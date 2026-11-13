import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { killProcess, markProcessGroup } from "../process-group.js";
import {
  SESSIOND_BUFFER_BYTES,
  SESSIOND_IDLE_MS,
  SESSIOND_SOCKET,
  SESSIOND_VERSION,
  type SessiondAttachResult,
  type SessiondChunk,
  type SessiondEvent,
  type SessiondReply,
  type SessiondRequest,
  type SessiondSessionInfo,
} from "./protocol.js";

/** 已有实例在监听时抛出的错误；main.ts 靠它静默退出第二个实例。 */
export const SESSIOND_ALREADY_RUNNING = "sessiond already running";

/** 子进程只需要这几个能力，测试里可以换成假对象。 */
export interface ChildProcessLike {
  readonly pid?: number;
  /** 由 defaultSpawn 标记：这个子进程自成一个进程组，kill 要杀整组。 */
  readonly ownsProcessGroup?: boolean;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface SessiondServerOptions {
  stateDir: string;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessLike;
  log?: (line: string) => void;
  /** 测试用：把 4MB 上限调小，避免真的写满内存。 */
  bufferBytes?: number;
}

export interface SessiondServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface SessionState {
  sessionId: string;
  child: ChildProcessLike;
  /** 启动参数：Bridge 接回旧进程时靠它判断模型是不是换过了。 */
  args: string[];
  pid: number | null;
  running: boolean;
  lastSeq: number;
  ignoredSeq: number;
  backlog: SessiondChunk[];
  backlogChars: number;
  gap: boolean;
  killTimer: NodeJS.Timeout | null;
}

const KILL_GRACE_MS = 2_000;
const IDLE_CHECK_MS = 30_000;
const PROBE_TIMEOUT_MS = 500;

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessLike {
  // detached：托管进程自成一个进程组，停止时能连它再 spawn 出来的孙进程一起收掉。
  return markProcessGroup(
    nodeSpawn(command, args, { ...options, stdio: "pipe", detached: true }),
  ) as unknown as ChildProcessLike;
}

/** 用一次连接判断 socket 后面是否还有活着的实例，避免误删正在用的文件。 */
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
  });
}

export async function startSessiondServer(options: SessiondServerOptions): Promise<SessiondServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const spawnChild = options.spawn ?? defaultSpawn;
  const bufferBytes = options.bufferBytes ?? SESSIOND_BUFFER_BYTES;
  const socketPath = join(options.stateDir, "hosted", SESSIOND_SOCKET);

  mkdirSync(join(options.stateDir, "hosted"), { recursive: true });
  if (existsSync(socketPath)) {
    if (await probeSocket(socketPath)) throw new Error(SESSIOND_ALREADY_RUNNING);
    // 上次异常退出留下的 socket 文件没有监听者，删掉才能重新 bind。
    try {
      unlinkSync(socketPath);
    } catch {
      // 并发启动时另一个实例可能已经删掉了，忽略。
    }
  }

  const sessions = new Map<string, SessionState>();
  const connections = new Set<Socket>();
  let lastActivity = Date.now();
  let closing = false;
  // close 定义在后面；shutdown 分支先占位，避免收尾逻辑被提前引用。
  let shutdownNow: () => void = () => process.exit(0);

  const touch = (): void => {
    lastActivity = Date.now();
  };

  const send = (socket: Socket, message: SessiondReply | SessiondEvent): void => {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const broadcast = (message: SessiondEvent): void => {
    for (const socket of connections) send(socket, message);
  };

  const trimBacklog = (session: SessionState): void => {
    while (session.backlogChars > bufferBytes) {
      const dropped = session.backlog.shift();
      if (!dropped) break;
      session.backlogChars -= dropped.data.length;
      // 缓存装不下时只标记断档，Bridge 重连后知道自己少了中间一段。
      session.gap = true;
    }
  };

  const ackSession = (session: SessionState, seq: number): void => {
    const target = Math.max(0, seq);
    session.ignoredSeq = Math.max(session.ignoredSeq, target);
    while (session.backlog.length > 0) {
      const first = session.backlog[0];
      if (!first || first.seq > target) break;
      session.backlog.shift();
      session.backlogChars -= first.data.length;
    }
  };

  const attachResult = (session: SessionState, ack: number): SessiondAttachResult => {
    ackSession(session, ack);
    return {
      pid: session.pid,
      running: session.running,
      lastSeq: session.lastSeq,
      backlog: session.backlog.map((chunk) => ({ ...chunk })),
      gap: session.gap,
      args: [...session.args],
    };
  };

  const sessionInfo = (session: SessionState): SessiondSessionInfo => ({
    sessionId: session.sessionId,
    pid: session.pid,
    running: session.running,
    lastSeq: session.lastSeq,
    ignoredSeq: session.ignoredSeq,
  });

  const startSession = (message: SessiondRequest & { op: "start" }): SessiondReply => {
    const existing = sessions.get(message.sessionId);
    if (existing?.running) {
      return { id: message.id, ok: false, error: "already running" };
    }
    let child: ChildProcessLike;
    try {
      child = spawnChild(message.command, message.args, { cwd: message.cwd, env: process.env });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`启动会话 ${message.sessionId} 失败：${detail}`);
      return { id: message.id, ok: false, error: detail };
    }
    const session: SessionState = {
      sessionId: message.sessionId,
      child,
      args: [...message.args],
      pid: child.pid ?? null,
      running: true,
      lastSeq: 0,
      ignoredSeq: existing?.ignoredSeq ?? 0,
      backlog: [],
      backlogChars: 0,
      gap: false,
      killTimer: null,
    };
    sessions.set(message.sessionId, session);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      touch();
      const data = chunk.toString();
      // 只有 stdout 带 seq 并进 backlog，协议里 stderr 事件没有序号字段。
      const seq = session.lastSeq + 1;
      session.lastSeq = seq;
      session.backlog.push({ seq, data });
      session.backlogChars += data.length;
      trimBacklog(session);
      broadcast({ op: "stdout", sessionId: session.sessionId, seq, data });
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      touch();
      broadcast({ op: "stderr", sessionId: session.sessionId, data: chunk.toString() });
    });

    child.on("exit", (code, signal) => {
      touch();
      session.running = false;
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      broadcast({ op: "exit", sessionId: session.sessionId, code, signal });
    });

    child.on("error", (error: Error) => {
      touch();
      session.running = false;
      const code = (error as NodeJS.ErrnoException).code;
      log(`会话 ${session.sessionId} 出错：${error.message}`);
      broadcast({
        op: "error",
        sessionId: session.sessionId,
        code: typeof code === "string" ? code : "error",
        message: error.message,
      });
    });

    return { id: message.id, ok: true, result: { pid: session.pid } };
  };

  const killSession = (message: SessiondRequest & { op: "kill" }): SessiondReply => {
    const session = sessions.get(message.sessionId);
    if (!session) return { id: message.id, ok: false, error: "not found" };
    if (session.running) {
      // 杀整组：pi 的 workflow 会再 spawn 子进程，只杀直接子进程会留下孙进程。
      killProcess(session.child, "SIGTERM");
      if (!session.killTimer) {
        // 2 秒内没退出就 SIGKILL，定时器不阻塞进程退出。
        session.killTimer = setTimeout(() => {
          session.killTimer = null;
          killProcess(session.child, "SIGKILL");
        }, KILL_GRACE_MS);
        session.killTimer.unref();
      }
    }
    return { id: message.id, ok: true };
  };

  const handleRequest = (message: SessiondRequest): SessiondReply | null => {
    switch (message.op) {
      case "hello":
        if (message.version !== SESSIOND_VERSION) {
          return { id: message.id, ok: false, error: "version" };
        }
        return { id: message.id, ok: true, result: { version: SESSIOND_VERSION } };
      case "start":
        return startSession(message);
      case "attach": {
        const session = sessions.get(message.sessionId);
        if (!session) return { id: message.id, ok: false, error: "not found" };
        return { id: message.id, ok: true, result: attachResult(session, message.ack) };
      }
      case "list":
        return {
          id: message.id,
          ok: true,
          result: [...sessions.values()].map(sessionInfo),
        };
      case "kill":
        return killSession(message);
      case "stdin": {
        const session = sessions.get(message.sessionId);
        if (!session || !session.running) return null;
        try {
          session.child.stdin?.write(message.data);
        } catch (error) {
          log(`写入 ${message.sessionId} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }
      case "end": {
        const session = sessions.get(message.sessionId);
        if (!session) return null;
        try {
          session.child.stdin?.end();
        } catch (error) {
          log(`关闭 ${message.sessionId} 输入失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }
      case "ack": {
        const session = sessions.get(message.sessionId);
        if (session) ackSession(session, message.seq);
        return null;
      }
      case "shutdown": {
        // Bridge 升级后要换掉协议不一致的实例：先让回执写完，再按 close() 收掉子进程并退出。
        setTimeout(shutdownNow, 20);
        return null;
      }
      default:
        return null;
    }
  };

  const handleLine = (socket: Socket, line: string): void => {
    touch();
    const text = line.trim();
    if (!text) return;
    let message: SessiondRequest;
    try {
      message = JSON.parse(text) as SessiondRequest;
    } catch {
      log(`忽略无法解析的消息：${text.slice(0, 120)}`);
      return;
    }
    if (!message || typeof message !== "object" || typeof message.op !== "string") {
      log(`忽略缺少 op 的消息：${text.slice(0, 120)}`);
      return;
    }
    // stdin/end/ack 是单向指令，没有 id，也不回执。
    const messageId =
      "id" in message && typeof message.id === "string" ? message.id : null;
    let reply: SessiondReply | null;
    try {
      reply = handleRequest(message);
    } catch (error) {
      log(`处理 ${message.op} 失败：${error instanceof Error ? error.message : String(error)}`);
      reply = { id: messageId ?? "", ok: false, error: "internal" };
    }
    if (reply && messageId !== null) send(socket, reply);
  };

  const server: Server = createServer((socket) => {
    touch();
    connections.add(socket);
    socket.on("error", (error) => {
      log(`连接出错：${error.message}`);
    });
    socket.on("close", () => {
      connections.delete(socket);
      touch();
      // 断开连接不杀子进程：Bridge 重启后还要靠 attach 继续接上。
    });
    const reader = createInterface({ input: socket });
    reader.on("line", (line) => handleLine(socket, line));
    reader.on("close", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    log(`设置 socket 权限失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const idleTimer = setInterval(() => {
    if (closing) return;
    if (connections.size > 0) return;
    if ([...sessions.values()].some((session) => session.running)) return;
    if (Date.now() - lastActivity <= SESSIOND_IDLE_MS) return;
    log("没有连接也没有运行中的会话，sessiond 退出");
    void close().finally(() => process.exit(0));
  }, IDLE_CHECK_MS);

  let closingPromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    clearInterval(idleTimer);
    closingPromise = new Promise<void>((resolve) => {
      // 退出前先让子进程收到 SIGTERM；仍在跑的两秒后强杀由各自的定时器负责。
      for (const session of sessions.values()) {
        if (!session.running) continue;
        killProcess(session.child, "SIGTERM");
      }
      for (const socket of connections) socket.destroy();
      connections.clear();
      server.close(() => resolve());
      if (!server.listening) resolve();
      try {
        unlinkSync(socketPath);
      } catch {
        // 文件可能已经被删掉了。
      }
    });
    return closingPromise;
  };

  shutdownNow = (): void => {
    void close().finally(() => process.exit(0));
  };

  return { socketPath, close };
}
