/**
 * `apps/web/src/relay.ts` 的 RelayConnection：Node 自带 WebSocket，语义一样。
 * 一个连接只承载一条 channel；控制消息走文本帧，Noise 帧走二进制帧。
 *
 * 来源：gowinder/agent-bridge develop @ 2fbf2f25edd15ff7464ffab1d67ecbfb3fe5412e
 *       spikes/mcp-client/relay.mjs（逐字复制，无改动）
 */

import { RELAY_PROTOCOL_VERSION, RELAY_WS_PATH } from "@craftstead/protocol";

const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_CONTROLS = 64;

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

/** 中继的 WS 地址：http→ws、https→wss，路径固定 RELAY_WS_PATH，房间号走查询参数。 */
export function relaySocketUrl(relayUrl, roomId) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = RELAY_WS_PATH;
  url.search = `?room=${encodeURIComponent(roomId)}`;
  return url.toString();
}

export class RelayConnection {
  #ws;
  #controls = [];
  #frames = [];
  #waiters = [];
  #outbox = [];
  #open = false;
  #closeInfo = null;

  constructor(relayUrl, roomId, hello, onClosed) {
    const url = relaySocketUrl(relayUrl, roomId);
    this.url = url;
    this.onClosed = onClosed;
    this.#ws = new WebSocket(url);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.addEventListener("open", () => {
      this.#open = true;
      this.#ws.send(JSON.stringify(hello));
      for (const item of this.#outbox) this.#ws.send(item);
      this.#outbox.length = 0;
    });
    this.#ws.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") {
        try {
          this.#controls.push(JSON.parse(data));
        } catch {
          return;
        }
        if (this.#controls.length > MAX_QUEUED_CONTROLS) this.#controls.shift();
      } else {
        this.#frames.push(new Uint8Array(data));
        if (this.#frames.length > MAX_QUEUED_FRAMES) {
          // 丢一帧会让接收端 nonce 错位，之后每帧都解不开 —— 直接关掉让上层报错。
          this.close(1000, "backlog");
          return;
        }
      }
      this.#pump();
    });
    this.#ws.addEventListener("error", () => {
      this.#handleClose({ code: 1006, reason: "websocket error" });
    });
    this.#ws.addEventListener("close", (event) => {
      this.#handleClose({ code: event.code, reason: event.reason });
    });
  }

  static connect(relayUrl, roomId, hello, onClosed = () => {}) {
    const connection = new RelayConnection(relayUrl, roomId, hello, onClosed);
    const ready = Promise.race([
      connection.nextControl((message) => message.type === "ready" || message.type === "error"),
      // 网页里这条 race 不存在：Node 下连不上时只有 close 事件，等控制消息会白等 10 秒。
      connection.closed().then((info) => {
        throw new RelayError("closed", `中继连接已关闭 code=${info.code} reason=${info.reason}`);
      }),
    ]).then((message) => {
      if (message.type === "error") throw new RelayError(message.code, message.message);
      if (message.type !== "ready") throw new Error("unexpected relay reply");
      return message;
    });
    return { connection, ready };
  }

  #handleClose(info) {
    if (this.#closeInfo) return;
    this.#open = false;
    this.#closeInfo = info;
    this.onClosed(info);
    this.#pump();
  }

  #pump() {
    for (let i = 0; i < this.#waiters.length; i += 1) {
      const waiter = this.#waiters[i];
      if (waiter.kind === "frame" && this.#frames.length > 0) {
        this.#waiters.splice(i, 1);
        waiter.resolve(this.#frames.shift());
        return this.#pump();
      }
      if (waiter.kind === "control") {
        const index = this.#controls.findIndex(waiter.match);
        if (index !== -1) {
          const [message] = this.#controls.splice(index, 1);
          this.#waiters.splice(i, 1);
          waiter.resolve(message);
          return this.#pump();
        }
      }
      if (waiter.kind === "close" && this.#closeInfo) {
        this.#waiters.splice(i, 1);
        waiter.resolve(this.#closeInfo);
        return this.#pump();
      }
    }
  }

  nextControl(match, timeoutMs = 10_000) {
    const index = this.#controls.findIndex(match);
    if (index !== -1) return Promise.resolve(this.#controls.splice(index, 1)[0]);
    return this.#waitFor(timeoutMs, "中继控制消息超时", (resolve) => ({ kind: "control", match, resolve }));
  }

  nextFrame(timeoutMs = 10_000) {
    if (this.#frames.length > 0) return Promise.resolve(this.#frames.shift());
    return this.#waitFor(timeoutMs, "中继数据帧超时", (resolve) => ({ kind: "frame", resolve }));
  }

  closed() {
    if (this.#closeInfo) return Promise.resolve(this.#closeInfo);
    return new Promise((resolve) => this.#waiters.push({ kind: "close", resolve }));
  }

  /** 超时要把 waiter 摘掉：留着的话，之后真到的帧会被这个没人等的孤儿吃掉。 */
  #waitFor(timeoutMs, label, make) {
    return new Promise((resolve, reject) => {
      let waiter = null;
      const timer = setTimeout(() => {
        if (waiter) {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
        }
        reject(new Error(label));
      }, timeoutMs);
      waiter = make((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.#waiters.push(waiter);
    });
  }

  sendBinary(frame) {
    if (this.#closeInfo) return;
    if (this.#open) this.#ws.send(frame);
    else this.#outbox.push(frame);
  }

  sendText(text) {
    if (this.#closeInfo) return;
    if (this.#open) this.#ws.send(text);
    else this.#outbox.push(text);
  }

  close(code = 1000, reason = "done") {
    try {
      this.#ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}

export function helloMessage(roomId, channel, credential) {
  return {
    v: RELAY_PROTOCOL_VERSION,
    type: "hello",
    role: "browser",
    room: roomId,
    channel,
    credential,
  };
}
