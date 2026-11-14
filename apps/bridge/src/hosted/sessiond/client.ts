import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  SESSIOND_VERSION,
  type SessiondEvent,
  type SessiondReply,
  type SessiondRequest,
} from "./protocol.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** hello 版本不符时抛出的错误：上层据此要求旧守护进程 shutdown 后重启。 */
export const SESSIOND_VERSION_ERROR = "sessiond-version";

/** 请求 id 由客户端补：调用方只写 op 与参数，不用每次手拼 id。 */
type WithOptionalId<T> = T extends unknown
  ? "id" extends keyof T
    ? Omit<T, "id"> & { id?: string }
    : T
  : never;

export type SessiondRequestInput = WithOptionalId<SessiondRequest>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * sessiond 的 NDJSON 客户端：一行一条消息，带 id + ok 的是回执，带 op 的是事件。
 * 连接断开后所有还没回执的请求都 reject，由上层决定重连还是回退。
 */
export class SessiondClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: SessiondEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private sequence = 0;

  /** 连上后先握手：版本不一致时抛 SESSIOND_VERSION_ERROR，发现不了就会驱动旧实例。 */
  static async connect(
    socketPath: string,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    options: { hello?: boolean } = {},
  ): Promise<SessiondClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connection = createConnection(socketPath);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        connection.destroy();
        reject(new Error(`连接 sessiond 超时：${socketPath}`));
      }, timeoutMs);
      connection.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(connection);
      });
      connection.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
    const client = new SessiondClient(socket);
    // 发 shutdown 旧实例时只借一条原始连接，不需要握手。
    if (options.hello === false) return client;
    try {
      await client.request({ op: "hello", version: SESSIOND_VERSION }, timeoutMs);
    } catch (error) {
      client.close();
      if (error instanceof Error && error.message === "version") {
        throw new Error(SESSIOND_VERSION_ERROR);
      }
      throw error;
    }
    return client;
  }

  private constructor(socket: Socket) {
    this.socket = socket;
    const reader = createInterface({ input: socket });
    reader.on("line", (line) => this.handleLine(line));
    socket.on("error", () => this.finish());
    socket.on("close", () => this.finish());
  }

  /** 带 id 的请求：超时或连接断开时 reject，回执里的 result 原样返回。 */
  request<T = unknown>(message: SessiondRequestInput, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("sessiond 连接已关闭"));
    const id = (message as { id?: string }).id ?? `bridge-${++this.sequence}`;
    const payload = { ...message, id } as SessiondRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sessiond 请求超时：${payload.op}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });
      this.sendRaw(payload);
    });
  }

  /** 单向指令（stdin/end/ack）：没有回执，写失败也不报错。 */
  send(message: SessiondRequestInput): void {
    this.sendRaw(message as SessiondRequest);
  }

  onEvent(listener: (event: SessiondEvent) => void): void {
    this.eventListeners.add(listener);
  }

  onClose(listener: () => void): void {
    if (this.closed) {
      queueMicrotask(listener);
      return;
    }
    this.closeListeners.add(listener);
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.socket.destroy();
  }

  private sendRaw(message: SessiondRequest): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 坏行直接忽略：一行损坏不该带走整条连接。
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    if (typeof record["id"] === "string" && typeof record["ok"] === "boolean") {
      const reply = record as unknown as SessiondReply;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error ?? "sessiond 请求失败"));
      return;
    }
    if (typeof record["op"] === "string") {
      const event = record as unknown as SessiondEvent;
      for (const listener of this.eventListeners) listener(event);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("sessiond 连接已关闭");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}
