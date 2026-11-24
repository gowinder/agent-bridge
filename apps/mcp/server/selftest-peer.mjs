/**
 * 内存回环的「假 bridge」：验证 PeerClient 的请求/响应/错误/超时路径（不碰网络）。
 * 作为模块被 selftest.mjs 引用（共用它的 assert），也能单独跑：npm run selftest:peer。
 */

import { pathToFileURL } from "node:url";
import { loadNoiseNode } from "@craftstead/crypto/node";
import { PeerClient, PeerError } from "./lib/peer.mjs";
import { NoiseHandshake, reconnectPrologue } from "@craftstead/crypto";

class MemoryConnection {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.onSend = null;
    this.closedResolvers = [];
    this.isClosed = false;
  }

  push(frame) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.queue.push(frame);
  }

  nextFrame(timeoutMs = 10_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error("中继数据帧超时"));
      }, timeoutMs);
      const waiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }

  closed() {
    if (this.isClosed) return Promise.resolve({ code: 1000, reason: "done" });
    return new Promise((resolve) => this.closedResolvers.push(resolve));
  }

  sendBinary(frame) {
    this.onSend?.(frame);
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const resolve of this.closedResolvers) resolve({ code: 1000, reason: "done" });
  }
}

export async function runPeerLoopbackTest(noise, { assert, assertEqual }) {
  const roomId = "room-1234";
  const channel = "00112233445566778899aabbccddeeff";
  const deviceId = "11111111-2222-3333-4444-555555555555";
  const prologue = reconnectPrologue(roomId, channel, deviceId);
  const deviceKeys = noise.generateKeyPair();
  const bridgeKeys = noise.generateKeyPair();
  const clientHs = new NoiseHandshake(noise, {
    pattern: "ik",
    initiator: true,
    localKeys: deviceKeys,
    remotePublicKey: bridgeKeys.publicKey,
    prologue,
  });
  const bridgeHs = new NoiseHandshake(noise, { pattern: "ik", initiator: false, localKeys: bridgeKeys, prologue });
  // ik 握手：客户端发一阵，bridge 回一阵。
  const first = clientHs.write();
  bridgeHs.read(first);
  const second = bridgeHs.write();
  clientHs.read(second);
  assert(clientHs.finished && bridgeHs.finished, "回环 ik 握手完成");
  const clientChannel = clientHs.intoChannel();
  const bridgeChannel = bridgeHs.intoChannel();

  const connection = new MemoryConnection();
  const received = [];
  connection.onSend = (frame) => {
    // 客户端发出的帧：解密后交给「假 bridge」处理。
    const message = bridgeChannel.open(frame);
    if (!message) return;
    received.push(message);
    if (message.method === "message.list") return; // 故意不回，验证超时
    if (message.method === "session.list") {
      connection.push(bridgeChannel.seal({ v: 1, kind: "response", id: message.id, ok: false, error: { code: "unsupported", message: "假 bridge 模拟的错误" } })[0]);
      return;
    }
    connection.push(
      bridgeChannel.seal({
        v: 1,
        kind: "response",
        id: message.id,
        ok: true,
        result:
          message.method === "device.list"
            ? { devices: [{ deviceId, name: "Muse (MCP)", clientType: "mcp" }] }
            : { accepted: true, delivered: true },
      })[0],
    );
  };

  const client = new PeerClient(connection, clientChannel);
  try {
    const devices = await client.requestWith("device.list", undefined, { timeoutMs: 3000 });
    assert(devices.ok === true && devices.result.devices.length === 1, "PeerClient 收到并按 id 匹配响应");
    assertEqual(devices.result.devices[0].clientType, "mcp", "响应内容原样返回");

    const send = await client.requestWith(
      "message.send",
      { sessionId: "s1", text: "hi" },
      { timeoutMs: 3000, operationId: "op-selftest-1" },
    );
    assert(send.ok === true && send.result.accepted === true, "变更类请求带 operationId 往返成功");
    const sent = received.find((message) => message.method === "message.send");
    assert(sent?.operationId === "op-selftest-1", "请求帧带顶层 operationId（幂等键）", sent?.operationId);
    assert(sent?.params?.sessionId === "s1", "请求 params 原样到达");

    const failed = await client.requestWith("session.list", undefined, { timeoutMs: 3000 });
    assert(failed.ok === false && failed.error.code === "unsupported", "bridge 错误响应不被改写成成功", failed.error);

    const started = Date.now();
    let timeoutError = null;
    try {
      await client.requestWith("message.list", undefined, { timeoutMs: 300 });
    } catch (error) {
      timeoutError = error;
    }
    assert(timeoutError instanceof PeerError && timeoutError.code === "timeout", "无响应时按超时报错", timeoutError?.message);
    assert(Date.now() - started < 2000, "超时不靠 60s 通道判死（按调用覆盖）");
  } finally {
    client.stop();
  }
  assert(connection.isClosed === true, "client.stop() 关掉通道");
}

// ---------------------------------------------------------------- 独立 CLI 入口

const results = [];

function assert(condition, label, detail) {
  const ok = Boolean(condition);
  results.push({ ok, label });
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

function assertEqual(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  assert(same, label, same ? undefined : { actual, expected });
}

async function main() {
  console.log(`Agent Bridge MCP peer loopback selftest · node ${process.version}`);
  const noise = await loadNoiseNode();
  await runPeerLoopbackTest(noise, { assert, assertEqual });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n共 ${results.length} 项断言，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const item of failed) console.error(`  ✗ ${item.label}`);
    process.exit(1);
  }
  console.log("SELFTEST PASS");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nSELFTEST FAIL: ${error?.stack ?? error}`);
    process.exit(1);
  });
}

export { main };
