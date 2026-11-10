export const PROTOCOL_VERSION = 1 as const;
export const RELAY_PROTOCOL_VERSION = 2 as const;

/** Max plaintext bytes carried by one Noise transport message. */
export const MAX_FRAME_BYTES = 32 * 1024;
/** Max reassembled business message size. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Max concurrently reassembled messages per channel. */
export const MAX_PENDING_MESSAGES = 8;
/** Reassembly timeout for a chunked message. */
export const CHUNK_TTL_MS = 60_000;

export const RELAY_WS_PATH = "/v1/ws";
export const RELAY_PING = '{"v":1,"type":"ping"}';
export const RELAY_PONG = '{"v":1,"type":"pong"}';

export type RelayRole = "bridge" | "browser";

export type RelayCredential =
  | { kind: "bridge"; token: string }
  /** Only the SHA-256 of the invite token is sent, so the relay never learns the PSK input. */
  | { kind: "invite"; tokenHash: string }
  | { kind: "device"; deviceId: string; token: string };

export interface RelayHello {
  v: typeof RELAY_PROTOCOL_VERSION;
  type: "hello";
  role: RelayRole;
  room: string;
  /** 32 hex chars. Required for browser connections. */
  channel?: string;
  credential: RelayCredential;
}

export type RelayErrorCode =
  | "bad_request"
  | "invalid_credential"
  | "invite_expired"
  | "invite_used"
  | "device_expired"
  | "device_revoked"
  | "bridge_offline"
  | "channel_in_use"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export type RelayServerMessage =
  | {
      v: typeof RELAY_PROTOCOL_VERSION;
      type: "ready";
      role: RelayRole;
      channel?: string;
      bridgeOnline: boolean;
    }
  | {
      v: typeof RELAY_PROTOCOL_VERSION;
      type: "error";
      code: RelayErrorCode;
      message: string;
    }
  | {
      v: typeof RELAY_PROTOCOL_VERSION;
      type: "channel.open";
      channel: string;
      mode: "pair" | "device";
      deviceId?: string;
      inviteId?: string;
      name?: string;
    }
  | {
      v: typeof RELAY_PROTOCOL_VERSION;
      type: "channel.close";
      channel: string;
      reason?: string;
    }
  | {
      v: typeof RELAY_PROTOCOL_VERSION;
      type: "peer.state";
      bridgeOnline: boolean;
    };

/** Bridge → relay control frames carried as text. */
export interface RelayBridgeControl {
  v: typeof RELAY_PROTOCOL_VERSION;
  type: "channel.close";
  channel: string;
  reason?: string;
}

/** 16-byte channel id prefix on relay binary frames plus Noise ciphertext. */
export const RELAY_CHANNEL_BYTES = 16;

export const METHODS = [
  "pair.request",
  "host.info",
  "host.capabilities",
  "app.list",
  "project.list",
  "session.list",
  "session.get",
  "session.rail",
  "task.messages",
  "message.list",
  "session.subscribe",
  "session.unsubscribe",
  "sync.resume",
  "message.send",
  "turn.cancel",
  "approval.respond",
  "transfer.prepare",
  "transfer.commit",
  "file.upload.begin",
  "file.upload.chunk",
  "file.upload.finish",
  "operation.get",
  "device.list",
  "device.revoke",
  "fs.roots",
  "fs.list",
  "fs.read",
  "shell.exec",
  "shell.cancel",
] as const;

export type Method = (typeof METHODS)[number];

export const EVENT_NAMES = [
  "session.updated",
  "message.delta",
  "message.completed",
  "approval.required",
  "capabilities.changed",
  "host.status",
  "shell.output",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const ERROR_CODES = [
  "invalid_params",
  "not_found",
  "unsupported",
  "unauthorized",
  "conflict",
  "operation_conflict",
  "stale_cursor",
  "adapter_unavailable",
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RequestMessage {
  v: typeof PROTOCOL_VERSION;
  kind: "request";
  id: string;
  method: Method;
  params?: unknown;
  /** Idempotency key for mutating methods. */
  operationId?: string;
}

export interface ResponseMessage {
  v: typeof PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: ErrorCode; message: string; data?: unknown };
}

export interface EventMessage {
  v: typeof PROTOCOL_VERSION;
  kind: "event";
  event: EventName;
  data?: unknown;
}

export interface ChunkMessage {
  v: typeof PROTOCOL_VERSION;
  kind: "chunk";
  messageId: string;
  seq: number;
  total: number;
  /** base64 of this slice of the serialized message. */
  data: string;
}

export type WireMessage =
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | ChunkMessage;

export interface PairRequestParams {
  deviceName: string;
  platform?: string;
  /** 6-digit code the user must confirm on both screens. */
  confirmCode: string;
}

export interface PairResult {
  deviceId: string;
  reconnectToken: string;
  expiresAt: number | null;
  confirmCode: string;
  bridge: { name: string; version: string; platform: string };
}

export interface DeviceSummary {
  deviceId: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
}

export interface HostInfoResult {
  name: string;
  version: string;
  platform: string;
  adapters: Array<{
    id: string;
    status: "ready" | "unavailable" | "needs_permission";
    label?: string;
    detail?: string;
  }>;
  /** Present only while the local user has opened the remote devtools switch. */
  devtools?: DevtoolsStatus;
}

// ---- Remote devtools (files + single command execution) ----

export const DEVTOOLS_CAPABILITIES = ["files", "terminal"] as const;

export type DevtoolsCapabilityName = (typeof DEVTOOLS_CAPABILITIES)[number];

/** One independently switched capability; `expiresAt` null means until it is turned off. */
export interface DevtoolsCapability {
  enabled: boolean;
  expiresAt: number | null;
}

/**
 * Reading project files and running commands are separate switches: the browser is
 * read-only and stays inside one project, while a command can write anywhere.
 */
export interface DevtoolsStatus {
  files: DevtoolsCapability;
  terminal: DevtoolsCapability;
}

export interface FsRoot {
  name: string;
  path: string;
}

/**
 * `root` is the project directory the chat belongs to; the bridge refuses anything else.
 * `sessionId` is what ties the request to that chat: the bridge checks the session's
 * project resolves to `root`, so a device cannot aim the browser at another project.
 */
export interface FsRootsParams {
  sessionId: string;
  root: string;
}

export interface FsRootsResult {
  enabled: boolean;
  roots: FsRoot[];
}

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface FsListParams {
  /** The chat whose project directory is being browsed. */
  sessionId: string;
  /** Project directory of the chat; every read is confined to it. */
  root: string;
  path?: string;
}

export interface FsListResult {
  path: string;
  /** Parent directory, null at a root. */
  parent: string | null;
  entries: FsEntry[];
}

export interface FsReadParams {
  sessionId: string;
  root: string;
  path: string;
}

export interface FsReadResult {
  path: string;
  name: string;
  mime: string;
  size: number;
  mtime: number;
  truncated: boolean;
  /** Set for text-like files. */
  text?: string;
  /** Set for images, base64 encoded. */
  dataBase64?: string;
}

export interface ShellExecParams {
  /** The chat whose project directory the command runs in. */
  sessionId: string;
  /** Project directory of the chat; the command starts there unless `cwd` names a path inside it. */
  root: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellExecResult {
  execId: string;
  cwd: string;
}

export interface ShellCancelParams {
  execId: string;
}

export interface ShellCancelResult {
  ok: boolean;
  killed: boolean;
}

export type ShellEventData =
  | { execId: string; type: "stdout" | "stderr"; data: string }
  | {
      execId: string;
      type: "exit";
      code: number | null;
      signal: string | null;
      killed: boolean;
      durationMs: number;
      truncated: boolean;
    };

// ---- Sessions ----

export type AdapterMode = "official" | "cli" | "local-store" | "ui-automation";

/** How complete an adapter's view is; never claim complete without evidence. */
export type Completeness = "complete" | "partial" | "unknown" | "unavailable";

export interface AdapterCapabilities {
  enumerate: Completeness;
  read: Completeness;
  send: boolean;
  /** Why sending is limited, even when it is available in some cases. */
  sendDetail?: string;
  /** Whether the adapter can start a new conversation in a project. */
  create: boolean;
  /** Why creating a conversation is unavailable. */
  createDetail?: string;
  /** Why an operation is unavailable. */
  reason?: string;
}

export interface AppInfo {
  appId: string;
  provider: "anthropic" | "openai" | "google" | "deepseek";
  kind: "claude-code" | "codex" | "antigravity" | "antigravity-desktop" | "dsh";
  name: string;
  version?: string;
  mode: AdapterMode;
  status: "ready" | "unavailable" | "needs_permission";
  capabilities: AdapterCapabilities;
}

export interface ProjectInfo {
  projectId: string;
  appId: string;
  name: string;
  cwd?: string;
  sessionCount: number;
}

export interface SessionSummary {
  sessionId: string;
  appId: string;
  projectId: string;
  kind: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Desktop currently holds a live process / open view for this session. */
  live: boolean;
  /** The session process is actively running a turn right now. */
  busy?: boolean;
  canSend: boolean;
  /** Set when canSend is false. */
  sendBlockedReason?: string;
  /**
   * The directory the session actually works in. A worktree session keeps the
   * original repository as its project but runs in `.claude/worktrees/<name>`;
   * remote tools (file browsing, commands) must start here, not at the project.
   */
  cwd?: string;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageBlock {
  type: "text" | "tool";
  text: string;
  truncated?: boolean;
}

export interface MessageRecord {
  messageId: string;
  sessionId: string;
  role: MessageRole;
  createdAt: number;
  blocks: MessageBlock[];
  /** `peer` marks a message injected by another local agent session. */
  origin?: "local" | "peer";
}

export interface AppListResult {
  apps: AppInfo[];
}

export interface ProjectListResult {
  projects: ProjectInfo[];
}

export interface SessionListResult {
  sessions: SessionSummary[];
  completeness: Completeness;
  /** Set when completeness is not complete. */
  note?: string;
}

export interface SessionGetResult {
  session: SessionSummary;
}

export interface ContextDetail {
  label: string;
  value: string;
}

/** How much of the model context window the session currently occupies. */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  model?: string;
  /** True when the window size is an assumption rather than reported by the client. */
  windowEstimated?: boolean;
  /** Client specific rows for the details popover. */
  details?: ContextDetail[];
}

export interface MessageListResult {
  messages: MessageRecord[];
  /** Pass as `before` to load the previous page. Absent when at the start. */
  nextBefore?: string;
  completeness: Completeness;
  note?: string;
  /** Context window usage of the session, when the client exposes it. */
  context?: ContextUsage;
  /** The client is still working on the latest turn. */
  busy?: boolean;
  /** The latest turn was stopped by the user before it finished. */
  interrupted?: boolean;
}

export interface MessageSendResult {
  accepted: boolean;
  /** True only when the target confirmed delivery. */
  delivered: boolean;
  detail?: string;
}

/** One environment row of the session rail. */
export interface RailRow {
  label: string;
  value: string;
}

/** A background task (subagent) spawned inside a session. */
export interface RailTask {
  taskId: string;
  name: string;
  detail?: string;
  kind: "subagent" | "background";
  agentType?: string;
  model?: string;
  status: "running" | "done";
  startedAt?: number;
  updatedAt?: number;
  /** 1 for tasks the session spawned directly. */
  depth?: number;
}

/** What the session rail shows beside the conversation. */
export interface SessionRailResult {
  environment: RailRow[];
  context?: ContextUsage;
  servers: Array<{ name: string; detail?: string }>;
  tasks: RailTask[];
  note?: string;
}

export interface SessionRailParams {
  sessionId: string;
}

export interface TaskMessagesParams {
  sessionId: string;
  taskId: string;
  limit?: number;
  before?: string;
}

export interface SessionListParams {
  appId?: string;
  projectId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface MessageListParams {
  sessionId: string;
  limit?: number;
  before?: string;
}

export interface MessageAttachment {
  name: string;
  mime: string;
  size: number;
  /** Absolute path on the bridge host. */
  path: string;
  kind: "image" | "file";
}

export interface MessageSendParams {
  sessionId: string;
  text: string;
  attachments?: MessageAttachment[];
}

export interface FileUploadBeginParams {
  sessionId: string;
  name: string;
  mime: string;
  size: number;
}

export interface FileUploadBeginResult {
  uploadId: string;
  /** Raw bytes per upload.chunk call (base64 expands by ~4/3). */
  chunkSize: number;
}

export interface FileUploadChunkParams {
  uploadId: string;
  index: number;
  /** base64 of the raw chunk bytes. */
  data: string;
}

export interface FileUploadChunkResult {
  uploadId: string;
  received: number;
}

export interface FileUploadFinishParams {
  uploadId: string;
}

export interface FileUploadFinishResult {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  kind: "image" | "file";
}

export interface TransferPrepareParams {
  sourceSessionId: string;
  messageId: string;
  targetSessionId: string;
}

export interface TransferSourceInfo {
  sessionId: string;
  title: string;
  messageId: string;
  role: MessageRecord["role"];
  createdAt: number;
}

export interface TransferTargetInfo {
  sessionId: string;
  title: string;
  appId: string;
  canSend: boolean;
  sendBlockedReason?: string;
}

export interface TransferPrepareResult {
  transferId: string;
  /** Epoch ms after which the prepared transfer is discarded. */
  expiresAt: number;
  /** Full, untruncated text the target will receive. */
  text: string;
  textLength: number;
  source: TransferSourceInfo;
  target: TransferTargetInfo;
  note?: string;
}

export interface TransferCommitParams {
  transferId: string;
}

export interface TransferCommitResult extends MessageSendResult {
  transferId: string;
  targetSessionId: string;
  textLength: number;
}

// ---- REST ----

export interface CreateRoomRequest {
  roomId?: string;
  label?: string;
}

export interface CreateRoomResponse {
  roomId: string;
  bridgeToken: string;
}

export interface CreateInviteRequest {
  inviteId: string;
  /** SHA-256 of the invite token, hex. The raw token never leaves the bridge. */
  tokenHash: string;
  ttlSeconds?: number;
}

export interface InviteResponse {
  inviteId: string;
  expiresAt: number;
}

export interface RegisterDeviceRequest {
  deviceId: string;
  name: string;
  publicKey: string;
  ttlSeconds?: number | null;
}

export interface RegisterDeviceResponse {
  deviceId: string;
  reconnectToken: string;
  expiresAt: number | null;
}

export interface DeviceListResponse {
  devices: DeviceSummary[];
}

export interface RoomStatusResponse {
  roomId: string;
  bridgeOnline: boolean;
  deviceCount: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseRelayHello(value: unknown): RelayHello | null {  if (!isObject(value)) return null;
  if (value["v"] !== RELAY_PROTOCOL_VERSION) return null;
  if (value["type"] !== "hello") return null;
  const role = value["role"];
  if (role !== "bridge" && role !== "browser") return null;
  const room = value["room"];
  if (!isString(room) || !/^[a-z0-9-]{8,64}$/.test(room)) return null;
  const credential = value["credential"];
  if (!isObject(credential)) return null;
  const kind = credential["kind"];
  let parsed: RelayCredential;
  if (kind === "invite") {
    const tokenHash = credential["tokenHash"];
    if (!isString(tokenHash) || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    parsed = { kind, tokenHash };
  } else if (kind === "bridge" || kind === "device") {
    const token = credential["token"];
    if (!isString(token) || token.length < 16 || token.length > 256) return null;
    if (kind === "bridge") {
      parsed = { kind, token };
    } else {
      const deviceId = credential["deviceId"];
      if (!isString(deviceId) || !/^[a-z0-9-]{8,64}$/.test(deviceId)) return null;
      parsed = { kind, deviceId, token };
    }
  } else {
    return null;
  }
  const channel = value["channel"];
  if (role === "browser") {
    if (!isString(channel) || !/^[0-9a-f]{32}$/.test(channel)) return null;
  } else if (channel !== undefined) {
    return null;
  }
  return channel === undefined
    ? { v: RELAY_PROTOCOL_VERSION, type: "hello", role, room, credential: parsed }
    : { v: RELAY_PROTOCOL_VERSION, type: "hello", role, room, channel, credential: parsed };
}

export function parseWireMessage(value: unknown): WireMessage | null {
  if (!isObject(value) || value["v"] !== PROTOCOL_VERSION) return null;
  const kind = value["kind"];
  if (kind === "request") {
    const id = value["id"];
    const method = value["method"];
    if (!isString(id) || id.length === 0 || id.length > 64) return null;
    if (!isString(method) || !(METHODS as readonly string[]).includes(method)) return null;
    return value as unknown as RequestMessage;
  }
  if (kind === "response") {
    const id = value["id"];
    if (!isString(id) || typeof value["ok"] !== "boolean") return null;
    return value as unknown as ResponseMessage;
  }
  if (kind === "event") {
    const event = value["event"];
    if (!isString(event) || !(EVENT_NAMES as readonly string[]).includes(event)) return null;
    return value as unknown as EventMessage;
  }
  if (kind === "chunk") {
    const { messageId, seq, total, data } = value;
    if (!isString(messageId) || !isString(data)) return null;
    if (typeof seq !== "number" || typeof total !== "number") return null;
    if (!Number.isInteger(seq) || !Number.isInteger(total)) return null;
    if (seq < 0 || total < 1 || total > 4096 || seq >= total) return null;
    return value as unknown as ChunkMessage;
  }
  return null;
}

export function isRequest(message: WireMessage): message is RequestMessage {
  return message.kind === "request";
}

export function isResponse(message: WireMessage): message is ResponseMessage {
  return message.kind === "response";
}

export function isEvent(message: WireMessage): message is EventMessage {
  return message.kind === "event";
}

export function isChunk(message: WireMessage): message is ChunkMessage {
  return message.kind === "chunk";
}

export function parseBridgeControl(value: unknown): RelayBridgeControl | null {
  if (!isObject(value)) return null;
  if (value["v"] !== RELAY_PROTOCOL_VERSION || value["type"] !== "channel.close") return null;
  const channel = value["channel"];
  if (!isString(channel) || !/^[0-9a-f]{32}$/.test(channel)) return null;
  const reason = value["reason"];
  if (reason !== undefined && !isString(reason)) return null;
  return reason === undefined
    ? { v: RELAY_PROTOCOL_VERSION, type: "channel.close", channel }
    : { v: RELAY_PROTOCOL_VERSION, type: "channel.close", channel, reason };
}
