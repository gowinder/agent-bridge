/**
 * 连接层：复用 spike 的 pairing/peer/relay 模块，不重写协议。
 * 职责：读本地设备身份 → ik 重连 → 请求/响应（带 operationId）→ 关闭。
 *
 * 安全：identity.json 里的私钥与 reconnectToken 只在内存里用，绝不进日志。
 * log.mjs 的 registerSecret 会登记这两个值，误打印也会被替换成 [redacted]。
 */

import { loadNoiseNode } from "@craftstead/crypto/node";
import { BridgeToolError, ToolError, UnpairedError } from "./errors.mjs";
import { registerSecret, debug } from "./log.mjs";
import { connectDevice } from "./pairing.mjs";
import { PeerError } from "./peer.mjs";
import { loadProfile } from "./profile.mjs";
import { readJson, statePaths } from "./state.mjs";

const REQUIRED_IDENTITY_FIELDS = [
  "deviceId",
  "publicKey",
  "privateKey",
  "bridgePublicKey",
  "reconnectToken",
  "roomId",
];

/** 读身份文件；缺失/不完整一律按「未配对」处理，绝不伪造身份。 */
export async function loadIdentity() {
  const { identity: identityPath } = statePaths();
  const raw = await readJson(identityPath);
  if (raw === null) throw new UnpairedError({ reason: "identity_missing" });
  const missing = REQUIRED_IDENTITY_FIELDS.filter((key) => typeof raw[key] !== "string" || !raw[key]);
  if (missing.length > 0) {
    throw new UnpairedError({ reason: "identity_incomplete", missingFields: missing });
  }
  registerSecret(raw.privateKey);
  registerSecret(raw.reconnectToken);
  return raw;
}

/** 给调用方看的设备概览：只给 public 部分。 */
export function describeIdentity(identity) {
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName ?? null,
    clientType: identity.clientType ?? null,
    relayUrl: identity.relayUrl ?? null,
    roomId: identity.roomId ?? null,
    bridgePublicKey: identity.bridgePublicKey,
    pairedAt: identity.pairedAt ?? null,
    expiresAt: identity.expiresAt ?? null,
    bridge: identity.bridge ?? null,
  };
}

export class BridgeLink {
  #opened = null;
  #closing = false;

  constructor({ profile } = {}) {
    this.profile = profile ?? null;
    this.identity = null;
    this.client = null;
    this.connection = null;
  }

  get isOpen() {
    return this.client !== null && !this.client.isDead;
  }

  /** 幂等打开：同一进程内多次工具调用共享一条通道；通道判死后下一次调用自动重连。 */
  async open() {
    if (this.isOpen) return this;
    if (this.client?.isDead) {
      this.client = null;
      this.connection = null;
    }
    if (this.#opened) {
      const previous = this.#opened;
      this.#opened = null;
      const link = await previous.catch(() => null);
      if (link?.isOpen) {
        this.#opened = previous;
        return link;
      }
    }
    const pending = this.#connect().catch((error) => {
      if (this.#opened === pending) this.#opened = null;
      throw error;
    });
    this.#opened = pending;
    return pending;
  }

  async #connect() {
    const identity = await loadIdentity();
    const profile = this.profile ?? (await loadProfile()).profile;
    this.identity = identity;
    const relayUrl = identity.relayUrl ?? profile.relayUrl;
    const device = {
      deviceId: identity.deviceId,
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      bridgePublicKey: identity.bridgePublicKey,
      reconnectToken: identity.reconnectToken,
      roomId: identity.roomId,
      relayUrl,
    };
    let noise;
    try {
      noise = await loadNoiseNode();
    } catch (error) {
      throw new ToolError("wasm_unavailable", `Noise wasm 加载失败：${error.message}`, {
        hint: "Noise wasm 由 @craftstead/crypto 提供（packages/crypto/wasm/noise.wasm，不在 git 里）：先跑 npm install，再跑 npm run build:wasm -w @craftstead/crypto（需要 rustup 与 wasm32-unknown-unknown），最后跑仓库根 npm run build。",
      });
    }
    try {
      const { client, connection } = await connectDevice(noise, device);
      this.client = client;
      this.connection = connection;
      debug("bridge 通道已建立");
      return this;
    } catch (error) {
      throw mapConnectError(error, identity, relayUrl);
    }
  }

  async call(method, params, { timeoutMs = 30_000, operationId } = {}) {
    if (!this.isOpen) await this.open();
    if (this.#closing) throw new ToolError("closed", "连接器正在关闭，请重试。");
    try {
      const response = await this.client.requestWith(method, params, { timeoutMs, operationId });
      if (!response.ok) {
        const code = response.error?.code ?? "internal";
        const message = response.error?.message ?? `${method} 失败`;
        throw new BridgeToolError(code, `${method} 被 bridge 拒绝：${message}`, {
          details: response.error?.data,
        });
      }
      return response.result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof PeerError) {
        throw new ToolError(error.code === "timeout" ? "bridge_timeout" : "bridge_closed", `${method} 失败：${error.message}`, {
          hint:
            error.code === "timeout"
              ? "bridge 在这段时间没有回应；先 session_read 看重连后是否有结果（变更类调用带 operationId，重试不会产生重复消息）。"
              : "通道已断开；重新调用即可自动重连（设备身份已持久化）。",
        });
      }
      throw new ToolError("bridge_error", `${method} 失败：${error.message}`);
    }
  }

  close() {
    this.#closing = true;
    try {
      this.client?.stop();
    } catch {
      // ignore
    }
    this.client = null;
    this.connection = null;
  }
}

function mapConnectError(error, identity, relayUrl) {
  const code = error?.code ?? "";
  if (code === "device_revoked") {
    return new ToolError("device_revoked", "本设备已被 revoke（在菜单栏 Agent Bridge 的设备列表里撤销）。", {
      hint: `需要重新配对：删除 ${statePaths().identity} 后重新生成邀请并跑 pair.mjs。`,
      details: { deviceId: identity.deviceId },
    });
  }
  if (code === "device_expired") {
    return new ToolError("device_expired", "本设备的重连令牌已过期，bridge 拒绝重连。", {
      hint: "需要重新配对（同上）。",
      details: { deviceId: identity.deviceId },
    });
  }
  if (code === "invalid_credential") {
    return new ToolError("invalid_credential", "bridge 不接受当前设备凭据（可能已在另一处被撤销或替换）。", {
      hint: "先确认设备列表里还有本设备（默认名 Muse (MCP)）；没有就重新配对。",
      details: { deviceId: identity.deviceId },
    });
  }
  if (code === "bridge_offline") {
    return new ToolError("bridge_offline", `中继连上了，但 Mac 侧 bridge 不在线（${relayUrl}）。`, {
      hint: "确认 Mac 菜单栏 Agent Bridge 在运行，且已连上中继。",
    });
  }
  if (code === "channel_in_use") {
    return new ToolError("channel_in_use", "中继报告该 channel 正被占用，稍后重试。", { hint: "重试一次即可；持续出现说明有另一个进程在用同一身份。" });
  }
  return new ToolError("connect_failed", `连接 bridge 失败：${error?.message ?? error}`, {
    hint: `检查网络、relay 地址（${statePaths().profile} 的 relayUrl）与 Mac 侧 bridge 是否在线。`,
    details: { deviceId: identity.deviceId, relayUrl },
  });
}
