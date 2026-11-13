import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  ContextUsage,
  HostedCreateParams,
  HostedDirInfo,
  HostedDirsResult,
  HostedInterruptResult,
  HostedOptionsResult,
  HostedPermissionMode,
  HostedStopResult,
  MessageBlock,
  MessageListResult,
  MessageQuestion,
  MessageRecord,
  MessageSendResult,
  ProjectInfo,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText } from "../adapters/types.js";
import { contextUsageFromUsage, sanitizeContextUsage } from "../context-usage.js";
import { effortLevels } from "../effort.js";
import { modelCatalog } from "../model-catalog.js";
import { defaultStateDir } from "../store.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 60_000;
const MAX_BLOCK_CHARS = 4_000;
export const MAX_TITLE_CHARS = 60;
const KILL_GRACE_MS = 2_000;
/** CLI 模型名允许的字符集：普通标识符 + 完整 ID 里的括号/点/冒号，且不能以 `-` 开头。 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

export const HOSTED_PERMISSION_MODES: HostedPermissionMode[] = [
  "manual",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
];

/**
 * 托管会话允许远程指定的权限模式。auto 由分类器逐动作审查；
 * bypassPermissions 属于高危模式（仍受 sandbox 与 deny 规则约束），
 * 默认不开放，只有 hosted.json 里显式打开 allowBypassPermissions 才进入白名单。
 */
const BASE_REMOTE_MODES: HostedPermissionMode[] = [
  "manual",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
];

export function remoteHostedModes(allowBypassPermissions: boolean): HostedPermissionMode[] {
  return allowBypassPermissions
    ? [...BASE_REMOTE_MODES]
    : BASE_REMOTE_MODES.filter((mode) => mode !== "bypassPermissions");
}

export interface HostedConfig {
  /** Directories allowed to host sessions. Absolute paths after `~` expansion. */
  dirs: string[];
  idleTimeoutMs: number;
  /** 是否允许托管会话使用 bypassPermissions；默认 false。 */
  allowBypassPermissions: boolean;
  /** Override the CLI binary; defaults to `claude` on PATH. */
  cliPath?: string;
}

interface HostedRecord {
  id: string;
  cwd: string;
  title: string;
  permissionMode: HostedPermissionMode;
  /** CLI `--model` value; undefined keeps the CLI default. */
  model?: string;
  /** CLI `--effort` level; undefined keeps the CLI default. */
  effort?: string;
  /** 由 CLI 的 init 事件报告的实际模型，用来核对是否按预期生效。 */
  observedModel?: string;
  /** 最近一次 assistant 事件的 usage，用来在侧栏显示上下文占用。 */
  context?: ContextUsage;
  /** CLI init 事件报告的斜杠命令与技能，网页输入「/」时用来提示。 */
  slashCommands?: string[];
  /** 最近一轮被「停止」中断：下一次发送用户消息前一直成立，网页重开也能显示「已中断」。 */
  interrupted?: boolean;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  questions?: MessageQuestion[];
}

interface LiveProcess {
  child: HostedChild;
  buffer: string;
  busy: boolean;
  pending: PendingPermission | null;
  startedAt: number;
  /** 最后一条 stderr，进程非零退出时拼进系统消息，避免只剩一个光秃秃的退出码。 */
  stderrTail: string;
  /** 最后一次启动是否为 --resume，用来识别「会话记录不存在」并自动改走新建。 */
  resumed: boolean;
  /** 主动停止（按钮或空闲超时）时先置位；退出事件据此照常提示「已结束」。 */
  killed?: boolean;
  /** 退出事件已经处理过，迟到或重复的 error/exit 不再写第二条系统消息。 */
  finished?: boolean;
}

export interface HostedChild {
  stdin: { write(chunk: string): boolean; end(): void } | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  /** 二进制不存在时 Node 异步抛 ENOENT；没有监听会直接崩掉 Bridge。 */
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}

export type HostedSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => HostedChild;

export interface HostedManagerOptions {
  /** Defaults to `AGENT_BRIDGE_HOME` or the app-support dir, same as the store. */
  stateDir?: string;
  spawn?: HostedSpawn;
  log?: (line: string) => void;
}

/**
 * Owns Claude Code processes that Bridge itself starts (`-p` + stream-json).
 *
 * Only the authenticated device channel (`DeviceSession.dispatch`) may call
 * into this manager: text that reaches it is a real stdin user turn, never a
 * peer envelope and never text forwarded from another local agent session.
 * Nothing here reads or writes desktop transcripts or `/tmp/cc-socks`.
 */
export class HostedSessionManager {
  private readonly stateDir: string;
  private readonly spawnFn: HostedSpawn;
  private readonly log: (line: string) => void;
  private config: HostedConfig;
  private readonly records = new Map<string, HostedRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly live = new Map<string, LiveProcess>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly exitHandler = (): void => this.stopAll();

  constructor(options: HostedManagerOptions = {}) {
    this.stateDir = options.stateDir ?? defaultStateDir();
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as HostedSpawn);
    this.log = options.log ?? (() => undefined);
    this.config = readConfig(this.stateDir);
    this.loadRecords();
    this.sweeper = setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS);
    this.sweeper.unref();
    process.once("exit", this.exitHandler);
  }

  configForClient(): HostedDirsResult {
    const dirs: HostedDirInfo[] = [];
    const seen = new Set<string>();
    for (const raw of this.config.dirs) {
      const path = expandHome(raw);
      const exists = isDirectory(path);
      dirs.push({
        path,
        name: basename(path) || path,
        sessionCount: [...this.records.values()].filter((record) => record.cwd === path).length,
        exists,
      });
      seen.add(path);
    }
    for (const record of this.records.values()) {
      if (seen.has(record.cwd)) continue;
      // Keep sessions whose directory left the allowlist visible, but not creatable.
      dirs.push({
        path: record.cwd,
        name: basename(record.cwd) || record.cwd,
        sessionCount: [...this.records.values()].filter((item) => item.cwd === record.cwd).length,
        exists: false,
      });
      seen.add(record.cwd);
    }
    const result: HostedDirsResult = {
      enabled: this.config.dirs.length > 0,
      dirs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      permissionModes: this.remotePermissionModes(),
      allowBypassPermissions: this.config.allowBypassPermissions,
    };
    if (!result.enabled) {
      result.note = `尚未配置可托管的目录：编辑 ${join(this.stateDir, "hosted.json")} 的 dirs 后重启 Bridge`;
    }
    return result;
  }

  /** 把目录加进托管白名单：只收已存在的绝对路径，重复添加是幂等的。 */
  addDir(input: string): HostedDirsResult {
    const target = this.normalizeDir(input);
    if (!isDirectory(target)) throw new RpcError("invalid_params", `目录不存在：${target}`);
    const known = this.config.dirs.map((dir) => canonical(expandHome(dir)) ?? resolve(expandHome(dir)));
    if (!known.includes(target)) {
      this.config = { ...this.config, dirs: [...this.config.dirs, target] };
      this.writeConfig();
      this.log(`hosted: 允许托管目录 ${target}`);
    }
    return this.configForClient();
  }

  /** 移出白名单：已有会话保留，只是不能再从这里新建。目录已被删掉时也允许移除。 */
  removeDir(input: string): HostedDirsResult {
    const target = this.normalizeDir(input);
    const dirs = this.config.dirs.filter(
      (dir) => (canonical(expandHome(dir)) ?? resolve(expandHome(dir))) !== target,
    );
    if (dirs.length !== this.config.dirs.length) {
      this.config = { ...this.config, dirs };
      this.writeConfig();
      this.log(`hosted: 移除托管目录 ${target}`);
    }
    return this.configForClient();
  }

  /** 统一成绝对路径（~ 展开、存在的路径取 realpath）；不检查目录是否存在。 */
  private normalizeDir(input: string): string {
    const raw = input.trim();
    if (!raw) throw new RpcError("invalid_params", "目录不能为空");
    if (!raw.startsWith("~") && !isAbsolute(raw)) {
      throw new RpcError("invalid_params", `需要绝对路径：${raw}`);
    }
    return canonical(expandHome(raw)) ?? resolve(expandHome(raw));
  }

  /** 写回 hosted.json：保留其它设置，权限按状态目录的惯例收紧到 0600。 */
  private writeConfig(): void {
    const path = join(this.stateDir, "hosted.json");
    const payload = {
      dirs: this.config.dirs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      allowBypassPermissions: this.config.allowBypassPermissions,
      ...(this.config.cliPath ? { cliPath: this.config.cliPath } : {}),
    };
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (cause) {
      throw new RpcError(
        "internal",
        `写入 ${path} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  projects(): ProjectInfo[] {
    const counts = new Map<string, number>();
    for (const record of this.records.values()) {
      counts.set(record.cwd, (counts.get(record.cwd) ?? 0) + 1);
    }
    const projects: ProjectInfo[] = [];
    const seen = new Set<string>();
    const push = (cwd: string): void => {
      if (seen.has(cwd)) return;
      seen.add(cwd);
      projects.push({
        projectId: projectIdFor(cwd),
        appId: "hosted",
        name: basename(cwd) || cwd,
        cwd,
        sessionCount: counts.get(cwd) ?? 0,
      });
    };
    for (const raw of this.config.dirs) {
      const path = expandHome(raw);
      if (isDirectory(path)) push(path);
    }
    for (const record of this.records.values()) push(record.cwd);
    return projects;
  }

  /** 当前配置允许远程指定的权限模式；hosted.create 与网页下拉都以此为准。 */
  remotePermissionModes(): HostedPermissionMode[] {
    return remoteHostedModes(this.config.allowBypassPermissions);
  }

  sessions(): SessionSummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => this.summary(record));
  }

  session(sessionId: string): SessionSummary | null {
    const record = this.record(sessionId);
    return record ? this.summary(record) : null;
  }

  messagesFor(sessionId: string, page: MessagePage): MessageListResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const all = this.messagesOf(record.id);
    let end = all.length;
    if (page.before) {
      const index = all.findIndex((message) => message.messageId === page.before);
      if (index >= 0) end = index;
    }
    const start = Math.max(0, end - page.limit);
    const pageMessages = all.slice(start, end);
    const live = this.live.get(record.id);
    const result: MessageListResult = {
      messages: pageMessages,
      completeness: "complete",
      busy: live?.busy ?? false,
      ...(record.interrupted ? { interrupted: true } : {}),
      ...(record.context ? { context: record.context } : {}),
      ...(record.slashCommands ? { slashCommands: record.slashCommands } : {}),
    };
    const first = pageMessages[0];
    if (start > 0 && first) result.nextBefore = first.messageId;
    if (!live) {
      result.note = "Bridge 当前没有运行这个会话的进程；发送消息时会自动 resume。";
    }
    return result;
  }

  messageText(sessionId: string, messageId: string): MessageText | null {
    const record = this.record(sessionId);
    if (!record) return null;
    const message = this.messagesOf(record.id).find((item) => item.messageId === messageId);
    if (!message) return null;
    const text = message.blocks
      .filter((block) => block.type === "text" || block.type === "ask" || block.type === "next-step")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (!text) return null;
    return { messageId: message.messageId, role: message.role, createdAt: message.createdAt, text };
  }

  rail(sessionId: string): SessionRailResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const live = this.live.get(record.id);
    return {
      environment: [
        { label: "工作目录", value: record.cwd },
        { label: "权限模式", value: record.permissionMode },
        { label: "模型", value: modelLabel(record) },
        { label: "思考程度", value: record.effort ?? "CLI 默认" },
        {
          label: "进程",
          value: live ? `运行中（pid ${live.child.pid ?? "?"}）` : "未运行（发送时 resume）",
        },
        { label: "空闲超时", value: `${Math.round(this.config.idleTimeoutMs / 60_000)} 分钟` },
      ],
      servers: [],
      tasks: [],
      ...(record.context ? { context: record.context } : {}),
      note: "This session is hosted by Bridge, not by the Claude desktop app.",
    };
  }

  create(params: HostedCreateParams): SessionSummary {
    const cwd = this.allowedPath(params.path);
    const permissionMode = this.permissionMode(params.permissionMode);
    this.assertModeAllowed(permissionMode);
    const model = this.model(params.model);
    const effort = this.effort(params.effort);
    const now = Date.now();
    const id = randomUUID();
    const record: HostedRecord = {
      id,
      cwd,
      title: params.title?.trim() || "托管会话",
      permissionMode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    };
    try {
      this.start(record, false);
    } catch (error) {
      this.live.delete(id);
      // 权限模式被拒绝这类 RpcError 原样上抛，别改写成「无法启动」。
      if (error instanceof RpcError) throw error;
      throw new RpcError(
        "adapter_unavailable",
        `无法启动 Claude Code：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.records.set(id, record);
    this.persistRecords();
    this.log(`hosted: created ${id} in ${cwd} (${permissionMode})`);
    return this.summary(record);
  }

  /** 改托管会话的标题；空标题视为错误，清除覆盖只针对非托管会话。 */
  rename(sessionId: string, title: string): SessionSummary {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const next = title.trim().slice(0, MAX_TITLE_CHARS);
    if (!next) throw new RpcError("invalid_params", "标题不能为空");
    record.title = next;
    record.updatedAt = Date.now();
    this.persistRecords();
    return this.summary(record);
  }

  resume(sessionId: string): SessionSummary {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (!isDirectory(record.cwd)) {
      throw new RpcError("adapter_unavailable", `工作目录已不存在：${record.cwd}`);
    }
    if (!this.live.has(record.id)) {
      try {
        this.start(record, true);
      } catch (error) {
        this.live.delete(record.id);
        if (error instanceof RpcError) throw error;
        throw new RpcError(
          "adapter_unavailable",
          `无法 resume Claude Code：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      record.lastActiveAt = Date.now();
      this.persistRecords();
    }
    return this.summary(record);
  }

  stop(sessionId: string): HostedStopResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const stopped = this.kill(record.id);
    return { stopped, session: this.summary(record) };
  }

  /** 新建托管会话可选的模型与思考程度，取自本机 CLI。 */
  options(): HostedOptionsResult {
    const models = modelCatalog();
    const result: HostedOptionsResult = {
      models,
      efforts: effortLevels(this.cliBinary()),
    };
    if (models.length === 0) {
      result.note = "读不到模型目录（桌面端与 CLI 都没有缓存），只能使用 CLI 默认模型。";
    }
    return result;
  }

  /**
   * 只停当前回合，进程留着：往 stdin 发 control_request/interrupt，
   * CLI 会中止正在跑的这一轮并照常回到可输入状态。
   */
  interrupt(sessionId: string): HostedInterruptResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const live = this.live.get(record.id);
    if (!live || (!live.busy && !live.pending)) {
      return { interrupted: false, session: this.summary(record) };
    }
    // 停在没有回答的批准请求上时，先拒绝它，否则这一轮还在等输入。
    if (live.pending) {
      this.respondControl(live, live.pending.requestId, {
        behavior: "deny",
        message: "用户停止了当前回合",
      });
      live.pending = null;
    }
    live.child.stdin?.write(
      `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
    );
    live.busy = false;
    record.interrupted = true;
    this.appendRecord(record, {
      messageId: randomUUID(),
      sessionId: record.id,
      role: "system",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: "已停止当前回合" }],
    });
    this.log(`hosted: interrupt ${record.id}`);
    this.touch(record);
    return { interrupted: true, session: this.summary(record) };
  }

  async send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (!text.trim()) throw new RpcError("invalid_params", "消息不能为空");
    if (!isDirectory(record.cwd)) {
      throw new RpcError("adapter_unavailable", `工作目录已不存在：${record.cwd}`);
    }
    if (!this.live.has(record.id)) this.start(record, true);
    const live = this.live.get(record.id);
    if (!live || !live.child.stdin) {
      throw new RpcError("adapter_unavailable", "托管进程不可写");
    }
    // `origin` names the paired device for logs only: hosted stdin carries a real
    // user turn, so the transcript must not gain a peer-style sender label.
    if (origin) this.log(`hosted: send from ${origin}`);
    if (live.pending) {
      const handled = this.answerPermission(record, live, text);
      if (handled) {
        this.recordUser(record, text);
        this.touch(record);
        return { accepted: true, delivered: true, detail: "已答复待批准的操作" };
      }
      // Not an answer to the prompt: deny it and deliver the text as a user turn.
      this.respondControl(live, live.pending.requestId, {
        behavior: "deny",
        message: "用户没有批准这次调用，改为直接回复",
      });
      live.pending = null;
    }
    this.writeUserTurn(live, text);
    this.recordUser(record, text);
    record.interrupted = false;
    live.busy = true;
    this.touch(record);
    return { accepted: true, delivered: true };
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    process.removeListener("exit", this.exitHandler);
    this.stopAll();
  }

  private start(record: HostedRecord, resume: boolean): void {
    // 已有记录可能是在开关打开时建的：关掉开关后不允许再用 bypass 启动。
    this.assertModeAllowed(record.permissionMode);
    const cli = this.cliBinary();
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      record.permissionMode,
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      "stdio",
    ];
    if (resume) args.push("--resume", record.id);
    else args.push("--session-id", record.id);
    // 恢复也要带上同一个模型与思考程度，否则续写会悄悄换回 CLI 默认值。
    if (record.model) args.push("--model", record.model);
    if (record.effort) args.push("--effort", record.effort);
    const child = this.spawnFn(cli, args, { cwd: record.cwd, env: process.env });
    const live: LiveProcess = {
      child,
      buffer: "",
      busy: false,
      pending: null,
      startedAt: Date.now(),
      stderrTail: "",
      resumed: resume,
    };
    this.live.set(record.id, live);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.onStdout(record, live, String(chunk)));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const line = String(chunk).trim();
      if (line) live.stderrTail = line.slice(0, 300);
      if (line && !line.startsWith("[claude-code:")) this.log(`hosted ${record.id} stderr: ${line.slice(0, 300)}`);
    });
    child.on("error", (error) => {
      // 停止后马上发消息会先放入新进程；旧进程迟到的 error/exit 不能把它从跟踪里删掉。
      const current = this.live.get(record.id);
      if (current && current !== live) return;
      if (current === live) this.live.delete(record.id);
      if (live.finished) return;
      live.finished = true;
      const detail =
        error.code === "ENOENT"
          ? `找不到 Claude Code CLI：${cli}。托管会话需要它在 PATH 或 AGENT_BRIDGE_CLAUDE_PATH 中。`
          : `启动 Claude Code 失败：${error.message}`;
      this.log(`hosted ${record.id} spawn error: ${detail}`);
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "system",
        createdAt: Date.now(),
        blocks: [{ type: "text", text: detail }],
      });
      this.touch(record);
    });
    child.on("exit", (code, signal) => {
      const current = this.live.get(record.id);
      if (current && current !== live) return;
      if (current === live) this.live.delete(record.id);
      if (live.finished) return;
      live.finished = true;
      // 会话记录从来没生成过（例如上次 spawn 直接失败）时，--resume 会立刻退出；
      // 这种会话改走 --session-id 新建一次，用户不必手动删掉重来。
      if (!live.killed && !signal && code !== 0 && live.resumed && /no conversation found/i.test(live.stderrTail)) {
        this.log(`hosted ${record.id}: 会话记录不存在，改为新建`);
        try {
          this.start(record, false);
          return;
        } catch (error) {
          this.log(`hosted ${record.id}: 重新启动失败：${String(error)}`);
        }
      }
      const failed = !signal && code !== 0;
      const reason = signal
        ? `信号 ${signal}`
        : `退出码 ${code ?? "?"}${failed && live.stderrTail ? `：${live.stderrTail}` : ""}`;
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "system",
        createdAt: Date.now(),
        blocks: [{ type: "text", text: `托管进程已结束（${reason}）。再发消息会 resume 这个会话。` }],
      });
      this.touch(record);
    });
  }

  private onStdout(record: HostedRecord, live: LiveProcess, chunk: string): void {
    live.buffer += chunk;
    let index = live.buffer.indexOf("\n");
    while (index >= 0) {
      const line = live.buffer.slice(0, index).trim();
      live.buffer = live.buffer.slice(index + 1);
      index = live.buffer.indexOf("\n");
      if (!line) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(payload)) continue;
      this.handleEvent(record, live, payload);
    }
  }

  private handleEvent(record: HostedRecord, live: LiveProcess, event: Record<string, unknown>): void {
    const type = event["type"];
    if (type === "assistant") {
      const message = isRecord(event["message"]) ? event["message"] : {};
      // usage 既描述这次调用的用量，也是下一轮开始时的上下文占用；blocks 为空（例如
      // 全是工具调用）时也要记下来，否则侧栏只在有可见文本时才更新。
      const reported = typeof message["model"] === "string" ? message["model"] : "";
      const context = contextUsageFromUsage(
        message["usage"],
        reported || record.observedModel || record.model || "",
      );
      if (context) record.context = context;
      const blocks = blocksFromContent(message["content"]);
      if (blocks.length === 0) {
        if (context) this.touch(record);
        return;
      }
      if (record.title === "托管会话") {
        const textBlock = blocks.find((block) => block.type === "text" && block.text.trim());
        if (textBlock) record.title = truncateTitle(textBlock.text);
      }
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "assistant",
        createdAt: Date.now(),
        blocks,
      });
      this.touch(record);
      return;
    }
    if (type === "control_request") {
      const request = isRecord(event["request"]) ? event["request"] : {};
      if (request["subtype"] !== "can_use_tool") return;
      const requestId = typeof event["request_id"] === "string" ? event["request_id"] : "";
      const toolName = typeof request["tool_name"] === "string" ? request["tool_name"] : "tool";
      const input = isRecord(request["input"]) ? request["input"] : {};
      if (!requestId) return;
      const questions = toolName === "AskUserQuestion" ? questionsFromInput(input) : undefined;
      live.pending = { requestId, toolName, input, ...(questions ? { questions } : {}) };
      live.busy = true;
      const block = questions
        ? ({
            type: "ask",
            text: questions[0]?.question ?? "需要你回答",
            ask: questions[0]?.question,
            questions,
          } as MessageBlock)
        : ({
            type: "next-step",
            text: describeToolInput(input),
            ask: `允许执行 ${toolName} 吗？`,
            actions: [{ label: "允许" }, { label: "拒绝" }],
            pending: true,
          } as MessageBlock);
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "assistant",
        createdAt: Date.now(),
        blocks: [block],
      });
      this.touch(record);
      return;
    }
    if (type === "system") {
      // init 事件里带着 CLI 实际加载的模型；记下来，老会话也能看到自己在用哪个。
      if (event["subtype"] === "init") {
        let changed = false;
        const model = event["model"];
        if (typeof model === "string" && model && model !== record.observedModel) {
          record.observedModel = model;
          changed = true;
        }
        const commands = slashCommandsOf(event);
        if (commands && commands.join("\n") !== (record.slashCommands ?? []).join("\n")) {
          record.slashCommands = commands;
          changed = true;
        }
        if (changed) this.touch(record);
        return;
      }
    }
    if (type === "system" && event["subtype"] === "permission_denied") {
      const tool = typeof event["tool_name"] === "string" ? event["tool_name"] : "工具";
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "system",
        createdAt: Date.now(),
        blocks: [{ type: "text", text: `权限被拒绝：${tool}` }],
      });
      this.touch(record);
      return;
    }
    if (type === "result") {
      live.busy = false;
      live.pending = null;
      const isError = event["is_error"] === true;
      const text = typeof event["result"] === "string" ? event["result"].trim() : "";
      if (isError && text) {
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text: truncate(text, MAX_BLOCK_CHARS).text }],
        });
      }
      this.touch(record);
    }
  }

  private answerPermission(record: HostedRecord, live: LiveProcess, text: string): boolean {
    const pending = live.pending;
    if (!pending) return false;
    if (pending.questions && pending.questions.length > 0) {
      const answers = answersFromText(text, pending.questions);
      this.respondControl(live, pending.requestId, {
        behavior: "allow",
        updatedInput: { ...pending.input, answers },
      });
      live.pending = null;
      live.busy = true;
      this.touch(record);
      return true;
    }
    const trimmed = text.trim();
    if (/^(允许|批准|同意|可以|allow|yes|y)$/i.test(trimmed)) {
      this.respondControl(live, pending.requestId, { behavior: "allow", updatedInput: pending.input });
      live.pending = null;
      live.busy = true;
      this.touch(record);
      return true;
    }
    if (/^(拒绝|不允许|不同意|deny|no|n)$/i.test(trimmed)) {
      this.respondControl(live, pending.requestId, { behavior: "deny", message: "用户拒绝" });
      live.pending = null;
      live.busy = false;
      this.touch(record);
      return true;
    }
    return false;
  }

  private respondControl(live: LiveProcess, requestId: string, response: Record<string, unknown>): void {
    live.child.stdin?.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`,
    );
  }

  private writeUserTurn(live: LiveProcess, text: string): void {
    live.child.stdin?.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null })}\n`,
    );
  }

  private recordUser(record: HostedRecord, text: string): void {
    if (record.title === "托管会话") record.title = truncateTitle(text);
    this.appendRecord(record, {
      messageId: randomUUID(),
      sessionId: record.id,
      role: "user",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: truncate(text, MAX_BLOCK_CHARS).text }],
    });
  }

  private appendRecord(record: HostedRecord, message: MessageRecord): void {
    const list = this.messagesOf(record.id);
    list.push(message);
    record.updatedAt = message.createdAt;
    try {
      mkdirSync(this.hostedDir(), { recursive: true, mode: 0o700 });
      appendFileSync(this.transcriptPath(record.id), `${JSON.stringify(message)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log(`hosted: transcript write failed: ${String(error)}`);
    }
    record.updatedAt = message.createdAt;
  }

  private messagesOf(id: string): MessageRecord[] {
    const cached = this.messages.get(id);
    if (cached) return cached;
    const list: MessageRecord[] = [];
    const path = this.transcriptPath(id);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed) && typeof parsed["messageId"] === "string") {
            list.push(parsed as unknown as MessageRecord);
          }
        } catch {
          // Skip torn lines from a crashed write.
        }
      }
    }
    this.messages.set(id, list);
    return list;
  }

  private summary(record: HostedRecord): SessionSummary {
    const live = this.live.get(record.id);
    const dirExists = isDirectory(record.cwd);
    const summary: SessionSummary = {
      sessionId: sessionKeyFor(record.id),
      appId: "hosted",
      projectId: projectIdFor(record.cwd),
      kind: "hosted",
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: false,
      live: Boolean(live),
      busy: live?.busy ?? false,
      needsDecision: Boolean(live?.pending),
      canSend: dirExists,
      hosted: true,
      hostedState: live ? "running" : "stopped",
      permissionMode: record.permissionMode,
      ...(record.model ?? record.observedModel ? { model: record.model ?? record.observedModel } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
      cwd: record.cwd,
    };
    if (!dirExists) summary.sendBlockedReason = `工作目录已不存在：${record.cwd}`;
    return summary;
  }

  private allowedPath(input: string): string {
    if (this.config.dirs.length === 0) {
      throw new RpcError(
        "unsupported",
        `没有配置可托管的目录：编辑 ${join(this.stateDir, "hosted.json")} 的 dirs 后重启 Bridge`,
      );
    }
    const target = canonical(expandHome(input.trim()));
    const allowed = this.config.dirs
      .map((dir) => canonical(expandHome(dir)))
      .filter((dir): dir is string => dir !== null);
    if (!target || !allowed.includes(target)) {
      throw new RpcError("unauthorized", `目录不在允许列表中：${input}（允许：${allowed.join("、") || "无"}）`);
    }
    if (!isDirectory(target)) throw new RpcError("invalid_params", `目录不存在：${target}`);
    return target;
  }

  private permissionMode(value: string | undefined): HostedPermissionMode {
    if (!value) return "manual";
    if ((HOSTED_PERMISSION_MODES as string[]).includes(value)) return value as HostedPermissionMode;
    throw new RpcError("invalid_params", `不支持的权限模式：${value}`);
  }

  /** bypassPermissions 只有在 hosted.json 显式打开时才允许；关掉后老会话也不能再启动。 */
  private assertModeAllowed(mode: HostedPermissionMode): void {
    if (mode === "bypassPermissions" && !this.config.allowBypassPermissions) {
      throw new RpcError(
        "unsupported",
        `Bridge 未允许托管会话使用 bypassPermissions：在 ${join(this.stateDir, "hosted.json")} 设置 "allowBypassPermissions": true 后重启 Bridge`,
      );
    }
  }

  /** 模型名会原样进 argv：只收普通标识符形式，挡掉 `--flag` 这类参数注入。 */
  /**
   * 菜单栏/launchd 启动时 PATH 里通常没有 `claude`（它装在 ~/.local/bin），
   * 直接 spawn "claude" 会 ENOENT。按显式配置、常见安装位置依次找一个存在的。
   */
  private cliBinary(): string {
    const explicit = this.config.cliPath ?? process.env["AGENT_BRIDGE_CLAUDE_PATH"];
    if (explicit) return explicit;
    const candidates = [
      join(homedir(), ".local", "bin", "claude"),
      join(homedir(), ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "claude";
  }

  private model(value: string | undefined): string | undefined {
    const model = value?.trim();
    if (!model) return undefined;
    if (!MODEL_PATTERN.test(model)) {
      throw new RpcError("invalid_params", `模型名不合法：${value}`);
    }
    return model;
  }

  /** 思考程度会原样进 argv：只接受 CLI 自己列出的档位。 */
  private effort(value: string | undefined): string | undefined {
    const effort = value?.trim().toLowerCase();
    if (!effort) return undefined;
    const levels = effortLevels(this.cliBinary());
    if (!levels.includes(effort)) {
      throw new RpcError("invalid_params", `不支持的思考程度：${value}（可用：${levels.join("、")}）`);
    }
    return effort;
  }

  private touch(record: HostedRecord): void {
    record.lastActiveAt = Date.now();
    record.updatedAt = record.lastActiveAt;
    this.persistRecords();
  }

  private record(sessionId: string): HostedRecord | null {
    const id = stripPrefix(sessionId);
    const record = this.records.get(id);
    return record ?? null;
  }

  private kill(id: string): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    live.killed = true;
    this.live.delete(id);
    try {
      live.child.stdin?.end();
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        live.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, KILL_GRACE_MS);
    timer.unref();
    try {
      live.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    return true;
  }

  private stopAll(): void {
    for (const id of [...this.live.keys()]) this.kill(id);
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, live] of this.live) {
      if (live.busy || live.pending) continue;
      if (now - live.startedAt < IDLE_SWEEP_MS) continue;
      const record = this.records.get(id);
      if (!record) continue;
      if (now - record.lastActiveAt <= this.config.idleTimeoutMs) continue;
      this.log(`hosted: idle timeout, stopping ${id}`);
      this.kill(id);
    }
  }

  private hostedDir(): string {
    return join(this.stateDir, "hosted");
  }

  private transcriptPath(id: string): string {
    return join(this.hostedDir(), `${id}.jsonl`);
  }

  private registryPath(): string {
    return join(this.hostedDir(), "sessions.json");
  }

  private loadRecords(): void {
    const path = this.registryPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const list = isRecord(raw) && Array.isArray(raw["sessions"]) ? raw["sessions"] : [];
      for (const item of list) {
        if (!isRecord(item)) continue;
        if (typeof item["id"] !== "string" || typeof item["cwd"] !== "string") continue;
        const context = sanitizeContextUsage(item["context"]);
        const slashCommands = sanitizeSlashCommands(item["slashCommands"]);
        this.records.set(item["id"], {
          id: item["id"],
          cwd: item["cwd"],
          title: typeof item["title"] === "string" ? item["title"] : "托管会话",
          permissionMode: this.permissionMode(
            typeof item["permissionMode"] === "string" ? item["permissionMode"] : "manual",
          ),
          // 记录里的模型名不可信：校验不过就当没写，别让一条坏记录拖垮整个注册表。
          ...(typeof item["model"] === "string" && MODEL_PATTERN.test(item["model"]) ? { model: item["model"] } : {}),
          ...(typeof item["effort"] === "string" && /^[a-z][a-z-]{0,15}$/.test(item["effort"])
            ? { effort: item["effort"] }
            : {}),
          ...(typeof item["observedModel"] === "string" && MODEL_PATTERN.test(item["observedModel"])
            ? { observedModel: item["observedModel"] }
            : {}),
          ...(item["interrupted"] === true ? { interrupted: true } : {}),
          ...(context ? { context } : {}),
          ...(slashCommands ? { slashCommands } : {}),
          createdAt: numberOr(item["createdAt"], Date.now()),
          updatedAt: numberOr(item["updatedAt"], Date.now()),
          lastActiveAt: numberOr(item["lastActiveAt"], Date.now()),
        });
      }
    } catch (error) {
      this.log(`hosted: registry read failed: ${String(error)}`);
    }
  }

  private persistRecords(): void {
    try {
      mkdirSync(this.hostedDir(), { recursive: true, mode: 0o700 });
      const tmp = `${this.registryPath()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(
          {
            sessions: [...this.records.values()].map((record) => ({
              id: record.id,
              cwd: record.cwd,
              title: record.title,
              permissionMode: record.permissionMode,
              ...(record.model ? { model: record.model } : {}),
              ...(record.effort ? { effort: record.effort } : {}),
              ...(record.observedModel ? { observedModel: record.observedModel } : {}),
              ...(record.interrupted ? { interrupted: record.interrupted } : {}),
              ...(record.context ? { context: record.context } : {}),
              ...(record.slashCommands ? { slashCommands: record.slashCommands } : {}),
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              lastActiveAt: record.lastActiveAt,
            })),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      renameSync(tmp, this.registryPath());
    } catch (error) {
      this.log(`hosted: registry write failed: ${String(error)}`);
    }
  }
}

export function sessionKeyFor(id: string): string {
  return `hosted:${id}`;
}

/** 会话详情里的模型说明：请求值、CLI 实际报告值，或者两者都没有时的未知状态。 */
function modelLabel(record: HostedRecord): string {
  if (record.observedModel) {
    return record.model && record.model !== record.observedModel
      ? `${record.model}（实际 ${record.observedModel}）`
      : record.observedModel;
  }
  if (record.model) return `${record.model}（尚未运行，实际模型未知）`;
  return "CLI 默认（未记录，下次运行后自动显示）";
}

function stripPrefix(sessionId: string): string {
  return sessionId.startsWith("hosted:") ? sessionId.slice("hosted:".length) : sessionId;
}

function projectIdFor(cwd: string): string {
  return `hosted:${cwd}`;
}

function readConfig(stateDir: string): HostedConfig {
  const path = join(stateDir, "hosted.json");
  if (!existsSync(path)) {
    return { dirs: [], idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, allowBypassPermissions: false };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const dirs = isRecord(raw) && Array.isArray(raw["dirs"])
      ? raw["dirs"].filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
    const idle = isRecord(raw) ? numberOr(raw["idleTimeoutMs"], DEFAULT_IDLE_TIMEOUT_MS) : DEFAULT_IDLE_TIMEOUT_MS;
    const config: HostedConfig = {
      dirs,
      idleTimeoutMs: Math.max(idle, 60_000),
      allowBypassPermissions: isRecord(raw) && raw["allowBypassPermissions"] === true,
      ...(isRecord(raw) && typeof raw["cliPath"] === "string" ? { cliPath: raw["cliPath"] } : {}),
    };
    return config;
  } catch {
    return { dirs: [], idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, allowBypassPermissions: false };
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function canonical(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const MAX_SLASH_COMMANDS = 500;
const MAX_SLASH_COMMAND_CHARS = 120;

/** init 事件里的 `slash_commands` 混着只在终端生效的命令，去掉它们免得网页提示了却不可用。 */
function slashCommandsOf(event: Record<string, unknown>): string[] | undefined {
  const list = event["slash_commands"];
  if (!Array.isArray(list)) return undefined;
  const terminalRaw = event["terminal_slash_commands"];
  const terminal = new Set(
    Array.isArray(terminalRaw) ? terminalRaw.filter((item): item is string => typeof item === "string") : [],
  );
  return sanitizeSlashCommands(list.filter((item) => !terminal.has(String(item))));
}

function sanitizeSlashCommands(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().replace(/^\/+/, "");
    if (!name || name.length > MAX_SLASH_COMMAND_CHARS || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_SLASH_COMMANDS) break;
  }
  return out.length > 0 ? out : undefined;
}

function truncateTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "托管会话";
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line;
}

function blocksFromContent(content: unknown): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const items = Array.isArray(content) ? content : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item["type"] === "text" && typeof item["text"] === "string" && item["text"].trim()) {
      blocks.push({ type: "text", ...truncate(item["text"], MAX_BLOCK_CHARS) });
    } else if (item["type"] === "tool_use") {
      const name = typeof item["name"] === "string" ? item["name"] : "tool";
      const input = isRecord(item["input"]) ? item["input"] : {};
      blocks.push({ type: "tool", text: truncate(`${name} ${describeToolInput(input)}`, MAX_BLOCK_CHARS).text });
    }
  }
  return blocks;
}

function describeToolInput(input: Record<string, unknown>): string {
  const command = input["command"];
  if (typeof command === "string") return command;
  const file = input["file_path"] ?? input["path"] ?? input["notebook_path"];
  if (typeof file === "string") return file;
  const url = input["url"];
  if (typeof url === "string") return url;
  const description = input["description"];
  if (typeof description === "string") return description;
  const text = JSON.stringify(input);
  return text === "{}" ? "" : text.slice(0, 300);
}

function questionsFromInput(input: Record<string, unknown>): MessageQuestion[] | undefined {
  const raw = input["questions"];
  if (!Array.isArray(raw)) return undefined;
  const questions: MessageQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item["question"] !== "string") continue;
    const options = Array.isArray(item["options"])
      ? item["options"]
          .filter(isRecord)
          .map((option) => ({
            label: typeof option["label"] === "string" ? option["label"] : "",
            ...(typeof option["description"] === "string" ? { description: option["description"] } : {}),
          }))
          .filter((option) => option.label !== "")
      : [];
    questions.push({
      question: item["question"],
      ...(typeof item["header"] === "string" ? { header: item["header"] } : {}),
      ...(item["multiSelect"] === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return questions.length > 0 ? questions : undefined;
}

function answersFromText(text: string, questions: MessageQuestion[]): Record<string, string | string[]> {
  const parts = text
    .split(/[、,，\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const answers: Record<string, string | string[]> = {};
  if (questions.length === 1) {
    const question = questions[0];
    if (!question) return answers;
    const matched = question.options
      .map((option) => option.label)
      .filter((label) => parts.includes(label) || text.trim() === label);
    if (question.multiSelect) {
      answers[question.question] = matched.length > 0 ? matched : [text.trim()];
    } else {
      answers[question.question] = matched[0] ?? text.trim();
    }
    return answers;
  }
  questions.forEach((question, index) => {
    const part = parts[index] ?? "";
    if (!question.multiSelect) {
      answers[question.question] = part;
      return;
    }
    // 多选答案在网页里用「/」连接：同题多选要还原成数组，否则会被当成一个选项。
    const chosen = part
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const matched = question.options
      .map((option) => option.label)
      .filter((label) => chosen.includes(label));
    answers[question.question] = matched.length > 0 ? matched : chosen;
  });
  return answers;
}
