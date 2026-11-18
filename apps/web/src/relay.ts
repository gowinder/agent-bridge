import {
  RELAY_PROTOCOL_VERSION,
  RELAY_WS_PATH,
  type RelayHello,
  type RelayServerMessage,
} from "@craftstead/protocol";
import { tr } from "./i18n";

type Control = RelayServerMessage;

/**
 * 读循环意外退出（或长时间没人调用 nextFrame）时帧会一直堆在这里。
 * 留一点余量够重新排空就行，别把标签页内存吃光。
 */
const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_CONTROLS = 64;

type Waiter =
  | { kind: "control"; match: (message: Control) => boolean; resolve: (message: Control) => void }
  | { kind: "frame"; resolve: (frame: Uint8Array) => void }
  | { kind: "close"; resolve: (info: CloseInfo) => void };

export interface CloseInfo {
  code: number;
  reason: string;
}

export class RelayConnection {
  private readonly ws: WebSocket;
  private readonly controls: Control[] = [];
  private readonly frames: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly outbox: Array<string | Uint8Array> = [];
  private open = false;
  private closeInfo: CloseInfo | null = null;

  private constructor(
    relayUrl: string,
    roomId: string,
    hello: RelayHello,
    private readonly onClosed: (info: CloseInfo) => void,
  ) {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = RELAY_WS_PATH;
    url.search = `?room=${encodeURIComponent(roomId)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.open = true;
      this.ws.send(JSON.stringify(hello));
      for (const item of this.outbox) this.ws.send(item);
      this.outbox.length = 0;
    });
    this.ws.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer;
      if (typeof data === "string") {
        try {
          this.controls.push(JSON.parse(data) as Control);
        } catch {
          return;
        }
        if (this.controls.length > MAX_QUEUED_CONTROLS) this.controls.shift();
      } else {
        this.frames.push(new Uint8Array(data));
        if (this.frames.length > MAX_QUEUED_FRAMES) {
          // 丢一帧会让接收端的 nonce 错位，之后每一帧都解密失败 —— 表现成永久静默。
          // 溢出就关连接，让上层重连重建通道。
          this.close(1000, "backlog");
          return;
        }
      }
      this.pump();
    });
    this.ws.addEventListener("error", () => {
      this.handleClose({ code: 1006, reason: "websocket error" });
    });
    this.ws.addEventListener("close", (event) => {
      this.handleClose({ code: event.code, reason: event.reason });
    });
  }

  static connect(
    relayUrl: string,
    roomId: string,
    hello: RelayHello,
    onClosed: (info: CloseInfo) => void,
  ): { connection: RelayConnection; ready: Promise<void> } {
    const connection = new RelayConnection(relayUrl, roomId, hello, onClosed);
    const ready = connection.nextControl((message) => message.type === "ready" || message.type === "error").then(
      (message) => {
        if (message.type === "error") throw new RelayError(message.code, message.message);
        if (message.type !== "ready") throw new Error("unexpected relay reply");
      },
    );
    return { connection, ready };
  }

  private handleClose(info: CloseInfo): void {
    if (this.closeInfo) return;
    // 关掉之后 send 会抛 InvalidStateError；置回 false 让 sendBinary 走丢弃分支。
    this.open = false;
    this.closeInfo = info;
    this.onClosed(info);
    this.pump();
  }

  private pump(): void {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i]!;
      if (waiter.kind === "frame" && this.frames.length > 0) {
        this.waiters.splice(i, 1);
        waiter.resolve(this.frames.shift()!);
        return this.pump();
      }
      if (waiter.kind === "control") {
        const index = this.controls.findIndex(waiter.match);
        if (index !== -1) {
          const [message] = this.controls.splice(index, 1);
          this.waiters.splice(i, 1);
          waiter.resolve(message!);
          return this.pump();
        }
      }
      if (waiter.kind === "close" && this.closeInfo) {
        this.waiters.splice(i, 1);
        waiter.resolve(this.closeInfo);
        return this.pump();
      }
    }
  }

  nextControl(match: (message: Control) => boolean, timeoutMs = 10_000): Promise<Control> {
    const index = this.controls.findIndex(match);
    if (index !== -1) return Promise.resolve(this.controls.splice(index, 1)[0]!);
    return this.waitFor<Control>(timeoutMs, tr("中继控制消息超时"), (resolve) => ({
      kind: "control",
      match,
      resolve,
    }));
  }

  nextFrame(timeoutMs = 10_000): Promise<Uint8Array> {
    if (this.frames.length > 0) return Promise.resolve(this.frames.shift()!);
    return this.waitFor<Uint8Array>(timeoutMs, tr("中继数据帧超时"), (resolve) => ({ kind: "frame", resolve }));
  }

  closed(): Promise<CloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve) => this.waiters.push({ kind: "close", resolve }));
  }

  /**
   * 等一个 waiter，带超时。超时要把 waiter 从队列里摘掉：留着的话，
   * 之后真正到达的帧会被这个没人等的孤儿吃掉，表现为「偶发丢消息」。
   */
  private waitFor<T>(timeoutMs: number, label: string, make: (resolve: (value: T) => void) => Waiter): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let waiter: Waiter | null = null;
      const timer = setTimeout(() => {
        if (waiter) {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
        }
        reject(new Error(label));
      }, timeoutMs);
      waiter = make((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.waiters.push(waiter);
    });
  }

  sendBinary(frame: Uint8Array): void {
    // 已经关了就别再排队：既发不出去，也会把 outbox 撑大。
    if (this.closeInfo) return;
    if (this.open) this.ws.send(frame);
    else this.outbox.push(frame);
  }

  sendText(text: string): void {
    if (this.closeInfo) return;
    if (this.open) this.ws.send(text);
    else this.outbox.push(text);
  }

  close(code = 1000, reason = "done"): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export function helloMessage(
  roomId: string,
  channel: string,
  credential: RelayHello["credential"],
): RelayHello {
  return {
    v: RELAY_PROTOCOL_VERSION,
    type: "hello",
    role: "browser",
    room: roomId,
    channel,
    credential,
  };
}
