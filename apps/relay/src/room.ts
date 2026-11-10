import {
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROTOCOL_VERSION,
  parseBridgeControl,
  parseRelayHello,
  type DeviceSummary,
  type RelayErrorCode,
  type RelayHello,
  type RelayServerMessage,
} from "@agent-bridge/protocol";
import type { Env } from "./env.js";

interface Attachment {
  role: "bridge" | "browser";
  channel?: string;
  mode?: "pair" | "device";
  deviceId?: string;
  authedAt: number;
  pending?: boolean;
  deadline?: number;
}

const encoder = new TextEncoder();
const INVITE_TTL_SECONDS = 300;
const MAX_INVITE_TTL_SECONDS = 600;
const MAX_DEVICE_TTL_SECONDS = 30 * 24 * 3600;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const HELLO_TIMEOUT_MS = 5_000;
/** 认领房间所需的 bridge 凭据最小长度，避免用可猜的短串占号。 */
const MIN_BRIDGE_TOKEN_CHARS = 16;
/** 无人认领或长期没有 bridge 连入的房间，保留这么久后清空存储。 */
const IDLE_ROOM_MS = 30 * 24 * 3600 * 1000;
/** last_seen 的落盘节流：每个房间最多每分钟写一次。 */
const TOUCH_INTERVAL_MS = 60_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function token(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export class Room {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  private schemaReady = false;
  private lastTouchAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG),
    );
    // 架构表不能放在构造函数里：任何人拿一个房间号连上来都会实例化这个 DO，
    // 那样等于让陌生人给存储计费。等到房间真的被认领、要写邀请/设备时再建表。
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS invites (
         id TEXT PRIMARY KEY,
         hash TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         used_at INTEGER
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         public_key TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER,
         revoked_at INTEGER,
         last_seen_at INTEGER
       )`,
    );
    this.schemaReady = true;
  }

  private async meta(key: string): Promise<string | null> {
    const value = await this.ctx.storage.get<string>(key);
    if (value) return value;
    // 旧版本把认领信息存在 SQL 的 meta 表里；读不到 KV 时回退到旧表，避免升级后房间被当成未认领。
    try {
      const row = this.ctx.storage.sql
        .exec("SELECT value FROM meta WHERE key = ?", key)
        .toArray()[0];
      return row ? String(row["value"]) : null;
    } catch {
      return null;
    }
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /** 记录房间还在被使用，并把空闲回收的闹钟推到最近。 */
  private async touch(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTouchAt < TOUCH_INTERVAL_MS) return;
    this.lastTouchAt = now;
    await this.ctx.storage.put("last_seen", now);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < now + IDLE_ROOM_MS - TOUCH_INTERVAL_MS) {
      await this.ctx.storage.setAlarm(now + IDLE_ROOM_MS);
    }
  }

  /**
   * 一个闹钟做两件事：给未完成握手的 socket 兜底超时，以及回收空闲房间。
   * 取两者中更早的时间重新上表。
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as (Attachment & { deadline?: number }) | null;
      if (!attachment?.pending) continue;
      const deadline = attachment.deadline ?? 0;
      if (deadline <= now) {
        this.fail(ws, "invalid_credential", "hello timeout");
        continue;
      }
      next = next === null ? deadline : Math.min(next, deadline);
    }
    const lastSeen = (await this.ctx.storage.get<number>("last_seen")) ?? 0;
    if (this.ctx.getWebSockets().length > 0 || now - lastSeen < IDLE_ROOM_MS) {
      const idleAt = Math.max(lastSeen, now) + IDLE_ROOM_MS;
      next = next === null ? idleAt : Math.min(next, idleAt);
    } else {
      // 没有连接也没有 bridge 用这份凭据登录过：整间清空，房间号回到可认领状态。
      await this.ctx.storage.deleteAll();
      this.schemaReady = false;
      this.lastTouchAt = 0;
      return;
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") {
      return this.handleWebSocket(request);
    }

    if (!(await this.authorizeBridge(request))) {
      return errorResponse("unauthorized", "bad bridge credential", 401);
    }
    this.ensureSchema();
    void this.touch();

    if (path === "/invites" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        inviteId?: string;
        tokenHash?: string;
        ttlSeconds?: number;
      };
      // The bridge mints the token and sends only its hash: the relay must never
      // learn the raw token, because it is the pairing PSK input.
      if (!body.inviteId || !/^[a-z0-9-]{8,64}$/.test(body.inviteId)) {
        return errorResponse("bad_request", "bad inviteId", 400);
      }
      if (!body.tokenHash || !/^[0-9a-f]{64}$/.test(body.tokenHash)) {
        return errorResponse("bad_request", "bad tokenHash", 400);
      }
      const ttl = Math.min(
        Math.max(Math.trunc(body.ttlSeconds ?? INVITE_TTL_SECONDS), 30),
        MAX_INVITE_TTL_SECONDS,
      );
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "INSERT INTO invites (id, hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
        body.inviteId,
        body.tokenHash,
        now,
        now + ttl * 1000,
      );
      return json({ inviteId: body.inviteId, expiresAt: now + ttl * 1000 });
    }

    if (path === "/devices" && request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT id, name, created_at, expires_at, revoked_at, last_seen_at FROM devices ORDER BY created_at DESC",
        )
        .toArray();
      const devices: DeviceSummary[] = rows.map((row) => ({
        deviceId: String(row["id"]),
        name: String(row["name"]),
        createdAt: Number(row["created_at"]),
        expiresAt: row["expires_at"] === null ? null : Number(row["expires_at"]),
        revokedAt: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
        lastSeenAt: row["last_seen_at"] === null ? null : Number(row["last_seen_at"]),
      }));
      return json({ devices });
    }

    if (path === "/devices" && request.method === "POST") {
      const body = (await request.json()) as {
        deviceId?: string;
        name?: string;
        publicKey?: string;
        ttlSeconds?: number | null;
      };
      if (!body.deviceId || !body.name || !body.publicKey) {
        return errorResponse("bad_request", "missing fields", 400);
      }
      if (!/^[a-z0-9-]{8,64}$/.test(body.deviceId)) {
        return errorResponse("bad_request", "bad deviceId", 400);
      }
      let expiresAt: number | null = null;
      if (body.ttlSeconds != null) {
        const ttl = Math.min(Math.max(Math.trunc(body.ttlSeconds), 60), MAX_DEVICE_TTL_SECONDS);
        expiresAt = Date.now() + ttl * 1000;
      }
      const reconnectToken = token();
      this.ctx.storage.sql.exec(
        `INSERT INTO devices (id, name, public_key, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           public_key = excluded.public_key,
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at,
           revoked_at = NULL`,
        body.deviceId,
        body.name,
        body.publicKey,
        await sha256Hex(reconnectToken),
        Date.now(),
        expiresAt,
      );
      return json({ deviceId: body.deviceId, reconnectToken, expiresAt });
    }

    const deviceMatch = /^\/devices\/([a-z0-9-]{8,64})$/.exec(path);
    if (deviceMatch && request.method === "DELETE") {
      const deviceId = deviceMatch[1]!;
      const existing = this.ctx.storage.sql
        .exec("SELECT id FROM devices WHERE id = ?", deviceId)
        .toArray()[0];
      if (!existing) return errorResponse("not_found", "no such device", 404);
      this.ctx.storage.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), deviceId);
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Attachment | null;
        if (attachment?.role === "browser" && attachment.deviceId === deviceId) {
          ws.close(4003, "device revoked");
        }
      }
      return json({ ok: true });
    }

    if (path === "/status" && request.method === "GET") {
      const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").toArray()[0];
      return json({
        roomId: (await this.meta("room_id")) ?? "",
        bridgeOnline: this.bridgeSocket() !== null,
        deviceCount: Number(row?.["n"] ?? 0),
      });
    }

    return errorResponse("not_found", "unknown route", 404);
  }

  private async authorizeBridge(request: Request): Promise<boolean> {
    const presented = bearer(request);
    const stored = await this.meta("bridge_hash");
    if (!presented || !stored) return false;
    return constantTimeEqual(await sha256Hex(presented), stored);
  }

  private bridgeSocket(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.role === "bridge") return ws;
    }
    return null;
  }

  private browserSocket(channel: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.role === "browser" && attachment.channel === channel) return ws;
    }
    return null;
  }

  private handleWebSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse("bad_request", "expected websocket upgrade", 426);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const deadline = Date.now() + HELLO_TIMEOUT_MS;
    server.serializeAttachment({ pending: true, deadline } as Attachment);
    void this.scheduleHelloSweep(deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Wakes the room so unauthenticated sockets cannot hang forever. */
  private async scheduleHelloSweep(deadline: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || deadline < existing) await this.ctx.storage.setAlarm(deadline);
  }

  private sendControl(ws: WebSocket, message: RelayServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket already gone
    }
  }

  private fail(ws: WebSocket, code: RelayErrorCode, message: string): void {
    this.sendControl(ws, { v: RELAY_PROTOCOL_VERSION, type: "error", code, message });
    try {
      ws.close(1008, code);
    } catch {
      // already closed
    }
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const raw = ws.deserializeAttachment() as (Attachment & { pending?: boolean; deadline?: number }) | null;
    if (!raw || raw.pending) {
      if (typeof data !== "string") {
        this.fail(ws, "bad_request", "expected hello");
        return;
      }
      if (raw?.deadline && Date.now() > raw.deadline) {
        this.fail(ws, "invalid_credential", "hello timeout");
        return;
      }
      if (data.length > MAX_CONTROL_BYTES) {
        this.fail(ws, "bad_request", "hello too large");
        return;
      }
      const hello = parseRelayHello(this.safeJson(data));
      if (!hello) {
        this.fail(ws, "bad_request", "invalid hello");
        return;
      }
      void this.authenticate(ws, hello);
      return;
    }
    if (typeof data === "string") {
      if (data.length > MAX_CONTROL_BYTES) return;
      if (raw.role === "bridge") this.handleBridgeControl(data);
      return;
    }
    this.route(ws, raw, data);
  }

  private handleBridgeControl(text: string): void {
    const control = parseBridgeControl(this.safeJson(text));
    if (!control) return;
    const target = this.browserSocket(control.channel);
    if (!target) return;
    try {
      target.close(4003, control.reason ?? "closed by bridge");
    } catch {
      // already closed
    }
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private async authenticate(ws: WebSocket, hello: RelayHello): Promise<void> {
    const roomId = await this.meta("room_id");
    // 房间在首个 bridge 连接时认领；未被认领的房间不接受浏览器连接。
    if (roomId ? hello.room !== roomId : hello.role !== "bridge") {
      this.fail(ws, "not_found", "unknown room");
      return;
    }

    if (hello.role === "bridge") {
      if (hello.credential.kind !== "bridge") {
        this.fail(ws, "invalid_credential", "bridge credential required");
        return;
      }
      if (hello.credential.token.length < MIN_BRIDGE_TOKEN_CHARS) {
        this.fail(ws, "invalid_credential", "bridge token too short");
        return;
      }
      const presented = await sha256Hex(hello.credential.token);
      const stored = await this.meta("bridge_hash");
      if (!stored) {
        this.ensureSchema();
        await this.setMeta("room_id", hello.room);
        await this.setMeta("bridge_hash", presented);
        await this.setMeta("created_at", String(Date.now()));
        this.lastTouchAt = 0;
        await this.touch();
      } else if (!constantTimeEqual(presented, stored)) {
        this.fail(ws, "invalid_credential", "bad bridge token");
        return;
      } else {
        // 已认领房间的桥重连同样算活跃：否则 29 天重连一次、又在下个 30 天前断开，
        // 房间会因为从未刷新 last_seen 被空闲回收连凭据一起清掉。
        await this.touch();
      }
      for (const other of this.ctx.getWebSockets()) {
        const attachment = other.deserializeAttachment() as Attachment | null;
        if (other !== ws && attachment?.role === "bridge") other.close(4001, "replaced");
      }
      ws.serializeAttachment({ role: "bridge", authedAt: Date.now() } satisfies Attachment);
      this.sendControl(ws, {
        v: RELAY_PROTOCOL_VERSION,
        type: "ready",
        role: "bridge",
        bridgeOnline: true,
      });
      this.broadcastPeerState(true);
      return;
    }

    if (hello.role !== "browser" || !hello.channel) {
      this.fail(ws, "bad_request", "browser channel required");
      return;
    }
    if (this.browserSocket(hello.channel)) {
      this.fail(ws, "channel_in_use", "channel already connected");
      return;
    }

    this.ensureSchema();
    let mode: "pair" | "device";
    let deviceId: string | undefined;
    let inviteId: string | undefined;

    if (hello.credential.kind === "invite") {
      const row = this.ctx.storage.sql
        .exec("SELECT id, expires_at, used_at FROM invites WHERE hash = ?", hello.credential.tokenHash)
        .toArray()[0];
      if (!row) {
        this.fail(ws, "invalid_credential", "unknown invite");
        return;
      }
      if (row["used_at"] !== null) {
        this.fail(ws, "invite_used", "invite already used");
        return;
      }
      if (Number(row["expires_at"]) < Date.now()) {
        this.fail(ws, "invite_expired", "invite expired");
        return;
      }
      if (!this.bridgeSocket()) {
        this.fail(ws, "bridge_offline", "bridge is offline");
        return;
      }
      this.ctx.storage.sql.exec("UPDATE invites SET used_at = ? WHERE id = ?", Date.now(), String(row["id"]));
      mode = "pair";
      inviteId = String(row["id"]);
    } else if (hello.credential.kind === "device") {
      const row = this.ctx.storage.sql
        .exec(
          "SELECT token_hash, expires_at, revoked_at, name FROM devices WHERE id = ?",
          hello.credential.deviceId,
        )
        .toArray()[0];
      if (!row) {
        this.fail(ws, "invalid_credential", "unknown device");
        return;
      }
      if (row["revoked_at"] !== null) {
        this.fail(ws, "device_revoked", "device revoked");
        return;
      }
      if (row["expires_at"] !== null && Number(row["expires_at"]) < Date.now()) {
        this.fail(ws, "device_expired", "device expired");
        return;
      }
      if (!constantTimeEqual(await sha256Hex(hello.credential.token), String(row["token_hash"]))) {
        this.fail(ws, "invalid_credential", "bad device token");
        return;
      }
      if (!this.bridgeSocket()) {
        this.fail(ws, "bridge_offline", "bridge is offline");
        return;
      }
      this.ctx.storage.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now(), hello.credential.deviceId);
      mode = "device";
      deviceId = hello.credential.deviceId;
    } else {
      this.fail(ws, "invalid_credential", "bridge credential not valid for browser");
      return;
    }

    void this.touch();
    const attachment: Attachment = { role: "browser", channel: hello.channel, mode, authedAt: Date.now() };
    if (deviceId) attachment.deviceId = deviceId;
    ws.serializeAttachment(attachment);

    const bridge = this.bridgeSocket();
    if (!bridge) {
      this.fail(ws, "bridge_offline", "bridge is offline");
      return;
    }
    const open: RelayServerMessage = {
      v: RELAY_PROTOCOL_VERSION,
      type: "channel.open",
      channel: hello.channel,
      mode,
    };
    if (deviceId) open.deviceId = deviceId;
    if (inviteId) open.inviteId = inviteId;
    this.sendControl(bridge, open);
    this.sendControl(ws, {
      v: RELAY_PROTOCOL_VERSION,
      type: "ready",
      role: "browser",
      channel: hello.channel,
      bridgeOnline: true,
    });
  }

  private route(_ws: WebSocket, attachment: Attachment, data: ArrayBuffer): void {
    const frame = new Uint8Array(data);
    if (frame.length < 17 || frame.length > MAX_FRAME_BYTES) return;
    if (attachment.role === "bridge") {
      const channel = hex(frame.subarray(0, 16));
      const target = this.browserSocket(channel);
      if (!target) return;
      try {
        target.send(frame.subarray(16));
      } catch {
        // dropped frame; reconnect/resume handles gaps
      }
      return;
    }
    if (!attachment.channel) return;
    const bridge = this.bridgeSocket();
    if (!bridge) return;
    const out = new Uint8Array(16 + frame.length);
    out.set(fromHex(attachment.channel), 0);
    out.set(frame, 16);
    try {
      bridge.send(out);
    } catch {
      // dropped
    }
  }

  private broadcastPeerState(bridgeOnline: boolean): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.role !== "browser") continue;
      this.sendControl(ws, { v: RELAY_PROTOCOL_VERSION, type: "peer.state", bridgeOnline });
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "bridge") {
      this.broadcastPeerState(false);
      for (const other of this.ctx.getWebSockets()) {
        const otherAttachment = other.deserializeAttachment() as Attachment | null;
        if (otherAttachment?.role === "browser") other.close(4002, "bridge offline");
      }
    } else if (attachment?.role === "browser" && attachment.channel) {
      const bridge = this.bridgeSocket();
      if (bridge) {
        this.sendControl(bridge, {
          v: RELAY_PROTOCOL_VERSION,
          type: "channel.close",
          channel: attachment.channel,
          reason: reason || `close ${code}`,
        });
      }
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "socket error");
    } catch {
      // already closed
    }
  }
}


