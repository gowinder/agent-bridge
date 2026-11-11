import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AppInfo,
  ContextUsage,
  MessageBlock,
  MessageListResult,
  MessageQuestion,
  MessageQuestionOption,
  MessageRecord,
  MessageSendResult,
  ModelOption,
  NextStepAction,
  ProjectInfo,
  RailRow,
  RailTask,
  SessionModelsResult,
  SessionRailResult,
  SessionSummary,
} from "@craftstead/protocol";
import { RpcError, truncate, type MessagePage, type MessageText, type SessionAdapter } from "./types.js";

const SOCKET_DIR = "/tmp/cc-socks";
const SUPPORT_DIR = join(homedir(), "Library", "Application Support");
const SESSION_ROOTS = [
  join(SUPPORT_DIR, "Claude-3p", "claude-code-sessions"),
  join(SUPPORT_DIR, "Claude", "claude-code-sessions"),
];
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// 桌面端每个打开的会话进程都会写 <pid>.json（pid → sessionId / hostSessionId / socket）。
const LIVE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");
/** ps 的启动时间与元数据里的 startedAt 允许的误差，超出即视为 pid 被复用。 */
const PID_REUSE_TOLERANCE_MS = 120_000;
/** 请求桌面打开会话后，等待它的 CLI 进程与消息通道就绪的上限。 */
const WAKE_WAIT_MS = 30_000;
const WAKE_POLL_MS = 400;
const MAX_BLOCK_CHARS = 4_000;

interface DesktopSession {
  localId: string;
  cliSessionId: string;
  priorCliSessionIds: string[];
  cwd: string;
  /** 会话所属项目目录；工作树里的会话归到原项目，而不是单独成一个项目。 */
  projectCwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  permissionMode: string;
  model: string;
  effort: string;
  /** Server names taken from the enabled MCP tool ids (`local:<server>:<tool>`). */
  mcpServers: string[];
}

interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  spawnDepth?: number;
  finished?: boolean;
  pickedEffortModel?: string;
}

interface RawEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: Record<string, unknown>;
  };
}

/** Timestamps that tell whether the CLI is still working on a turn. */
interface BusyState {
  lastUserAt: number;
  lastTurnEndAt: number;
  lastActivityAt: number;
}

interface CachedMessages {
  mtimeMs: number;
  size: number;
  messages: MessageRecord[];
  context?: ContextUsage;
  busy?: BusyState;
  interrupted?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 桌面端回合结束时的「下一步」盒子就是这一次工具调用。 */
const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";

/** 桌面端给应用动作按钮的默认文案；工具输入里可能只给了 action。 */
const APP_ACTION_LABELS: Record<string, string> = {
  commit: "提交",
  create_pr: "创建 PR",
  merge: "合并 PR",
  fix_ci: "修复 CI",
  address_comments: "处理评审意见",
  resolve_conflicts: "解决冲突",
  verify: "验证改动",
  archive: "归档会话",
};

/** 把 wrap_up 的输入转成带按钮的消息块；没有可点的东西时不显示。 */
function nextStepBlock(input: unknown): MessageBlock | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const ask = typeof raw["ask"] === "string" ? raw["ask"].trim() : "";
  const actions: NextStepAction[] = [];
  if (Array.isArray(raw["actions"])) {
    for (const item of raw["actions"]) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const action = typeof entry["action"] === "string" ? entry["action"] : undefined;
      const label = (typeof entry["label"] === "string" ? entry["label"] : "").trim()
        || (action ? APP_ACTION_LABELS[action] : undefined);
      if (!label) continue;
      actions.push(action ? { action, label } : { label });
    }
  }
  if (!ask && actions.length === 0) return null;
  const block: MessageBlock = { type: "next-step", text: ask || "下一步" };
  if (ask) block.ask = ask;
  if (actions.length > 0) block.actions = actions;
  return block;
}

/** 桌面端弹给用户选的提问工具；网页只展示，不在网页里回答。 */
const ASK_TOOL = "AskUserQuestion";

/** 把 AskUserQuestion 的输入转成一行行可读的问题与选项。 */
function askBlock(input: unknown, max: number): MessageBlock | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw["questions"])) return null;
  const questions: MessageQuestion[] = [];
  const lines: string[] = [];
  for (const item of raw["questions"]) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const question = (typeof entry["question"] === "string" ? entry["question"] : "").trim();
    if (!question) continue;
    const header = (typeof entry["header"] === "string" ? entry["header"] : "").trim();
    const options: MessageQuestionOption[] = [];
    if (Array.isArray(entry["options"])) {
      for (const option of entry["options"]) {
        if (typeof option !== "object" || option === null) continue;
        const value = option as Record<string, unknown>;
        const label = (typeof value["label"] === "string" ? value["label"] : "").trim();
        if (!label) continue;
        const description = (typeof value["description"] === "string" ? value["description"] : "").trim();
        options.push(description ? { label, description } : { label });
      }
    }
    questions.push({
      ...(header ? { header } : {}),
      question,
      ...(typeof entry["multiSelect"] === "boolean" ? { multiSelect: entry["multiSelect"] } : {}),
      options,
    });
    lines.push(`${header ? `${header}：` : ""}${question}`);
    for (const option of options) {
      lines.push(option.description ? `- ${option.label}：${option.description}` : `- ${option.label}`);
    }
  }
  if (questions.length === 0) return null;
  return { type: "ask", ...truncate(lines.join("\n"), max), questions };
}

/**
 * 信封里的发送者名。所有设备共用同一个进程和同一个名字时，接收方无法分辨消息来自
 * 哪个客户端；带上配对设备名即可区分，同时避免设备名里的引号破坏信封结构。
 */
function senderLabel(origin: string | undefined): string {
  const name = (origin ?? "").replace(/["<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return name ? `Agent Bridge · ${name}` : "Agent Bridge";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Models advertised with a 1M token context window (e.g. `claude-sonnet-4-5[1m]`). */
/** 桌面记录的模型值可能是路由别名（`a.b.claude-opus-5-5`）或带 `[1m]` 后缀。 */
function normalizeModelId(raw: string): string {
  let value = raw.replace(/\[1m\]$/i, "").trim();
  const dot = value.lastIndexOf(".");
  if (dot >= 0) value = value.slice(dot + 1);
  return value;
}

/** 取最长匹配，避免 `claude-opus-4-8` 抢走 `claude-opus-4-8-20261210`。 */
function matchCatalogModel(raw: string, catalog: ModelOption[]): ModelOption | undefined {
  const value = normalizeModelId(raw);
  let best: ModelOption | undefined;
  for (const item of catalog) {
    if (value !== item.id && !value.startsWith(`${item.id}-`)) continue;
    if (!best || item.id.length > best.id.length) best = item;
  }
  return best;
}

function isMillionTokenModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("[1m]") || name.includes("-1m") || name.includes("1m-context");
}

/** A turn the user stopped is recorded as a synthetic user entry. */
function isInterruptEntry(entry: RawEntry): boolean {
  if (entry.type !== "user" || entry.isSidechain) return false;
  const content = entry.message?.content;
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>)["text"];
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.some((text) => text.trim().startsWith("[Request interrupted by user"));
}

/** A turn is open when the last main-chain user entry is newer than the last turn end. */
function trackBusy(busy: BusyState, entry: RawEntry): void {
  if (entry.isSidechain) return;
  const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return;
  if (at > busy.lastActivityAt) busy.lastActivityAt = at;
  if (entry.type === "user" && at > busy.lastUserAt) busy.lastUserAt = at;
  if (entry.type === "system" && entry.subtype === "turn_duration") {
    if (at > busy.lastTurnEndAt) busy.lastTurnEndAt = at;
  }
}

const BUSY_IDLE_MS = 30 * 60_000;

/**
 * A turn is open while the last main-chain user entry is newer than the last turn end and
 * the transcript is still being written. The first turn of a session has no
 * `turn_duration` yet, and a long turn keeps writing tool steps past the user timestamp,
 * so freshness is measured from the last entry of any kind.
 */
function isBusy(busy: BusyState | undefined): boolean {
  if (!busy) return false;
  if (busy.lastUserAt <= busy.lastTurnEndAt) return false;
  return Date.now() - busy.lastActivityAt < BUSY_IDLE_MS;
}

/** A subagent whose meta still says "running" is only believed while its file is fresh. */
const SUBAGENT_RUNNING_MAX_AGE_MS = 10 * 60_000;
/** The rail lists the newest tasks only; a long session can spawn hundreds. */
const MAX_RAIL_TASKS = 20;

/** MCP tool ids look like `local:<server>:<tool>`; the rail lists the server. */
function mcpServersOf(tools: unknown, remote: unknown): string[] {
  const out = new Set<string>();
  if (tools && typeof tools === "object") {
    for (const id of Object.keys(tools as Record<string, unknown>)) {
      const parts = id.split(":");
      if (parts.length >= 3 && parts[1]) out.add(parts[1]);
    }
  }
  if (Array.isArray(remote)) {
    for (const item of remote) {
      if (!item || typeof item !== "object") continue;
      const name = asString((item as Record<string, unknown>)["name"]);
      if (name) out.add(name);
    }
  }
  return [...out];
}

function listSessionFiles(root: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const child of listSessionFiles(path)) out.push(child);
    } else if (/^local_[\w-]+\.json$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const metaCache = new Map<string, { mtimeMs: number; session: DesktopSession | null }>();
let rootsCache: { roots: string[]; checkedAt: number } | null = null;

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly key = "claude-code";
  private processCache: {
    at: number;
    bySession: Map<string, number>;
    /** session/host id → the CLI reports it is running a turn. */
    busy: Set<string>;
    error: string | null;
  } | null = null;
  private transcriptPathCache = new Map<string, { path: string | null; checkedAt: number }>();
  private messageCache = new Map<string, CachedMessages>();
  private sendQueue: Promise<unknown> = Promise.resolve();
  /** 注入回执通道；接收端要求 from 里的 socket 名等于发送进程 pid，所以全进程只绑一个。 */
  private receiptServer: Server | null = null;
  private receiptSink: ((chunk: string) => void) | null = null;

  app(): AppInfo {
    const hasRoot = this.roots().length > 0;
    const processError = this.scanProcesses().error;
    return {
      appId: this.key,
      provider: "anthropic",
      kind: "claude-code",
      name: "Claude Desktop · Code",
      mode: "local-store",
      status: hasRoot ? "ready" : "unavailable",
      capabilities: {
        enumerate: hasRoot ? "partial" : "unavailable",
        read: hasRoot ? "partial" : "unavailable",
        send: hasRoot && processError === null,
        sendDetail: processError
          ? `${processError}；请在终端中直接启动 Bridge，不要在受限沙箱里运行，否则无法判断哪些会话正在桌面中运行。`
          : "发送走运行中会话进程的本地 UDS 通道；会话未运行时先请求桌面用深链打开它，等进程就绪后再投递。",
        create: false,
        createDetail: "桌面 Code 会话由 Claude Desktop 创建，Bridge 只能读取并驱动已存在的会话。",
        reason: hasRoot ? undefined : "未找到 Claude Desktop 的会话元数据目录",
      },
    };
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    for (const session of this.records()) {
      const projectId = this.projectIdFor(session.projectCwd);
      const entry = map.get(projectId);
      if (entry) entry.sessionCount += 1;
      else {
        map.set(projectId, {
          projectId,
          appId: this.key,
          name: session.projectCwd ? basename(session.projectCwd) : "未分组会话",
          cwd: session.projectCwd || undefined,
          sessionCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.sessionCount - a.sessionCount);
  }

  sessions(): SessionSummary[] {
    const scan = this.scanProcesses();
    const bySession = scan.bySession;
    const out: SessionSummary[] = [];
    for (const session of this.records()) {
      const sessionId = `${this.key}:${session.localId}`;
      const pid = this.livePid(session, bySession);
      const live = pid !== undefined;
      const busy =
        scan.busy.has(session.localId) ||
        (session.cliSessionId !== "" && scan.busy.has(session.cliSessionId));
      // 未运行的会话可以让桌面用深链打开（会现场拉起 CLI 进程），
      // 所以只按「能否唤醒」判断可发送，不再要求进程已经在跑。
      const canWake = !session.archived && session.cliSessionId !== "" && scan.error === null;
      const canSend = live ? this.socketFor(pid) !== null : canWake;
      out.push({
        sessionId,
        appId: this.key,
        projectId: this.projectIdFor(session.projectCwd),
        kind: "code",
        title: (session.title || "未命名会话").slice(0, 120),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: session.archived,
        live,
        ...(busy ? { busy: true } : {}),
        canSend,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        sendBlockedReason: canSend
          ? undefined
          : scan.error ??
            (live
              ? "该会话进程没有可用的本地消息通道"
              : session.archived
                ? "会话已归档；先在桌面取消归档后再发送"
                : session.cliSessionId
                  ? "桌面上没有可用的会话进程，暂时无法唤醒"
                  : "该会话没有关联 CLI transcript，无法在桌面恢复"),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  session(sessionId: string): SessionSummary | null {
    return this.sessions().find((item) => item.sessionId === sessionId) ?? null;
  }

  messages(sessionId: string, page: MessagePage): MessageListResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    if (!record.cliSessionId) {
      return {
        messages: [],
        completeness: "partial",
        note: "该会话没有关联 CLI transcript，无法读取历史",
      };
    }
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) {
      return {
        messages: [],
        completeness: "partial",
        note: "未找到该会话的 transcript 文件",
      };
    }
    const parsed = this.readTranscript(path, sessionId);
    const all = parsed.messages;
    let end = all.length;
    if (page.before) {
      const index = all.findIndex((message) => message.messageId === page.before);
      if (index === -1) throw new RpcError("invalid_params", "未知的分页游标");
      end = index;
    }
    const start = Math.max(0, end - page.limit);
    const messages = all.slice(start, end);
    const result: MessageListResult = {
      messages,
      completeness: "partial",
      note: "仅主链文本与工具调用摘要；不含侧链、图片与工具输出全文",
    };
    if (parsed.context) result.context = parsed.context;
    if (parsed.busy) result.busy = true;
    if (parsed.interrupted) result.interrupted = true;
    if (start > 0) result.nextBefore = messages[0]?.messageId;
    return result;
  }

  rail(sessionId: string): SessionRailResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    const environment: RailRow[] = [];
    if (record.cwd) environment.push({ label: "目录", value: record.cwd });
    const branch = this.gitBranch(record);
    if (branch) environment.push({ label: "分支", value: branch });
    if (record.model) environment.push({ label: "模型", value: record.model });
    if (record.effort) environment.push({ label: "推理强度", value: record.effort });
    if (record.permissionMode) {
      environment.push({
        label: "权限",
        value: record.permissionMode === "bypassPermissions" ? "跳过确认" : record.permissionMode,
      });
    }
    const result: SessionRailResult = {
      environment,
      servers: record.mcpServers.map((name) => ({ name })),
      tasks: this.subagentTasks(record),
    };
    const context = this.contextFor(record);
    if (context) result.context = context;
    return result;
  }

  /**
   * 桌面端把模型目录缓存在 ~/.claude/cache/model-catalog，取最新的 ccd 表面那份；
   * 目录只用于展示名称与可选项，切换模型仍然只能在桌面里做。
   */
  models(sessionId: string): SessionModelsResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    const catalog = this.modelCatalog();
    // 桌面记录里可能是路由别名或带 [1m] 后缀，能对上目录时以目录里的 id 为准。
    const raw = record.model || undefined;
    const matched = raw ? matchCatalogModel(raw, catalog) : undefined;
    const current = matched?.id ?? raw;
    const currentName = matched?.name ?? raw;
    return {
      ...(current ? { current } : {}),
      ...(currentName ? { currentName } : {}),
      models: catalog,
      canSwitch: false,
      note: "模型需要在 Claude 桌面里切换；这里只展示当前会话可用的模型。",
    };
  }

  private modelCatalogCache: { at: number; models: ModelOption[] } | null = null;

  private modelCatalog(): ModelOption[] {
    const now = Date.now();
    if (this.modelCatalogCache && now - this.modelCatalogCache.at < 60_000) {
      return this.modelCatalogCache.models;
    }
    const models: ModelOption[] = [];
    try {
      const dir = join(homedir(), ".claude", "cache", "model-catalog");
      const files = readdirSync(dir)
        .filter((name) => name.endsWith("-ccd.json"))
        .map((name) => {
          const path = join(dir, name);
          try {
            return { path, mtimeMs: statSync(path).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((item): item is { path: string; mtimeMs: number } => item !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const raw = files[0] ? JSON.parse(readFileSync(files[0].path, "utf8")) : null;
      const list = raw?.catalog?.config?.models;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item?.id !== "string" || typeof item?.name !== "string") continue;
          models.push({
            id: item.id,
            name: item.name,
            ...(item.section === "main" || item.section === "overflow" ? { section: item.section } : {}),
          });
        }
      }
    } catch {
      // 没有缓存或格式变了：只展示当前模型名。
    }
    this.modelCatalogCache = { at: now, models };
    return models;
  }

  taskMessages(sessionId: string, taskId: string, page: MessagePage): MessageListResult {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    const file = this.subagentFile(record, taskId);
    if (!file) throw new RpcError("not_found", "未知后台任务");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取子任务记录");
    }
    const messages: MessageRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      const message = this.toMessage(entry, `${sessionId}#${taskId}`, messages.length, true);
      if (message) messages.push(message);
    }
    let end = messages.length;
    if (page.before) {
      const index = messages.findIndex((message) => message.messageId === page.before);
      if (index === -1) throw new RpcError("invalid_params", "未知的分页游标");
      end = index;
    }
    const start = Math.max(0, end - page.limit);
    const result: MessageListResult = {
      messages: messages.slice(start, end),
      completeness: "partial",
      note: "子任务记录：仅文本与工具调用摘要",
    };
    if (start > 0) result.nextBefore = result.messages[0]?.messageId;
    return result;
  }

  /** The branch of the working tree; the transcript may lag or be detached. */
  private gitBranch(record: DesktopSession): string | null {
    const recorded = this.transcriptBranch(record);
    if (recorded && recorded !== "HEAD") return recorded;
    return this.worktreeBranch(record.cwd) ?? recorded;
  }

  /** `cwd/.git/HEAD`, following the `gitdir:` pointer of a worktree checkout. */
  private worktreeBranch(cwd: string): string | null {
    if (!cwd) return null;
    try {
      const dotGit = join(cwd, ".git");
      let headPath = join(dotGit, "HEAD");
      if (statSync(dotGit).isFile()) {
        const pointer = readFileSync(dotGit, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/.exec(pointer);
        if (!match?.[1]) return null;
        headPath = join(resolve(cwd, match[1]), "HEAD");
      }
      const head = readFileSync(headPath, "utf8").trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref?.[1]) return ref[1];
      return head ? head.slice(0, 8) : null;
    } catch {
      return null;
    }
  }

  private transcriptBranch(record: DesktopSession): string | null {
    if (!record.cliSessionId) return null;
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) return null;
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        closeSync(fd);
      }
      const matches = buffer.toString("utf8").match(/"gitBranch":"([^"]*)"/g);
      const last = matches?.[matches.length - 1];
      const branch = last ? /"gitBranch":"([^"]*)"/.exec(last)?.[1] : undefined;
      return branch ? branch : null;
    } catch {
      return null;
    }
  }

  private contextFor(record: DesktopSession): ContextUsage | undefined {
    if (!record.cliSessionId) return undefined;
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) return undefined;
    try {
      return this.readTranscript(path, `${this.key}:${record.localId}`).context;
    } catch {
      return undefined;
    }
  }

  /** `~/.claude/projects/<project>/<cliSessionId>/subagents` for this session and its priors. */
  private subagentDirs(record: DesktopSession): string[] {
    const dirs: string[] = [];
    for (const id of [record.cliSessionId, ...record.priorCliSessionIds]) {
      if (!id) continue;
      const path = this.transcriptPath(id);
      if (!path) continue;
      const dir = join(dirname(path), id, "subagents");
      if (existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
    }
    return dirs;
  }

  private subagentFile(record: DesktopSession, taskId: string): string | null {
    if (!/^agent-[A-Za-z0-9]+$/.test(taskId)) return null;
    for (const dir of this.subagentDirs(record)) {
      const file = join(dir, `${taskId}.jsonl`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  private subagentTasks(record: DesktopSession): RailTask[] {
    const tasks: RailTask[] = [];
    const seen = new Set<string>();
    for (const dir of this.subagentDirs(record)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        const taskId = name.slice(0, -".meta.json".length);
        if (seen.has(taskId)) continue;
        const jsonl = join(dir, `${taskId}.jsonl`);
        if (!existsSync(jsonl)) continue;
        let meta: SubagentMeta;
        let metaMtimeMs = 0;
        try {
          meta = JSON.parse(readFileSync(join(dir, name), "utf8")) as SubagentMeta;
          metaMtimeMs = statSync(join(dir, name)).mtimeMs;
        } catch {
          continue;
        }
        seen.add(taskId);
        // meta 在子代理启动时写入、结束时才补 finished；运行期间只有 jsonl 在增长。
        let jsonlMtimeMs = 0;
        let startedAt: number | undefined;
        try {
          const info = statSync(jsonl);
          jsonlMtimeMs = info.mtimeMs;
          startedAt = info.birthtimeMs;
        } catch {
          // fall back to meta
        }
        const updatedAt = Math.max(metaMtimeMs, jsonlMtimeMs);
        const running = meta.finished !== true && Date.now() - updatedAt < SUBAGENT_RUNNING_MAX_AGE_MS;
        const task: RailTask = {
          taskId,
          name: meta.name || meta.description || taskId,
          kind: "subagent",
          status: running ? "running" : "done",
          updatedAt,
        };
        if (meta.name && meta.description) task.detail = meta.description;
        if (meta.agentType) task.agentType = meta.agentType;
        if (meta.pickedEffortModel) task.model = meta.pickedEffortModel;
        if (typeof meta.spawnDepth === "number") task.depth = meta.spawnDepth;
        if (startedAt) task.startedAt = startedAt;
        tasks.push(task);
      }
    }
    return tasks
      .sort((a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0))
      .slice(0, MAX_RAIL_TASKS);
  }

  messageText(sessionId: string, messageId: string): MessageText | null {
    const record = this.record(sessionId);
    if (!record?.cliSessionId) return null;
    const path = this.transcriptPath(record.cliSessionId);
    if (!path) return null;
    let transcript: string;
    try {
      transcript = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (entry.isSidechain) continue;
      if ((entry.uuid ?? "") !== messageId) continue;
      const text = this.fullTextOf(entry.message?.content);
      if (!text) return null;
      return {
        messageId,
        role: entry.type,
        createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
        text,
      };
    }
    return null;
  }

  async send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult> {
    const runSend = async (): Promise<MessageSendResult> => {
      const record = this.record(sessionId);
      if (!record) throw new RpcError("not_found", "未知会话");
      if (!record.cliSessionId) {
        throw new RpcError("adapter_unavailable", "该会话没有关联 CLI 进程，无法发送");
      }
      const scan = this.scanProcesses();
      if (scan.error) throw new RpcError("adapter_unavailable", scan.error);
      let match = this.liveMatch(record, scan.bySession);
      if (!match) {
        if (record.archived) {
          throw new RpcError("adapter_unavailable", "会话已归档；先在桌面取消归档后再发送");
        }
        if (!record.cliSessionId) {
          throw new RpcError("adapter_unavailable", "该会话没有关联 CLI transcript，无法在桌面恢复");
        }
        match = await this.wakeDesktopSession(record);
        if (!match) {
          throw new RpcError(
            "adapter_unavailable",
            "已请求 Claude 桌面打开该会话，但会话进程仍未就绪；请确认桌面正在运行后重试",
          );
        }
      }
      const target = this.socketFor(match.pid);
      if (!target) throw new RpcError("adapter_unavailable", "该会话进程没有可用的消息通道");
      const mode = record.permissionMode === "bypassPermissions" ? "bypass" : "default";
      const result = await this.injectUds(target, text, mode, origin);
      if (result.delivered) return result;
      // The CLI does not always answer with a receipt; the transcript is the
      // authoritative confirmation that the message reached the session.
      if (await this.confirmInTranscript(match.id, text)) {
        return { accepted: true, delivered: true, detail: "已写入会话记录" };
      }
      return result;
    };
    const task = this.sendQueue.then(runSend, runSend);
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * 桌面端为工作树会话写了 originCwd；没有这个字段的旧记录按路径推断，
   * 否则每个工作树都会变成一个独立项目，会话在原项目里就找不到了。
   */
  private projectCwdOf(cwd: string, originCwd: string): string {
    if (originCwd) return originCwd;
    const at = cwd.indexOf("/.claude/worktrees/");
    return at > 0 ? cwd.slice(0, at) : cwd;
  }

  private projectIdFor(cwd: string): string {
    return `${this.key}:${cwd || "ungrouped"}`;
  }

  private roots(): string[] {
    const now = Date.now();
    if (rootsCache && now - rootsCache.checkedAt < 30_000) return rootsCache.roots;
    const roots = SESSION_ROOTS.filter((root) => listSessionFiles(root).length > 0);
    rootsCache = { roots, checkedAt: now };
    return roots;
  }

  private records(): DesktopSession[] {
    // 桌面有几个数据目录（Claude / Claude-3p）会同时写入，只读其中一个会漏掉会话。
    const byId = new Map<string, DesktopSession>();
    for (const root of this.roots()) {
      for (const file of listSessionFiles(root)) {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        const cached = metaCache.get(file);
        let session: DesktopSession | null;
        if (cached && cached.mtimeMs === mtimeMs) {
          session = cached.session;
        } else {
          session = this.parseMeta(file);
          metaCache.set(file, { mtimeMs, session });
        }
        if (!session) continue;
        const existing = byId.get(session.localId);
        if (!existing || session.updatedAt > existing.updatedAt) byId.set(session.localId, session);
      }
    }
    return [...byId.values()];
  }

  private parseMeta(path: string): DesktopSession | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const localId = asString(raw["sessionId"]) || basename(path).replace(/\.json$/, "");
      const createdAt = asNumber(raw["createdAt"]);
      const cwd = asString(raw["cwd"]);
      return {
        localId,
        cliSessionId: asString(raw["cliSessionId"]),
        priorCliSessionIds: Array.isArray(raw["priorCliSessionIds"])
          ? raw["priorCliSessionIds"]
              .filter((item): item is string => typeof item === "string" && item !== "")
              .slice(-20)
          : [],
        cwd,
        projectCwd: this.projectCwdOf(cwd, asString(raw["originCwd"])),
        title: asString(raw["title"]),
        createdAt,
        updatedAt:
          asNumber(raw["lastActivityAt"]) ||
          asNumber(raw["lastTurnEdgeAt"]) ||
          asNumber(raw["lastFocusedAt"]) ||
          createdAt,
        archived: raw["isArchived"] === true,
        permissionMode: asString(raw["permissionMode"]),
        model: asString(raw["model"]),
        effort: asString(raw["effort"]),
        mcpServers: mcpServersOf(raw["enabledMcpTools"], raw["remoteMcpServersConfig"]),
      };
    } catch {
      return null;
    }
  }

  private record(sessionId: string): DesktopSession | null {
    const localId = sessionId.startsWith(`${this.key}:`)
      ? sessionId.slice(this.key.length + 1)
      : sessionId;
    return this.records().find((item) => item.localId === localId) ?? null;
  }

  private scanProcesses(maxAgeMs = 2_000): {
    bySession: Map<string, number>;
    busy: Set<string>;
    error: string | null;
  } {
    const now = Date.now();
    if (this.processCache && now - this.processCache.at < maxAgeMs) return this.processCache;
    const bySession = new Map<string, number>();
    const starts = new Map<number, number>();
    const busy = new Set<string>();
    let error: string | null = null;
    try {
      // execFileSync via promisify would be async; use a synchronous spawn to keep the
      // adapter interface synchronous for listing.
      const output = execFileSync("/bin/ps", ["-axo", "pid=,lstart=,command="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
      });
      for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const startedAt = Date.parse(match[2] ?? "");
        if (Number.isFinite(startedAt)) starts.set(pid, startedAt);
        const command = match[3] ?? "";
        if (!command.includes("claude")) continue;
        const resumed =
          /--resume(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
            command,
          ) ??
          /--session-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
            command,
          );
        const sessionId = resumed?.[1];
        if (!sessionId) continue;
        if (!bySession.has(sessionId) || this.socketFor(pid)) bySession.set(sessionId, pid);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error = message.includes("operation not permitted") || message.includes("EPERM")
        ? "无法枚举本机进程（ps 被拒绝），不能定位运行中的会话"
        : `无法枚举本机进程：${message}`;
    }
    this.mergeDesktopSessions(bySession, starts, busy);
    this.processCache = { at: now, bySession, busy, error };
    return this.processCache;
  }

  /**
   * 桌面新建对话时命令里不带 --resume，argv 无法定位会话；用 ~/.claude/sessions/<pid>.json
   * 补上 sessionId / hostSessionId。用进程启动时间排除 pid 复用，避免把消息发给别的会话。
   */
  private mergeDesktopSessions(
    bySession: Map<string, number>,
    starts: Map<number, number>,
    busy: Set<string>,
  ): void {
    let names: string[];
    try {
      names = readdirSync(LIVE_SESSIONS_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(join(LIVE_SESSIONS_DIR, name), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pid = asNumber(raw["pid"]);
      if (!pid) continue;
      const actual = starts.get(pid);
      if (actual === undefined) continue;
      const startedAt = asNumber(raw["startedAt"]);
      if (startedAt && Math.abs(actual - startedAt) > PID_REUSE_TOLERANCE_MS) continue;
      const hasSocket = this.socketFor(pid) !== null;
      // <pid>.json 里的 status 由 CLI 自己维护（idle / busy），比解析 transcript 便宜且实时。
      if (raw["status"] === "busy") {
        for (const id of [asString(raw["sessionId"]), asString(raw["hostSessionId"])]) {
          if (id) busy.add(id);
        }
      }
      for (const id of [asString(raw["sessionId"]), asString(raw["hostSessionId"])]) {
        if (!id) continue;
        if (!bySession.has(id) || hasSocket) bySession.set(id, pid);
      }
    }
  }

  private livePid(record: DesktopSession, bySession: Map<string, number>): number | undefined {
    return this.liveMatch(record, bySession)?.pid;
  }

  /**
   * 让桌面用官方深链打开这个会话，桌面会按需拉起它的 CLI 进程；
   * 等待进程与 UDS 通道都出现后再返回，超时则返回 undefined。
   */
  private async wakeDesktopSession(
    record: DesktopSession,
  ): Promise<{ pid: number; id: string } | undefined> {
    this.openDesktopSession(record.localId);
    const deadline = Date.now() + WAKE_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
      const match = this.liveMatch(record, this.scanProcesses(0).bySession);
      if (match && this.socketFor(match.pid)) return match;
    }
    return undefined;
  }

  private openDesktopSession(localId: string): void {
    const url = `claude://code/continue?session=${encodeURIComponent(localId)}`;
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args =
      process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(command, args, { timeout: 10_000 }, () => undefined);
  }

  private liveMatch(
    record: DesktopSession,
    bySession: Map<string, number>,
  ): { pid: number; id: string } | undefined {
    // The desktop rotates cliSessionId when a conversation is compacted, rewound
    // or resumed; the open tab keeps running under an id recorded in
    // priorCliSessionIds, so match any of them. hostSessionId（local_…）由
    // ~/.claude/sessions/<pid>.json 直接给出，新建对话时也能匹配。
    for (const id of [record.cliSessionId, record.localId, ...record.priorCliSessionIds]) {
      if (!id) continue;
      const pid = bySession.get(id);
      if (pid !== undefined) return { pid, id: record.cliSessionId || id };
    }
    return undefined;
  }

  private socketFor(pid: number | undefined): string | null {
    if (pid === undefined) return null;
    const direct = join(SOCKET_DIR, `${pid}.sock`);
    if (existsSync(direct)) return direct;
    try {
      for (const name of readdirSync(SOCKET_DIR)) {
        if (name.startsWith(`${pid}-`) && name.endsWith(".sock")) return join(SOCKET_DIR, name);
      }
    } catch {
      // socket dir missing
    }
    return null;
  }

  private transcriptPath(cliSessionId: string): string | null {
    const now = Date.now();
    const cached = this.transcriptPathCache.get(cliSessionId);
    if (cached && now - cached.checkedAt < 60_000) return cached.path;
    let path: string | null = null;
    try {
      for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const candidate = join(PROJECTS_DIR, dir.name, `${cliSessionId}.jsonl`);
        if (existsSync(candidate)) {
          path = candidate;
          break;
        }
      }
    } catch {
      // projects dir missing
    }
    this.transcriptPathCache.set(cliSessionId, { path, checkedAt: now });
    return path;
  }

  private readTranscript(
    path: string,
    sessionId: string,
  ): { messages: MessageRecord[]; context?: ContextUsage; busy: boolean; interrupted: boolean } {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取会话 transcript");
    }
    const cached = this.messageCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      const interrupted = cached.interrupted === true;
      return {
        messages: cached.messages,
        ...(cached.context ? { context: cached.context } : {}),
        busy: isBusy(cached.busy) && !interrupted,
        interrupted,
      };
    }

    const messages: MessageRecord[] = [];
    let context: ContextUsage | undefined;
    const busy: BusyState = { lastUserAt: 0, lastTurnEndAt: 0, lastActivityAt: 0 };
    let lastContentOrder = -1;
    let lastInterruptOrder = -1;
    let order = 0;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new RpcError("adapter_unavailable", "无法读取会话 transcript");
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      order += 1;
      if (isInterruptEntry(entry)) {
        lastInterruptOrder = order;
        continue;
      }
      const message = this.toMessage(entry, sessionId, messages.length);
      if (message) {
        messages.push(message);
        lastContentOrder = order;
      }
      const usage = this.contextOf(entry);
      if (usage) context = usage;
      trackBusy(busy, entry);
    }
    const interrupted = lastInterruptOrder > lastContentOrder;
    this.messageCache.set(path, {
      mtimeMs,
      size,
      messages,
      ...(context ? { context } : {}),
      busy,
      interrupted,
    });
    return {
      messages,
      ...(context ? { context } : {}),
      busy: isBusy(busy) && !interrupted,
      interrupted,
    };
  }

  /** Latest assistant usage entry wins; it describes the context the next turn will see. */
  private contextOf(entry: RawEntry): ContextUsage | undefined {
    if (entry.type !== "assistant" || entry.isSidechain) return undefined;
    const usage = entry.message?.usage;
    if (!usage) return undefined;
    const input = asNumber(usage["input_tokens"]);
    const cacheRead = asNumber(usage["cache_read_input_tokens"]);
    const cacheWrite = asNumber(usage["cache_creation_input_tokens"]);
    const output = asNumber(usage["output_tokens"]);
    const used = input + cacheRead + cacheWrite;
    if (used <= 0) return undefined;
    const model = asString(entry.message?.model);
    const known = /claude|opus|sonnet|haiku/i.test(model);
    return {
      usedTokens: used,
      windowTokens: isMillionTokenModel(model) ? 1_000_000 : 200_000,
      ...(model ? { model } : {}),
      ...(known ? {} : { windowEstimated: true }),
      details: [
        { label: "输入", value: input.toLocaleString("en-US") },
        { label: "缓存读", value: cacheRead.toLocaleString("en-US") },
        { label: "缓存写", value: cacheWrite.toLocaleString("en-US") },
        { label: "输出", value: output.toLocaleString("en-US") },
      ],
    };
  }

  private toMessage(
    entry: RawEntry,
    sessionId: string,
    index: number,
    allowSidechain = false,
  ): MessageRecord | null {
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    if (entry.isSidechain && !allowSidechain) return null;
    const blocks = this.extractBlocks(entry.message?.content);
    if (blocks.length === 0) return null;
    const role = entry.type;
    let origin: "local" | "peer" = "local";
    for (const block of blocks) {
      const peer = /<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(
        block.text,
      );
      if (peer?.[1] !== undefined) {
        block.text = peer[1].trim();
        origin = "peer";
      }
    }
    return {
      messageId: entry.uuid ?? `${sessionId}:${index}`,
      sessionId,
      role,
      createdAt: entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0,
      blocks,
      origin,
    };
  }

  private extractBlocks(content: unknown): MessageBlock[] {
    const blocks: MessageBlock[] = [];
    if (typeof content === "string") {
      const clean = this.stripSystem(content);
      if (clean) blocks.push({ type: "text", ...truncate(clean, MAX_BLOCK_CHARS) });
      return blocks;
    }
    if (!Array.isArray(content)) return blocks;
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        const clean = this.stripSystem(block["text"]);
        if (clean) blocks.push({ type: "text", ...truncate(clean, MAX_BLOCK_CHARS) });
      } else if (block["type"] === "tool_use") {
        const name = asString(block["name"]) || "tool";
        const nextStep = name === WRAP_UP_TOOL ? nextStepBlock(block["input"]) : null;
        if (nextStep) {
          blocks.push(nextStep);
          continue;
        }
        const ask = name === ASK_TOOL ? askBlock(block["input"], MAX_BLOCK_CHARS) : null;
        if (ask) {
          blocks.push(ask);
          continue;
        }
        const input = block["input"] === undefined ? "" : JSON.stringify(block["input"]);
        blocks.push({ type: "tool", ...truncate(`调用 ${name} ${input}`.trim(), 300) });
      }
    }
    return blocks;
  }

  private fullTextOf(content: unknown): string {
    const parts: string[] = [];
    if (typeof content === "string") {
      const clean = this.stripSystem(content);
      if (clean) parts.push(clean);
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (typeof raw !== "object" || raw === null) continue;
        const block = raw as Record<string, unknown>;
        if (block["type"] !== "text" || typeof block["text"] !== "string") continue;
        const clean = this.stripSystem(block["text"]);
        if (clean) parts.push(clean);
      }
    }
    const joined = parts.join("\n\n");
    const peer = /<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(joined);
    return (peer?.[1] ?? joined).trim();
  }

  private stripSystem(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  }

  private async confirmInTranscript(cliSessionId: string, text: string): Promise<boolean> {
    const path = this.transcriptPath(cliSessionId);
    if (!path) return false;
    const needle = text.trim().slice(0, 40);
    if (!needle) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let messages: MessageRecord[] = [];
      try {
        messages = this.readTranscript(path, `${this.key}:${cliSessionId}`).messages;
      } catch {
        return false;
      }
      for (const message of messages.slice(-8)) {
        if (message.role !== "user") continue;
        if (
          message.blocks.some((block) => block.type === "text" && block.text.includes(needle))
        ) {
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  /**
   * 接收端（CLI 2.1.319）用 LOCAL_PEERPID 校验发送进程，要求信封里的 socket 名等于发送
   * 进程 pid，所以地址只能是 `<pid>.sock`，不能每封换名字。发送由 sendQueue 串行化，
   * 同一时刻只有一封在途，因此全进程绑一个常驻回执通道，把收到的行交给当前在途的那封；
   * 不再按次创建/删除监听，也不会出现「收件地址短暂不存在」的窗口期。
   */
  private receiptChannel(): Promise<void> {
    if (this.receiptServer) return Promise.resolve();
    const own = join(SOCKET_DIR, `${process.pid}.sock`);
    return new Promise<void>((resolve, reject) => {
      if (existsSync(own)) {
        try {
          unlinkSync(own);
        } catch {
          // ignore
        }
      }
      const server = createServer((connection) => {
        connection.setEncoding("utf8");
        connection.on("data", (chunk: string) => this.receiptSink?.(chunk));
        connection.on("error", () => undefined);
      });
      server.once("error", reject);
      server.listen(own, () => {
        server.off("error", reject);
        server.on("error", () => undefined);
        try {
          chmodSync(own, 0o600);
        } catch {
          // best effort
        }
        this.receiptServer = server;
        // 监听常驻，退出时再清理，免得 /tmp/cc-socks 里留下无主 socket。
        process.once("exit", () => {
          try {
            if (existsSync(own)) unlinkSync(own);
          } catch {
            // ignore
          }
        });
        resolve();
      });
    });
  }

  private injectUds(target: string, text: string, mode: string, origin?: string): Promise<MessageSendResult> {
    const own = join(SOCKET_DIR, `${process.pid}.sock`);
    return new Promise<MessageSendResult>((resolve, reject) => {
      let settled = false;
      const receipts: string[] = [];
      let client: Socket | null = null;
      const finish = (result: MessageSendResult | Error): void => {
        if (settled) return;
        settled = true;
        this.receiptSink = null;
        try {
          client?.destroy();
        } catch {
          // ignore
        }
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const enqueueReceipt = (raw: string): void => {
        for (const line of raw.split("\n")) {
          if (line.trim()) receipts.push(line.trim());
        }
      };
      const settleFromReceipts = (): void => {
        const joined = receipts.join("\n");
        const status = /"status"\s*:\s*"([a-z_]+)"/.exec(joined)?.[1];
        if (!status) return;
        finish({
          accepted: status !== "refused",
          delivered: status === "delivered",
          detail:
            status === "held"
              ? "目标会话正忙，消息已交给桌面排队"
              : status === "refused"
                ? "目标会话拒绝接收该消息"
                : status,
        });
      };

      this.receiptChannel().then(
        () => {
          if (settled) return;
          this.receiptSink = (chunk: string) => {
            enqueueReceipt(chunk);
            settleFromReceipts();
          };
          client = createConnection(target);
          client.setEncoding("utf8");
          client.on("connect", () => {
            const envelope = `<cross-session-message from="uds:${own}" from-name="${senderLabel(origin)}" from-mode="${mode}">\n${text}\n</cross-session-message>`;
            const frame = {
              msg_id: randomUUID(),
              type: "user",
              message: { role: "user", content: envelope },
              priority: "next",
              from: `uds:${own}`,
            };
            client?.write(`${JSON.stringify(frame)}\n`);
          });
          client.on("data", (chunk: string) => {
            enqueueReceipt(chunk);
            settleFromReceipts();
          });
          client.on("error", (error) => finish(error));
          client.setTimeout(3_000, () => {
            finish({
              accepted: true,
              delivered: false,
              detail:
                receipts.length > 0
                  ? `未收到投递确认：${receipts.join(" ").slice(0, 200)}`
                  : "已写入本地通道，但未收到投递确认",
            });
          });
        },
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
      setTimeout(() => {
        finish({
          accepted: true,
          delivered: false,
          detail:
            receipts.length > 0
              ? `未收到投递确认：${receipts.join(" ").slice(0, 200)}`
              : "已写入本地通道，但未收到投递确认",
        });
      }, 4_000).unref();
    });
  }
}
