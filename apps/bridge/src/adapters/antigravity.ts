import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppInfo,
  MessageBlock,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  RailRow,
  RailTask,
  SessionRailResult,
  SessionSummary,
} from "@agent-bridge/protocol";
import { RpcError, truncate, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";

const ANTIGRAVITY_DIR = join(homedir(), ".gemini", "antigravity-cli");
const SUMMARIES_DB = join(ANTIGRAVITY_DIR, "conversation_summaries.db");
const CONVERSATIONS_DIR = join(ANTIGRAVITY_DIR, "conversations");
const MAX_BLOCK_CHARS = 4_000;
const MAX_SESSIONS = 500;
const MAX_RAIL_TASKS = 20;
const SEND_WAIT_MS = 8_000;
const MAX_STDERR_CHARS = 4_000;

/** Server-side paths whose values we read out of the protobuf step payload. */
const WANTED_TEXT = new Set([
  ".19.2",
  ".20.1",
  ".20.3",
  ".20.7.1",
  ".20.7.2",
  ".20.7.3",
  ".20.8",
  ".5.4.1",
  ".5.4.2",
  ".5.4.3",
  ".24.3.2",
]);
const WANTED_NUM = new Set([".5.1.1", ".5.1.2"]);

const STEP_USER = 14;
const STEP_MODEL = 15;
const STEP_TOOL = 21;
const STEP_TOOL_LEGACY = 132;
const STEP_INTERRUPTED = 17;

interface SummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  step_count: number | null;
  last_modified_time: string | null;
  last_user_input_time: string | null;
  workspace_uris: string | null;
  status: string | null;
  agent_name: string | null;
  parent_conversation_id: string | null;
  nesting_depth: number | null;
  not_fully_idle: number | null;
  killed: number | null;
}

interface StepRow {
  idx: number;
  step_type: number;
  step_payload: Uint8Array;
}

interface ParsedConversation {
  messages: MessageRecord[];
  interrupted: boolean;
}

/** A tiny protobuf reader good enough for the step payload shape Antigravity writes. */
function parseFields(payload: Buffer): { text: Map<string, string>; num: Map<string, number> } {
  const text = new Map<string, string>();
  const num = new Map<string, number>();

  const walk = (buffer: Buffer, prefix: string, depth: number): void => {
    let pos = 0;
    while (pos < buffer.length) {
      const header = readVarint(buffer, pos);
      if (!header) return;
      const [key, afterKey] = header;
      pos = afterKey;
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field === 0) return;
      const path = `${prefix}.${field}`;
      if (wire === 0) {
        const value = readVarint(buffer, pos);
        if (!value) return;
        if (WANTED_NUM.has(path)) num.set(path, value[0]);
        pos = value[1];
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 2) {
        const length = readVarint(buffer, pos);
        if (!length) return;
        const [size, afterLength] = length;
        if (size < 0 || afterLength + size > buffer.length) return;
        const child = buffer.subarray(afterLength, afterLength + size);
        pos = afterLength + size;
        if (depth < 3) walk(child, path, depth + 1);
        if (WANTED_TEXT.has(path) && !text.has(path)) text.set(path, child.toString("utf8"));
      } else {
        return;
      }
    }
  };

  walk(payload, "", 0);
  return { text, num };
}

function readVarint(buffer: Buffer, start: number): [number, number] | null {
  let value = 0;
  let multiplier = 1;
  let pos = start;
  while (pos < buffer.length) {
    const byte = buffer[pos] ?? 0;
    value += (byte & 0x7f) * multiplier;
    pos += 1;
    if ((byte & 0x80) === 0) return [value, pos];
    multiplier *= 128;
    if (multiplier > 2 ** 49) return null;
  }
  return null;
}

function stepTime(fields: { num: Map<string, number> }): number {
  const seconds = fields.num.get(".5.1.1") ?? 0;
  if (!seconds) return 0;
  const nanos = fields.num.get(".5.1.2") ?? 0;
  return seconds * 1000 + Math.round(nanos / 1_000_000);
}

function toolBlock(name: string, args: string): MessageBlock {
  return { type: "tool", ...truncate(`调用 ${name} ${args}`.trim(), 300) };
}

/** Prompt written by `agy` for an interrupted turn; the UI shows it as an interruption. */
function isInterruptedNotice(value: string | undefined): boolean {
  if (!value) return false;
  return /interrupted/i.test(value);
}

function conversationPath(id: string): string {
  return join(CONVERSATIONS_DIR, `${id}.db`);
}

/** Parses a stored timestamp, rejecting the placeholder epochs Antigravity writes. */
function parseTime(value: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 1_000_000_000_000 ? time : 0;
}

function parseMessages(sessionId: string, conversationId: string): ParsedConversation {
  const messages: MessageRecord[] = [];
  const seenTools = new Set<string>();
  let interrupted = false;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(conversationPath(conversationId), { readOnly: true });
  } catch {
    throw new RpcError("adapter_unavailable", "无法打开 Antigravity 会话数据库");
  }
  try {
    /** Antigravity writes one row per assistant step; keep one message per turn. */
    const appendAssistant = (messageId: string, createdAt: number, blocks: MessageBlock[]): void => {
      const last = messages.at(-1);
      if (last && last.role === "assistant") {
        last.blocks.push(...blocks);
        if (!last.createdAt) last.createdAt = createdAt;
        return;
      }
      messages.push({ messageId, sessionId, role: "assistant", createdAt, blocks });
    };
    const rows = db
      .prepare("SELECT idx, step_type, step_payload FROM steps ORDER BY idx")
      .all() as unknown as StepRow[];
    for (const row of rows) {
      const fields = parseFields(Buffer.from(row.step_payload));
      const createdAt = stepTime(fields);
      const messageId = `${sessionId}:${row.idx}`;

      if (row.step_type === STEP_USER) {
        const value = fields.text.get(".19.2")?.trim();
        if (!value) continue;
        messages.push({
          messageId,
          sessionId,
          role: "user",
          createdAt,
          blocks: [{ type: "text", ...truncate(value, MAX_BLOCK_CHARS) }],
        });
        continue;
      }

      if (row.step_type === STEP_MODEL) {
        const blocks: MessageBlock[] = [];
        const visible = fields.text.get(".20.1") ?? fields.text.get(".20.8");
        if (visible?.trim()) {
          blocks.push({ type: "text", ...truncate(visible.trim(), MAX_BLOCK_CHARS) });
        }
        const toolId = fields.text.get(".20.7.1");
        const toolName = fields.text.get(".20.7.2");
        if (toolName && toolId && !seenTools.has(toolId)) {
          seenTools.add(toolId);
          blocks.push(toolBlock(toolName, fields.text.get(".20.7.3") ?? ""));
        }
        if (blocks.length === 0) continue;
        appendAssistant(messageId, createdAt, blocks);
        continue;
      }

      if (row.step_type === STEP_TOOL || row.step_type === STEP_TOOL_LEGACY) {
        const toolId = fields.text.get(".5.4.1");
        const toolName = fields.text.get(".5.4.2");
        if (!toolName || !toolId || seenTools.has(toolId)) continue;
        seenTools.add(toolId);
        appendAssistant(messageId, createdAt, [toolBlock(toolName, fields.text.get(".5.4.3") ?? "")]);
        continue;
      }

      if (row.step_type === STEP_INTERRUPTED && isInterruptedNotice(fields.text.get(".24.3.2"))) {
        interrupted = true;
      }
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError("adapter_unavailable", "无法读取 Antigravity 会话步骤");
  } finally {
    db.close();
  }

  return { messages, interrupted };
}

function workspacePath(uris: string | null): string {
  if (!uris) return "";
  let list: unknown;
  try {
    list = JSON.parse(uris);
  } catch {
    return "";
  }
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item !== "string") continue;
    if (item.startsWith("file://")) {
      try {
        return decodeURIComponent(item.slice("file://".length));
      } catch {
        return item.slice("file://".length);
      }
    }
  }
  return "";
}

function findBinary(): string | null {
  const candidates = [
    join(homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  const fromPath = (process.env["PATH"] ?? "")
    .split(":")
    .map((dir) => join(dir, "agy"))
    .find((path) => existsSync(path));
  return fromPath ?? null;
}

export class AntigravityAdapter implements SessionAdapter {
  readonly key = "antigravity";
  private summariesDb: DatabaseSync | null = null;
  private summariesChecked = false;
  private messageCache = new Map<string, { stamp: string; parsed: ParsedConversation }>();
  private sendQueue: Promise<unknown> = Promise.resolve();
  private binaryCache: { at: number; path: string | null } | null = null;

  app(): AppInfo {
    const db = this.summaries();
    const binary = this.binary();
    return {
      appId: this.key,
      provider: "google",
      kind: "antigravity",
      name: "Antigravity CLI",
      mode: "cli",
      status: db ? "ready" : "unavailable",
      capabilities: {
        enumerate: db ? "partial" : "unavailable",
        read: db ? "partial" : "unavailable",
        send: db !== null && binary !== null,
        sendDetail:
          "发送会用 `agy --conversation <id> --print <文本>` 新起一个 CLI 进程续写该会话；该会话正在运行时不可发送，且需要本机 agy 已登录。",
        create: false,
        createDetail:
          "尚未接入 Antigravity 的新建会话（ACP session/new）；先在 agy 中新建会话，再从这里发送。",
        reason: db ? undefined : "未找到 Antigravity CLI 的会话索引（~/.gemini/antigravity-cli）",
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const row of this.rows()) {
      const cwd = workspacePath(row.workspace_uris);
      const projectId = this.projectIdFor(cwd);
      const entry = map.get(projectId);
      if (entry) entry.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: cwd ? basename(cwd) : "未分组会话",
          cwd: cwd || undefined,
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  sessions(): SessionSummary[] {
    return this.rows()
      .map((row) => this.summaryOf(row))
      .filter((item): item is SessionSummary => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  session(sessionId: string): SessionSummary | null {
    return this.sessions().find((item) => item.sessionId === sessionId) ?? null;
  }

  messages(sessionId: string, page: MessagePage): MessageListResult {
    const row = this.row(sessionId);
    if (!row) throw new RpcError("not_found", "未知会话");
    const parsed = this.parsed(sessionId, row.conversation_id);
    const all = parsed.messages;
    let end = all.length;
    if (page.before) {
      const index = all.findIndex((message) => message.messageId === page.before);
      if (index === -1) throw new RpcError("invalid_params", "未知的分页游标");
      end = index;
    }
    const start = Math.max(0, end - page.limit);
    const messages = all.slice(start, end);
    const result: MessageListResult = {
      messages,
      completeness: "partial",
      note: "读取 Antigravity CLI 会话库中的用户／助手文本与工具调用；不含隐藏推理内容",
    };
    if (row.not_fully_idle === 1) result.busy = true;
    if (parsed.interrupted) result.interrupted = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  messageText(sessionId: string, messageId: string): MessageText | null {
    const row = this.row(sessionId);
    if (!row) return null;
    const message = this.parsed(sessionId, row.conversation_id).messages.find(
      (item) => item.messageId === messageId,
    );
    if (!message) return null;
    return {
      messageId: message.messageId,
      role: message.role,
      createdAt: message.createdAt,
      text: message.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n\n"),
    };
  }

  rail(sessionId: string): SessionRailResult {
    const row = this.row(sessionId);
    if (!row) throw new RpcError("not_found", "未知会话");
    const environment: RailRow[] = [];
    const cwd = workspacePath(row.workspace_uris);
    if (cwd) environment.push({ label: "目录", value: cwd });
    if (row.step_count) environment.push({ label: "步骤", value: String(row.step_count) });
    if (row.status) environment.push({ label: "状态", value: row.status });
    const tasks: RailTask[] = this.children(row.conversation_id)
      .slice(0, MAX_RAIL_TASKS)
      .map((child) => {
        const running = /RUNNING/i.test(child.status ?? "") || child.not_fully_idle === 1;
        const task: RailTask = {
          taskId: child.conversation_id,
          name: (child.agent_name || "子代理").slice(0, 60),
          kind: "subagent",
          status: running ? "running" : "done",
        };
        if (child.agent_name) task.agentType = child.agent_name;
        // Some rows carry a placeholder epoch (2001-01-01); ignore implausible values.
        const started = parseTime(child.last_user_input_time);
        if (started) task.startedAt = started;
        const updated = parseTime(child.last_modified_time);
        if (updated) task.updatedAt = updated;
        return task;
      });
    const result: SessionRailResult = { environment, servers: [], tasks };
    if (tasks.length > 0) result.note = "子代理会话来自 Antigravity 的会话索引";
    return result;
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const runSend = async (): Promise<MessageSendResult> => {
      const row = this.row(sessionId);
      if (!row) throw new RpcError("not_found", "未知会话");
      if (row.not_fully_idle === 1) {
        throw new RpcError("adapter_unavailable", "该会话正在运行中，等本轮结束后再发送");
      }
      const binary = this.binary();
      if (!binary) throw new RpcError("adapter_unavailable", "未找到 agy 可执行文件");
      const cwd = workspacePath(row.workspace_uris);
      return this.spawnTurn(binary, row.conversation_id, text, cwd);
    };
    const task = this.sendQueue.then(runSend, runSend);
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  private spawnTurn(
    binary: string,
    conversationId: string,
    text: string,
    cwd: string,
  ): Promise<MessageSendResult> {
    return new Promise<MessageSendResult>((resolve, reject) => {
      const child = spawn(
        binary,
        ["--conversation", conversationId, "--output-format", "stream-json", "--print", text],
        {
          cwd: cwd && existsSync(cwd) ? cwd : homedir(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      let settled = false;
      const finish = (): void => {
        settled = true;
      };

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
      });
      // The result line is not needed: the conversation store is the source of truth.
      child.stdout?.resume();
      child.on("error", (error) => {
        if (settled) return;
        finish();
        reject(new RpcError("adapter_unavailable", `无法启动 agy（${error.message}）`));
      });
      child.on("exit", (code) => {
        if (settled) return;
        finish();
        if (code === 0) {
          resolve({ accepted: true, delivered: true, detail: "Antigravity CLI 已完成该轮" });
          return;
        }
        const detail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(
          new RpcError(
            "adapter_unavailable",
            `agy 退出码 ${String(code)}${detail ? `：${detail}` : ""}`,
          ),
        );
      });

      setTimeout(() => {
        if (settled) return;
        finish();
        child.stdout?.resume();
        child.stderr?.resume();
        child.unref();
        resolve({
          accepted: true,
          delivered: false,
          detail: "已在 Antigravity CLI 中开始执行；回复稍后出现在该会话中",
        });
      }, SEND_WAIT_MS).unref();
    });
  }

  private parsed(sessionId: string, conversationId: string): ParsedConversation {
    const path = conversationPath(conversationId);
    let stamp = "";
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = "missing";
    }
    const cached = this.messageCache.get(conversationId);
    if (cached && cached.stamp === stamp) return cached.parsed;
    const parsed = parseMessages(sessionId, conversationId);
    this.messageCache.set(conversationId, { stamp, parsed });
    return parsed;
  }

  private summaryOf(row: SummaryRow): SessionSummary | null {
    const cwd = workspacePath(row.workspace_uris);
    const live = /RUNNING/i.test(row.status ?? "") || row.not_fully_idle === 1;
    const binary = this.binary();
    const canSend = binary !== null && !live;
    let createdAt = 0;
    try {
      createdAt = statSync(conversationPath(row.conversation_id)).birthtimeMs;
    } catch {
      createdAt = 0;
    }
    const updatedAt = parseTime(row.last_modified_time);
    return {
      sessionId: `${this.key}:${row.conversation_id}`,
      appId: this.key,
      projectId: this.projectIdFor(cwd),
      kind: "antigravity",
      title: (row.title || row.preview || "未命名会话").slice(0, 120),
      createdAt,
      updatedAt: updatedAt || createdAt,
      archived: false,
      live,
      canSend,
      sendBlockedReason: canSend
        ? undefined
        : live
          ? "该会话正在运行中，等本轮结束后再发送"
          : "未找到 agy 可执行文件",
    };
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private summaries(): DatabaseSync | null {
    if (this.summariesChecked) return this.summariesDb;
    this.summariesChecked = true;
    try {
      this.summariesDb = new DatabaseSync(SUMMARIES_DB, { readOnly: true });
      return this.summariesDb;
    } catch {
      return null;
    }
  }

  private rows(): SummaryRow[] {
    const db = this.summaries();
    if (!db) return [];
    try {
      return db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, status, agent_name,
                  parent_conversation_id, nesting_depth, not_fully_idle, killed
           FROM conversation_summaries
           WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
             AND (nesting_depth IS NULL OR nesting_depth = 0)
           ORDER BY last_modified_time DESC
           LIMIT ${MAX_SESSIONS}`,
        )
        .all() as unknown as SummaryRow[];
    } catch {
      return [];
    }
  }

  private row(sessionId: string): SummaryRow | null {
    const id = String(sessionId).slice(this.key.length + 1);
    const db = this.summaries();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, status, agent_name,
                  parent_conversation_id, nesting_depth, not_fully_idle, killed
           FROM conversation_summaries WHERE conversation_id = ?`,
        )
        .get(id) as unknown as SummaryRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  private children(conversationId: string): SummaryRow[] {
    const db = this.summaries();
    if (!db) return [];
    try {
      return db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, status, agent_name,
                  parent_conversation_id, nesting_depth, not_fully_idle, killed
           FROM conversation_summaries
           WHERE parent_conversation_id = ?
           ORDER BY last_modified_time DESC
           LIMIT ${MAX_RAIL_TASKS}`,
        )
        .all(conversationId) as unknown as SummaryRow[];
    } catch {
      return [];
    }
  }

  private binary(): string | null {
    const now = Date.now();
    if (this.binaryCache && now - this.binaryCache.at < 30_000) return this.binaryCache.path;
    const path = findBinary();
    this.binaryCache = { at: now, path };
    return path;
  }
}
