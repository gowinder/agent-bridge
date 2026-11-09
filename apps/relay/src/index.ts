import type { DeviceListResponse, InviteResponse } from "@agent-bridge/protocol";
import type { Env } from "./env.js";
import { Room } from "./room.js";

export { Room };

const encoder = new TextEncoder();

function json(data: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function fail(code: string, message: string, status: number, origin?: string): Response {
  return json({ error: { code, message } }, status, origin);
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

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function roomStub(env: Env, roomId: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("origin");
  const allowed = env.WEB_ORIGIN ?? origin ?? "*";
  const headers = new Headers();
  headers.set("access-control-allow-origin", allowed === "*" ? "*" : allowed);
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "origin");
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request, env)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

const ROOM_ID = /^[a-z0-9-]{8,64}$/;

async function forward(
  env: Env,
  roomId: string,
  request: Request,
  innerPath: string,
): Promise<Response> {
  const target = new URL(request.url);
  target.pathname = innerPath;
  target.search = "";
  target.protocol = "https:";
  target.host = "room.internal";
  return roomStub(env, roomId).fetch(new Request(target, request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/v1/health") {
      return withCors(json({ ok: true, version: 1 }, 200), request, env);
    }

    if (!url.pathname.startsWith("/v1/")) {
      return fail("not_found", "unknown route", 404);
    }

    if (url.pathname === "/v1/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return fail("bad_request", "expected websocket upgrade", 426);
      }
      const roomId = url.searchParams.get("room") ?? "";
      if (!ROOM_ID.test(roomId)) return fail("bad_request", "bad room", 400);
      const target = new URL(request.url);
      target.protocol = "https:";
      target.host = "room.internal";
      target.pathname = "/ws";
      target.search = "";
      return roomStub(env, roomId).fetch(new Request(target, request));
    }

    const adminRequired = async (): Promise<Response | null> => {
      const expected = env.ADMIN_TOKEN;
      if (!expected) return fail("conflict", "ADMIN_TOKEN is not configured", 503);
      const presented = bearer(request);
      if (!presented || !constantTimeEqual(presented, expected)) {
        return fail("unauthorized", "bad admin token", 401);
      }
      return null;
    };

    if (url.pathname === "/v1/rooms" && request.method === "POST") {
      const rejected = await adminRequired();
      if (rejected) return withCors(rejected, request, env);
      let body: { roomId?: string; label?: string } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        body = {};
      }
      const roomId = body.roomId ?? crypto.randomUUID();
      if (!ROOM_ID.test(roomId)) return fail("bad_request", "bad roomId", 400);
      const bridgeToken = newToken();
      const bridgeHash = await sha256Hex(bridgeToken);
      const response = await roomStub(env, roomId).fetch(
        new Request("https://room.internal/admin/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomId, bridgeHash }),
        }),
      );
      if (!response.ok) return withCors(response, request, env);
      return withCors(json({ roomId, bridgeToken }, 201), request, env);
    }

    const roomMatch = /^\/v1\/rooms\/([a-z0-9-]{8,64})(\/.*)$/.exec(url.pathname);
    if (!roomMatch) return fail("not_found", "unknown route", 404);
    const roomId = roomMatch[1]!;
    const rest = roomMatch[2]!;

    if (rest === "/rotate" && request.method === "POST") {
      const rejected = await adminRequired();
      if (rejected) return withCors(rejected, request, env);
      const bridgeToken = newToken();
      const bridgeHash = await sha256Hex(bridgeToken);
      const target = new URL(request.url);
      target.protocol = "https:";
      target.host = "room.internal";
      target.pathname = "/admin/rotate";
      const response = await roomStub(env, roomId).fetch(
        new Request(target, { method: "POST", body: JSON.stringify({ bridgeHash }) }),
      );
      if (!response.ok) return withCors(response, request, env);
      return withCors(json({ roomId, bridgeToken }, 200), request, env);
    }

    if (rest === "/invites" && request.method === "POST") {
      const response = await forward(env, roomId, request, "/invites");
      if (!response.ok) return withCors(response, request, env);
      return withCors(json((await response.json()) as InviteResponse, 201), request, env);
    }

    if (rest === "/devices" && request.method === "GET") {
      const response = await forward(env, roomId, request, "/devices");
      if (!response.ok) return withCors(response, request, env);
      return withCors(json((await response.json()) as DeviceListResponse, 200), request, env);
    }

    if (rest === "/devices" && request.method === "POST") {
      const response = await forward(env, roomId, request, "/devices");
      if (!response.ok) return withCors(response, request, env);
      return withCors(json(await response.json(), 201), request, env);
    }

    const deviceMatch = /^\/devices\/([a-z0-9-]{8,64})$/.exec(rest);
    if (deviceMatch && request.method === "DELETE") {
      const response = await forward(env, roomId, request, `/devices/${deviceMatch[1]!}`);
      return withCors(response, request, env);
    }

    if (rest === "/status" && request.method === "GET") {
      const response = await forward(env, roomId, request, "/status");
      return withCors(response, request, env);
    }

    return fail("not_found", "unknown route", 404);
  },
} satisfies ExportedHandler<Env>;
