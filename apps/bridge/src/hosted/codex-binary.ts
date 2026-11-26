import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * codex 装在 bun 的全局目录或 Homebrew 里，菜单栏 app 拉起的 Bridge 未必继承到那条 PATH。
 * 返回 null 表示本机没有 codex：新建面板把它标成不可用，已有会话也不会静默起进程。
 */
export function codexBinary(): string | null {
  const explicit = process.env["AGENT_BRIDGE_CODEX_PATH"];
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const candidate of [
    join(homedir(), ".bun", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
