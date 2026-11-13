import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  ContextUsage,
  HostedAgent,
  HostedAgentOption,
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
  MessageQuestionOption,
  MessageRecord,
  ModelOption,
  MessageSendResult,
  ProjectInfo,
  SessionModelsResult,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText } from "../adapters/types.js";
import { contextUsageFromUsage, sanitizeContextUsage } from "../context-usage.js";
import { effortLevels } from "../effort.js";
import { modelCatalog } from "../model-catalog.js";
import { subagentTasks } from "../subagents.js";
import { defaultStateDir } from "../store.js";
import { piBinary } from "./pi-binary.js";
import { piAgentSourceDir, preparePiAgentDir, removePiAgentDir } from "./pi-agent-dir.js";
import { PiSession, type PiPending } from "./pi-session.js";
import { piSubagentTasks } from "./pi-subagents.js";
import { claudeTaskMessages, piTaskMessages } from "./task-messages.js";
import { killProcess, markProcessGroup } from "./process-group.js";
import { SessiondBridge } from "./sessiond/bridge.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 60_000;
const MAX_BLOCK_CHARS = 4_000;
export const MAX_TITLE_CHARS = 60;
const KILL_GRACE_MS = 2_000;
/** 补算老会话的上下文用量时只读转录尾部这么多字节。 */
const TRANSCRIPT_TAIL_BYTES = 262_144;
/**
 * CLI 模型名允许的字符集：普通标识符 + 完整 ID 里的括号/点/冒号，再加路由器的 `厂商/模型`
 * 与 `组/子组`（例如 `ncncapi/claude-opus-5-5`、`group/dsgroup`）；不能以 `-` 开头。
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,79}$/;
/** 网页能加的启动参数最多这么多项、每项这么长，免得把 argv 撑爆。 */
const MAX_EXTRA_ARGS = 24;
const MAX_EXTRA_ARG_CHARS = 200;
/**
 * 决定会话身份、输出协议与权限的旗标不接受：它们由 Bridge 按会话记录设置，
 * 网页再传一遍会顶掉会话跟踪，或绕过 hosted.json 的 allowBypassPermissions 开关。
 */
const BLOCKED_EXTRA_ARGS = new Set([
  "-p",
  "--print",
  "-c",
  "--continue",
  "--resume",
  "--session-id",
  "--input-format",
  "--output-format",
  "--permission-mode",
  "--permission-prompts",
  "--permission-prompt-tool",
  "--dangerously-skip-permissions",
  // settings 文件里能写 permissions.allow 和 hooks，等于绕过上面的模式门禁。
  "--settings",
]);

/** pi 这边同理：会话身份、协议模式与信任开关由 Bridge 决定。 */
const BLOCKED_PI_ARGS = new Set([
  "--mode",
  "--session",
  "--session-id",
  "--session-dir",
  "--no-session",
  "--fork",
  "-c",
  "--continue",
  "-r",
  "--resume",
  "-a",
  "--approve",
  "-na",
  "--no-approve",
]);

/** 读注册表时用：手改过的记录也不能塞进上面那些旗标，坏数据丢掉而不是整表读失败。 */
function sanitizeExtraArgs(values: unknown[]): string[] {
  const tokens: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const token = value.trim();
    if (!token || token.length > MAX_EXTRA_ARG_CHARS) continue;
    if (BLOCKED_EXTRA_ARGS.has(token.split("=")[0] ?? token)) continue;
    tokens.push(token);
  }
  return tokens.slice(0, MAX_EXTRA_ARGS);
}

/** 没有守护进程时在本机直接起子进程：自成一组，停的时候连孙进程一起收。 */
function spawnLocal(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): HostedChild {
  return markProcessGroup(
    nodeSpawn(command, args, { cwd: options.cwd, env: options.env, detached: true }),
  ) as unknown as HostedChild;
}

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
  /** 持有进程的 CLI；缺省（老记录）是 Claude Code。 */
  agent?: HostedAgent;
  permissionMode: HostedPermissionMode;
  /** CLI `--model` value; undefined keeps the CLI default. */
  model?: string;
  /** CLI `--effort` level; undefined keeps the CLI default. */
  effort?: string;
  /** 额外的 CLI 启动参数（已拆成 argv token），resume 时原样带上。 */
  args?: string[];
  /** pi 会话：新派生的子代理用哪个模型；缺省跟随 pi 自己的设置。 */
  subagentModel?: string;
  /** 由 CLI 的 init 事件报告的实际模型，用来核对是否按预期生效。 */
  observedModel?: string;
  /** 最近一次 assistant 事件的 usage，用来在侧栏显示上下文占用。 */
  context?: ContextUsage;
  /** CLI init 事件报告的斜杠命令与技能，网页输入「/」时用来提示。 */
  slashCommands?: string[];
  /** pi 会话能用的模型清单（get_available_models），换模型时给网页用。 */
  piModels?: ModelOption[];
  /** 网页上归档的会话：记录留着，只是不在列表里显示。 */
  archived?: boolean;
  /** 最近一轮被「停止」中断：下一次发送用户消息前一直成立，网页重开也能显示「已中断」。 */
  interrupted?: boolean;
  /** 已写进 CLI 但还没等到 result 的用户消息；Bridge 重启后据此自动续跑。 */
  pendingText?: string;
  /** 已经自动续跑过几次：反复中断的会话不能无限重启。 */
  resumeAttempts?: number;
  /** sessiond 已经处理到的 stdout 序号；重连时从这里之后补齐断线输出。 */
  stdoutSeq?: number;
  /** 最后一条还没应答的权限请求原始行：Bridge 重连后重新投给解析流程。 */
  pendingLine?: string;
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
  /** pi 会话的协议客户端；Claude Code 会话没有。 */
  pi?: PiSession;
  /** pi 扩展正在等网页回答的提问。 */
  piPending?: PiPending;
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
  /** 由 spawnInOwnGroup 标记：这个进程自成一个进程组，kill 要杀整组。 */
  ownsProcessGroup?: boolean;
}

export type HostedSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; sessionId: string },
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
  /** 注入的 spawn 只给测试用；为 null 时走 sessiond。 */
  private readonly spawnFn: HostedSpawn | null;
  private readonly sessiond: SessiondBridge | null;
  private readonly log: (line: string) => void;
  private config: HostedConfig;
  private readonly records = new Map<string, HostedRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly live = new Map<string, LiveProcess>();
  private sweeper: NodeJS.Timeout | null = null;
  /** stdout 很密，注册表最多两秒写一次。 */
  private lastPersistAt = 0;
  // Bridge 退出只断开 sessiond 连接：子进程继续由守护进程持有，重启后 attach 接上。
  private readonly exitHandler = (): void => {
    this.sessiond?.close();
  };

  constructor(options: HostedManagerOptions = {}) {
    this.stateDir = options.stateDir ?? defaultStateDir();
    this.log = options.log ?? (() => undefined);
    this.spawnFn = options.spawn ?? null;
    // 默认把进程交给 sessiond；显式注入 spawn 时完全不碰守护进程。
    this.sessiond = this.spawnFn
      ? null
      : new SessiondBridge(this.stateDir, {
          log: this.log,
          // 守护进程起不来时退回原来的本机 spawn，托管不能整体不可用。
          fallback: (command, args, spawnOptions) =>
            spawnLocal(command, args, { cwd: spawnOptions.cwd, env: process.env }),
        });
    this.config = readConfig(this.stateDir);
    this.loadRecords();
    // 只恢复启动瞬间就存在的未完成轮次：recover 是异步的，期间新建/刚发出的会话不能被重放。
    const interrupted = new Set(
      [...this.records.values()].filter((record) => record.pendingText).map((record) => record.id),
    );
    this.backfillContext();
    // 先向 sessiond 要回还在跑的会话，再让旧的 --resume 兜底处理剩下的。
    void this.recover(interrupted);
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

  /** 设置界面改完 hosted.json 后重新读一次，不用重启 Bridge。 */
  reloadConfig(): void {
    this.config = readConfig(this.stateDir);
  }

  /** 只改 allowBypassPermissions，其余键原样保留；写盘后立即生效。 */
  setAllowBypassPermissions(enabled: boolean): HostedDirsResult {
    const path = join(this.stateDir, "hosted.json");
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) raw = parsed;
    } catch {
      // 没有文件或内容坏了：按只有这一项的新配置写。
    }
    raw["allowBypassPermissions"] = enabled;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      throw new RpcError(
        "internal",
        `写入 hosted.json 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.reloadConfig();
    return this.configForClient();
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

  /** 侧栏点开的后台任务记录：pi 读 run 的 events.jsonl，Claude Code 读子代理转录。 */
  taskMessages(sessionId: string, taskId: string, page: MessagePage): MessageListResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const all =
      record.agent === "pi" ? piTaskMessages(record.id, taskId) : claudeTaskMessages(record.id, taskId);
    if (!all) throw new RpcError("not_found", "未知后台任务");
    let end = all.length;
    if (page.before) {
      const index = all.findIndex((message) => message.messageId === page.before);
      if (index === -1) throw new RpcError("invalid_params", "未知的分页游标");
      end = index;
    }
    const start = Math.max(0, end - page.limit);
    const result: MessageListResult = {
      messages: all.slice(start, end),
      completeness: "partial",
      note: record.agent === "pi" ? "子代理记录：来自 pi-subagents 的 run 产物，仅文本与工具摘要" : "子任务记录：仅文本与工具调用摘要",
    };
    if (start > 0) result.nextBefore = result.messages[0]?.messageId;
    return result;
  }

  rail(sessionId: string): SessionRailResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const live = this.live.get(record.id);
    const pi = record.agent === "pi";
    return {
      environment: [
        { label: "工作目录", value: record.cwd },
        ...(pi
          ? [{ label: "引擎", value: "pi 托管" }]
          : [
              { label: "权限模式", value: record.permissionMode },
              { label: "思考程度", value: record.effort ?? "CLI 默认" },
            ]),
        { label: "模型", value: modelLabel(record) },
        ...(pi ? [{ label: "子代理模型", value: record.subagentModel ?? "跟随 pi 设置" }] : []),
        ...(record.args?.length ? [{ label: "启动参数", value: record.args.join(" ") }] : []),
        {
          label: "进程",
          value: live ? `运行中（pid ${live.child.pid ?? "?"}）` : "未运行（发送时 resume）",
        },
        { label: "空闲超时", value: `${Math.round(this.config.idleTimeoutMs / 60_000)} 分钟` },
      ],
      servers: [],
      // 子代理记录和桌面会话同一份：CLI 按 --session-id 写在自己的 projects 目录下。
      // pi 没有这份转录，后台子代理 run 的状态在 pi-subagents 自己的临时目录里。
      tasks: pi ? piSubagentTasks(record.id) : subagentTasks([record.id]),
      ...(record.context ? { context: record.context } : {}),
      note: "This session is hosted by Bridge, not by the Claude desktop app.",
    };
  }

  create(params: HostedCreateParams): SessionSummary {
    const cwd = this.allowedPath(params.path);
    const agent: HostedAgent = params.agent === "pi" ? "pi" : "claude";
    // pi 没有权限模式与思考程度：记录里留 manual，只当作占位。
    const permissionMode = agent === "pi" ? "manual" : this.permissionMode(params.permissionMode);
    this.assertModeAllowed(permissionMode);
    const model = this.model(params.model);
    const effort = agent === "pi" ? undefined : this.effort(params.effort);
    const subagentModel = agent === "pi" ? this.model(params.subagentModel) : undefined;
    const extraArgs = this.extraArgs(params.args, agent);
    const now = Date.now();
    const id = randomUUID();
    const record: HostedRecord = {
      id,
      cwd,
      title: params.title?.trim() || "托管会话",
      ...(agent === "pi" ? { agent } : {}),
      permissionMode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(subagentModel ? { subagentModel } : {}),
      ...(extraArgs ? { args: extraArgs } : {}),
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
        `无法启动 ${agent === "pi" ? "pi" : "Claude Code"}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.records.set(id, record);
    this.persistRecords();
    this.log(`hosted: created ${id} in ${cwd} (${permissionMode})`);
    return this.summary(record);
  }

  /** 归档/取消归档：只改标记，进程与记录都不动。 */
  archive(sessionId: string, archived: boolean): SessionSummary {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (archived) record.archived = true;
    else delete record.archived;
    this.persistRecords();
    return this.summary(record);
  }

  /**
   * 删除托管会话：停掉进程、删掉记录与聊天记录文件。
   * CLI 自己的转录（~/.claude/projects 里那份）不动，删除的只是 Bridge 这边的东西。
   */
  async remove(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    this.kill(record.id);
    await this.stopInSessiond(record.id);
    this.messages.delete(record.id);
    try {
      rmSync(this.transcriptPath(record.id), { force: true });
    } catch (error) {
      this.log(`hosted: remove transcript failed: ${String(error)}`);
    }
    removePiAgentDir(this.piAgentDirOf(record.id));
    this.records.delete(record.id);
    this.persistRecords();
    this.log(`hosted: removed ${record.id}`);
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
          `无法 resume ${record.agent === "pi" ? "pi" : "Claude Code"}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      record.lastActiveAt = Date.now();
      this.persistRecords();
    }
    return this.summary(record);
  }

  async stop(sessionId: string): Promise<HostedStopResult> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    // 用户主动关掉的会话不该在 Bridge 重启后被自动续跑；kill 本身不写注册表。
    record.pendingText = undefined;
    this.persistRecords();
    const tracked = this.kill(record.id);
    // Bridge 没跟踪到、但守护进程里还跑着的进程同样要停。
    const orphan = await this.stopInSessiond(record.id);
    return { stopped: tracked || orphan, session: this.summary(record) };
  }

  /** 网页上的模型选择：托管会话可以从网页换模型，换完下一条消息按新模型 resume。 */
  models(sessionId: string): SessionModelsResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (record.agent === "pi") {
      const models = record.piModels ?? [];
      const current = record.model ?? record.observedModel;
      const result: SessionModelsResult = { models, canSwitch: true, canSwitchSubagent: true };
      if (current) {
        result.current = current;
        result.currentName = models.find((item) => item.id === current)?.name ?? current;
      }
      if (record.subagentModel) result.subagentModel = record.subagentModel;
      result.note =
        models.length > 0
          ? "换模型会停掉当前 pi 进程，下一条消息按新模型重新打开这个会话；子代理模型只影响之后新派生的子代理。"
          : "pi 的模型清单要等会话跑过一次才拿得到。";
      return result;
    }
    const models = modelCatalog();
    const current = record.model ?? record.observedModel;
    const result: SessionModelsResult = { models, canSwitch: true };
    if (current) {
      result.current = current;
      result.currentName = models.find((item) => item.id === current)?.name ?? current;
    }
    result.note = record.model
      ? "换模型会停掉当前进程，下一条消息按新模型重新 resume。"
      : "这条会话还没钉住模型，现在跑的是 CLI 默认模型；选一个就会钉住它。";
    return result;
  }

  /** `model` 传 null 表示改回「跟 CLI 默认走」。 */
  async setModel(sessionId: string, value: string | null): Promise<SessionSummary> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    const live = this.live.get(record.id);
    const model = this.model(value?.trim() || undefined);
    // pi 的 RPC 有原生 set_model：进程不用停，正在跑的回合结束后就按新模型继续。
    if (record.agent === "pi" && model && live?.pi) {
      const switched = await live.pi.setModel(model);
      if (switched.error) {
        throw new RpcError("invalid_params", `pi 换模型失败：${switched.error}`);
      }
      record.model = switched.model ?? model;
      record.observedModel = record.model;
      this.touch(record);
      return this.summary(record);
    }
    if (live?.busy || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再换模型");
    }
    // 先停进程再改记录：停不掉就报错，别让界面显示新模型而进程还跑着旧的。
    if (live) this.kill(record.id);
    // 换模型必须让旧进程真的退出，否则下一条消息会接回还在跑的那一个，模型没换。
    // 守护进程里没有跟踪到的旧进程（上一代 Bridge 留下的）也只能由它杀掉。
    await this.stopInSessiond(record.id, true);
    if (model) record.model = model;
    else delete record.model;
    // 实际模型是上一轮 init 报的，换了模型旧值就作废，下次运行重新记录。
    delete record.observedModel;
    this.touch(record);
    return this.summary(record);
  }

  /**
   * 单独改这个会话派生子代理用的模型（只对 pi 有效）。
   * pi 只在启动时读 settings.json，所以空闲进程要先停掉，下一条消息按新设置重新打开会话；
   * 已经在跑的子代理不受影响，只有之后新派生的才用新模型。
   * `value` 传 null 表示改回跟随 pi 自己的设置。
   */
  async setSubagentModel(sessionId: string, value: string | null): Promise<SessionSummary> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (record.agent !== "pi") {
      throw new RpcError("unsupported", "只有 pi 托管会话可以单独设置子代理模型");
    }
    const live = this.live.get(record.id);
    const model = this.model(value?.trim() || undefined);
    if (live?.busy || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再换子代理模型");
    }
    // 先写好新的 agent 目录，再停进程：写不进去就别停，免得白断一轮。
    const agentDir = this.piAgentDirOf(record.id);
    if (model) {
      if (!preparePiAgentDir(agentDir, model)) {
        throw new RpcError("unsupported", `读不到 pi 的 agent 目录（${piAgentSourceDir()}），子代理模型没有生效`);
      }
    } else {
      removePiAgentDir(agentDir);
    }
    if (live) this.kill(record.id);
    await this.stopInSessiond(record.id, true);
    if (model) record.subagentModel = model;
    else delete record.subagentModel;
    this.touch(record);
    return this.summary(record);
  }

  /** 让守护进程停掉这个会话的进程（没有就不做），并等它退出；strict 时停不掉就抛错。 */
  private async stopInSessiond(id: string, strict = false): Promise<boolean> {
    if (!this.sessiond) return false;
    try {
      return await this.sessiond.killSession(id);
    } catch (error) {
      this.log(`hosted: kill ${id} in sessiond failed: ${String(error)}`);
      if (strict) {
        throw new RpcError(
          "conflict",
          `旧进程没停掉，模型没有切换：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  }

  /** 新建托管会话可选的模型与思考程度，取自本机 CLI。 */
  options(): HostedOptionsResult {
    const models = modelCatalog();
    const pi = piBinary();
    const agents: HostedAgentOption[] = [
      { id: "claude", label: "Claude Code", available: true },
      {
        id: "pi",
        label: "pi",
        available: pi !== null,
        ...(pi === null ? { detail: "未找到 pi 可执行文件（~/.bun/bin/pi 或 AGENT_BRIDGE_PI_PATH）" } : {}),
      },
    ];
    const result: HostedOptionsResult = {
      models,
      efforts: effortLevels(this.cliBinary()),
      agents,
    };
    if (models.length === 0) {
      result.note = "读不到模型目录（桌面端与 CLI 都没有缓存），只能使用 CLI 默认模型。";
    }
    // 子代理模型只认 pi 自己报过的模型名：把已有 pi 会话的清单合并起来当选项。
    const piModels: ModelOption[] = [];
    const seen = new Set<string>();
    for (const record of this.records.values()) {
      if (record.agent !== "pi") continue;
      for (const item of record.piModels ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        piModels.push(item);
      }
    }
    if (piModels.length > 0) result.piModels = piModels;
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
    if (!live || (!live.busy && !live.pending && !live.piPending)) {
      return { interrupted: false, session: this.summary(record) };
    }
    if (record.agent === "pi") {
      if (live.piPending) live.pi?.cancel();
      live.pi?.abort();
      live.busy = false;
      record.interrupted = true;
      record.pendingText = undefined;
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
    // 停在没有回答的批准请求上时，先拒绝它，否则这一轮还在等输入。
    if (live.pending) {
      this.respondControl(record, live, live.pending.requestId, {
        behavior: "deny",
        message: "用户停止了当前回合",
      });
      live.pending = null;
    }
    record.pendingLine = undefined;
    live.child.stdin?.write(
      `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
    );
    live.busy = false;
    record.interrupted = true;
    // 用户主动停的一轮不该在重启后又被自动续跑。
    record.pendingText = undefined;
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
    if (record.agent === "pi") {
      const pi = live.pi;
      if (!pi) throw new RpcError("adapter_unavailable", "pi 协议还没就绪，稍后再发");
      if (live.piPending) {
        const pending = live.piPending;
        pi.answer(pending, text);
        this.recordUser(record, text);
        this.touch(record);
        return { accepted: true, delivered: true, detail: "已答复 pi 的提问" };
      }
      pi.prompt(text, live.busy);
      this.recordUser(record, text);
      // 这一轮要等 agent_settled 才算结束；中途 Bridge 退出就靠它续跑。
      record.pendingText = text;
      record.interrupted = false;
      live.busy = true;
      this.touch(record);
      return { accepted: true, delivered: true };
    }
    if (live.pending) {
      const handled = this.answerPermission(record, live, text);
      if (handled) {
        this.recordUser(record, text);
        this.touch(record);
        return { accepted: true, delivered: true, detail: "已答复待批准的操作" };
      }
      // Not an answer to the prompt: deny it and deliver the text as a user turn.
      this.respondControl(record, live, live.pending.requestId, {
        behavior: "deny",
        message: "用户没有批准这次调用，改为直接回复",
      });
      live.pending = null;
    }
    this.writeUserTurn(live, text);
    this.recordUser(record, text);
    // 这一轮要等 result 事件才算结束；中途 Bridge 退出就靠它续跑。
    record.pendingText = text;
    record.interrupted = false;
    live.busy = true;
    this.touch(record);
    return { accepted: true, delivered: true };
  }

  /**
   * Bridge 重启后的恢复：sessiond 还活着的会话直接 attach 回去，补上断线期间的输出，
   * 并把没应答的权限请求重新挂上；sessiond 里没有的会话再退回 --resume 重放。
   */
  private async recover(interrupted: ReadonlySet<string>): Promise<void> {
    const sessiond = this.sessiond;
    if (!sessiond) {
      this.resumeInterrupted(interrupted);
      return;
    }
    try {
      await sessiond.ensure();
      const infos = await sessiond.list();
      const running = new Set(infos.filter((info) => info.running).map((info) => info.sessionId));
      for (const record of this.records.values()) {
        if (!running.has(record.id) || this.live.has(record.id)) continue;
        const result = await sessiond.attach(record.id, record.stdoutSeq ?? 0);
        const child = sessiond.remoteChild(record.id);
        if (!result.running || !child) continue;
        const live = this.track(record, child, true, this.cliBinary());
        if (result.gap) {
          this.appendRecord(record, {
            messageId: randomUUID(),
            sessionId: record.id,
            role: "system",
            createdAt: Date.now(),
            blocks: [{ type: "text", text: "Bridge 重启期间会话输出过多，中间一段已丢弃" }],
          });
        }
        // 先喂 backlog，再放行持有的事件：两者按 seq 顺序进入同一条解析缓冲。
        for (const chunk of result.backlog) this.feedChild(record, live, chunk.data, chunk.seq);
        child.release();
        // 这一轮还没收尾：保持 busy，否则 sweepIdle 会把正在跑的进程当空闲杀掉。
        if (record.pendingText) live.busy = true;
        // 重投没有应答的权限请求；存的原始行没有换行，补上才能进解析缓冲。
        const pending = record.pendingLine;
        if (pending && record.agent !== "pi" && !live.finished) {
          this.onStdout(record, live, `${pending}\n`);
          live.busy = true;
        }
        this.log(
          `hosted: reattached ${record.id} (backlog ${result.backlog.length}, gap=${result.gap})`,
        );
      }
    } catch (error) {
      // 守护进程没起来或协议出错：退回原来的 --resume 兜底，不能把 Bridge 卡死。
      this.log(`hosted: sessiond recover failed: ${String(error)}`);
    }
    this.resumeInterrupted(interrupted);
  }

  /** Bridge 重启时子进程会被一起杀掉，已写入但没等到 result 的那一轮只能靠 --resume 重放。 */
  private resumeInterrupted(interrupted: ReadonlySet<string>): void {
    for (const id of interrupted) {
      const record = this.records.get(id);
      if (!record) continue;
      // sessiond 里还活着的会话已经 attach 回来了，不能再起第二个进程。
      if (this.live.has(record.id)) continue;
      const text = record.pendingText;
      if (!text) continue;
      const attempts = record.resumeAttempts ?? 0;
      if (attempts >= 3) {
        // 每次都续跑又每次被打断：停手，别让一个坏会话无限重启 Bridge。
        record.pendingText = undefined;
        record.interrupted = true;
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text: "上次一轮被反复中断，需要手动继续" }],
        });
        this.persistRecords();
        this.log(`hosted: auto-resume gave up for ${record.id} after ${attempts} attempts`);
        continue;
      }
      record.resumeAttempts = attempts + 1;
      this.persistRecords();
      try {
        this.start(record, true);
        const live = this.live.get(record.id);
        if (live) {
          if (record.agent === "pi") live.pi?.prompt(text, false);
          else this.writeUserTurn(live, text);
          live.busy = true;
          record.interrupted = false;
          this.touch(record);
        }
      } catch (error) {
        // 一条会话起不来（目录没了、模式被关掉）不能拖垮整个 Bridge。
        this.log(`hosted: auto-resume failed for ${record.id}: ${String(error)}`);
        continue;
      }
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "system",
        createdAt: Date.now(),
        blocks: [{ type: "text", text: "Bridge 重启，已自动续跑上次未结束的一轮" }],
      });
      this.persistRecords();
      this.log(`hosted: auto-resumed ${record.id} (attempt ${record.resumeAttempts})`);
    }
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    process.removeListener("exit", this.exitHandler);
    this.stopAll();
    this.sessiond?.close();
  }

  private start(record: HostedRecord, resume: boolean): void {
    if (record.agent === "pi") {
      this.startPi(record, resume);
      return;
    }
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
    // 网页加的启动参数放在最后，允许覆盖上面的默认值（例如 --agent 这种 Bridge 不认识的旗标）。
    if (record.args?.length) args.push(...record.args);
    const child = this.spawnProcess(cli, args, record.cwd, record.id, record.stdoutSeq ?? 0);
    this.track(record, child, resume, cli);
  }

  /**
   * pi 用 `--mode rpc` 常驻：一行一条命令，回复与事件也从 stdout 一行一条回来。
   * `--session-id` 带 Bridge 的会话 id，首次创建、之后 resume 都是同一条命令。
   */
  private startPi(record: HostedRecord, resume: boolean): void {
    const binary = piBinary();
    if (!binary) {
      throw new RpcError(
        "adapter_unavailable",
        "未找到 pi 可执行文件：托管 pi 会话需要它在 ~/.bun/bin、/opt/homebrew/bin 或 AGENT_BRIDGE_PI_PATH 中。",
      );
    }
    const args = ["--mode", "rpc", "--session-id", record.id, "--approve"];
    // 模型记成 `provider/modelId`，启动时拆回两个旗标。
    if (record.model) {
      const slash = record.model.indexOf("/");
      if (slash > 0) args.push("--provider", record.model.slice(0, slash), "--model", record.model.slice(slash + 1));
      else args.push("--model", record.model);
    }
    if (record.args?.length) args.push(...record.args);
    // 子代理模型只认 settings.json：给这个会话单独准备一份 agent 目录，用环境变量指过去。
    const agentDir = preparePiAgentDir(this.piAgentDirOf(record.id), record.subagentModel);
    const child = this.spawnProcess(
      binary,
      args,
      record.cwd,
      record.id,
      record.stdoutSeq ?? 0,
      agentDir ? { PI_CODING_AGENT_DIR: agentDir } : undefined,
    );
    this.track(record, child, resume, binary);
  }

  /** 默认交给 sessiond 持有；注入 spawn 的测试和守护进程不可用时走本机。 */
  private spawnProcess(
    command: string,
    args: string[],
    cwd: string,
    sessionId: string,
    ack: number,
    extraEnv?: Record<string, string>,
  ): HostedChild {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    if (this.spawnFn) return this.spawnFn(command, args, { cwd, env, sessionId });
    // 守护进程自己带环境，只把多出来的那几项传过去，别把整个 env 塞进协议。
    if (this.sessiond) {
      return this.sessiond.spawnChild(command, args, { cwd, sessionId, ack, ...(extraEnv ? { env: extraEnv } : {}) });
    }
    return spawnLocal(command, args, { cwd, env });
  }

  /** 这个会话专用的 pi agent 目录（只有设了子代理模型才会真的建）。 */
  private piAgentDirOf(id: string): string {
    return join(this.stateDir, "pi-agent", id);
  }

  /** 把子进程挂进 live 表并接好事件；新建与重连共用同一套退出/错误处理。 */
  private track(record: HostedRecord, child: HostedChild, resume: boolean, cli: string): LiveProcess {
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
    if (record.agent === "pi") this.attachPi(record, live);
    child.stdout?.setEncoding?.("utf8");
    // RemoteChild 会把 sessiond 的 seq 作为第二个参数带上，用来推进 ack。
    child.stdout?.on("data", (chunk: string | Buffer, seq?: number) =>
      this.feedChild(record, live, String(chunk), seq),
    );
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
      const label = record.agent === "pi" ? "pi" : "Claude Code";
      const detail =
        error.code === "ENOENT"
          ? `找不到 ${label} 可执行文件：${cli}`
          : `启动 ${label} 失败：${error.message}`;
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
      if (
        record.agent !== "pi" &&
        !live.killed &&
        !signal &&
        code !== 0 &&
        live.resumed &&
        /no conversation found/i.test(live.stderrTail)
      ) {
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
    return live;
  }

  private onStdout(record: HostedRecord, live: LiveProcess, chunk: string, seq?: number): void {
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
      this.handleEvent(record, live, payload, line);
    }
    if (seq !== undefined) this.advanceSeq(record, seq);
  }

  /** 子进程输出进哪条解析路径：pi 走协议客户端，Claude Code 走 stream-json 解析。 */
  private feedChild(record: HostedRecord, live: LiveProcess, chunk: string, seq?: number): void {
    if (live.pi) {
      live.pi.feed(chunk);
      if (seq !== undefined) this.advanceSeq(record, seq);
      return;
    }
    this.onStdout(record, live, chunk, seq);
  }

  /** sessiond 已经送到第 seq 段输出：记账、ack，顺带合并写盘。 */
  private advanceSeq(record: HostedRecord, seq: number): void {
    record.stdoutSeq = seq;
    this.sessiond?.ack(record.id, seq);
    // 输出很密：两秒内合并成一次写盘，重启时最多重放这一小段。
    if (Date.now() - this.lastPersistAt > 2_000) {
      this.lastPersistAt = Date.now();
      this.persistRecords();
    }
  }

  /** pi 会话：把子进程的 stdin 交给协议客户端，事件回写到托管记录。 */
  private attachPi(record: HostedRecord, live: LiveProcess): void {
    const pi = new PiSession(
      (line) => {
        try {
          live.child.stdin?.write(`${line}\n`);
        } catch {
          // 进程刚退出时写不进去：下一轮发送会重新拉起。
        }
      },
      {
        assistant: (blocks) => {
          if (record.title === "托管会话") {
            const text = blocks.find((block) => block.type === "text" && block.text.trim());
            if (text) record.title = truncateTitle(text.text);
          }
          this.appendRecord(record, {
            messageId: randomUUID(),
            sessionId: record.id,
            role: "assistant",
            createdAt: Date.now(),
            blocks,
          });
          this.touch(record);
        },
        system: (text) => {
          // pi 会自动重试，同一条错误会连着报好几次：只留第一条。
          const list = this.messagesOf(record.id);
          const last = list[list.length - 1];
          if (
            last &&
            last.role === "system" &&
            last.blocks.length === 1 &&
            last.blocks[0]?.type === "text" &&
            last.blocks[0].text === truncate(text, MAX_BLOCK_CHARS).text
          ) {
            return;
          }
          this.appendRecord(record, {
            messageId: randomUUID(),
            sessionId: record.id,
            role: "system",
            createdAt: Date.now(),
            blocks: [{ type: "text", text: truncate(text, MAX_BLOCK_CHARS).text }],
          });
          this.touch(record);
        },
        context: (usage) => {
          record.context = usage;
          this.touch(record);
        },
        pending: (pending) => this.onPiPending(record, live, pending),
        busy: (busy) => {
          live.busy = busy;
          this.touch(record);
        },
        settled: (aborted) => {
          // 这一轮收尾：不再需要续跑，配额清零给下一轮用。
          record.pendingText = undefined;
          record.resumeAttempts = 0;
          if (aborted) record.interrupted = true;
          this.touch(record);
        },
        title: (name) => {
          if (record.title !== "托管会话") return;
          record.title = name.slice(0, MAX_TITLE_CHARS);
          this.touch(record);
        },
        commands: (names) => {
          record.slashCommands = names;
          this.touch(record);
        },
        models: (models) => {
          record.piModels = models;
          this.touch(record);
        },
        model: (id) => {
          if (!MODEL_PATTERN.test(id)) return;
          record.observedModel = id;
          // 第一次跑起来就把实际模型钉住，之后续写仍按同一个模型启动。
          if (!record.model) record.model = id;
          this.touch(record);
        },
        log: (line) => this.log(line),
      },
    );
    live.pi = pi;
    pi.prime();
  }

  /** pi 扩展要用户选/确认/输入：挂到 pending 上，网页作答后回 extension_ui_response。 */
  private onPiPending(record: HostedRecord, live: LiveProcess, pending: PiPending | null): void {
    if (!pending) {
      live.piPending = undefined;
      this.touch(record);
      return;
    }
    live.piPending = pending;
    live.busy = true;
    const options: MessageQuestionOption[] =
      pending.method === "confirm"
        ? [{ label: "是" }, { label: "否" }]
        : pending.options.map((label) => ({ label }));
    const question: MessageQuestion = { question: pending.title, options };
    // 需要自由输入（input/editor）时给一句提示，选项为空，答案直接打字发过来。
    const block: MessageBlock =
      question.options.length > 0
        ? {
            type: "ask",
            text: pending.title,
            ask: pending.title,
            questions: [question],
          }
        : {
            type: "next-step",
            text: pending.message || pending.title,
            ask: pending.title,
            pending: true,
          };
    this.appendRecord(record, {
      messageId: randomUUID(),
      sessionId: record.id,
      role: "assistant",
      createdAt: Date.now(),
      blocks: [block],
    });
    this.touch(record);
  }

  private handleEvent(
    record: HostedRecord,
    live: LiveProcess,
    event: Record<string, unknown>,
    line: string,
  ): void {
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
      // 重连后重投的是同一条待批准请求：transcript 里那一条还在，不再追加一份。
      const replay = record.pendingLine === line && this.alreadyAsked(record, toolName);
      record.pendingLine = line;
      if (replay) {
        this.touch(record);
        return;
      }
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
        if (typeof model === "string" && model && MODEL_PATTERN.test(model)) {
          if (model !== record.observedModel) {
            record.observedModel = model;
            changed = true;
          }
          // 第一次跑起来时把 CLI 实际用的模型钉住：之后本机改了 CLI 默认模型，
          // 这条会话 resume 仍按原模型启动，不会悄悄跟着换掉。
          if (!record.model) {
            record.model = model;
            changed = true;
          }
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
      record.pendingLine = undefined;
      // 这一轮正常收尾：不再需要续跑，配额也清零给下一轮用。
      record.pendingText = undefined;
      record.resumeAttempts = 0;
      // 走代理的模型在 assistant 事件里可能报 0 用量；回合结束时按 CLI 转录里的真实用量兜底。
      const context = contextFromTranscript(record);
      if (context) record.context = context;
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

  /** 重投的权限请求是否已经在 transcript 末尾留过一条待批准消息（避免重启后重复追加）。 */
  private alreadyAsked(record: HostedRecord, toolName: string): boolean {
    const list = this.messagesOf(record.id);
    const last = list[list.length - 1];
    if (!last) return false;
    return last.blocks.some(
      (block) =>
        block.type === "ask" ||
        (block.type === "next-step" && (block.ask ?? block.text).includes(toolName)),
    );
  }

  private answerPermission(record: HostedRecord, live: LiveProcess, text: string): boolean {
    const pending = live.pending;
    if (!pending) return false;
    if (pending.questions && pending.questions.length > 0) {
      const answers = answersFromText(text, pending.questions);
      this.respondControl(record, live, pending.requestId, {
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
      this.respondControl(record, live, pending.requestId, { behavior: "allow", updatedInput: pending.input });
      live.pending = null;
      live.busy = true;
      this.touch(record);
      return true;
    }
    if (/^(拒绝|不允许|不同意|deny|no|n)$/i.test(trimmed)) {
      this.respondControl(record, live, pending.requestId, { behavior: "deny", message: "用户拒绝" });
      live.pending = null;
      live.busy = false;
      this.touch(record);
      return true;
    }
    return false;
  }

  /** 应答一条权限请求，并清掉断线恢复用的原始行：这条请求已经有结论了。 */
  private respondControl(
    record: HostedRecord,
    live: LiveProcess,
    requestId: string,
    response: Record<string, unknown>,
  ): void {
    record.pendingLine = undefined;
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
      archived: record.archived === true,
      live: Boolean(live),
      busy: live?.busy ?? false,
      needsDecision: Boolean(live?.pending || live?.piPending),
      canSend: dirExists,
      hosted: true,
      hostedState: live ? "running" : "stopped",
      ...(record.agent === "pi" ? { hostedAgent: "pi" as const } : {}),
      permissionMode: record.permissionMode,
      ...(record.model ?? record.observedModel ? { model: record.model ?? record.observedModel } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.subagentModel ? { subagentModel: record.subagentModel } : {}),
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

  /** 网页加的启动参数：每项按空格拆成 argv，挡掉 Bridge 自己那套会话与权限旗标。 */
  private extraArgs(values: string[] | undefined, agent: HostedAgent = "claude"): string[] | undefined {
    const tokens: string[] = [];
    const blocked = agent === "pi" ? BLOCKED_PI_ARGS : BLOCKED_EXTRA_ARGS;
    for (const value of values ?? []) {
      if (typeof value !== "string") continue;
      if (value.length > MAX_EXTRA_ARG_CHARS) {
        throw new RpcError("invalid_params", `启动参数过长（上限 ${MAX_EXTRA_ARG_CHARS} 字）：${value.slice(0, 40)}…`);
      }
      for (const token of value.trim().split(/\s+/)) {
        if (!token) continue;
        const flag = token.split("=")[0] ?? token;
        if (blocked.has(flag)) {
          throw new RpcError("invalid_params", `启动参数不接受 ${flag}：会话身份与权限由 Bridge 按会话记录设置`);
        }
        tokens.push(token);
      }
    }
    return tokens.length > 0 ? tokens.slice(0, MAX_EXTRA_ARGS) : undefined;
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
      killProcess(live.child, "SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref();
    // 自成进程组的（本机 spawn）杀整组，pi 的 workflow 起的孙进程也一起收掉。
    killProcess(live.child, "SIGTERM");
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
      // 接回过的子进程万一没停掉，守护进程里还会留着：下次发消息就会接回旧进程。
      void this.stopInSessiond(id);
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
          ...(item["agent"] === "pi" ? { agent: "pi" as const } : {}),
          permissionMode: this.permissionMode(
            typeof item["permissionMode"] === "string" ? item["permissionMode"] : "manual",
          ),
          // 记录里的模型名不可信：校验不过就当没写，别让一条坏记录拖垮整个注册表。
          ...(typeof item["model"] === "string" && MODEL_PATTERN.test(item["model"]) ? { model: item["model"] } : {}),
          ...(typeof item["effort"] === "string" && /^[a-z][a-z-]{0,15}$/.test(item["effort"])
            ? { effort: item["effort"] }
            : {}),
          ...(typeof item["subagentModel"] === "string" && MODEL_PATTERN.test(item["subagentModel"])
            ? { subagentModel: item["subagentModel"] }
            : {}),
          ...(Array.isArray(item["args"]) ? { args: sanitizeExtraArgs(item["args"]) } : {}),
          ...(typeof item["observedModel"] === "string" && MODEL_PATTERN.test(item["observedModel"])
            ? { observedModel: item["observedModel"] }
            : {}),
          ...(item["interrupted"] === true ? { interrupted: true } : {}),
          ...(typeof item["pendingText"] === "string" && item["pendingText"]
            ? { pendingText: item["pendingText"] }
            : {}),
          ...(typeof item["resumeAttempts"] === "number" && item["resumeAttempts"] > 0
            ? { resumeAttempts: Math.floor(item["resumeAttempts"]) }
            : {}),
          ...(typeof item["stdoutSeq"] === "number" && item["stdoutSeq"] > 0
            ? { stdoutSeq: Math.floor(item["stdoutSeq"]) }
            : {}),
          ...(typeof item["pendingLine"] === "string" && item["pendingLine"]
            ? { pendingLine: item["pendingLine"] }
            : {}),
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

  /** 上下文用量的记录晚于会话本身：老记录缺这个字段，启动时从 CLI 转录里补一次。 */
  private backfillContext(): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.context) continue;
      const context = contextFromTranscript(record);
      if (!context) continue;
      record.context = context;
      changed = true;
    }
    if (changed) this.persistRecords();
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
              ...(record.agent ? { agent: record.agent } : {}),
              permissionMode: record.permissionMode,
              ...(record.model ? { model: record.model } : {}),
              ...(record.effort ? { effort: record.effort } : {}),
              ...(record.subagentModel ? { subagentModel: record.subagentModel } : {}),
              ...(record.args?.length ? { args: record.args } : {}),
              ...(record.observedModel ? { observedModel: record.observedModel } : {}),
              ...(record.interrupted ? { interrupted: record.interrupted } : {}),
              ...(record.pendingText ? { pendingText: record.pendingText } : {}),
              ...(record.resumeAttempts ? { resumeAttempts: record.resumeAttempts } : {}),
              ...(record.stdoutSeq ? { stdoutSeq: record.stdoutSeq } : {}),
              ...(record.pendingLine ? { pendingLine: record.pendingLine } : {}),
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

/** CLI 把每个会话的转录写在 ~/.claude/projects/<cwd>/<id>.jsonl，末尾那条 assistant 带着用量。 */
function contextFromTranscript(record: HostedRecord): ContextUsage | undefined {
  const root = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }
  const file = dirs.map((dir) => join(root, dir, `${record.id}.jsonl`)).find((path) => existsSync(path));
  if (!file) return undefined;
  let text: string;
  let truncated = false;
  try {
    truncated = statSync(file).size > TRANSCRIPT_TAIL_BYTES;
    text = readTail(file, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  // 从中间截断的第一行不完整，丢掉。
  if (truncated) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.includes('"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["type"] !== "assistant") continue;
    const message = isRecord(entry["message"]) ? entry["message"] : {};
    const reported = typeof message["model"] === "string" ? message["model"] : "";
    // 转录里的模型名会丢掉 [1m] 这类后缀，窗口上限以会话记录的模型为准。
    const context = contextUsageFromUsage(
      message["usage"],
      record.observedModel || reported || record.model || "",
    );
    if (context) return context;
  }
  return undefined;
}

/** 只读文件末尾这么多个字节：转录可能几十 MB，整份读进内存不值当。 */
function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
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
