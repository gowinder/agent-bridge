// pi 的子代理默认模型只认 settings.json（用户级 `~/.pi/agent` 或项目的 `.pi`），
// 没有命令行旗标也没有环境变量。要给单个托管会话钉住子代理模型，就给这个会话准备一份
// agent 目录：其余条目按项软链到真实目录，settings.json 换成带 `subagents.defaultModel`
// 的副本，再用 `PI_CODING_AGENT_DIR` 指过去。
//
// 不能整目录软链 `npm`：pi 解析已安装的包时要真实目录，软链过去会当成没装，扩展全不加载。
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 用户真正的 pi agent 目录；Bridge 自己也可能被 PI_CODING_AGENT_DIR 指到别处。 */
export function piAgentSourceDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["PI_CODING_AGENT_DIR"]?.trim();
  return configured ? configured : join(homedir(), ".pi", "agent");
}

/** 子代理与压缩在 settings.json 里的覆盖项；都没设时不另建目录。 */
export interface PiSubagentSettings {
  model?: string;
  thinking?: string;
  /** `compaction.reserveTokens`：剩余这么多 token 时触发自动压缩。 */
  reserveTokens?: number;
}

/**
 * pi 会往这些目录里写运行时数据（会话转录、任务、子代理记录）。
 * 它们必须整目录软链到源目录，不能像只读资源那样建成真实目录：
 * 否则 pi 把会话写进 target 里，下一次重建被 rmSync 连带删掉，
 * `--session-id` 再启动就只能新建一个空会话（表现为历史全丢）。
 */
const RUNTIME_DIRS = new Set(["sessions", "missions", "pi-subagents"]);

/**
 * 老版本的这些目录是真实目录，里面已经有 pi 写下的数据。
 * 重建之前先搬回源目录，否则升级后第一次启动就把历史清空了。
 */
function rescueRuntimeDir(target: string, source: string, name: string): void {
  const from = join(target, name);
  const to = join(source, name);
  let entries: string[];
  try {
    if (lstatSync(from).isSymbolicLink() || !statSync(from).isDirectory()) return;
    entries = readdirSync(from);
  } catch {
    return;
  }
  try {
    mkdirSync(to, { recursive: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if (existsSync(dest)) continue;
    try {
      renameSync(src, dest);
    } catch {
      // 跨卷时 rename 会失败：退回复制再删，别把数据留在待删的 target 里。
      try {
        cpSync(src, dest, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      } catch {
        // 单项搬不动就留着，至少别抛错挡住 pi 启动。
      }
    }
  }
}

/**
 * 准备这个会话专用的 pi agent 目录，返回要放进 `PI_CODING_AGENT_DIR` 的路径。
 * 没设子代理模型与思考等级、或读不到用户的 agent 目录时返回 null：不覆盖，pi 用默认目录。
 * 只覆盖传进来的项，其余沿用用户 settings.json 里的值（例如只设思考等级时模型仍跟随）。
 */
export function preparePiAgentDir(
  target: string,
  options: PiSubagentSettings,
  source: string = piAgentSourceDir(),
): string | null {
  if (!options.model && !options.thinking && options.reserveTokens === undefined) return null;
  // 指向自己就别动，否则会把真实目录清空。
  if (resolve(target) === resolve(source)) return null;
  let entries: string[];
  try {
    entries = readdirSync(source);
  } catch {
    return null;
  }
  // 先抢救老版本落在 target 里的会话，再整体重建。
  for (const name of RUNTIME_DIRS) rescueRuntimeDir(target, source, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of entries) {
    if (name === "settings.json") continue;
    const from = join(source, name);
    const to = join(target, name);
    try {
      if (statSync(from).isDirectory()) {
        // 运行时数据整目录软链：重建时只删链接，源目录里的会话与任务不受影响。
        if (RUNTIME_DIRS.has(name)) {
          symlinkSync(from, to);
          continue;
        }
        mkdirSync(to, { recursive: true });
        for (const child of readdirSync(from)) {
          if (existsSync(join(to, child))) continue;
          symlinkSync(join(from, child), join(to, child));
        }
      } else {
        symlinkSync(from, to);
      }
    } catch {
      // 单个条目链不过去（权限、并发删除）不影响 pi 启动，缺的那项按默认处理。
    }
  }
  // 源目录里还没有 sessions 时（没在终端跑过 pi），先建出来再软链，
  // 否则 pi 会在 target 里新建真实目录，下次重建又丢。
  const sessionsSource = join(source, "sessions");
  const sessionsTarget = join(target, "sessions");
  try {
    if (!existsSync(sessionsTarget)) {
      mkdirSync(sessionsSource, { recursive: true });
      symlinkSync(sessionsSource, sessionsTarget);
    }
  } catch {
    // 建不出来就让 pi 自己用默认目录，至少不挡启动。
  }
  const settings = readSettings(join(source, "settings.json"));
  const subagents =
    typeof settings["subagents"] === "object" && settings["subagents"] !== null && !Array.isArray(settings["subagents"])
      ? { ...(settings["subagents"] as Record<string, unknown>) }
      : {};
  if (options.model) subagents["defaultModel"] = options.model;
  if (options.thinking) subagents["defaultThinking"] = options.thinking;
  settings["subagents"] = subagents;
  if (options.reserveTokens !== undefined) {
    const compaction =
      typeof settings["compaction"] === "object" && settings["compaction"] !== null && !Array.isArray(settings["compaction"])
        ? { ...(settings["compaction"] as Record<string, unknown>) }
        : {};
    compaction["reserveTokens"] = options.reserveTokens;
    settings["compaction"] = compaction;
  }
  try {
    writeFileSync(join(target, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    return null;
  }
  return target;
}

/** 清掉这个会话的 agent 目录（取消子代理模型时用）。 */
export function removePiAgentDir(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // 用户的 settings.json 读不出来就按空配置起，至少子代理模型能生效。
  }
  return {};
}
