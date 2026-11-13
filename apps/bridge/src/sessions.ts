import { randomUUID } from "node:crypto";
import {
  pairPrologue,
  reconnectPrologue,
  confirmCode,
  derivePairPsk,
  fromHex,
  toHex,
  NoiseHandshake,
  SecureChannel,
  type KeyPair,
  type Noise,
} from "@craftstead/crypto";
import type {
  DeviceSummary,
  ErrorCode,
  EventMessage,
  HostedPermissionMode,
  HostInfoResult,
  MessageAttachment,
  PairResult,
  PushInfoResult,
  PushSubscribeResult,
  RequestMessage,
  ResponseMessage,
  SessionListParams,
  ShellEventData,
  WireMessage,
} from "@craftstead/protocol";
import type { SessionAdapters } from "./adapters/index.js";
import { RpcError } from "./adapters/types.js";
import type { Devtools } from "./devtools.js";
import type { Pusher } from "./push.js";
import type { RelayApi } from "./relay-client.js";
import type { DeviceRecord, InviteRecord, Store } from "./store.js";
import type { UploadStore } from "./uploads.js";

export interface ChannelSession {
  handleFrame(frame: Uint8Array): void;
  dispose(): void;
}

interface SessionOptions {
  noise: Noise;
  identity: KeyPair;
  roomId: string;
  channel: string;
  send: (frame: Uint8Array) => void;
  log: (line: string) => void;
  /** 只有会改变状态或内容的请求才会走到这里，供菜单栏的「最近操作日志」记录。 */
  activity?: (line: string) => void;
  close: () => void;
}

export interface PairingOptions extends SessionOptions {
  invite: InviteRecord;
  api: RelayApi;
  store: Store;
  hostName: string;
  /** Bridge 自身版本，配对与 host.info 都会原样报给客户端。 */
  version: string;
  deviceTtlSeconds: number | null;
  /** The code the user must see on both screens; shown in the menu bar while pairing. */
  onConfirmCode?: (code: string) => void;
}

function errorResponse(id: string, code: ErrorCode, message: string): ResponseMessage {
  return {
    v: 1,
    kind: "response",
    id,
    ok: false,
    error: { code, message },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

function numberParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 读接口（session.list、message.list、fs.* 等）每隔几秒就被轮询一次，记进操作日志
 * 只会把真正做过的操作冲掉，所以只挑会改变状态或内容的请求。
 */
const ACTIVITY_METHODS = new Set([
  "message.send",
  "shell.exec",
  "shell.cancel",
  "file.upload.finish",
  "hosted.addDir",
  "hosted.removeDir",
  "hosted.create",
  "hosted.stop",
  "hosted.resume",
  "hosted.interrupt",
  "session.compact",
  "session.rename",
  "transfer.commit",
  "device.revoke",
  "device.rename",
]);

/** 把一次请求压缩成一行给人看的操作记录；不关心的请求返回 null。 */
function describeActivity(request: RequestMessage): string | null {
  if (!ACTIVITY_METHODS.has(request.method)) return null;
  const params = isObject(request.params) ? request.params : {};
  const sessionId = stringParam(params, "sessionId");
  const suffix = sessionId ? `（会话 ${sessionId.slice(0, 8)}）` : "";
  if (request.method === "message.send") {
    const text = (stringParam(params, "text") ?? "").replace(/\s+/g, " ").trim();
    if (!text) return `发送附件${suffix}`;
    return `发送消息「${text.length > 24 ? `${text.slice(0, 24)}…` : text}」${suffix}`;
  }
  if (request.method === "shell.exec") {
    const command = (stringParam(params, "command") ?? "").trim().split("\n")[0] ?? "";
    if (!command) return "执行命令";
    return `执行命令「${command.length > 40 ? `${command.slice(0, 40)}…` : command}」`;
  }
  if (request.method === "hosted.addDir" || request.method === "hosted.removeDir") {
    const path = (stringParam(params, "path") ?? "").trim();
    const verb = request.method === "hosted.addDir" ? "添加" : "移除";
    return path ? `${verb}托管目录「${path}」` : `${verb}托管目录`;
  }
  if (request.method === "session.rename") {
    const title = (stringParam(params, "title") ?? "").trim();
    return title ? `重命名会话为「${title.length > 24 ? `${title.slice(0, 24)}…` : title}」${suffix}` : `恢复会话原名${suffix}`;
  }
  return request.method;
}

function composeMessage(text: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((file) =>
    file.kind === "image" ? `![${file.name}](<${file.path}>)` : `[${file.name}](<${file.path}>)`,
  );
  return text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
}

export class PairingSession implements ChannelSession {
  private handshake: NoiseHandshake | null = null;
  private secure: SecureChannel | null = null;
  private expectedCode = "";
  private browserPublicKey: Uint8Array | null = null;
  private queue: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(private readonly options: PairingOptions) {}

  handleFrame(frame: Uint8Array): void {
    if (this.finished) return;
    this.queue = this.queue
      .then(() => this.process(frame))
      .catch((error: unknown) => {
        this.options.log(`配对失败：${error instanceof Error ? error.message : String(error)}`);
        this.dispose();
      });
  }

  private async process(frame: Uint8Array): Promise<void> {
    if (!this.handshake) {
      const psk = await derivePairPsk(this.options.invite.token, this.options.roomId);
      this.handshake = new NoiseHandshake(this.options.noise, {
        pattern: "xxpsk3",
        initiator: false,
        localKeys: this.options.identity,
        psk,
        prologue: pairPrologue(this.options.roomId, this.options.channel),
      });
    }

    if (!this.secure) {
      this.handshake.read(frame);
      if (!this.handshake.finished) {
        this.options.send(this.handshake.write());
        return;
      }
      const remote = this.handshake.remoteStatic;
      if (!remote) throw new Error("handshake exposed no browser key");
      this.browserPublicKey = remote;
      this.expectedCode = await confirmCode(remote, this.options.identity.publicKey);
      this.secure = this.handshake.intoChannel();
      this.options.onConfirmCode?.(this.expectedCode);
      this.options.log(`配对握手完成，确认码 ${this.expectedCode}`);
      return;
    }

    const message = this.secure.open(frame);
    if (!message || message.kind !== "request") return;
    await this.handleRequest(message);
  }

  private async handleRequest(request: RequestMessage): Promise<void> {
    if (request.method !== "pair.request") {
      this.respond(errorResponse(request.id, "unsupported", "only pair.request is accepted here"));
      return;
    }
    const params = isObject(request.params) ? request.params : {};
    const name = typeof params["deviceName"] === "string" ? params["deviceName"].trim() : "";
    const code = typeof params["confirmCode"] === "string" ? params["confirmCode"] : "";
    if (!name || name.length > 64) {
      this.respond(errorResponse(request.id, "invalid_params", "invalid device name"));
      return;
    }
    if (!constantTimeEqual(code, this.expectedCode)) {
      this.respond(errorResponse(request.id, "invalid_params", "确认码不一致，配对已拒绝"));
      this.dispose();
      return;
    }
    if (!this.browserPublicKey) throw new Error("missing browser key");

    const deviceId = randomUUID();
    const publicKey = toHex(this.browserPublicKey);
    const grant = await this.options.api.registerDevice({
      deviceId,
      name,
      publicKey,
      ttlSeconds: this.options.deviceTtlSeconds,
    });
    const device: DeviceRecord = {
      id: deviceId,
      name,
      publicKey,
      createdAt: Date.now(),
      expiresAt: grant.expiresAt,
      revokedAt: null,
      lastSeenAt: null,
    };
    this.options.store.saveDevice(device);
    this.options.store.markInviteUsed(this.options.invite.id);

    const result: PairResult = {
      deviceId,
      reconnectToken: grant.reconnectToken,
      expiresAt: grant.expiresAt,
      confirmCode: this.expectedCode,
      bridge: {
        name: this.options.hostName,
        version: this.options.version,
        platform: `${process.platform} ${process.arch}`,
      },
    };
    this.respond({ v: 1, kind: "response", id: request.id, ok: true, result });
    this.options.log(`已配对设备「${name}」，deviceId=${deviceId}`);
    this.finishSoon();
  }

  private respond(message: ResponseMessage): void {
    if (!this.secure) return;
    for (const frame of this.secure.seal(message)) this.options.send(frame);
  }

  private finishSoon(): void {
    this.finished = true;
    setTimeout(() => this.dispose(), 200);
  }

  dispose(): void {
    this.finished = true;
    this.secure?.close();
    this.secure = null;
    this.handshake?.dispose();
    this.handshake = null;
    this.options.close();
  }
}

export interface DeviceSessionOptions extends SessionOptions {
  device: DeviceRecord;
  api: RelayApi;
  store: Store;
  hostName: string;
  /** Bridge 自身版本，配对与 host.info 都会原样报给客户端。 */
  version: string;
  adapters: SessionAdapters;
  uploads: UploadStore;
  devtools: Devtools;
  pusher: Pusher;
}

export class DeviceSession implements ChannelSession {
  private handshake: NoiseHandshake | null = null;
  private secure: SecureChannel | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: DeviceSessionOptions) {}

  handleFrame(frame: Uint8Array): void {
    if (this.disposed) return;
    this.queue = this.queue
      .then(() => this.process(frame))
      .catch((error: unknown) => {
        this.options.log(`设备通道失败：${error instanceof Error ? error.message : String(error)}`);
        this.dispose();
      });
  }

  private async process(frame: Uint8Array): Promise<void> {
    if (this.disposed) return;
    if (!this.handshake) {
      this.handshake = new NoiseHandshake(this.options.noise, {
        pattern: "ik",
        initiator: false,
        localKeys: this.options.identity,
        remotePublicKey: fromHex(this.options.device.publicKey),
        prologue: reconnectPrologue(this.options.roomId, this.options.channel, this.options.device.id),
      });
    }
    if (!this.secure) {
      this.handshake.read(frame);
      this.options.send(this.handshake.write());
      if (!this.handshake.finished) throw new Error("IK handshake did not finish");
      const remote = this.handshake.remoteStatic;
      if (!remote || toHex(remote) !== this.options.device.publicKey) {
        throw new Error("device key mismatch");
      }
      this.secure = this.handshake.intoChannel();
      this.options.log(`设备「${this.options.device.name}」已连接`);
      return;
    }
    const message = this.secure.open(frame);
    if (!message || message.kind !== "request") return;
    await this.handleRequest(message);
  }

  private async handleRequest(request: RequestMessage): Promise<void> {
    let response: ResponseMessage;
    const activity = describeActivity(request);
    if (activity) this.options.activity?.(activity);
    try {
      response = { v: 1, kind: "response", id: request.id, ok: true, result: await this.dispatch(request) };
    } catch (error) {
      const message = error instanceof RpcError
        ? error.message
        : error instanceof Error
          ? error.message
          : "internal error";
      if (activity) this.options.activity?.(`${request.method} 失败：${message}`);
      if (error instanceof RpcError) {
        response = errorResponse(request.id, error.code, error.message);
      } else {
        response = errorResponse(request.id, "internal", message);
      }
    }
    this.respond(response);
  }

  private async dispatch(request: RequestMessage): Promise<unknown> {
    const params = isObject(request.params) ? request.params : {};
    switch (request.method) {
      case "host.info": {
        const info: HostInfoResult = {
          name: this.options.hostName,
          version: this.options.version,
          platform: `${process.platform} ${process.arch}`,
          adapters: this.options.adapters.hostAdapters(),
          devtools: this.options.devtools.status(),
        };
        return info;
      }
      case "host.capabilities":
        return this.options.adapters.apps();
      case "app.list":
        return this.options.adapters.apps();
      case "project.list": {
        const appId = stringParam(params, "appId");
        return this.options.adapters.projects(appId);
      }
      case "session.list": {
        const query: SessionListParams = {};
        const appId = stringParam(params, "appId");
        const projectId = stringParam(params, "projectId");
        const limit = numberParam(params, "limit");
        if (appId) query.appId = appId;
        if (projectId) query.projectId = projectId;
        if (limit !== undefined) query.limit = limit;
        if (params["includeArchived"] === true) query.includeArchived = true;
        return this.options.adapters.sessions(query);
      }
      case "session.get": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.session(sessionId);
      }
      case "message.list": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        const query: { limit?: number; before?: string } = {};
        const limit = numberParam(params, "limit");
        const before = stringParam(params, "before");
        if (limit !== undefined) query.limit = limit;
        if (before) query.before = before;
        return this.options.adapters.messages(sessionId, query);
      }
      case "session.rail": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.rail(sessionId);
      }
      case "session.models": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.models(sessionId);
      }
      case "session.compact": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.compact(sessionId);
      }
      case "session.rename": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        const raw = params["title"];
        if (raw !== null && typeof raw !== "string") {
          throw new RpcError("invalid_params", "title must be string or null");
        }
        return this.options.adapters.rename(sessionId, raw);
      }
      case "hosted.dirs":
        return this.options.adapters.hostedDirs();
      case "hosted.addDir":
        return this.options.adapters.hostedAddDir(stringParam(params, "path") ?? "");
      case "hosted.removeDir":
        return this.options.adapters.hostedRemoveDir(stringParam(params, "path") ?? "");
      case "hosted.create": {
        const path = stringParam(params, "path");
        if (!path) throw new RpcError("invalid_params", "path required");
        const permissionMode = stringParam(params, "permissionMode");
        // 只接受白名单里的模式；bypassPermissions 还取决于 hosted.json 的 allowBypassPermissions。
        if (permissionMode && !this.options.adapters.hostedModes().includes(permissionMode as HostedPermissionMode)) {
          throw new RpcError(
            "invalid_params",
            permissionMode === "bypassPermissions"
              ? "Bridge 未允许托管会话使用 bypassPermissions（hosted.json 的 allowBypassPermissions）"
              : `托管会话不接受该权限模式：${permissionMode}`,
          );
        }
        const title = stringParam(params, "title");
        const model = stringParam(params, "model");
        const effort = stringParam(params, "effort");
        return this.options.adapters.hostedCreate({
          path,
          ...(permissionMode ? { permissionMode: permissionMode as HostedPermissionMode } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(title ? { title } : {}),
        });
      }
      case "hosted.options":
        return this.options.adapters.hostedOptions();
      case "hosted.interrupt": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.hostedInterrupt(sessionId);
      }
      case "hosted.stop": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.hostedStop(sessionId);
      }
      case "hosted.resume": {
        const sessionId = stringParam(params, "sessionId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        return this.options.adapters.hostedResume(sessionId);
      }
      case "push.info": {
        const info: PushInfoResult = {
          publicKey: this.options.pusher.publicKey(),
          subscriptions: this.options.pusher.count(this.options.device.id),
        };
        return info;
      }
      case "push.subscribe": {
        const endpoint = stringParam(params, "endpoint") ?? "";
        const keys = params["keys"];
        const p256dh = isObject(keys) ? stringParam(keys, "p256dh") : undefined;
        const auth = isObject(keys) ? stringParam(keys, "auth") : undefined;
        if (!p256dh || !auth) throw new RpcError("invalid_params", "订阅缺少密钥");
        if (!/^https:\/\//i.test(endpoint)) throw new RpcError("invalid_params", "订阅地址必须是 https");
        const result: PushSubscribeResult = {
          subscriptions: this.options.pusher.subscribe(this.options.device.id, {
            endpoint,
            keys: { p256dh, auth },
          }),
        };
        return result;
      }
      case "push.unsubscribe": {
        const endpoint = stringParam(params, "endpoint");
        if (!endpoint) throw new RpcError("invalid_params", "endpoint required");
        const result: PushSubscribeResult = {
          subscriptions: this.options.pusher.unsubscribe(this.options.device.id, endpoint),
        };
        return result;
      }
      case "task.messages": {
        const sessionId = stringParam(params, "sessionId");
        const taskId = stringParam(params, "taskId");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        if (!taskId) throw new RpcError("invalid_params", "taskId required");
        const query: { limit?: number; before?: string } = {};
        const limit = numberParam(params, "limit");
        const before = stringParam(params, "before");
        if (limit !== undefined) query.limit = limit;
        if (before) query.before = before;
        return this.options.adapters.taskMessages(sessionId, taskId, query);
      }
      case "message.send": {
        const sessionId = stringParam(params, "sessionId");
        const text = stringParam(params, "text") ?? "";
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        const attachments = this.attachmentParams(params["attachments"]);
        if (!text.trim() && attachments.length === 0) throw new RpcError("invalid_params", "消息不能为空");
        const composed = composeMessage(text.trim(), attachments);
        if (composed.length > 32_000) throw new RpcError("invalid_params", "消息过长");
        return this.options.adapters.send(sessionId, composed, this.options.device.name);
      }
      case "file.upload.begin": {
        const sessionId = stringParam(params, "sessionId");
        const name = stringParam(params, "name");
        const size = numberParam(params, "size");
        if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
        if (!name) throw new RpcError("invalid_params", "name required");
        if (size === undefined) throw new RpcError("invalid_params", "size required");
        // 会话不存在时这里会抛出 not_found；必须 await，否则 reject 无人接管会让进程退出。
        await this.options.adapters.session(sessionId);
        return this.options.uploads.begin(
          this.options.channel,
          sessionId,
          name,
          stringParam(params, "mime") ?? "",
          size,
        );
      }
      case "file.upload.chunk": {
        const uploadId = stringParam(params, "uploadId");
        const index = numberParam(params, "index");
        const data = stringParam(params, "data");
        if (!uploadId) throw new RpcError("invalid_params", "uploadId required");
        if (index === undefined) throw new RpcError("invalid_params", "index required");
        if (data === undefined) throw new RpcError("invalid_params", "data required");
        return this.options.uploads.chunk(this.options.channel, uploadId, index, data);
      }
      case "file.upload.finish": {
        const uploadId = stringParam(params, "uploadId");
        if (!uploadId) throw new RpcError("invalid_params", "uploadId required");
        return this.options.uploads.finish(this.options.channel, uploadId);
      }
      case "transfer.prepare": {
        const sourceSessionId = stringParam(params, "sourceSessionId");
        const messageId = stringParam(params, "messageId");
        const targetSessionId = stringParam(params, "targetSessionId");
        if (!sourceSessionId) throw new RpcError("invalid_params", "sourceSessionId required");
        if (!messageId) throw new RpcError("invalid_params", "messageId required");
        if (!targetSessionId) throw new RpcError("invalid_params", "targetSessionId required");
        return this.options.adapters.prepareTransfer(this.options.device.id, {
          sourceSessionId,
          messageId,
          targetSessionId,
        });
      }
      case "transfer.commit": {
        const transferId = stringParam(params, "transferId");
        if (!transferId) throw new RpcError("invalid_params", "transferId required");
        return this.options.adapters.commitTransfer(
          this.options.device.id,
          transferId,
          stringParam(params, "text"),
        );
      }
      case "device.list": {
        const devices: DeviceSummary[] = this.options.store.devices().map((device) => ({
          deviceId: device.id,
          name: device.name,
          createdAt: device.createdAt,
          expiresAt: device.expiresAt,
          revokedAt: device.revokedAt,
          lastSeenAt: device.lastSeenAt,
        }));
        return { devices };
      }
      case "device.revoke": {
        const deviceId = params["deviceId"];
        if (typeof deviceId !== "string") throw new Error("deviceId required");
        // A paired device may only revoke itself; other devices are managed from the Mac.
        if (deviceId !== this.options.device.id) {
          throw new RpcError("unauthorized", "只能撤销当前设备，请在 Mac 上撤销其他设备");
        }
        const target = this.options.store.device(deviceId);
        if (!target) throw new Error("unknown device");
        await this.options.api.revokeDevice(deviceId);
        this.options.store.revokeDevice(deviceId);
        return { ok: true };
      }
      case "device.rename": {
        const deviceId = params["deviceId"];
        if (typeof deviceId !== "string") throw new RpcError("invalid_params", "deviceId required");
        // 同撤销一样只允许改自己，其他设备的名称由 Mac 上的持有者管理。
        if (deviceId !== this.options.device.id) {
          throw new RpcError("unauthorized", "只能重命名当前设备");
        }
        const name = stringParam(params, "name")?.trim();
        if (!name || name.length > 64) throw new RpcError("invalid_params", "invalid device name");
        const target = this.options.store.device(deviceId);
        if (!target) throw new Error("unknown device");
        this.options.store.saveDevice({ ...target, name });
        // 通道打开时读的那份记录也要跟着改，否则后续 message.send 仍用旧名字。
        this.options.device.name = name;
        return { ok: true, name };
      }
      case "fs.roots": {
        const root = stringParam(params, "root");
        if (!root) throw new RpcError("invalid_params", "root required");
        return this.options.devtools.roots(stringParam(params, "sessionId"), root);
      }
      case "fs.list": {
        const root = stringParam(params, "root");
        if (!root) throw new RpcError("invalid_params", "root required");
        return this.options.devtools.listDirs(
          stringParam(params, "sessionId"),
          root,
          stringParam(params, "path"),
        );
      }
      case "fs.read": {
        const root = stringParam(params, "root");
        if (!root) throw new RpcError("invalid_params", "root required");
        const path = stringParam(params, "path");
        if (!path) throw new RpcError("invalid_params", "path required");
        return this.options.devtools.readFile(stringParam(params, "sessionId"), root, path);
      }
      case "shell.exec": {
        const root = stringParam(params, "root");
        if (!root) throw new RpcError("invalid_params", "root required");
        const command = stringParam(params, "command") ?? "";
        return this.options.devtools.exec(
          this.options.channel,
          stringParam(params, "sessionId"),
          root,
          command,
          stringParam(params, "cwd"),
          numberParam(params, "timeoutMs"),
          (data: ShellEventData) => this.emit("shell.output", data),
        );
      }
      case "shell.cancel": {
        const execId = stringParam(params, "execId");
        if (!execId) throw new RpcError("invalid_params", "execId required");
        return this.options.devtools.cancel(this.options.channel, execId);
      }
      default:
        throw new Error(`unsupported method: ${request.method}`);
    }
  }

  private attachmentParams(value: unknown): MessageAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new RpcError("invalid_params", "attachments invalid");
    if (value.length > 10) throw new RpcError("invalid_params", "附件最多 10 个");
    return value.map((item): MessageAttachment => {
      if (!isObject(item) || Array.isArray(item)) throw new RpcError("invalid_params", "附件字段无效");
      const path = stringParam(item, "path");
      if (!path) throw new RpcError("invalid_params", "附件路径缺失");
      const resolved = this.options.uploads.resolvePath(path);
      const name = stringParam(item, "name") || "file";
      const mime = stringParam(item, "mime") ?? "";
      return {
        name,
        mime,
        size: numberParam(item, "size") ?? 0,
        path: resolved,
        kind: mime.startsWith("image/") ? "image" : "file",
      };
    });
  }

  private respond(message: WireMessage): void {
    if (!this.secure || this.disposed) return;
    for (const frame of this.secure.seal(message)) this.options.send(frame);
  }

  private emit(event: EventMessage["event"], data: unknown): void {
    if (!this.secure || this.disposed) return;
    const message: EventMessage = { v: 1, kind: "event", event, data };
    for (const frame of this.secure.seal(message)) this.options.send(frame);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.devtools.disposeOwner(this.options.channel);
    this.secure?.close();
    this.secure = null;
    this.handshake?.dispose();
    this.handshake = null;
    this.options.close();
  }
}
