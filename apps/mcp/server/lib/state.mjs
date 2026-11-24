/**
 * 状态目录：device 私钥与重连令牌只存这里，绝不进 git、绝不打印。
 *
 * 位置按「每用户配置目录」解析（仓库内不留任何运行时状态）：
 *   1. $AGENT_BRIDGE_MCP_HOME（显式覆盖；pair.mjs 的 --state-dir 也是设它）
 *   2. $XDG_CONFIG_HOME/agent-bridge/mcp
 *   3. ~/.agent-bridge/mcp
 * 不要复用 $AGENT_BRIDGE_HOME：那是 bridge 守护进程自己的状态目录，混用会撞车。
 *
 * 来源：gowinder/agent-bridge develop @ 2fbf2f25edd15ff7464ffab1d67ecbfb3fe5412e
 *       spikes/mcp-client/state.mjs（逐字保留函数语义）
 * 改动（相对 spike）：
 *   1. 状态目录改成上面的每用户配置目录，不再写进连接器项目；
 *   2. 环境变量改为 AGENT_BRIDGE_MCP_HOME；
 *   3. 路径表增加 registry / profile（spike 只有 identity / device / confirm），
 *      identity.json 同时承载设备密钥与重连令牌（spike 拆成 device + identity 两个文件）。
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 配对设备名：和 DESIGN §4 一致，在菜单栏/网页设备列表里一眼可辨。 */
export const DEFAULT_DEVICE_NAME = "Muse (MCP)";

/** 显式覆盖只接受绝对路径：相对路径会落到当前目录（很可能正好在仓库里）。 */
function absoluteOverride(value) {
  const trimmed = value?.trim();
  return trimmed && isAbsolute(trimmed) ? trimmed : null;
}

export function stateDir() {
  const override = absoluteOverride(process.env.AGENT_BRIDGE_MCP_HOME);
  if (override) return override;
  const xdg = absoluteOverride(process.env.XDG_CONFIG_HOME);
  if (xdg) return join(xdg, "agent-bridge", "mcp");
  return join(homedir(), ".agent-bridge", "mcp");
}

export function statePaths() {
  const dir = stateDir();
  return {
    dir,
    identity: join(dir, "identity.json"),
    registry: join(dir, "registry.json"),
    profile: join(dir, "profile.json"),
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

/** registry/profile 不含凭据，但同处 0700 目录；同样按 0600 写，少一条要判断的规则。 */
export async function writeStateJson(path, value) {
  await writeSecretJson(path, value);
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
 * 人工确认门：配对确认码要人眼比对，所以握手结束后挂在这里，
 * 直到用户把 `yes` 写进 `<state>/confirm`。
 */
export async function waitForConfirmFile({ timeoutMs = 240_000, intervalMs = 500 } = {}) {
  const { confirm } = statePaths();
  console.log("等待人工确认：请比对菜单栏上的确认码与本脚本打印的确认码。");
  console.log(`  一致    → 把 yes 写进：${confirm}`);
  console.log("  不一致  → 写 no（或直接 Ctrl-C）");
  console.log(`  超时    → ${Math.round(timeoutMs / 1000)} 秒后中止`);
  console.log(`  写法    → printf yes > ${JSON.stringify(confirm)}`);
  const deadline = Date.now() + timeoutMs;
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
