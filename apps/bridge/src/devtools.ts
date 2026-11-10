// Remote devtools: read-only project file browsing plus single command execution.
// Both are off by default and only work while the local user has switched them on
// from the menu bar app or `agent-bridge devtools on`.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import type {
  DevtoolsStatus,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsRoot,
  ShellCancelResult,
  ShellEventData,
  ShellExecResult,
} from "@agent-bridge/protocol";
import type { SessionAdapters } from "./adapters/index.js";
import { RpcError } from "./adapters/types.js";
import type { Store } from "./store.js";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ENTRIES = 2_000;

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

interface ExecRecord {
  proc: ChildProcess;
  owner: string;
  killed: boolean;
  truncated: boolean;
  startedAt: number;
  timer: NodeJS.Timeout;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class Devtools {
  private execs = new Map<string, ExecRecord>();
  private rootsCache: { at: number; roots: Array<FsRoot & { real: string }> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly adapters: SessionAdapters,
    private readonly log: (line: string) => void,
  ) {}

  status(): DevtoolsStatus {
    const stored = this.store.meta("devtools_enabled") === "1";
    const expiresAt = Number(this.store.meta("devtools_expires_at") ?? "") || null;
    const active = stored && (expiresAt === null || expiresAt > Date.now());
    if (stored && !active) this.setEnabled(false);
    return {
      enabled: active,
      expiresAt: active ? expiresAt : null,
      terminal: active,
      files: active,
    };
  }

  setEnabled(enabled: boolean, ttlSeconds?: number | null): DevtoolsStatus {
    if (!enabled) {
      this.killAll();
      this.store.setMeta("devtools_enabled", "0");
      this.store.setMeta("devtools_expires_at", "");
      this.log("远程工具已关闭");
      return this.status();
    }
    const ttl = ttlSeconds === null || ttlSeconds === undefined ? null : clamp(Math.round(ttlSeconds), 60, 86400);
    const expiresAt = ttl === null ? null : Date.now() + ttl * 1000;
    this.store.setMeta("devtools_enabled", "1");
    this.store.setMeta("devtools_expires_at", expiresAt === null ? "" : String(expiresAt));
    this.log(
      `远程工具已开启${expiresAt === null ? "（不自动关闭）" : `，${new Date(expiresAt).toLocaleTimeString()} 失效`}`,
    );
    return this.status();
  }

  roots(): FsRoot[] {
    return this.allRoots().map(({ name, path }) => ({ name, path }));
  }

  private allRoots(): Array<FsRoot & { real: string }> {
    const cached = this.rootsCache;
    if (cached && Date.now() - cached.at < 5_000) return cached.roots;
    const seen = new Set<string>();
    const roots: Array<FsRoot & { real: string }> = [];
    for (const project of this.adapters.projects().projects) {
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

  /** Resolves a client path and refuses anything outside an allowed project root. */
  private resolveInside(path: string): { real: string; root: (FsRoot & { real: string }) | null } {
    const roots = this.allRoots();
    if (roots.length === 0) throw new RpcError("unsupported", "没有可浏览的项目目录");
    const target = resolve(path);
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      throw new RpcError("not_found", "路径不存在");
    }
    const root = roots.find((item) => real === item.real || real.startsWith(item.real + sep));
    if (!root) throw new RpcError("unauthorized", "路径不在允许的项目目录内");
    return { real, root };
  }

  private requireEnabled(): void {
    if (!this.status().enabled) {
      throw new RpcError("unsupported", "远程工具未开启，请在 Mac 的菜单栏中打开");
    }
  }

  listDirs(path: string): FsListResult {
    this.requireEnabled();
    const { real } = this.resolveInside(path);
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
    const all = this.allRoots();
    const root = all.find((item) => real === item.real || real.startsWith(item.real + sep));
    const parent = root && real !== root.real ? real.slice(0, real.lastIndexOf(sep)) : null;
    return { path: real, parent, entries };
  }

  readFile(path: string): FsReadResult {
    this.requireEnabled();
    const { real } = this.resolveInside(path);
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

  exec(owner: string, command: string, cwd: string | undefined, timeoutMs: number | undefined, emit: (data: ShellEventData) => void): ShellExecResult {
    this.requireEnabled();
    const text = command.trim();
    if (!text) throw new RpcError("invalid_params", "命令不能为空");
    if (text.length > 8_000) throw new RpcError("invalid_params", "命令过长");
    const roots = this.allRoots();
    const workdir = cwd ? this.resolveInside(cwd).real : roots[0]?.real;
    if (!workdir) throw new RpcError("unsupported", "没有可用的项目目录");
    const timeout = clamp(Math.round(timeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000, MAX_TIMEOUT_MS);
    const shell = process.env["SHELL"] && existsSync(process.env["SHELL"]) ? process.env["SHELL"] : "/bin/sh";
    const execId = randomUUID();
    const startedAt = Date.now();
    const proc = spawn(shell, ["-lc", text], {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    try {
      record.proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        record.proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 2_000);
  }
}
