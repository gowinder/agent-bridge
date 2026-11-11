import type { SecureChannel } from "@craftstead/crypto";
import type {
  EventMessage,
  Method,
  RequestMessage,
  ResponseMessage,
  WireMessage,
} from "@craftstead/protocol";
import type { RelayConnection } from "./relay.js";

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Pending {
  resolve: (message: ResponseMessage) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class PeerClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: EventMessage) => void>();
  private stopped = false;

  constructor(
    private readonly connection: RelayConnection,
    private readonly secure: SecureChannel,
  ) {
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const frame = await Promise.race([
        this.connection.nextFrame(60_000).catch(() => null),
        this.connection.closed().then(() => null),
      ]);
      if (frame === null || this.stopped) return;
      let message: WireMessage | null;
      try {
        message = this.secure.open(frame);
      } catch {
        message = null;
      }
      // `null` also means "a chunk was buffered"; only a real close stops the loop.
      if (!message) continue;
      this.dispatch(message);
    }
  }

  private dispatch(message: WireMessage): void {
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    if (message.kind === "event") {
      for (const listener of this.listeners) listener(message);
    }
  }

  request(method: Method, params?: unknown, timeoutMs = 20_000): Promise<ResponseMessage> {
    const id = requestId();
    const message: RequestMessage =
      params === undefined
        ? { v: 1, kind: "request", id, method }
        : { v: 1, kind: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Bridge 响应超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      for (const frame of this.secure.seal(message)) this.connection.sendBinary(frame);
    });
  }

  onEvent(listener: (event: EventMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("连接已关闭"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.secure.close();
    this.connection.close();
  }
}
