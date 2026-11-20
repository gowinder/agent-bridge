import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_COMPACTION_TRIGGER_PERCENT } from "@craftstead/protocol";
import type {
  ContextUsage,
  HostedAgent,
  HostedAgentOption,
  HostedCreateDefaults,
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
  RailTask,
  SessionModelsResult,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText } from "../adapters/types.js";
import { toolSummaryOf } from "../tool-summary.js";
import {
  contextUsageFromUsage,
  sanitizeContextUsage,
  sessionTokensOf,
  tokenUsageFromClaude,
} from "../context-usage.js";
import { effortLevels } from "../effort.js";
import { modelCatalog } from "../model-catalog.js";
import { subagentTasks } from "../subagents.js";
import { defaultStateDir } from "../store.js";
import { piBinary } from "./pi-binary.js";
import { piAgentSourceDir, preparePiAgentDir, removePiAgentDir } from "./pi-agent-dir.js";
import { piDefaultModel, piModelCatalog, piModelContextWindow } from "./pi-models.js";
import { PiSession, type PiPending } from "./pi-session.js";
import { MAX_PI_TASKS, piSubagentRunning, piSubagentRunnerPids, piSubagentTasks } from "./pi-subagents.js";
import { claudeTaskMessages, piTaskMessages } from "./task-messages.js";
import { killProcess, markProcessGroup } from "./process-group.js";
import { SessionTrees, killTree, snapshotProcesses, subtree } from "./process-tree.js";
import { SessiondBridge } from "./sessiond/bridge.js";
import { FsScope, FsScopeError } from "../fs-scope.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 60_000;
/**
 * 一轮忙着的会话多久没有输出就标记成「疑似卡住」，多久检查一次。
 * 选 2 分钟：正常一轮里的工具调用间隔远小于它，而等系统授权弹窗／等网络会一直挂着。
 */
const DEFAULT_STALL_MS = 120_000;
const STALL_CHECK_MS = 15_000;
const MAX_BLOCK_CHARS = 4_000;
export const MAX_TITLE_CHARS = 60;
const KILL_GRACE_MS = 2_000;
/** 每隔这么久把在跑会话的后代登进内存：detached 出去的孙进程停止时只能靠这份表找回。 */
const TREE_SCAN_MS = 1_000;
/** 进程自己退出（不是被停）时，给登记表里的残留后代下 SIGTERM 到 SIGKILL 的宽限。 */
const ORPHAN_GRACE_MS = 500;
/** 补算老会话的上下文用量时只读转录尾部这么多字节。 */
const TRANSCRIPT_TAIL_BYTES = 262_144;
/**
 * CLI 模型名允许的字符集：普通标识符 + 完整 ID 里的括号/点/冒号，再加路由器的 `厂商/模型`
 * 与 `组/子组`（例如 `ncncapi/claude-opus-5-5`、`group/dsgroup`）；不能以 `-` 开头。
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,79}$/;
/** pi 的思考等级（`pi --thinking` 与 pi-subagents 的 `thinking` 同一套，从低到高）。 */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 托管白名单最多这么多个目录：多到这份上说明是没整理过的清单，容易点错。 */
const MAX_HOSTED_DIRS = 64;

function PROBED_OK(path: string): string {
  return `目录已授权可读：${path}`;
}

function PROBE_TIMEOUT(path: string): string {
  return `等待系统授权超时（${DIR_PROBE_TIMEOUT_MS / 1000} 秒）：${path}`;
}

function DENIED_NOTE(path: string): string {
  return `macOS 拒绝访问这个目录：${path}（到「系统设置 → 隐私与安全性 → 文件与文件夹」勾选 AgentBridge，或重新点一次「+」再授权）`;
}

/** 目录授权探测的结果：`unknown` 只表示「还没探过」。 */
type DirAuth = "ok" | "denied" | "pending" | "unknown";

/**
 * 探测目录可读性的超时。弹框没人点就一直是 pending：既不当成可读（会让会话卡住），
 * 也不当成拒绝（用户可能只是还没回来点）。
 */
const DIR_PROBE_TIMEOUT_MS = 20_000;

/**
 * 启动后重新探一遍「已授权」的目录。
 *
 * `dir-auth.json` 里的 ok 不会自己失效：用户在系统设置里撤销授权、外置卷换了名字、
 * 目录被换成另一个挂载点之后，UI 还显示一切正常，真读时却又弹框/挂住。已授权的 readdir
 * 不弹框、只要几毫秒，所以启动后补探一次是便宜的。延迟到启动完再做，避免和启动抢 IO。
 */
const REPROBE_OK_DELAY_MS = 30_000;
/** 自动压缩阈值（`compaction.reserveTokens`）的上限：再大就每轮都压，没意义。 */
const MAX_COMPACTION_RESERVE_TOKENS = 1_000_000;
/** 网页能加的启动参数最多这么多项、每项这么长，免得把 argv 撑爆。 */
const MAX_EXTRA_ARGS = 24;
const MAX_EXTRA_ARG_CHARS = 200;
/** pi 会话文件的路径上限（`new_session` 报回来、下次 resume 用 `--session`）。 */
const MAX_SESSION_PATH_CHARS = 4_096;
/**
 * Bridge 自己在托管会话里执行的斜杠命令：pi 的 RPC 有对应动作，不必把整行当消息发给模型。
 * 其余内置命令（`/tree`、`/login`、`/mcp` 之类）依赖终端交互或进程级设置，仍然只属于终端。
 */
const BRIDGE_SLASH_COMMANDS = ["compact", "export", "model", "name", "new", "session", "thinking"] as const;
/** `/quit` 在终端里是退出；托管会话里等价于停掉这个会话的进程。 */
const BRIDGE_QUIT_COMMAND = "quit";
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
  "--fork-session",
  "--session-id",
  "--input-format",
  "--output-format",
  "--permission-mode",
  "--permission-prompts",
  "--permission-prompt-tool",
  "--dangerously-skip-permissions",
  // settings 文件里能写 permissions.allow 和 hooks，等于绕过上面的模式门禁。
  "--settings",
  // 这组能把白名单之外的目录拉进工作区、或换一套 MCP / 工具配置：
  // 白名单管的是「能建在哪」，这些旗标一放，目录边界就没了。
  "--add-dir",
  "--mcp-config",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--append-system-prompt",
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

/** `/new` 报回来的会话文件路径要直接进 argv：只接受绝对路径，且不能夹带换行/空字节。 */
function sanitizeSessionPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path.startsWith("/") || path.length > MAX_SESSION_PATH_CHARS) return undefined;
  if (/[\r\n\0]/.test(path)) return undefined;
  return path;
}

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
  /** 上一次新建托管会话用的选项：网页下次打开新建面板时据此预填。 */
  lastCreate?: HostedCreateDefaults;
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
  /** pi 会话的思考等级（`--thinking`）；缺省跟随 pi 自己的设置。 */
  thinking?: string;
  /** pi 会话：新派生的子代理的思考等级（settings.json 的 `subagents.defaultThinking`）。 */
  subagentThinking?: string;
  /** pi 会话：自动压缩触发点，占上下文窗口的百分比（1–100）；缺省用 Bridge 默认值。 */
  compactionTriggerPercent?: number;
  /** 旧字段：直接写死的预留 token 数；老记录里才会出现，新设置只用百分比。 */
  compactionReserveTokens?: number;
  /** pi 会话在 `/new` 之后用的新会话文件：续写要按 `--session <路径>` 而不是 `--session-id`。 */
  piSessionPath?: string;
  /** pi 自己的命令清单（`get_commands` 原样）：同名时让给 pi 的扩展命令，Bridge 不截流。 */
  piCommands?: string[];
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
  /** 最近一次收到子进程输出的时刻：没有输出的空转就是这里在涨。 */
  lastOutputAt: number;
  /** 无输出超过阈值时置位（取值为「开始算卡住」的时刻），恢复输出就清掉。 */
  stalledSince?: number;
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
  /** 无输出多久判为卡住（毫秒）；测试用短值。 */
  stallMs?: number;
  /** 卡住检查的间隔（毫秒）；测试用短值。 */
  stallCheckMs?: number;
  /** 测试用：替换「真的读一次目录」这一步；默认起子进程。 */
  probeDir?: (path: string) => Promise<"ok" | "denied" | "timeout" | "unknown">;
  /** 启动后多久复核已授权的目录（毫秒）；测试用短值。 */
  reprobeDelayMs?: number;
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
  /**
   * 每个会话的后代 pid 登记表。
   *
   * 托管进程派生的子代理 runner 是 detached 起的（自成一个进程组），停会话时按组杀
   * 收不到它们，所以跑着的时候就把后代 pid 记下来，停的时候按 pid 点名。
   */
  private readonly trees = new SessionTrees();
  /** 正在被我们主动收尾的会话：退出事件不必再扫一遍（停止流程自己会核对）。 */
  private readonly stopping = new Set<string>();
  private treeTimer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  /** 无输出检查：只负责把「疑似卡住」标出来，从不替用户点掉系统弹窗。 */
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly stallMs: number;
  private readonly stallCheckMs: number;
  /** 枚举收口：记录里的 cwd 可能早就从白名单里删了，不能直接 stat。 */
  private readonly fs: FsScope;
  /**
   * 白名单目录的两种写法：`~` 展开后的原样值，以及 realpath 之后的值。
   * `record.cwd` 存的是 realpath 后的（`allowedPath` 的 canonical），只认原样值会把
   * 符号链接的白名单目录判成越界，会话从此发不出消息。
   */
  private dirsCache: { at: number; list: { raw: string; real: string }[] } | null = null;
  /**
   * 每个白名单目录到底能不能读。
   *
   * TCC 的授权要等第一次**真读**（`readdir`/`open`）才生效：加目录时只做 `realpath`/`stat`
   * 不会弹框，于是「目录加好了」和「目录真的能用」中间隔着一层系统授权。人不在 Mac 前时
   * 那次弹框没人点，读目录的调用就挂在那里，整个会话卡住。所以这里在加目录的那一刻主动
   * 探一次：授权提前到用户在设置里点「+」的时候。
   */
  private readonly dirAuth = new Map<string, DirAuth>();
  /**
   * 正在排队或探测中的目录 → 登记号。
   *
   * 用登记号而不是单纯一个集合：路径可能「移除 → 立刻加回」，旧探测的结果回来时不能把
   * 新登记的探测当成自己收掉（否则新探测永远不跑，队列跟着停）。
   */
  private readonly probing = new Map<string, number>();
  private probeToken = 0;
  /**
   * 探测排队：一次只放一个弹窗出去。
   *
   * 每个探测都可能弹一个系统授权框，同时起五个就是五个框糊在用户脸上。加目录本来就是
   * 一个一个加的动作，所以这里严格串行：前一个出结果（或超时）才轮到下一个。
   */
  private readonly probeQueue: string[] = [];
  private probeRunning = false;
  private probeCancel: (() => void) | null = null;
  private reprobeTimer: NodeJS.Timeout | null = null;
  /** 启动后复核的那些探测：结果 ok 时不改动状态，只有降级才写。 */
  private readonly silentProbes = new Set<string>();
  private readonly probeImpl: ((path: string) => Promise<"ok" | "denied" | "timeout" | "unknown">) | null;
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
    this.fs = new FsScope({
      roots: () => this.allowDirs().flatMap((dir) => [dir.real, dir.raw]),
      log: this.log,
    });
    this.probeImpl = options.probeDir ?? null;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.stallCheckMs = options.stallCheckMs ?? STALL_CHECK_MS;
    this.loadDirAuth();
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
    this.stallTimer = setInterval(() => this.checkStalls(), this.stallCheckMs);
    this.stallTimer.unref();
    this.reprobeTimer = setTimeout(() => this.reprobeAllowedDirs(), options.reprobeDelayMs ?? REPROBE_OK_DELAY_MS);
    this.reprobeTimer.unref();
    process.once("exit", this.exitHandler);
  }

  /**
   * 白名单目录的 raw / realpath 两种写法（缓存 5 秒）。
   *
   * 白名单是用户自己点过头的根，对它 realpath 是安全的；客户端的路径永远不 realpath，
   * 见 `allowedPath()`。
   */
  private allowDirs(): { raw: string; real: string }[] {
    if (this.dirsCache && Date.now() - this.dirsCache.at < 5_000) return this.dirsCache.list;
    const list = this.config.dirs.map((entry) => {
      const raw = expandHome(entry);
      return { raw, real: canonical(raw) ?? raw };
    });
    this.dirsCache = { at: Date.now(), list };
    return list;
  }

  configForClient(): HostedDirsResult {
    const dirs: HostedDirInfo[] = [];
    const seen = new Set<string>();
    // 手改 hosted.json 时目录可能写成非 canonical 的写法（`~/link/...`），而授权状态是按
    // canonical 记的：查表两种写法都试一次，不然会误报「未授权」。
    const realByRaw = new Map(this.allowDirs().map((dir) => [dir.raw, dir.real]));
    for (const raw of this.config.dirs) {
      const path = expandHome(raw);
      const exists = this.cwdExists(path);
      dirs.push({
        path,
        name: basename(path) || path,
        sessionCount: [...this.records.values()].filter((record) => record.cwd === path).length,
        exists,
        allowed: true,
        auth: this.dirAuth.get(path) ?? this.dirAuth.get(realByRaw.get(path) ?? "") ?? "unknown",
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
        allowed: false,
      });
      seen.add(record.cwd);
    }
    const result: HostedDirsResult = {
      enabled: this.config.dirs.length > 0,
      dirs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      permissionModes: this.remotePermissionModes(),
      allowBypassPermissions: this.config.allowBypassPermissions,
      ...(this.config.lastCreate ? { lastCreate: this.config.lastCreate } : {}),
    };
    if (!result.enabled) {
      result.note = `尚未配置可托管的目录：编辑 ${join(this.stateDir, "hosted.json")} 的 dirs 后重启 Bridge`;
    }
    return result;
  }

  /** 设置界面改完 hosted.json 后重新读一次，不用重启 Bridge。 */
  reloadConfig(): void {
    this.config = readConfig(this.stateDir);
    this.dirsCache = null;
  }

  /**
   * 主动读一次目录，把 TCC 授权弹框提前到「加目录」这一刻。
   *
   * 必须走子进程：弹框没人点的时候，那个 `readdir` 会一直挂着（上一版就是会话里的 `find`
   * 挂了两小时，把单线程的 Bridge 一起拖死）。子进程挂着不占主线程，超时直接杀掉，主线程
   * 只拿到一个「还在等授权」的状态。
   */
  private probeDir(path: string, silent = false): void {
    if (this.probing.has(path)) return;
    this.probing.set(path, ++this.probeToken);
    // silent 用于启动后复核已授权的目录：不把 UI 打回「等待授权」，只在结果变差时降级。
    if (!silent) this.dirAuth.set(path, "pending");
    this.probeQueue.push(path);
    if (silent) this.silentProbes.add(path);
    this.drainProbeQueue();
  }

  /** 启动后复核一遍已授权的目录：授权被撤销时把它们降级成 denied。 */
  private reprobeAllowedDirs(): void {
    this.reprobeTimer = null;
    const seen = new Set<string>();
    for (const entry of this.config.dirs) {
      const path = expandHome(entry);
      if (this.dirAuth.get(path) !== "ok") continue;
      if (seen.has(path)) continue;
      seen.add(path);
      this.probeDir(path, true);
    }
  }

  /** 队列里一次只跑一个：一个目录一个弹窗，不并发。 */
  private drainProbeQueue(): void {
    if (this.probeRunning) return;
    let path: string | undefined;
    let token = 0;
    // 排队期间目录可能被移出白名单（probing 里已经删掉）：跳过，别为它弹框。
    while ((path = this.probeQueue.shift()) !== undefined) {
      const current = this.probing.get(path);
      if (current !== undefined) {
        token = current;
        break;
      }
      path = undefined;
    }
    if (path === undefined) return;
    this.probeRunning = true;
    let settled = false;
    const done = (result: "ok" | "denied" | "timeout" | "unknown", note: string): void => {
      if (settled) return;
      settled = true;
      this.probeRunning = false;
      this.probeCancel = null;
      // 路径被移除后又加回来时登记号已经变了：这个结果作废，别把新的探测收掉。
      if (this.probing.get(path) === token) {
        this.probing.delete(path);
        this.finishProbe(path, result === "timeout" ? "pending" : result, note);
      }
      this.drainProbeQueue();
    };
    this.probeCancel = this.startProbe(path, done);
  }

  /** 起一次探测，返回取消函数。默认走子进程：弹窗没人点时挂的是它，不是 Bridge 主线程。 */
  private startProbe(
    path: string,
    done: (result: "ok" | "denied" | "timeout" | "unknown", note: string) => void,
  ): () => void {
    if (this.probeImpl) {
      void this.probeImpl(path).then(
        (result) => done(result, result === "ok" ? PROBED_OK(path) : result === "denied" ? DENIED_NOTE(path) : PROBE_TIMEOUT(path)),
        (error: unknown) => done("denied", `探测目录失败：${path}（${String(error)}）`),
      );
      return () => undefined;
    }
    // 目录当 argv 传，不拼进脚本：路径里有引号也不会变成代码。
    // 退出码区分「系统不给读」与「其它失败」：把「目录被删了」说成「去系统设置授权」是指错方向。
    const script =
      "try{require('fs').readdirSync(process.argv[1]);}" +
      "catch(e){process.exit(e&&(e.code==='EPERM'||e.code==='EACCES')?2:1)}";
    const child = nodeSpawn(process.execPath, ["-e", script, path], {
      stdio: "ignore",
    });
    const cancel = (): void => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
    // 弹框没人点：留 pending，进程杀掉。既不当可读（会让会话挂住），也不当拒绝
    // （用户可能只是还没回来）。
    const timer = setTimeout(() => {
      done("timeout", PROBE_TIMEOUT(path));
      cancel();
    }, DIR_PROBE_TIMEOUT_MS);
    timer.unref();
    child.on("error", (error) => {
      done("denied", `探测目录失败：${path}（${String(error)}）`);
      cancel();
    });
    child.on("exit", (code, signal) => {
      // 外部把探测子进程杀掉（不是我们的取消）：队列不能就此停摆，按超时收尾。
      if (signal) {
        done("timeout", PROBE_TIMEOUT(path));
        return;
      }
      if (code === 0) done("ok", PROBED_OK(path));
      else if (code === 2) done("denied", DENIED_NOTE(path));
      else done("unknown", `探测目录失败（退出码 ${code}）：${path}`);
      cancel();
    });
    return cancel;
  }

  private finishProbe(path: string, auth: DirAuth, note: string): void {
    // 探测期间目录被移出白名单：结果作废（不能把一个已经删掉的目录写回 dir-auth.json）。
    if (!this.dirAuth.has(path)) {
      this.silentProbes.delete(path);
      return;
    }
    if (this.silentProbes.delete(path)) {
      // 复核：没变差就当没发生，避免 UI 闪一下「未授权」又变回来。
      if (auth === "ok" || this.dirAuth.get(path) !== "ok") return;
    } else if (this.dirAuth.get(path) !== "pending") {
      return;
    }
    this.dirAuth.set(path, auth);
    this.persistDirAuth();
    this.log(`hosted: ${note}`);
  }

  private dirAuthPath(): string {
    return join(this.hostedDir(), "dir-auth.json");
  }

  private loadDirAuth(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.dirAuthPath(), "utf8"));
    } catch {
      return; // 没有这个文件：全部算「还没探过」。
    }
    if (!isRecord(parsed)) return;
    for (const [path, value] of Object.entries(parsed)) {
      // pending 是「当时没人点框」，不能持久化，否则重启后再也不弹。
      if (value === "ok" || value === "denied") this.dirAuth.set(path, value);
    }
  }

  private persistDirAuth(): void {
    const payload: Record<string, string> = {};
    for (const [path, auth] of this.dirAuth) {
      if (auth === "ok" || auth === "denied") payload[path] = auth;
    }
    try {
      // 一条 ok/denied 都没有时不落文件：pending 不该被持久化成「探过了」。
      if (Object.keys(payload).length === 0) {
        rmSync(this.dirAuthPath(), { force: true });
        return;
      }
      mkdirSync(this.hostedDir(), { recursive: true, mode: 0o700 });
      const tmp = `${this.dirAuthPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      renameSync(tmp, this.dirAuthPath());
    } catch (error) {
      this.log(`hosted: 记录目录授权状态失败：${String(error)}`);
    }
  }

  /**
   * 读盘、改几个键、写回：运行中手改过 hosted.json（还没重启）时，不会被内存里的旧配置冲掉。
   * 只用于「顺手记一下」的改动；改 dirs 这类设置仍走 writeConfig。
   */
  private patchConfigFile(patch: Record<string, unknown>): void {
    const path = join(this.stateDir, "hosted.json");
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) raw = parsed;
    } catch {
      // 没有文件或内容坏了：按只有这几项的新配置写。
    }
    Object.assign(raw, patch);
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
  }

  /** 只改 allowBypassPermissions，其余键原样保留；写盘后立即生效。 */
  setAllowBypassPermissions(enabled: boolean): HostedDirsResult {
    this.patchConfigFile({ allowBypassPermissions: enabled });
    this.reloadConfig();
    return this.configForClient();
  }

  /**
   * 整份替换托管白名单。只给本机 admin 接口用：远程设备不能让白名单多出目录，
   * 否则「只有白名单里的目录能建会话」这层限制等于没有。
   */
  setDirs(input: string[], probe: string[] = []): HostedDirsResult {
    const dirs: string[] = [];
    const previous = new Set(this.config.dirs.map((dir) => this.compareDir(dir)));
    const current = previous;
    for (const item of input) {
      const raw = String(item ?? "").trim();
      if (!raw) continue;
      const target = this.normalizeDir(raw);
      if (!isDirectory(target)) {
        // 已经在白名单里的目录被删了：跳过，不要让整份写入失败。否则只要留着一个
        // 早已删掉的旧目录，「添加目录」就永远报错，而界面上没有移除入口。
        if (current.has(this.compareDir(target))) {
          this.log(`hosted: 跳过已不存在的托管目录 ${target}`);
          continue;
        }
        throw new RpcError("invalid_params", `目录不存在：${target}`);
      }
      if (!dirs.includes(target)) dirs.push(target);
    }
    if (dirs.length > MAX_HOSTED_DIRS) {
      throw new RpcError("invalid_params", `托管目录最多 ${MAX_HOSTED_DIRS} 个`);
    }
    if (dirs.join("\n") !== this.config.dirs.join("\n")) {
      // 被移出白名单的目录：授权状态与排队的探测一起清掉，免得「已经删掉的目录」还在
      // 等授权、还在写 dir-auth.json。正在跑的那个不硬杀（弹窗已经弹出去了，杀掉只是
      // 让它闪一下），结果回来时由 finishProbe 的守卫丢弃。
      const kept = new Set(dirs);
      for (const path of [...this.dirAuth.keys()]) {
        if (kept.has(path)) continue;
        this.dirAuth.delete(path);
        this.probing.delete(path);
        const queued = this.probeQueue.indexOf(path);
        if (queued >= 0) this.probeQueue.splice(queued, 1);
      }
      this.persistDirAuth();
      this.config = { ...this.config, dirs };
      // 白名单换了，授权根缓存与闸门里的工程根立刻作废：否则刚被移除的目录还能建会话。
      this.dirsCache = null;
      this.writeConfig();
      this.log(`hosted: 白名单改为 ${dirs.length} 个目录`);
    }
    // 只探「这次新加的」和客户端显式要求重探的（菜单栏点「+」重新添加已存在的目录）。
    // 整份写回时不能把其它未授权目录也排一遍：删一个目录会让剩下的挨个弹框。
    const asked = new Set<string>();
    for (const item of probe) {
      try {
        asked.add(this.normalizeDir(String(item ?? "")));
      } catch {
        // 客户端给了不存在的路径：忽略，别让整份写入失败。
      }
    }
    for (const target of dirs) {
      if (this.dirAuth.get(target) === "ok") continue;
      if (previous.has(this.compareDir(target)) && !asked.has(target)) continue;
      this.probeDir(target);
    }
    return this.configForClient();
  }

  /**
   * 目录已经不在时 realpath 会失败，退一步解析父目录：这样 `/var/…` 与 `/private/var/…`
   * 这类系统性符号链接能对齐，否则「早已删掉、但还在白名单里」的旧目录永远匹配不上。
   */
  private compareDir(path: string): string {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
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
      ...(this.config.lastCreate ? { lastCreate: this.config.lastCreate } : {}),
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
      if (this.cwdExists(path)) push(path);
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

  /**
   * 托管会话的转录同时也躺在对应 CLI 自己的会话目录里（pi 在 `~/.pi/agent/sessions`，
   * sessions 整目录软链回用户目录），适配器会把同一段对话再列一遍；改过名后两边标题对不上，
   * 历史里就是两条。这里给出 pi 要认领的原生会话 id，由会话列表把 pi 那份剔掉，
   * 保留带改名与运行状态的托管记录。
   */
  hostedNativeSessionIds(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const claim = (adapterKey: string, id: string): void => {
      const bucket = out.get(adapterKey) ?? new Set<string>();
      bucket.add(id);
      out.set(adapterKey, bucket);
    };
    for (const record of this.records.values()) {
      // 只有 pi 需要认领：claude 桌面索引里的 id 是 `local_*`，不是 CLI 的 `--session-id`，
      // 对不上；而 claude-code-cli 适配器本来就按 hosted/sessions.json 排除托管会话。
      if (record.agent !== "pi") continue;
      for (const id of this.piSessionIds(record)) claim("pi", id);
    }
    return out;
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
      // 找不到游标就报错，别静默退回最新一页：网页那边会以为「加载更早」点了没反应。
      if (index === -1) throw new RpcError("invalid_params", "未知的分页游标");
      end = index;
    }
    const start = Math.max(0, end - page.limit);
    // 全文留到 message.text 再给，列表里还是截到 MAX_BLOCK_CHARS：帧大小与渲染成本不变。
    const pageMessages = all.slice(start, end).map(trimMessageForList);
    const live = this.live.get(record.id);
    const result: MessageListResult = {
      messages: pageMessages,
      completeness: "complete",
      busy: this.busyOf(record),
      ...(record.interrupted ? { interrupted: true } : {}),
      ...(record.context ? { context: record.context } : {}),
      ...(record.slashCommands ? { slashCommands: record.slashCommands } : {}),
    };
    const tokens = sessionTokensOf(all);
    if (tokens) result.tokens = tokens;
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
    let all: MessageRecord[] | null | undefined;
    if (record.agent === "pi") {
      // `/new` 之后的 run 记在 pi 的新会话 id 下，rail 列得出来，这里也得读得到。
      for (const id of this.piSessionIds(record)) {
        all = piTaskMessages(id, taskId);
        if (all) break;
      }
    } else {
      all = claudeTaskMessages(record.id, taskId);
    }
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
    const tokens = sessionTokensOf(this.messagesOf(record.id));
    return {
      ...(tokens ? { tokens } : {}),
      environment: [
        { label: "工作目录", value: record.cwd },
        ...(pi
          ? [{ label: "引擎", value: "pi 托管" }]
          : [
              { label: "权限模式", value: record.permissionMode },
              { label: "思考程度", value: record.effort ?? "CLI 默认" },
            ]),
        { label: "模型", value: modelLabel(record) },
        ...(pi
          ? [
              { label: "思考等级", value: record.thinking ?? "跟随 pi 设置" },
              { label: "子代理模型", value: record.subagentModel ?? "跟随 pi 设置" },
              { label: "子代理思考等级", value: record.subagentThinking ?? "跟随 pi 设置" },
              { label: "自动压缩", value: this.compactionLabel(record) },
            ]
          : []),
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
      tasks: pi ? this.piTasks(record) : subagentTasks([record.id]),
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
    const thinking = agent === "pi" ? this.thinkingLevel(params.thinking) : undefined;
    const subagentThinking = agent === "pi" ? this.thinkingLevel(params.subagentThinking) : undefined;
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
      ...(thinking ? { thinking } : {}),
      ...(subagentThinking ? { subagentThinking } : {}),
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
    try {
      this.rememberCreateDefaults(agent, permissionMode, { model, effort, subagentModel, thinking, subagentThinking });
    } catch (error) {
      // 记住默认值只是下次新建时省点事：写 hosted.json 失败不该让已经起来的会话看起来创建失败。
      this.log(`hosted: 记住新建选项失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
    // 删记录前把后代收干净：记录一删，子代理 runner 的归属就查不到了。
    const { leftover } = await this.teardown(record.id);
    if (leftover.length > 0) this.log(`hosted: remove ${record.id} 仍有后代没停掉：${leftover.join(", ")}`);
    this.messages.delete(record.id);
    try {
      rmSync(this.transcriptPath(record.id), { force: true });
    } catch (error) {
      this.log(`hosted: remove transcript failed: ${String(error)}`);
    }
    removePiAgentDir(this.piAgentDirOf(record.id));
    this.trees.forget(record.id);
    this.stopping.delete(record.id);
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
    if (!this.cwdExists(record.cwd)) {
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
    // 进程组收不到 setsid 出去的后台子代理（pi-subagents 的后台 runner 就是），
    // teardown 会按 pid 逐个收，并把收不掉的 pid 带出来。
    const { leftover, stopped } = await this.teardown(record.id);
    const result: HostedStopResult = { stopped, session: this.summary(record) };
    if (leftover.length > 0) {
      // 停不干净不能默默返回成功：把 pid 交出去，日志里也留一条。
      this.log(`hosted: stop ${record.id} 还有 ${leftover.length} 个后代进程没杀掉：${leftover.join(", ")}`);
      result.leftover = leftover;
    }
    return result;
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
      if (record.subagentThinking) result.subagentThinking = record.subagentThinking;
      result.canSwitchThinking = true;
      result.canSwitchSubagentThinking = true;
      result.thinkingLevels = [...PI_THINKING_LEVELS];
      if (record.thinking) result.thinking = record.thinking;
      result.note =
        models.length > 0
          ? "思考等级立刻生效（改回跟随 pi 设置要重启进程）；换模型会停掉当前 pi 进程，下一条消息按新模型重新打开这个会话；子代理的设置只影响之后新派生的子代理。"
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
    if (this.busyOf(record) || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再换模型");
    }
    // 先停进程再改记录：停不掉就报错，别让界面显示新模型而进程还跑着旧的。
    // 旧进程连它派生的子代理一起收（下面统一走 teardown）。
    // 换模型必须让旧进程真的退出，否则下一条消息会接回还在跑的那一个，模型没换。
    // 守护进程里没有跟踪到的旧进程（上一代 Bridge 留下的）也只能由它杀掉。
    // 旧进程派生的后台子代理是 detached 起的，不在进程组里：必须按 pid 收掉，
    // 收不干净就不能装作切换成功。
    const { leftover } = await this.teardown(record.id, { strict: true });
    if (leftover.length > 0) {
      throw new RpcError("conflict", `旧进程派生的进程没停掉，设置没有切换：${leftover.join(", ")}`);
    }
    if (model) record.model = model;
    else delete record.model;
    // 实际模型是上一轮 init 报的，换了模型旧值就作废，下次运行重新记录。
    delete record.observedModel;
    this.touch(record);
    return this.summary(record);
  }

  /**
   * 只改这个会话派生子代理用的模型或思考等级（只对 pi 有效）。
   * pi 只在启动时读 settings.json，所以空闲进程要先停掉，下一条消息按新设置重新打开会话；
   * 已经在跑的子代理不受影响，只有之后新派生的才用新设置。
   * 传 null 表示改回跟随 pi 自己的设置。
   */
  async setSubagentModel(sessionId: string, value: string | null): Promise<SessionSummary> {
    return this.applySubagentSetting(sessionId, { model: value });
  }

  /** 子代理的思考等级，语义同 `setSubagentModel`。 */
  async setSubagentThinking(sessionId: string, value: string | null): Promise<SessionSummary> {
    return this.applySubagentSetting(sessionId, { thinking: value });
  }

  private async applySubagentSetting(
    sessionId: string,
    patch: { model?: string | null; thinking?: string | null },
  ): Promise<SessionSummary> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (record.agent !== "pi") {
      throw new RpcError("unsupported", "只有 pi 托管会话可以单独设置子代理");
    }
    const live = this.live.get(record.id);
    const model = patch.model === undefined ? record.subagentModel : this.model(patch.model?.trim() || undefined);
    const thinking =
      patch.thinking === undefined
        ? record.subagentThinking
        : patch.thinking === null
          ? undefined
          : this.thinkingLevel(patch.thinking);
    if (this.busyOf(record) || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再改子代理设置");
    }
    // 先写好新的 agent 目录，再停进程：写不进去就别停，免得白断一轮。
    const agentDir = this.piAgentDirOf(record.id);
    // 没改的那几项沿用记录里的值；三项都没有值就把目录清掉。
    const reserveTokens = this.compactionReserveFor(record);
    if (model || thinking || reserveTokens !== undefined) {
      if (!preparePiAgentDir(agentDir, { model, thinking, reserveTokens })) {
        throw new RpcError("unsupported", `读不到 pi 的 agent 目录（${piAgentSourceDir()}），子代理设置没有生效`);
      }
    } else {
      removePiAgentDir(agentDir);
    }
    // 旧进程连它派生的子代理一起收（下面统一走 teardown）。
    // 旧进程派生的后台子代理是 detached 起的，不在进程组里：必须按 pid 收掉，
    // 收不干净就不能装作切换成功。
    const { leftover } = await this.teardown(record.id, { strict: true });
    if (leftover.length > 0) {
      throw new RpcError("conflict", `旧进程派生的进程没停掉，设置没有切换：${leftover.join(", ")}`);
    }
    if (model) record.subagentModel = model;
    else delete record.subagentModel;
    if (thinking) record.subagentThinking = thinking;
    else delete record.subagentThinking;
    this.touch(record);
    return this.summary(record);
  }

  /**
   * 换这个会话的思考等级（只对 pi 有效）。`value` 传 null 表示改回跟随 pi 设置。
   * pi 的 RPC 有原生 `set_thinking_level`：进程在跑就直接改，不用重启；
   * 但「取消等级」pi 没有对应 RPC，只能停掉进程，让下次启动不带 `--thinking`。
   */
  async setThinking(sessionId: string, value: string | null): Promise<SessionSummary> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (record.agent !== "pi") {
      throw new RpcError("unsupported", "只有 pi 托管会话有思考等级");
    }
    const level = value === null ? undefined : this.thinkingLevel(value);
    const live = this.live.get(record.id);
    if (level && live?.pi) {
      const result = await live.pi.setThinkingLevel(level);
      if (result.error) {
        throw new RpcError("invalid_params", `pi 设置思考等级失败：${result.error}`);
      }
      record.thinking = level;
      this.touch(record);
      return this.summary(record);
    }
    if (this.busyOf(record) || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再换思考等级");
    }
    // 进程不在、或者要改回跟随 pi 设置：停掉旧进程，下一条消息按新参数启动。
    // 旧进程连它派生的子代理一起收（下面统一走 teardown）。
    // 旧进程派生的后台子代理是 detached 起的，不在进程组里：必须按 pid 收掉，
    // 收不干净就不能装作切换成功。
    const { leftover } = await this.teardown(record.id, { strict: true });
    if (leftover.length > 0) {
      throw new RpcError("conflict", `旧进程派生的进程没停掉，设置没有切换：${leftover.join(", ")}`);
    }
    if (level) record.thinking = level;
    else delete record.thinking;
    this.touch(record);
    return this.summary(record);
  }

  /**
   * 改这个会话的自动压缩触发点（窗口用到的百分比，只对 pi 有效）：上下文到达窗口的
   * 这个比例时 pi 自己压缩。pi 只认 `compaction.reserveTokens`，这里按当前模型窗口
   * 换算成它认的值；pi 只在启动时读 settings.json，所以空闲进程要先停掉。
   * `value` 传 null 表示改回 Bridge 默认值。
   */
  async setCompaction(sessionId: string, value: number | null): Promise<SessionSummary> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知托管会话");
    if (record.agent !== "pi") {
      throw new RpcError("unsupported", "只有 pi 托管会话可以设置自动压缩触发点");
    }
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 100)) {
      throw new RpcError("invalid_params", "自动压缩触发点必须是 1 到 100 之间的整数（窗口百分比）");
    }
    const live = this.live.get(record.id);
    if (this.busyOf(record) || live?.pending || live?.piPending) {
      throw new RpcError("conflict", "这一轮还在跑，等它结束再改自动压缩触发点");
    }
    const next: HostedRecord = { ...record };
    delete next.compactionReserveTokens;
    if (value !== null) next.compactionTriggerPercent = value;
    else delete next.compactionTriggerPercent;
    const reserve = this.compactionReserveFor(next);
    // 先写好新的 agent 目录，再停进程：写不进去就别停，免得白断一轮。
    const agentDir = this.piAgentDirOf(record.id);
    const needsDir = Boolean(record.subagentModel || record.subagentThinking || reserve !== undefined);
    const prepared = needsDir
      ? preparePiAgentDir(agentDir, {
          model: record.subagentModel,
          thinking: record.subagentThinking,
          reserveTokens: reserve,
        })
      : null;
    if (needsDir && !prepared) {
      throw new RpcError("unsupported", `读不到 pi 的 agent 目录（${piAgentSourceDir()}），自动压缩触发点没有生效`);
    }
    // 窗口还未知（还没跑过一轮、配置里也查不到）时先不建目录，等下次启动再算。
    if (!prepared) removePiAgentDir(agentDir);
    // 旧进程连它派生的子代理一起收（下面统一走 teardown）。
    // 旧进程派生的后台子代理是 detached 起的，不在进程组里：必须按 pid 收掉，
    // 收不干净就不能装作切换成功。
    const { leftover } = await this.teardown(record.id, { strict: true });
    if (leftover.length > 0) {
      throw new RpcError("conflict", `旧进程派生的进程没停掉，设置没有切换：${leftover.join(", ")}`);
    }
    delete record.compactionReserveTokens;
    if (value !== null) record.compactionTriggerPercent = value;
    else delete record.compactionTriggerPercent;
    this.touch(record);
    return this.summary(record);
  }

  /** 按触发百分比换算 pi 认的 reserveTokens；窗口未知时返回 undefined（pi 用自己的默认）。 */
  private compactionReserveFor(record: HostedRecord): number | undefined {
    if (record.compactionReserveTokens !== undefined) return record.compactionReserveTokens;
    const window = this.contextWindowFor(record);
    if (window === undefined) return undefined;
    const percent = record.compactionTriggerPercent ?? DEFAULT_COMPACTION_TRIGGER_PERCENT;
    const trigger = Math.round((window * percent) / 100);
    return Math.min(MAX_COMPACTION_RESERVE_TOKENS, Math.max(0, window - trigger));
  }

  /** 会话模型窗口：优先用 pi 上报过的，其次查 pi 自己的模型配置。 */
  private contextWindowFor(record: HostedRecord): number | undefined {
    const reported = record.context?.windowTokens;
    if (typeof reported === "number" && reported > 0) return reported;
    const model = record.model ?? record.observedModel ?? piDefaultModel();
    return model ? piModelContextWindow(model) : undefined;
  }

  private compactionLabel(record: HostedRecord): string {
    const base = this.compactionSettingLabel(record);
    // pi 只在启动时读 settings.json：进程里的值和记录里的设置不一致时，
    // 说明它还按旧值在压缩，光看设置会以为已经改了。
    const effective = this.liveCompactionReserve(record);
    if (effective === undefined) return base;
    const intended = this.compactionReserveFor(record);
    if (intended === effective) return base;
    const window = this.contextWindowFor(record);
    if (window === undefined) {
      return `${base}；运行中的进程仍按旧预留 ${effective.toLocaleString("en-US")} tokens 压缩，重启后生效`;
    }
    const trigger = Math.max(0, window - effective);
    return `${base}；运行中的进程仍按旧预留 ${effective.toLocaleString("en-US")}（约 ${trigger.toLocaleString("en-US")} tokens 时压缩），重启后生效`;
  }

  private compactionSettingLabel(record: HostedRecord): string {
    if (record.compactionReserveTokens !== undefined) {
      const window = this.contextWindowFor(record);
      const trigger = window === undefined ? undefined : Math.max(0, window - record.compactionReserveTokens);
      return trigger === undefined
        ? `预留 ${record.compactionReserveTokens.toLocaleString("en-US")} tokens 时压缩（旧设置）`
        : `上下文约 ${trigger.toLocaleString("en-US")} tokens 时压缩（旧设置）`;
    }
    const percent = record.compactionTriggerPercent ?? DEFAULT_COMPACTION_TRIGGER_PERCENT;
    const suffix = record.compactionTriggerPercent === undefined ? "（默认）" : "";
    const window = this.contextWindowFor(record);
    if (window === undefined) return `上下文用到窗口的 ${percent}% 时压缩${suffix}`;
    const trigger = Math.round((window * percent) / 100);
    return `上下文用到窗口的 ${percent}%（约 ${trigger.toLocaleString("en-US")} / ${window.toLocaleString("en-US")} tokens）时压缩${suffix}`;
  }

  /** 运行中的 pi 进程实际读到的预留 token 数；进程不在、没独立 agent 目录或读不到时为 undefined。 */
  private liveCompactionReserve(record: HostedRecord): number | undefined {
    if (!this.live.has(record.id)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.piAgentDirOf(record.id), "settings.json"), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const compaction = (parsed as Record<string, unknown>)["compaction"];
      if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) return undefined;
      const value = (compaction as Record<string, unknown>)["reserveTokens"];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
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

  /**
   * 记住这次新建用的选项，写回 hosted.json。Claude Code 与 pi 的模型清单不通用，
   * 所以各存各的：切引擎时只覆盖自己那一份，另一份留着。
   */
  private rememberCreateDefaults(
    agent: HostedAgent,
    permissionMode: HostedPermissionMode,
    used: {
      model?: string;
      effort?: string;
      subagentModel?: string;
      thinking?: string;
      subagentThinking?: string;
    },
  ): void {
    const prev = this.config.lastCreate ?? {};
    // pi 的 permissionMode 只是占位（它没有权限模式），沿用上一次 Claude Code 用的那个。
    const next: HostedCreateDefaults = {
      agent,
      permissionMode: agent === "pi" ? (prev.permissionMode ?? permissionMode) : permissionMode,
    };
    // 本次用的引擎以「这次选了什么」为准：选回默认就不写这项，下次预填跟着回到默认；
    // 另一个引擎的那份原样留着，来回切引擎不会互相清空。
    if (agent === "pi") {
      if (prev.model) next.model = prev.model;
      if (prev.effort) next.effort = prev.effort;
      if (used.model) next.piModel = used.model;
      if (used.thinking) next.piThinking = used.thinking;
      if (used.subagentModel) next.subagentModel = used.subagentModel;
      if (used.subagentThinking) next.subagentThinking = used.subagentThinking;
    } else {
      if (prev.piModel) next.piModel = prev.piModel;
      if (prev.piThinking) next.piThinking = prev.piThinking;
      if (prev.subagentModel) next.subagentModel = prev.subagentModel;
      if (prev.subagentThinking) next.subagentThinking = prev.subagentThinking;
      if (used.model) next.model = used.model;
      if (used.effort) next.effort = used.effort;
    }
    this.patchConfigFile({ lastCreate: next });
    this.config.lastCreate = next;
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
    // pi 的模型清单：先读 pi 自己的配置（新建时还没有进程可问），再补上跑过的会话报回来的。
    const piModels: ModelOption[] = [];
    const seen = new Set<string>();
    const addPiModel = (item: ModelOption): void => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      piModels.push(item);
    };
    for (const item of piModelCatalog()) addPiModel(item);
    for (const record of this.records.values()) {
      if (record.agent !== "pi") continue;
      for (const item of record.piModels ?? []) addPiModel(item);
    }
    if (piModels.length > 0) result.piModels = piModels;
    if (this.config.lastCreate) result.lastCreate = this.config.lastCreate;
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
    // 主回合已经收尾、后台子代理还在跑：进程看着是闲的，但仍然有活没干完。
    const background =
      live !== undefined &&
      record.agent === "pi" &&
      !live.busy &&
      !live.pending &&
      !live.piPending &&
      this.piSessionIds(record).some((id) => piSubagentRunning(id));
    if (!live || (!live.busy && !live.pending && !live.piPending && !background)) {
      return { interrupted: false, session: this.summary(record) };
    }
    if (record.agent === "pi") {
      // 后台子代理跑在 pi 进程内部，abort 停不掉，只能把进程停掉。
      if (background) {
        void this.teardown(record.id);
        // 那一轮是正常收尾的，不置 interrupted：否则网页会把最后一条回复画成「已停止」。
        record.pendingText = undefined;
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text: "已停止后台子代理" }],
        });
        this.log(`hosted: interrupt background subagents ${record.id}`);
        this.touch(record);
        return { interrupted: true, session: this.summary(record) };
      }
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
    if (!this.cwdExists(record.cwd)) {
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
      // 命令先于弹窗答案判定：pi 在等回答时发 `/new` 不该被当成回答内容。
      if (await this.runPiSlash(record, live, pi, text)) {
        return { accepted: true, delivered: true, detail: "已在托管会话里执行命令" };
      }
      if (live.piPending) {
        const pending = live.piPending;
        pi.answer(pending, text);
        this.recordUser(record, text);
        this.touch(record);
        return { accepted: true, delivered: true, detail: "已答复 pi 的提问" };
      }
      // 终端里的内置命令由终端自己执行；托管会话没有这一层，由 Bridge 接住，
      // 否则整行会被当成用户消息发给模型（模型只会解释一遍这个命令）。
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
      // 白名单改掉之后旧会话可能指着受保护目录：自动续跑不能绕过闸门起进程。
      if (!this.cwdExists(record.cwd)) {
        record.pendingText = undefined;
        record.interrupted = true;
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text: `工作目录不可用，没有自动续跑：${record.cwd}` }],
        });
        this.persistRecords();
        this.log(`hosted: auto-resume skipped ${record.id}: 工作目录不可用 ${record.cwd}`);
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
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
    if (this.treeTimer) clearInterval(this.treeTimer);
    this.treeTimer = null;
    this.trees.clear();
    this.stopping.clear();
    if (this.reprobeTimer) clearTimeout(this.reprobeTimer);
    this.reprobeTimer = null;
    this.probeQueue.length = 0;
    this.probeRunning = false;
    this.probeCancel?.();
    this.probeCancel = null;
    this.probing.clear();
    this.silentProbes.clear();
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
   * 用户在这条会话里执行过 `/new` 后，pi 的会话文件已经换了（id 也换了），
   * 这时改按文件路径续写，否则重启会回到 `/new` 之前的历史。
   */
  private startPi(record: HostedRecord, resume: boolean): void {
    const binary = piBinary();
    if (!binary) {
      throw new RpcError(
        "adapter_unavailable",
        "未找到 pi 可执行文件：托管 pi 会话需要它在 ~/.bun/bin、/opt/homebrew/bin 或 AGENT_BRIDGE_PI_PATH 中。",
      );
    }
    const args = record.piSessionPath
      ? ["--mode", "rpc", "--session", record.piSessionPath, "--approve"]
      : ["--mode", "rpc", "--session-id", record.id, "--approve"];
    // 模型记成 `provider/modelId`，启动时拆回两个旗标。
    if (record.model) {
      const slash = record.model.indexOf("/");
      if (slash > 0) args.push("--provider", record.model.slice(0, slash), "--model", record.model.slice(slash + 1));
      else args.push("--model", record.model);
    }
    if (record.thinking) args.push("--thinking", record.thinking);
    if (record.args?.length) args.push(...record.args);
    // 子代理模型与思考等级只认 settings.json：给这个会话单独准备一份 agent 目录，用环境变量指过去。
    const agentDir = preparePiAgentDir(this.piAgentDirOf(record.id), {
      model: record.subagentModel,
      thinking: record.subagentThinking,
      reserveTokens: this.compactionReserveFor(record),
    });
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
      lastOutputAt: Date.now(),
      stderrTail: "",
      resumed: resume,
    };
    this.live.set(record.id, live);
    // 立刻登记根进程并开始盯后代：托管进程派生的子代理 runner 是 detached 起的，
    // 停会话时只能按 pid 点名，晚一步它就 re-parent 到 pid 1 了。
    this.rememberTrees();
    this.watchTrees();
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
      // 进程自己退了（正常收尾、崩溃、换模型重启）：登记表里可能还留着 setsid 出去的
      // 后台子代理，一并收掉。用此刻的快照，后面重启的新进程不能被算进来。
      // 主动停止时停止流程自己会核对，这里不用重复扫。
      if (!this.stopping.has(record.id)) void this.reapOrphans(record.id, this.trees.known(record.id));
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
        if (!this.cwdExists(record.cwd)) {
          this.log(`hosted ${record.id}: 工作目录不可用，不再新建进程 ${record.cwd}`);
          return;
        }
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
    // 任何一段输出都算「这一轮还在动」：卡住标记靠它清掉。
    live.lastOutputAt = Date.now();
    if (live.stalledSince) {
      live.stalledSince = undefined;
      this.log(`hosted ${record.id} 恢复输出`);
    }
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
        assistant: (blocks, usage) => {
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
            ...(usage ? { usage } : {}),
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
            truncate(last.blocks[0].text, MAX_BLOCK_CHARS).text === truncate(text, MAX_BLOCK_CHARS).text
          ) {
            return;
          }
          this.appendRecord(record, {
            messageId: randomUUID(),
            sessionId: record.id,
            role: "system",
            createdAt: Date.now(),
            blocks: [{ type: "text", text }],
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
          record.piCommands = names;
          record.slashCommands = withBridgeCommands(names);
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

  /** 系统提示：命令执行结果直接写进转录，不跑模型、也不算用户消息。 */
  private piNotice(record: HostedRecord, text: string): void {
    this.appendRecord(record, {
      messageId: randomUUID(),
      sessionId: record.id,
      role: "system",
      createdAt: Date.now(),
      blocks: [{ type: "text", text }],
    });
    this.touch(record);
  }

  /**
   * 托管会话里的 `/xxx`：能映射到 pi RPC 的由 Bridge 执行，其余原样交给 pi
   * （扩展命令、`/skill:`、提示词模板都在 pi 那边展开）。
   * 返回 true 表示这一行已经处理完，不该再当用户消息发出去。
   */
  private async runPiSlash(
    record: HostedRecord,
    live: LiveProcess,
    pi: PiSession,
    text: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
    const match = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match) return false;
    const name = (match[1] ?? "").toLowerCase();
    const arg = (match[2] ?? "").trim();
    const quit = name === BRIDGE_QUIT_COMMAND;
    if (!quit && !(BRIDGE_SLASH_COMMANDS as readonly string[]).includes(name)) return false;
    // pi 那边也有同名命令（扩展、技能或模板）时让给它，Bridge 只接 pi 没有的。
    if (!quit && record.piCommands?.includes(name)) return false;
    this.log(`hosted: slash /${name} ${record.id}`);
    // 弹窗期间整行会被当成答案，命令不能这么处理：除 /quit 外都要求先回答。
    if (!quit && live.piPending) {
      this.piNotice(record, "pi 正在等你回答上一个问题，先回答它（或发 /quit 停掉这一轮）");
      return true;
    }
    // 这三条要独占一个空闲进程：跑着的回合里换会话或压缩会互相踩。
    if ((name === "new" || name === "compact" || quit) && live.busy) {
      this.piNotice(record, `这一轮还在跑，等它结束再 /${name}`);
      return true;
    }
    if (quit) {
      const result = await this.stop(record.id);
      this.piNotice(record, result.stopped ? "已停掉托管进程" : "这条会话本来就没在跑");
      return true;
    }
    if (name === "new") {
      // 新建会换会话文件：置 busy，既挡住并发命令，也避免空闲回收在中间把进程杀掉。
      live.busy = true;
      this.touch(record);
      try {
        const result = await pi.newSession();
        if (result.error) {
          this.piNotice(record, `新建会话失败：${result.error}`);
          return true;
        }
        // 会话文件已经换了：记下新路径，否则 Bridge 重启会续到 `/new` 之前的旧会话。
        const next = sanitizeSessionPath(result.sessionPath);
        if (!next) {
          this.piNotice(record, "新建会话失败：pi 没有报回新的会话文件");
          return true;
        }
        record.piSessionPath = next;
        if (result.model) record.observedModel = result.model;
        delete record.context;
        record.pendingText = undefined;
        record.interrupted = false;
        // 上一条会话撞过的续跑上限属于旧上下文，新会话从零计。
        record.resumeAttempts = 0;
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text: "已开始新会话，pi 的上下文已清空（上面更早的消息只留在 Bridge 的记录里）" }],
        });
        this.touch(record);
        return true;
      } finally {
        live.busy = false;
        this.touch(record);
      }
    }
    if (name === "compact") {
      // 压缩要真跑一次模型（最长 10 分钟）：置 busy 挡住并发命令与空闲回收，
      // 同时不能等回执再返回，否则设备通道会被占住。
      live.busy = true;
      this.touch(record);
      void pi
        .compact(arg)
        .then((result) => {
          if (result.error) {
            this.piNotice(record, `压缩失败：${result.error}`);
            return;
          }
          const before = result.tokensBefore !== undefined ? result.tokensBefore.toLocaleString("en-US") : "";
          const after = result.tokensAfter !== undefined ? result.tokensAfter.toLocaleString("en-US") : "";
          const detail = before && after ? `：约 ${before} → ${after} tokens` : "";
          this.piNotice(record, `已压缩上下文${detail}`);
        })
        .catch((error: unknown) => {
          this.piNotice(record, `压缩失败：${error instanceof Error ? error.message : "未知原因"}`);
        })
        .finally(() => {
          live.busy = false;
          this.touch(record);
        });
      return true;
    }
    if (name === "session") {
      const stats = await pi.stats();
      if (!stats) {
        this.piNotice(record, "pi 没有返回会话统计");
        return true;
      }
      this.piNotice(record, statsText(stats));
      return true;
    }
    if (name === "name") {
      if (!arg) {
        this.piNotice(record, `当前名称：${record.title}`);
        return true;
      }
      const result = await pi.renameSession(arg.slice(0, MAX_TITLE_CHARS));
      if (result.error) {
        this.piNotice(record, `改名失败：${result.error}`);
        return true;
      }
      record.title = arg.slice(0, MAX_TITLE_CHARS);
      this.touch(record);
      this.piNotice(record, `已改名为「${record.title}」`);
      return true;
    }
    if (name === "model") {
      if (!arg) {
        this.piNotice(
          record,
          `当前模型：${record.observedModel ?? record.model ?? "pi 的默认模型"}。换模型在侧栏的模型面板里选，或发 /model <provider/model>。`,
        );
        return true;
      }
      try {
        const summary = await this.setModel(record.id, arg);
        this.piNotice(record, `模型已换成 ${summary.model ?? arg}`);
      } catch (error) {
        this.piNotice(record, error instanceof Error ? error.message : "换模型失败");
      }
      return true;
    }
    if (name === "thinking") {
      if (!arg) {
        this.piNotice(
          record,
          `当前思考等级：${record.thinking ?? "跟随 pi 设置"}。可用：${PI_THINKING_LEVELS.join("、")}`,
        );
        return true;
      }
      let level: string;
      try {
        level = this.thinkingLevel(arg) ?? "";
      } catch (error) {
        this.piNotice(record, error instanceof Error ? error.message : "不支持的思考等级");
        return true;
      }
      const result = await pi.setThinkingLevel(level);
      if (result.error) {
        this.piNotice(record, `设置思考等级失败：${result.error}`);
        return true;
      }
      record.thinking = level;
      this.touch(record);
      this.piNotice(record, `思考等级已设为 ${level}`);
      return true;
    }
    if (name === "export") {
      let outputPath: string | undefined;
      if (arg) {
        // 网页只能往这个会话的工作目录里写，不给它一条任意落盘的路径。
        const root = resolve(record.cwd);
        const target = resolve(root, arg);
        if (target !== root && !target.startsWith(`${root}/`)) {
          this.piNotice(record, "导出路径必须在这个会话的工作目录里");
          return true;
        }
        outputPath = target;
      }
      const result = await pi.exportHtml(outputPath);
      if (result.error) {
        this.piNotice(record, `导出失败：${result.error}`);
        return true;
      }
      this.piNotice(record, result.path ? `已导出到 ${result.path}` : "已导出会话");
      return true;
    }
    // 名单与分支对不上就是写错了，交给 pi 按普通消息处理，不能静默跑成别的命令。
    return false;
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
      const turnUsage = tokenUsageFromClaude(message["usage"]);
      this.appendRecord(record, {
        messageId: randomUUID(),
        sessionId: record.id,
        role: "assistant",
        createdAt: Date.now(),
        blocks,
        ...(turnUsage ? { usage: turnUsage } : {}),
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
      const context = contextFromTranscript(record, this.fs);
      if (context) record.context = context;
      const isError = event["is_error"] === true;
      const text = typeof event["result"] === "string" ? event["result"].trim() : "";
      if (isError && text) {
        this.appendRecord(record, {
          messageId: randomUUID(),
          sessionId: record.id,
          role: "system",
          createdAt: Date.now(),
          blocks: [{ type: "text", text }],
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
      blocks: [{ type: "text", text }],
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

  /**
   * 这个托管会话在 pi 那边可能是两个 id：首会话用 `--session-id record.id`，
   * `/new` 之后续写 pi 新建的文件（`<时间戳>_<id>.jsonl`），id 由 pi 生成。
   * 后台子代理的 status.json 记的是 pi 的会话 id，两边都得认。
   */
  private piSessionIds(record: HostedRecord): string[] {
    const ids = [record.id];
    const file = basename(record.piSessionPath ?? "").replace(/\.jsonl$/, "");
    // 文件名是 `<时间戳>_<id>.jsonl`，时间戳里不会有下划线；用第一个下划线切，id 自带下划线也不会切错。
    const at = file.indexOf("_");
    if (at >= 0 && at < file.length - 1) ids.push(file.slice(at + 1));
    return ids;
  }

  /** 这个会话派生的后台子代理 run：两个 id 的并集，最新在前。 */
  private piTasks(record: HostedRecord): RailTask[] {
    const byRun = new Map<string, RailTask>();
    for (const id of this.piSessionIds(record)) {
      for (const task of piSubagentTasks(id)) byRun.set(task.taskId, task);
    }
    return [...byRun.values()]
      .sort((a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0))
      .slice(0, MAX_PI_TASKS);
  }

  /**
   * 会话是否还在干活：pi 主进程跑着这一轮，或者它派生的后台子代理还没结束。
   * 后台 run 跑在 pi 进程内部，主 agent 已经 settled，只看 `live.busy` 会误报成已完成。
   * 进程已经停掉（用户停止、空闲回收）时不再看后台 run：那些 run 也跟着没了，
   * status.json 却会一直停在 running，看它反而会显示成永远在跑。
   */
  private busyOf(record: HostedRecord): boolean {
    const live = this.live.get(record.id);
    if (live?.busy) return true;
    if (!live || record.agent !== "pi") return false;
    return this.piSessionIds(record).some((id) => piSubagentRunning(id));
  }

  /**
   * 记录里的 cwd 的状态。先过枚举闸门再 stat：白名单改掉之后，旧记录可能指着
   * `~/下载`、`~/文档` 这类受保护目录，直接 stat 就是一次系统授权弹窗。
   *
   * 越界与不存在要分开：前者是「白名单里没有它」，后者是「目录被删了」，
   * 界面上引向的排查动作完全不同。
   */
  private cwdState(path: string): "ok" | "missing" | "out-of-scope" {
    try {
      this.fs.assert(path, "hosted.cwd");
    } catch (error) {
      // 越界：日志已经在闸门里记过，这里只回答状态。
      if (error instanceof FsScopeError) return "out-of-scope";
      throw error;
    }
    return isDirectory(path) ? "ok" : "missing";
  }

  private cwdExists(path: string): boolean {
    return this.cwdState(path) === "ok";
  }

  private summary(record: HostedRecord): SessionSummary {
    const live = this.live.get(record.id);
    const cwdState = this.cwdState(record.cwd);
    const dirExists = cwdState === "ok";
    // 进程里真正生效的压缩预留量；和记录里的设置不一致说明还没重启。
    const effectiveReserve = live ? this.liveCompactionReserve(record) : undefined;
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
      busy: this.busyOf(record),
      ...(live?.stalledSince ? { stalledSince: live.stalledSince } : {}),
      needsDecision: Boolean(live?.pending || live?.piPending),
      canSend: dirExists,
      hosted: true,
      hostedState: live ? "running" : "stopped",
      // 老记录没有 agent 字段，那是 Claude Code 时代留下的；一律写出来，网页的图标/文案才分得清。
      hostedAgent: record.agent === "pi" ? "pi" : "claude",
      permissionMode: record.permissionMode,
      ...(record.model ?? record.observedModel ? { model: record.model ?? record.observedModel } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.subagentModel ? { subagentModel: record.subagentModel } : {}),
      ...(record.compactionTriggerPercent !== undefined
        ? { compactionTriggerPercent: record.compactionTriggerPercent }
        : {}),
      ...(record.compactionReserveTokens !== undefined
        ? { compactionReserveTokens: record.compactionReserveTokens }
        : {}),
      ...(effectiveReserve !== undefined ? { compactionEffectiveReserveTokens: effectiveReserve } : {}),
      cwd: record.cwd,
    };
    if (!dirExists) {
      summary.sendBlockedReason =
        cwdState === "out-of-scope"
          ? `工作目录已不在托管白名单里：${record.cwd}`
          : `工作目录已不存在：${record.cwd}`;
    }
    return summary;
  }

  private allowedPath(input: string): string {
    if (this.config.dirs.length === 0) {
      throw new RpcError(
        "unsupported",
        `没有配置可托管的目录：编辑 ${join(this.stateDir, "hosted.json")} 的 dirs 后重启 Bridge`,
      );
    }
    const dirs = this.allowDirs();
    const given = expandHome(input.trim());
    // 先按字符串比（白名单的两种写法都认）：客户端可以把路径指到 `~/下载`、`~/音乐`，
    // 对客户端路径做 realpath 就是一次系统授权弹窗 —— 不在白名单里就直接拒绝，
    // 根本不需要碰文件系统。
    const hit = dirs.find((dir) => dir.raw === given || dir.real === given);
    const allowed = dirs.map((dir) => dir.real);
    // 写法不一致（客户端给 `/var/...`、白名单里存 `/private/var/...`）时才解析一次。
    // 解析前先过闸门：`~/下载` 这类路径在这一步就被拒，不会走到 realpath。
    const target = hit ? hit.real : this.fs.check(given).ok ? canonical(given) : null;
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

  /** pi 的思考等级：`--thinking` 与 settings.json 的 `subagents.defaultThinking` 用同一套取值。 */
  private thinkingLevel(value: string | undefined): string | undefined {
    const level = value?.trim().toLowerCase();
    if (!level) return undefined;
    if (!PI_THINKING_LEVELS.includes(level)) {
      throw new RpcError("invalid_params", `pi 不支持的思考等级：${value}（可用：${PI_THINKING_LEVELS.join("、")}）`);
    }
    return level;
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

  /** 同步兜底：只发进程组信号，给进程退出前的收尾用；真正收整棵树走 teardown。 */
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

  /**
   * 停一个会话的进程，以及它派生的整棵树。
   *
   * 顺序有讲究：先登记后代、再把整棵树冻住杀掉（killTree 里做），守护进程那层放最后。
   * 反过来先杀主进程的话，它临死前派生的子代理会 re-parent 到 pid 1，ppid 线索断掉，
   * 之后就再也找不回来了 —— 这正是「停掉会话后子代理还在跑」的成因。
   */
  private async teardown(
    id: string,
    options: { tree?: boolean; strict?: boolean } = {},
  ): Promise<{ leftover: number[]; stopped: boolean }> {
    this.stopping.add(id);
    const live = this.live.get(id);
    const rootPid = live?.child.pid;
    let stopped = live !== undefined;
    const leftover: number[] = [];
    try {
      if (live) {
        live.killed = true;
        // 根进程还活着时 ppid 链才完整：先登记再动手。
        this.rememberTrees();
        this.live.delete(id);
        try {
          live.child.stdin?.end();
        } catch {
          // ignore
        }
      }
      const roots = typeof rootPid === "number" && rootPid > 1 ? [rootPid] : [];
      // 不 await：endTree 的同步段就把整棵树 SIGSTOP 冻住了，冻结之后根进程不可能再
      // 派生新进程，所以下面的进程组信号可以立刻发，不会留出赛跑窗口。
      const tree = options.tree === false ? null : this.endTree(id, roots);
      // 进程组级别的兜底：万一还有没登记到的后代。冻住的进程会先挂住这个信号，
      // 等 killTree 放行（SIGCONT）后才真正退出。
      if (live) {
        killProcess(live.child, "SIGTERM");
        const timer = setTimeout(() => {
          killProcess(live.child, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref();
      }
      if (tree) {
        const result = await tree;
        leftover.push(...result.leftover);
        if (result.killed > 0) stopped = true;
      }
      if (await this.stopInSessiond(id, options.strict === true)) stopped = true;
      if (options.tree !== false) {
        // 守护进程里那份可能带着我们没见过的后代：按它的 pid 再收一遍。
        const again = await this.endTree(id);
        for (const pid of again.leftover) if (!leftover.includes(pid)) leftover.push(pid);
      }
      return { leftover, stopped };
    } finally {
      this.stopping.delete(id);
    }
  }

  /**
   * 收掉一个会话的整棵树：登记表里的后代 + 会话根 + 子代理 runner。
   *
   * SIGTERM → 宽限 → SIGKILL → 核对都由 killTree 负责；杀不掉的 pid 会带出去，
   * 调用方必须显式报出去，不能当成停成功。
   */
  private async endTree(id: string, roots: number[] = []): Promise<{ leftover: number[]; killed: number }> {
    const registered = this.trees.known(id);
    const rootPid = this.live.get(id)?.child.pid;
    if (typeof rootPid === "number" && rootPid > 1) roots = [...roots, rootPid];
    else if (roots.length === 0) {
      // Bridge 没有 live 条目（重启后还没 attach 回来）：pid 只有守护进程知道。
      const daemon = await this.daemonPid(id);
      if (daemon) roots = [...roots, daemon];
    }
    const extra = this.subagentRunnerPids(id);
    // 先按副本干活再清表：清理期间重启的新进程不会被算进来。
    this.trees.forget(id);
    if (registered.size === 0 && roots.length === 0 && extra.length === 0) return { leftover: [], killed: 0 };
    const result = await killTree(registered, roots, extra, {
      graceMs: KILL_GRACE_MS,
      forbidden: this.foreignPids(id),
      log: (line) => this.log(`hosted ${id}: ${line}`),
    });
    if (result.terminated.length > 0) this.log(`hosted ${id}: 收掉 ${result.terminated.length} 个后代进程`);
    return { leftover: result.leftover, killed: result.terminated.length };
  }

  /**
   * 会话进程自己退出（正常收尾、崩溃、换模型重启）时收掉它还留着的后代。
   *
   * 用退出那一刻的登记表快照：随后可能立刻按新参数重启，不能把新进程的子孙算进来。
   */
  private async reapOrphans(id: string, registered: Map<number, string>): Promise<void> {
    const extra = this.subagentRunnerPids(id);
    this.trees.forget(id);
    if (registered.size === 0 && extra.length === 0) return;
    const result = await killTree(registered, [], extra, {
      graceMs: ORPHAN_GRACE_MS,
      forbidden: this.foreignPids(id),
      log: (line) => this.log(`hosted ${id}: ${line}`),
    });
    if (result.terminated.length > 0) {
      this.log(`hosted ${id}: 进程已退出，收掉 ${result.terminated.length} 个残留后代`);
    }
    if (result.leftover.length > 0) {
      this.log(`hosted ${id}: 进程已退出，仍有后代没停掉：${result.leftover.join(", ")}`);
    }
  }

  /** 这个会话派生的、还在跑的后台子代理 runner 的 pid（它们不在会话进程组里）。 */
  private subagentRunnerPids(id: string): number[] {
    const record = this.records.get(id);
    if (!record || record.agent !== "pi") return [];
    return this.piSessionIds(record).flatMap((piId) => piSubagentRunnerPids(piId));
  }

  /** 别的会话的进程：收自己的时候绝不能误伤。 */
  private foreignPids(id: string): number[] {
    const pids: number[] = [];
    for (const [other, live] of this.live) {
      if (other === id) continue;
      if (typeof live.child.pid === "number") pids.push(live.child.pid);
      for (const pid of this.trees.known(other).keys()) pids.push(pid);
    }
    return pids;
  }

  /** 守护进程里记着的会话 pid：Bridge 重启后还没 attach 回来时，只能问它。 */
  private async daemonPid(id: string): Promise<number | undefined> {
    if (!this.sessiond) return undefined;
    try {
      const infos = await this.sessiond.list();
      const info = infos.find((item) => stripPrefix(item.sessionId) === id);
      return info?.running ? info.pid ?? undefined : undefined;
    } catch (error) {
      this.log(`hosted: 查守护进程里的 ${id} 失败：${String(error)}`);
      return undefined;
    }
  }

  /** 把在跑会话的后代登记进内存表：停止时按 pid 点名，不能只靠进程组。 */
  private rememberTrees(): void {
    const roots = new Map<string, number>();
    for (const [id, live] of this.live) {
      const pid = live.child.pid;
      if (typeof pid === "number" && pid > 1) roots.set(id, pid);
    }
    if (roots.size === 0) return;
    const nodes = snapshotProcesses();
    for (const [id, pid] of roots) this.trees.remember(id, [pid], nodes);
  }

  private watchTrees(): void {
    if (this.treeTimer) return;
    this.treeTimer = setInterval(() => {
      if (this.live.size === 0) {
        if (this.treeTimer) clearInterval(this.treeTimer);
        this.treeTimer = null;
        return;
      }
      this.rememberTrees();
    }, TREE_SCAN_MS);
    this.treeTimer.unref();
  }

  private stopAll(): void {
    for (const id of [...this.live.keys()]) {
      // 同步兜底先发进程组信号，再异步收整棵树（能跑完就收干净）。
      this.kill(id);
      void this.teardown(id);
    }
  }

  /**
   * 忙着的会话长时间没有输出就标成「疑似卡住」。只做检测与状态上报：
   * 系统授权弹窗由用户自己点，Bridge 绝不代劳。
   */
  private checkStalls(): void {
    const now = Date.now();
    for (const [id, live] of this.live) {
      if (live.finished) continue;
      const record = this.records.get(id);
      // 侧栏的「运行中」用的是 busyOf（含 pi 后台子代理），这里必须同一个口径，
      // 否则子代理卡住时会话看起来在跑、却永远不会被判成卡住。
      const busy = record ? this.busyOf(record) : live.busy;
      // 正在等网页回答权限问题不算卡住：那是人没回，不是进程不动。
      if (!busy || live.pending || live.piPending) {
        live.stalledSince = undefined;
        continue;
      }
      const idle = now - live.lastOutputAt;
      if (idle < this.stallMs) {
        if (live.stalledSince) {
          live.stalledSince = undefined;
          this.log(`hosted ${id} 恢复输出`);
        }
        continue;
      }
      if (live.stalledSince) continue;
      live.stalledSince = live.lastOutputAt + this.stallMs;
      this.log(
        `hosted: 会话 ${id} 已经 ${Math.round(idle / 1000)} 秒没有输出，可能卡在系统授权弹窗或外部等待里`,
      );
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, live] of this.live) {
      if (live.busy || live.pending) continue;
      if (now - live.startedAt < IDLE_SWEEP_MS) continue;
      const record = this.records.get(id);
      if (!record) continue;
      // 主 agent 已经 settled、后台子代理还在跑：这时候杀掉进程会把没干完的活掐掉。
      if (record.agent === "pi" && this.piSessionIds(record).some((sid) => piSubagentRunning(sid))) continue;
      if (now - record.lastActiveAt <= this.config.idleTimeoutMs) continue;
      this.log(`hosted: idle timeout, stopping ${id}`);
      // 接回过的子进程、以及它派生的子代理，都要一起收掉。
      void this.teardown(id);
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
        const piSessionPath = sanitizeSessionPath(item["piSessionPath"]);
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
          ...(typeof item["thinking"] === "string" && PI_THINKING_LEVELS.includes(item["thinking"])
            ? { thinking: item["thinking"] }
            : {}),
          ...(typeof item["subagentThinking"] === "string" && PI_THINKING_LEVELS.includes(item["subagentThinking"])
            ? { subagentThinking: item["subagentThinking"] }
            : {}),
          ...(typeof item["compactionTriggerPercent"] === "number" &&
          Number.isSafeInteger(item["compactionTriggerPercent"]) &&
          item["compactionTriggerPercent"] >= 1 &&
          item["compactionTriggerPercent"] <= 100
            ? { compactionTriggerPercent: item["compactionTriggerPercent"] }
            : {}),
          ...(typeof item["compactionReserveTokens"] === "number" &&
          Number.isSafeInteger(item["compactionReserveTokens"]) &&
          item["compactionReserveTokens"] >= 0 &&
          item["compactionReserveTokens"] <= MAX_COMPACTION_RESERVE_TOKENS
            ? { compactionReserveTokens: item["compactionReserveTokens"] }
            : {}),
          ...(Array.isArray(item["args"]) ? { args: sanitizeExtraArgs(item["args"]) } : {}),
          ...(piSessionPath ? { piSessionPath } : {}),
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
      const context = contextFromTranscript(record, this.fs);
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
              ...(record.thinking ? { thinking: record.thinking } : {}),
              ...(record.subagentThinking ? { subagentThinking: record.subagentThinking } : {}),
              ...(record.compactionTriggerPercent !== undefined
                ? { compactionTriggerPercent: record.compactionTriggerPercent }
                : {}),
              ...(record.compactionReserveTokens !== undefined
                ? { compactionReserveTokens: record.compactionReserveTokens }
                : {}),
              ...(record.args?.length ? { args: record.args } : {}),
              ...(record.piSessionPath ? { piSessionPath: record.piSessionPath } : {}),
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
function contextFromTranscript(record: HostedRecord, fs: FsScope): ContextUsage | undefined {
  const root = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirNames(root, "hosted.transcript");
  } catch {
    return undefined;
  }
  const file = dirs.map((dir) => join(root, dir, `${record.id}.jsonl`)).find((path) => existsSync(path));
  if (!file) return undefined;
  let text: string;
  let truncated = false;
  try {
    truncated = fs.stat(file, "hosted.transcript").size > TRANSCRIPT_TAIL_BYTES;
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
    const lastCreate = isRecord(raw) ? readCreateDefaults(raw["lastCreate"]) : undefined;
    const config: HostedConfig = {
      dirs,
      idleTimeoutMs: Math.max(idle, 60_000),
      allowBypassPermissions: isRecord(raw) && raw["allowBypassPermissions"] === true,
      ...(isRecord(raw) && typeof raw["cliPath"] === "string" ? { cliPath: raw["cliPath"] } : {}),
      ...(lastCreate ? { lastCreate } : {}),
    };
    return config;
  } catch {
    return { dirs: [], idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, allowBypassPermissions: false };
  }
}

/** hosted.json 里的新建默认值：只认已知字段，手改坏了也不至于让 Bridge 起不来。 */
function readCreateDefaults(raw: unknown): HostedCreateDefaults | undefined {
  if (!isRecord(raw)) return undefined;
  const out: HostedCreateDefaults = {};
  if (raw["agent"] === "pi" || raw["agent"] === "claude") out.agent = raw["agent"];
  const mode = raw["permissionMode"];
  if (typeof mode === "string" && HOSTED_PERMISSION_MODES.includes(mode as HostedPermissionMode)) {
    out.permissionMode = mode as HostedPermissionMode;
  }
  for (const key of ["model", "effort", "piModel", "piThinking", "subagentModel", "subagentThinking"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/** pi 的 get_commands 只报扩展、技能、模板命令；Bridge 自己接住的内置命令也列给网页。 */
function withBridgeCommands(names: string[]): string[] {
  const out = [...names];
  const seen = new Set(out);
  for (const name of [...BRIDGE_SLASH_COMMANDS, BRIDGE_QUIT_COMMAND]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** `/session` 的一行统计：轮数、工具调用、累计 token、成本、上下文占用。 */
function statsText(stats: Record<string, unknown>): string {
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const tokens = isRecord(stats["tokens"]) ? stats["tokens"] : {};
  const context = isRecord(stats["contextUsage"]) ? stats["contextUsage"] : {};
  const parts = [
    `用户消息 ${num(stats["userMessages"])} 条、工具调用 ${num(stats["toolCalls"])} 次`,
    `累计 ${num(tokens["total"]).toLocaleString("en-US")} tokens`,
    `成本 $${num(stats["cost"]).toFixed(4)}`,
  ];
  const percent = num(context["percent"]);
  if (percent > 0) parts.push(`上下文占用 ${percent}%`);
  return `会话统计：${parts.join("，")}`;
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

/** 列表只给前几千字；全文留在托管记录里，等 message.text 再拿。 */
function trimMessageForList(message: MessageRecord): MessageRecord {
  let changed = false;
  const blocks = message.blocks.map((block) => {
    if (block.type !== "text") return block;
    if (block.text.length > MAX_BLOCK_CHARS) {
      changed = true;
      return { ...block, text: block.text.slice(0, MAX_BLOCK_CHARS), truncated: true };
    }
    // 早版本落盘时就把正文截到上限并留了标记，原文已经不在库里：
    // 清掉标记，不给一个点了也拿不到东西的「读取全文」。
    if (block.truncated) {
      changed = true;
      const copy = { ...block };
      delete copy.truncated;
      return copy;
    }
    return block;
  });
  return changed ? { ...message, blocks } : message;
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
      // 文本全文留在托管记录里，列表返回前才截断。
      blocks.push({ type: "text", text: item["text"] });
    } else if (item["type"] === "tool_use") {
      const name = typeof item["name"] === "string" ? item["name"] : "tool";
      const input = isRecord(item["input"]) ? item["input"] : {};
      const summary = toolSummaryOf(input);
      blocks.push({
        type: "tool",
        text: truncate(`${name} ${describeToolInput(input)}`, MAX_BLOCK_CHARS).text,
        ...(summary ? { summary } : {}),
      });
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
