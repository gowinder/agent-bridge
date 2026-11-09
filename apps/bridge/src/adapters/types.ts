import type {
  AppInfo,
  ErrorCode,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
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
  send(sessionId: string, text: string): Promise<MessageSendResult>;
}

export function truncate(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}
