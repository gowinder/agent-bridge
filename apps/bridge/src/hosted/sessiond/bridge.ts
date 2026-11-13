import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostedChild } from "../manager.js";
import { killProcess } from "../process-group.js";
import { SESSIOND_VERSION_ERROR, SessiondClient } from "./client.js";
import {
  SESSIOND_SOCKET,
  type SessiondAttachResult,
  type SessiondEvent,
  type SessiondSessionInfo,
} from "./protocol.js";

const CONNECT_TIMEOUT_MS = 1_000;
const SPAWN_TIMEOUT_MS = 5_000;
/** bundled 的 socket 一开始可能连不上，轮询比一次长时间等待更容易成功。 */
const SPAWN_POLL_MS = 100;
/** 杀会话后等它退出：守护进程 SIGTERM 后 2s 补 SIGKILL，这里留够余量。 */
const KILL_WAIT_MS = 100;
const KILL_WAIT_TRIES = 30;
/** 旧守护进程收到 shutdown 后要收尾子进程，最多等这么久让 socket 消失。 */
const SHUTDOWN_WAIT_MS = 2_000;
const SHUTDOWN_POLL_MS = 50;

export type SessiondFallbackSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; sessionId: string; env?: Record<string, string> },
) => HostedChild;

export interface SessiondBridgeOptions {
  log?: (line: string) => void;
  /** sessiond 起不来时退回本机 spawn：托管会话不能因为守护进程不可用就整体停摆。 */
  fallback?: SessiondFallbackSpawn;
}

export interface HostedCommandOptions {
  cwd: string;
  sessionId: string;
  /** 已经处理到的输出序号：接回已在跑的进程时用它补齐断线期间的输出。 */
  ack?: number;
  /** 启动时额外带的环境变量（守护进程按自己的环境合并）。 */
  env?: Record<string, string>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 决定「这个进程到底跑的是什么」的旗标：只要对不上，接回就等于用错模型。 */
const LAUNCH_FLAGS = ["--model", "--provider", "--effort", "--permission-mode"];

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function launchFlagsDiffer(running: readonly string[], wanted: readonly string[]): boolean {
  return LAUNCH_FLAGS.some((flag) => flagValue(running, flag) !== flagValue(wanted, flag));
}

/** 守护进程退出时会删掉 socket 文件，用它判断旧实例是否收摊完毕。 */
function socketGone(socketPath: string): boolean {
  try {
    lstatSync(socketPath);
    return false;
  } catch {
    return true;
  }
}

/** 编译后本文件在 dist/hosted/sessiond/，Bridge 入口是 dist/main.js。 */
function mainJsPath(): string {
  return fileURLToPath(new URL("../../main.js", import.meta.url));
}

/**
 * Bridge 侧看到的托管子进程。stdout 走 EventEmitter 而不是真 stream，
 * 额外把 sessiond 的 seq 作为第二个参数带给 manager，用来确认输出与重连补齐。
 */
export class RemoteChild extends EventEmitter implements HostedChild {
  private readonly out = new EventEmitter();
  private readonly err = new EventEmitter();
  readonly stdout = this.out as unknown as NodeJS.ReadableStream;
  readonly stderr = this.err as unknown as NodeJS.ReadableStream;
  readonly stdin: { write(chunk: string): boolean; end(): void };

  private client: SessiondClient | null = null;
  private local: HostedChild | null = null;
  private pidValue: number | undefined;
  private ack = 0;
  private ready = false;
  private closed = false;
  /** attach/start 回执到达前先接住事件，保证 backlog 先于断线后的实时输出。 */
  private holding = true;
  private held: SessiondEvent[] = [];
  private queuedWrites: string[] = [];
  private inputEnded = false;
  private killPending = false;
  private killSignal: NodeJS.Signals = "SIGTERM";
  /** 主动杀掉旧进程、准备按新参数重启时预期的退出事件数。 */
  private expectedExits = 0;

  constructor(
    private readonly bridge: SessiondBridge,
    private readonly sessionId: string,
  ) {
    super();
    this.stdin = {
      write: (chunk: string): boolean => {
        this.write(chunk);
        return true;
      },
      end: () => this.endInput(),
    };
  }

  get pid(): number | undefined {
    return this.pidValue;
  }

  /** sessiond 里真正拉起子进程；ensure 失败时改在本机 spawn，保住托管能力。 */
  async start(command: string, args: string[], options: HostedCommandOptions): Promise<void> {
    let client: SessiondClient;
    try {
      client = await this.bridge.ensure();
    } catch (error) {
      this.bridge.report(`sessiond 不可用，改在本机启动：${messageOf(error)}`);
      this.startLocal(command, args, options);
      return;
    }
    if (this.closed) return;
    this.client = client;
    this.ack = options.ack ?? 0;
    await this.launch(client, command, args, options, true);
  }

  /** 发一次 start；守护进程里已有同 id 进程时交给 attachRunning 决定接回还是重启。 */
  private async launch(
    client: SessiondClient,
    command: string,
    args: string[],
    options: HostedCommandOptions,
    retry: boolean,
  ): Promise<void> {
    try {
      const reply = await client.request<{ pid?: number | null }>({
        op: "start",
        sessionId: this.sessionId,
        command,
        args,
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
      });
      if (this.closed) return;
      this.pidValue = typeof reply?.pid === "number" ? reply.pid : undefined;
      this.ready = true;
      this.flushReady();
      this.release();
    } catch (error) {
      // 守护进程里这个会话还在跑（上一代 Bridge 留下的、或并发启动）：start 起不来。
      if (messageOf(error) !== "already running") {
        this.fail(error);
        return;
      }
      let outcome: "adopted" | "restart" | "failed";
      try {
        outcome = await this.attachRunning(client, args);
      } catch (attachError) {
        this.fail(attachError);
        return;
      }
      if (outcome !== "restart" || this.closed) return;
      if (!retry) {
        this.fail(new Error("会话已在守护进程里运行，旧进程停不掉"));
        return;
      }
      await this.launch(client, command, args, options, false);
    }
  }

  /**
   * 守护进程里已经在跑同一个会话：参数一致就接回（补 backlog、放行排队输入），
   * 参数不一致说明换过模型而旧进程没停掉，先杀掉再让上层按新参数重起。
   */
  private async attachRunning(
    client: SessiondClient,
    args: string[],
  ): Promise<"adopted" | "restart" | "failed"> {
    const result = await client.request<SessiondAttachResult>({
      op: "attach",
      sessionId: this.sessionId,
      ack: this.ack,
    });
    if (this.closed) return "failed";
    // 刚好在这一刻退出了：直接重起。
    if (!result.running) return "restart";
    if (result.args && launchFlagsDiffer(result.args, args)) {
      // 不杀的话这条消息会落到旧模型上，报 403 却看不出是没切换过去。
      this.bridge.report(`会话 ${this.sessionId} 仍按旧参数在跑，停掉后按新参数重启`);
      // 这次退出是我们要的，别让 manager 收尾成「托管进程已结束」。
      this.expectedExits += 1;
      // 旧进程的残留输出丢掉，重启期间的输入先排队，等新进程起来再发。
      this.held = [];
      this.ready = false;
      let killed: boolean;
      try {
        killed = await this.bridge.killSession(this.sessionId);
      } catch (error) {
        this.expectedExits = 0;
        throw error;
      }
      if (!killed) {
        this.expectedExits = 0;
        this.fail(new Error("旧进程停不掉，换的模型没有生效"));
        return "failed";
      }
      return "restart";
    }
    this.pidValue = result.pid ?? undefined;
    this.ready = true;
    this.bridge.report(`会话 ${this.sessionId} 已在守护进程里运行，改为接回`);
    for (const chunk of result.backlog) this.out.emit("data", chunk.data, chunk.seq);
    this.flushReady();
    this.release();
    return "adopted";
  }

  /** attach 回来的进程：pid 已知，但 backlog 仍由 manager 先喂进解析流程。 */
  attached(client: SessiondClient, pid: number | undefined): void {
    // 不绑客户端的话，接回来的进程 stdin 与 kill 都发不出去：发消息丢、换模型停不掉。
    this.client = client;
    this.pidValue = pid;
    this.ready = true;
  }

  /** backlog 喂完后再放行持有的事件，顺序才不会乱。 */
  release(): void {
    this.holding = false;
    // 接回期间排队的输入（以及可能的 kill）也要补发，否则第一条消息会静默丢掉。
    this.flushReady();
    const events = this.held.splice(0);
    for (const event of events) this.applyEvent(event);
  }

  /** 同一 sessionId 换新监听者时解绑，迟到的广播不再影响旧会话。 */
  detach(): void {
    this.closed = true;
    this.held = [];
    this.queuedWrites = [];
  }

  deliver(event: SessiondEvent): void {
    if (this.closed) return;
    if (this.holding || !this.ready) {
      this.held.push(event);
      return;
    }
    this.applyEvent(event);
  }

  /** 换参数重启时旧进程的 exit 会被吞掉，这条不能当成「会话结束」处理。 */
  get closedNow(): boolean {
    return this.closed;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.closed) return false;
    this.killPending = true;
    this.killSignal = signal ?? "SIGTERM";
    if (!this.ready) return true;
    this.sendKill();
    return true;
  }

  private applyEvent(event: SessiondEvent): void {
    if (this.closed) return;
    switch (event.op) {
      case "stdout":
        // seq 作为第二个参数交给 manager，用来推进 ack 与断线补齐。
        this.out.emit("data", event.data, event.seq);
        return;
      case "stderr":
        this.err.emit("data", event.data);
        return;
      case "exit":
        // 换参数重启时自己杀掉的进程：退出是预期内的，照旧跟踪同一个会话。
        if (this.expectedExits > 0) {
          this.expectedExits -= 1;
          return;
        }
        this.closed = true;
        this.emit("exit", event.code, event.signal);
        return;
      case "error":
        this.closed = true;
        this.emit("error", Object.assign(new Error(event.message), { code: event.code }));
    }
  }

  private write(chunk: string): void {
    if (this.closed) return;
    if (!this.ready) {
      this.queuedWrites.push(chunk);
      return;
    }
    if (this.local) {
      this.local.stdin?.write(chunk);
      return;
    }
    this.client?.send({ op: "stdin", sessionId: this.sessionId, data: chunk });
  }

  private endInput(): void {
    if (this.closed) return;
    this.inputEnded = true;
    if (!this.ready) return;
    if (this.local) this.local.stdin?.end();
    else this.client?.send({ op: "end", sessionId: this.sessionId });
  }

  private sendKill(): void {
    if (this.local) {
      // 本机回退起的子进程自成一组，杀整组才能连孙进程一起收掉。
      killProcess(this.local, this.killSignal);
      return;
    }
    this.client?.send({ op: "kill", sessionId: this.sessionId });
  }

  /** start 之前排队的 stdin/kill/end 在进程就绪后按序补发。 */
  private flushReady(): void {
    for (const chunk of this.queuedWrites.splice(0)) {
      if (this.local) this.local.stdin?.write(chunk);
      else this.client?.send({ op: "stdin", sessionId: this.sessionId, data: chunk });
    }
    if (this.killPending) {
      this.killPending = false;
      this.sendKill();
    }
    if (this.inputEnded) {
      if (this.local) this.local.stdin?.end();
      else this.client?.send({ op: "end", sessionId: this.sessionId });
    }
  }

  private startLocal(command: string, args: string[], options: HostedCommandOptions): void {
    if (this.closed) return;
    const spawnLocal = this.bridge.fallbackSpawn;
    if (!spawnLocal) {
      this.fail(new Error("sessiond 不可用，且没有配置本机回退"));
      return;
    }
    let child: HostedChild;
    try {
      child = spawnLocal(command, args, options);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.local = child;
    this.pidValue = child.pid;
    this.ready = true;
    child.stdout?.on("data", (chunk: string | Buffer) => this.out.emit("data", String(chunk)));
    child.stderr?.on("data", (chunk: string | Buffer) => this.err.emit("data", String(chunk)));
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.emit("exit", code, signal);
    });
    child.on("error", (error) => {
      if (this.closed) return;
      this.closed = true;
      this.emit("error", error);
    });
    this.flushReady();
    this.release();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    this.emit(
      "error",
      Object.assign(new Error(messageOf(error)), { code: typeof code === "string" ? code : "sessiond" }),
    );
  }
}

/**
 * 管理 sessiond 连接：连不上就 detached 拉起一份守护进程，并把事件分给各会话。
 * 守护进程持有 Claude Code 的 stdio，Bridge 只剩一条 socket，重启不会带走子进程。
 */
export class SessiondBridge {
  readonly socketPath: string;
  private readonly stateDir: string;
  private readonly log: (line: string) => void;
  private readonly fallback: SessiondFallbackSpawn | undefined;
  private readonly children = new Map<string, RemoteChild>();
  private client: SessiondClient | null = null;
  private connecting: Promise<SessiondClient> | null = null;
  private disposed = false;

  constructor(stateDir: string, options: SessiondBridgeOptions = {}) {
    this.stateDir = stateDir;
    this.log = options.log ?? (() => undefined);
    this.fallback = options.fallback;
    this.socketPath = join(stateDir, "hosted", SESSIOND_SOCKET);
  }

  get fallbackSpawn(): SessiondFallbackSpawn | undefined {
    return this.fallback;
  }

  report(line: string): void {
    this.log(line);
  }

  ensure(): Promise<SessiondClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = this.launch().then(
        (client) => {
          this.connecting = null;
          // 连接期间 Bridge 已经退出：别把 socket 留成孤儿。
          if (this.disposed) {
            client.close();
            throw new Error("sessiond 客户端已关闭");
          }
          this.client = client;
          return client;
        },
        (error) => {
          this.connecting = null;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  /** 同步返回 RemoteChild，start 在后台完成；同一会话只保留最新的监听者。 */
  spawnChild(command: string, args: string[], options: HostedCommandOptions): HostedChild {
    const child = new RemoteChild(this, options.sessionId);
    this.children.get(options.sessionId)?.detach();
    this.children.set(options.sessionId, child);
    void child.start(command, args, options);
    return child;
  }

  async list(): Promise<SessiondSessionInfo[]> {
    const client = await this.ensure();
    return client.request<SessiondSessionInfo[]>({ op: "list" });
  }

  async attach(sessionId: string, ack: number): Promise<SessiondAttachResult> {
    const client = await this.ensure();
    // 先登记再请求：backlog 之后的实时输出会立刻进来，必须先接住。
    const child = new RemoteChild(this, sessionId);
    this.children.get(sessionId)?.detach();
    this.children.set(sessionId, child);
    try {
      const result = await client.request<SessiondAttachResult>({ op: "attach", sessionId, ack });
      if (result.running) child.attached(client, result.pid ?? undefined);
      else this.dropChild(sessionId, child);
      return result;
    } catch (error) {
      this.dropChild(sessionId, child);
      throw error;
    }
  }

  remoteChild(sessionId: string): RemoteChild | null {
    return this.children.get(sessionId) ?? null;
  }

  /**
   * 让守护进程杀掉某个会话的进程，并等它真的退出。
   * Bridge 的 live 表里没有它（上一代 Bridge 留下的孤儿进程）时，只有这条路能停掉。
   */
  async killSession(sessionId: string): Promise<boolean> {
    const client = await this.ensure();
    const stillRunning = async (): Promise<boolean> => {
      const infos = await client.request<SessiondSessionInfo[]>({ op: "list" });
      return infos.some((info) => info.sessionId === sessionId && info.running);
    };
    if (!(await stillRunning())) return false;
    // 不摘监听者：进程退出时 manager 还要靠 exit 事件收尾，守护进程广播后自己会摘掉。
    client.send({ op: "kill", sessionId });
    // 等退出：紧接着的 start 才不会又撞上 already running（守护进程 2s 后补 SIGKILL）。
    for (let attempt = 0; attempt < KILL_WAIT_TRIES; attempt += 1) {
      await delay(KILL_WAIT_MS);
      if (!(await stillRunning())) return true;
    }
    // 没杀掉就如实说：调用方以为停了，下一次发消息会接回旧进程、旧模型。
    throw new Error("会话进程没有在超时内退出");
  }

  /** 告诉守护进程这段输出已经处理，断线时不必再回放。 */
  ack(sessionId: string, seq: number): void {
    this.client?.send({ op: "ack", sessionId, seq });
  }

  close(): void {
    this.disposed = true;
    this.client?.close();
    this.client = null;
    for (const child of this.children.values()) child.detach();
    this.children.clear();
  }

  private dropChild(sessionId: string, child: RemoteChild): void {
    if (this.children.get(sessionId) === child) this.children.delete(sessionId);
    child.detach();
  }

  private dispatch(event: SessiondEvent): void {
    const child = this.children.get(event.sessionId);
    if (!child) return;
    child.deliver(event);
    if (
      (event.op === "exit" || event.op === "error") &&
      child.closedNow &&
      this.children.get(event.sessionId) === child
    ) {
      // 进程已经结束：从分发表里摘掉，下一次 spawn 会登记新监听者。
      this.children.delete(event.sessionId);
    }
  }

  private async launch(): Promise<SessiondClient> {
    if (this.disposed) throw new Error("sessiond 客户端已关闭");
    try {
      return await this.connect(CONNECT_TIMEOUT_MS);
    } catch (error) {
      if (messageOf(error) !== SESSIOND_VERSION_ERROR) {
        // 没有实例在监听：下面自己拉起一份守护进程。
      } else {
        // 旧实例协议不认识：只能让它收摊（其子进程会一起结束），再起新的。
        this.log("sessiond 版本不一致，已重启守护进程（会话会随旧实例结束）");
        await this.shutdownOld();
      }
    }
    if (this.disposed) throw new Error("sessiond 客户端已关闭");
    mkdirSync(join(this.stateDir, "hosted"), { recursive: true, mode: 0o700 });
    const logPath = join(this.stateDir, "hosted", "sessiond.log");
    const fd = openSync(logPath, "a", 0o600);
    try {
      const child = nodeSpawn(process.execPath, [mainJsPath(), "serve-sessiond"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        // 守护进程必须和 Bridge 用同一个状态目录，socket 才会落到同一个位置。
        env: { ...process.env, AGENT_BRIDGE_HOME: this.stateDir },
      });
      child.unref();
      this.log(`sessiond: 已拉起守护进程 ${mainJsPath()} serve-sessiond`);
    } finally {
      // 子进程已经复制了 fd，父进程这边可以关掉。
      closeSync(fd);
    }
    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(SPAWN_POLL_MS);
      try {
        return await this.connect(CONNECT_TIMEOUT_MS);
      } catch (error) {
        if (messageOf(error) === SESSIOND_VERSION_ERROR) {
          throw new Error(`sessiond 版本不一致，旧实例仍未退出：${this.socketPath}`);
        }
        // 还没开始监听，继续轮询。
      }
    }
    throw new Error(`sessiond 启动超时：${this.socketPath}`);
  }

  /** 让协议版本不一致的旧守护进程 shutdown，并等它把 socket 文件删掉。 */
  private async shutdownOld(): Promise<void> {
    try {
      const client = await SessiondClient.connect(this.socketPath, CONNECT_TIMEOUT_MS, { hello: false });
      client.send({ op: "shutdown" });
      // 先把这一行写出去再销毁连接，否则 shutdown 可能留在缓冲里。
      await delay(SHUTDOWN_POLL_MS);
      client.close();
    } catch {
      // 连接已经不通：直接等 socket 文件消失。
    }
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (Date.now() < deadline) {
      if (socketGone(this.socketPath)) return;
      await delay(SHUTDOWN_POLL_MS);
    }
    this.log(`sessiond: 旧实例没有在 2 秒内退出：${this.socketPath}`);
  }

  private async connect(timeoutMs: number): Promise<SessiondClient> {
    const client = await SessiondClient.connect(this.socketPath, timeoutMs);
    client.onEvent((event) => this.dispatch(event));
    client.onClose(() => {
      if (this.client === client) this.client = null;
    });
    return client;
  }
}
