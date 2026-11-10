import { randomUUID } from "node:crypto";
import type {
  AppInfo,
  AppListResult,
  MessageListResult,
  MessageSendResult,
  ProjectInfo,
  ProjectListResult,
  SessionGetResult,
  SessionListParams,
  SessionListResult,
  SessionRailResult,
  SessionSummary,
  TransferCommitResult,
  TransferPrepareResult,
} from "@agent-bridge/protocol";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { RpcError, type SessionAdapter } from "./types.js";

const DEFAULT_SESSION_LIMIT = 200;
const MAX_SESSION_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
const MAX_TRANSFER_CHARS = 200_000;
const TRANSFER_TTL_MS = 120_000;

interface PreparedTransfer {
  deviceId: string;
  targetSessionId: string;
  text: string;
  expiresAt: number;
}

export class SessionAdapters {
  private readonly adapters: SessionAdapter[] = [new ClaudeCodeAdapter(), new CodexAdapter()];
  private readonly transfers = new Map<string, PreparedTransfer>();

  hostAdapters(): Array<{ id: string; status: "ready" | "unavailable" | "needs_permission"; label: string; detail?: string }> {
    return this.adapters.map((adapter) => {
      const app = adapter.app();
      const entry: { id: string; status: "ready" | "unavailable" | "needs_permission"; label: string; detail?: string } = {
        id: app.appId,
        status: app.status,
        label: app.name,
      };
      const detail = app.capabilities.reason ?? app.capabilities.sendDetail;
      if (detail) entry.detail = detail;
      return entry;
    });
  }

  apps(): AppListResult {
    return { apps: this.adapters.map((adapter) => adapter.app()) };
  }

  projects(appId?: string): ProjectListResult {
    const projects: ProjectInfo[] = [];
    for (const adapter of this.adapters) {
      if (appId && adapter.key !== appId) continue;
      projects.push(...adapter.projects());
    }
    return { projects };
  }

  sessions(params: SessionListParams): SessionListResult {
    const limit = clamp(params.limit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
    let completeness: SessionListResult["completeness"] = "complete";
    const notes: string[] = [];
    const collected: SessionSummary[] = [];
    for (const adapter of this.adapters) {
      if (params.appId && adapter.key !== params.appId) continue;
      const app = adapter.app();
      if (app.capabilities.enumerate === "unavailable") {
        completeness = demote(completeness, "partial");
        const reason = app.capabilities.reason ?? "适配器不可用";
        notes.push(`${app.name}：${reason}`);
        continue;
      }
      const sessions = adapter.sessions().filter((session) => {
        if (params.projectId && session.projectId !== params.projectId) return false;
        if (!params.includeArchived && session.archived) return false;
        return true;
      });
      if (app.capabilities.enumerate !== "complete") {
        completeness = demote(completeness, app.capabilities.enumerate === "unknown" ? "unknown" : "partial");
      }
      collected.push(...sessions);
    }
    collected.sort((a, b) => b.updatedAt - a.updatedAt);
    const result: SessionListResult = {
      sessions: collected.slice(0, limit),
      completeness,
    };
    if (collected.length > limit) {
      result.completeness = demote(result.completeness, "partial");
      notes.push(`会话较多，仅返回最近 ${limit} 条`);
    }
    if (notes.length > 0) result.note = notes.join("；");
    return result;
  }

  session(sessionId: string): SessionGetResult {
    const adapter = this.adapterFor(sessionId);
    const session = adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    return { session };
  }

  async messages(sessionId: string, params: { limit?: number; before?: string }): Promise<MessageListResult> {
    const adapter = this.adapterFor(sessionId);
    if (!adapter.session(sessionId)) throw new RpcError("not_found", "未知会话");
    const limit = clamp(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    return adapter.messages(sessionId, { limit, ...(params.before ? { before: params.before } : {}) });
  }

  async rail(sessionId: string): Promise<SessionRailResult> {
    const adapter = this.adapterFor(sessionId);
    if (!adapter.session(sessionId)) throw new RpcError("not_found", "未知会话");
    return adapter.rail(sessionId);
  }

  async taskMessages(
    sessionId: string,
    taskId: string,
    params: { limit?: number; before?: string },
  ): Promise<MessageListResult> {
    const adapter = this.adapterFor(sessionId);
    if (!adapter.session(sessionId)) throw new RpcError("not_found", "未知会话");
    if (!adapter.taskMessages) throw new RpcError("unsupported", "该来源不提供子任务记录");
    const limit = clamp(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    return adapter.taskMessages(sessionId, taskId, {
      limit,
      ...(params.before ? { before: params.before } : {}),
    });
  }

  async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const adapter = this.adapterFor(sessionId);
    const session = adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    if (!session.canSend) {
      throw new RpcError("adapter_unavailable", session.sendBlockedReason ?? "该会话当前不可发送");
    }
    return adapter.send(sessionId, text);
  }

  async prepareTransfer(
    deviceId: string,
    params: { sourceSessionId: string; messageId: string; targetSessionId: string },
  ): Promise<TransferPrepareResult> {
    this.pruneTransfers();
    const sourceAdapter = this.adapterFor(params.sourceSessionId);
    const source = sourceAdapter.session(params.sourceSessionId);
    if (!source) throw new RpcError("not_found", "来源会话不存在");
    const targetAdapter = this.adapterFor(params.targetSessionId);
    const target = targetAdapter.session(params.targetSessionId);
    if (!target) throw new RpcError("not_found", "目标会话不存在");
    const message = await sourceAdapter.messageText(params.sourceSessionId, params.messageId);
    if (!message) throw new RpcError("not_found", "找不到该消息，或该消息没有可转发的文本");
    const text = message.text;
    if (!text.trim()) throw new RpcError("invalid_params", "该消息没有可转发的文本");
    if (text.length > MAX_TRANSFER_CHARS) {
      throw new RpcError(
        "invalid_params",
        `消息过长（${text.length} 字符，上限 ${MAX_TRANSFER_CHARS}）`,
      );
    }

    const transferId = randomUUID();
    const expiresAt = Date.now() + TRANSFER_TTL_MS;
    this.transfers.set(transferId, {
      deviceId,
      targetSessionId: target.sessionId,
      text,
      expiresAt,
    });
    const result: TransferPrepareResult = {
      transferId,
      expiresAt,
      text,
      textLength: text.length,
      source: {
        sessionId: source.sessionId,
        title: source.title,
        messageId: message.messageId,
        role: message.role,
        createdAt: message.createdAt,
      },
      target: {
        sessionId: target.sessionId,
        title: target.title,
        appId: target.appId,
        canSend: target.canSend,
        ...(target.sendBlockedReason ? { sendBlockedReason: target.sendBlockedReason } : {}),
      },
    };
    if (!target.canSend) {
      result.note = target.sendBlockedReason ?? "目标会话当前不可发送";
    }
    return result;
  }

  async commitTransfer(deviceId: string, transferId: string): Promise<TransferCommitResult> {
    this.pruneTransfers();
    const prepared = this.transfers.get(transferId);
    if (!prepared) {
      throw new RpcError("invalid_params", "转发已过期或已提交，请重新预览后再发送");
    }
    if (prepared.deviceId !== deviceId) {
      throw new RpcError("invalid_params", "转发不属于当前设备，请重新预览");
    }
    // Consume before sending so a double click cannot submit twice.
    this.transfers.delete(transferId);
    const target = this.adapterFor(prepared.targetSessionId).session(prepared.targetSessionId);
    if (!target) throw new RpcError("not_found", "目标会话已不存在");
    if (!target.canSend) {
      throw new RpcError(
        "adapter_unavailable",
        target.sendBlockedReason ?? "目标会话当前不可发送",
      );
    }
    const sent = await this.send(prepared.targetSessionId, prepared.text);
    return {
      ...sent,
      transferId,
      targetSessionId: prepared.targetSessionId,
      textLength: prepared.text.length,
    };
  }

  private pruneTransfers(): void {
    const now = Date.now();
    for (const [id, entry] of this.transfers) {
      if (entry.expiresAt <= now) this.transfers.delete(id);
    }
  }

  private adapterFor(sessionId: string): SessionAdapter {
    const key = sessionId.split(":", 1)[0] ?? "";
    const adapter = this.adapters.find((item) => item.key === key);
    if (!adapter) throw new RpcError("not_found", "未知会话来源");
    return adapter;
  }
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function demote(
  current: SessionListResult["completeness"],
  next: SessionListResult["completeness"],
): SessionListResult["completeness"] {
  const rank = { complete: 0, partial: 1, unknown: 2, unavailable: 3 } as const;
  return rank[next] > rank[current] ? next : current;
}

export type { AppInfo };
