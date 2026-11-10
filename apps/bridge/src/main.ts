#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { toHex, type KeyPair, type Noise } from "@agent-bridge/crypto";
import { loadNoiseNode } from "@agent-bridge/crypto/node";
import { SessionAdapters } from "./adapters/index.js";
import { createRoom,
  RelayApi,
  RelayClient,
  RelayError,
  type RelayHandlers,
} from "./relay-client.js";
import { DeviceSession, PairingSession, type ChannelSession } from "./sessions.js";
import { defaultStateDir, Store } from "./store.js";
import { UploadStore } from "./uploads.js";

const VERSION = "0.1.0";
const DEVICE_TTL_OPTIONS: Record<string, number | null> = {
  manual: null,
  "1h": 3600,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

function usage(): void {
  console.log(`agent-bridge ${VERSION}

用法:
  agent-bridge init --relay <url> --admin-token <token> [--web <url>] [--name <name>]
  agent-bridge invite [--ttl 300]
  agent-bridge serve
  agent-bridge devices
  agent-bridge revoke <deviceId>
  agent-bridge status

状态目录: ${defaultStateDir()} (可用 AGENT_BRIDGE_HOME 覆盖)`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requireConfig(store: Store): {
  relayUrl: string;
  roomId: string;
  bridgeToken: string;
  webUrl: string;
  hostName: string;
  identity: KeyPair;
} {
  const relayUrl = store.meta("relay_url");
  const roomId = store.meta("room_id");
  const bridgeToken = store.meta("bridge_token");
  const privateKey = store.meta("identity_private");
  const publicKey = store.meta("identity_public");
  if (!relayUrl || !roomId || !bridgeToken || !privateKey || !publicKey) {
    throw new Error("尚未初始化，先运行 agent-bridge init");
  }
  return {
    relayUrl,
    roomId,
    bridgeToken,
    webUrl: store.meta("web_url") ?? relayUrl,
    hostName: store.hostName(),
    identity: {
      privateKey: Uint8Array.from(Buffer.from(privateKey, "base64")),
      publicKey: Uint8Array.from(Buffer.from(publicKey, "base64")),
    },
  };
}

function inviteUrl(webUrl: string, relayUrl: string, roomId: string, inviteToken: string): string {
  const params = new URLSearchParams({ relay: relayUrl, room: roomId, invite: inviteToken });
  return `${webUrl.replace(/\/+$/, "")}/#/pair?${params.toString()}`;
}

async function commandInit(args: string[]): Promise<void> {
  const relayArg = flag(args, "relay");
  const adminToken = flag(args, "admin-token") ?? process.env["AGENT_BRIDGE_ADMIN_TOKEN"];
  if (!relayArg || !adminToken) {
    throw new Error("init 需要 --relay 与 --admin-token（或 AGENT_BRIDGE_ADMIN_TOKEN）");
  }
  const relayUrl = normalizeUrl(relayArg);
  const webUrl = normalizeUrl(flag(args, "web") ?? relayUrl);
  const hostName = flag(args, "name") ?? hostname();
  const store = new Store();
  try {
    if (store.meta("bridge_token")) throw new Error("已经初始化过；如需换房间请先备份并删除状态目录");

    const health = await fetch(new URL("/v1/health", relayUrl));
    if (!health.ok) throw new Error(`中继不可用：HTTP ${health.status}`);

    const roomId = randomUUID();
    const room = await createRoom(relayUrl, adminToken, roomId);
    const noise = await loadNoiseNode();
    const identity = noise.generateKeyPair();

    store.setMeta("relay_url", relayUrl);
    store.setMeta("web_url", webUrl);
    store.setMeta("room_id", room.roomId);
    store.setMeta("bridge_token", room.bridgeToken);
    store.setMeta("host_name", hostName);
    store.setMeta("identity_private", Buffer.from(identity.privateKey).toString("base64"));
    store.setMeta("identity_public", Buffer.from(identity.publicKey).toString("base64"));
    store.setMeta("bridge_version", VERSION);

    console.log(`已初始化，房间 ${room.roomId}`);
    console.log(`公钥 ${toHex(identity.publicKey)}`);
    console.log("下一步：agent-bridge serve（保持常驻），再运行 agent-bridge invite 生成配对链接");
  } finally {
    store.close();
  }
}

async function commandInvite(args: string[]): Promise<void> {
  const ttl = Number(flag(args, "ttl") ?? "300");
  if (!Number.isFinite(ttl) || ttl < 30 || ttl > 600) throw new Error("--ttl 必须在 30..600 秒之间");
  const store = new Store();
  try {
    const config = requireConfig(store);
    const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
    const invite = await api.createInvite(ttl);
    store.saveInvite({
      id: invite.inviteId,
      token: invite.inviteToken,
      createdAt: Date.now(),
      expiresAt: invite.expiresAt,
      usedAt: null,
    });
    store.clearExpiredInvites();
    const url = inviteUrl(config.webUrl, config.relayUrl, config.roomId, invite.inviteToken);
    console.log(`邀请有效期至 ${new Date(invite.expiresAt).toLocaleTimeString()}（一次性）`);
    console.log(url);
    const status = await api.status().catch(() => null);
    if (status && !status.bridgeOnline) {
      console.log("注意：serve 当前未连接中继，浏览器将无法完成配对");
    }
  } finally {
    store.close();
  }
}

async function commandDevices(): Promise<void> {
  const store = new Store();
  try {
    const config = requireConfig(store);
    const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
    const remote = await api.devices();
    const local = new Map(store.devices().map((device) => [device.id, device]));
    for (const device of remote.devices) {
      const record = local.get(device.deviceId);
      const state = device.revokedAt
        ? "已撤销"
        : device.expiresAt && device.expiresAt < Date.now()
          ? "已过期"
          : "有效";
      const name = record?.name ?? device.name;
      console.log(`${device.deviceId}  ${name}  ${state}`);
    }
  } finally {
    store.close();
  }
}

async function commandRevoke(args: string[]): Promise<void> {
  const deviceId = args[0];
  if (!deviceId) throw new Error("用法：agent-bridge revoke <deviceId>");
  const store = new Store();
  try {
    const config = requireConfig(store);
    const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
    await api.revokeDevice(deviceId);
    store.revokeDevice(deviceId);
    console.log(`已撤销 ${deviceId}`);
  } finally {
    store.close();
  }
}

async function commandStatus(): Promise<void> {
  const store = new Store();
  try {
    const config = requireConfig(store);
    const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
    const status = await api.status();
    console.log(`房间 ${status.roomId}`);
    console.log(`中继连接 ${status.bridgeOnline ? "在线" : "离线"}`);
    console.log(`有效设备 ${status.deviceCount}`);
  } finally {
    store.close();
  }
}

function log(line: string): void {
  console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
}

async function commandServe(): Promise<void> {
  const store = new Store();
  const config = requireConfig(store);
  const noise: Noise = await loadNoiseNode();
  const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
  store.clearExpiredInvites();
  const adapters = new SessionAdapters();
  const uploads = new UploadStore(store.dir);

  let stopping = false;
  let relay: RelayClient | null = null;
  const sessions = new Map<string, ChannelSession>();

  const handlers: RelayHandlers = {
    onChannelOpen(message) {
      if (sessions.has(message.channel)) {
        sessions.get(message.channel)?.dispose();
        sessions.delete(message.channel);
      }
      const close = (): void => {
        sessions.delete(message.channel);
        relay?.closeChannel(message.channel, "session ended");
      };
      const send = (frame: Uint8Array): void => {
        relay?.send(message.channel, frame);
      };

      if (message.mode === "pair") {
        const invite = message.inviteId ? store.invite(message.inviteId) : null;
        if (!invite) {
          log(`配对失败：未知邀请 ${message.inviteId ?? "?"}`);
          relay?.closeChannel(message.channel, "unknown invite");
          return;
        }
        log(`收到配对连接，邀请 ${invite.id}`);
        sessions.set(
          message.channel,
          new PairingSession({
            noise,
            identity: config.identity,
            roomId: config.roomId,
            channel: message.channel,
            send,
            log,
            close,
            invite,
            api,
            store,
            hostName: config.hostName,
            deviceTtlSeconds: DEVICE_TTL_OPTIONS[store.meta("device_ttl") ?? "manual"] ?? null,
          }),
        );
        return;
      }

      const device = message.deviceId ? store.device(message.deviceId) : null;
      if (!device) {
        log(`设备连接失败：未知设备 ${message.deviceId ?? "?"}`);
        relay?.closeChannel(message.channel, "unknown device");
        return;
      }
      if (device.revokedAt !== null) {
        log(`设备连接失败：${device.id} 已撤销`);
        relay?.closeChannel(message.channel, "device revoked");
        return;
      }
      if (device.expiresAt !== null && device.expiresAt < Date.now()) {
        log(`设备连接失败：${device.id} 已过期`);
        relay?.closeChannel(message.channel, "device expired");
        return;
      }
      log(`设备「${device.name}」正在连接`);
      sessions.set(
        message.channel,
        new DeviceSession({
          noise,
          identity: config.identity,
          roomId: config.roomId,
          channel: message.channel,
          send,
          log,
          close,
          device,
          api,
          store,
          hostName: config.hostName,
          adapters,
          uploads,
        }),
      );
    },
    onChannelClose(channel) {
      sessions.get(channel)?.dispose();
      sessions.delete(channel);
    },
    onPeerState() {
      // room-level state; nothing to do while serving
    },
    onFrame(channel, frame) {
      sessions.get(channel)?.handleFrame(frame);
    },
  };

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    log("正在退出…");
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
    relay?.close(1000, "shutdown");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`Bridge ${VERSION} 启动，房间 ${config.roomId}`);
  for (const app of adapters.apps().apps) {
    if (app.capabilities.send || app.status === "unavailable") continue;
    log(`发送不可用（${app.name}）：${app.capabilities.sendDetail ?? app.capabilities.reason ?? "原因未知"}`);
  }
  let backoff = 1_000;
  while (!stopping) {
    relay = new RelayClient(config.relayUrl, config.roomId, config.bridgeToken, handlers);
    try {
      await relay.connect();
      backoff = 1_000;
      log("已连接中继，等待设备连接");
      const info = await relay.waitClosed();
      if (stopping) break;
      log(`中继连接断开（${info.code}${info.reason ? ` ${info.reason}` : ""}），重连中…`);
    } catch (error) {
      if (stopping) break;
      if (error instanceof RelayError) {
        log(`中继拒绝连接：${error.code} ${error.message}`);
        if (error.code === "invalid_credential" || error.code === "not_found") {
          log("桥接凭据失效，需要重新初始化");
          break;
        }
      } else {
        log(`连接失败：${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  store.close();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "init":
      await commandInit(args);
      return;
    case "invite":
      await commandInvite(args);
      return;
    case "serve":
      await commandServe();
      return;
    case "devices":
      await commandDevices();
      return;
    case "revoke":
      await commandRevoke(args);
      return;
    case "status":
      await commandStatus();
      return;
    case "--version":
    case "version":
      console.log(VERSION);
      return;
    default:
      usage();
      if (command) process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
