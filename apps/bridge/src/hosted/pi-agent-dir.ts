// pi 的子代理默认模型只认 settings.json（用户级 `~/.pi/agent` 或项目的 `.pi`），
// 没有命令行旗标也没有环境变量。要给单个托管会话钉住子代理模型，就给这个会话准备一份
// agent 目录：其余条目按项软链到真实目录，settings.json 换成带 `subagents.defaultModel`
// 的副本，再用 `PI_CODING_AGENT_DIR` 指过去。
//
// 不能整目录软链 `npm`：pi 解析已安装的包时要真实目录，软链过去会当成没装，扩展全不加载。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of entries) {
    if (name === "settings.json") continue;
    const from = join(source, name);
    const to = join(target, name);
    try {
      if (statSync(from).isDirectory()) {
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
