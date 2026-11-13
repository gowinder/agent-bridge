import { randomUUID } from "node:crypto";
import { MAX_TRANSFER_CHARS } from "@craftstead/protocol";
import type {
  AppInfo,
  AppListResult,
  HostedCreateParams,
  HostedDirsResult,
  HostedInterruptResult,
  HostedOptionsResult,
  HostedPermissionMode,
  HostedResumeResult,
  HostedStopResult,
  MessageListResult,
  MessageSendResult,
  ProjectInfo,
  ProjectListResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionGetResult,
  SessionListParams,
  SessionListResult,
  SessionModelsResult,
  SessionCompactResult,
  SessionRailResult,
  SessionSummary,
  TransferCommitResult,
  TransferPrepareResult,
} from "@craftstead/protocol";
import { HostedSessionManager, MAX_TITLE_CHARS } from "../hosted/manager.js";
import type { Store } from "../store.js";
import { AntigravityAdapter } from "./antigravity.js";
import { AntigravityDesktopAdapter } from "./antigravity-desktop.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { ClaudeCodeCliAdapter } from "./claude-code-cli.js";
import { CodexAdapter } from "./codex.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { DshAdapter } from "./dsh.js";
import { HostedAdapter } from "./hosted.js";
import { PiAdapter } from "./pi.js";
import { RpcError, type SessionAdapter } from "./types.js";

const DEFAULT_SESSION_LIMIT = 200;
const MAX_SESSION_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
const TRANSFER_TTL_MS = 120_000;

interface PreparedTransfer {
  deviceId: string;
  targetSessionId: string;
  text: string;
  expiresAt: number;
}

export class SessionAdapters {
  private readonly hostedManager = new HostedSessionManager({ log: (line) => console.log(line) });
  private readonly store: Store;
  private readonly adapters: SessionAdapter[];
  private readonly transfers = new Map<string, PreparedTransfer>();

  constructor(store: Store) {
    this.store = store;
    this.adapters = [
      new ClaudeCodeAdapter(),
      new ClaudeCodeCliAdapter(),
      new CodexAdapter(),
      new CodexCliAdapter(),
      new AntigravityAdapter(),
      new AntigravityDesktopAdapter(),
      new DshAdapter(),
      new PiAdapter(),
      new HostedAdapter(this.hostedManager),
    ];
  }

  /** 桌面应用的新建会话：由 Bridge 代它起一次无界面运行，第一条消息随创建发出。 */
  async createSession(params: SessionCreateParams): Promise<SessionCreateResult> {
    const adapter = this.adapters.find((item) => item.key === params.appId);
    if (!adapter) throw new RpcError("invalid_params", `未知客户端：${params.appId}`);
    if (!adapter.create || !adapter.app().capabilities.create) {
      throw new RpcError("unsupported", "这个客户端还不支持从网页新建会话");
    }
    const text = params.text.trim();
    if (!text) throw new RpcError("invalid_params", "第一条消息不能为空");
    return { session: await adapter.create({ projectId: params.projectId, text }) };
  }

  hostedDirs(): HostedDirsResult {
    return this.hostedManager.configForClient();
  }

  hostedModes(): HostedPermissionMode[] {
    return this.hostedManager.remotePermissionModes();
  }

  /** 设置界面看到的托管配置，对应状态目录里的 hosted.json。 */
  hostedConfig(): { allowBypassPermissions: boolean; dirs: string[]; idleTimeoutMs: number } {
    const info = this.hostedManager.configForClient();
    return {
      allowBypassPermissions: info.allowBypassPermissions,
      dirs: info.dirs.map((dir) => dir.path),
      idleTimeoutMs: info.idleTimeoutMs,
    };
  }

  setHostedAllowBypass(enabled: boolean): { allowBypassPermissions: boolean; dirs: string[]; idleTimeoutMs: number } {
    const info = this.hostedManager.setAllowBypassPermissions(enabled);
    return {
      allowBypassPermissions: info.allowBypassPermissions,
      dirs: info.dirs.map((dir) => dir.path),
      idleTimeoutMs: info.idleTimeoutMs,
    };
  }

  hostedAddDir(path: string): HostedDirsResult {
    return this.hostedManager.addDir(path);
  }

  hostedRemoveDir(path: string): HostedDirsResult {
    return this.hostedManager.removeDir(path);
  }

  hostedOptions(): HostedOptionsResult {
    return this.hostedManager.options();
  }

  hostedInterrupt(sessionId: string): HostedInterruptResult {
    return this.hostedManager.interrupt(sessionId);
  }

  hostedCreate(params: HostedCreateParams): SessionGetResult {
    return { session: this.hostedManager.create(params) };
  }

  hostedStop(sessionId: string): Promise<HostedStopResult> {
    return this.hostedManager.stop(sessionId);
  }

  async hostedSetModel(sessionId: string, model: string | null): Promise<SessionGetResult> {
    return { session: await this.hostedManager.setModel(sessionId, model) };
  }

  async hostedSetSubagentModel(sessionId: string, model: string | null): Promise<SessionGetResult> {
    return { session: await this.hostedManager.setSubagentModel(sessionId, model) };
  }

  hostedResume(sessionId: string): HostedResumeResult {
    return { session: this.hostedManager.resume(sessionId) };
  }

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

  async projects(appId?: string): Promise<ProjectListResult> {
    const projects: ProjectInfo[] = [];
    for (const adapter of this.adapters) {
      if (appId && adapter.key !== appId) continue;
      projects.push(...(await adapter.projects()));
    }
    return { projects };
  }

  async sessions(params: SessionListParams): Promise<SessionListResult> {
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
      const sessions = (await adapter.sessions()).filter((session) => {
        if (params.projectId && session.projectId !== params.projectId) return false;
        if (!params.includeArchived && session.archived) return false;
        return true;
      });
      if (app.capabilities.enumerate !== "complete") {
        completeness = demote(completeness, app.capabilities.enumerate === "unknown" ? "unknown" : "partial");
      }
      collected.push(...sessions.map((session) => this.decorate(session, adapter.key)));
    }
    // 置顶的排最前，其余按更新时间；两组内部都是新的在前。
    collected.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
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

  async session(sessionId: string): Promise<SessionGetResult> {
    const adapter = this.adapterFor(sessionId);
    const session = await adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    return { session: this.decorate(session, adapter.key) };
  }

  /**
   * 改显示名。Bridge 托管的会话直接改托管记录；其它来源只保存 Bridge 侧覆盖，
   * 不动源应用里的标题，返回值同时带上原名。
   */
  async rename(sessionId: string, rawTitle: string | null): Promise<SessionGetResult> {
    const adapter = this.adapterFor(sessionId);
    const session = await adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    const title = (rawTitle ?? "").trim().slice(0, MAX_TITLE_CHARS);
    if (adapter.key === "hosted") {
      if (!title) throw new RpcError("invalid_params", "标题不能为空");
      return { session: this.hostedManager.rename(sessionId, title) };
    }
    if (!title) this.store.clearSessionTitle(adapter.key, sessionId);
    else this.store.setSessionTitle(adapter.key, sessionId, title);
    return { session: this.decorate(session, adapter.key) };
  }

  /** 置顶只是 Bridge 侧的书签：任何来源的会话都能置顶，不动源应用。 */
  async pin(sessionId: string, pinned: boolean): Promise<SessionGetResult> {
    const adapter = this.adapterFor(sessionId);
    const session = await adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    this.store.setSessionPin(adapter.key, sessionId, pinned);
    return { session: this.decorate(session, adapter.key) };
  }

  /** 归档：只有 Bridge 托管的会话归 Bridge 管，桌面会话请在原应用里归档。 */
  archive(sessionId: string, archived: boolean): SessionGetResult {
    const adapter = this.adapterFor(sessionId);
    if (adapter.key !== "hosted") {
      throw new RpcError("unsupported", "只有 Bridge 托管会话能在这里归档；桌面会话请在原应用里归档");
    }
    return { session: this.hostedManager.archive(sessionId, archived) };
  }

  /** 删除托管会话：停进程、删记录与 Bridge 这边的聊天记录，不动 CLI 自己的转录。 */
  async deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    const adapter = this.adapterFor(sessionId);
    if (adapter.key !== "hosted") {
      throw new RpcError("unsupported", "只有 Bridge 托管会话能在这里删除；桌面会话请在原应用里删除");
    }
    await this.hostedManager.remove(sessionId);
    this.store.setSessionPin(adapter.key, sessionId, false);
    return { deleted: true };
  }

  async messages(sessionId: string, params: { limit?: number; before?: string }): Promise<MessageListResult> {
    const adapter = this.adapterFor(sessionId);
    if (!(await adapter.session(sessionId))) throw new RpcError("not_found", "未知会话");
    const limit = clamp(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    return adapter.messages(sessionId, { limit, ...(params.before ? { before: params.before } : {}) });
  }

  async rail(sessionId: string): Promise<SessionRailResult> {
    const adapter = this.adapterFor(sessionId);
    if (!(await adapter.session(sessionId))) throw new RpcError("not_found", "未知会话");
    return adapter.rail(sessionId);
  }

  async models(sessionId: string): Promise<SessionModelsResult> {
    const adapter = this.adapterFor(sessionId);
    if (!(await adapter.session(sessionId))) throw new RpcError("not_found", "未知会话");
    if (!adapter.models) {
      return { models: [], canSwitch: false, note: "这个客户端没有模型信息" };
    }
    return adapter.models(sessionId);
  }

  async compact(sessionId: string): Promise<SessionCompactResult> {
    const adapter = this.adapterFor(sessionId);
    if (!(await adapter.session(sessionId))) throw new RpcError("not_found", "未知会话");
    if (!adapter.compact) {
      throw new RpcError("unsupported", "这个客户端不支持从 Bridge 压缩上下文");
    }
    return adapter.compact(sessionId);
  }

  async taskMessages(
    sessionId: string,
    taskId: string,
    params: { limit?: number; before?: string },
  ): Promise<MessageListResult> {
    const adapter = this.adapterFor(sessionId);
    if (!(await adapter.session(sessionId))) throw new RpcError("not_found", "未知会话");
    if (!adapter.taskMessages) throw new RpcError("unsupported", "该来源不提供子任务记录");
    const limit = clamp(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    return adapter.taskMessages(sessionId, taskId, {
      limit,
      ...(params.before ? { before: params.before } : {}),
    });
  }

  async send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult> {
    const adapter = this.adapterFor(sessionId);
    const session = await adapter.session(sessionId);
    if (!session) throw new RpcError("not_found", "未知会话");
    if (!session.canSend) {
      throw new RpcError("adapter_unavailable", session.sendBlockedReason ?? "该会话当前不可发送");
    }
    return adapter.send(sessionId, text, origin);
  }

  async prepareTransfer(
    deviceId: string,
    params: { sourceSessionId: string; messageId: string; targetSessionId: string },
  ): Promise<TransferPrepareResult> {
    this.pruneTransfers();
    const sourceAdapter = this.adapterFor(params.sourceSessionId);
    const source = await sourceAdapter.session(params.sourceSessionId);
    if (!source) throw new RpcError("not_found", "来源会话不存在");
    const targetAdapter = this.adapterFor(params.targetSessionId);
    const target = await targetAdapter.session(params.targetSessionId);
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

  async commitTransfer(
    deviceId: string,
    transferId: string,
    edited?: string,
  ): Promise<TransferCommitResult> {
    this.pruneTransfers();
    const prepared = this.transfers.get(transferId);
    if (!prepared) {
      throw new RpcError("invalid_params", "转发已过期或已提交，请重新预览后再发送");
    }
    if (prepared.deviceId !== deviceId) {
      throw new RpcError("invalid_params", "转发不属于当前设备，请重新预览");
    }
    // 预览里改过的正文以这次提交的内容为准，长度与空白的限制和 prepare 保持一致。
    const text = edited ?? prepared.text;
    if (!text.trim()) throw new RpcError("invalid_params", "消息不能为空");
    if (text.length > MAX_TRANSFER_CHARS) {
      throw new RpcError(
        "invalid_params",
        `消息过长（${text.length} 字符，上限 ${MAX_TRANSFER_CHARS}）`,
      );
    }
    // Consume before sending so a double click cannot submit twice.
    this.transfers.delete(transferId);
    const targetAdapter = this.adapterFor(prepared.targetSessionId);
    const target = await targetAdapter.session(prepared.targetSessionId);
    if (!target) throw new RpcError("not_found", "目标会话已不存在");
    if (!target.canSend) {
      throw new RpcError(
        "adapter_unavailable",
        target.sendBlockedReason ?? "目标会话当前不可发送",
      );
    }
    const sent = await this.send(prepared.targetSessionId, text);
    return {
      ...sent,
      transferId,
      targetSessionId: prepared.targetSessionId,
      textLength: text.length,
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

  /**
   * 叠上 Bridge 侧的覆盖名与置顶标记。
   * 两者都按 adapter key 存（写入时用的也是它），读也必须用同一把 key。
   */
  private decorate(session: SessionSummary, adapterKey: string): SessionSummary {
    const override = this.store.sessionTitle(adapterKey, session.sessionId);
    const pinned = this.store.sessionPinned(adapterKey, session.sessionId);
    const next = pinned ? { ...session, pinned: true } : session;
    if (override === null) return next;
    return { ...next, title: override, originalTitle: session.title };
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
