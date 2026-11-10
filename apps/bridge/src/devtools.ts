// Remote devtools: read-only project file browsing plus single command execution.
// The two capabilities are switched independently, both off by default, and each is
// only usable while the local user has switched it on from the menu bar app or
// `agent-bridge devtools`. File browsing never leaves the chat's own project directory.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import {
  DEVTOOLS_CAPABILITIES,
  MAX_MESSAGE_BYTES,
  type DevtoolsCapability,
  type DevtoolsCapabilityName,
  type DevtoolsStatus,
  type FsEntry,
  type FsListResult,
  type FsReadResult,
  type FsRoot,
  type FsRootsResult,
  type ShellCancelResult,
  type ShellEventData,
  type ShellExecResult,
} from "@agent-bridge/protocol";
import type { SessionAdapters } from "./adapters/index.js";
import { RpcError } from "./adapters/types.js";
import type { Store } from "./store.js";

const MAX_TEXT_BYTES = 1024 * 1024;
/**
 * Base64 inflates by 4/3 and the response envelope adds a little more, so a raw
 * image limit near MAX_MESSAGE_BYTES would make `seal()` reject the reply and
 * drop the device channel. Leave headroom for the encoding and the JSON wrapper.
 */
const MAX_IMAGE_BYTES = Math.floor((MAX_MESSAGE_BYTES * 3) / 4) - 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ENTRIES = 2_000;

type Capability = DevtoolsCapabilityName;
type ScopedRoot = FsRoot & { real: string };

const CAPABILITY_LABEL: Record<Capability, string> = {
  files: "文件浏览",
  terminal: "命令执行",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".jsx": "text/plain",
  ".mjs": "text/plain",
  ".cjs": "text/plain",
  ".css": "text/plain",
  ".html": "text/plain",
  ".xml": "text/plain",
  ".svg": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".toml": "text/plain",
  ".sh": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".swift": "text/plain",
  ".sql": "text/plain",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
};

export function isDevtoolsCapability(value: unknown): value is Capability {
  return typeof value === "string" && (DEVTOOLS_CAPABILITIES as readonly string[]).includes(value);
}

interface ExecRecord {
  proc: ChildProcess;
  owner: string;
  killed: boolean;
  truncated: boolean;
  startedAt: number;
  timer: NodeJS.Timeout;
}

/** An exec still waiting on the adapter index; a closing channel cancels it before spawn. */
interface PendingExec {
  owner: string;
  cancelled: boolean;
}

interface ExpiryState {
  timer: NodeJS.Timeout | null;
  for: number | null;
}

/** An exec still waiting on the adapter index; a closing channel cancels it before spawn. */
interface PendingExec {
  owner: string;
  cancelled: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class Devtools {
  private execs = new Map<string, ExecRecord>();
  private pendingExecs = new Set<PendingExec>();
  private rootsCache: { at: number; roots: ScopedRoot[] } | null = null;
  private rootsLoading: Promise<ScopedRoot[]> | null = null;
  private readonly expiry = new Map<Capability, ExpiryState>();

  constructor(
    private readonly store: Store,
    private readonly adapters: SessionAdapters,
    private readonly log: (line: string) => void,
  ) {}

  status(): DevtoolsStatus {
    return { files: this.readCapability("files"), terminal: this.readCapability("terminal") };
  }

  private readCapability(capability: Capability): DevtoolsCapability {
    const stored = this.store.meta(`devtools_${capability}_enabled`) === "1";
    if (!stored) return { enabled: false, expiresAt: null };
    const expiresAt = Number(this.store.meta(`devtools_${capability}_expires_at`) ?? "") || null;
    if (expiresAt !== null && expiresAt <= Date.now()) {
      this.disable(capability, "expired");
      return { enabled: false, expiresAt: null };
    }
    this.armExpiry(capability, expiresAt);
    return { enabled: true, expiresAt };
  }

  /**
   * Shuts a capability down at its deadline even if no client asks for status again;
   * a command started just before expiry would otherwise keep running.
   */
  private armExpiry(capability: Capability, expiresAt: number | null): void {
    const current = this.expiry.get(capability);
    if (current && current.for === expiresAt && (expiresAt === null || current.timer)) return;
    this.clearExpiry(capability);
    const state: ExpiryState = { timer: null, for: expiresAt };
    if (expiresAt !== null) {
      const timer = setTimeout(() => {
        state.timer = null;
        state.for = null;
        this.disable(capability, "expired");
      }, Math.max(0, expiresAt - Date.now()));
      timer.unref();
      state.timer = timer;
    }
    this.expiry.set(capability, state);
  }

  private clearExpiry(capability: Capability): void {
    const current = this.expiry.get(capability);
    if (current?.timer) clearTimeout(current.timer);
    this.expiry.delete(capability);
  }

  private disable(capability: Capability, reason: "manual" | "expired"): void {
    this.clearExpiry(capability);
    this.store.setMeta(`devtools_${capability}_enabled`, "0");
    this.store.setMeta(`devtools_${capability}_expires_at`, "");
    // Commands belong to the terminal switch; file browsing never started any.
    if (capability === "terminal") this.killAll();
    const label = CAPABILITY_LABEL[capability];
    this.log(reason === "expired" ? `${label}已到期，自动关闭` : `${label}已关闭`);
  }

  setEnabled(capability: Capability, enabled: boolean, ttlSeconds?: number | null): DevtoolsStatus {
    if (!enabled) {
      this.disable(capability, "manual");
      return this.status();
    }
    const ttl = ttlSeconds === null || ttlSeconds === undefined ? null : clamp(Math.round(ttlSeconds), 60, 86400);
    const expiresAt = ttl === null ? null : Date.now() + ttl * 1000;
    this.store.setMeta(`devtools_${capability}_enabled`, "1");
    this.store.setMeta(`devtools_${capability}_expires_at`, expiresAt === null ? "" : String(expiresAt));
    this.armExpiry(capability, expiresAt);
    const label = CAPABILITY_LABEL[capability];
    this.log(
      `${label}已开启${expiresAt === null ? "（不自动关闭）" : `，${new Date(expiresAt).toLocaleTimeString()} 失效`}`,
    );
    return this.status();
  }

  private requireCapability(capability: Capability): void {
    if (!this.readCapability(capability).enabled) {
      throw new RpcError("unsupported", `${CAPABILITY_LABEL[capability]}未开启，请在 Mac 菜单栏中打开`);
    }
  }

  /** `root` must be one of the known project directories; the reply names it back. */
  async roots(root: string): Promise<FsRootsResult> {
    this.requireCapability("files");
    const scoped = await this.scope(root);
    // Root lookup can wait on the adapter index; the switch may have gone off meanwhile.
    this.requireCapability("files");
    return { enabled: true, roots: [{ name: scoped.name, path: scoped.path }] };
  }

  /**
   * The adapter index is async (dsh indexes its sessions lazily), so roots are
   * loaded asynchronously and kept for 5 s. Concurrent callers share one load.
   */
  private async allRoots(): Promise<ScopedRoot[]> {
    const cached = this.rootsCache;
    if (cached && Date.now() - cached.at < 5_000) return cached.roots;
    if (this.rootsLoading) return this.rootsLoading;
    const loading = this.loadRoots();
    this.rootsLoading = loading;
    try {
      return await loading;
    } finally {
      this.rootsLoading = null;
    }
  }

  private async loadRoots(): Promise<ScopedRoot[]> {
    const seen = new Set<string>();
    const roots: ScopedRoot[] = [];
    for (const project of (await this.adapters.projects()).projects) {
      if (!project.cwd) continue;
      let real: string;
      try {
        real = realpathSync(project.cwd);
        if (!statSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push({ name: project.name || basename(real), path: real, real });
    }
    this.rootsCache = { at: Date.now(), roots };
    return roots;
  }

  /**
   * Resolves the chat's project directory. Only a directory that belongs to one of
   * the known projects is accepted, so a device cannot aim the browser at `/`.
   */
  private async scope(root: string): Promise<ScopedRoot> {
    let want: string;
    try {
      want = realpathSync(resolve(root));
    } catch {
      throw new RpcError("not_found", "项目目录不存在");
    }
    const match = (await this.allRoots()).find((item) => item.real === want);
    if (!match) throw new RpcError("unauthorized", "只能访问当前会话所属的项目目录");
    return match;
  }

  /** Resolves a client path and refuses anything outside the scoped project root. */
  private resolveInside(root: ScopedRoot, path: string): string {
    let real: string;
    try {
      real = realpathSync(resolve(root.real, path));
    } catch {
      throw new RpcError("not_found", "路径不存在");
    }
    if (real !== root.real && !real.startsWith(root.real + sep)) {
      throw new RpcError("unauthorized", "路径不在该项目目录内");
    }
    return real;
  }

  async listDirs(root: string, path?: string): Promise<FsListResult> {
    this.requireCapability("files");
    const scoped = await this.scope(root);
    // Root lookup can wait on the adapter index; the switch may have gone off meanwhile.
    this.requireCapability("files");
    const real = path ? this.resolveInside(scoped, path) : scoped.real;
    let stats;
    try {
      stats = statSync(real);
    } catch {
      throw new RpcError("not_found", "路径不存在");
    }
    if (!stats.isDirectory()) throw new RpcError("invalid_params", "不是目录");
    const entries: FsEntry[] = [];
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = `${real}${sep}${entry.name}`;
      let childStats;
      try {
        childStats = statSync(child);
      } catch {
        continue;
      }
      const isDir = entry.isDirectory();
      entries.push({
        name: entry.name,
        path: child,
        type: isDir ? "dir" : "file",
        ...(isDir ? {} : { size: childStats.size }),
        mtime: childStats.mtimeMs,
      });
      if (entries.length >= MAX_ENTRIES) break;
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      path: real,
      parent: real === scoped.real ? null : dirname(real),
      entries,
    };
  }

  async readFile(root: string, path: string): Promise<FsReadResult> {
    this.requireCapability("files");
    const scoped = await this.scope(root);
    // Root lookup can wait on the adapter index; the switch may have gone off meanwhile.
    this.requireCapability("files");
    const real = this.resolveInside(scoped, path);
    let stats;
    try {
      stats = statSync(real);
    } catch {
      throw new RpcError("not_found", "路径不存在");
    }
    if (!stats.isFile()) throw new RpcError("invalid_params", "不是文件");
    const ext = extname(real).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    const limit = imageMime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    const truncated = stats.size > limit;
    if (imageMime && truncated) throw new RpcError("invalid_params", "图片过大，无法预览");
    // Never read past the limit: a huge file must not be pulled into memory just to be cut.
    const length = Math.min(stats.size, limit);
    const buffer = Buffer.alloc(length);
    const fd = openSync(real, "r");
    try {
      readSync(fd, buffer, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    if (imageMime) {
      return {
        path: real,
        name: basename(real),
        mime: imageMime,
        size: stats.size,
        mtime: stats.mtimeMs,
        truncated: false,
        dataBase64: buffer.toString("base64"),
      };
    }
    // A NUL byte early in the file means binary; refuse instead of rendering noise.
    const head = buffer.subarray(0, Math.min(buffer.length, 8192));
    if (head.includes(0)) throw new RpcError("invalid_params", "二进制文件无法预览");
    return {
      path: real,
      name: basename(real),
      mime: TEXT_MIME[ext] ?? "text/plain",
      size: stats.size,
      mtime: stats.mtimeMs,
      truncated,
      text: buffer.toString("utf8"),
    };
  }

  async exec(
    owner: string,
    root: string,
    command: string,
    cwd: string | undefined,
    timeoutMs: number | undefined,
    emit: (data: ShellEventData) => void,
  ): Promise<ShellExecResult> {
    this.requireCapability("terminal");
    const text = command.trim();
    if (!text) throw new RpcError("invalid_params", "命令不能为空");
    if (text.length > 8_000) throw new RpcError("invalid_params", "命令过长");
    // Registered before the root lookup: a channel closed while we wait must not spawn.
    const pending: PendingExec = { owner, cancelled: false };
    this.pendingExecs.add(pending);
    let workdir: string;
    try {
      const scoped = await this.scope(root);
      workdir = cwd ? this.resolveInside(scoped, cwd) : scoped.real;
    } finally {
      this.pendingExecs.delete(pending);
    }
    if (pending.cancelled) throw new RpcError("unsupported", "设备通道已断开");
    // The switch can be turned off, or expire, while the adapter index is loading.
    this.requireCapability("terminal");
    const timeout = clamp(Math.round(timeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000, MAX_TIMEOUT_MS);
    const shell = process.env["SHELL"] && existsSync(process.env["SHELL"]) ? process.env["SHELL"] : "/bin/sh";
    const execId = randomUUID();
    const startedAt = Date.now();
    const proc = spawn(shell, ["-lc", text], {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so cancellation reaches anything the command started.
      detached: process.platform !== "win32",
    });
    const record: ExecRecord = {
      proc,
      owner,
      killed: false,
      truncated: false,
      startedAt,
      timer: setTimeout(() => this.kill(execId, false), timeout),
    };
    this.execs.set(execId, record);
    this.log(`[${owner.slice(0, 8)}] $ ${text}（${workdir}）`);

    let bytes = 0;
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (record.truncated) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        record.truncated = true;
        emit({ execId, type: stream, data: "\n…输出超过 1 MB，已截断并终止\n" });
        this.kill(execId, true);
        return;
      }
      emit({ execId, type: stream, data: chunk.toString("utf8") });
    };
    proc.stdout?.on("data", forward("stdout"));
    proc.stderr?.on("data", forward("stderr"));
    proc.on("error", (error: Error) => {
      clearTimeout(record.timer);
      this.execs.delete(execId);
      emit({ execId, type: "stderr", data: `${error.message}\n` });
      emit({
        execId,
        type: "exit",
        code: null,
        signal: null,
        killed: false,
        durationMs: Date.now() - startedAt,
        truncated: record.truncated,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(record.timer);
      // A background job (`cmd &` with redirected output) lets the shell exit while the
      // group lives on; sweep it before the record is dropped, or nothing can stop it later.
      this.sweepGroup(record.proc.pid);
      if (!this.execs.delete(execId)) return;
      emit({
        execId,
        type: "exit",
        code,
        signal,
        killed: record.killed,
        durationMs: Date.now() - startedAt,
        truncated: record.truncated,
      });
    });
    return { execId, cwd: workdir };
  }

  cancel(execId: string): ShellCancelResult {
    const record = this.execs.get(execId);
    if (!record) return { ok: true, killed: false };
    this.kill(execId, true);
    return { ok: true, killed: true };
  }

  /** Kills everything a closed device channel started. */
  disposeOwner(owner: string): void {
    for (const pending of this.pendingExecs) {
      if (pending.owner === owner) pending.cancelled = true;
    }
    for (const [execId, record] of this.execs) {
      if (record.owner === owner) this.kill(execId, false);
    }
  }

  private killAll(): void {
    for (const execId of [...this.execs.keys()]) this.kill(execId, false);
  }

  private kill(execId: string, byUser: boolean): void {
    const record = this.execs.get(execId);
    if (!record) return;
    record.killed = true;
    if (byUser) this.log(`已终止命令 ${execId.slice(0, 8)}`);
    const pid = record.proc.pid;
    this.signalGroup(pid, "SIGTERM");
    setTimeout(() => this.signalGroup(pid, "SIGKILL"), 2_000).unref();
  }

  /** Signals the whole group: the shell's children outlive a signal sent to the shell alone. */
  private signalGroup(pid: number | undefined, name: NodeJS.Signals): void {
    if (pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, name);
      else process.kill(pid, name);
    } catch {
      // already gone
    }
  }

  /** Terminates whatever the group still holds after its shell exited. */
  private sweepGroup(pid: number | undefined): void {
    if (pid === undefined || process.platform === "win32") return;
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    this.signalGroup(pid, "SIGTERM");
    setTimeout(() => this.signalGroup(pid, "SIGKILL"), 2_000).unref();
  }
}
