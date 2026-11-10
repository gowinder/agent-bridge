import type { DeviceListResponse, InviteResponse } from "@agent-bridge/protocol";
import type { Env } from "./env.js";
import { clientIp, rateLimit } from "./rate-limit.js";
import { Room } from "./room.js";

export { Room };

function json(data: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function fail(code: string, message: string, status: number, origin?: string): Response {
  return json({ error: { code, message } }, status, origin);
}

function roomStub(env: Env, roomId: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Only the configured web origin (or, when unset, the relay's own origin) may call
 * the API from a browser. Never reflect an arbitrary Origin. A relay running on
 * loopback additionally accepts loopback origins so `vite dev` keeps working.
 */
function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (env.WEB_ORIGIN) return origin === env.WEB_ORIGIN ? origin : null;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    if (originUrl.host === requestUrl.host) return origin;
    if (isLoopback(requestUrl.hostname) && isLoopback(originUrl.hostname)) return origin;
    return null;
  } catch {
    return null;
  }
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  headers.set("vary", "origin");
  const origin = allowedOrigin(request, env);
  if (!origin) return headers;
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request, env)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

const ROOM_ID = /^[a-z0-9-]{8,64}$/;
/** 同一 IP 每分钟能发起的 WebSocket 连接（含浏览器重连与 bridge 重连）。 */
const WS_LIMIT_PER_MIN = 40;
/** 同一 IP 每分钟能调用的房间 REST 接口。 */
const API_LIMIT_PER_MIN = 120;

function tooMany(retryAfter: number, request: Request, env: Env): Response {
  // 429 同样只能回带白名单里的 Origin，不能把请求头原样反射回去。
  const response = fail(
    "rate_limited",
    "too many requests",
    429,
    allowedOrigin(request, env) ?? undefined,
  );
  response.headers.set("retry-after", String(Math.max(retryAfter, 1)));
  return response;
}

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
      // Browsers always attach Origin; a foreign page must not drive this room.
      // Non-browser clients (the bridge) send no Origin and are still authenticated by hello.
      if (request.headers.get("origin") !== null && allowedOrigin(request, env) === null) {
        return fail("unauthorized", "origin not allowed", 403);
      }
      const wsLimit = rateLimit(`ws:${clientIp(request)}`, WS_LIMIT_PER_MIN, 60_000);
      if (!wsLimit.ok) return tooMany(wsLimit.retryAfter, request, env);
      const roomId = url.searchParams.get("room") ?? "";
      if (!ROOM_ID.test(roomId)) return fail("bad_request", "bad room", 400);
      const target = new URL(request.url);
      target.protocol = "https:";
      target.host = "room.internal";
      target.pathname = "/ws";
      target.search = "";
      return roomStub(env, roomId).fetch(new Request(target, request));
    }

    const roomMatch = /^\/v1\/rooms\/([a-z0-9-]{8,64})(\/.*)$/.exec(url.pathname);
    if (!roomMatch) return fail("not_found", "unknown route", 404);
    const roomId = roomMatch[1]!;
    const rest = roomMatch[2]!;

    const apiLimit = rateLimit(`api:${clientIp(request)}`, API_LIMIT_PER_MIN, 60_000);
    if (!apiLimit.ok) return tooMany(apiLimit.retryAfter, request, env);

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
