import { readFileSync } from "node:fs";
import { join } from "node:path";

// 托管会话统一追加的约束。
//
// 为什么需要它：托管 CLI 的 bash 工具不受 Bridge 的 fs-scope 管，agent 为了找一个文件
// 很容易跑 `find ~` / `find /Users/<name>`。主目录下的「桌面 / 文档 / 下载 / 照片 /
// 音乐 / 影片」在 macOS TCC 后面，这一扫就是三四个系统授权弹窗；弹窗没人点，命令就挂在
// 那里，远程会话跟着卡死（实测有会话因此 7 分钟没有任何输出）。
//
// 主会话走两条路注入：pi 用会话专属 agent 目录里的 AGENTS.md（同时让子代理继承），
// Claude Code 用 `--append-system-prompt`。文本保持简短，别把上下文窗口浪费在说教上。
//
// 用户自己在 ~/.pi/agent 里已经有上下文文件（AGENTS.md / CLAUDE.md）时不能盖掉，
// 这条路失效，调用方要退回 CLI 旗标。
export const HOSTED_GUARD_PROMPT = [
  "补充约束（由 Agent Bridge 注入）：",
  "1. 工作目录已经固定在工程目录里，检索、读文件、跑命令都只在工程目录内进行。",
  "2. 不要递归扫描用户主目录（`find ~`、`find /Users/<name>`、`grep -r ~`、`ls ~/*`、`du ~` 这类）。",
  "   主目录下的「桌面 / 文档 / 下载 / 照片 / 音乐 / 影片」在 macOS 系统授权后面，扫描会弹出系统授权框、",
  "   让命令长时间挂住，远程会话也会跟着卡死。",
  "3. 需要主目录里的具体文件时按已知绝对路径直接读取；路径不确定先问用户，不要全盘搜索。",
  "4. 派生子代理时，把第 2、3 条原样写进子代理的任务描述。",
].join("\n");

/** pi 的 agent 目录会作为「全局上下文」加载这个文件；内容由 Bridge 维护，不跟随用户目录。 */
export const HOSTED_GUARD_CONTEXT_FILE = "AGENTS.md";

/** `loadProjectContextFiles` 认的上下文文件名，顺序也一致：已经存在的不能被我们盖掉。 */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/**
 * 会话目录里的 AGENTS.md 是不是**我们**写的。
 *
 * 不能只判断文件存在：用户自己的 AGENTS.md 也会被软链进来，那时准则根本没落地，
 * 必须退回 CLI 旗标。
 */
export function hostedGuardWritten(dir: string): boolean {
  try {
    return readFileSync(join(dir, HOSTED_GUARD_CONTEXT_FILE), "utf8").trim() === HOSTED_GUARD_PROMPT;
  } catch {
    return false;
  }
}
