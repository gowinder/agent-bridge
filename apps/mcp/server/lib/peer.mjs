/**
 * `apps/web/src/peer.ts` 的 PeerClient：请求按 id 配对，事件忽略，
 * `open()` 返回 null 表示「这一帧只是分片，继续读」。
 *
 * 来源：gowinder/agent-bridge develop @ 2fbf2f25edd15ff7464ffab1d67ecbfb3fe5412e
 *       spikes/mcp-client/peer.mjs
 * 改动（相对 spike）：新增 requestWith()，给请求帧带上协议顶层的 operationId
 * （幂等键，protocol RequestMessage.operationId）；request() 语义与 spike 完全一致。
 */

const FRAME_IDLE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PeerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PeerError";
    this.code = code;
  }
}

export class PeerClient {
  #pending = new Map();
  #stopped = false;
  #dead = false;

  constructor(connection, secure) {
    this.connection = connection;
    this.secure = secure;
    void this.#readLoop();
  }

  async #readLoop() {
    for (;;) {
      if (this.#stopped) return;
      const frame = await Promise.race([
        this.connection.nextFrame(FRAME_IDLE_MS).catch(() => null),
        this.connection.closed().then(() => null),
      ]);
      if (this.#stopped) return;
      if (frame === null) {
        // 超时和真关闭都走这里：通道从此收不到响应，必须主动结束。
        this.#die();
        return;
      }
      let message = null;
      try {
        message = this.secure.open(frame);
      } catch {
        message = null;
      }
      // null 也可能是「分片已缓存」，只有通道关闭才停循环。
      if (!message) continue;
      if (message.kind !== "response") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  get isDead() {
    return this.#dead;
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.requestWith(method, params, { timeoutMs });
  }

  /** spike 版 request + 可选的 operationId（变更类方法的重试幂等键）。 */
  requestWith(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, operationId } = {}) {
    if (this.#stopped) return Promise.reject(new PeerError("closed", "连接已关闭"));
    const id = requestId();
    const message = {
      v: 1,
      kind: "request",
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(operationId ? { operationId } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PeerError("timeout", `Bridge 响应超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      for (const frame of this.secure.seal(message)) this.connection.sendBinary(frame);
    });
  }

  #die() {
    if (this.#dead || this.#stopped) return;
    this.#dead = true;
    this.stop();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PeerError("closed", "连接已关闭"));
    }
    this.#pending.clear();
    this.secure.close();
    this.connection.close();
  }
}

/** verify 里每一步都要「失败就停」，这里把 `ok:false` 直接抛成带 code 的错误。 */
export async function call(client, method, params, timeoutMs) {
  const response = await client.request(method, params, timeoutMs);
  if (!response.ok) {
    throw new PeerError(response.error?.code ?? "internal", response.error?.message ?? `${method} 失败`);
  }
  return response.result;
}
