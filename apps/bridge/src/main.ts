#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { toHex, type KeyPair, type Noise } from "@craftstead/crypto";
import { loadNoiseNode } from "@craftstead/crypto/node";
import type { DevtoolsCapability, DevtoolsCapabilityName, DevtoolsStatus } from "@craftstead/protocol";
import { SessionAdapters } from "./adapters/index.js";
import {
  ADMIN_HOST,
  DEFAULT_ADMIN_PORT,
  ensureAdminToken,
  startAdminServer,
  type AdminActions,
  type AdminDevice,
} from "./admin.js";
import { Devtools, isDevtoolsCapability } from "./devtools.js";
import { SessionNotifier } from "./notify.js";
import { Pusher } from "./push.js";
import {
  RelayApi,
  RelayClient,
  RelayError,
  type RelayHandlers,
} from "./relay-client.js";
import { DeviceSession, PairingSession, type ChannelSession } from "./sessions.js";
import { defaultStateDir, Store } from "./store.js";
import { UploadStore } from "./uploads.js";

// 版本只有一个来源：工作区根的 package.json（dist/ 三层之上）。
// 打包进 app 时 build.sh 会写一份同布局的 bridge/package.json，两处都能解析到。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();
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
  agent-bridge init --relay <url> [--web <url>] [--name <name>]
  agent-bridge invite [--ttl 300]
  agent-bridge serve
  agent-bridge devices [ttl <manual|1h|24h|7d|30d>]   (默认 30d)
  agent-bridge revoke <deviceId>
  agent-bridge devtools [files|terminal] [on|off|status] [--ttl 3600]
  agent-bridge status
  agent-bridge info

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
  if (!relayArg) throw new Error("init 需要 --relay <url>");
  const relayUrl = normalizeUrl(relayArg);
  const webUrl = normalizeUrl(flag(args, "web") ?? relayUrl);
  const hostName = flag(args, "name") ?? hostname();
  const store = new Store();
  try {
    if (store.meta("bridge_token")) throw new Error("已经初始化过；如需换房间请先备份并删除状态目录");

    const health = await fetch(new URL("/v1/health", relayUrl));
    if (!health.ok) throw new Error(`中继不可用：HTTP ${health.status}`);

    // 房间号与凭据都在本机生成：中继只转发，首个用这份凭据连上来的 bridge 认领该房间。
    const roomId = randomUUID();
    const bridgeToken = randomBytes(32).toString("base64url");
    const noise = await loadNoiseNode();
    const identity = noise.generateKeyPair();

    store.setMeta("relay_url", relayUrl);
    store.setMeta("web_url", webUrl);
    store.setMeta("room_id", roomId);
    store.setMeta("bridge_token", bridgeToken);
    store.setMeta("host_name", hostName);
    store.setMeta("identity_private", Buffer.from(identity.privateKey).toString("base64"));
    store.setMeta("identity_public", Buffer.from(identity.publicKey).toString("base64"));
    store.setMeta("bridge_version", VERSION);

    console.log(`已初始化，房间 ${roomId}`);
    console.log(`公钥 ${toHex(identity.publicKey)}`);
    console.log("下一步：agent-bridge serve（保持常驻），再运行 agent-bridge invite 生成配对链接");
  } finally {
    store.close();
  }
}

/** The token is minted here and never sent to the relay: only its hash leaves this process. */
async function mintInvite(
  api: RelayApi,
  store: Store,
  config: { webUrl: string; relayUrl: string; roomId: string },
  ttlSeconds: number,
): Promise<{ url: string; expiresAt: number }> {
  const inviteToken = randomBytes(32).toString("base64url");
  const inviteId = randomUUID();
  const invite = await api.createInvite({
    inviteId,
    tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
    ttlSeconds,
  });
  store.saveInvite({
    id: inviteId,
    token: inviteToken,
    createdAt: Date.now(),
    expiresAt: invite.expiresAt,
    usedAt: null,
  });
  store.clearExpiredInvites();
  return {
    url: inviteUrl(config.webUrl, config.relayUrl, config.roomId, inviteToken),
    expiresAt: invite.expiresAt,
  };
}

async function commandInvite(args: string[]): Promise<void> {
  const ttl = Number(flag(args, "ttl") ?? "300");
  if (!Number.isFinite(ttl) || ttl < 30 || ttl > 600) throw new Error("--ttl 必须在 30..600 秒之间");
  const store = new Store();
  try {
    const config = requireConfig(store);
    const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
    const invite = await mintInvite(api, store, config, ttl);
    console.log(`邀请有效期至 ${new Date(invite.expiresAt).toLocaleTimeString()}（一次性）`);
    console.log(invite.url);
    const status = await api.status().catch(() => null);
    if (status && !status.bridgeOnline) {
      console.log("注意：serve 当前未连接中继，浏览器将无法完成配对");
    }
  } finally {
    store.close();
  }
}

async function commandDevices(args: string[]): Promise<void> {
  const store = new Store();
  try {
    if (args[0] === "ttl") {
      const option = args[1];
      if (!option || !Object.hasOwn(DEVICE_TTL_OPTIONS, option)) {
        throw new Error(
          `用法：agent-bridge devices ttl <${Object.keys(DEVICE_TTL_OPTIONS).join("|")}>`,
        );
      }
      // 配对时由 serve 现读这个值，写入后对下一次配对立即生效。
      store.setMeta("device_ttl", option);
      const ttl = DEVICE_TTL_OPTIONS[option] ?? null;
      console.log(
        ttl === null
          ? "已设置：之后配对的新设备不会过期（manual）"
          : `已设置：之后配对的新设备有效期 ${option}`,
      );
      return;
    }
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

/**
 * Asks the running bridge to flip one switch: it owns the running commands, so a
 * direct database write from this process would leave them executing.
 */
async function setDevtoolsOnBridge(
  store: Store,
  capability: DevtoolsCapabilityName,
  enabled: boolean,
  ttlSeconds: number | null,
): Promise<DevtoolsStatus | null> {
  let token: string;
  try {
    token = readFileSync(join(store.dir, "admin-token"), "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const configured = process.env["AGENT_BRIDGE_ADMIN_PORT"] ?? store.meta("admin_port");
  const port = Number(configured) || DEFAULT_ADMIN_PORT;
  try {
    const response = await fetch(`http://${ADMIN_HOST}:${port}/devtools`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ capability, enabled, ttlSeconds }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as DevtoolsStatus;
  } catch {
    return null;
  }
}

function printDevtools(status: DevtoolsStatus): void {
  const line = (label: string, capability: DevtoolsCapability): string =>
    `${label}：${capability.enabled ? "已开启" : "已关闭"}${
      capability.expiresAt ? `（${new Date(capability.expiresAt).toLocaleTimeString()} 失效）` : ""
    }`;
  console.log(line("文件浏览", status.files));
  console.log(line("命令执行", status.terminal));
}

/** Remote file browsing and command execution are off unless turned on here or in the menu bar. */
async function commandDevtools(args: string[]): Promise<void> {
  const store = new Store();
  try {
    let local: Devtools | null = null;
    const localDevtools = (): Devtools => {
      local ??= new Devtools(store, new SessionAdapters(), (line) => console.log(line));
      return local;
    };
    const first = args[0];
    if (first === undefined || first === "status") {
      printDevtools(localDevtools().status());
      return;
    }
    if (!isDevtoolsCapability(first)) {
      throw new Error("用法：agent-bridge devtools [files|terminal] [on|off|status] [--ttl 3600]");
    }
    const action = args[1] ?? "status";
    let next: DevtoolsStatus | null = null;
    if (action === "on") {
      const ttlRaw = flag(args, "ttl") ?? "3600";
      const ttl = Number(ttlRaw);
      if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) throw new Error("--ttl 必须在 60..86400 秒之间");
      next = await setDevtoolsOnBridge(store, first, true, ttl);
      if (!next) next = localDevtools().setEnabled(first, true, ttl);
    } else if (action === "off") {
      next = await setDevtoolsOnBridge(store, first, false, null);
      if (!next) {
        console.log("Bridge 未在运行：只更新本地状态，下次启动时生效");
        next = localDevtools().setEnabled(first, false);
      }
    } else if (action !== "status") {
      throw new Error("用法：agent-bridge devtools [files|terminal] [on|off|status] [--ttl 3600]");
    }
    printDevtools(next ?? localDevtools().status());
  } finally {
    store.close();
  }
}

/** Prints one JSON line describing the local state; never throws when uninitialized. */
async function commandInfo(): Promise<void> {
  const store = new Store();
  try {
    const relayUrl = store.meta("relay_url");
    const roomId = store.meta("room_id");
    console.log(
      JSON.stringify({
        initialized: Boolean(relayUrl && roomId && store.meta("bridge_token")),
        relayUrl,
        roomId,
        webUrl: store.meta("web_url") ?? relayUrl,
        hostName: store.hostName(),
        stateDir: store.dir,
        version: VERSION,
      }),
    );
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

/** 菜单栏里的一天以内只显示时分，跨天的补上日期。 */
function formatDeviceEvent(at: number, line: string): string {
  const date = new Date(at);
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour12: false });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? `[${time}] ${line}` : `[${date.getMonth() + 1}-${date.getDate()} ${time}] ${line}`;
}

async function commandServe(): Promise<void> {
  const store = new Store();
  const config = requireConfig(store);
  const noise: Noise = await loadNoiseNode();
  const api = new RelayApi(config.relayUrl, config.roomId, config.bridgeToken);
  store.clearExpiredInvites();
  const adapters = new SessionAdapters();
  const uploads = new UploadStore(store.dir);
  const devtools = new Devtools(store, adapters, log);
  const pusher = new Pusher(store, log);
  const notifier = new SessionNotifier(adapters, pusher, log);

  let stopping = false;
  let relay: RelayClient | null = null;
  /** Live channel → session, with the device it belongs to for the menu bar app. */
  const sessions = new Map<
    string,
    {
      channel: string;
      session: ChannelSession;
      kind: "pair" | "device";
      deviceId?: string;
      name?: string;
      /** Pairing only: the code the user compares on both screens. */
      code?: string;
      since: number;
    }
  >();
  let relayOnline = false;

  const dropDevice = (deviceId: string): number => {
    let closed = 0;
    for (const entry of [...sessions.values()]) {
      if (entry.deviceId !== deviceId) continue;
      entry.session.dispose();
      closed += 1;
    }
    return closed;
  };

  /** 菜单栏的每设备操作日志；存在本地库里，Bridge 重启后还在。 */
  const recordEvent = (deviceId: string, line: string): void => {
    try {
      store.recordDeviceEvent(deviceId, line);
    } catch (error) {
      // 写日志失败不能连累设备通道本身。
      log(`操作日志写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const adminActions: AdminActions = {
    async snapshot() {
      const devtoolsStatus = devtools.status();
      const local = new Map(store.devices().map((device) => [device.id, device]));
      const online = new Set(
        [...sessions.values()].flatMap((entry) => (entry.deviceId ? [entry.deviceId] : [])),
      );
      let devices: AdminDevice[] = [];
      let error: string | undefined;
      try {
        const remote = await api.devices();
        devices = remote.devices.map((device) => ({
          deviceId: device.deviceId,
          name: local.get(device.deviceId)?.name ?? device.name,
          createdAt: device.createdAt,
          expiresAt: device.expiresAt,
          revokedAt: device.revokedAt,
          lastSeenAt: device.lastSeenAt,
          online: online.has(device.deviceId),
          log: store
            .deviceEvents(device.deviceId)
            .map((event) => formatDeviceEvent(event.at, event.line)),
        }));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      return {
        version: VERSION,
        hostName: config.hostName,
        roomId: config.roomId,
        webUrl: config.webUrl,
        relayOnline,
        bridgePid: process.pid,
        devices,
        connections: [...sessions.values()].map((entry) => ({
          channel: entry.channel,
          kind: entry.kind,
          deviceId: entry.deviceId ?? null,
          name: entry.name ?? null,
          since: entry.since,
        })),
        devtools: devtoolsStatus,
        pairings: [...sessions.values()]
          .filter((entry) => entry.kind === "pair")
          .map((entry) => ({ channel: entry.channel, code: entry.code ?? null, since: entry.since })),
        ...(error ? { error } : {}),
      };
    },
    async disconnectDevice(deviceId: string) {
      const closed = dropDevice(deviceId);
      if (closed > 0) recordEvent(deviceId, "已从菜单断开连接");
      return { closed };
    },
    async revokeDevice(deviceId: string) {
      await api.revokeDevice(deviceId);
      store.revokeDevice(deviceId);
      recordEvent(deviceId, "证书已作废（从菜单）");
      return { closed: dropDevice(deviceId) };
    },
    async disconnectAll() {
      let closed = 0;
      for (const entry of [...sessions.values()]) {
        if (entry.deviceId) recordEvent(entry.deviceId, "已断开全部连接（从菜单）");
        entry.session.dispose();
        closed += 1;
      }
      return { closed };
    },
    async revokeAll() {
      const pending = store.devices().filter((device) => device.revokedAt === null);
      const failed: string[] = [];
      let revoked = 0;
      let closed = 0;
      for (const device of pending) {
        try {
          await api.revokeDevice(device.id);
          store.revokeDevice(device.id);
          recordEvent(device.id, "证书已作废（从菜单全部作废）");
          closed += dropDevice(device.id);
          revoked += 1;
        } catch (error) {
          failed.push(`${device.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { revoked, closed, failed };
    },
    async createInvite(ttlSeconds: number) {
      return mintInvite(api, store, config, ttlSeconds);
    },
    async setDevtools(capability: DevtoolsCapabilityName, enabled: boolean, ttlSeconds: number | null) {
      return devtools.setEnabled(capability, enabled, ttlSeconds);
    },
  };

  const handlers: RelayHandlers = {
    onChannelOpen(message) {
      if (sessions.has(message.channel)) {
        sessions.get(message.channel)?.session.dispose();
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
        if (invite.usedAt !== null || invite.expiresAt < Date.now()) {
          log(`配对失败：邀请 ${invite.id} 已使用或已过期`);
          relay?.closeChannel(message.channel, "invite expired");
          return;
        }
        log(`收到配对连接，邀请 ${invite.id}`);
        sessions.set(message.channel, {
          channel: message.channel,
          session: new PairingSession({
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
            // 默认 30 天：长期有效的设备凭据一旦丢失就再也不会自己失效，需要用户显式改回 manual。
            deviceTtlSeconds: DEVICE_TTL_OPTIONS[store.meta("device_ttl") ?? "30d"] ?? null,
            onConfirmCode: (code) => {
              const entry = sessions.get(message.channel);
              if (entry) entry.code = code;
            },
          }),
          kind: "pair",
          since: Date.now(),
        });
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
      sessions.set(message.channel, {
        channel: message.channel,
        session: new DeviceSession({
          noise,
          identity: config.identity,
          roomId: config.roomId,
          channel: message.channel,
          send,
          log: (line) => {
            log(line);
            recordEvent(device.id, line);
          },
          activity: (line) => recordEvent(device.id, line),
          close,
          device,
          api,
          store,
          hostName: config.hostName,
          adapters,
          uploads,
          devtools,
          pusher,
        }),
        kind: "device",
        deviceId: device.id,
        name: device.name,
        since: Date.now(),
      });
    },
    onChannelClose(channel) {
      const entry = sessions.get(channel);
      if (!entry) return;
      if (entry.deviceId) recordEvent(entry.deviceId, "连接断开");
      entry.session.dispose();
      sessions.delete(channel);
    },
    onPeerState() {
      // room-level state; nothing to do while serving
    },
    onFrame(channel, frame) {
      sessions.get(channel)?.session.handleFrame(frame);
    },
  };

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    log("正在退出…");
    notifier.stop();
    for (const entry of sessions.values()) entry.session.dispose();
    sessions.clear();
    relay?.close(1000, "shutdown");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`Bridge ${VERSION} 启动，房间 ${config.roomId}`);
  notifier.start();
  for (const app of adapters.apps().apps) {
    if (app.capabilities.send || app.status === "unavailable") continue;
    log(`发送不可用（${app.name}）：${app.capabilities.sendDetail ?? app.capabilities.reason ?? "原因未知"}`);
  }

  const configuredPort = process.env["AGENT_BRIDGE_ADMIN_PORT"] ?? store.meta("admin_port");
  const adminPort = configuredPort ? Number(configuredPort) : DEFAULT_ADMIN_PORT;
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535) {
    log(`本地管理接口端口无效：${configuredPort}，已跳过`);
  } else {
    try {
      const server = await startAdminServer({
        port: adminPort,
        token: ensureAdminToken(store.dir),
        actions: adminActions,
        log,
      });
      log(`本地管理接口 http://${ADMIN_HOST}:${adminPort}（令牌 ${join(store.dir, "admin-token")}）`);
      process.on("exit", () => server.close());
    } catch (error) {
      log(`本地管理接口启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let backoff = 1_000;
  while (!stopping) {
    relay = new RelayClient(config.relayUrl, config.roomId, config.bridgeToken, handlers);
    try {
      await relay.connect();
      relayOnline = true;
      backoff = 1_000;
      log("已连接中继，等待设备连接");
      const info = await relay.waitClosed();
      relayOnline = false;
      if (stopping) break;
      log(`中继连接断开（${info.code}${info.reason ? ` ${info.reason}` : ""}），重连中…`);
    } catch (error) {
      relayOnline = false;
      if (stopping) break;
      if (error instanceof RelayError) {
        log(`中继拒绝连接：${error.code} ${error.message}`);
        if (error.code === "invalid_credential" || error.code === "not_found") {
          log("房间已被其他凭据占用（或状态目录来自另一份部署），需要重新初始化");
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
      await commandDevices(args);
      return;
    case "revoke":
      await commandRevoke(args);
      return;
    case "devtools":
      await commandDevtools(args);
      return;
    case "status":
      await commandStatus();
      return;
    case "info":
      await commandInfo();
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
