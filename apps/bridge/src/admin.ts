// Local control surface for the menu bar app. Loopback-only HTTP with a bearer
// token stored next to the bridge state, so a GUI process can read who is
// connected and cut a device off without touching the relay.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { DevtoolsCapabilityName, DevtoolsStatus } from "@craftstead/protocol";
import { isDevtoolsCapability } from "./devtools.js";

export const ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 47825;
/** preview 实例的默认端口：与生产错开，两份 Bridge 可以同时运行。 */
export const PREVIEW_ADMIN_PORT = 47826;
/** 每个状态目录各自保存管理端口，preview 与生产实例才能同时运行。 */
export const ADMIN_PORT_FILE = "admin-port";

function validPort(value: number): number | null {
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

/** 中继地址或 AGENT_BRIDGE_ENV 指向 preview 时用 preview 默认端口。 */
export function isPreviewDeployment(relayUrl?: string | null): boolean {
  const env = process.env["AGENT_BRIDGE_ENV"]?.trim().toLowerCase();
  if (env === "preview" || env === "dev" || env === "development") return true;
  if (env === "production" || env === "prod") return false;
  if (!relayUrl) return false;
  let host = relayUrl;
  try {
    host = new URL(relayUrl).hostname;
  } catch {
    // 不是完整 URL 时按原字符串判断
  }
  return /preview|staging/i.test(host);
}

/** `${dir}/admin-port` 里的端口；文件缺失或内容不合法时返回 null。 */
export function readAdminPortFile(dir: string): number | null {
  try {
    const raw = readFileSync(join(dir, ADMIN_PORT_FILE), "utf8").trim();
    return raw === "" ? null : validPort(Number(raw));
  } catch {
    return null;
  }
}

/** 写入管理端口文件；菜单栏和 CLI 共用这一份。 */
export function writeAdminPortFile(dir: string, port: number): void {
  const value = validPort(port);
  if (value === null) throw new Error(`端口不合法：${port}（1–65535）`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ADMIN_PORT_FILE);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/**
 * 端口优先级：`AGENT_BRIDGE_ADMIN_PORT` > `admin-port` 文件 > 旧版 meta >
 * 按部署环境取默认（preview 47826、生产 47825）。
 * 环境变量支持临时覆盖；文件让 preview/生产各用各的端口。
 */
export function resolveAdminPort(
  dir: string,
  options: { relayUrl?: string | null; legacyMeta?: string | null } = {},
): number {
  const fromEnv = validPort(Number(process.env["AGENT_BRIDGE_ADMIN_PORT"]));
  if (fromEnv !== null) return fromEnv;
  const fromFile = readAdminPortFile(dir);
  if (fromFile !== null) return fromFile;
  const fromMeta = validPort(Number(options.legacyMeta));
  if (fromMeta !== null) return fromMeta;
  return isPreviewDeployment(options.relayUrl) ? PREVIEW_ADMIN_PORT : DEFAULT_ADMIN_PORT;
}

export interface AdminDevice {
  deviceId: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  online: boolean;
  /** 最近操作日志，最新的在最前面。 */
  log: string[];
}

export interface AdminConnection {
  channel: string;
  kind: "pair" | "device";
  deviceId: string | null;
  name: string | null;
  since: number;
}

export interface AdminPairing {
  channel: string;
  /** Null until the browser's handshake finishes. */
  code: string | null;
  since: number;
}

export interface AdminSnapshot {
  version: string;
  hostName: string;
  roomId: string;
  webUrl: string;
  relayOnline: boolean;
  bridgePid: number;
  devices: AdminDevice[];
  connections: AdminConnection[];
  devtools: DevtoolsStatus;
  /** Pairing channels that are still waiting for the confirm-code check. */
  pairings: AdminPairing[];
  /** Set when the relay could not be asked for the device list. */
  error?: string;
}

export interface AdminActions {
  snapshot(): Promise<AdminSnapshot>;
  disconnectDevice(deviceId: string): Promise<{ closed: number }>;
  revokeDevice(deviceId: string): Promise<{ closed: number }>;
  disconnectAll(): Promise<{ closed: number }>;
  revokeAll(): Promise<{ revoked: number; closed: number; failed: string[] }>;
  createInvite(ttlSeconds: number): Promise<{ url: string; expiresAt: number }>;
  setDevtools(
    capability: DevtoolsCapabilityName,
    enabled: boolean,
    ttlSeconds: number | null,
  ): Promise<DevtoolsStatus>;
}

export interface AdminServerOptions {
  port: number;
  token: string;
  actions: AdminActions;
  log: (line: string) => void;
}

/** Reads the admin token from the state directory, creating it on first run. */
export function ensureAdminToken(dir: string): string {
  const path = join(dir, "admin-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      // 老版本可能写出 0644，读到就顺手收紧。
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort
      }
      return existing;
    }
  } catch {
    // create below
  }
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
  return token;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Only the local menu bar app talks here: it sends no Origin and names a loopback
 * Host. A browser page (or a DNS-rebinding name) is refused before the token check,
 * so a stray page cannot drive the bridge even if it learns the token.
 */
function localRequest(request: IncomingMessage): boolean {
  if (request.headers["origin"] !== undefined) return false;
  const host = request.headers["host"];
  if (typeof host !== "string") return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return hostname === ADMIN_HOST || hostname === "localhost" || hostname === "[::1]";
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 8_192) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function startAdminServer(options: AdminServerOptions): Promise<Server> {
  const { actions, token, log } = options;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (!localRequest(request)) {
          send(response, 403, { error: "forbidden" });
          return;
        }
        if (!authorized(request, token)) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        const url = new URL(request.url ?? "/", `http://${ADMIN_HOST}`);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        if (path === "/status" && request.method === "GET") {
          send(response, 200, await actions.snapshot());
          return;
        }
        if (path === "/invite" && request.method === "POST") {
          const body = await readBody(request);
          const ttl = typeof body["ttlSeconds"] === "number" ? body["ttlSeconds"] : 300;
          send(response, 200, await actions.createInvite(Math.min(Math.max(ttl, 30), 600)));
          return;
        }
        if (path === "/devtools" && request.method === "POST") {
          const body = await readBody(request);
          const capability = body["capability"];
          if (!isDevtoolsCapability(capability)) {
            send(response, 400, { error: "capability 必须是 files 或 terminal" });
            return;
          }
          const enabled = body["enabled"] === true;
          const ttl = typeof body["ttlSeconds"] === "number" ? body["ttlSeconds"] : null;
          send(response, 200, await actions.setDevtools(capability, enabled, ttl));
          return;
        }
        if (path === "/devices/disconnect-all" && request.method === "POST") {
          send(response, 200, await actions.disconnectAll());
          return;
        }
        if (path === "/devices/revoke-all" && request.method === "POST") {
          send(response, 200, await actions.revokeAll());
          return;
        }
        const action = /^\/devices\/([A-Za-z0-9_-]{8,64})\/(disconnect|revoke)$/.exec(path);
        if (action && request.method === "POST") {
          const deviceId = action[1] ?? "";
          if (action[2] === "disconnect") {
            send(response, 200, await actions.disconnectDevice(deviceId));
          } else {
            send(response, 200, await actions.revokeDevice(deviceId));
          }
          return;
        }
        send(response, 404, { error: "not_found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`管理接口出错：${message}`);
        if (!response.headersSent) send(response, 500, { error: message });
        else response.end();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, ADMIN_HOST, () => {
      server.off("error", reject);
      server.on("error", (error: Error) => log(`管理接口错误：${error.message}`));
      resolve(server);
    });
  });
}
