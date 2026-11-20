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
import {
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";

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
/** 同一条越界的日志最小间隔：会话列表轮询不能让日志刷屏。 */
const LOG_DEDUPE_MS = 60_000;

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
 * 授权根之内的路径直接放行；主目录之内必须落在某个根里，或者是 CLI 自己的数据目录；
 * 其余一律拒绝。判定只看字符串与符号链接本身（`lstat` + `readlink` 不进入目标，
 * 因此不会触发授权弹窗），绝不做 `realpath`。
 */
export function scopeCheck(
  path: string,
  roots: readonly string[],
  options: { home?: string; depth?: number } = {},
): FsScopeCheck {
  // 主目录自身也可能在符号链接后面（`/var` → `/private/var`，测试用 tmpdir 时必然遇到），
  // 解析一次再比，否则解析后的路径会被当成「主目录之外」而白放行。
  const rawHome = options.home ?? homedir();
  const home = normalize(resolveLinks(rawHome) ?? rawHome).replace(/\/+$/, "");
  const target = normalize(path);
  const depth = options.depth ?? 0;
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

  /**
   * 符号链接可以把任意路径引到受保护目录（`/tmp/link -> ~/Downloads`）。判定结果是
   * 「会放行」时才逐段解析链接本身（`lstat` + `readlink`，不进入目标）再看一遍；
   * 解析后落到别处就按新路径重判，落到原地就按放行处理。
   */
  const recheck = (base: string): FsScopeCheck | null => {
    const resolved = resolveLinks(base);
    if (resolved === null) return { ok: false, because: "符号链接层级过深，无法判定" };
    const linked = normalize(resolved);
    if (linked === base) return null;
    if (depth >= 3) return null;
    return scopeCheck(linked, roots, { home, depth: depth + 1 });
  };

  if (!target.startsWith(`${home}${sep}`)) return recheck(target) ?? { ok: true };

  const rel = target.slice(home.length + 1);
  const first = rel.split(sep)[0] ?? "";
  const protectedDir = PROTECTED_HOME_DIRS.find(
    (name) => rel === name || rel.startsWith(`${name}${sep}`),
  );
  // 受保护目录：直接拒绝，连 lstat 都不做（这一层就是不能有任何文件系统访问）。
  if (protectedDir) return { ok: false, because: `受保护目录 ~/${protectedDir}` };
  // CLI 自己的数据目录（`~/.pi`、`~/.claude`…）与 `~/Library` 下的几个数据目录不受 TCC 保护。
  const dataDir =
    first.startsWith(".") ||
    HOME_DATA_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}${sep}`));
  if (!dataDir) return { ok: false, because: "不在任何授权根内" };
  // 这些目录会放行，但要确认没被其中的符号链接带去别处。
  return recheck(target) ?? { ok: true };
}

/**
 * 逐段解析符号链接，返回解析后的绝对路径。
 *
 * 只用 `lstat` + `readlink`：读的是链接自身，不会进入目标目录，所以既不会触发
 * macOS 的目录授权，也不需要 `realpath`。路径不存在时不报错，把剩余部分原样接回去，
 * 交给真正的 `fs` 调用去报 ENOENT。层级过深（成环）时返回 null，由调用方按越界处理。
 */
export function resolveLinks(path: string, limit = 16): string | null {
  let current: string = sep;
  const pending = path.split(sep).filter((part) => part.length > 0 && part !== ".");
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    let info;
    try {
      info = lstatSync(next);
    } catch {
      // 后半段不存在：原样拼回去，让真正的 fs 调用报错，而不是在这里改写路径。
      return pending.length > 0 ? join(next, ...pending) : next;
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > limit) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null;
    }
    const absolute = isAbsolute(target) ? target : join(current, target);
    const rest = absolute.split(sep).filter((item) => item.length > 0).concat(pending);
    pending.length = 0;
    pending.push(...rest);
    current = sep;
  }
  return current;
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
  /** 每条越界最近一次写日志的时间，用来压掉重复刷屏。 */
  private readonly loggedAt = new Map<string, number>();

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
    // 同一条越界会被反复触发（会话列表每几秒刷一次），记录与日志都按 key 去重，
    // 否则日志会被同一行灌满，真正的新越界反而看不见。
    const key = `${refusal.path}|${reason}|${check.because}`;
    const index = this.refusals.findIndex(
      (item) => `${item.path}|${item.reason}|${item.because}` === key,
    );
    if (index !== -1) this.refusals.splice(index, 1);
    this.refusals.unshift(refusal);
    if (this.refusals.length > REFUSAL_KEEP) this.refusals.length = REFUSAL_KEEP;
    const lastLogged = this.loggedAt.get(key) ?? 0;
    if (at - lastLogged >= LOG_DEDUPE_MS) {
      if (this.loggedAt.size > 256) this.loggedAt.clear();
      this.loggedAt.set(key, at);
      this.options.log(`${FS_SCOPE_LOG_PREFIX}（${check.because}）：${refusal.path} <- ${reason}`);
    }
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
