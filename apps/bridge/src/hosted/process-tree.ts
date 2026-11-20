/**
 * 会话进程树：杀掉一个托管会话时，连它的后代一起收掉。
 *
 * 只按进程组杀不够。pi-subagents 的后台 async runner 是
 * `spawn(cmd, args, { detached: true })` 起的（bundle 里的 backgroundProcessOptions()），
 * setsid 之后它自成一个进程组，父进程组 `kill(-pgid)` 收不到它；父进程一死，它还会被
 * re-parent 到 pid 1，连 ppid 这条线索都没了。实测：托管 pi 会话的进程组是 91236，
 * 它派生的 runner 是 91340（自己一组，pgid 91340），停掉会话后 runner 的 ppid 变成 1，
 * 继续每秒往文件里写一行。
 *
 * 所以停止分两步：会话跑着的时候把后代 pid 登记下来（setsid 之前 ppid 关系还在），
 * 停的时候拿登记表逐个杀，再扫 ps 兜底，杀完核对，没死的 pid 交给调用方显式报出去。
 *
 * 平台：Windows 的 ps 没有这些字段，直接返回空表 —— 那种平台退回进程组处理。
 */

import { execFileSync } from "node:child_process";

/** 进程表里的一行。 */
export interface ProcNode {
  pid: number;
  ppid: number;
  pgid: number;
  /** ps 的 lstart：认「同一个 pid 还是不是那个进程」。 */
  start: string;
  /** 完整命令行：额外带进来的 pid 靠它核对身份。 */
  command: string;
}

/** pi-subagents 的后台 runner 命令行里一定带这个路径片段。 */
const RUNNER_COMMAND = /pi-subagents/;

const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,lstart=,command="];
/** lstart 是 5 段（Tue Nov 17 13:39:09 2026），强制 C locale 才不会随语言变形状。 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/;

/** 一次进程表快照；拿不到（非 darwin/linux、ps 出错）时返回空表。 */
export function snapshotProcesses(timeoutMs = 3_000): ProcNode[] {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let out: string;
  try {
    out = execFileSync("ps", PS_ARGS, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return [];
  }
  const nodes: ProcNode[] = [];
  for (const line of out.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    nodes.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      start: match[4]!,
      command: match[5]!,
    });
  }
  return nodes;
}

/** roots 及其全部后代。setsid 出去但父进程还活着的也算，ppid 关系那时还没断。 */
export function subtree(nodes: ProcNode[], roots: Iterable<number>): ProcNode[] {
  const seen = new Set<number>();
  for (const root of roots) if (root > 1) seen.add(root);
  if (seen.size === 0) return [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (seen.has(node.pid)) continue;
      if (seen.has(node.ppid)) {
        seen.add(node.pid);
        grew = true;
      }
    }
  }
  return nodes.filter((node) => seen.has(node.pid));
}

/**
 * 每个会话一份的后代登记表：pid → 首次看到的启动时刻。
 *
 * 启动时刻是防误杀的关键：pid 会被复用，表里留着旧 pid 时直接 kill 可能杀掉一个
 * 毫不相干的进程。发信号之前比一次 lstart，对不上就认为那个进程已经不在了。
 */
export class SessionTrees {
  private readonly trees = new Map<string, Map<number, string>>();

  /** 把 roots 的整棵子树记到 key 名下。 */
  remember(key: string, roots: Iterable<number>, nodes: ProcNode[]): void {
    const nodes_ = subtree(nodes, roots);
    if (nodes_.length > 0) this.record(key, nodes_);
  }

  /** 直接登记已知进程（外部带来的 pid，例如子代理 runner）。 */
  record(key: string, nodes: ProcNode[]): void {
    let tree = this.trees.get(key);
    if (!tree) {
      tree = new Map<number, string>();
      this.trees.set(key, tree);
    }
    for (const node of nodes) {
      if (node.pid <= 1) continue;
      if (!tree.has(node.pid)) tree.set(node.pid, node.start);
    }
  }

  /** 这个会话登记过的 pid 快照（副本，后续登记不影响调用方）。 */
  known(key: string): Map<number, string> {
    return new Map(this.trees.get(key) ?? []);
  }

  has(key: string): boolean {
    return (this.trees.get(key)?.size ?? 0) > 0;
  }

  forget(key: string): void {
    this.trees.delete(key);
  }

  clear(): void {
    this.trees.clear();
  }
}

export interface TreeKillResult {
  /** 确认已经不在的 pid。 */
  terminated: number[];
  /** 宽限期过后还在的 pid：调用方必须显式暴露，不能当成停成功。 */
  leftover: number[];
}

export interface TreeKillOptions {
  /** 冻结整棵树（SIGSTOP）最多花多久，防止在派生子进程的循环里转不停。 */
  freezeMs?: number;
  /** SIGTERM 到 SIGKILL 之间的宽限。 */
  graceMs?: number;
  /** 每轮复查间隔。 */
  pollMs?: number;
  /** SIGKILL 之后再核对多久，兜住「杀的时候刚好又派生了子进程」。 */
  verifyMs?: number;
  /** 绝对不能碰的 pid：别的会话的整棵树、Bridge 自己。 */
  forbidden?: Iterable<number>;
  log?: (line: string) => void;
}

const DEFAULT_FREEZE_MS = 400;
const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_VERIFY_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程还在吗。EPERM 说明进程存在、只是不归我们管，也算活着。 */
export function alivePid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(node: ProcNode, signalName: NodeJS.Signals, forbidden: Set<number>): void {
  if (node.pid <= 1) return;
  // 绝不碰自己、自己的父进程、名单里的进程。
  if (node.pid === process.pid || node.pid === process.ppid) return;
  if (forbidden.has(node.pid) || forbidden.has(node.pgid)) return;
  try {
    process.kill(node.pid, signalName);
  } catch {
    // 已经退出。
    return;
  }
  // 自成一组（detached / setsid）的进程，组里可能还有它的后代：连组一起收。
  if (node.pgid === node.pid) {
    try {
      process.kill(-node.pid, signalName);
    } catch {
      // 组里只剩它自己，上面那一发就够了。
    }
  }
}

/**
 * 杀掉一颗会话进程树：SIGTERM → 宽限 → SIGKILL → 核对。
 *
 * @param registered 会话期间登记的后代（pid → lstart）
 * @param roots 会话根进程；登记表为空时靠它现场扫一遍
 * @param extraPids 额外已知的 pid（子代理 runner，来自 pi-subagents 的 status.json）
 * @returns 杀不掉的 pid 会出现在 leftover 里，调用方不能把它当成功
 */
export async function killTree(
  registered: Map<number, string>,
  roots: Iterable<number> = [],
  extraPids: Iterable<number> = [],
  options: TreeKillOptions = {},
): Promise<TreeKillResult> {
  const freezeMs = options.freezeMs ?? DEFAULT_FREEZE_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const verifyMs = options.verifyMs ?? DEFAULT_VERIFY_MS;
  const forbidden = new Set<number>(options.forbidden ?? []);
  const log = options.log;
  const known = new Map(registered);
  const rootPids = [...roots].filter((pid) => pid > 1);
  const extras = [...extraPids].filter((pid) => pid > 1);
  if (known.size === 0 && rootPids.length === 0 && extras.length === 0) {
    return { terminated: [], leftover: [] };
  }

  let nodes = snapshotProcesses();

  // 根进程只认第一次看到的启动时刻：之后 pid 被复用也不再当成根。
  const rootStarts = new Map<number, string>();
  for (const pid of rootPids) {
    const node = nodes.find((item) => item.pid === pid);
    if (node) {
      rootStarts.set(pid, node.start);
      if (!known.has(pid)) known.set(pid, node.start);
    }
  }
  // 额外 pid 要先认身份：命令行里还是 pi-subagents 的运行器才认，
  // 否则可能是个复用了同一个 pid 的无关进程。
  for (const pid of extras) {
    if (known.has(pid)) continue;
    const node = nodes.find((item) => item.pid === pid);
    if (!node || !RUNNER_COMMAND.test(node.command)) {
      log?.(`pid ${pid} 看起来不是本会话的子代理运行器，跳过`);
      continue;
    }
    known.set(pid, node.start);
  }
  const started = new Set(known.keys());

  /** 清掉被复用的 pid，补上新扫到的后代。 */
  const refresh = (): void => {
    for (const [pid, start] of known) {
      const node = nodes.find((item) => item.pid === pid);
      if (node && node.start !== start) {
        known.delete(pid);
        log?.(`进程 ${pid} 已被复用（启动时刻变了），跳过`);
      }
    }
    const liveRoots = [...rootStarts.entries()]
      .filter(([pid, start]) => nodes.some((item) => item.pid === pid && item.start === start))
      .map(([pid]) => pid);
    // 根进程还活着时每轮都补一次：它可能刚派生出新的一层。
    for (const node of subtree(nodes, liveRoots)) if (!known.has(node.pid)) known.set(node.pid, node.start);
    // 已登记进程的子进程也扫进来：父进程 setsid 得太快、登记表还没看到的那种。
    for (const node of subtree(nodes, known.keys())) if (!known.has(node.pid)) known.set(node.pid, node.start);
  };

  const alive = (): ProcNode[] =>
    [...known.entries()]
      .map(([pid, start]) => nodes.find((node) => node.pid === pid && node.start === start))
      .filter((node): node is ProcNode => node !== undefined && !forbidden.has(node.pid) && node.pid !== process.pid);

  refresh();

  // 先把整棵树冻住再收。
  //
  // 这一步是「停的时候刚好在派生子进程」这个窗口的唯一解法：只要根进程还活着，它随时
  // 可能再 spawn 一个 setsid 出去的子进程，而等我们发现它时父进程已经死了、ppid 线索
  // 也断了。SIGSTOP 冻住之后任何节点都不能再 fork，树就闭合了；反复扫到没有新节点为止。
  const freezeDeadline = Date.now() + freezeMs;
  for (;;) {
    const targets = alive();
    for (const node of targets) signal(node, "SIGSTOP", forbidden);
    if (Date.now() >= freezeDeadline) break;
    await sleep(pollMs);
    nodes = snapshotProcesses();
    const knownBefore = known.size;
    refresh();
    if (known.size === knownBefore) break;
  }

  // 冻住的进程收到 SIGTERM 也只是挂起，得先放行让它自己处理退出。
  const termDeadline = Date.now() + graceMs;
  for (;;) {
    const targets = alive();
    if (targets.length === 0) break;
    for (const node of targets) {
      signal(node, "SIGTERM", forbidden);
      signal(node, "SIGCONT", forbidden);
    }
    if (Date.now() >= termDeadline) break;
    await sleep(pollMs);
    nodes = snapshotProcesses();
    refresh();
  }

  let targets = alive();
  if (targets.length > 0) {
    log?.(`SIGTERM 后仍有 ${targets.length} 个进程在跑，改用 SIGKILL：${targets.map((node) => node.pid).join(", ")}`);
    const killDeadline = Date.now() + verifyMs;
    do {
      for (const node of targets) signal(node, "SIGKILL", forbidden);
      await sleep(pollMs);
      nodes = snapshotProcesses();
      refresh();
      targets = alive();
    } while (targets.length > 0 && Date.now() < killDeadline);
  }

  const leftover = targets.map((node) => node.pid);
  const terminated = [...started].filter((pid) => !leftover.includes(pid) && !alivePid(pid));
  if (leftover.length > 0) log?.(`仍有进程未退出：${leftover.join(", ")}`);
  return { terminated, leftover };
}
