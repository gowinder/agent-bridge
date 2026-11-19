#!/usr/bin/env node
import { access, rm } from "node:fs/promises";
import { PeerClient } from "./peer.mjs";
import { loadNoise, parsePairingLink, startPairing } from "./pairing.mjs";
import { runSelftest } from "./selftest.mjs";
import {
  DEFAULT_DEVICE_NAME,
  ensureStateDir,
  statePaths,
  waitForConfirmFile,
  writeSecretJson,
} from "./state.mjs";
import { runReconnect, runVerify } from "./verify.mjs";

/**
 * Part 1 的无头配对 spike：验证「不带浏览器，用 MCP 客户端身份跑完配对与重连」是否可行。
 * 一次性验证脚本，不进 tsc 构建（根 tsconfig 只有 references，不含 spikes/）。
 */

const USAGE = `用法：node spikes/mcp-client/spike.mjs <子命令> [参数]

子命令：
  selftest                 无网络自检（wasm 加载 / xxpsk3 + ik 握手 / 分片 / 链接解析）
  pair "<邀请链接>"        配对一台设备（会等人把 yes 写进状态目录的 confirm 文件）
  verify                   用已配对的身份重连并验证一轮读写
  reconnect                只重连 + session.list，证明身份持久化有效

参数：
  --name <设备名>          默认 ${DEFAULT_DEVICE_NAME}（trim 后 1..64 字符）
  --dir <路径>             verify 新建托管会话用的目录，默认取 hosted.dirs 里第一个可用项

状态目录（设备私钥/令牌只存这里，绝不进仓库）：
  $AGENT_BRIDGE_SPIKE_HOME 或 ~/Library/Application Support/AgentBridge-mcp-spike

不要对着生产实例（47825）做 pair/verify；preview（47826）没有邀请链接时也不要做。
`;

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`参数 ${item} 缺值`);
      flags.set(item.slice(2), value);
      i += 1;
      continue;
    }
    positional.push(item);
  }
  return { positional, flags };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function finish(code) {
  // WebSocket 在 Node 下会挂住事件循环；spike 一次性跑完，直接退出。
  // stdout 接到管道时是异步写：先等它 flush，否则 `| tail` 会把输出截断。
  process.stdout.write("", () => process.exit(code));
}

async function runPair(linkText, name) {
  const link = parsePairingLink(linkText);
  if (!link) throw new Error("邀请链接无法解析：需要形如 https://<host>/#/pair?relay=…&room=…&invite=…");
  console.log(`中继：${link.relayUrl}\n房间：${link.roomId}\n邀请：${link.inviteToken.slice(0, 8)}…（${link.inviteToken.length} 字符）`);

  const { dir, device: deviceFile } = statePaths();
  if (await exists(deviceFile)) {
    throw new Error(
      `已经有配对结果（${deviceFile}），拒绝重复配对。要重新配对先删掉状态目录：rm -rf ${JSON.stringify(dir)}`,
    );
  }
  await ensureStateDir();
  console.log(`状态目录：${dir}`);
  // 上一次中断的运行可能把 yes 留在盘上；清掉，这次必须重新人工确认。
  await rm(statePaths().confirm, { force: true });

  const noise = await loadNoise();
  let challenge = null;
  let client = null;
  try {
    challenge = await startPairing(noise, link);
    console.log("\n=================================================");
    console.log(`   配对确认码：${challenge.confirmCode}`);
    console.log("=================================================");
    console.log("菜单栏预览里显示同一个码才继续；码不一致说明中继/房间被换掉了。");
    await waitForConfirmFile();

    client = new PeerClient(challenge.connection, challenge.secure);
    const response = await client.request(
      "pair.request",
      {
        deviceName: name,
        platform: `node ${process.version} mcp-spike`,
        // 新版 Bridge 会把这个设备标成 MCP；老 Bridge 忽略未知键，不影响配对。
        clientType: "mcp",
        confirmCode: challenge.confirmCode,
      },
      60_000,
    );
    if (!response.ok || !response.result) {
      const code = response.error?.code ?? "internal";
      const message = response.error?.message ?? "配对被拒绝";
      const hint = message.includes("确认码") ? "\n确认码不一致：这张邀请已经作废，需要重新生成邀请链接。" : "";
      throw new Error(`pair.request 失败（${code}）：${message}${hint}`);
    }
    const result = response.result;

    await writeSecretJson(statePaths().identity, {
      privateKey: toHexString(challenge.keys.privateKey),
      publicKey: toHexString(challenge.keys.publicKey),
    });
    await writeSecretJson(statePaths().device, {
      deviceId: result.deviceId,
      reconnectToken: result.reconnectToken,
      roomId: link.roomId,
      relayUrl: link.relayUrl,
      bridgePublicKey: challenge.bridgePublicKey,
      expiresAt: result.expiresAt,
      name,
      pairedAt: Date.now(),
    });

    console.log("\nPairResult：");
    // reconnectToken 只落 0600 的 device.json，不进 stdout（tee/会话日志会把凭据带出本机）。
    const { reconnectToken: _secret, ...safeResult } = result;
    console.log(JSON.stringify(safeResult, null, 2));
    console.log(`\n已保存设备身份到 ${statePaths().identity} 与 ${statePaths().device}（0600）`);
    console.log("PAIR PASS");
  } finally {
    if (client) client.stop();
    else if (challenge) challenge.connection.close(1000, "pair done");
  }
}

function toHexString(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function parseName(flags) {
  const raw = flags.get("name") ?? DEFAULT_DEVICE_NAME;
  const name = raw.trim();
  if (!name || name.length > 64) throw new Error(`--name 必须 trim 后 1..64 字符（当前 ${name.length}）`);
  return name;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "selftest") {
    await runSelftest();
    return 0;
  }

  if (command === "pair") {
    const linkText = positional[1] ?? flags.get("link");
    if (!linkText) throw new Error(`pair 需要邀请链接：node spike.mjs pair "https://…/#/pair?…"`);
    await runPair(linkText, parseName(flags));
    return 0;
  }

  if (command === "verify") {
    await runVerify(await loadNoise(), { name: parseName(flags), dir: flags.get("dir") });
    return 0;
  }

  if (command === "reconnect") {
    await runReconnect(await loadNoise());
    return 0;
  }

  throw new Error(`未知子命令：${command}\n\n${USAGE}`);
}

main().then(
  (code) => {
    process.exitCode = code;
    finish(code);
  },
  (error) => {
    console.error(`\n${error?.name === "PeerError" ? `[${error.code}] ` : ""}${error?.message ?? error}`);
    process.exitCode = 1;
    if (process.env.AGENT_BRIDGE_SPIKE_DEBUG) console.error(error);
    // stderr 也要 flush：强退前把错误完整写出去。
    process.stderr.write("", () => finish(1));
  },
);
