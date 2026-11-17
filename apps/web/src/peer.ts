import type { SecureChannel } from "@craftstead/crypto";
import type {
  EventMessage,
  Method,
  RequestMessage,
  ResponseMessage,
  WireMessage,
} from "@craftstead/protocol";
import type { RelayConnection } from "./relay.js";
import { tr } from "./i18n";

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 网页与 Bridge 之间的请求失败：重试有没有意义看 `code`，不看人类可读文案。
 * `timeout` 是这边等太久，`closed` 是通道没了（断线 / 主动关）。
 */
export class PeerError extends Error {
  constructor(
    readonly code: "timeout" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "PeerError";
  }
}

interface Pending {
  resolve: (message: ResponseMessage) => void;
  reject: (error: Error) => void;
  timer: number;
}

/** 这么久连一个下行帧都没有，就当通道已经死了：继续等只会让请求统统超时。 */
const FRAME_IDLE_MS = 60_000;

export class PeerClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: EventMessage) => void>();
  private readonly deadListeners = new Set<() => void>();
  private stopped = false;
  /** 读循环已经退出：socket 可能还开着，但这条通道再也收不到响应。 */
  private dead = false;

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
        this.connection.nextFrame(FRAME_IDLE_MS).catch(() => null),
        this.connection.closed().then(() => null),
      ]);
      if (this.stopped) return;
      if (frame === null) {
        // 超时和真关闭都走这里。两种情况下通道都不再可用，必须主动结束并通知上层：
        // 只是 return 的话 `active` 仍非空，后续每个请求都会白等 20 秒超时。
        this.die();
        return;
      }
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
    // 已经关掉/判死的通道发不出去了：立刻报错，别让调用方白等 20 秒。
    if (this.stopped) return Promise.reject(new PeerError("closed", tr("连接已关闭")));
    const id = requestId();
    const message: RequestMessage =
      params === undefined
        ? { v: 1, kind: "request", id, method }
        : { v: 1, kind: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new PeerError("timeout", tr("Bridge 响应超时")));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      for (const frame of this.secure.seal(message)) this.connection.sendBinary(frame);
    });
  }

  /**
   * 通道死了（读循环退出 / 超时没有下行帧）时回调一次，让上层去重连。
   * 已经死了的话立刻回调，避免注册晚一步就永远收不到。
   */
  onDead(listener: () => void): () => void {
    if (this.dead) {
      listener();
      return () => {};
    }
    this.deadListeners.add(listener);
    return () => this.deadListeners.delete(listener);
  }

  get isDead(): boolean {
    return this.dead;
  }

  private die(): void {
    if (this.dead || this.stopped) return;
    this.dead = true;
    // 关掉连接：relay 会通知 Bridge 释放这条通道，pending 的请求也会以 closed 结束。
    this.stop();
    for (const listener of this.deadListeners) listener();
    this.deadListeners.clear();
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
      pending.reject(new PeerError("closed", tr("连接已关闭")));
    }
    this.pending.clear();
    this.listeners.clear();
    this.secure.close();
    this.connection.close();
  }
}
