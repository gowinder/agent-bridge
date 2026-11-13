// 子代理（后台任务）记录：CLI 把每个会话派生的子代理写在
// `~/.claude/projects/<project>/<sessionId>/subagents/<taskId>.meta.json`，
// 运行期间只有同名的 .jsonl 在增长。桌面适配器和 Bridge 托管会话共用这份读取逻辑。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RailTask } from "@craftstead/protocol";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
/** meta 还写着 running 的子代理，只在文件仍然新鲜时才算在跑。 */
const SUBAGENT_RUNNING_MAX_AGE_MS = 10 * 60_000;
/** 侧栏只列最新的这些；长会话可能派生几百个。 */
export const MAX_RAIL_TASKS = 20;

interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  spawnDepth?: number;
  finished?: boolean;
  pickedEffortModel?: string;
}

/** CLI 转录所在的 project 目录；找不到返回 null。 */
function projectDirOf(cliSessionId: string, root: string): string | null {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(root, entry.name, `${cliSessionId}.jsonl`))) {
        return join(root, entry.name);
      }
    }
  } catch {
    // 没有 projects 目录：这个会话没有转录，也就没有子代理记录。
  }
  return null;
}

/** 这些 CLI 会话各自的 `subagents` 目录，按传入顺序去重。 */
export function subagentDirsFor(
  cliSessionIds: Array<string | undefined>,
  root = PROJECTS_DIR,
): string[] {
  const dirs: string[] = [];
  for (const id of cliSessionIds) {
    if (!id) continue;
    const project = projectDirOf(id, root);
    if (!project) continue;
    const dir = join(project, id, "subagents");
    if (existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** 这些 CLI 会话派生过的子代理，最新在前。 */
export function subagentTasks(
  cliSessionIds: Array<string | undefined>,
  max = MAX_RAIL_TASKS,
  root = PROJECTS_DIR,
): RailTask[] {
  const tasks: RailTask[] = [];
  const seen = new Set<string>();
  for (const dir of subagentDirsFor(cliSessionIds, root)) {
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
        // 退回用 meta 的时间
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
    .slice(0, max);
}
