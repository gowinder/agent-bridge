#!/usr/bin/env node
/**
 * 一次性配对命令（不是 MCP 工具，spec §2）。
 *
 *   node server/pair.mjs --invite-file <包含邀请链接的文件>
 *   node server/pair.mjs --invite "https://.../#/pair?relay=…&room=…&invite=…"   # 不推荐（shell 历史会留）
 *
 * 流程照 spike：解析邀请 → hello(invite) → xxpsk3 握手 → 打印 6 位确认码 →
 * 等 <状态目录>/confirm 出现 yes（240s 超时 / no 即放弃）→ pair.request
 * （deviceName "Muse (MCP)"，clientType "mcp"）→ 身份落盘 0600。
 *
 * 邀请只从命令行参数/本地文件读：不接受聊天里粘贴的邀请，也不打印邀请全文。
 */

import { access, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { toHex } from "@craftstead/crypto";
import { ToolError } from "./lib/errors.mjs";
import { loadNoise, parsePairingLink, startPairing } from "./lib/pairing.mjs";
import { PeerClient } from "./lib/peer.mjs";
import { loadProfile } from "./lib/profile.mjs";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_DEVICE_NAME,
  ensureStateDir,
  stateDir,
  statePaths,
  waitForConfirmFile,
  writeSecretJson,
} from "./lib/state.mjs";

const CONFIRM_TIMEOUT_MS = 240_000;

const USAGE = `用法：
  node server/pair.mjs --invite-file <文件>      # 推荐：邀请链接先写成本机文件
  node server/pair.mjs --invite "<邀请链接>"      # 谨慎：会留在 shell 历史里

参数：
  --name <设备名>        默认 ${DEFAULT_DEVICE_NAME}（bridge 设备列表里显示的名字）
  --allow-relay          允许配对到 profile.relayUrl 之外的中继（自建 relay 场景；默认拒绝）

配对前准备：
  1. Mac 菜单栏 Agent Bridge → 生成配对邀请链接；
  2. 把整条链接（含 #/pair?... 片段）写进本机文件；
  3. 运行本命令，比对菜单栏与终端里的 6 位确认码；
  4. 一致时把 yes 写进确认文件（本命令会打印实际路径），不一致写 no（或 Ctrl-C）。

状态目录：--state-dir > $AGENT_BRIDGE_MCP_HOME > $XDG_CONFIG_HOME/agent-bridge/mcp > ~/.agent-bridge/mcp
  （0700；identity.json 0600；目录不进仓库）
listener 配对示例（listener 用独立设备身份）：
  node server/pair.mjs --invite-file invite-listener.txt \\
    --state-dir ~/.agent-bridge/mcp/listener --name "Muse (MCP) Listener"
`;

/** --state-dir 走环境变量：lib/state.mjs 的所有路径都从 AGENT_BRIDGE_MCP_HOME 来。 */
function applyStateDirOverride(flags) {
  const dir = flags.get("state-dir");
  if (dir === undefined) return;
  if (!dir.trim()) throw new UsageError("--state-dir 不能为空");
  process.env.AGENT_BRIDGE_MCP_HOME = resolve(dir);
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) throw new UsageError(`不认识的参数：${item}`);
    if (item === "--allow-relay") {
      flags.set("allow-relay", "true");
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`参数 ${item} 缺值`);
    flags.set(item.slice(2), value);
    i += 1;
  }
  return flags;
}

class UsageError extends Error {}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function finish(code) {
  // WebSocket 会挂住事件循环：等 stdout flush 后直接退出。
  process.stdout.write("", () => process.exit(code));
}

async function readInvite(flags) {
  const file = flags.get("invite-file");
  const inline = flags.get("invite");
  if (file) return { text: (await readFile(file, "utf8")).trim(), source: `文件 ${file}` };
  if (inline) return { text: inline.trim(), source: "命令行参数（注意 shell 历史）" };
  return null;
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
    applyStateDirOverride(flags);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return finish(2);
  }

  const invite = await readInvite(flags).catch((error) => {
    console.error(`读取邀请失败：${error.message}`);
    return null;
  });
  if (!invite) {
    console.error(`没有邀请链接，拒绝启动配对。\n\n${USAGE}`);
    return finish(2);
  }

  const link = parsePairingLink(invite.text);
  if (!link) {
    console.error(
      "邀请链接无法解析：需要形如 https://<host>/#/pair?relay=…&room=…&invite=… 的整条链接（fragment 必须在）。",
    );
    return finish(2);
  }

  const { profile } = await loadProfile();
  if (link.relayUrl !== profile.relayUrl && flags.get("allow-relay") !== "true") {
    console.error(
      [
        `邀请里的中继（${link.relayUrl}）与 profile.relayUrl（${profile.relayUrl}）不一致，已拒绝。`,
        "默认只配对 profile.relayUrl（默认是生产中继 https://agent-bridge.craftstead.app）；自建 relay 的邀请地址会不同。",
        `确需配对到这个中继：改 ${statePaths().profile} 里的 relayUrl，或显式加 --allow-relay。`,
      ].join("\n"),
    );
    return finish(2);
  }

  const { identity: identityPath, confirm } = statePaths();
  if (await exists(identityPath)) {
    console.error(
      `已经有配对结果：${identityPath}\n拒绝重复配对。要重新配对先删除状态目录：rm -rf ${JSON.stringify(stateDir())}`,
    );
    return finish(2);
  }

  await ensureStateDir();
  const name = (flags.get("name") ?? DEFAULT_DEVICE_NAME).trim();
  if (name.length < 1 || name.length > 64) {
    console.error("设备名长度必须是 1..64。");
    return finish(2);
  }

  console.log(`邀请来源：${invite.source}`);
  console.log(`中继：${link.relayUrl}`);
  console.log(`房间：${link.roomId}`);
  console.log(`邀请：${link.inviteToken.slice(0, 8)}…（${link.inviteToken.length} 字符，不打印全文）`);
  console.log(`设备名：${name}  类型：mcp`);

  const noise = await loadNoise();
  let pairing = null;
  try {
    pairing = await startPairing(noise, link);
    console.log("");
    console.log("==============================================");
    console.log(`  配对确认码：${pairing.confirmCode}`);
    console.log("  核对 Mac 菜单栏上的码是否一致（不一致就写 no）");
    console.log("==============================================");
    console.log("");

    await waitForConfirmFile({ timeoutMs: CONFIRM_TIMEOUT_MS });

    const peer = new PeerClient(pairing.connection, pairing.secure);
    const response = await peer.requestWith(
      "pair.request",
      {
        deviceName: name,
        platform: process.platform,
        clientType: "mcp",
        confirmCode: pairing.confirmCode,
      },
      { timeoutMs: 60_000, operationId: `pair-${pairing.channel}` },
    );
    if (!response.ok) {
      throw new ToolError(response.error?.code ?? "pair_failed", `pair.request 被拒绝：${response.error?.message ?? "未知错误"}`, {
        hint:
          response.error?.code === "invalid_params"
            ? "确认码不一致或邀请已被使用：确认码不符会直接关通道，邀请一次性，失败就要重新生成邀请。"
            : "检查邀请是否过期/已用；邀请一次性，失败后需在 Mac 上重新生成。",
      });
    }
    const result = response.result;
    if (!result?.deviceId || !result?.reconnectToken) {
      throw new ToolError("pair_incomplete", "pair.request 返回里缺 deviceId 或 reconnectToken。", {
        details: { keys: Object.keys(result ?? {}) },
      });
    }

    await writeSecretJson(identityPath, {
      version: 1,
      deviceId: result.deviceId,
      deviceName: name,
      clientType: "mcp",
      platform: process.platform,
      publicKey: toHex(pairing.keys.publicKey),
      privateKey: toHex(pairing.keys.privateKey),
      bridgePublicKey: pairing.bridgePublicKey,
      reconnectToken: result.reconnectToken,
      roomId: link.roomId,
      relayUrl: link.relayUrl,
      bridge: result.bridge ?? null,
      expiresAt: result.expiresAt ?? null,
      pairedAt: new Date().toISOString(),
      pairedWith: { confirmCode: result.confirmCode ?? pairing.confirmCode, channel: pairing.channel },
    });

    console.log("");
    console.log("配对成功，身份已落盘（0600，不会打印令牌）：");
    console.log(`  ${identityPath}`);
    console.log(`  设备：${result.deviceId}（${name}）`);
    if (result.bridge) console.log(`  bridge：${result.bridge.name} ${result.bridge.version} / ${result.bridge.platform}`);

    // best-effort 自查：确认设备在 bridge 的列表里。失败不影响配对结果。
    const devices = await peer.requestWith("device.list", undefined, { timeoutMs: 30_000 }).catch(() => null);
    const self = devices?.ok ? devices.result?.devices?.find((item) => item.deviceId === result.deviceId) : null;
    if (self) console.log(`  device.list 自查：✓ 在列（${devices.result.devices.length} 台设备，clientType=${self.clientType ?? "?"}）`);
    else console.log("  device.list 自查：未完成（不影响配对；可用 bridge_status 复查）");

    peer.stop();
    await rm(confirm, { force: true }).catch(() => {});
    return finish(0);
  } catch (error) {
    console.error(`配对失败：${error.message}`);
    if (error.hint) console.error(error.hint);
    return finish(3);
  } finally {
    try {
      pairing?.connection?.close(1000, "done");
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  console.error(`未处理错误：${error?.stack ?? error}`);
  finish(1);
});
