import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AppInfo,
  MessageBlock,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  RailRow,
  SessionModelsResult,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";

/**
 * pi 把会话存成 `~/.pi/agent/sessions/<编码后的 cwd>/<时间戳>_<会话 id>.jsonl`。
 * 第一行是会话头，之后每条是一个树节点：message / session_info / compaction / label / custom。
 * ohmypi 是跑在 pi 上的一层编排包（`/ohmypi` 开关 + `~/.pi/agent/ohmypi.json`），
 * 会话同样落在这里，所以这一个适配器同时覆盖 pi 与 ohmypi。
 */
const AGENT_DIR = process.env["AGENT_BRIDGE_PI_DIR"] || join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const MAX_SESSIONS = 500;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_BLOCK_CHARS = 4_000;
const TITLE_CHARS = 120;
const MAX_RAIL_TASKS = 20;

interface SessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  name?: string;
  summary?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
    timestamp?: number;
  };
}

interface SessionRecord {
  path: string;
  id: string;
  cwd: string;
  parentSession: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
}

interface ParsedLog {
  messages: MessageRecord[];
  texts: Map<string, string[]>;
  model: string;
}

export class PiAdapter implements SessionAdapter {
  readonly key = "pi";
  private readonly indexCache = new Map<string, { stamp: string; record: SessionRecord }>();
  private sendTail: Promise<unknown> = Promise.resolve();

  app(): AppInfo {
    const hasRoot = existsSync(SESSIONS_DIR);
    const binary = this.binary();
    return {
      appId: this.key,
      provider: "other",
      kind: "pi",
      name: "pi",
      mode: "cli",
      status: hasRoot ? "ready" : "unavailable",
      capabilities: {
        enumerate: hasRoot ? "complete" : "unavailable",
        read: hasRoot ? "complete" : "unavailable",
        send: hasRoot && binary !== null,
        sendDetail:
          "未运行的会话由 Bridge 用 `pi -p --session <文件>` 续写一轮，沿用该会话自己的模型与设置；正在终端里跑的同一会话不要在两边同时发。",
        create: false,
        createDetail: "pi 会话由终端里的 pi 创建；Bridge 只读取并驱动已有会话。",
        reason: hasRoot ? undefined : `未找到 ${SESSIONS_DIR}`,
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const record of this.records()) {
      const projectId = this.projectIdFor(record.cwd);
      const entry = map.get(projectId);
      if (entry) entry.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: record.cwd ? basename(record.cwd) : "未分组会话",
          ...(record.cwd ? { cwd: record.cwd } : {}),
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  sessions(): SessionSummary[] {
    return this.records()
      .map((record) => this.summaryOf(record))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
  }

  session(sessionId: string): SessionSummary | null {
    const record = this.record(sessionId);
    return record ? this.summaryOf(record) : null;
  }

  async messages(sessionId: string, page: MessagePage): Promise<MessageListResult> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    return this.page(this.parse(record, sessionId), page);
  }

  async messageText(sessionId: string, messageId: string): Promise<MessageText | null> {
    const record = this.record(sessionId);
    if (!record) return null;
    const parsed = this.parse(record, sessionId);
    const message = parsed.messages.find((item) => item.messageId === messageId);
    if (!message) return null;
    return {
      messageId: message.messageId,
      role: message.role,
      createdAt: message.createdAt,
      text: (parsed.texts.get(message.messageId) ?? []).join("\n\n"),
    };
  }

  async rail(sessionId: string): Promise<SessionRailResult> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    const environment: RailRow[] = [];
    if (record.cwd) environment.push({ label: "目录", value: record.cwd });
    if (record.model) environment.push({ label: "模型", value: record.model });
    const children = this.records()
      .filter((item) => item.parentSession === record.id)
      .slice(0, MAX_RAIL_TASKS);
    return {
      environment,
      servers: [],
      tasks: children.map((child) => ({
        taskId: child.id,
        name: (child.title || "子会话").slice(0, 60),
        kind: "subagent" as const,
        status: "done" as const,
        startedAt: child.createdAt,
        updatedAt: child.updatedAt,
      })),
    };
  }

  models(sessionId: string): SessionModelsResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    return {
      ...(record.model ? { current: record.model, currentName: record.model } : {}),
      models: [],
      canSwitch: false,
      note: "模型在 pi 会话里切换；这里只展示最后一条回复实际用的模型。",
    };
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const task = this.sendTail.then(
      () => this.doSend(sessionId, text),
      () => this.doSend(sessionId, text),
    );
    this.sendTail = task.catch(() => undefined);
    return task;
  }

  private doSend(sessionId: string, text: string): MessageSendResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    if (!text.trim()) throw new RpcError("invalid_params", "消息不能为空");
    const binary = this.binary();
    if (!binary) throw new RpcError("adapter_unavailable", "未找到 pi 可执行文件");
    const child = spawn(binary, ["-p", "--session", record.path], {
      cwd: record.cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.unref();
    try {
      child.stdin?.end(text);
    } catch {
      // 进程已经退出时忽略；消息没进去，网页下一轮会从会话文件看出来。
    }
    return {
      accepted: true,
      delivered: false,
      detail: "已让 Bridge 用 pi 续写这个会话；跑完后刷新即可看到回复",
    };
  }

  private summaryOf(record: SessionRecord): SessionSummary {
    return {
      sessionId: `${this.key}:${record.id}`,
      appId: this.key,
      projectId: this.projectIdFor(record.cwd),
      kind: "pi",
      title: (record.title || "未命名会话").slice(0, TITLE_CHARS),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: false,
      live: false,
      canSend: this.binary() !== null,
      sendBlockedReason: this.binary() !== null ? undefined : "未找到 pi 可执行文件",
      ...(record.cwd ? { cwd: record.cwd } : {}),
    };
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private bareId(sessionId: string): string {
    return sessionId.startsWith(`${this.key}:`) ? sessionId.slice(this.key.length + 1) : sessionId;
  }

  private record(sessionId: string): SessionRecord | null {
    const id = this.bareId(sessionId);
    return this.records().find((item) => item.id === id) ?? null;
  }

  /** 会话文件按目录分组，读到的标题等信息按 路径+mtime+size 缓存，列表轮询不重复解析。 */
  private records(): SessionRecord[] {
    const out: SessionRecord[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      const base = join(SESSIONS_DIR, dir);
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(base, name);
        const record = this.indexOne(path);
        if (record) out.push(record);
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private indexOne(path: string): SessionRecord | null {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      return null;
    }
    if (size === 0) return null;
    const stamp = `${mtimeMs}:${size}`;
    const cached = this.indexCache.get(path);
    if (cached && cached.stamp === stamp) return cached.record;

    const head = this.readWindow(path, 0, Math.min(size, HEAD_BYTES));
    const header = parseHeader(head);
    if (!header || typeof header.id !== "string" || !header.id) return null;
    const tail = size > HEAD_BYTES ? this.readWindow(path, Math.max(0, size - TAIL_BYTES), TAIL_BYTES) : "";
    const info = scanLines(`${head}\n${tail}`);
    const record: SessionRecord = {
      path,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      parentSession: typeof header.parentSession === "string" ? header.parentSession : "",
      title: info.name || info.firstUser || "",
      createdAt: Date.parse(header.timestamp ?? "") || Math.round(mtimeMs),
      updatedAt: Math.round(mtimeMs),
      model: info.model,
    };
    this.indexCache.set(path, { stamp, record });
    return record;
  }

  private parse(record: SessionRecord, sessionId: string): ParsedLog {
    let raw = "";
    try {
      raw = this.readWindow(record.path, 0, Number.MAX_SAFE_INTEGER);
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取 pi 会话文件");
    }
    const messages: MessageRecord[] = [];
    const texts = new Map<string, string[]>();
    let model = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: PiEntry;
      try {
        entry = JSON.parse(line) as PiEntry;
      } catch {
        continue;
      }
      if (entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId) {
        model = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const messageId = typeof entry.id === "string" && entry.id ? entry.id : `${sessionId}:${messages.length}`;
      const createdAt =
        typeof entry.message.timestamp === "number"
          ? entry.message.timestamp
          : typeof entry.timestamp === "string"
            ? Date.parse(entry.timestamp) || 0
            : typeof entry.timestamp === "number"
              ? entry.timestamp
              : 0;
      const blocks: MessageBlock[] = [];
      const parts: string[] = [];
      for (const part of contentParts(entry.message.content)) {
        if (part.type === "text" && part.text.trim()) {
          parts.push(part.text.trim());
          blocks.push({ type: "text", ...truncate(part.text.trim(), MAX_BLOCK_CHARS) });
          continue;
        }
        if (part.type === "toolCall" && role === "assistant") {
          blocks.push({ type: "tool", ...truncate(`调用 ${part.name} ${part.args}`.trim(), 300) });
        }
      }
      if (blocks.length === 0) continue;
      if (role === "assistant" && entry.message.model) model = entry.message.model;
      messages.push({ messageId, sessionId, role, createdAt, blocks });
      if (parts.length > 0) texts.set(messageId, parts);
    }
    return { messages, texts, model };
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
      note: "读取 pi 会话里的用户／助手文本与工具调用；不含推理内容、图片与工具输出",
    };
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  private readWindow(path: string, start: number, length: number): string {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = statSync(path).size;
      const want = Math.max(0, Math.min(length, size - start));
      if (want === 0) return "";
      const buffer = Buffer.alloc(want);
      const read = readSync(fd, buffer, 0, want, start);
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** pi 装在 bun 的全局目录里，菜单栏 app 拉起的 Bridge 未必继承到那条 PATH。 */
  private binary(): string | null {
    const explicit = process.env["AGENT_BRIDGE_PI_PATH"];
    if (explicit) return existsSync(explicit) ? explicit : null;
    for (const candidate of [join(homedir(), ".bun", "bin", "pi"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

function parseHeader(text: string): SessionHeader | null {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionHeader;
      if (entry.type === "session") return entry;
    } catch {
      // 头部之后的行可能被截断，跳过即可。
    }
    return null;
  }
  return null;
}

/** 头部窗口与尾部窗口里找显示名、首条用户消息与最后用的模型。 */
function scanLines(text: string): { name: string; firstUser: string; model: string } {
  let name = "";
  let firstUser = "";
  let model = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      name = entry.name.trim();
      continue;
    }
    if (entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId) {
      model = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    if (message.role === "assistant" && typeof message.model === "string" && message.model) {
      model = message.model;
      continue;
    }
    if (firstUser || message.role !== "user") continue;
    const raw = contentParts(message.content)
      .filter((part) => part.type === "text" && part.text.trim())
      .map((part) => part.text.trim())
      .join(" ");
    if (raw) firstUser = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
  }
  return { name: name.slice(0, TITLE_CHARS), firstUser, model };
}

interface ContentPart {
  type: string;
  text: string;
  name: string;
  args: string;
}

function contentParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content, name: "", args: "" }];
  if (!Array.isArray(content)) return [];
  const out: ContentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as { type?: string; text?: unknown; name?: unknown; arguments?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text, name: "", args: "" });
      continue;
    }
    if (part.type === "toolCall" && typeof part.name === "string") {
      const args = typeof part.arguments === "string" ? part.arguments : safeJson(part.arguments);
      out.push({ type: "toolCall", text: "", name: part.name, args });
    }
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}
