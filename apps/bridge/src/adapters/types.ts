import type {
  AppInfo,
  ErrorCode,
  MessageListResult,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  SessionRailResult,
  SessionModelsResult,
  SessionCompactResult,
  SessionSummary,
} from "@craftstead/protocol";

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
  projects(): ProjectInfo[] | Promise<ProjectInfo[]>;
  sessions(): SessionSummary[] | Promise<SessionSummary[]>;
  session(sessionId: string): SessionSummary | null | Promise<SessionSummary | null>;
  messages(sessionId: string, page: MessagePage): MessageListResult | Promise<MessageListResult>;
  messageText(sessionId: string, messageId: string): MessageText | null | Promise<MessageText | null>;
  /** Environment, context, connectors and background tasks of one session. */
  rail(sessionId: string): SessionRailResult | Promise<SessionRailResult>;
  /** 当前模型与可选模型；客户端没有这个概念时可以不实现。 */
  models?(sessionId: string): SessionModelsResult | Promise<SessionModelsResult>;
  /** 让客户端自己压缩该会话的上下文；客户端没有原生入口时可以不实现。 */
  compact?(sessionId: string): Promise<SessionCompactResult>;
  /** Messages written by one background task (subagent); absent when the app keeps none. */
  taskMessages?(sessionId: string, taskId: string, page: MessagePage): MessageListResult | Promise<MessageListResult>;
  /** `origin` 是发起人的标识（例如配对设备名），用于让目标会话区分消息从哪个客户端来。 */
  send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult>;
  /** 客户端没有可用的无界面入口时可以不实现；实现后 capabilities.create 才能为 true。 */
  create?(params: { projectId: string; text: string }): Promise<SessionSummary>;
}

export function truncate(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}
