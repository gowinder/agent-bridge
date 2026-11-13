// pi-subagents 的后台 async run 把状态写在
// `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json`。
// 前台子代理跑在 pi 进程内部、不走 stdout，只有后台 run 有可读的产物。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RailTask } from "@craftstead/protocol";

const RUNS_DIR_NAME = "async-subagent-runs";
/** 状态还写着在跑、但这么久没动静的 run 不再算在跑（进程被杀掉的情况）。 */
const RUN_STALE_MS = 10 * 60_000;
/** 侧栏只列最新的这些。 */
const MAX_PI_TASKS = 20;
/** 按目录时间挑这么多份 status.json 读，免得扫几百个 run。 */
const MAX_SCANNED_RUNS = MAX_PI_TASKS * 2;

interface PiRunStatus {
  runId?: string;
  sessionId?: string;
  state?: string;
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

/** 某个 pi 会话派生的后台子代理 run，最新在前。 */
export function piSubagentTasks(
  piSessionId: string | undefined,
  max = MAX_PI_TASKS,
  root = piSubagentRoot(),
): RailTask[] {
  if (!piSessionId) return [];
  const runsDir = join(root, RUNS_DIR_NAME);
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return { name: entry.name, mtimeMs: statSync(join(runsDir, entry.name)).mtimeMs };
        } catch {
          return { name: entry.name, mtimeMs: 0 };
        }
      });
  } catch {
    // 没跑过后台子代理，或 pi 的临时目录已被清掉。
    return [];
  }
  const tasks: RailTask[] = [];
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SCANNED_RUNS)) {
    let status: PiRunStatus;
    try {
      status = JSON.parse(readFileSync(join(runsDir, entry.name, "status.json"), "utf8")) as PiRunStatus;
    } catch {
      continue;
    }
    // run 目录按用户共享，只留这个会话派生的。
    if (status.sessionId !== piSessionId) continue;
    const task = taskOf(entry.name, status, entry.mtimeMs);
    if (task) tasks.push(task);
  }
  return tasks
    .sort((a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0))
    .slice(0, max);
}

function taskOf(runId: string, status: PiRunStatus, dirMtimeMs: number): RailTask | null {
  const steps = Array.isArray(status.steps) ? status.steps : [];
  const stepIndex =
    typeof status.currentStep === "number" && status.currentStep >= 0 && status.currentStep < steps.length
      ? status.currentStep
      : 0;
  const step = steps[stepIndex];
  const agentType = typeof step?.agent === "string" && step.agent ? step.agent : undefined;
  const state = typeof status.state === "string" ? status.state : "";
  const updatedAt =
    [status.lastActivityAt, status.lastUpdate, status.endedAt, dirMtimeMs].find(
      (value): value is number => typeof value === "number" && value > 0,
    ) ?? dirMtimeMs;
  // queued/running/paused 都算没结束，其余（complete/failed/partial/stopped/rejected）算结束。
  const unfinished = state === "queued" || state === "running" || state === "paused";
  const task: RailTask = {
    taskId: runId,
    name: step?.sessionName?.trim() || agentType || runId,
    kind: "subagent",
    status: unfinished && Date.now() - updatedAt < RUN_STALE_MS ? "running" : "done",
    startedAt: typeof status.startedAt === "number" ? status.startedAt : undefined,
    updatedAt,
    depth: 1,
  };
  if (agentType) task.agentType = agentType;
  if (steps.length > 1) task.detail = `${steps.length} 步 · 第 ${stepIndex + 1} 步`;
  if (status.mode === "workflow") task.detail = task.detail ?? "workflow";
  return task;
}
