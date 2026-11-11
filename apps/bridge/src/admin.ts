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

export interface AdminDevice {
  deviceId: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  online: boolean;
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
    if (existing) return existing;
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
