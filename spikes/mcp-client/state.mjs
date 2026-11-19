import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认设备名：和网页里手动改名时用的名字一致，便于在「设备」列表里认出来。 */
export const DEFAULT_DEVICE_NAME = "Muse (MCP) · spike";

/** 状态目录必须留在仓库外：里面是设备私钥与重连令牌。 */
export function stateDir() {
  const override = process.env.AGENT_BRIDGE_SPIKE_HOME?.trim();
  if (override) return override;
  return join(homedir(), "Library", "Application Support", "AgentBridge-mcp-spike");
}

export function statePaths() {
  const dir = stateDir();
  return {
    dir,
    identity: join(dir, "identity.json"),
    device: join(dir, "device.json"),
    confirm: join(dir, "confirm"),
  };
}

export async function ensureStateDir() {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 目录已存在时 mkdir 的 mode 不生效，显式收紧一次。
  await chmod(dir, 0o700);
  return dir;
}

/** 私钥/令牌文件统一 0600：先写再 chmod，避免受 umask 影响。 */
export async function writeSecretJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 人工确认门：配对确认码要人眼比对，所以握手结束后脚本挂在这里，
 * 直到用户把 `yes` 写进 `<state>/confirm`。
 */
export async function waitForConfirmFile({ timeoutMs = 240_000, intervalMs = 500 } = {}) {
  const { confirm } = statePaths();
  const deadline = Date.now() + timeoutMs;
  console.log(`等待人工确认：请比对菜单栏上的确认码与本脚本打印的确认码。`);
  console.log(`  一致    → 把 yes 写进：${confirm}`);
  console.log(`  不一致  → 写 no（或直接 Ctrl-C）`);
  console.log(`  超时    → ${Math.round(timeoutMs / 1000)} 秒后中止`);
  console.log(`  写法    → printf yes > ${JSON.stringify(confirm)}`);
  for (;;) {
    let text = null;
    try {
      text = (await readFile(confirm, "utf8")).trim().toLowerCase();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (text === "yes") {
      console.log("确认门：收到 yes，继续配对。");
      return;
    }
    if (text) throw new Error(`确认文件内容为「${text}」，不是 yes，中止配对：${confirm}`);
    if (Date.now() >= deadline) throw new Error(`等待人工确认超时，中止配对：${confirm}`);
    await sleep(intervalMs);
  }
}
