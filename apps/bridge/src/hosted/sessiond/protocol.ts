/**
 * Bridge 与会话守护进程（sessiond）之间的行分隔 JSON 协议。
 *
 * 守护进程持有 Claude Code 子进程的 stdio，所以 Bridge 重启只会断开这条连接，
 * 正在跑的那一轮不受影响；重连后按 ack 序号补齐断线期间的输出。
 */
/**
 * 升到 3：start 可以带额外的环境变量（pi 会话用 `PI_CODING_AGENT_DIR` 钉住子代理模型）。
 * 旧守护进程会忽略这个字段、按自己的环境起进程，等于设置不生效，所以版本对不上就换掉。
 */
export const SESSIOND_VERSION = 3;

/** 断线期间每个会话最多缓存这么多输出，超过就把最老的丢掉并标记断档。 */
export const SESSIOND_BUFFER_BYTES = 4 * 1024 * 1024;

/** 没有 Bridge 连接、也没有会话在跑超过这个时间，守护进程自己退出。 */
export const SESSIOND_IDLE_MS = 30 * 60_000;

export const SESSIOND_SOCKET = "sessiond.sock";

export interface SessiondHello {
  id: string;
  op: "hello";
  version: number;
}

export interface SessiondStart {
  id: string;
  op: "start";
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  /** 只传多出来的那几项，守护进程按自己的环境合并。 */
  env?: Record<string, string>;
}

export interface SessiondAttach {
  id: string;
  op: "attach";
  sessionId: string;
  /** Bridge 已经处理到的输出序号，守护进程只回放它之后的。 */
  ack: number;
}

export interface SessiondList {
  id: string;
  op: "list";
}

export interface SessiondKill {
  id: string;
  op: "kill";
  sessionId: string;
}

/** 下面三条是单向指令，没有 id，也不回执。 */
export interface SessiondStdin {
  op: "stdin";
  sessionId: string;
  data: string;
}

export interface SessiondEnd {
  op: "end";
  sessionId: string;
}

export interface SessiondAck {
  op: "ack";
  sessionId: string;
  seq: number;
}

/** Bridge 升级后协议不一致时，用它让旧守护进程收摊（会连同子进程一起结束）。 */
export interface SessiondShutdown {
  op: "shutdown";
}

export type SessiondRequest =
  | SessiondHello
  | SessiondStart
  | SessiondAttach
  | SessiondList
  | SessiondKill
  | SessiondStdin
  | SessiondEnd
  | SessiondAck
  | SessiondShutdown;

export interface SessiondChunk {
  seq: number;
  data: string;
}

export interface SessiondSessionInfo {
  sessionId: string;
  pid: number | null;
  running: boolean;
  lastSeq: number;
  ignoredSeq: number;
}

export interface SessiondAttachResult {
  pid: number | null;
  running: boolean;
  lastSeq: number;
  backlog: SessiondChunk[];
  /** 断线期间缓存溢出，backlog 不完整。 */
  gap: boolean;
  /** 这个进程当初的启动参数；旧版守护进程没有这一项。 */
  args?: string[];
}

export interface SessiondReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface SessiondStdoutEvent {
  op: "stdout";
  sessionId: string;
  seq: number;
  data: string;
}

export interface SessiondStderrEvent {
  op: "stderr";
  sessionId: string;
  data: string;
}

export interface SessiondExitEvent {
  op: "exit";
  sessionId: string;
  code: number | null;
  signal: string | null;
}

export interface SessiondErrorEvent {
  op: "error";
  sessionId: string;
  code: string;
  message: string;
}

export type SessiondEvent =
  | SessiondStdoutEvent
  | SessiondStderrEvent
  | SessiondExitEvent
  | SessiondErrorEvent;

export type SessiondMessage = SessiondReply | SessiondEvent;
