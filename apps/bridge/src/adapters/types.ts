import type {
  AppInfo,
  ErrorCode,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  SessionRailResult,
  SessionSummary,
} from "@agent-bridge/protocol";

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface MessagePage {
  limit: number;
  before?: string;
}

export interface MessageText {
  messageId: string;
  role: MessageRecord["role"];
  createdAt: number;
  /** Full, untruncated text (text blocks joined by a blank line). */
  text: string;
}

export interface SessionAdapter {
  /** Stable adapter key, also the sessionId prefix. */
  readonly key: string;
  app(): AppInfo;
  projects(): ProjectInfo[];
  sessions(): SessionSummary[];
  session(sessionId: string): SessionSummary | null;
  messages(sessionId: string, page: MessagePage): MessageListResult | Promise<MessageListResult>;
  messageText(sessionId: string, messageId: string): MessageText | null | Promise<MessageText | null>;
  /** Environment, context, connectors and background tasks of one session. */
  rail(sessionId: string): SessionRailResult | Promise<SessionRailResult>;
  /** Messages written by one background task (subagent); absent when the app keeps none. */
  taskMessages?(sessionId: string, taskId: string, page: MessagePage): MessageListResult | Promise<MessageListResult>;
  /** `origin` 是发起人的标识（例如配对设备名），用于让目标会话区分消息从哪个客户端来。 */
  send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult>;
}

export function truncate(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}
