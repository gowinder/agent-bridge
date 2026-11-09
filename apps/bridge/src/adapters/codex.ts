import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type {
  AppInfo,
  ContextUsage,
  MessageBlock,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  SessionSummary,
} from "@agent-bridge/protocol";
import { RpcError, truncate, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";

const CODEX_DIR = join(homedir(), ".codex");
const SQLITE_DIR = join(CODEX_DIR, "sqlite");
const SESSIONS_DIR = join(CODEX_DIR, "sessions");
const IPC_SOCKET = join(CODEX_DIR, "ipc", "ipc.sock");
const MAX_BLOCK_CHARS = 4_000;
const MAX_SESSIONS = 500;
const SEND_WAIT_MS = 8_000;
const DISCOVERY_WAIT_MS = 15_000;
const SEND_TIMEOUT_MS = 180_000;
const UNSET_CLIENT_ID = "00000000-0000-0000-0000-000000000000";

/** Wire versions expected by Codex desktop IPC handlers (from ChatGPT app bundle). */
const IPC_METHOD_VERSIONS: Record<string, number> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
};

function frameVersion(method: string, hostId: string | undefined): number {
  const base = IPC_METHOD_VERSIONS[method] ?? 0;
  return hostId && method.startsWith("thread-follower-") ? base + 1 : base;
}

interface ThreadRow {
  id: string;
  title: string | null;
  cwd: string | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  rollout_path: string | null;
  archived: number | null;
  thread_source: string | null;
}

interface BusyState {
  lastStart: number;
  lastEnd: number;
  sawStart: boolean;
}

interface CachedMessages {
  mtimeMs: number;
  size: number;
  messages: MessageRecord[];
  context?: ContextUsage;
  busy?: BusyState;
}

interface RawLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** The rollout's `token_count` events carry the context the last turn occupied. */
function contextOf(entry: RawLine): ContextUsage | undefined {
  if (entry.type !== "event_msg") return undefined;
  const payload = entry.payload;
  if (!payload || payload["type"] !== "token_count") return undefined;
  const info = usageOf(payload["info"]);
  const last = usageOf(info?.["last_token_usage"]);
  if (!info || !last) return undefined;
  const input = numberOf(last["input_tokens"]);
  const cached = numberOf(last["cached_input_tokens"]);
  const cacheWrite = numberOf(last["cache_write_input_tokens"]);
  const output = numberOf(last["output_tokens"]);
  const reasoning = numberOf(last["reasoning_output_tokens"]);
  const used = input + cached + cacheWrite;
  if (used <= 0) return undefined;
  const reported = numberOf(info["model_context_window"]);
  const details = [
    { label: "输入", value: input.toLocaleString("en-US") },
    { label: "缓存", value: cached.toLocaleString("en-US") },
    { label: "输出", value: output.toLocaleString("en-US") },
    { label: "推理输出", value: reasoning.toLocaleString("en-US") },
  ];
  const limits = usageOf(payload["rate_limits"]);
  for (const key of ["primary", "secondary"] as const) {
    const limit = usageOf(limits?.[key]);
    if (!limit) continue;
    const percent = numberOf(limit["used_percent"]);
    const minutes = numberOf(limit["window_minutes"]);
    const window = minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : `${Math.round(minutes / 60)} 小时`;
    details.push({ label: `限额 ${window}`, value: `${percent}% 已用` });
  }
  return {
    usedTokens: used,
    windowTokens: reported > 0 ? reported : 200_000,
    ...(reported > 0 ? {} : { windowEstimated: true }),
    details,
  };
}

function modelOf(entry: RawLine): string | undefined {
  if (entry.type !== "turn_context") return undefined;
  const model = entry.payload?.["model"];
  return typeof model === "string" && model !== "" ? model : undefined;
}

/** Codex opens a task with `task_started` and closes it with `task_complete`. */
function trackRolloutBusy(busy: BusyState, entry: RawLine): void {
  if (entry.type !== "event_msg") return;
  const kind = entry.payload?.["type"];
  if (kind !== "task_started" && kind !== "task_complete") return;
  const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return;
  if (kind === "task_started") {
    busy.sawStart = true;
    if (at > busy.lastStart) busy.lastStart = at;
  } else if (at > busy.lastEnd) {
    busy.lastEnd = at;
  }
}

const BUSY_MAX_AGE_MS = 30 * 60_000;

function rolloutBusy(busy: BusyState | undefined): boolean {
  if (!busy || !busy.sawStart) return false;
  if (busy.lastStart <= busy.lastEnd) return false;
  return Date.now() - busy.lastStart < BUSY_MAX_AGE_MS;
}

const CATALOG_PATH = join(SQLITE_DIR, "codex.db");

function hasCatalog(path: string): boolean {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.prepare("SELECT 1 FROM local_thread_catalog LIMIT 1").get();
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function newestStateDb(): string | null {
  let best: { path: string; version: number } | null = null;
  try {
    for (const name of readdirSync(SQLITE_DIR)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (!match) continue;
      const version = Number(match[1]);
      if (!best || version > best.version) best = { path: join(SQLITE_DIR, name), version };
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

/** Resolve a rollout path recorded without the `.zst` suffix. */
function rolloutFile(path: string): { path: string; compressed: boolean } | null {
  const candidates = [
    { path, compressed: path.endsWith(".zst") },
    { path: `${path}.zst`, compressed: true },
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface IpcRequest {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  targetClientId?: string;
  hostId?: string;
}

class IpcClient {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private clientId = UNSET_CLIENT_ID;
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("IPC 连接已关闭")));
  }

  static async connect(): Promise<IpcClient> {
    const socket = createConnection(IPC_SOCKET);
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error("IPC 连接超时"));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.setTimeout(0);
    return new IpcClient(socket);
  }

  async initialize(): Promise<void> {
    const response = await this.request({
      method: "initialize",
      params: { clientType: "agent-bridge" },
      timeoutMs: 10_000,
    });
    const result = response["result"] as Record<string, unknown> | undefined;
    const clientId = result?.["clientId"];
    if (response["resultType"] !== "success" || typeof clientId !== "string") {
      throw new RpcError("adapter_unavailable", "Codex IPC 初始化失败");
    }
    this.clientId = clientId;
  }

  request({ method, params, timeoutMs, targetClientId, hostId }: IpcRequest): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const frame = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version: frameVersion(method, hostId),
      method,
      params,
      targetClientId,
      hostId,
      timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("IPC 请求超时"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame(frame));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC 连接已关闭"));
      this.pending.delete(id);
    }
    this.socket.destroy();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message["type"] === "client-discovery-request") {
        this.socket.write(
          encodeFrame({
            type: "client-discovery-response",
            requestId: message["requestId"],
            response: { canHandle: false },
          }),
        );
        continue;
      }
      if (message["type"] === "request") {
        this.socket.write(
          encodeFrame({
            type: "response",
            requestId: message["requestId"],
            resultType: "error",
            error: "no-handler-for-request",
          }),
        );
        continue;
      }
      if (message["type"] !== "response") continue;
      const pending = this.pending.get(String(message["requestId"]));
      if (!pending) continue;
      this.pending.delete(String(message["requestId"]));
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }
}

function encodeFrame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class CodexAdapter implements SessionAdapter {
  readonly key = "codex";
  private db: DatabaseSync | null = null;
  private dbPath: string | null = null;
  private catalogDb: DatabaseSync | null = null;
  private catalogChecked = false;
  private messageCache = new Map<string, CachedMessages>();
  private rolloutCache = new Map<string, { path: string; compressed: boolean }>();

  app(): AppInfo {
    const dbPath = this.catalog() ? CATALOG_PATH : this.stateDb();
    const ipc = existsSync(IPC_SOCKET);
    return {
      appId: this.key,
      provider: "openai",
      kind: "codex",
      name: "ChatGPT Desktop · Codex",
      mode: "local-store",
      status: dbPath ? "ready" : "unavailable",
      capabilities: {
        enumerate: dbPath ? "partial" : "unavailable",
        read: dbPath ? "partial" : "unavailable",
        send: dbPath !== null && ipc,
        sendDetail:
          "仅能向 Codex 桌面当前打开的线程发送；原生 ChatGPT Chat/Work 不在该通道内，本适配器不提供。",
        reason: dbPath ? undefined : "未找到 Codex 线程数据库",
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const thread of this.threads()) {
      const projectId = this.projectIdFor(thread.cwd);
      const entry = map.get(projectId);
      if (entry) entry.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: thread.cwd ? basename(thread.cwd) : "未分组会话",
          cwd: thread.cwd || undefined,
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  sessions(): SessionSummary[] {
    const ipc = existsSync(IPC_SOCKET);
    return this.threads().map((thread) => ({
      sessionId: `${this.key}:${thread.id}`,
      appId: this.key,
      projectId: this.projectIdFor(thread.cwd),
      kind: "codex-thread",
      title: (thread.title || "未命名线程").slice(0, 120),
      createdAt: thread.created_at_ms ?? 0,
      updatedAt: thread.updated_at_ms ?? 0,
      archived: (thread.archived ?? 0) !== 0,
      live: false,
      canSend: ipc,
      sendBlockedReason: ipc ? undefined : "Codex 桌面未运行（未找到本地 IPC 通道）",
    }));
  }

  session(sessionId: string): SessionSummary | null {
    return this.sessions().find((item) => item.sessionId === sessionId) ?? null;
  }

  async messages(sessionId: string, page: MessagePage): Promise<MessageListResult> {
    const thread = this.thread(String(sessionId).slice(this.key.length + 1));
    if (!thread) throw new RpcError("not_found", "未知线程");
    const file = this.rolloutFor(thread);
    if (!file) {
      return { messages: [], completeness: "partial", note: "未找到该线程的 rollout 文件" };
    }
    const parsed = await this.readRollout(file.path, thread.id);
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
      note: "读取 rollout 中的用户／助手消息文本；不含工具调用输出与推理内容",
    };
    if (parsed.context) result.context = parsed.context;
    if (parsed.busy) result.busy = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  async messageText(sessionId: string, messageId: string): Promise<MessageText | null> {
    const threadId = String(sessionId).slice(this.key.length + 1);
    const thread = this.thread(threadId);
    if (!thread) return null;
    const file = this.rolloutFor(thread);
    if (!file) return null;
    const stream = createReadStream(file.path);
    const input = file.path.endsWith(".zst") ? stream.pipe(createZstdDecompress()) : stream;
    const lines = createInterface({ input, crlfDelay: Infinity });
    let kept = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: RawLine;
        try {
          entry = JSON.parse(line) as RawLine;
        } catch {
          continue;
        }
        if (entry.type !== "response_item") continue;
        const payload = entry.payload;
        if (!payload || payload["type"] !== "message") continue;
        const role = payload["role"];
        if (role !== "user" && role !== "assistant") continue;
        const content = payload["content"];
        const parts: string[] = [];
        if (Array.isArray(content)) {
          for (const raw of content) {
            if (typeof raw !== "object" || raw === null) continue;
            const block = raw as Record<string, unknown>;
            const type = block["type"];
            if (type !== "input_text" && type !== "output_text") continue;
            const text = typeof block["text"] === "string" ? block["text"].trim() : "";
            if (!text) continue;
            if (role === "user" && isInjectedContext(text)) continue;
            parts.push(text);
          }
        }
        const text = parts.join("\n\n").trim();
        const id =
          typeof payload["id"] === "string"
            ? payload["id"]
            : `${threadId}:${typeof entry.ordinal === "number" ? entry.ordinal : kept}`;
        if (text) kept += 1;
        if (id !== messageId) continue;
        if (!text) return null;
        return {
          messageId,
          role,
          createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
          text,
        };
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return null;
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const threadId = String(sessionId).slice(this.key.length + 1);
    if (!this.thread(threadId)) throw new RpcError("not_found", "未知线程");
    if (!existsSync(IPC_SOCKET)) {
      throw new RpcError("adapter_unavailable", "Codex 桌面未运行（未找到本地 IPC 通道）");
    }

    const client = await IpcClient.connect().catch(() => {
      throw new RpcError(
        "adapter_unavailable",
        "无法连接 Codex 本地 IPC 通道（Codex 桌面可能未在运行）",
      );
    });
    try {
      await client.initialize();

      const discovery = await client.request({
        method: "thread-owner-discovery",
        params: { hostId: "local", conversationId: threadId },
        timeoutMs: DISCOVERY_WAIT_MS,
      });
      const owner = discovery["handledByClientId"];
      if (discovery["resultType"] !== "success" || typeof owner !== "string") {
        if (discovery["error"] === "no-client-found") {
          throw new RpcError(
            "adapter_unavailable",
            "该线程未在 Codex 桌面中打开；先在桌面打开该线程再发送",
          );
        }
        throw new RpcError(
          "adapter_unavailable",
          `无法定位承接该线程的 Codex 桌面客户端（${String(discovery["error"] ?? "unknown")}）`,
        );
      }

      const sendPromise = client.request({
        method: "thread-follower-start-turn",
        targetClientId: owner,
        timeoutMs: SEND_TIMEOUT_MS,
        params: {
          conversationId: threadId,
          turnStart: {
            request: {
              threadId,
              input: [{ type: "text", text, text_elements: [] }],
            },
            context: {},
          },
        },
      });
      sendPromise.then(
        () => client.close(),
        () => client.close(),
      );
      const early = await Promise.race([
        sendPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SEND_WAIT_MS)),
      ]);
      if (early === null) {
        return {
          accepted: true,
          delivered: false,
          detail: "已提交到 Codex 桌面，仍在执行；稍后刷新查看回复",
        };
      }
      if (early["resultType"] !== "success") {
        throw new RpcError(
          "adapter_unavailable",
          `Codex 拒绝该轮：${String(early["error"] ?? early["resultType"] ?? "unknown")}`,
        );
      }
      return { accepted: true, delivered: true, detail: "Codex 已完成该轮" };
    } catch (error) {
      client.close();
      if (
        error instanceof Error &&
        (error.message === "IPC 请求超时" || error.message === "IPC 连接已关闭")
      ) {
        throw new RpcError("adapter_unavailable", `Codex 桌面未响应（${error.message}）`);
      }
      throw error;
    }
  }

  private projectIdFor(cwd: string | null): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private stateDb(): string | null {
    if (this.db) return this.dbPath;
    const path = newestStateDb();
    if (!path) return null;
    try {
      this.db = new DatabaseSync(path, { readOnly: true });
      this.dbPath = path;
      return path;
    } catch {
      return null;
    }
  }

  private threads(): ThreadRow[] {
    const catalog = this.catalog();
    if (catalog) {
      try {
        return catalog
          .prepare(
            `SELECT thread_id AS id, display_title AS title, cwd,
                    CAST(source_created_at * 1000 AS INTEGER) AS created_at_ms,
                    CAST(source_updated_at * 1000 AS INTEGER) AS updated_at_ms,
                    NULL AS rollout_path, 0 AS archived, thread_source
             FROM local_thread_catalog
             WHERE host_id = 'local' AND (thread_source IS NULL OR thread_source != 'subagent')
             ORDER BY source_updated_at DESC
             LIMIT ${MAX_SESSIONS}`,
          )
          .all() as unknown as ThreadRow[];
      } catch {
        return [];
      }
    }
    if (!this.stateDb() || !this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, title, cwd, created_at_ms, updated_at_ms, rollout_path, archived, thread_source
           FROM threads
           WHERE archived = 0 AND (thread_source IS NULL OR thread_source != 'subagent')
           ORDER BY updated_at_ms DESC
           LIMIT ${MAX_SESSIONS}`,
        )
        .all() as unknown as ThreadRow[];
      return rows;
    } catch {
      return [];
    }
  }

  private thread(threadId: string): ThreadRow | null {
    const catalog = this.catalog();
    if (catalog) {
      try {
        const row = catalog
          .prepare(
            `SELECT thread_id AS id, display_title AS title, cwd,
                    CAST(source_created_at * 1000 AS INTEGER) AS created_at_ms,
                    CAST(source_updated_at * 1000 AS INTEGER) AS updated_at_ms,
                    NULL AS rollout_path, 0 AS archived, thread_source
             FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?`,
          )
          .get(threadId) as unknown as ThreadRow | undefined;
        return row ?? null;
      } catch {
        return null;
      }
    }
    if (!this.stateDb() || !this.db) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT id, title, cwd, created_at_ms, updated_at_ms, rollout_path, archived, thread_source
           FROM threads WHERE id = ?`,
        )
        .get(threadId) as unknown as ThreadRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /** Current desktop keeps threads in `codex.db`; older builds used `state_N.sqlite`. */
  private catalog(): DatabaseSync | null {
    if (this.catalogChecked) return this.catalogDb;
    this.catalogChecked = true;
    if (!hasCatalog(CATALOG_PATH)) return null;
    try {
      this.catalogDb = new DatabaseSync(CATALOG_PATH, { readOnly: true });
      return this.catalogDb;
    } catch {
      return null;
    }
  }

  private rolloutFor(thread: ThreadRow): { path: string; compressed: boolean } | null {
    if (thread.rollout_path) return rolloutFile(thread.rollout_path);
    const cached = this.rolloutCache.get(thread.id);
    if (cached && existsSync(cached.path)) return cached;
    const base = new Date(thread.created_at_ms ?? Date.now());
    for (const offset of [0, -1, 1]) {
      const day = new Date(base.getTime() + offset * 86_400_000);
      const dir = join(
        SESSIONS_DIR,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, "0"),
        String(day.getDate()).padStart(2, "0"),
      );
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.includes(thread.id)) continue;
        const entry = { path: join(dir, name), compressed: name.endsWith(".zst") };
        this.rolloutCache.set(thread.id, entry);
        return entry;
      }
    }
    return null;
  }

  private async readRollout(
    path: string,
    threadId: string,
  ): Promise<{ messages: MessageRecord[]; context?: ContextUsage; busy: boolean }> {
    const stat = statSync(path);
    const cached = this.messageCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return {
        messages: cached.messages,
        ...(cached.context ? { context: cached.context } : {}),
        busy: rolloutBusy(cached.busy),
      };
    }
    const stream = createReadStream(path);
    const input = path.endsWith(".zst") ? stream.pipe(createZstdDecompress()) : stream;
    const lines = createInterface({ input, crlfDelay: Infinity });
    const messages: MessageRecord[] = [];
    const busy: BusyState = { lastStart: 0, lastEnd: 0, sawStart: false };
    let context: ContextUsage | undefined;
    let model: string | undefined;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: RawLine;
        try {
          entry = JSON.parse(line) as RawLine;
        } catch {
          continue;
        }
        const message = this.toMessage(entry, threadId, messages.length);
        if (message) messages.push(message);
        model = modelOf(entry) ?? model;
        const usage = contextOf(entry);
        if (usage) context = usage;
        trackRolloutBusy(busy, entry);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (context && model) context.model = model;
    this.messageCache.set(path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      messages,
      ...(context ? { context } : {}),
      busy,
    });
    return { messages, ...(context ? { context } : {}), busy: rolloutBusy(busy) };
  }

  private toMessage(entry: RawLine, threadId: string, index: number): MessageRecord | null {
    if (entry.type !== "response_item") return null;
    const payload = entry.payload;
    if (!payload || payload["type"] !== "message") return null;
    const role = payload["role"];
    if (role !== "user" && role !== "assistant") return null;
    const content = payload["content"];
    if (!Array.isArray(content)) return null;
    const blocks: MessageBlock[] = [];
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const block = raw as Record<string, unknown>;
      const type = block["type"];
      if (type !== "input_text" && type !== "output_text") continue;
      const text = typeof block["text"] === "string" ? block["text"].trim() : "";
      if (!text) continue;
      if (role === "user" && isInjectedContext(text)) continue;
      blocks.push({ type: "text", ...truncate(text, MAX_BLOCK_CHARS) });
    }
    if (blocks.length === 0) return null;
    const ordinal = typeof entry.ordinal === "number" ? entry.ordinal : index;
    return {
      messageId: typeof payload["id"] === "string" ? payload["id"] : `${threadId}:${ordinal}`,
      sessionId: `${this.key}:${threadId}`,
      role,
      createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
      blocks,
      origin: "local",
    };
  }
}

function isInjectedContext(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<permissions instructions>")
  );
}
