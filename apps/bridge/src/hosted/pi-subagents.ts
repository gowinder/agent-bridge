// pi-subagents 的后台 async run 把状态写在
// `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json`。
// 前台子代理跑在 pi 进程内部、不走 stdout，只有后台 run 有可读的产物。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RailTask } from "@craftstead/protocol";

const RUNS_DIR_NAME = "async-subagent-runs";
/**
 * status.json 里的 sessionId 可能是裸 id，也可能是会话文件路径
 * （`<时间戳>_<sessionId>.jsonl`）；Bridge 的会话记录只存裸 id。
 */
function sameSession(recorded: string | undefined, piSessionId: string): boolean {
  if (!recorded) return false;
  if (recorded === piSessionId) return true;
  const base = recorded.slice(recorded.lastIndexOf("/") + 1).slice(recorded.lastIndexOf("\\") + 1);
  return base === piSessionId || base === `${piSessionId}.jsonl` || base.endsWith(`_${piSessionId}.jsonl`);
}
/** 状态还写着在跑、但这么久没动静的 run 不再算在跑（进程被杀掉的情况）。 */
const RUN_STALE_MS = 10 * 60_000;
/** 侧栏只列最新的这些。 */
export const MAX_PI_TASKS = 20;
/**
 * 最多读这么多份 status.json，免得扫几百个 run。
 * 排序键是 status.json 自己的 mtime（run 执行期间会被重写），目录 mtime 只在增删文件时变，
 * 按目录 mtime 排会把「早开始、还在跑」的 run 挤出去，会话就又显示成不忙了。
 */
const MAX_SCANNED_RUNS = 200;
/**
 * 一次扫描的结果缓存这么久：侧栏、消息列表、会话列表会各问一次「还有没有在跑的」，
 * 同一个 root 下几十个会话没必要各扫一遍目录。
 */
const SCAN_TTL_MS = 1_000;
/** 缓存条目上限：root 通常只有一个，超了直接整表清掉。 */
const MAX_SCAN_CACHE = 8;
const scanCache = new Map<string, { at: number; runs: ScannedRun[] }>();

interface PiRunStatus {
  runId?: string;
  sessionId?: string;
  state?: string;
  /** runner 进程的 pid：判活靠它，别靠文件时间。 */
  pid?: number;
  mode?: string;
  startedAt?: number;
  lastActivityAt?: number;
  lastUpdate?: number;
  endedAt?: number;
  currentStep?: number;
  steps?: PiRunStep[];
}

interface PiRunStep {
  agent?: string;
  sessionName?: string;
  status?: string;
}

/** 和 pi-subagents 的 resolveTempScopeId 一致：有 uid 用 uid，否则用用户名。 */
export function piSubagentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["PI_SUBAGENTS_TEMP_ROOT"]?.trim();
  if (configured) return configured;
  const uid = process.getuid?.();
  if (typeof uid === "number") return join(tmpdir(), `pi-subagents-uid-${uid}`);
  const user = env["USERNAME"] || env["USER"] || env["LOGNAME"] || "";
  const scope = user ? `user-${user.replace(/[^A-Za-z0-9._-]/g, "_")}` : "shared";
  return join(tmpdir(), `pi-subagents-${scope}`);
}

/** 扫出来的一份 run：目录名、status.json 内容、目录 mtime（时间戳都缺时兜底）。 */
interface ScannedRun {
  runId: string;
  status: PiRunStatus;
  dirMtimeMs: number;
}

/** 扫 `<root>/async-subagent-runs` 下最新的那批 status.json，结果按 root 缓存 1 秒。 */
function scanRuns(root: string): ScannedRun[] {
  const now = Date.now();
  const hit = scanCache.get(root);
  if (hit && now - hit.at < SCAN_TTL_MS) return hit.runs;
  const runsDir = join(root, RUNS_DIR_NAME);
  const runs: ScannedRun[] = [];
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return { name: entry.name, mtimeMs: statSync(join(runsDir, entry.name, "status.json")).mtimeMs };
        } catch {
          try {
            return { name: entry.name, mtimeMs: statSync(join(runsDir, entry.name)).mtimeMs };
          } catch {
            return { name: entry.name, mtimeMs: 0 };
          }
        }
      });
  } catch {
    // 没跑过后台子代理，或 pi 的临时目录已被清掉。
    entries = [];
  }
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SCANNED_RUNS)) {
    try {
      const status = JSON.parse(readFileSync(join(runsDir, entry.name, "status.json"), "utf8")) as PiRunStatus;
      runs.push({ runId: entry.name, status, dirMtimeMs: entry.mtimeMs });
    } catch {
      continue;
    }
  }
  if (scanCache.size > MAX_SCAN_CACHE) scanCache.clear();
  scanCache.set(root, { at: now, runs });
  return runs;
}

/** 某个 pi 会话派生的后台子代理 run，最新在前。 */
export function piSubagentTasks(
  piSessionId: string | undefined,
  max = MAX_PI_TASKS,
  root = piSubagentRoot(),
): RailTask[] {
  if (!piSessionId) return [];
  const tasks: RailTask[] = [];
  // run 目录按用户共享，只留这个会话派生的。
  for (const run of scanRuns(root)) {
    if (!sameSession(run.status.sessionId, piSessionId)) continue;
    const task = taskOf(run.runId, run.status, run.dirMtimeMs);
    if (task) tasks.push(task);
  }
  return tasks
    .sort((a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0))
    .slice(0, max);
}

/**
 * 这个 pi 会话派生的后台子代理是否还有在跑的。
 *
 * 后台 run 跑在 pi 进程内部，主 agent 可能已经 settled：只看 RPC 的 busy 会把
 * 「主 agent 说完话、子代理还在干活」误判成已完成，所以会话状态还要看这里。
 */
export function piSubagentRunning(piSessionId: string | undefined, root = piSubagentRoot()): boolean {
  if (!piSessionId) return false;
  return scanRuns(root).some(
    (run) => sameSession(run.status.sessionId, piSessionId) && isRunning(run.status, run.dirMtimeMs),
  );
}

/**
 * 这个 pi 会话派生的、还在跑的后台子代理 runner 的 pid。
 *
 * 停止会话时用来点名：async runner 是 detached 起的，不在会话的进程组里，
 * 光按进程组杀收不到它，得按 pid 单独收。
 */
export function piSubagentRunnerPids(piSessionId: string | undefined, root = piSubagentRoot()): number[] {
  if (!piSessionId) return [];
  const pids: number[] = [];
  for (const run of scanRuns(root)) {
    if (!sameSession(run.status.sessionId, piSessionId)) continue;
    if (!isRunning(run.status, run.dirMtimeMs)) continue;
    const pid = run.status.pid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

/** 这个 pi 会话派生的某次 run 的目录；runId 不合法、或 run 属于别的会话时返回 null。 */
export function piRunDir(piSessionId: string, runId: string, root = piSubagentRoot()): string | null {
  // runId 会拼进路径：只收 UUID 这类普通标识符，挡掉 `../`。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) return null;
  const dir = join(root, RUNS_DIR_NAME, runId);
  try {
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as PiRunStatus;
    // run 目录按用户共享，别的会话的 run 不给看。
    if (!sameSession(status.sessionId, piSessionId)) return null;
  } catch {
    return null;
  }
  return dir;
}

/** 这份 run 最后一次有动静的时间；status 里的时间戳都缺时用目录 mtime。 */
function updatedAtOf(status: PiRunStatus, dirMtimeMs: number): number {
  return (
    [status.lastActivityAt, status.lastUpdate, status.endedAt, dirMtimeMs].find(
      (value): value is number => typeof value === "number" && value > 0,
    ) ?? dirMtimeMs
  );
}

/** 进程还在吗。EPERM 说明进程存在、只是不归我们管，也算活着。 */
function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 这份 run 是否还在跑。
 *
 * status.json 的 state 全集见 pi-subagents 的 ASYNC_STATUS_SNAPSHOT_STATES：
 * queued / running / complete / failed / partial / paused / stopped / rejected。
 * 它的 terminalState() 把 paused 也算终态，文档也写明只有 queued 与 running 是活的
 * （docs/extension-api.md「Treat queued and running as live」）。
 *
 * 判活优先看 runner 的 pid：pi-subagents 只在活动分类变化时才重写 status.json，
 * 一个跑很久的工具调用期间文件看着是旧的，按文件年龄判会把它当成已经结束。
 * pid 拿不到或已经退出时才退回时间判断，兜住「进程崩了、state 停在 running」的情况。
 */
function isRunning(status: PiRunStatus, dirMtimeMs: number): boolean {
  const state = typeof status.state === "string" ? status.state : "";
  if (state !== "queued" && state !== "running") return false;
  // 有 pid 就以 pid 为准：被停掉的 run 会永远停在 running，退回时间判断会让它假活 10 分钟。
  if (typeof status.pid === "number" && status.pid > 0) return pidAlive(status.pid);
  return Date.now() - updatedAtOf(status, dirMtimeMs) < RUN_STALE_MS;
}

function taskOf(runId: string, status: PiRunStatus, dirMtimeMs: number): RailTask | null {
  const steps = Array.isArray(status.steps) ? status.steps : [];
  const stepIndex =
    typeof status.currentStep === "number" && status.currentStep >= 0 && status.currentStep < steps.length
      ? status.currentStep
      : 0;
  const step = steps[stepIndex];
  const agentType = typeof step?.agent === "string" && step.agent ? step.agent : undefined;
  const task: RailTask = {
    taskId: runId,
    name: step?.sessionName?.trim() || agentType || runId,
    kind: "subagent",
    status: isRunning(status, dirMtimeMs) ? "running" : "done",
    startedAt: typeof status.startedAt === "number" ? status.startedAt : undefined,
    updatedAt: updatedAtOf(status, dirMtimeMs),
    depth: 1,
  };
  if (agentType) task.agentType = agentType;
  if (steps.length > 1) task.detail = `${steps.length} 步 · 第 ${stepIndex + 1} 步`;
  if (status.mode === "workflow") task.detail = task.detail ?? "workflow";
  return task;
}
