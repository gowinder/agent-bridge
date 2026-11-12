import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppInfo, MessageSendResult, SessionModelsResult, SessionSummary } from "@craftstead/protocol";
import { defaultStateDir } from "../store.js";
import { ClaudeCodeAdapter, type DesktopSession } from "./claude-code.js";
import { RpcError } from "./types.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 120;
const EXCLUDE_CACHE_MS = 10_000;
/** 远程续写不沿用的高权限模式：没有交互界面可确认。 */
const RESUME_UNSAFE_MODES = new Set(["bypassPermissions", "dontAsk", "auto", "acceptEdits"]);

interface TranscriptHead {
  cwd: string;
  title: string;
  createdAt: number;
}

interface TranscriptIndex {
  mtimeMs: number;
  size: number;
  cwd: string;
  title: string;
  createdAt: number;
  permissionMode: string;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  permissionMode?: string;
  summary?: string;
  message?: { content?: unknown };
}

/**
 * 独立展示终端里 `claude` 创建的会话。数据仍来自 ~/.claude/projects 的 transcript，
 * 但排除已被 Claude 桌面索引和 Bridge 托管会话占用的那些，避免同一个会话出现两份。
 */
export class ClaudeCodeCliAdapter extends ClaudeCodeAdapter {
  override readonly key: string = "claude-code-cli";
  private readonly indexCache = new Map<string, TranscriptIndex>();
  private exclusionCache: { at: number; ids: Set<string> } | null = null;
  private sendTail: Promise<unknown> = Promise.resolve();

  override app(): AppInfo {
    const hasRoot = existsSync(PROJECTS_DIR);
    const processError = this.scanProcesses().error;
    return {
      appId: this.key,
      provider: "anthropic",
      kind: "claude-code-cli",
      name: "Claude Code · CLI",
      mode: "cli",
      status: hasRoot ? "ready" : "unavailable",
      capabilities: {
        enumerate: hasRoot ? "partial" : "unavailable",
        read: hasRoot ? "partial" : "unavailable",
        send: hasRoot && processError === null,
        sendDetail: processError
          ? `${processError}；请在终端中直接启动 Bridge，不要在受限沙箱里运行。`
          : "运行中的 CLI 进程走 /tmp/cc-socks 注入；未运行的会话由 Bridge 用 claude --resume -p 恢复一轮，并沿用该会话上次的权限模式（default 模式下需要确认的操作在非交互恢复时会被拒绝）。",
        create: false,
        createDetail: "CLI 会话由终端里的 claude 创建；Bridge 只读取并驱动已有会话。",
        reason: hasRoot ? undefined : "未找到 ~/.claude/projects",
      },
    };
  }

  override sessions(): SessionSummary[] {
    const scan = this.scanProcesses();
    const out: SessionSummary[] = [];
    for (const session of this.records()) {
      const sessionId = `${this.key}:${session.localId}`;
      const pid = this.livePid(session, scan.bySession);
      const live = pid !== undefined;
      const busy =
        scan.busy.has(session.localId) ||
        (session.cliSessionId !== "" && scan.busy.has(session.cliSessionId));
      const socket = live ? this.socketFor(pid) : null;
      const canSend = scan.error === null && (!live || socket !== null);
      const needsDecision = busy ? this.pendingAsk(session) : false;
      const summary: SessionSummary = {
        sessionId,
        appId: this.key,
        projectId: this.projectIdFor(session.projectCwd),
        kind: "code",
        title: (session.title || "未命名会话").slice(0, MAX_TITLE_CHARS),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: false,
        live,
        ...(busy ? { busy: true } : {}),
        ...(needsDecision ? { needsDecision: true } : {}),
        canSend,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        sendBlockedReason: canSend
          ? undefined
          : scan.error ??
            (live ? "该会话进程没有可用的本地消息通道" : "无法通过 claude --resume 恢复该会话"),
      };
      out.push(summary);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  override models(sessionId: string): SessionModelsResult {
    const result = super.models(sessionId);
    return {
      ...result,
      canSwitch: false,
      note: "模型在终端会话里切换；这里只展示转录里最后一次实际使用的模型。",
    };
  }

  override async send(sessionId: string, text: string, origin?: string): Promise<MessageSendResult> {
    const task = this.sendTail.then(
      () => this.doSend(sessionId, text, origin),
      () => this.doSend(sessionId, text, origin),
    );
    this.sendTail = task.catch(() => undefined);
    return task;
  }

  private async doSend(
    sessionId: string,
    text: string,
    origin?: string,
  ): Promise<MessageSendResult> {
    const record = this.record(sessionId);
    if (!record) throw new RpcError("not_found", "未知会话");
    if (!text.trim()) throw new RpcError("invalid_params", "消息不能为空");
    const scan = this.scanProcesses();
    if (scan.error) throw new RpcError("adapter_unavailable", scan.error);

    const match = this.liveMatch(record, scan.bySession);
    if (match) {
      const target = this.socketFor(match.pid);
      if (!target) throw new RpcError("adapter_unavailable", "该会话进程没有可用的消息通道");
      // 与桌面适配器一致：目标声明 bypassPermissions 时，信封也必须声明同一模式。
      const mode = record.permissionMode === "bypassPermissions" ? "bypass" : "default";
      const result = await this.injectUds(target, text, mode, origin);
      if (result.delivered) return result;
      if (await this.confirmInTranscript(match.id, text)) {
        return { accepted: true, delivered: true, detail: "已写入会话记录" };
      }
      return result;
    }

    this.resumeTurn(record, text);
    const downgraded =
      !!record.permissionMode && RESUME_UNSAFE_MODES.has(record.permissionMode);
    return {
      accepted: true,
      delivered: false,
      detail: `已让 Bridge 用 claude --resume 恢复该 CLI 会话执行这一轮（权限模式 ${
        downgraded ? "默认" : record.permissionMode || "默认"
      }${downgraded ? `；安全降级：远程续写不沿用 ${record.permissionMode}` : ""}）`,
    };
  }

  /** 会话没有运行中的进程时，用一个 -p 进程接续同一 session id。 */
  private resumeTurn(record: DesktopSession, text: string): void {
    const cli = process.env["AGENT_BRIDGE_CLAUDE_PATH"] || "claude";
    const args = [
      "-p",
      "--resume",
      record.cliSessionId,
      "--output-format",
      "json",
    ];
    // 远程触发的新进程没人盯着，不沿用高权限模式，交给 CLI 默认值兜底。
    if (record.permissionMode && !RESUME_UNSAFE_MODES.has(record.permissionMode)) {
      args.push("--permission-mode", record.permissionMode);
    }
    const child = spawn(cli, args, {
      cwd: record.cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.unref();
    try {
      child.stdin?.end(text);
    } catch {
      // 进程已经退出时忽略；消息没进去，网页下一轮会从 transcript 看出来。
    }
  }

  protected override records(): DesktopSession[] {
    const excluded = this.excludedSessionIds();
    const byId = new Map<string, DesktopSession>();
    for (const dir of this.projectDirs()) {
      const base = join(PROJECTS_DIR, dir);
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        if (!SESSION_ID_RE.test(id) || excluded.has(id)) continue;
        const index = this.indexFor(join(base, name));
        if (!index) continue;
        const session: DesktopSession = {
          localId: id,
          cliSessionId: id,
          priorCliSessionIds: [],
          cwd: index.cwd,
          projectCwd: this.projectCwdOf(index.cwd, ""),
          title: index.title,
          createdAt: index.createdAt,
          updatedAt: index.mtimeMs,
          archived: false,
          permissionMode: index.permissionMode,
          model: "",
          effort: "",
          mcpServers: [],
        };
        const existing = byId.get(id);
        if (!existing || session.updatedAt > existing.updatedAt) byId.set(id, session);
      }
    }
    return [...byId.values()];
  }

  private projectDirs(): string[] {
    try {
      return readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private indexFor(path: string): TranscriptIndex | null {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      return null;
    }
    if (size === 0) return null;
    const cached = this.indexCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;

    const head = this.readHead(path, size);
    if (!head) return null;
    const tail = this.readTail(path, size);
    const index: TranscriptIndex = {
      mtimeMs,
      size,
      cwd: head.cwd,
      title: head.title,
      createdAt: head.createdAt,
      permissionMode: lastPermissionMode(tail),
    };
    this.indexCache.set(path, index);
    return index;
  }

  private readHead(path: string, size: number): TranscriptHead | null {
    let text: string;
    try {
      text = readWindow(path, 0, Math.min(size, HEAD_BYTES));
    } catch {
      return null;
    }
    let cwd = "";
    let summary = "";
    let firstUser = "";
    let createdAt = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
      if (!createdAt && typeof entry.timestamp === "string") {
        createdAt = Date.parse(entry.timestamp) || 0;
      }
      if (entry.type === "summary" && typeof entry.summary === "string" && !summary) {
        summary = entry.summary;
      }
      if (firstUser || entry.type !== "user" || entry.isSidechain) continue;
      const text = textOf(entry.message?.content);
      if (text) firstUser = text;
    }
    return {
      cwd,
      title: cleanTitle(summary || firstUser),
      createdAt: createdAt || Date.now(),
    };
  }

  private readTail(path: string, size: number): string {
    const length = Math.min(size, TAIL_BYTES);
    try {
      return readWindow(path, size - length, length);
    } catch {
      return "";
    }
  }

  /** 桌面索引和托管记录里的会话已经从各自入口展示，CLI 入口不再重复列出。 */
  private excludedSessionIds(): Set<string> {
    const now = Date.now();
    if (this.exclusionCache && now - this.exclusionCache.at < EXCLUDE_CACHE_MS) {
      return this.exclusionCache.ids;
    }
    const ids = new Set<string>();
    try {
      for (const session of this.desktopRecords()) {
        if (session.cliSessionId) ids.add(session.cliSessionId);
        for (const prior of session.priorCliSessionIds) ids.add(prior);
      }
    } catch {
      // 桌面目录读不到时按空处理，宁可多列也不把 CLI 会话全吞掉。
    }
    try {
      const raw = JSON.parse(
        readFileSync(join(defaultStateDir(), "hosted", "sessions.json"), "utf8"),
      ) as { sessions?: Array<{ id?: unknown }> };
      for (const item of raw.sessions ?? []) {
        if (typeof item.id === "string" && item.id) ids.add(item.id);
      }
    } catch {
      // 还没有托管会话。
    }
    this.exclusionCache = { at: now, ids };
    return ids;
  }
}

function readWindow(path: string, start: number, length: number): string {
  let fd: number | undefined;
  try {
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.join("\n");
}

function cleanTitle(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

function lastPermissionMode(tail: string): string {
  let mode = "";
  for (const match of tail.matchAll(/"permissionMode"\s*:\s*"([^"]+)"/g)) {
    if (match[1]) mode = match[1];
  }
  return mode;
}
