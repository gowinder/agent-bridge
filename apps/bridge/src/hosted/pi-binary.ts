import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi 装在 bun 的全局目录里，菜单栏 app 拉起的 Bridge 未必继承到那条 PATH。 */
export function piBinary(): string | null {
  const explicit = process.env["AGENT_BRIDGE_PI_PATH"];
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const candidate of [join(homedir(), ".bun", "bin", "pi"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
