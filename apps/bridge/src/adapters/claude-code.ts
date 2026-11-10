import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

const SOCKET_DIR = "/tmp/cc-socks";
const SUPPORT_DIR = join(homedir(), "Library", "Application Support");
const SESSION_ROOTS = [
  join(SUPPORT_DIR, "Claude-3p", "claude-code-sessions"),
  join(SUPPORT_DIR, "Claude", "claude-code-sessions"),
];
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_BLOCK_CHARS = 4_000;

interface DesktopSession {
  localId: string;
  cliSessionId: string;
  priorCliSessionIds: string[];
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  permissionMode: string;
}

interface RawEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: Record<string, unknown>;
  };
}

/** Timestamps that tell whether the CLI is still working on a turn. */
interface BusyState {
  lastUserAt: number;
  lastTurnEndAt: number;
  sawTurnEnd: boolean;
}

interface CachedMessages {
  mtimeMs: number;
  size: number;
  messages: MessageRecord[];
  context?: ContextUsage;
  busy?: BusyState;
  interrupted?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Models advertised with a 1M token context window (e.g. `claude-sonnet-4-5[1m]`). */
function isMillionTokenModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("[1m]") || name.includes("-1m") || name.includes("1m-context");
}

/** A turn the user stopped is recorded as a synthetic user entry. */
function isInterruptEntry(entry: RawEntry): boolean {
  if (entry.type !== "user" || entry.isSidechain) return false;
  const content = entry.message?.content;
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>)["text"];
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.some((text) => text.trim().startsWith("[Request interrupted by user"));
}

/** A turn is open when the last main-chain user entry is newer than the last turn end. */
function trackBusy(busy: BusyState, entry: RawEntry): void {
  if (entry.isSidechain) return;
  const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return;
  if (entry.type === "user" && at > busy.lastUserAt) busy.lastUserAt = at;
  if (entry.type === "system" && entry.subtype === "turn_duration") {
    busy.sawTurnEnd = true;
    if (at > busy.lastTurnEndAt) busy.lastTurnEndAt = at;
  }
}

const BUSY_MAX_AGE_MS = 30 * 60_000;

function isBusy(busy: BusyState | undefined): boolean {
  if (!busy || !busy.sawTurnEnd) return false;
  if (busy.lastUserAt <= busy.lastTurnEndAt) return false;
  return Date.now() - busy.lastUserAt < BUSY_MAX_AGE_MS;
}

function listSessionFiles(root: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const child of listSessionFiles(path)) out.push(child);
    } else if (/^local_[\w-]+\.json$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const metaCache = new Map<string, { mtimeMs: number; session: DesktopSession | null }>();
let rootCache: { root: string; checkedAt: number } | null = null;

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly key = "claude-code";
  private processCache: { at: number; bySession: Map<string, number>; error: string | null } | null = null;
  private transcriptPathCache = new Map<string, { path: string | null; checkedAt: number }>();
  private messageCache = new Map<string, CachedMessages>();
  private sendQueue: Promise<unknown> = Promise.resolve();

  app(): AppInfo {
    const root = this.activeRoot();
    const processError = this.scanProcesses().error;
    return {
      appId: this.key,
      provider: "anthropic",
      kind: "claude-code",
      name: "Claude Desktop · Code",
      mode: "local-store",
      status: root ? "ready" : "unavailable",
      capabilities: {
        enumerate: root ? "partial" : "unavailable",
        read: root ? "partial" : "unavailable",
        send: root !== null && processError === null,
        sendDetail: processError
          ? `${processError}；请在终端中直接启动 Bridge，不要在受限沙箱里运行，否则无法判断哪些会话正在桌面中运行。`
          : "发送走运行中会话进程的本地 UDS 通道；仅对已在桌面打开的 Code 会话生效，回复需从 transcript 刷新。",
        create: false,
        createDetail: "桌面 Code 会话由 Claude Desktop 创建，Bridge 只能读取并驱动已存在的会话。",
        reason: root ? undefined : "未找到 Claude Desktop 的会话元数据目录",
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const session of this.records()) {
      const projectId = this.projectIdFor(session.cwd);
      const entry = map.get(projectId);
      if (entry) entry.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: session.cwd ? basename(session.cwd) : "未分组会话",
          cwd: session.cwd || undefined,
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  sessions(): SessionSummary[] {
    const scan = this.scanProcesses();
    const bySession = scan.bySession;
    const out: SessionSummary[] = [];
    for (const session of this.records()) {
      const sessionId = `${this.key}:${session.localId}`;
      const pid = this.livePid(session, bySession);
      const live = pid !== undefined;
      const canSend = live && this.socketFor(pid) !== null;
      out.push({
        sessionId,
        appId: this.key,
        projectId: this.projectIdFor(session.cwd),
        kind: "code",
        title: (session.title || "未命名会话").slice(0, 120),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: session.archived,
        live,
        canSend,
        sendBlockedReason: canSend
          ? undefined
          : scan.error ??
            (live
              ? "该会话进程没有可用的本地消息通道"
              : "该会话未在桌面中打开；先在桌面打开后才能发送"),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  session(sessionId: string): SessionSummary | null {
    return this.sessions().find((item) => item.sessionId === sessionId) ?? null;
  }

  messages(sessionId: string, page: MessagePage): MessageListResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    if (!record.cliSessionId) {
      return {
        messages: [],
        completeness: "partial",
        note: "该会话没有关联 CLI transcript，无法读取历史",
      };
    }
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) {
      return {
        messages: [],
        completeness: "partial",
        note: "未找到该会话的 transcript 文件",
      };
    }
    const parsed = this.readTranscript(path, sessionId);
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
      note: "仅主链文本与工具调用摘要；不含侧链、图片与工具输出全文",
    };
    if (parsed.context) result.context = parsed.context;
    if (parsed.busy) result.busy = true;
    if (parsed.interrupted) result.interrupted = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  messageText(sessionId: string, messageId: string): MessageText | null {
    const record = this.record(sessionId);
    if (!record?.cliSessionId) return null;
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) return null;
    let transcript: string;
    try {
      transcript = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (entry.isSidechain) continue;
      if ((entry.uuid ?? "") !== messageId) continue;
      const text = this.fullTextOf(entry.message?.content);
      if (!text) return null;
      return {
        messageId,
        role: entry.type,
        createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
        text,
      };
    }
    return null;
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const runSend = async (): Promise<MessageSendResult> => {
      const record = this.record(sessionId);
      if (!record) throw new RpcError("not_found", "未知会话");
      if (!record.cliSessionId) {
        throw new RpcError("adapter_unavailable", "该会话没有关联 CLI 进程，无法发送");
      }
      const scan = this.scanProcesses();
      if (scan.error) throw new RpcError("adapter_unavailable", scan.error);
      const match = this.liveMatch(record, scan.bySession);
      if (!match) {
        throw new RpcError("adapter_unavailable", "该会话未在桌面中打开；先在桌面打开后再发送");
      }
      const target = this.socketFor(match.pid);
      if (!target) throw new RpcError("adapter_unavailable", "该会话进程没有可用的消息通道");
      const mode = record.permissionMode === "bypassPermissions" ? "bypass" : "default";
      const result = await this.injectUds(target, text, mode);
      if (result.delivered) return result;
      // The CLI does not always answer with a receipt; the transcript is the
      // authoritative confirmation that the message reached the session.
      if (await this.confirmInTranscript(match.id, text)) {
        return { accepted: true, delivered: true, detail: "已写入会话记录" };
      }
      return result;
    };
    const task = this.sendQueue.then(runSend, runSend);
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private activeRoot(): string | null {
    const now = Date.now();
    if (rootCache && now - rootCache.checkedAt < 30_000) return rootCache.root || null;
    let best: { root: string; newest: number } | null = null;
    for (const root of SESSION_ROOTS) {
      let newest = 0;
      for (const file of listSessionFiles(root)) {
        try {
          newest = Math.max(newest, statSync(file).mtimeMs);
        } catch {
          // file vanished
        }
      }
      if (newest > 0 && (!best || newest > best.newest)) best = { root, newest };
    }
    rootCache = { root: best?.root ?? "", checkedAt: now };
    return best?.root ?? null;
  }

  private records(): DesktopSession[] {
    const root = this.activeRoot();
    if (!root) return [];
    const out: DesktopSession[] = [];
    for (const file of listSessionFiles(root)) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const cached = metaCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs) {
        if (cached.session) out.push(cached.session);
        continue;
      }
      const session = this.parseMeta(file);
      metaCache.set(file, { mtimeMs, session });
      if (session) out.push(session);
    }
    return out;
  }

  private parseMeta(path: string): DesktopSession | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const localId = asString(raw["sessionId"]) || basename(path).replace(/\.json$/, "");
      const createdAt = asNumber(raw["createdAt"]);
      return {
        localId,
        cliSessionId: asString(raw["cliSessionId"]),
        priorCliSessionIds: Array.isArray(raw["priorCliSessionIds"])
          ? raw["priorCliSessionIds"]
              .filter((item): item is string => typeof item === "string" && item !== "")
              .slice(-20)
          : [],
        cwd: asString(raw["cwd"]),
        title: asString(raw["title"]),
        createdAt,
        updatedAt:
          asNumber(raw["lastActivityAt"]) ||
          asNumber(raw["lastTurnEdgeAt"]) ||
          asNumber(raw["lastFocusedAt"]) ||
          createdAt,
        archived: raw["isArchived"] === true,
        permissionMode: asString(raw["permissionMode"]),
      };
    } catch {
      return null;
    }
  }

  private record(sessionId: string): DesktopSession | null {
    const localId = sessionId.startsWith(`${this.key}:`)
      ? sessionId.slice(this.key.length + 1)
      : sessionId;
    return this.records().find((item) => item.localId === localId) ?? null;
  }

  private scanProcesses(): { bySession: Map<string, number>; error: string | null } {
    const now = Date.now();
    if (this.processCache && now - this.processCache.at < 2_000) return this.processCache;
    const bySession = new Map<string, number>();
    let error: string | null = null;
    try {
      // execFileSync via promisify would be async; use a synchronous spawn to keep the
      // adapter interface synchronous for listing.
      const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
      });
      for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const command = match[2] ?? "";
        if (!command.includes("claude")) continue;
        const resumed =
          /--resume(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
            command,
          ) ??
          /--session-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
            command,
          );
        const sessionId = resumed?.[1];
        if (!sessionId) continue;
        if (!bySession.has(sessionId) || this.socketFor(pid)) bySession.set(sessionId, pid);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error = message.includes("operation not permitted") || message.includes("EPERM")
        ? "无法枚举本机进程（ps 被拒绝），不能定位运行中的会话"
        : `无法枚举本机进程：${message}`;
    }
    this.processCache = { at: now, bySession, error };
    return this.processCache;
  }

  private livePid(record: DesktopSession, bySession: Map<string, number>): number | undefined {
    return this.liveMatch(record, bySession)?.pid;
  }

  private liveMatch(
    record: DesktopSession,
    bySession: Map<string, number>,
  ): { pid: number; id: string } | undefined {
    // The desktop rotates cliSessionId when a conversation is compacted, rewound
    // or resumed; the open tab keeps running under an id recorded in
    // priorCliSessionIds, so match any of them.
    for (const id of [record.cliSessionId, ...record.priorCliSessionIds]) {
      if (!id) continue;
      const pid = bySession.get(id);
      if (pid !== undefined) return { pid, id };
    }
    return undefined;
  }

  private socketFor(pid: number | undefined): string | null {
    if (pid === undefined) return null;
    const direct = join(SOCKET_DIR, `${pid}.sock`);
    if (existsSync(direct)) return direct;
    try {
      for (const name of readdirSync(SOCKET_DIR)) {
        if (name.startsWith(`${pid}-`) && name.endsWith(".sock")) return join(SOCKET_DIR, name);
      }
    } catch {
      // socket dir missing
    }
    return null;
  }

  private transcriptPath(cliSessionId: string): string | null {
    const now = Date.now();
    const cached = this.transcriptPathCache.get(cliSessionId);
    if (cached && now - cached.checkedAt < 60_000) return cached.path;
    let path: string | null = null;
    try {
      for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const candidate = join(PROJECTS_DIR, dir.name, `${cliSessionId}.jsonl`);
        if (existsSync(candidate)) {
          path = candidate;
          break;
        }
      }
    } catch {
      // projects dir missing
    }
    this.transcriptPathCache.set(cliSessionId, { path, checkedAt: now });
    return path;
  }

  private readTranscript(
    path: string,
    sessionId: string,
  ): { messages: MessageRecord[]; context?: ContextUsage; busy: boolean; interrupted: boolean } {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取会话 transcript");
    }
    const cached = this.messageCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      const interrupted = cached.interrupted === true;
      return {
        messages: cached.messages,
        ...(cached.context ? { context: cached.context } : {}),
        busy: isBusy(cached.busy) && !interrupted,
        interrupted,
      };
    }

    const messages: MessageRecord[] = [];
    let context: ContextUsage | undefined;
    const busy: BusyState = { lastUserAt: 0, lastTurnEndAt: 0, sawTurnEnd: false };
    let lastContentOrder = -1;
    let lastInterruptOrder = -1;
    let order = 0;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取会话 transcript");
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      order += 1;
      if (isInterruptEntry(entry)) {
        lastInterruptOrder = order;
        continue;
      }
      const message = this.toMessage(entry, sessionId, messages.length);
      if (message) {
        messages.push(message);
        lastContentOrder = order;
      }
      const usage = this.contextOf(entry);
      if (usage) context = usage;
      trackBusy(busy, entry);
    }
    const interrupted = lastInterruptOrder > lastContentOrder;
    this.messageCache.set(path, {
      mtimeMs,
      size,
      messages,
      ...(context ? { context } : {}),
      busy,
      interrupted,
    });
    return {
      messages,
      ...(context ? { context } : {}),
      busy: isBusy(busy) && !interrupted,
      interrupted,
    };
  }

  /** Latest assistant usage entry wins; it describes the context the next turn will see. */
  private contextOf(entry: RawEntry): ContextUsage | undefined {
    if (entry.type !== "assistant" || entry.isSidechain) return undefined;
    const usage = entry.message?.usage;
    if (!usage) return undefined;
    const input = asNumber(usage["input_tokens"]);
    const cacheRead = asNumber(usage["cache_read_input_tokens"]);
    const cacheWrite = asNumber(usage["cache_creation_input_tokens"]);
    const output = asNumber(usage["output_tokens"]);
    const used = input + cacheRead + cacheWrite;
    if (used <= 0) return undefined;
    const model = asString(entry.message?.model);
    const known = /claude|opus|sonnet|haiku/i.test(model);
    return {
      usedTokens: used,
      windowTokens: isMillionTokenModel(model) ? 1_000_000 : 200_000,
      ...(model ? { model } : {}),
      ...(known ? {} : { windowEstimated: true }),
      details: [
        { label: "输入", value: input.toLocaleString("en-US") },
        { label: "缓存读", value: cacheRead.toLocaleString("en-US") },
        { label: "缓存写", value: cacheWrite.toLocaleString("en-US") },
        { label: "输出", value: output.toLocaleString("en-US") },
      ],
    };
  }

  private toMessage(entry: RawEntry, sessionId: string, index: number): MessageRecord | null {
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    if (entry.isSidechain) return null;
    const blocks = this.extractBlocks(entry.message?.content);
    if (blocks.length === 0) return null;
    const role = entry.type;
    let origin: "local" | "peer" = "local";
    for (const block of blocks) {
      const peer = /<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(
        block.text,
      );
      if (peer?.[1] !== undefined) {
        block.text = peer[1].trim();
        origin = "peer";
      }
    }
    return {
      messageId: entry.uuid ?? `${sessionId}:${index}`,
      sessionId,
      role,
      createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
      blocks,
      origin,
    };
  }

  private extractBlocks(content: unknown): MessageBlock[] {
    const blocks: MessageBlock[] = [];
    if (typeof content === "string") {
      const clean = this.stripSystem(content);
      if (clean) blocks.push({ type: "text", ...truncate(clean, MAX_BLOCK_CHARS) });
      return blocks;
    }
    if (!Array.isArray(content)) return blocks;
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        const clean = this.stripSystem(block["text"]);
        if (clean) blocks.push({ type: "text", ...truncate(clean, MAX_BLOCK_CHARS) });
      } else if (block["type"] === "tool_use") {
        const name = asString(block["name"]) || "tool";
        const input = block["input"] === undefined ? "" : JSON.stringify(block["input"]);
        blocks.push({ type: "tool", ...truncate(`调用 ${name} ${input}`.trim(), 300) });
      }
    }
    return blocks;
  }

  private fullTextOf(content: unknown): string {
    const parts: string[] = [];
    if (typeof content === "string") {
      const clean = this.stripSystem(content);
      if (clean) parts.push(clean);
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (typeof raw !== "object" || raw === null) continue;
        const block = raw as Record<string, unknown>;
        if (block["type"] !== "text" || typeof block["text"] !== "string") continue;
        const clean = this.stripSystem(block["text"]);
        if (clean) parts.push(clean);
      }
    }
    const joined = parts.join("\n\n");
    const peer = /<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(joined);
    return (peer?.[1] ?? joined).trim();
  }

  private stripSystem(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  }

  private async confirmInTranscript(cliSessionId: string, text: string): Promise<boolean> {
    const path = this.transcriptPath(cliSessionId);
    if (!path) return false;
    const needle = text.trim().slice(0, 40);
    if (!needle) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let messages: MessageRecord[] = [];
      try {
        messages = this.readTranscript(path, `${this.key}:${cliSessionId}`).messages;
      } catch {
        return false;
      }
      for (const message of messages.slice(-8)) {
        if (message.role !== "user") continue;
        if (
          message.blocks.some((block) => block.type === "text" && block.text.includes(needle))
        ) {
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  private injectUds(target: string, text: string, mode: string): Promise<MessageSendResult> {
    const own = join(SOCKET_DIR, `${process.pid}.sock`);
    return new Promise<MessageSendResult>((resolve, reject) => {
      let settled = false;
      const receipts: string[] = [];
      let client: Socket | null = null;
      let server: Server | null = null;
      const finish = (result: MessageSendResult | Error): void => {
        if (settled) return;
        settled = true;
        try {
          client?.destroy();
        } catch {
          // ignore
        }
        server?.close();
        try {
          if (existsSync(own)) unlinkSync(own);
        } catch {
          // ignore
        }
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const enqueueReceipt = (raw: string): void => {
        for (const line of raw.split("\n")) {
          if (line.trim()) receipts.push(line.trim());
        }
      };
      const settleFromReceipts = (): void => {
        const joined = receipts.join("\n");
        const status = /"status"\s*:\s*"([a-z_]+)"/.exec(joined)?.[1];
        if (!status) return;
        finish({
          accepted: status !== "refused",
          delivered: status === "delivered",
          detail:
            status === "held"
              ? "目标会话正忙，消息已交给桌面排队"
              : status === "refused"
                ? "目标会话拒绝接收该消息"
                : status,
        });
      };

      if (existsSync(own)) {
        try {
          unlinkSync(own);
        } catch {
          // ignore
        }
      }
      server = createServer((connection) => {
        connection.setEncoding("utf8");
        connection.on("data", (chunk: string) => {
          enqueueReceipt(chunk);
          settleFromReceipts();
        });
        connection.on("error", () => undefined);
      });
      server.on("error", (error) => finish(error));
      server.listen(own, () => {
        try {
          chmodSync(own, 0o600);
        } catch {
          // best effort
        }
        client = createConnection(target);
        client.setEncoding("utf8");
        client.on("connect", () => {
          const envelope = `<cross-session-message from="uds:${own}" from-name="Agent Bridge" from-mode="${mode}">\n${text}\n</cross-session-message>`;
          const frame = {
            msg_id: randomUUID(),
            type: "user",
            message: { role: "user", content: envelope },
            priority: "next",
            from: `uds:${own}`,
          };
          client?.write(`${JSON.stringify(frame)}\n`);
        });
        client.on("data", (chunk: string) => {
          enqueueReceipt(chunk);
          settleFromReceipts();
        });
        client.on("error", (error) => finish(error));
        client.setTimeout(3_000, () => {
          finish({
            accepted: true,
            delivered: false,
            detail:
              receipts.length > 0
                ? `未收到投递确认：${receipts.join(" ").slice(0, 200)}`
                : "已写入本地通道，但未收到投递确认",
          });
        });
      });
      setTimeout(() => {
        finish({
          accepted: true,
          delivered: false,
          detail:
            receipts.length > 0
              ? `未收到投递确认：${receipts.join(" ").slice(0, 200)}`
              : "已写入本地通道，但未收到投递确认",
        });
      }, 4_000).unref();
    });
  }
}
