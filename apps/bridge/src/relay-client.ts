import {
  RELAY_PROTOCOL_VERSION,
  RELAY_WS_PATH,
  type DeviceListResponse,
  type InviteResponse,
  type RegisterDeviceResponse,
  type RelayServerMessage,
  type RoomStatusResponse,
} from "@agent-bridge/protocol";
import { fromHex, toHex } from "@agent-bridge/crypto";

export class RelayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorCode(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error === "object" && error !== null) {
      const code = (error as Record<string, unknown>)["code"];
      const message = (error as Record<string, unknown>)["message"];
      if (typeof code === "string") return `${code}: ${typeof message === "string" ? message : ""}`;
    }
  }
  return fallback;
}

export async function createRoom(
  relayUrl: string,
  adminToken: string,
  roomId: string,
): Promise<{ roomId: string; bridgeToken: string }> {
  const response = await fetch(new URL("/v1/rooms", relayUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new RelayError(errorCode(body, "request_failed"), `create room failed (${response.status})`, response.status);
  }
  const parsed = body as { roomId?: string; bridgeToken?: string };
  if (!parsed.roomId || !parsed.bridgeToken) throw new RelayError("bad_response", "bad create response", 502);
  return { roomId: parsed.roomId, bridgeToken: parsed.bridgeToken };
}

export class RelayApi {
  constructor(
    private readonly relayUrl: string,
    private readonly roomId: string,
    private readonly bridgeToken: string,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(new URL(`/v1/rooms/${this.roomId}${path}`, this.relayUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new RelayError(errorCode(body, "request_failed"), `relay error (${response.status})`, response.status);
    }
    return body;
  }

  async createInvite(ttlSeconds = 300): Promise<InviteResponse> {
    return (await this.call("/invites", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds }),
    })) as InviteResponse;
  }

  async registerDevice(input: {
    deviceId: string;
    name: string;
    publicKey: string;
    ttlSeconds: number | null;
  }): Promise<RegisterDeviceResponse> {
    return (await this.call("/devices", {
      method: "POST",
      body: JSON.stringify(input),
    })) as RegisterDeviceResponse;
  }

  async devices(): Promise<DeviceListResponse> {
    return (await this.call("/devices", { method: "GET" })) as DeviceListResponse;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.call(`/devices/${deviceId}`, { method: "DELETE" });
  }

  async status(): Promise<RoomStatusResponse> {
    return (await this.call("/status", { method: "GET" })) as RoomStatusResponse;
  }
}

export interface RelayHandlers {
  onChannelOpen(message: Extract<RelayServerMessage, { type: "channel.open" }>): void;
  onChannelClose(channel: string, reason: string | undefined): void;
  onPeerState(bridgeOnline: boolean): void;
  onFrame(channel: string, frame: Uint8Array): void;
}

interface CloseInfo {
  code: number;
  reason: string;
}

function websocketUrl(relayUrl: string, roomId: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = RELAY_WS_PATH;
  url.search = `?room=${encodeURIComponent(roomId)}`;
  return url.toString();
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private closeResolve: ((info: CloseInfo) => void) | null = null;
  private readonly closedPromise: Promise<CloseInfo>;

  constructor(
    private readonly relayUrl: string,
    private readonly roomId: string,
    private readonly bridgeToken: string,
    private readonly handlers: RelayHandlers,
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
  }

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(websocketUrl(this.relayUrl, this.roomId));
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close(4000, "auth timeout");
        } catch {
          // ignore
        }
        reject(new Error("relay hello timed out"));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            v: RELAY_PROTOCOL_VERSION,
            type: "hello",
            role: "bridge",
            room: this.roomId,
            credential: { kind: "bridge", token: this.bridgeToken },
          }),
        );
      });

      ws.addEventListener("message", (event) => {
        const data = (event as MessageEvent).data as string | ArrayBuffer;
        if (typeof data === "string") {
          let message: RelayServerMessage;
          try {
            message = JSON.parse(data) as RelayServerMessage;
          } catch {
            return;
          }
          if (message.type === "ready") {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            return;
          }
          if (message.type === "error") {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new RelayError(message.code, message.message, 401));
            }
            return;
          }
          if (message.type === "channel.open") {
            this.handlers.onChannelOpen(message);
            return;
          }
          if (message.type === "channel.close") {
            this.handlers.onChannelClose(message.channel, message.reason);
            return;
          }
          if (message.type === "peer.state") {
            this.handlers.onPeerState(message.bridgeOnline);
          }
          return;
        }
        const frame = new Uint8Array(data);
        if (frame.length < 17) return;
        this.handlers.onFrame(toHex(frame.subarray(0, 16)), frame.subarray(16));
      });

      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("relay websocket error"));
      });

      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error(`relay closed during hello (${event.code})`));
        }
        this.closeResolve?.({ code: event.code, reason: event.reason });
      });
    });
  }

  send(channel: string, frame: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(16 + frame.length);
    out.set(fromHex(channel), 0);
    out.set(frame, 16);
    this.ws.send(out);
  }

  closeChannel(channel: string, reason?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!/^[0-9a-f]{32}$/.test(channel)) return;
    this.ws.send(
      JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        type: "channel.close",
        channel,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(code = 1000, reason = "shutdown"): void {
    try {
      this.ws?.close(code, reason);
    } catch {
      // ignore
    }
  }

  waitClosed(): Promise<CloseInfo> {
    return this.closedPromise;
  }
}
