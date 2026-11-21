// Remote devtools: read-only project file browsing plus single command execution.
// The two capabilities are switched independently, both off by default, and each is
// only usable while the local user has switched it on from the menu bar app or
// `agent-bridge devtools`. File browsing never leaves the chat's own project directory.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
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
} from "@craftstead/protocol";
import type { SessionAdapters } from "./adapters/index.js";
import { FsScope, FsScopeError } from "./fs-scope.js";
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
/** 同时运行的命令上限：一条长命令最多占用 10 分钟，不设上限就成了一键 fork bomb。 */
const MAX_CONCURRENT_EXECS = 8;

type Capability = DevtoolsCapabilityName;
/** `projectIds` keeps every adapter project that resolves to this directory, so a chat in any of them is accepted. */
type ScopedRoot = FsRoot & { real: string; projectIds: Set<string>; realResolved?: string };

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

/** 纯字符串判断 `path` 是否落在 `root` 里（两者都是已归一化的绝对路径）。 */
function isUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}${sep}`);
}

/** 系统拒绝（macOS 的文件夹授权没给）：既不是越界，也不是路径不存在，要对用户说清楚。 */
export function permissionError(error: unknown): RpcError | null {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  if (code !== "EPERM" && code !== "EACCES") return null;
  return new RpcError(
    "unauthorized",
    "macOS 没有授予这个目录的访问权限：到「系统设置 → 隐私与安全性 → 文件与文件夹」给 AgentBridge 勾上，或者在设置里重新添加这个目录再点一次允许",
  );
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
  /** uploads 根的真实路径；undefined 表示还没算过，null 表示目录不存在。 */
  private uploadsReal: string | null | undefined;
  /** 枚举收口：工程白名单之外的路径一律拒绝，见 fs-scope.ts。 */
  private readonly fs: FsScope;
  /** 基础授权根（托管白名单 + 状态目录）的缓存：枚举每个子项都要判一次，不能每次都去 stat 白名单。 */
  private baseRoots: string[] = [];
  private baseRootsAt = 0;

  constructor(
    private readonly store: Store,
    private readonly adapters: SessionAdapters,
    private readonly log: (line: string) => void,
  ) {
    this.fs = new FsScope({ roots: () => this.currentBaseRoots(), log });
  }

  /** 托管白名单是用户自己点过头的根；状态目录里的 uploads 属于 Bridge 自己的数据。 */
  private currentBaseRoots(): string[] {
    if (Date.now() - this.baseRootsAt < 5_000) return this.baseRoots;
    const roots: string[] = [];
    for (const dir of this.adapters.hostedDirs().dirs) {
      if (!dir.allowed) continue;
      roots.push(dir.path);
      // 白名单是用户点过头的根，对它 realpath 是安全的。两种写法都登记：
      // 会话记录里的 cwd 存的是 realpath 后的值，只认原样写法会把符号链接的白名单目录判成越界。
      try {
        const real = realpathSync(dir.path);
        if (real !== dir.path) roots.push(real);
      } catch {
        // 目录已经不在了：保留原样写法，交给使用方报「不存在」。
      }
    }
    this.baseRoots = [...roots, this.store.dir, join(this.store.dir, "uploads")];
    this.baseRootsAt = Date.now();
    return this.baseRoots;
  }

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

  /** `root` must be the project directory of `sessionId`; the reply names it back. */
  async roots(sessionId: string | undefined, root: string): Promise<FsRootsResult> {
    this.requireCapability("files");
    const scoped = await this.scope(sessionId, root);
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
    const seen = new Map<string, ScopedRoot>();
    const roots: ScopedRoot[] = [];
    for (const project of (await this.adapters.projects()).projects) {
      if (!project.cwd) continue;
      // 只做纯字符串归一，不 realpath/stat：这份索引每几秒重建一次，而工程目录可能
      // 落在桌面/文档/下载/外置磁盘上，碰一次就要弹一次「文件与文件夹」授权。
      // 真正读文件时才解析真实路径（scope / read），符号链接在那儿兜底。
      const real = resolve(project.cwd);
      const existing = seen.get(real);
      if (existing) {
        existing.projectIds.add(project.projectId);
        continue;
      }
      const root: ScopedRoot = {
        name: project.name || basename(real),
        path: real,
        real,
        projectIds: new Set([project.projectId]),
      };
      seen.set(real, root);
      roots.push(root);
    }
    // 工程目录就是这一份索引里的根：登记进枚举闸门，以后往这些目录里走就不算越界。
    this.fs.setExtraRoots(roots.map((root) => root.real));
    this.rootsCache = { at: Date.now(), roots };
    return roots;
  }

  /**
   * Resolves the chat's project directory. `sessionId` must resolve to the same
   * project as `root`, so a device cannot aim the browser at another project or at `/`.
   */
  private async scope(sessionId: string | undefined, root: string): Promise<ScopedRoot> {
    if (!sessionId) throw new RpcError("invalid_params", "sessionId required");
    const { session } = await this.adapters.session(sessionId);
    // A missing path must not be reported differently from a foreign one, or the
    // device could probe the filesystem for existence outside the project.
    const roots = await this.allRoots();
    const wanted = resolve(root);
    const exact = roots.find((item) => item.real === wanted && item.projectIds.has(session.projectId));
    if (exact) return exact;
    // 走到这里说明请求的路径和索引里的写法不一致（符号链接、大小写），
    // 只有这种少见情况才解析一次真实路径。这一步也可能被客户端指向受保护目录，
    // 所以同样走闸门：越界就在碰文件系统之前断掉，不给它换一个授权弹窗的机会。
    let want: string | null = null;
    try {
      want = this.fs.realpath(wanted, "files.scope");
    } catch {
      want = null;
    }
    const match = want === null
      ? undefined
      : roots.find((item) => item.real === want && item.projectIds.has(session.projectId));
    if (match) return match;
    if (want !== null) {
      for (const item of roots) {
        if (!item.projectIds.has(session.projectId)) continue;
        let itemReal: string | null = null;
        try {
          itemReal = this.fs.realpath(item.real, "files.scope");
        } catch {
          continue;
        }
        if (itemReal === want) return item;
      }
    }
    // 工作树会话归在原项目里，但它自己在 .claude/worktrees/<name> 下工作：
    // 只放行这个会话自己的 cwd，别的路径仍按项目范围拒绝。
    if (want !== null && session.cwd) {
      let own: string | null = null;
      try {
        own = this.fs.realpath(resolve(session.cwd), "files.scope");
      } catch {
        own = null;
      }
      if (own === want) {
        return { name: basename(want), path: want, real: want, projectIds: new Set([session.projectId]) };
      }
    }
    throw new RpcError("unauthorized", "只能访问当前会话所属的项目目录");
  }

  /**
   * Resolves a client path and refuses anything outside the scoped project root.
   *
   * 先用纯字符串判越界再 realpath：客户端可以把路径指到 `~/下载`、`~/音乐`，
   * 而 realpath 一次就是一次 macOS 授权弹窗（弹窗不点掉会一直挂着）。
   */
  private resolveInside(root: ScopedRoot, path: string, allowUploads = false): string {
    const base = this.rootReal(root);
    const uploads = join(this.store.dir, "uploads");
    const target = resolve(root.real, path);
    const within =
      isUnder(target, base) ||
      isUnder(target, root.real) ||
      isUnder(target, root.path) ||
      (allowUploads && isUnder(target, uploads));
    if (!within) throw new RpcError("unauthorized", "路径不在该项目目录内");
    let real: string;
    try {
      real = this.fs.realpath(target, "files.resolve", { extraRoots: [base, root.real, root.path, uploads] });
    } catch (error) {
      // 越界与不存在对外区别不开，免得可以拿它探测文件是否存在。
      if (error instanceof FsScopeError) throw new RpcError("unauthorized", "路径不在该项目目录内");
      throw new RpcError("not_found", "路径不存在");
    }
    // 解析后还要再比一次：符号链接可以把「工程里的路径」引到工程外。
    if (!isUnder(real, base) && !(allowUploads && this.insideUploads(real))) {
      throw new RpcError("unauthorized", "路径不在该项目目录内");
    }
    return real;
  }

  /**
   * 索引里的 root 只做了纯字符串归一（那份索引每几秒重建一次，不能 realpath 受保护目录）；
   * 工程目录本身带符号链接时（macOS 的 `/tmp` → `/private/tmp` 最常见），realpath 后的
   * 子路径不会以原字符串开头，整棵树都会被误判成越界。真正读文件时才解析一次并缓存。
   */
  private rootReal(root: ScopedRoot): string {
    if (root.realResolved === undefined) {
      try {
        root.realResolved = this.fs.realpath(root.real, "files.root");
      } catch {
        root.realResolved = root.real;
      }
    }
    return root.realResolved;
  }

  /**
   * 聊天里发的附件落在 state 目录的 uploads 下，不属于任何项目。转录里引用这些
   * 路径时也要能预览，否则点开自己刚发的图片会得到「路径不在该项目目录内」。
   */
  private insideUploads(real: string): boolean {
    if (this.uploadsReal === undefined) {
      try {
        this.uploadsReal = this.fs.realpath(join(this.store.dir, "uploads"), "files.uploads");
      } catch {
        this.uploadsReal = null;
      }
    }
    return this.uploadsReal !== null && real.startsWith(this.uploadsReal + sep);
  }

  /** 路径是否指向 uploads 里的附件；不存在、或闸门拒绝解析，一律按「不是附件」处理。 */
  private insideUploadsPath(path: string): boolean {
    try {
      return this.insideUploads(this.fs.realpath(path, "files.uploads", { extraRoots: [join(this.store.dir, "uploads")] }));
    } catch {
      return false;
    }
  }

  /**
   * 附件判定的第一道闸：先比字符串，不碰文件系统。
   * `realpath` 打到「桌面 / 文档 / 下载」这类受保护目录会弹系统授权，而这一步在
   * capability 检查之前 —— 没开文件浏览的设备不该能用一次 `fs.read` 换来一个授权弹窗。
   */
  private looksLikeUpload(path: string): boolean {
    if (!path.startsWith(join(this.store.dir, "uploads") + sep)) return false;
    return this.insideUploadsPath(path);
  }

  async listDirs(sessionId: string | undefined, root: string, path?: string): Promise<FsListResult> {
    this.requireCapability("files");
    const scoped = await this.scope(sessionId, root);
    // Root lookup can wait on the adapter index; the switch may have gone off meanwhile.
    this.requireCapability("files");
    const real = path ? this.resolveInside(scoped, path) : this.rootReal(scoped);
    const extraRoots = [this.rootReal(scoped), scoped.path];
    let stats;
    try {
      stats = this.fs.stat(real, "files.list", { extraRoots });
    } catch (error) {
      if (error instanceof FsScopeError) throw new RpcError("unauthorized", "这个目录不在允许访问的范围内");
      throw new RpcError("not_found", "路径不存在");
    }
    if (!stats.isDirectory()) throw new RpcError("invalid_params", "不是目录");
    const entries: FsEntry[] = [];
    let dirents: ReturnType<FsScope["readdir"]>;
    try {
      dirents = this.fs.readdir(real, "files.list", { extraRoots });
    } catch (error) {
      // 闸门放行了，但系统不给（目录在受保护位置且没授权）：说清楚是缺授权，不是路径不存在。
      throw permissionError(error) ?? new RpcError("not_found", "读不到这个目录");
    }
    for (const entry of dirents) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = `${real}${sep}${entry.name}`;
      let childStats;
      try {
        // lstat: a symlink pointing outside the project must not leak its target's size or mtime.
        childStats = this.fs.lstat(child, "files.list", { extraRoots });
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
      parent: real === this.rootReal(scoped) ? null : dirname(real),
      entries,
    };
  }

  async readFile(sessionId: string | undefined, root: string, path: string): Promise<FsReadResult> {
    // 自己发的附件落在 state/uploads 下：不开「文件浏览」也该能点开预览，否则只能拿到一句
    // 「文件浏览未开启」。只免这一个目录的开关，其它路径照旧先要开关，
    // 免得未开启的设备拿 fs.read 探测项目里有什么。
    const attachment = this.looksLikeUpload(resolve(root, path));
    if (!attachment) this.requireCapability("files");
    const scoped = await this.scope(sessionId, root);
    const real = this.resolveInside(scoped, path, true);
    // Root lookup can wait on the adapter index; the switch may have gone off meanwhile.
    if (!attachment || !this.insideUploads(real)) this.requireCapability("files");
    const extraRoots = [this.rootReal(scoped), scoped.path, join(this.store.dir, "uploads")];
    let stats;
    try {
      stats = this.fs.stat(real, "files.read", { extraRoots });
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
    let fd: number;
    try {
      fd = this.fs.open(real, "files.read", { flags: "r", extraRoots });
    } catch (error) {
      throw permissionError(error) ?? new RpcError("not_found", "路径不存在");
    }
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
    sessionId: string | undefined,
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
      const scoped = await this.scope(sessionId, root);
      workdir = cwd ? this.resolveInside(scoped, cwd) : scoped.real;
    } finally {
      this.pendingExecs.delete(pending);
    }
    if (pending.cancelled) throw new RpcError("unsupported", "设备通道已断开");
    // The switch can be turned off, or expire, while the adapter index is loading.
    this.requireCapability("terminal");
    if (this.execs.size >= MAX_CONCURRENT_EXECS) {
      throw new RpcError("rate_limited", "同时运行的命令过多，请先结束其他命令");
    }
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

  /** Only the channel that started a command may cancel it; other channels get a silent no-op. */
  cancel(owner: string, execId: string): ShellCancelResult {
    const record = this.execs.get(execId);
    if (!record || record.owner !== owner) return { ok: true, killed: false };
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
