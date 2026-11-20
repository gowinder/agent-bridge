// 文件系统枚举的唯一收口。
//
// macOS 把「桌面 / 文档 / 下载 / 照片 / 音乐 / 影片」这些目录放在 TCC 后面：第一次碰到
// 就会弹「文件与文件夹」授权，弹窗没被点掉之前那个系统调用一直挂着。Bridge 是单线程的，
// 一次 realpath / readdir 挂住就是整条会话看起来还在跑、实际两小时没有任何输出。
//
// 所以枚举不许凭一个算出来的路径直接下 fs：必须先过 FsScope。规则只有一条 ——
// 只能在「已经授权过的根」里面走：托管白名单目录、工程目录、状态目录，以及 CLI 自己的
// 主目录数据目录（`~/.pi`、`~/.claude`、`~/Library/Application Support` 这类，它们不是
// 用户文档）。其它主目录路径一律拒绝并记一行日志，绝不「先扫一遍再过滤」：枚举本身
// 就是越界，过滤结果救不回来。
import { lstatSync, openSync, readdirSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";

/** 审计日志与测试里引用的固定名字：日志一搜就能找到越界是从哪条路径进来的。 */
export const FS_SCOPE_LOG_PREFIX = "fs-scope: 拒绝越界访问";

/** 受保护的用户目录：不在任何授权根里时直接拒绝，日志里点名是哪一个。 */
export const PROTECTED_HOME_DIRS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library/Mobile Documents",
  "Library/CloudStorage",
  "Movies",
  "Music",
  "Pictures",
  "Public",
] as const;

/**
 * 主目录下允许直接枚举的数据目录：CLI 与系统自己的配置、缓存、日志。
 * 这些目录不受 TCC 保护，适配器要读会话与模型清单只能靠它们。
 */
const HOME_DATA_PREFIXES = [
  "Library/Application Support",
  "Library/Caches",
  "Library/HTTPStorages",
  "Library/Logs",
  "Library/Preferences",
] as const;

/** 最近拒绝记录的保留条数：只给诊断与测试看，不落盘。 */
const REFUSAL_KEEP = 32;

export class FsScopeError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "FsScopeError";
  }
}

export interface FsScopeRefusal {
  path: string;
  reason: string;
  /** 被判定越界时命中的那一条规则，日志里用来点明原因。 */
  because: string;
  at: number;
}

export interface FsScopeOptions {
  /** 授权根。每次判定都重新取：托管白名单是可以在运行中改的。 */
  roots: () => readonly string[];
  log: (line: string) => void;
  /** 覆盖主目录（测试用）。 */
  home?: string;
  now?: () => number;
}

interface CallOptions {
  /** 这次调用额外认可的根：例如当前会话自己的工程目录。 */
  extraRoots?: readonly string[];
}

export type FsScopeCheck = { ok: true } | { ok: false; because: string };

/**
 * 一次判定：`path` 能否枚举。
 *
 * 主目录之外的路径不在本闸门职责内（系统目录不会弹授权，README 里的临时目录、
 * `/opt/homebrew` 之类也照旧要能读）；主目录之内必须落在授权根里，或者是 CLI 数据目录。
 */
export function scopeCheck(
  path: string,
  roots: readonly string[],
  options: { home?: string } = {},
): FsScopeCheck {
  const home = (options.home ?? homedir()).replace(/\/+$/, "");
  const target = normalize(path);
  for (const root of roots) {
    const normalized = normalize(root);
    if (!normalized) continue;
    if (target === normalized || target.startsWith(`${normalized}${sep}`)) return { ok: true };
  }
  // 可移除/外接磁盘同样是授权门禁后面（「可移除的宗卷」），没被当成根就别去碰。
  if (target === "/Volumes" || target.startsWith(`/Volumes${sep}`)) {
    return { ok: false, because: "可移除磁盘不是授权根" };
  }
  if (target === home) return { ok: false, because: "主目录本身不是授权根" };
  if (!target.startsWith(`${home}${sep}`)) return { ok: true };
  const rel = target.slice(home.length + 1);
  const first = rel.split(sep)[0] ?? "";
  // CLI 自己的数据目录（`~/.pi`、`~/.claude`…）不受 TCC 保护，适配器离不开它们。
  if (first.startsWith(".")) return { ok: true };
  for (const prefix of HOME_DATA_PREFIXES) {
    if (rel === prefix || rel.startsWith(`${prefix}${sep}`)) return { ok: true };
  }
  const protectedDir = PROTECTED_HOME_DIRS.find(
    (name) => rel === name || rel.startsWith(`${name}${sep}`),
  );
  if (protectedDir) return { ok: false, because: `受保护目录 ~/${protectedDir}` };
  return { ok: false, because: "不在任何授权根内" };
}

function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  try {
    // 只做纯字符串归一：realpath 解符号链接要碰文件系统，正是这里要避免的事。
    return trimmed ? resolvePath(trimmed) : trimmed;
  } catch {
    return trimmed;
  }
}

export class FsScope {
  private readonly refusals: FsScopeRefusal[] = [];
  private readonly home: string;
  private readonly now: () => number;
  /** 运行中登记下来的根：工程目录索引这类每次都要重新扫一遍才知道的根。 */
  private extra: string[] = [];

  constructor(private readonly options: FsScopeOptions) {
    this.home = options.home ?? homedir();
    this.now = options.now ?? (() => Date.now());
  }

  /** 工程索引刷新后同步一次，之后的枚举就不用再传 extraRoots。 */
  setExtraRoots(roots: readonly string[]): void {
    this.extra = roots.filter((root) => typeof root === "string" && root.length > 0);
  }

  /** 最近的拒绝记录（新在前），诊断与测试用。 */
  get recentRefusals(): readonly FsScopeRefusal[] {
    return this.refusals;
  }

  roots(extraRoots: readonly string[] = []): string[] {
    const all = [...this.options.roots(), ...this.extra, ...extraRoots];
    return all.filter((root) => typeof root === "string" && root.length > 0);
  }

  check(path: string, extraRoots: readonly string[] = []): FsScopeCheck {
    return scopeCheck(path, this.roots(extraRoots), { home: this.home });
  }

  /** 不满足就抛 FsScopeError，并写一行日志。返回归一化后的绝对路径。 */
  assert(path: string, reason: string, options: CallOptions = {}): string {
    const check = this.check(path, options.extraRoots);
    if (check.ok) return normalize(path);
    const at = this.now();
    const refusal: FsScopeRefusal = { path: normalize(path), reason, because: check.because, at };
    this.refusals.unshift(refusal);
    if (this.refusals.length > REFUSAL_KEEP) this.refusals.length = REFUSAL_KEEP;
    this.options.log(`${FS_SCOPE_LOG_PREFIX}（${check.because}）：${refusal.path} <- ${reason}`);
    throw new FsScopeError(refusal.path, reason, `拒绝访问 ${refusal.path}：${check.because}`);
  }

  /** 带类型的目录枚举：文件浏览用它，符号链接类型也要读出来。 */
  readdir(path: string, reason: string, options: CallOptions = {}): Dirent[] {
    return readdirSync(this.assert(path, reason, options), { withFileTypes: true });
  }

  /** 只要文件名时的枚举。 */
  readdirNames(path: string, reason: string, options: CallOptions = {}): string[] {
    return readdirSync(this.assert(path, reason, options));
  }

  stat(path: string, reason: string, options: CallOptions = {}): Stats {
    return statSync(this.assert(path, reason, options));
  }

  lstat(path: string, reason: string, options: CallOptions = {}): Stats {
    return lstatSync(this.assert(path, reason, options));
  }

  realpath(path: string, reason: string, options: CallOptions = {}): string {
    return realpathSync(this.assert(path, reason, options));
  }

  open(path: string, reason: string, options: CallOptions & { flags: string }): number {
    return openSync(this.assert(path, reason, options), options.flags);
  }
}
