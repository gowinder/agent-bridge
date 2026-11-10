import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
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

const DSH_HOME = join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;
const MAX_BLOCK_CHARS = 4_000;
const MAX_SESSIONS = 500;
const MAX_RAIL_TASKS = 20;
const HEAD_BYTES = 256 * 1024;
const HEAD_CONCURRENCY = 32;
const SEND_WAIT_MS = 8_000;
const MAX_STDERR_CHARS = 4_000;
const TITLE_CHARS = 120;

interface SessionHeader {
  type?: string;
  version?: number;
  id?: string;
  cwd?: string;
  createdAt?: number;
  parentSession?: string;
  origin?: string;
  agentPreset?: string;
}

interface HeadInfo {
  header: SessionHeader & { id: string };
  title: string;
  firstUser: string;
  label: string;
}

interface Entry {
  path: string;
  stamp: string;
  id: string;
  cwd: string;
  parentSession: string;
  preset: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  label: string;
}

interface ParsedLog {
  messages: MessageRecord[];
  firstTime: number;
  lastTime: number;
  lastTurnReason: string;
  busy: boolean;
}

interface JsonEvent {
  type?: string;
  seq?: number;
  time?: number;
  id?: string;
  data?: Record<string, unknown>;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n\n");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sessionFileOf(dir: string): string | null {
  try {
    const name = readdirSync(dir).find((item) => SESSION_FILE.test(item));
    return name ? join(dir, name) : null;
  } catch {
    return null;
  }
}

/** Streams only the head of a session log, long enough for its identity and title. */
function readHead(path: string): Promise<HeadInfo | null> {
  return new Promise<HeadInfo | null>((resolve) => {
    const stream = createZstdDecompress();
    let buffer = "";
    let seen = 0;
    let header: (SessionHeader & { id: string }) | null = null;
    let title = "";
    let firstUser = "";
    let label = "";
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve(header ? { header, title, firstUser, label } : null);
    };
    const consume = (line: string): void => {
      if (!line) return;
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        return;
      }
      if (event.type === "session" && typeof event.id === "string") {
        header = event as unknown as SessionHeader & { id: string };
        return;
      }
      if (event.type === "session/title" && !title) {
        const value = event.data?.["title"];
        if (typeof value === "string") title = collapse(value);
        return;
      }
      if (event.type === "user/message" && !firstUser) {
        const source = event.data?.["source"] as { kind?: string } | undefined;
        if (source?.kind === "user") firstUser = collapse(contentText(event.data?.["content"]));
        return;
      }
      if (event.type === "subagent/descriptor" && !label) {
        const value = event.data?.["label"];
        if (typeof value === "string") label = value;
      }
    };
    const wanted = (): boolean => {
      if (!header) return false;
      if (header.parentSession) return title !== "" || label !== "";
      return title !== "";
    };
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      buffer += chunk.toString("utf8");
      seen += chunk.length;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consume(line);
        if (wanted()) {
          finish();
          return;
        }
        index = buffer.indexOf("\n");
      }
      if (seen > HEAD_BYTES) finish();
    });
    stream.on("error", finish);
    stream.on("end", finish);
    createReadStream(path)
      .on("error", finish)
      .pipe(stream);
  });
}

function parseLog(path: string, sessionId: string): ParsedLog {
  let raw: Buffer;
  try {
    raw = zstdDecompressSync(readFileSync(path));
  } catch {
    throw new RpcError("adapter_unavailable", "无法解压 dsh 会话记录");
  }
  const messages: MessageRecord[] = [];
  const seenTools = new Set<string>();
  let firstTime = 0;
  let lastTime = 0;
  let lastTurnReason = "";
  let openTurn = false;

  const appendAssistant = (messageId: string, createdAt: number, blocks: MessageBlock[]): void => {
    const last = messages.at(-1);
    if (last && last.role === "assistant") {
      last.blocks.push(...blocks);
      if (!last.createdAt) last.createdAt = createdAt;
      return;
    }
    messages.push({ messageId, sessionId, role: "assistant", createdAt, blocks });
  };

  for (const line of raw.toString("utf8").split("\n")) {
    if (!line) continue;
    let event: JsonEvent;
    try {
      event = JSON.parse(line) as JsonEvent;
    } catch {
      continue;
    }
    const time = typeof event.time === "number" ? event.time : 0;
    if (time) {
      if (!firstTime) firstTime = time;
      lastTime = time;
    }
    const seq = typeof event.seq === "number" ? event.seq : 0;
    const messageId = `${sessionId}:${seq}`;

    if (event.type === "turn/start") {
      openTurn = true;
      continue;
    }
    if (event.type === "turn/end") {
      openTurn = false;
      const reason = event.data?.["reason"] as { kind?: string } | undefined;
      lastTurnReason = reason?.kind ?? "";
      continue;
    }
    if (event.type === "user/message") {
      const source = event.data?.["source"] as { kind?: string } | undefined;
      if (source?.kind !== "user") continue;
      const text = contentText(event.data?.["content"]);
      if (!text) continue;
      messages.push({
        messageId,
        sessionId,
        role: "user",
        createdAt: time,
        blocks: [{ type: "text", ...truncate(text, MAX_BLOCK_CHARS) }],
      });
      continue;
    }
    if (event.type === "assistant/message") {
      const message = event.data?.["message"] as { content?: unknown } | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      const blocks: MessageBlock[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const item = part as { type?: string; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          blocks.push({ type: "text", ...truncate(item.text.trim(), MAX_BLOCK_CHARS) });
          continue;
        }
        if (item.type === "tool-call" && typeof item.name === "string") {
          const callId = typeof item.id === "string" ? item.id : "";
          if (callId && seenTools.has(callId)) continue;
          if (callId) seenTools.add(callId);
          const args = typeof item.arguments === "string" ? item.arguments : "";
          blocks.push({ type: "tool", ...truncate(`调用 ${item.name} ${args}`.trim(), 300) });
        }
      }
      if (blocks.length === 0) continue;
      appendAssistant(messageId, time, blocks);
    }
  }

  return { messages, firstTime, lastTime, lastTurnReason, busy: openTurn };
}

function findBinary(): string | null {
  const candidates = [join(homedir(), ".local", "bin", "dsh"), "/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  const fromPath = (process.env["PATH"] ?? "")
    .split(":")
    .map((dir) => join(dir, "dsh"))
    .find((path) => existsSync(path));
  return fromPath ?? null;
}

export class DshAdapter implements SessionAdapter {
  readonly key = "dsh";
  private headCache = new Map<string, { stamp: string; head: HeadInfo | null }>();
  private logCache = new Map<string, { stamp: string; parsed: ParsedLog }>();
  private sendQueues = new Map<string, Promise<unknown>>();
  private binaryCache: { at: number; path: string | null } | null = null;

  app(): AppInfo {
    const available = existsSync(SESSIONS_DIR);
    const binary = this.binary();
    return {
      appId: this.key,
      provider: "deepseek",
      kind: "dsh",
      name: "DeepSeek Harness",
      mode: "local-store",
      status: available ? "ready" : "unavailable",
      capabilities: {
        enumerate: available ? "partial" : "unavailable",
        read: available ? "partial" : "unavailable",
        send: available && binary !== null,
        sendDetail:
          "发送会用 `dsh --profile headless --session-id <id>` 续写该会话；会话由桌面版正在运行时会被拒绝，且要求会话的预设与工作目录在该 profile 中可复现。",
        create: false,
        createDetail: "尚未接入 dsh 的新建会话；先在桌面版里新建会话，再从这里发送。",
        reason: available ? undefined : "未找到 dsh 会话目录（~/.dsh/sessions）",
      },
    };
  }

  async projects(): Promise<ProjectInfo[]> {
    const entries = await this.index();
    const map = new Map<string, ProjectInfo>();
    for (const entry of entries) {
      const projectId = this.projectIdFor(entry.cwd);
      const existing = map.get(projectId);
      if (existing) existing.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: entry.cwd ? basename(entry.cwd) : "未分组会话",
          cwd: entry.cwd || undefined,
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  async sessions(): Promise<SessionSummary[]> {
    const entries = await this.index();
    return entries
      .filter((entry) => !entry.parentSession)
      .map((entry) => this.summaryOf(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
  }

  async session(sessionId: string): Promise<SessionSummary | null> {
    const entries = await this.index();
    const entry = entries.find((item) => item.id === this.bareId(sessionId));
    return entry ? this.summaryOf(entry) : null;
  }

  async messages(sessionId: string, page: MessagePage): Promise<MessageListResult> {
    const entry = await this.entry(sessionId);
    const parsed = this.log(entry, sessionId);
    return this.page(parsed, page);
  }

  async taskMessages(sessionId: string, taskId: string, page: MessagePage): Promise<MessageListResult> {
    const parent = await this.entry(sessionId);
    const child = await this.entry(`dsh:${taskId}`);
    if (child.parentSession !== parent.id) throw new RpcError("not_found", "该任务不属于当前会话");
    const parsed = this.log(child, `dsh:${child.id}`);
    return this.page(parsed, page);
  }

  async messageText(sessionId: string, messageId: string): Promise<MessageText | null> {
    const entry = await this.entry(sessionId);
    const message = this.log(entry, sessionId).messages.find((item) => item.messageId === messageId);
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

  async rail(sessionId: string): Promise<SessionRailResult> {
    const entry = await this.entry(sessionId);
    const environment: RailRow[] = [];
    if (entry.cwd) environment.push({ label: "目录", value: entry.cwd });
    if (entry.preset) environment.push({ label: "预设", value: entry.preset });
    const children = (await this.index()).filter((item) => item.parentSession === entry.id).slice(0, MAX_RAIL_TASKS);
    const tasks: RailTask[] = children.map((child) => {
      let parsed: ParsedLog | null = null;
      try {
        parsed = this.log(child, `dsh:${child.id}`);
      } catch {
        parsed = null;
      }
      const task: RailTask = {
        taskId: child.id,
        name: (child.label || child.title || "子代理").slice(0, 60),
        kind: "subagent",
        status: parsed?.busy ? "running" : "done",
      };
      const started = parsed?.firstTime ?? child.createdAt;
      if (started) task.startedAt = started;
      const updated = parsed?.lastTime ?? child.updatedAt;
      if (updated) task.updatedAt = updated;
      return task;
    });
    return { environment, servers: [], tasks };
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const previous = this.sendQueues.get(sessionId) ?? Promise.resolve();
    const run = async (): Promise<MessageSendResult> => {
      const entry = await this.entry(sessionId);
      const binary = this.binary();
      if (!binary) throw new RpcError("adapter_unavailable", "未找到 dsh 可执行文件");
      return this.spawnTurn(binary, entry, text);
    };
    const task = previous.then(run, run);
    this.sendQueues.set(
      sessionId,
      task.catch(() => undefined),
    );
    return task;
  }

  private page(parsed: ParsedLog, page: MessagePage): MessageListResult {
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
      note: "读取 dsh 会话日志中的用户／助手文本与工具调用；不含推理内容、附件与工具输出",
    };
    if (parsed.busy) result.busy = true;
    if (parsed.lastTurnReason === "interrupted") result.interrupted = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  private spawnTurn(binary: string, entry: Entry, text: string): Promise<MessageSendResult> {
    return new Promise<MessageSendResult>((resolve, reject) => {
      // The task goes through stdin so a message starting with "-" is never read as a flag.
      const child = spawn(binary, ["--profile", "headless", "--session-id", entry.id, "--json", "-"], {
        cwd: entry.cwd && existsSync(entry.cwd) ? entry.cwd : homedir(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end(`${text}\n`);
      let stderr = "";
      let settled = false;
      const finish = (): void => {
        settled = true;
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
      });
      child.stdout?.resume();
      child.on("error", (error) => {
        if (settled) return;
        finish();
        reject(new RpcError("adapter_unavailable", `无法启动 dsh（${error.message}）`));
      });
      child.on("exit", (code) => {
        if (settled) return;
        finish();
        if (code === 0) {
          resolve({ accepted: true, delivered: true, detail: "dsh headless 已完成该轮" });
          return;
        }
        const detail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(new RpcError("adapter_unavailable", `dsh 退出码 ${String(code)}${detail ? `：${detail}` : ""}`));
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
          detail: "已在 dsh headless 中开始执行；回复稍后写入该会话",
        });
      }, SEND_WAIT_MS).unref();
    });
  }

  private log(entry: Entry, sessionId: string): ParsedLog {
    const cached = this.logCache.get(entry.path);
    if (cached && cached.stamp === entry.stamp) return cached.parsed;
    const parsed = parseLog(entry.path, sessionId);
    this.logCache.set(entry.path, { stamp: entry.stamp, parsed });
    return parsed;
  }

  private summaryOf(entry: Entry): SessionSummary {
    const binary = this.binary();
    return {
      sessionId: `dsh:${entry.id}`,
      appId: this.key,
      projectId: this.projectIdFor(entry.cwd),
      kind: "dsh",
      title: (entry.title || entry.label || "未命名会话").slice(0, TITLE_CHARS),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      archived: false,
      live: false,
      canSend: binary !== null,
      sendBlockedReason: binary ? undefined : "未找到 dsh 可执行文件",
    };
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private bareId(sessionId: string): string {
    return sessionId.startsWith(`${this.key}:`) ? sessionId.slice(this.key.length + 1) : sessionId;
  }

  private async entry(sessionId: string): Promise<Entry> {
    const id = this.bareId(sessionId);
    const entry = (await this.index()).find((item) => item.id === id);
    if (!entry) throw new RpcError("not_found", "未知会话");
    return entry;
  }

  /** Walks the session store, reusing per-file head reads until a log changes. */
  private async index(): Promise<Entry[]> {
    const files: Array<{ path: string; stamp: string; updatedAt: number }> = [];
    let workspaces: string[];
    try {
      workspaces = readdirSync(SESSIONS_DIR);
    } catch {
      return [];
    }
    for (const workspace of workspaces) {
      const dir = join(SESSIONS_DIR, workspace);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      let children: string[];
      try {
        children = readdirSync(dir);
      } catch {
        continue;
      }
      for (const child of children) {
        const path = sessionFileOf(join(dir, child));
        if (!path) continue;
        try {
          const stat = statSync(path);
          files.push({ path, stamp: `${stat.mtimeMs}:${stat.size}`, updatedAt: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }

    const entries: Entry[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(HEAD_CONCURRENCY, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        if (!file) return;
        const cached = this.headCache.get(file.path);
        let head: HeadInfo | null;
        if (cached && cached.stamp === file.stamp) {
          head = cached.head;
        } else {
          head = await readHead(file.path);
          this.headCache.set(file.path, { stamp: file.stamp, head });
        }
        if (!head) continue;
        entries.push({
          path: file.path,
          stamp: file.stamp,
          id: head.header.id,
          cwd: head.header.cwd ?? "",
          parentSession: head.header.parentSession ?? "",
          preset: head.header.agentPreset ?? "",
          createdAt: head.header.createdAt ?? 0,
          updatedAt: file.updatedAt,
          title: head.title || (head.firstUser ? head.firstUser.slice(0, 80) : ""),
          label: head.label,
        });
      }
    });
    await Promise.all(workers);
    return entries;
  }

  private binary(): string | null {
    const now = Date.now();
    if (this.binaryCache && now - this.binaryCache.at < 30_000) return this.binaryCache.path;
    const path = findBinary();
    this.binaryCache = { at: now, path };
    return path;
  }
}
