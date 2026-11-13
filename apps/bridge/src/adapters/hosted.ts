import type {
  AppInfo,
  MessageListResult,
  MessageSendResult,
  ProjectInfo,
  SessionModelsResult,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";
import type { HostedSessionManager } from "../hosted/manager.js";

export const HOSTED_APP_ID = "hosted";

/**
 * Sessions whose Claude Code process Bridge starts and owns. They are not
 * desktop sessions: Bridge writes their stdin directly with user turns.
 */
export class HostedAdapter implements SessionAdapter {
  readonly key = HOSTED_APP_ID;

  constructor(private readonly manager: HostedSessionManager) {}

  app(): AppInfo {
    const config = this.manager.configForClient();
    return {
      appId: HOSTED_APP_ID,
      provider: "anthropic",
      kind: "hosted",
      // 这里既能托管 Claude Code 也能托管 pi，别再写死引擎名。
      name: "Bridge 托管",
      mode: "cli",
      status: "ready",
      capabilities: {
        enumerate: "complete",
        read: "complete",
        send: true,
        create: true,
        ...(config.enabled
          ? {}
          : { createDetail: config.note ?? "未配置可托管的目录" }),
      },
    };
  }

  projects(): ProjectInfo[] {
    return this.manager.projects();
  }

  sessions(): SessionSummary[] {
    return this.manager.sessions();
  }

  session(sessionId: string): SessionSummary | null {
    return this.manager.session(sessionId);
  }

  messages(sessionId: string, page: MessagePage): MessageListResult {
    return this.manager.messagesFor(sessionId, page);
  }

  messageText(sessionId: string, messageId: string): MessageText | null {
    return this.manager.messageText(sessionId, messageId);
  }

  rail(sessionId: string): SessionRailResult {
    return this.manager.rail(sessionId);
  }

  models(sessionId: string): SessionModelsResult {
    return this.manager.models(sessionId);
  }

  async send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult> {
    const session = this.manager.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知托管会话");
    if (!session.canSend) {
      throw new RpcError("adapter_unavailable", session.sendBlockedReason ?? "该托管会话当前不可发送");
    }
    return this.manager.send(sessionId, text, origin);
  }
}
