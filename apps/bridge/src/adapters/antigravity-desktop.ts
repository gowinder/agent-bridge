import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  AppInfo,
  Completeness,
  MessageBlock,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  RailRow,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";

const ANTIGRAVITY_DIR = join(homedir(), ".gemini", "antigravity");
const CONVERSATIONS_DIR = join(ANTIGRAVITY_DIR, "conversations");
const MCP_CONFIG = join(ANTIGRAVITY_DIR, "mcp_config.json");
const GLOBAL_STATE_DB = join(
  homedir(),
  "Library",
  "Application Support",
  "Antigravity",
  "User",
  "globalStorage",
  "state.vscdb",
);
const STATE_KEY = "antigravityUnifiedStateSync.trajectorySummaries";

const RPC_PREFIX = "/exa.language_server_pb.LanguageServerService/";
const CURL_BIN = "/usr/bin/curl";
const PS_BIN = "/bin/ps";
const LSOF_BIN = "/usr/sbin/lsof";

const MAX_BLOCK_CHARS = 8_000;
const MAX_SESSIONS = 500;
const MAX_SERVERS = 20;
const ENDPOINT_TTL_MS = 15_000;
const CATALOG_TTL_MS = 3_000;
const SUMMARIES_TTL_MS = 10_000;
const STEPS_TTL_MS = 1_500;
const RPC_TIMEOUT_SEC = 15;
const PROBE_TIMEOUT_SEC = 2;

/** Step types the desktop UI does not show as conversation content. */
const SILENT_STEPS = new Set([
  "CORTEX_STEP_TYPE_CONVERSATION_HISTORY",
  "CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS",
  "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE",
  "CORTEX_STEP_TYPE_CHECKPOINT",
  "CORTEX_STEP_TYPE_CODE_ACKNOWLEDGEMENT",
  "CORTEX_STEP_TYPE_COMMAND_STATUS",
  "CORTEX_STEP_TYPE_SEND_COMMAND_INPUT",
]);

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

interface ProtoField {
  wire: number;
  num?: number;
  buf?: Buffer;
}

/** Minimal protobuf reader: keeps varints and length-delimited fields, ignores the rest. */
function parseProto(buffer: Buffer): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let pos = 0;
  while (pos < buffer.length) {
    const header = readVarint(buffer, pos);
    if (!header) break;
    const [key, afterKey] = header;
    pos = afterKey;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) break;
    if (wire === 0) {
      const value = readVarint(buffer, pos);
      if (!value) break;
      pos = value[1];
      pushField(fields, field, { wire, num: value[0] });
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) break;
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) break;
      pos += 4;
    } else if (wire === 2) {
      const length = readVarint(buffer, pos);
      if (!length) break;
      const [size, afterLength] = length;
      if (size < 0 || afterLength + size > buffer.length) break;
      pushField(fields, field, { wire, buf: buffer.subarray(afterLength, afterLength + size) });
      pos = afterLength + size;
    } else {
      break;
    }
  }
  return fields;
}

function pushField(fields: Map<number, ProtoField[]>, field: number, value: ProtoField): void {
  const list = fields.get(field);
  if (list) list.push(value);
  else fields.set(field, [value]);
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

function firstField(fields: Map<number, ProtoField[]>, field: number): ProtoField | undefined {
  return fields.get(field)?.[0];
}

function textField(fields: Map<number, ProtoField[]>, field: number): string {
  return firstField(fields, field)?.buf?.toString("utf8") ?? "";
}

function numField(fields: Map<number, ProtoField[]>, field: number): number {
  return firstField(fields, field)?.num ?? 0;
}

function nested(fields: Map<number, ProtoField[]>, field: number): Map<number, ProtoField[]> {
  const buf = firstField(fields, field)?.buf;
  return buf ? parseProto(buf) : new Map();
}

/** Protobuf Timestamp { seconds, nanos } → epoch ms. */
function timestampMs(fields: Map<number, ProtoField[]>, field: number): number {
  const stamp = nested(fields, field);
  const seconds = numField(stamp, 1);
  if (!seconds) return 0;
  return seconds * 1000 + Math.round(numField(stamp, 2) / 1_000_000);
}

function fileUriPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return uri.slice("file://".length);
  }
}

interface DesktopSummary {
  cascadeId: string;
  title: string;
  stepCount: number;
  createdAt: number;
  updatedAt: number;
  folder: string;
  branch: string;
  repo: string;
  origin: string;
  running: boolean;
}

interface CatalogEntry {
  cascadeId: string;
  summary: DesktopSummary | null;
  birthtimeMs: number;
  mtimeMs: number;
}

interface Endpoint {
  pid: number;
  port: number;
  token: string;
}

/**
 * CSRF 令牌只写进 0600 的 curl 配置文件：放进 argv 的话，本机任何进程 `ps` 都能读到，
 * 而 curl 的报错信息也可能把它带进错误回执转发给设备。
 */
const csrfConfigs = new Map<string, string>();

process.once("exit", () => {
  for (const file of csrfConfigs.values()) {
    try {
      rmSync(dirname(file), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function csrfConfig(token: string): string {
  const cached = csrfConfigs.get(token);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-curl-"));
  const file = join(dir, "csrf.conf");
  writeFileSync(file, `header = "X-Codeium-Csrf-Token: ${token}"\n`, { mode: 0o600 });
  csrfConfigs.set(token, file);
  return file;
}

interface StepInputItem {
  text?: string;
  item?: {
    file?: {
      absoluteUri?: string;
      workspaceUrisToRelativePaths?: Record<string, string>;
    };
  };
}

interface Step {
  type: string;
  status?: string;
  metadata?: {
    createdAt?: string;
    toolCall?: { id?: string; name?: string; argumentsJson?: string };
  };
  userInput?: { items?: StepInputItem[] };
  plannerResponse?: { response?: string; modifiedResponse?: string; stopReason?: string };
  notifyUser?: { notificationContent?: string };
  errorMessage?: { error?: { userErrorMessage?: string; shortError?: string } };
  taskBoundary?: { taskName?: string; taskStatus?: string };
  codeAction?: { description?: string };
  [key: string]: unknown;
}

interface ParsedConversation {
  messages: MessageRecord[];
  busy: boolean;
  interrupted: boolean;
  /** Untruncated text per message, kept for transfers. */
  texts: Map<string, string[]>;
}

export class AntigravityDesktopAdapter implements SessionAdapter {
  readonly key = "antigravity-desktop";
  private catalogCache: { at: number; entries: CatalogEntry[] } | null = null;
  private summariesCache: { at: number; map: Map<string, DesktopSummary> } | null = null;
  private scanCache: { at: number; endpoint: Endpoint | null; error: string | null; live: Map<string, DesktopSummary> } | null = null;
  private stepsCache = new Map<string, { at: number; steps: Step[] }>();

  app(): AppInfo {
    const store = this.storeReady();
    const { endpoint, error } = this.scan();
    const read: Completeness = store && endpoint ? "complete" : "unavailable";
    let reason: string | undefined;
    if (!store) reason = "未找到 Antigravity 桌面版的会话目录（~/.gemini/antigravity）";
    else if (!endpoint) reason = error ?? "Antigravity 桌面版未运行：能看到会话列表，但读不到会话内容";
    return {
      appId: this.key,
      provider: "google",
      kind: "antigravity-desktop",
      name: "Antigravity 桌面版",
      mode: "local-store",
      status: store ? "ready" : "unavailable",
      capabilities: {
        enumerate: store ? "complete" : "unavailable",
        read,
        send: false,
        sendDetail:
          "发送需要调用 Antigravity 桌面版语言服务的内部接口，尚未可靠接入；请在 Antigravity 中继续对话。",
        create: false,
        createDetail: "请在 Antigravity 桌面版中新建会话。",
        ...(reason ? { reason } : {}),
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const entry of this.catalog()) {
      const cwd = entry.summary?.folder ?? "";
      const projectId = this.projectIdFor(cwd);
      const existing = map.get(projectId);
      if (existing) existing.sessionCount += 1;
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
    return this.catalog().map((entry) => this.summaryOf(entry));
  }

  session(sessionId: string): SessionSummary | null {
    const entry = this.entryFor(sessionId);
    return entry ? this.summaryOf(entry) : null;
  }

  async messages(sessionId: string, page: MessagePage): Promise<MessageListResult> {
    const entry = this.entryFor(sessionId);
    if (!entry) throw new RpcError("not_found", "未知会话");
    const parsed = this.parsed(entry.cascadeId, await this.steps(entry.cascadeId));
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
      completeness: "complete",
      note: "读取 Antigravity 桌面版会话的全部步骤（含工具调用）；内容来自桌面版本地语言服务接口，非公开协议",
    };
    if (parsed.busy) result.busy = true;
    if (parsed.interrupted) result.interrupted = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  async messageText(sessionId: string, messageId: string): Promise<MessageText | null> {
    const entry = this.entryFor(sessionId);
    if (!entry) return null;
    const parsed = this.parsed(entry.cascadeId, await this.steps(entry.cascadeId));
    const message = parsed.messages.find((item) => item.messageId === messageId);
    if (!message) return null;
    return {
      messageId: message.messageId,
      role: message.role,
      createdAt: message.createdAt,
      text: (parsed.texts.get(message.messageId) ?? []).join("\n\n"),
    };
  }

  rail(sessionId: string): SessionRailResult {
    const entry = this.entryFor(sessionId);
    if (!entry) throw new RpcError("not_found", "未知会话");
    const summary = entry.summary;
    const environment: RailRow[] = [];
    if (summary?.folder) environment.push({ label: "目录", value: summary.folder });
    if (summary?.repo) environment.push({ label: "仓库", value: summary.repo });
    if (summary?.branch) environment.push({ label: "分支", value: summary.branch });
    if (summary?.stepCount) environment.push({ label: "步骤", value: String(summary.stepCount) });
    environment.push({ label: "模式", value: "桌面版（只读）" });
    const servers = mcpServers();
    const result: SessionRailResult = { environment, servers, tasks: [] };
    const notes: string[] = [];
    if (servers.length > 0) notes.push("MCP 服务器来自桌面版的全局配置");
    if (summary?.origin) notes.push(`远程：${summary.origin}`);
    if (notes.length > 0) result.note = notes.join("；");
    return result;
  }

  async send(): Promise<MessageSendResult> {
    throw new RpcError("unsupported", "Antigravity 桌面版暂不支持从 Bridge 发送消息");
  }

  private parsed(cascadeId: string, steps: Step[]): ParsedConversation {
    const sessionId = `${this.key}:${cascadeId}`;
    const messages: MessageRecord[] = [];
    const texts = new Map<string, string[]>();
    const seenTools = new Set<string>();
    let busy = false;
    let interrupted = false;

    /** Steps arrive one per assistant action; keep one message per turn. */
    const appendAssistant = (
      messageId: string,
      createdAt: number,
      blocks: MessageBlock[],
      fullText?: string,
    ): void => {
      const last = messages.at(-1);
      if (last && last.role === "assistant") {
        last.blocks.push(...blocks);
        if (!last.createdAt) last.createdAt = createdAt;
        if (fullText) {
          const list = texts.get(last.messageId);
          if (list) list.push(fullText);
          else texts.set(last.messageId, [fullText]);
        }
        return;
      }
      messages.push({ messageId, sessionId, role: "assistant", createdAt, blocks });
      texts.set(messageId, fullText ? [fullText] : []);
    };

    steps.forEach((step, index) => {
      if (step.status === "CORTEX_STEP_STATUS_RUNNING") busy = true;
      if (step.status === "CORTEX_STEP_STATUS_CANCELED") interrupted = true;
      const createdAt = Date.parse(step.metadata?.createdAt ?? "") || 0;
      const messageId = `${sessionId}:${index}`;

      if (step.type === "CORTEX_STEP_TYPE_USER_INPUT") {
        const text = userText(step).trim();
        if (!text) return;
        messages.push({
          messageId,
          sessionId,
          role: "user",
          createdAt,
          blocks: [{ type: "text", ...truncate(text, MAX_BLOCK_CHARS) }],
        });
        texts.set(messageId, [text]);
        return;
      }

      if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
        const response = step.plannerResponse;
        const text = (response?.modifiedResponse ?? "").trim() || (response?.response ?? "").trim();
        if (text) {
          appendAssistant(messageId, createdAt, [{ type: "text", ...truncate(text, MAX_BLOCK_CHARS) }], text);
        }
        return;
      }

      if (step.type === "CORTEX_STEP_TYPE_NOTIFY_USER") {
        const text = step.notifyUser?.notificationContent?.trim();
        if (text) {
          appendAssistant(messageId, createdAt, [{ type: "text", ...truncate(text, MAX_BLOCK_CHARS) }], text);
        }
        return;
      }

      if (step.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE") {
        const error = step.errorMessage?.error;
        const text = (error?.userErrorMessage ?? error?.shortError ?? "").trim();
        if (text) appendAssistant(messageId, createdAt, [{ type: "tool", ...truncate(`错误：${text}`, 400) }]);
        return;
      }

      if (SILENT_STEPS.has(step.type)) return;

      const label = toolLabel(step);
      if (!label) return;
      const toolId = step.metadata?.toolCall?.id;
      if (toolId) {
        if (seenTools.has(toolId)) return;
        seenTools.add(toolId);
      }
      appendAssistant(messageId, createdAt, [{ type: "tool", ...truncate(label, 400) }]);
    });

    return { messages, busy, interrupted, texts };
  }

  private summaryOf(entry: CatalogEntry): SessionSummary {
    const summary = entry.summary;
    const createdAt =
      summary?.createdAt || Math.round(entry.birthtimeMs) || entry.mtimeMs || summary?.updatedAt || Date.now();
    return {
      sessionId: `${this.key}:${entry.cascadeId}`,
      appId: this.key,
      projectId: this.projectIdFor(summary?.folder ?? ""),
      kind: this.key,
      title: (summary?.title || "未命名会话").slice(0, 120),
      createdAt,
      updatedAt: summary?.updatedAt || Math.round(entry.mtimeMs),
      archived: false,
      live: summary?.running === true,
      ...(summary?.running === true ? { busy: true } : {}),
      canSend: false,
      sendBlockedReason: "Antigravity 桌面版暂不支持从 Bridge 发送消息，请在 Antigravity 中继续对话",
    };
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private entryFor(sessionId: string): CatalogEntry | null {
    const cascadeId = String(sessionId).slice(this.key.length + 1);
    if (!cascadeId) return null;
    return this.catalog().find((entry) => entry.cascadeId === cascadeId) ?? null;
  }

  private storeReady(): boolean {
    return existsSync(CONVERSATIONS_DIR) || this.summaries().size > 0;
  }

  private catalog(): CatalogEntry[] {
    const now = Date.now();
    if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.entries;
    const summaries = this.summariesWithLive();
    let names: string[] = [];
    try {
      names = readdirSync(CONVERSATIONS_DIR);
    } catch {
      names = [];
    }
    const entries: CatalogEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".pb")) continue;
      const cascadeId = name.slice(0, -".pb".length);
      if (!cascadeId) continue;
      let stat;
      try {
        stat = statSync(join(CONVERSATIONS_DIR, name));
      } catch {
        continue;
      }
      entries.push({
        cascadeId,
        summary: summaries.get(cascadeId) ?? null,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
      });
    }
    // The conversation in use may not be persisted as a .pb yet; the running
    // language server still reports it and can serve its steps. State-store-only
    // summaries are left out: for those ids the language server answers
    // "trajectory not found", so listing them would only produce dead rows.
    const persisted = new Set(entries.map((entry) => entry.cascadeId));
    for (const [cascadeId, summary] of this.scan().live) {
      if (persisted.has(cascadeId)) continue;
      entries.push({ cascadeId, summary, birthtimeMs: 0, mtimeMs: 0 });
    }
    entries.sort((a, b) => this.updatedAt(b) - this.updatedAt(a));
    const limited = entries.slice(0, MAX_SESSIONS);
    this.catalogCache = { at: now, entries: limited };
    return limited;
  }

  private updatedAt(entry: CatalogEntry): number {
    return entry.summary?.updatedAt || entry.mtimeMs;
  }

  private summaries(): Map<string, DesktopSummary> {
    const now = Date.now();
    if (this.summariesCache && now - this.summariesCache.at < SUMMARIES_TTL_MS) {
      return this.summariesCache.map;
    }
    const map = readSummaries();
    this.summariesCache = { at: now, map };
    return map;
  }

  /**
   * The desktop only persists a summary once a conversation is closed, so the
   * conversation open right now is missing from the state store; the running
   * language server knows it, so its trajectory list fills the gap.
   */
  private summariesWithLive(): Map<string, DesktopSummary> {
    const merged = new Map(this.summaries());
    for (const [cascadeId, live] of this.scan().live) {
      const known = merged.get(cascadeId);
      if (!known || live.updatedAt >= known.updatedAt) {
        merged.set(cascadeId, { ...live, title: live.title || known?.title || "" });
      }
    }
    return merged;
  }

  private scan(): { endpoint: Endpoint | null; error: string | null; live: Map<string, DesktopSummary> } {
    const now = Date.now();
    if (this.scanCache && now - this.scanCache.at < ENDPOINT_TTL_MS) return this.scanCache;
    const result = findEndpoint();
    this.scanCache = {
      at: now,
      endpoint: result.endpoint,
      error: result.error,
      live: result.endpoint ? readLiveSummaries(result.endpoint, result.current) : new Map(),
    };
    return this.scanCache;
  }

  private async steps(cascadeId: string): Promise<Step[]> {
    const cached = this.stepsCache.get(cascadeId);
    const now = Date.now();
    if (cached && now - cached.at < STEPS_TTL_MS) return cached.steps;
    const { endpoint, error } = this.scan();
    if (!endpoint) {
      throw new RpcError(
        "adapter_unavailable",
        error ?? "Antigravity 桌面版未运行，暂时读不到会话内容；打开 Antigravity 后重试",
      );
    }
    const body = await this.call(endpoint, "GetCascadeTrajectorySteps", { cascadeId }, RPC_TIMEOUT_SEC);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new RpcError("adapter_unavailable", "Antigravity 桌面版返回了无法解析的数据");
    }
    if (isRecord(parsed) && typeof parsed["code"] === "string" && typeof parsed["message"] === "string") {
      throw new RpcError(
        parsed["message"].includes("not found") ? "not_found" : "adapter_unavailable",
        `Antigravity 桌面版：${parsed["message"]}`,
      );
    }
    const steps = isRecord(parsed) && Array.isArray(parsed["steps"]) ? (parsed["steps"] as Step[]) : [];
    this.stepsCache.set(cascadeId, { at: now, steps });
    return steps;
  }

  private call(endpoint: Endpoint, method: string, body: unknown, timeoutSec: number): Promise<string> {
    return execFileAsync(
      CURL_BIN,
      curlArgs(endpoint, method, JSON.stringify(body), timeoutSec, csrfConfig(endpoint.token)),
      { encoding: "utf8", timeout: (timeoutSec + 2) * 1000, maxBuffer: 64 * 1024 * 1024 },
    ).then(
      (result) => result.stdout,
      (cause: unknown) => {
        const message = (cause instanceof Error ? cause.message : String(cause)).replaceAll(
          endpoint.token,
          "***",
        );
        throw new RpcError("adapter_unavailable", `无法调用 Antigravity 桌面版接口：${message}`);
      },
    );
  }
}

function curlArgs(
  endpoint: Endpoint,
  method: string,
  body: string,
  timeoutSec: number,
  configFile: string,
): string[] {
  return [
    "-s",
    "-S",
    "--noproxy",
    "*",
    "-m",
    String(timeoutSec),
    "-X",
    "POST",
    `http://127.0.0.1:${endpoint.port}${RPC_PREFIX}${method}`,
    "--config",
    configFile,
    "-H",
    "Content-Type: application/json",
    "-H",
    "Connect-Protocol-Version: 1",
    "-d",
    body,
  ];
}

/** The desktop language server exposes a Connect/JSON API on a random localhost port. */
function findEndpoint(): { endpoint: Endpoint | null; error: string | null; current: Set<string> } {
  let listing: string;
  try {
    listing = execFileSync(PS_BIN, ["axww", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      endpoint: null,
      current: new Set(),
      error: /operation not permitted|EPERM/i.test(message)
        ? "无法枚举本机进程（ps 被拒绝），不能定位 Antigravity 桌面版"
        : `无法枚举本机进程：${message}`,
    };
  }
  const candidates: Array<{ pid: number; token: string }> = [];
  for (const line of listing.split("\n")) {
    // 2.27 起进程名从 language_server_macos 变成 language_server，靠 app_data_dir 区分产品。
    if (!/(^|[\s/])language_server(_macos)?(?=\s|$)/.test(line)) continue;
    if (!/--app_data_dir[\s=]+antigravity(\s|$)/.test(line)) continue;
    const pid = Number(line.trimStart().split(/\s+/, 1)[0]);
    const token = /--csrf_token[\s=]+(\S+)/.exec(line)?.[1];
    if (Number.isFinite(pid) && pid > 0 && token) candidates.push({ pid, token });
  }
  for (const candidate of candidates) {
    for (const port of listeningPorts(candidate.pid)) {
      const probed = probe(port, candidate.token);
      if (probed.ok) return { endpoint: { ...candidate, port }, error: null, current: probed.current };
    }
  }
  return { endpoint: null, error: null, current: new Set() };
}

function listeningPorts(pid: number): number[] {
  let output: string;
  try {
    output = execFileSync(LSOF_BIN, ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const match of output.matchAll(/:(\d{2,5}) \(LISTEN\)/g)) {
    const port = Number(match[1]);
    if (port > 0 && port < 65_536) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function probe(port: number, token: string): { ok: boolean; current: Set<string> } {
  const current = new Set<string>();
  try {
    // 2.30 的 GetUserTrajectoryDescriptions 返回空对象，改用 GetAllCascadeTrajectories 认端点，
    // 顺带从状态里认出正在运行的会话。
    const output = execFileSync(
      CURL_BIN,
      curlArgs(
        { pid: 0, port, token },
        "GetAllCascadeTrajectories",
        "{}",
        PROBE_TIMEOUT_SEC,
        csrfConfig(token),
      ),
      { encoding: "utf8", timeout: (PROBE_TIMEOUT_SEC + 1) * 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed) || !isRecord(parsed["trajectorySummaries"])) return { ok: false, current };
    for (const [cascadeId, item] of Object.entries(parsed["trajectorySummaries"])) {
      if (!isRecord(item)) continue;
      const status = typeof item["status"] === "string" ? item["status"] : "";
      if (!status.includes("RUNNING")) continue;
      const trajectoryId = item["trajectoryId"];
      current.add(typeof trajectoryId === "string" && trajectoryId ? trajectoryId : cascadeId);
    }
    return { ok: true, current };
  } catch {
    return { ok: false, current };
  }
}

function readSummaries(): Map<string, DesktopSummary> {
  const map = new Map<string, DesktopSummary>();
  let raw: unknown;
  try {
    const db = new DatabaseSync(GLOBAL_STATE_DB, { readOnly: true });
    try {
      raw = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(STATE_KEY)?.["value"];
    } finally {
      db.close();
    }
  } catch {
    return map;
  }
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString("utf8")
        : "";
  if (!text) return map;
  const root = parseProto(Buffer.from(text, "base64"));
  for (const entry of root.get(1) ?? []) {
    if (!entry.buf) continue;
    const fields = parseProto(entry.buf);
    const cascadeId = textField(fields, 1);
    const holder = firstField(fields, 2)?.buf;
    if (!cascadeId || !holder) continue;
    const payloadText = textField(parseProto(holder), 1);
    if (!payloadText) continue;
    const payload = parseProto(Buffer.from(payloadText, "base64"));
    const workspace = nested(payload, 9);
    const repo = nested(workspace, 3);
    map.set(cascadeId, {
      cascadeId,
      title: textField(payload, 1),
      stepCount: numField(payload, 2),
      updatedAt: timestampMs(payload, 3),
      createdAt: timestampMs(payload, 7),
      folder: fileUriPath(textField(workspace, 1)),
      branch: textField(workspace, 4),
      repo: textField(repo, 1),
      origin: textField(repo, 2),
      running: false,
    });
  }
  return map;
}

/** Trajectories the running language server knows about, including the open one. */
function readLiveSummaries(endpoint: Endpoint, current: Set<string>): Map<string, DesktopSummary> {
  const map = new Map<string, DesktopSummary>();
  let output: string;
  try {
    output = execFileSync(
      CURL_BIN,
      curlArgs(
        endpoint,
        "GetAllCascadeTrajectories",
        "{}",
        PROBE_TIMEOUT_SEC + 1,
        csrfConfig(endpoint.token),
      ),
      { encoding: "utf8", timeout: (PROBE_TIMEOUT_SEC + 2) * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return map;
  }
  const summaries = isRecord(parsed) ? parsed["trajectorySummaries"] : undefined;
  if (!isRecord(summaries)) return map;
  for (const [cascadeId, raw] of Object.entries(summaries)) {
    const summary = liveSummary(cascadeId, raw, current);
    if (summary) map.set(cascadeId, summary);
  }
  return map;
}

function liveSummary(cascadeId: string, raw: unknown, current: Set<string>): DesktopSummary | null {
  if (!isRecord(raw)) return null;
  const workspaces = Array.isArray(raw["workspaces"]) ? raw["workspaces"] : [];
  const workspace = isRecord(workspaces[0]) ? workspaces[0] : {};
  const repo = isRecord(workspace["repository"]) ? workspace["repository"] : {};
  const status = typeof raw["status"] === "string" ? raw["status"] : "";
  const trajectoryId = typeof raw["trajectoryId"] === "string" ? raw["trajectoryId"] : "";
  return {
    cascadeId,
    title: typeof raw["summary"] === "string" ? raw["summary"] : "",
    stepCount: typeof raw["stepCount"] === "number" ? raw["stepCount"] : 0,
    createdAt: Date.parse(typeof raw["createdTime"] === "string" ? raw["createdTime"] : "") || 0,
    updatedAt: Date.parse(typeof raw["lastModifiedTime"] === "string" ? raw["lastModifiedTime"] : "") || 0,
    folder:
      typeof workspace["workspaceFolderAbsoluteUri"] === "string"
        ? fileUriPath(workspace["workspaceFolderAbsoluteUri"])
        : "",
    branch: typeof workspace["branchName"] === "string" ? workspace["branchName"] : "",
    repo: typeof repo["computedName"] === "string" ? repo["computedName"] : "",
    origin: typeof repo["gitOriginUrl"] === "string" ? repo["gitOriginUrl"] : "",
    running: status.includes("RUNNING") || (trajectoryId !== "" && current.has(trajectoryId)),
  };
}

function userText(step: Step): string {
  const parts: string[] = [];
  for (const item of step.userInput?.items ?? []) {
    if (typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    const file = item.item?.file;
    if (!file?.absoluteUri) continue;
    const relative = Object.values(file.workspaceUrisToRelativePaths ?? {})[0];
    parts.push(`[${relative || fileUriPath(file.absoluteUri)}]`);
  }
  return parts.join("");
}

function stepPayload(step: Step): Record<string, unknown> {
  for (const [key, value] of Object.entries(step)) {
    if (key === "type" || key === "status" || key === "metadata") continue;
    if (isRecord(value)) return value;
  }
  return {};
}

function toolArg(step: Step, ...names: string[]): string {
  const json = step.metadata?.toolCall?.argumentsJson;
  if (!json) return "";
  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch {
    return "";
  }
  if (!isRecord(args)) return "";
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function toolLabel(step: Step): string {
  const payload = stepPayload(step);
  const text = (...keys: string[]): string => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const path = (...keys: string[]): string => fileUriPath(text(...keys));

  switch (step.type) {
    case "CORTEX_STEP_TYPE_RUN_COMMAND":
      return `运行 ${text("commandLine", "command")}`;
    case "CORTEX_STEP_TYPE_VIEW_FILE": {
      const start = payload["startLine"];
      const end = payload["endLine"];
      const range = typeof start === "number" ? `:${String(start)}${typeof end === "number" && end !== start ? `-${String(end)}` : ""}` : "";
      return `读取 ${path("absolutePathUri", "absolutePath")}${range}`;
    }
    case "CORTEX_STEP_TYPE_GREP_SEARCH": {
      const where = path("searchPathUri");
      return `搜索 ${text("query")}${where ? ` 于 ${where}` : ""}`;
    }
    case "CORTEX_STEP_TYPE_FIND": {
      const where = text("searchDirectory");
      return `查找 ${text("pattern")}${where ? ` 于 ${where}` : ""}`;
    }
    case "CORTEX_STEP_TYPE_LIST_DIRECTORY":
      return `列出 ${path("directoryPathUri")}`;
    case "CORTEX_STEP_TYPE_CODE_ACTION": {
      const target = toolArg(step, "TargetFile", "targetFile");
      if (target) return `编辑 ${target}`;
      const description = text("description");
      return description ? `编辑 ${truncate(description, 120).text}` : "编辑文件";
    }
    case "CORTEX_STEP_TYPE_GENERATE_IMAGE":
      return "生成图像";
    case "CORTEX_STEP_TYPE_TASK_BOUNDARY": {
      const name = text("taskName");
      const status = text("taskStatus");
      return `任务 ${name}${status ? ` · ${status}` : ""}`.trim();
    }
    default: {
      const name = step.metadata?.toolCall?.name;
      if (name) return `调用 ${name}`;
      const suffix = step.type.replace("CORTEX_STEP_TYPE_", "").toLowerCase();
      return suffix ? `调用 ${suffix}` : "";
    }
  }
}

function mcpServers(): Array<{ name: string; detail?: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(MCP_CONFIG, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(raw)) return [];
  const servers = raw["mcpServers"];
  if (!isRecord(servers)) return [];
  return Object.entries(servers)
    .slice(0, MAX_SERVERS)
    .map(([name, config]) => {
      const command = isRecord(config) && typeof config["command"] === "string" ? config["command"] : "";
      return command ? { name, detail: command } : { name };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
