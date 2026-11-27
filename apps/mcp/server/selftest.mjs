#!/usr/bin/env node
/**
 * 离线自检（仿 spike 的 selftest 风格）：全部不碰网络、不碰 Mac、不碰生产实例。
 *
 * 覆盖：
 *   1. Noise wasm 加载 + xxpsk3/ik 回环握手 + 单帧/分片往返
 *   2. 协议编解码（parseWireMessage / parseRelayHello / 邀请链接解析 / relay URL）
 *   3. profile 合并逻辑
 *   4. 登记册 CRUD + 审计 + 文件权限
 *   4b. 登记册并发：跳进程锁下 upsert/appendAudit 一条不丢；无锁对照确实丢；陈旧锁回收；
 *       登记册副本的原子写与「审计只追加」
 *   4c. 锁的陈旧策略：死 pid 立即回收 / 活 pid 二次确认 / 不可解析锁短确认通道
 *   5. 消息视图与「pi 在提问」识别
 *   6. 未配对行为：9 个工具全部返回明确「未配对」错误；pair.mjs 无邀请时拒绝启动
 *   7. 凭据不外泄：日志脱敏、stdout/stderr 无令牌/私钥字样
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  confirmCode,
  derivePairPsk,
  NoiseHandshake,
  pairPrologue,
  reconnectPrologue,
} from "@craftstead/crypto";
import { loadNoiseNode, NOISE_WASM_BYTES, NOISE_WASM_SHA256, WasmIntegrityError } from "@craftstead/crypto/node";
import { MAX_FRAME_BYTES, parseRelayHello, parseWireMessage, PROTOCOL_VERSION } from "@craftstead/protocol";
import { ALLOWED_TOOLS } from "../bin/client.mjs";
import { loadIdentity } from "./lib/bridge.mjs";
import { LOCK_DEFAULTS } from "./lib/lock.mjs";
import { log, registerSecret } from "./lib/log.mjs";
import {
  detectNeedsUser,
  hasTruncatedBlock,
  looksLikeQuestion,
  messageText,
  messageView,
  sortMessages,
  withFullText,
} from "./lib/messages.mjs";
import { credentialsFromFragment, parsePairingLink } from "./lib/pairing.mjs";
import { DEFAULT_PROFILE, loadProfile, mergeProfile, normalizeRelayUrl } from "./lib/profile.mjs";
import {
  appendAudit,
  findByKey,
  findBySessionId,
  loadRegistry,
  findAcceptedSend,
  messageDigest,
  readRegistry,
  saveRegistry,
  sessionKey,
  setArchived,
  setInFlight,
  touchSession,
  updateRegistry,
  upsertSession,
} from "./lib/registry.mjs";
import { helloMessage, relaySocketUrl } from "./lib/relay.mjs";
import { ensureStateDir, readJson, stateDir, statePaths, writeSecretJson } from "./lib/state.mjs";
import { listenerStateDir } from "./lib/listener-state.mjs";
import { runPeerLoopbackTest } from "./selftest-peer.mjs";
import { TOOL_DEFINITIONS } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER_ENTRY = join(HERE, "index.mjs");
const CLIENT_ENTRY = join(ROOT, "bin", "client.mjs");
const PAIR_ENTRY = join(HERE, "pair.mjs");
const REGISTRY_LIB_URL = pathToFileURL(join(HERE, "lib", "registry.mjs")).href;
const LOCK_LIB_URL = pathToFileURL(join(HERE, "lib", "lock.mjs")).href;
/** 仓库里的 wasm 由 @craftstead/crypto 发布（packages/crypto/wasm/noise.wasm）：从包入口反推，不硬编码层级。 */
const WASM_PATH = fileURLToPath(new URL("../wasm/noise.wasm", import.meta.resolve("@craftstead/crypto/node")));

const SENTINEL_SECRET = "SENTINEL_NOT_A_REAL_TOKEN_0123456789abcdef";

const results = [];
const capturedOutput = [];

function record(ok, label, detail) {
  results.push({ ok, label, detail });
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  throw new Error(`自检失败：${label}`);
}

function assert(condition, label, detail) {
  record(Boolean(condition), label, detail);
}

function assertThrows(fn, label, matcher) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  const ok = error !== null && (matcher === undefined || Boolean(matcher(error)));
  record(ok, label, error === null ? "未抛错（应当拒绝）" : error.message);
  return error;
}

function assertEqual(actual, expected, label) {
  record(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    JSON.stringify(actual) === JSON.stringify(expected) ? undefined : { actual, expected },
  );
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-selftest-"));
  const previous = process.env.AGENT_BRIDGE_MCP_HOME;
  process.env.AGENT_BRIDGE_MCP_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_MCP_HOME;
    else process.env.AGENT_BRIDGE_MCP_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 子进程工具

function startServer(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const pending = new Map();
  let nextId = 1;
  let stdoutText = "";
  let stderrText = "";
  createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    stdoutText += `${line}\n`;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  const request = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`server 响应超时：${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    capturedOutput.push(stdoutText, stderrText);
  };
  return {
    request,
    notify,
    close,
    get stdout() {
      return stdoutText;
    },
    get stderr() {
      return stderrText;
    },
  };
}

function runNode(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      capturedOutput.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- 1. wasm/握手

function pumpHandshake(a, b) {
  const steps = [];
  let message = a.write();
  steps.push(`initiator → ${message.length}B`);
  for (let round = 0; round < 8; round += 1) {
    b.read(message);
    if (a.finished && b.finished) return steps;
    message = b.write();
    steps.push(`responder → ${message.length}B`);
    a.read(message);
    if (a.finished && b.finished) return steps;
    message = a.write();
    steps.push(`initiator → ${message.length}B`);
  }
  throw new Error("握手未在两个方向同时完成（消息顺序不对）");
}

function openAll(frames, channel) {
  let message = null;
  for (const frame of frames) {
    const opened = channel.open(frame);
    if (opened) message = opened;
  }
  return message;
}

async function testCrypto() {
  section("wasm 与握手");
  const noise = await loadNoiseNode();
  assert(
    typeof noise.generateKeyPair === "function",
    "loadNoiseNode 加载 @craftstead/crypto 的 noise.wasm（原样 wasm 通过完整性校验）",
  );

  // C-1：钉死哈希必须与这份 wasm 构建产物一致，篡改即拒绝加载。
  const wasmBytes = await readFile(WASM_PATH);
  const wasmSha256 = createHash("sha256").update(wasmBytes).digest("hex");
  assert(
    wasmSha256 === NOISE_WASM_SHA256 && wasmBytes.byteLength === NOISE_WASM_BYTES,
    "钉死 sha256/字节数与仓库的 noise.wasm 一致（@craftstead/crypto 构建产物）",
    wasmSha256,
  );
  const tamperDir = await mkdtemp(join(tmpdir(), "agent-bridge-wasm-tamper-"));
  try {
    const tampered = Buffer.from(wasmBytes);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    const tamperedPath = join(tamperDir, "noise.wasm");
    await writeFile(tamperedPath, tampered);
    let tamperError = null;
    try {
      await loadNoiseNode(tamperedPath);
    } catch (error) {
      tamperError = error;
    }
    assert(tamperError !== null, "篡改一字节的 wasm 副本被拒绝加载（fail closed）");
    assert(
      tamperError instanceof WasmIntegrityError && tamperError.code === "wasm_integrity_failed",
      "篡改拒绝是结构化错误（code=wasm_integrity_failed）",
      tamperError?.name,
    );
    assert(
      /完整性校验失败/.test(tamperError.message) && tamperError.actualSha256 !== NOISE_WASM_SHA256,
      "错误信息写明 wasm 完整性校验失败并带实测哈希",
      tamperError?.message,
    );
  } finally {
    await rm(tamperDir, { recursive: true, force: true });
  }
  const probe = noise.generateKeyPair();
  assert(probe.privateKey.length === 32 && probe.publicKey.length === 32, "密钥对 32+32 字节");

  const roomId = "room-1234";
  const channel = "00112233445566778899aabbccddeeff";
  const inviteToken = "invite_token_for_selftest_only_0001";
  const psk = await derivePairPsk(inviteToken, roomId);
  assert(psk.length === 32, "derivePairPsk 得到 32 字节 psk");
  assert(sameBytes(psk, await derivePairPsk(inviteToken, roomId)), "psk 可复现");

  const clientKeys = noise.generateKeyPair();
  const bridgeKeys = noise.generateKeyPair();
  const prologue = pairPrologue(roomId, channel);
  const initiator = new NoiseHandshake(noise, { pattern: "xxpsk3", initiator: true, localKeys: clientKeys, psk, prologue });
  const responder = new NoiseHandshake(noise, { pattern: "xxpsk3", initiator: false, localKeys: bridgeKeys, psk, prologue });
  const steps = pumpHandshake(initiator, responder);
  console.log(`  握手消息：${steps.join("，")}`);
  assert(initiator.finished && responder.finished, "xxpsk3（配对）双方 finished");
  assert(sameBytes(initiator.remoteStatic, bridgeKeys.publicKey), "initiator 看到的 remoteStatic = Bridge 公钥");
  assert(sameBytes(responder.remoteStatic, clientKeys.publicKey), "responder 看到的 remoteStatic = 客户端公钥");
  const code = await confirmCode(clientKeys.publicKey, initiator.remoteStatic);
  assert(/^[0-9]{6}$/.test(code), "确认码 6 位数字", code);
  assert(code === (await confirmCode(clientKeys.publicKey, bridgeKeys.publicKey)), "两端确认码一致");

  const deviceId = "11111111-2222-3333-4444-555555555555";
  const deviceKeys = noise.generateKeyPair();
  const ikPro = reconnectPrologue(roomId, "ffeeddccbbaa99887766554433221100", deviceId);
  const ikA = new NoiseHandshake(noise, { pattern: "ik", initiator: true, localKeys: deviceKeys, remotePublicKey: bridgeKeys.publicKey, prologue: ikPro });
  const ikB = new NoiseHandshake(noise, { pattern: "ik", initiator: false, localKeys: bridgeKeys, prologue: ikPro });
  pumpHandshake(ikA, ikB);
  assert(ikA.finished && ikB.finished, "ik（重连）双方 finished");
  assert(sameBytes(ikB.remoteStatic, deviceKeys.publicKey), "Bridge 侧拿到的设备公钥与本地一致");

  const a = ikA.intoChannel();
  const b = ikB.intoChannel();
  const small = { v: 1, kind: "request", id: "req-1", method: "host.ping" };
  const framesSmall = a.seal(small);
  assert(framesSmall.length === 1, "小消息单帧");
  assertEqual(openAll(framesSmall, b), small, "小消息逐字节往返");

  const bigText = "A".repeat(40_000);
  const big = { v: 1, kind: "response", id: "req-big", ok: true, result: { text: bigText } };
  const framesBig = a.seal(big);
  assert(framesBig.length > 1, `>32KiB 消息被分片（${framesBig.length} 帧）`);
  assert(framesBig.every((frame) => frame.length <= 64 * 1024), "每帧都在中继 64KiB 上限内", framesBig.map((f) => f.length));
  assertEqual(openAll(framesBig, b), big, "分片消息重组后逐字节一致");
  assert(MAX_FRAME_BYTES === 32 * 1024, "MAX_FRAME_BYTES = 32KiB（分片阈值）");

  a.close();
  b.close();
  return noise;
}

// ---------------------------------------------------------------- 2. 协议编解码

function testProtocol() {
  section("协议编解码");
  assert(PROTOCOL_VERSION === 1, "PROTOCOL_VERSION = 1");

  const request = {
    v: 1,
    kind: "request",
    id: "req-1",
    method: "message.send",
    params: { sessionId: "s1", text: "hi" },
    operationId: "op-123",
  };
  assertEqual(parseWireMessage(request), request, "request（含 operationId）解析后原样返回");
  assertEqual(
    parseWireMessage({ v: 1, kind: "response", id: "req-1", ok: true, result: { accepted: true } }),
    { v: 1, kind: "response", id: "req-1", ok: true, result: { accepted: true } },
    "response 解析",
  );
  assertEqual(parseWireMessage({ v: 1, kind: "event", event: "host.status", data: {} }).event, "host.status", "event 解析");
  assert(parseWireMessage({ ...request, method: "not.a.method" }) === null, "未知方法被拒绝");
  assert(parseWireMessage({ ...request, v: 2 }) === null, "错误版本被拒绝");
  assert(parseWireMessage({ ...request, kind: "chunk", seq: 0, total: 1, data: "x", messageId: "m" }) !== null, "chunk 解析");

  const roomId = "room-1234";
  const channel = "00112233445566778899aabbccddeeff";
  const inviteHello = helloMessage(roomId, channel, { kind: "invite", tokenHash: "0".repeat(64) });
  assert(parseRelayHello(inviteHello) !== null, "邀请 hello 通过 parseRelayHello");
  assert(inviteHello.role === "browser" && inviteHello.v === 2, "hello 是 browser 角色、中继协议 v2");
  const deviceHello = helloMessage(roomId, channel, { kind: "device", deviceId: "11111111-2222-3333-4444-555555555555", token: "device_token_for_selftest_only_01" });
  assert(parseRelayHello(deviceHello) !== null, "设备 hello 通过 parseRelayHello");
  assert(parseRelayHello({ ...inviteHello, channel: "short" }) === null, "短 channel 的 hello 被拒绝");

  assert(
    relaySocketUrl("https://relay.example.com", "room-1234") === "wss://relay.example.com/v1/ws?room=room-1234",
    "https 中继 → wss + 固定路径",
    relaySocketUrl("https://relay.example.com", "room-1234"),
  );
  assert(
    relaySocketUrl(mergeProfile(DEFAULT_PROFILE, null).profile.relayUrl, "room-1234") ===
      "wss://agent-bridge.craftstead.app/v1/ws?room=room-1234",
    "默认 profile 中继地址可用（生产中继）",
  );

  const token = "invite_token_for_selftest_only_0001";
  const link = `https://example.invalid/#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-1234&invite=${token}`;
  const parsed = parsePairingLink(link);
  assert(parsed !== null, "邀请链接解析成功");
  assert(parsed.relayUrl === "https://relay.example.com", "relay 取 origin", parsed.relayUrl);
  assert(parsed.roomId === "room-1234" && parsed.inviteToken === token, "room/invite 解析正确");
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("http://127.0.0.1:8787")}&room=room-1234&invite=${token}`)?.relayUrl ===
      "http://127.0.0.1:8787",
    "回环地址允许 http",
  );
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("http://relay.example.com")}&room=room-1234&invite=${token}`) === null,
    "非回环 http 中继被拒绝",
  );
  assert(credentialsFromFragment(`#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-12&invite=${token}`) === null, "room 太短被拒绝");
  assert(credentialsFromFragment(`#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-1234&invite=short`) === null, "invite 太短被拒绝");
  assert(parsePairingLink("https://example.invalid/#/settings") === null, "非配对 fragment 被拒绝");
  assert(parsePairingLink("https://example.invalid/") === null, "没有 fragment 被拒绝");
}

// ---------------------------------------------------------------- 3. profile

async function testProfile(home) {
  section("启动偏好 profile");
  const defaults = mergeProfile(DEFAULT_PROFILE, null);
  assert(defaults.warnings.length === 0, "空配置无 warning");
  assertEqual(defaults.profile, { ...DEFAULT_PROFILE, relayUrl: "https://agent-bridge.craftstead.app" }, "默认值与 DESIGN §8 一致（relay 归一化为生产中继 https）");
  assertEqual(
    [defaults.profile.model, defaults.profile.thinking, defaults.profile.subagentModel, defaults.profile.subagentThinking, defaults.profile.promptSuffix],
    ["", "", "", "", ""],
    "默认不设启动偏好（空串 = 不传给 bridge）",
  );

  const partial = mergeProfile(DEFAULT_PROFILE, { engine: "claude", model: "m/x", modeA: true });
  assertEqual(
    [partial.profile.engine, partial.profile.model, partial.profile.modeA, partial.profile.thinking],
    ["claude", "m/x", true, ""],
    "逐项覆盖，其余保持默认",
  );

  const cleared = mergeProfile(
    { ...DEFAULT_PROFILE, model: "m/x", thinking: "high", subagentModel: "m/y", subagentThinking: "low", promptSuffix: "后缀" },
    { model: "", thinking: "", subagentModel: "", subagentThinking: "", promptSuffix: "" },
  );
  assertEqual(
    [cleared.profile.model, cleared.profile.thinking, cleared.profile.subagentModel, cleared.profile.subagentThinking, cleared.profile.promptSuffix],
    ["", "", "", "", ""],
    "空串清空已有值（不等同于「没配」）",
  );
  assert(cleared.warnings.length === 0, "清空是合法操作，不留 warning", cleared.warnings);

  const bad = mergeProfile(DEFAULT_PROFILE, { engine: "gpt", thinking: 42, modeA: "yes", relayUrl: "ftp://x" });
  assertEqual([bad.profile.engine, bad.profile.thinking, bad.profile.modeA], ["pi", "", false], "非法值退回默认");
  assert(bad.warnings.length === 4, "非法值各留一条 warning", bad.warnings);

  const blankRequired = mergeProfile(DEFAULT_PROFILE, { engine: "  ", relayUrl: "" });
  assertEqual(
    [blankRequired.profile.engine, blankRequired.profile.relayUrl],
    ["pi", "https://agent-bridge.craftstead.app"],
    "engine / relayUrl 不接受空串（空串 != 不传）",
  );
  assert(blankRequired.warnings.length === 2, "engine / relayUrl 空串各留一条 warning", blankRequired.warnings);

  const relay = mergeProfile(DEFAULT_PROFILE, { relayUrl: "wss://relay.example.com" });
  assert(relay.profile.relayUrl === "https://relay.example.com", "wss 归一化为 https（避免 relaySocketUrl 降级成 ws）");

  // P-1：只允许 TLS（wss/https，任意主机）与回环明文（ws/http → 127.0.0.1 / ::1 / localhost）。
  assert(normalizeRelayUrl("wss://relay.example.com") === "https://relay.example.com", "wss:// 任意主机被接受（P-1）");
  assert(normalizeRelayUrl("ws://127.0.0.1:47826") === "http://127.0.0.1:47826", "ws://127.0.0.1 被接受（P-1）");
  assert(normalizeRelayUrl("ws://[::1]:47826") === "http://[::1]:47826", "ws://[::1] 被接受（P-1）");
  assert(normalizeRelayUrl("http://localhost:47826") === "http://localhost:47826", "http://localhost 被接受（回环，P-1）");
  assertThrows(() => normalizeRelayUrl("http://evil.example:8080"), "http://evil.example 被拒绝（P-1）", (error) => /已拒绝/.test(error.message));
  assertThrows(() => normalizeRelayUrl("ws://evil.example:8080"), "非回环 ws:// 被拒绝（P-1）", (error) => /已拒绝/.test(error.message));
  assertThrows(() => normalizeRelayUrl("ftp://relay.example.com"), "非 http(s)/ws(s) 协议被拒绝（P-1）", (error) => /只允许 wss/.test(error.message));
  // 真实中继（生产/preview）都是 wss，不能被误伤。
  assert(
    normalizeRelayUrl("wss://agent-bridge.craftstead.app") === "https://agent-bridge.craftstead.app" &&
      normalizeRelayUrl("wss://agent-bridge-preview.craftstead.app") === "https://agent-bridge-preview.craftstead.app",
    "生产/preview 两套真实 relayUrl（wss）照常通过",
  );

  // 落到 profile.json 的非法中继必须被拒绝并回落到默认 wss，不会被拿去连接。
  const rejected = mergeProfile(DEFAULT_PROFILE, { relayUrl: "http://evil.example:8080" });
  assert(
    rejected.profile.relayUrl === normalizeRelayUrl(DEFAULT_PROFILE.relayUrl) && rejected.warnings.some((line) => /relayUrl 已拒绝/.test(line)),
    "profile.json 里的 http://evil.example 被拒绝并回落默认中继（含明确 warning）",
    rejected.warnings,
  );
  const persistedBad = mergeProfile({ ...DEFAULT_PROFILE, relayUrl: "https://agent-bridge.craftstead.app" }, { relayUrl: "ws://evil.example" });
  assert(persistedBad.profile.relayUrl === "https://agent-bridge.craftstead.app", "已归一化的 base 不被非法值覆盖（P-1）");

  const first = await loadProfile();
  assert(first.created === true, "首次 loadProfile 写出默认 profile.json");
  const file = await readJson(statePaths().profile);
  assert(
    file && file.engine === "pi" && file.model === "" && file.promptSuffix === "" && file.relayUrl === "https://agent-bridge.craftstead.app",
    "profile.json 内容正确（空串偏好落盘为空串、relay 已归一化）",
    file,
  );
  const mode = (await stat(statePaths().profile)).mode & 0o777;
  assert(mode === 0o600, "profile.json 权限 0600（实测）", mode.toString(8));
  const second = await loadProfile();
  assert(second.created === false && second.profile.relayUrl === "https://agent-bridge.craftstead.app", "第二次读取不重写、值一致");
  void home;
}

// ---------------------------------------------------------------- 3b. 状态目录解析

function testStateDirResolution() {
  section("状态目录解析（每用户配置目录，不写进仓库）");
  const saved = {
    mcpHome: process.env.AGENT_BRIDGE_MCP_HOME,
    xdg: process.env.XDG_CONFIG_HOME,
    bridgeHome: process.env.AGENT_BRIDGE_HOME,
    listenerDir: process.env.AB_LISTENER_STATE_DIR,
  };
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const xdgRoot = join(tmpdir(), "agent-bridge-selftest-xdg");
  const homeRoot = join(tmpdir(), "agent-bridge-selftest-home");
  try {
    delete process.env.AGENT_BRIDGE_MCP_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AB_LISTENER_STATE_DIR;
    assertEqual(stateDir(), join(homedir(), ".agent-bridge", "mcp"), "默认 ~/.agent-bridge/mcp（不再写进项目目录）");
    assertEqual(listenerStateDir(), join(stateDir(), "listener"), "listener 默认是主状态目录下的一级子目录");

    process.env.XDG_CONFIG_HOME = xdgRoot;
    assertEqual(stateDir(), join(xdgRoot, "agent-bridge", "mcp"), "XDG_CONFIG_HOME 优先于 home");

    process.env.AGENT_BRIDGE_MCP_HOME = homeRoot;
    assertEqual(stateDir(), homeRoot, "AGENT_BRIDGE_MCP_HOME 优先于 XDG_CONFIG_HOME");

    process.env.AGENT_BRIDGE_MCP_HOME = "relative-state";
    assertEqual(stateDir(), join(xdgRoot, "agent-bridge", "mcp"), "相对路径的覆盖被忽略（否则会写进当前目录）");

    delete process.env.AGENT_BRIDGE_MCP_HOME;
    process.env.AGENT_BRIDGE_HOME = join(tmpdir(), "agent-bridge-selftest-bridge-home");
    assert(stateDir() !== process.env.AGENT_BRIDGE_HOME, "不把 AGENT_BRIDGE_HOME 当 MCP 状态目录（那是 bridge 自己的）");
    assertEqual(statePaths().identity, join(stateDir(), "identity.json"), "身份文件固定在状态目录下");

    process.env.AB_LISTENER_STATE_DIR = join(tmpdir(), "agent-bridge-selftest-listener-dir");
    assertEqual(listenerStateDir(), process.env.AB_LISTENER_STATE_DIR, "AB_LISTENER_STATE_DIR 仍可覆盖 listener 目录");

    process.env.AB_LISTENER_STATE_DIR = "relative-listener";
    assertEqual(listenerStateDir(), join(stateDir(), "listener"), "相对路径的 listener 覆盖同样被忽略（不能落到 CWD）");
  } finally {
    restore("AGENT_BRIDGE_MCP_HOME", saved.mcpHome);
    restore("XDG_CONFIG_HOME", saved.xdg);
    restore("AGENT_BRIDGE_HOME", saved.bridgeHome);
    restore("AB_LISTENER_STATE_DIR", saved.listenerDir);
  }
}

// ---------------------------------------------------------------- 4. 登记册

async function testRegistry() {
  section("登记册 CRUD 与审计");
  const key = sessionKey({ engine: "pi", cwd: "/work/a", purpose: "  Main Task " });
  assert(key === "pi|/work/a|main task", "sessionKey 归一化（engine|cwd|purpose）", key);

  let { registry } = await loadRegistry();
  assert(registry.sessions.length === 0 && registry.audit.length === 0, "空登记册");

  const entry = upsertSession(registry, { key, engine: "pi", cwd: "/work/a", purpose: "Main Task", sessionId: "s1", title: "MCP · t" });
  assert(findByKey(registry, key)?.sessionId === "s1", "upsert 后按 key 命中");
  assert(findBySessionId(registry, "s1")?.title === "MCP · t", "按 sessionId 命中");
  upsertSession(registry, { key, engine: "pi", cwd: "/work/a", purpose: "Main Task", sessionId: "s1", title: "MCP · t2" });
  assert(registry.sessions.length === 1, "同 key/sessionId 的 upsert 不产生重复条目");
  assert(findBySessionId(registry, "s1").title === "MCP · t2", "upsert 更新 title");

  const createdAt = entry.createdAt;
  await sleep(5);
  touchSession(registry, "s1");
  assert(findBySessionId(registry, "s1").lastUsedAt > createdAt, "touch 刷新 lastUsedAt");

  setInFlight(registry, "s1", { operationId: "op-1", at: new Date().toISOString() });
  assert(findBySessionId(registry, "s1").inFlight?.operationId === "op-1", "记录未完成回合");
  setArchived(registry, "s1", true);
  assert(findBySessionId(registry, "s1").archived === true && findBySessionId(registry, "s1").inFlight === null, "归档时清掉 inFlight");

  const digest = messageDigest("hello");
  assert(/^[0-9a-f]{64}$/.test(digest), "消息审计是 sha256 十六进制", digest);
  assert(messageDigest("hello") === digest && messageDigest("hello!") !== digest, "摘要确定性且区分内容");

  for (let i = 0; i < 600; i += 1) appendAudit(registry, { action: "session_send", sessionId: "s1", messageSha256: messageDigest(`m${i}`) });
  const saved = await saveRegistry(registry);
  assert(saved.audit.length === 500, "审计只保留最近 500 条", saved.audit.length);
  assert(saved.audit.at(-1).messageSha256 === messageDigest("m599"), "审计是追加顺序");

  const reloaded = (await loadRegistry()).registry;
  assert(reloaded.sessions.length === 1 && reloaded.sessions[0].sessionId === "s1", "save/load 往返保留会话");
  assert(reloaded.audit.length === 500, "save/load 往返保留审计");
  assert(!("message" in reloaded.audit[0]) && !("text" in reloaded.audit[0]), "审计不存消息全文");

  // 发送幂等：只有「同一会话 + 同一 operationId + accepted=true」的审计才算已投递。
  const idem = { version: 1, updatedAt: new Date().toISOString(), sessions: [], audit: [] };
  appendAudit(idem, { action: "session_send", sessionId: "s1", operationId: "op-a", messageSha256: messageDigest("x"), accepted: true });
  appendAudit(idem, { action: "session_send", sessionId: "s1", operationId: "op-b", messageSha256: messageDigest("y"), accepted: false });
  assert(findAcceptedSend(idem, "s1", "op-a")?.messageSha256 === messageDigest("x"), "同一 operationId 的已投递发送能被查到（重试不再重发）");
  assert(findAcceptedSend(idem, "s1", "op-b") === null, "accepted=false 的发送不算已投递（允许重试）");
  assert(findAcceptedSend(idem, "s2", "op-a") === null, "幂等键按会话隔离");
  assert(findAcceptedSend(idem, "s1", "op-c") === null, "未知 operationId 不算已投递");

  const registryMode = (await stat(statePaths().registry)).mode & 0o777;
  assert(registryMode === 0o600, "registry.json 权限 0600（实测）", registryMode.toString(8));
}

// ---------------------------------------------------------------- 4b. 登记册并发

const CONC_WORKERS = 6;
const CONC_ROUNDS = 3;

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 新模式的 worker：每轮一个独立的锁内事务（真实并发，不做人为串行）。 */
const LOCKED_WORKER_SOURCE = [
  'const lib = await import(process.env.REGISTRY_LIB_URL);',
  'const idx = Number(process.env.WORKER_INDEX);',
  `const rounds = ${CONC_ROUNDS};`,
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  'for (let round = 0; round < rounds; round += 1) {',
  '  await lib.updateRegistry((registry) => {',
  '    const purpose = "conc-" + idx + "-" + round;',
  '    const sessionId = "sess-" + idx + "-" + round;',
  '    lib.upsertSession(registry, { engine: "pi", cwd: "/work/selftest", purpose, sessionId, title: purpose });',
  '    lib.appendAudit(registry, { action: "session_open", sessionId, worker: idx, round });',
  '  });',
  '  await sleep(Math.random() * 12);',
  '}',
].join("\n");

/**
 * 旧模式的 worker（对照）：无锁 load → 栅栏（所有进程都拿到同一份快照）→ 内存改 → 整文件写回。
 * 栅栏让「lost update」确定性发生，而不是靠运气。
 */
const LEGACY_WORKER_SOURCE = [
  'const fs = await import("node:fs/promises");',
  'const lib = await import(process.env.REGISTRY_LIB_URL);',
  'const idx = Number(process.env.WORKER_INDEX);',
  'const total = Number(process.env.WORKER_TOTAL);',
  'const dir = process.env.READY_DIR;',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  'const countMarkers = async (prefix) => (await fs.readdir(dir)).filter((name) => name.startsWith(prefix)).length;',
  'await fs.writeFile(dir + "/ready-" + idx, "1");',
  'while ((await countMarkers("ready-")) < total) await sleep(5);',
  'const { registry } = await lib.loadRegistry();',
  'await fs.writeFile(dir + "/loaded-" + idx, "1");',
  'while ((await countMarkers("loaded-")) < total) await sleep(5);',
  'await sleep(40);',
  'lib.upsertSession(registry, { engine: "pi", cwd: "/work/legacy", purpose: "lost-" + idx, sessionId: "legacy-" + idx });',
  'lib.appendAudit(registry, { action: "session_open", sessionId: "legacy-" + idx });',
  'await lib.saveRegistry(registry);',
].join("\n");

async function testRegistryConcurrency() {
  section("登记册并发（跨进程锁 / lost-update 回归）");

  // (1) 新模式：N 个进程并行做锁内事务，条目与审计必须一条不丢。
  await withTempHome(async (home) => {
    const runs = [];
    for (let i = 0; i < CONC_WORKERS; i += 1) {
      runs.push(
        runNode(["--input-type=module", "-e", LOCKED_WORKER_SOURCE], {
          env: { AGENT_BRIDGE_MCP_HOME: home, WORKER_INDEX: String(i), REGISTRY_LIB_URL },
          timeoutMs: 120_000,
        }),
      );
    }
    const exits = await Promise.all(runs);
    assert(
      exits.every((item) => item.code === 0),
      "并发 worker 全部正常退出",
      exits.map((item) => ({ code: item.code, stderr: item.stderr.slice(-300) })),
    );
    const expected = CONC_WORKERS * CONC_ROUNDS;
    const { registry } = await loadRegistry();
    assert(
      registry.sessions.length === expected,
      `锁下 ${CONC_WORKERS} 进程 × ${CONC_ROUNDS} 轮 upsert 一条不丢（${expected} 条）`,
      registry.sessions.length,
    );
    const ids = new Set(registry.sessions.map((entry) => entry.sessionId));
    const missing = [];
    for (let i = 0; i < CONC_WORKERS; i += 1) {
      for (let round = 0; round < CONC_ROUNDS; round += 1) {
        if (!ids.has(`sess-${i}-${round}`)) missing.push(`sess-${i}-${round}`);
      }
    }
    assert(missing.length === 0, "并发 upsert 的 sessionId 全部在内", missing);
    const audits = registry.audit.filter((item) => item.action === "session_open");
    assert(audits.length === expected, "并发 appendAudit 一条不丢", audits.length);
    const marks = new Set(audits.map((item) => `${item.worker}-${item.round}`));
    assert(marks.size === expected, "审计覆盖每个 worker 的每一轮", marks.size);
    assert(!(await fileExists(join(home, "registry.json.lock"))), "并发结束后没有残留锁文件");
  });

  // (2) 旧模式对照：同样的并发下确实会丢条目与审计（证明用例真的能抓到回归）。
  await withTempHome(async (home) => {
    const barrierDir = join(home, "barrier");
    await mkdir(barrierDir, { recursive: true, mode: 0o700 });
    const runs = [];
    for (let i = 0; i < CONC_WORKERS; i += 1) {
      runs.push(
        runNode(["--input-type=module", "-e", LEGACY_WORKER_SOURCE], {
          env: {
            AGENT_BRIDGE_MCP_HOME: home,
            WORKER_INDEX: String(i),
            WORKER_TOTAL: String(CONC_WORKERS),
            READY_DIR: barrierDir,
            REGISTRY_LIB_URL,
          },
          timeoutMs: 120_000,
        }),
      );
    }
    const exits = await Promise.all(runs);
    assert(
      exits.every((item) => item.code === 0),
      "旧模式对照 worker 全部正常退出",
      exits.map((item) => ({ code: item.code, stderr: item.stderr.slice(-300) })),
    );
    const { registry } = await loadRegistry();
    assert(
      registry.sessions.length > 0 && registry.sessions.length < CONC_WORKERS,
      `对照：无锁模式确实丢更新（${registry.sessions.length}/${CONC_WORKERS} 存活）`,
      registry.sessions.length,
    );
    assert(registry.audit.length < CONC_WORKERS, "对照：无锁模式的审计同样丢失", registry.audit.length);
  });

  // (3) 陈旧锁：死进程立刻回收、活进程的锁绝不抢、超龄锁可回收、出错也释放。
  await withTempHome(async (home) => {
    const lockPath = join(home, "registry.json.lock");
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = deadChild.pid;
    await new Promise((resolve) => deadChild.on("exit", resolve));

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: deadPid, host: hostname(), at: new Date(0).toISOString(), token: "stale-dead-pid" })}\n`,
      { mode: 0o600 },
    );
    const beganReclaim = Date.now();
    await updateRegistry((registry) => {
      appendAudit(registry, { action: "session_open", sessionId: "stale-reclaim" });
    });
    assert(Date.now() - beganReclaim < 5000, "死进程留下的锁被立即回收（不等超时）", Date.now() - beganReclaim);
    assert(!(await fileExists(lockPath)), "回收陈旧锁的进程事务结束后已释放锁");
    const reclaimed = (await loadRegistry()).registry;
    assert(
      reclaimed.audit.some((item) => item.sessionId === "stale-reclaim"),
      "回收陈旧锁后事务正常落账",
      reclaimed.audit.length,
    );

    // 活进程（本进程 pid）+ 新鲜 mtime：不得抢，按超时报错。
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: "live-holder" })}\n`,
      { mode: 0o600 },
    );
    let timeoutError = null;
    const beganLive = Date.now();
    try {
      await updateRegistry(() => {}, { timeoutMs: 300, staleMs: 60_000 });
    } catch (error) {
      timeoutError = error;
    }
    assert(timeoutError?.code === "lock_timeout", "活进程持有的锁不被抢，超时报 lock_timeout", timeoutError?.code ?? timeoutError?.message);
    assert(Date.now() - beganLive >= 250, "超时前一直在退避重试", Date.now() - beganLive);
    assert(await fileExists(lockPath), "放弃抢锁时不删除别人的锁文件");

    // 锁龄超过 staleMs：即使 pid 活着也视为陈旧（持有者卡死的情况）。
    await utimes(lockPath, new Date(0), new Date(0));
    const beganAge = Date.now();
    await updateRegistry(
      (registry) => {
        appendAudit(registry, { action: "session_open", sessionId: "age-reclaim" });
      },
      { staleMs: 50, timeoutMs: 5000 },
    );
    assert(Date.now() - beganAge < 5000, "超龄锁被回收（staleMs 生效）", Date.now() - beganAge);

    // mutator 抛错：异常照常上抛，锁照样释放（finally）。
    let mutatorError = null;
    try {
      await updateRegistry((registry) => {
        appendAudit(registry, { action: "session_open", sessionId: "never-saved" });
        throw new Error("mutator boom");
      });
    } catch (error) {
      mutatorError = error;
    }
    assert(mutatorError?.message === "mutator boom", "mutator 抛错向上抛（不吞）", mutatorError?.message);
    assert(!(await fileExists(lockPath)), "mutator 抛错也释放锁（finally）");
    assert(
      (await loadRegistry()).registry.audit.every((item) => item.sessionId !== "never-saved"),
      "抛错的事务不落盘",
    );
  });
}

/** 子进程：真抢到登记册锁 → 取一份旧快照 →「被冻结」（持锁不动、锁龄一路涨）→ 收到 resume 后按旧快照整文件写回再释放。 */
const FROZEN_HOLDER_SOURCE = [
  'const fs = await import("node:fs/promises");',
  'const lock = await import(process.env.LOCK_LIB_URL);',
  'const reg = await import(process.env.REGISTRY_LIB_URL);',
  'const dir = process.env.MARKER_DIR;',
  'const lockPath = process.env.AGENT_BRIDGE_MCP_HOME + "/registry.json.lock";',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  'const exists = async (path) => { try { await fs.stat(path); return true; } catch { return false; } };',
  'const release = await lock.acquireFileLock(lockPath, { staleMs: Number(process.env.HOLDER_STALE_MS), timeoutMs: 20000 });',
  'const mine = JSON.parse(await fs.readFile(lockPath, "utf8")).token;',
  'const { registry } = await reg.loadRegistry();',            // 冻结前的旧快照
  'await fs.writeFile(dir + "/held", "1");',
  'while (!(await exists(dir + "/resume"))) await sleep(5);',  // 「被冻结」：持锁不动，锁龄持续累积
  'reg.appendAudit(registry, { action: "session_open", sessionId: "frozen-holder" });',
  'await reg.saveRegistry(registry);',                          // 醒来后照旧快照整文件写回（lost-update 的载体）
  'const current = await fs.readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);',
  'await fs.writeFile(dir + "/result.json", JSON.stringify({ stillMine: Boolean(current && current.token === mine) }));',
  'await release();',
  'process.exit(0);',
].join("\n");

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fileExists(path)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
}

/** 起一个「冻结持有者」子进程（staleMs 注入成小值，锁龄很快超阈值）。 */
async function startFrozenHolder(home, markerDir, staleMs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", FROZEN_HOLDER_SOURCE], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_BRIDGE_MCP_HOME: home,
      MARKER_DIR: markerDir,
      HOLDER_STALE_MS: String(staleMs),
      LOCK_LIB_URL,
      REGISTRY_LIB_URL,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exit = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return { child, exit, stderrText: () => stderr };
}

/**
 * 锁的陈旧策略（SECURITY-AUDIT-LOCKFIX §5-E2 / §8 M-1、§5-E6 / L-2）：
 *   默认口径、活锁二次确认（含旧口径对照）、不可解析锁的短确认通道。
 */
async function testLockStalePolicy() {
  section("锁的陈旧策略（活锁二次确认 / 崩溃残留短确认）");

  assert(LOCK_DEFAULTS.staleMs === 120_000, "活持有者默认 staleMs = 120s", LOCK_DEFAULTS.staleMs);
  assert(LOCK_DEFAULTS.confirmMs >= 300, "超龄活锁回收前至少二次确认 300ms", LOCK_DEFAULTS.confirmMs);
  assert(
    LOCK_DEFAULTS.unparsableConfirmMs === 250 && LOCK_DEFAULTS.unparsableMinAgeMs === 2_000,
    "不可解析锁 = 250ms 后复查 + mtime 年龄 >2s 才回收",
    { confirmMs: LOCK_DEFAULTS.unparsableConfirmMs, minAgeMs: LOCK_DEFAULTS.unparsableMinAgeMs },
  );

  // (a) 活着但被冻结的持有者：注入 staleMs=100ms 让锁龄很快超阈值；
  //     调用方进入二次确认窗口后持有者恢复活动 → 必须放弃回收，双方落账都不丢。
  await withTempHome(async (home) => {
    const markerDir = join(home, "markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const lockPath = join(home, "registry.json.lock");
    const holder = await startFrozenHolder(home, markerDir, 100);
    assert(
      await waitForFile(join(markerDir, "held"), 15_000),
      "冻结的持有者已拿到锁（锁龄开始累积）",
      holder.stderrText().slice(-300),
    );
    await sleep(250); // 锁龄明显超过注入的 staleMs=100ms
    assert(await fileExists(lockPath), "注入 staleMs=100ms 后，冻结持有者的锁仍未被回收");

    const began = Date.now();
    const probe = updateRegistry(
      (registry) => {
        appendAudit(registry, { action: "session_open", sessionId: "probe" });
      },
      { staleMs: 100, timeoutMs: 20_000 },
    );
    await sleep(120); // 调用方此刻在二次确认窗口里
    await writeFile(join(markerDir, "resume"), "1"); // 持有者恢复活动：按旧快照写回 + 释放锁
    await probe;
    const elapsed = Date.now() - began;

    assert((await holder.exit) === 0, "冻结的持有者正常退出", holder.stderrText().slice(-300));
    const result = JSON.parse(await readFile(join(markerDir, "result.json"), "utf8"));
    assert(
      result.stillMine === true,
      "确认期间持有者恢复活动 → 回收被放弃（它释放时锁仍是自己的）",
      result,
    );
    assert(elapsed >= 300, "调用方等满了二次确认窗口才继续（不是到点即抢）", elapsed);
    const { registry } = await loadRegistry();
    const seen = registry.audit.map((item) => item.sessionId);
    assert(
      seen.includes("frozen-holder") && seen.includes("probe"),
      "恢复活动后两边落账都在（没有 lost update）",
      seen.slice(-3),
    );
    assert(!(await fileExists(lockPath)), "事务结束后没有残留锁文件");
  });

  // (a) 对照：同一套装置下，旧口径（活 pid + 锁龄超阈值就立刻回收）确实丢更新 —— 证明用例能抓到回归。
  await withTempHome(async (home) => {
    const markerDir = join(home, "markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const lockPath = join(home, "registry.json.lock");
    const holder = await startFrozenHolder(home, markerDir, 100);
    assert(
      await waitForFile(join(markerDir, "held"), 15_000),
      "对照：冻结的持有者已拿到锁",
      holder.stderrText().slice(-300),
    );
    await sleep(250);
    // 本文件历史版本（lock.mjs 修复前）的回收判定：活 pid + 锁龄 > staleMs → 直接 unlink，不二次确认。
    const staleStat = await stat(lockPath);
    const staleInfo = JSON.parse(await readFile(lockPath, "utf8"));
    assert(
      staleInfo.pid !== process.pid && Date.now() - staleStat.mtimeMs > 100,
      "对照：持有者仍然活着、锁龄已超 staleMs",
      { pid: staleInfo.pid, ageMs: Date.now() - staleStat.mtimeMs },
    );
    if ((await stat(lockPath)).ino === staleStat.ino) await rm(lockPath);
    await updateRegistry((registry) => {
      appendAudit(registry, { action: "session_open", sessionId: "old-policy-probe" });
    });
    await writeFile(join(markerDir, "resume"), "1");
    assert((await holder.exit) === 0, "对照：冻结的持有者正常退出", holder.stderrText().slice(-300));
    const { registry } = await loadRegistry();
    const seen = registry.audit.map((item) => item.sessionId);
    assert(
      seen.includes("frozen-holder") && !seen.includes("old-policy-probe"),
      "对照：旧口径下被抢先的落账确实被覆盖（lost update 复现）",
      seen.slice(-3),
    );
  });

  // (b) 不可解析/空锁（崩在 open 与 write 之间）：短确认通道快速回收并正常落账。
  await withTempHome(async (home) => {
    const lockPath = join(home, "registry.json.lock");
    await writeFile(lockPath, "", { mode: 0o600 });
    const old = new Date(Date.now() - 3_000);
    await utimes(lockPath, old, old);
    const began = Date.now();
    await updateRegistry((registry) => {
      appendAudit(registry, { action: "session_open", sessionId: "unparsable-reclaim" });
    });
    const elapsed = Date.now() - began;
    assert(elapsed < 2_000, "空锁被快速回收（不会按 staleMs=120s 堵住全量调用）", elapsed);
    assert(elapsed >= 200, "回收前走完了 250ms 规范复查窗口", elapsed);
    assert(!(await fileExists(lockPath)), "回收后事务正常释放锁");
    const { registry } = await loadRegistry();
    assert(
      registry.audit.some((item) => item.sessionId === "unparsable-reclaim"),
      "回收不可解析锁后落账成功",
      registry.audit.length,
    );

    // 刚创建的空锁（可能正处在 create→write 的微秒窗口）：不得抢。
    await writeFile(lockPath, "", { mode: 0o600 });
    let freshError = null;
    try {
      await updateRegistry(() => {}, { timeoutMs: 300 });
    } catch (error) {
      freshError = error;
    }
    assert(freshError?.code === "lock_timeout", "刚创建的空锁不被抢（不打断 create→write 窗口）", freshError?.code ?? freshError?.message);
    assert(await fileExists(lockPath), "放弃抢锁时保留别人的锁文件");
  });
}

/**
 * 登记册副本兼容性：拿一份「旧版写的」登记册文本（优先本机真实登记册的只读拷贝）放到临时状态目录里，
 * 验证原子写之后能被完整读回、只追加审计、不留临时文件与锁。绝不写回真文件。
 */
async function testRegistryCopyCompat() {
  section("登记册副本兼容性（只读拷贝 / 原子写 / 审计只追加）");
  const sourcePath = statePaths().registry;
  let text = null;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let origin = "本机真实登记册（只读拷贝）";
  if (text === null) {
    // 没有可读真实登记册：合成一份同结构的旧版文件，断言完全相同。
    const stamp = new Date(0).toISOString();
    text = `${JSON.stringify(
      {
        version: 1,
        updatedAt: stamp,
        sessions: [0, 1, 2].map((i) => ({
          key: `pi|/work/copy|copy-${i}`,
          engine: "pi",
          cwd: "/work/copy",
          purpose: `copy-${i}`,
          sessionId: `copy-sess-${i}`,
          title: `copy ${i}`,
          createdAt: stamp,
          lastUsedAt: stamp,
          archived: i === 2,
          inFlight: null,
        })),
        audit: [0, 1, 2].map((i) => ({ at: stamp, action: "session_open", sessionId: `copy-sess-${i}` })),
      },
      null,
      2,
    )}\n`;
    origin = "合成副本（本机没有可读登记册）";
  }
  const raw = JSON.parse(text);
  await withTempHome(async (home) => {
    await writeFile(join(home, "registry.json"), text, { mode: 0o600 });
    const { registry } = await readRegistry();
    assert(
      registry.sessions.length === raw.sessions.length,
      `${origin}原样读入 ${raw.sessions.length} 条会话`,
      registry.sessions.length,
    );
    assert(
      registry.audit.length === raw.audit.length,
      `${origin}原样读入 ${raw.audit.length} 条审计`,
      registry.audit.length,
    );
    const before = new Set(raw.sessions.map((entry) => entry.sessionId));
    const { result: after } = await updateRegistry((current) => {
      const target = current.sessions.find((entry) => !entry.archived) ?? current.sessions[0] ?? null;
      if (target) touchSession(current, target.sessionId);
      appendAudit(current, { action: "session_open", sessionId: target?.sessionId ?? "none", purpose: "lockfix-selftest" });
      return current.sessions.map((entry) => entry.sessionId);
    });
    assert(after.length === raw.sessions.length, "事务改写后会话数不变", after.length);
    assert(after.every((sessionId) => before.has(sessionId)), "事务改写后原有会话一条不少");
    const reloaded = (await readRegistry()).registry;
    assert(reloaded.sessions.length === raw.sessions.length, "落盘后重新读回会话数一致", reloaded.sessions.length);
    assert(reloaded.audit.length === raw.audit.length + 1, "审计只追加（+1），历史一条不丢", reloaded.audit.length);
    const leftovers = (await readdir(home)).filter((name) => name.includes(".tmp-"));
    assert(leftovers.length === 0, "原子写不留临时文件", leftovers);
    assert(!(await fileExists(join(home, "registry.json.lock"))), "事务结束后锁文件已删除");
  });
}

// ---------------------------------------------------------------- 5. 消息视图/提问

function testMessages() {
  section("消息视图与「pi 在提问」识别");
  const longText = "x".repeat(50_000);
  const record = {
    messageId: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 1000,
    blocks: [{ type: "text", text: "第一段" }, { type: "tool", text: "ls -la", summary: "列出目录" }, { type: "text", text: longText }],
  };
  const text = messageText(record);
  assert(text.startsWith("第一段\nls -la"), "messageText 按 block 顺序拼接");
  assert(text.endsWith(longText) && text.length > 50_000, "长消息不被截断（逐字原则）", text.length);
  assertEqual(messageView(record).text, text, "messageView 保留全文");
  assert(messageView(record).blocks[1].summary === "列出目录", "工具块保留 summary");

  const unordered = [
    { messageId: "b", createdAt: 2, blocks: [] },
    { messageId: "a", createdAt: 1, blocks: [] },
    { messageId: "c", createdAt: 3, blocks: [] },
  ];
  assertEqual(sortMessages(unordered).map((m) => m.messageId), ["a", "b", "c"], "消息按 createdAt 排序");

  assert(looksLikeQuestion("需要我现在停掉它吗？"), "中文提问被识别");
  assert(looksLikeQuestion("Would you like me to continue?"), "英文提问被识别");
  assert(!looksLikeQuestion("测试已通过，改动已提交。"), "陈述句不被误判");
  assert(!looksLikeQuestion(""), "空消息不算提问");

  const question = { messageId: "q", sessionId: "s1", role: "assistant", createdAt: 10, blocks: [{ type: "text", text: "要继续吗？" }] };
  const detected = detectNeedsUser([question], {});
  assert(detected?.messageId === "q" && detected.reason === "question_text", "回合结束后识别 pi 的提问");
  assert(detected.text === "要继续吗？", "needsUser 带原文");

  const withDecision = detectNeedsUser([{ ...question, blocks: [{ type: "text", text: "选一个" }] }], { needsDecision: true });
  assert(withDecision?.reason === "bridge_needs_decision", "bridge needsDecision 优先");

  const structured = detectNeedsUser(
    [{ messageId: "s", sessionId: "s1", role: "assistant", createdAt: 11, blocks: [{ type: "ask", text: "选择分支" }] }],
    {},
  );
  assert(structured?.reason === "structured_ask", "结构化 ask 块被识别");

  assert(detectNeedsUser([{ messageId: "u", sessionId: "s1", role: "user", createdAt: 12, blocks: [{ type: "text", text: "问题？" }] }], {}) === null, "最后一条是用户消息时不标 needsUser");
  assert(detectNeedsUser([], {}) === null, "空消息列表返回 null");

  // 回合还在跑（busy=true）：只有 bridge 的 needsDecision / 结构化 ask 能标 needsUser，问号启发式不跑。
  const halfTurn = [{ messageId: "h", sessionId: "s1", role: "assistant", createdAt: 13, blocks: [{ type: "text", text: "要我继续吗？" }] }];
  assert(detectNeedsUser(halfTurn, {}, { allowTextHeuristic: false }) === null, "busy 时半截输出里的问号不被当成提问");
  assert(
    detectNeedsUser(halfTurn, { needsDecision: true }, { allowTextHeuristic: false })?.reason === "bridge_needs_decision",
    "busy 但 bridge 报 needsDecision 时仍标 needsUser（pi 结构化提问实际形态）",
  );
  const pendingAsk = [
    { messageId: "p", sessionId: "s1", role: "assistant", createdAt: 14, blocks: [{ type: "next-step", text: "请选择", ask: "选择", pending: true }] },
  ];
  assert(
    detectNeedsUser(pendingAsk, {}, { allowTextHeuristic: false })?.reason === "structured_ask",
    "busy 时结构化 next-step pending 也标 needsUser",
  );

  // bridge 的 message.list 把长块截到 4000 字（block.truncated）：要能发现并用 message.text 补齐。
  const truncatedRecord = {
    messageId: "t1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 20,
    blocks: [{ type: "tool", text: "x".repeat(4000), truncated: true }],
  };
  assert(hasTruncatedBlock(truncatedRecord) === true, "识别被 bridge 截断的块");
  assert(hasTruncatedBlock(record) === false, "未截断的消息不需要补全文");
  const truncatedView = messageView(truncatedRecord);
  assert(truncatedView.blocks[0].truncated === true, "消息视图保留 truncated 标记（不静默截断）");
  const fullText = "y".repeat(50_000);
  const expanded = withFullText(truncatedView, { text: fullText, truncated: false, length: fullText.length });
  assert(expanded.text.length === 50_000 && expanded.textSource === "message.text", "message.text 全文覆盖列表里的截断文本");
  assert(expanded.bridgeFullTextTruncated === undefined && expanded.fullTextLength === 50_000, "全文补齐后带长度，未超上限时不标截断");
}

// ---------------------------------------------------------------- 6. 未配对行为

async function testUnpaired() {
  section("未配对行为（子进程，真实 stdio）");
  const home = await mkdtemp(join(tmpdir(), "agent-bridge-unpaired-"));
  try {
    const server = startServer({ AGENT_BRIDGE_MCP_HOME: home });
    try {
      const init = await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "selftest" } });
      assert(init.result?.serverInfo?.name === "agent-bridge-mcp", "initialize 返回 serverInfo", init.result?.serverInfo);
      assert(init.result?.capabilities?.tools !== undefined, "initialize 声明 tools 能力");
      server.notify("notifications/initialized");

      const listed = await server.request("tools/list", {});
      const names = (listed.result?.tools ?? []).map((tool) => tool.name);
      assertEqual(names, TOOL_DEFINITIONS.map((tool) => tool.name), "tools/list 顺序与定义一致");
      assert(names.length === 9, "tools/list 恰好 9 个工具", names.length);
      assertEqual([...new Set(ALLOWED_TOOLS)].sort(), [...names].sort(), "ALLOWED_TOOLS 与 server 工具面一致");

      const calls = {
        bridge_status: {},
        session_list: {},
        session_open: { cwd: "/tmp", purpose: "selftest" },
        session_read: { sessionId: "00000000-0000-0000-0000-000000000000" },
        session_wait: { sessionId: "00000000-0000-0000-0000-000000000000", timeoutMs: 1000 },
        session_send: { sessionId: "00000000-0000-0000-0000-000000000000", text: "hi" },
        session_stop: { sessionId: "00000000-0000-0000-0000-000000000000" },
        session_archive: { sessionId: "00000000-0000-0000-0000-000000000000" },
        session_adopt: { sessionId: "00000000-0000-0000-0000-000000000000", purpose: "selftest" },
      };
      for (const [name, args] of Object.entries(calls)) {
        const response = await server.request("tools/call", { name, arguments: args });
        const text = response.result?.content?.[0]?.text ?? "";
        assert(response.result?.isError === true, `${name} 未配对时返回 isError`);
        assert(text.includes("未配对") && text.includes("pair.mjs"), `${name} 错误里带未配对说明与配对指引`);
      }

      const unknown = await server.request("tools/call", { name: "shell.exec", arguments: { cmd: "id" } });
      assert(unknown.error?.code === -32602, "server 拒绝白名单外工具（-32602）", unknown.error);
      assert(!("result" in unknown), "被拒工具没有执行结果");

      assert((await readJson(join(home, "identity.json"))) === null, "未配对期间不生成假身份");
      assert(server.stdout.split("\n").filter(Boolean).every((line) => line.startsWith("{")), "server stdout 只有 JSON-RPC");
    } finally {
      await server.close();
    }

    const pairNoInvite = await runNode([PAIR_ENTRY]);
    assert(pairNoInvite.code === 2, "pair.mjs 无邀请时拒绝启动（exit 2）", pairNoInvite.code);
    assert(pairNoInvite.stderr.includes("没有邀请链接"), "pair.mjs 说明缺邀请", pairNoInvite.stderr.split("\n")[0]);
    assert((await readJson(join(home, "identity.json"))) === null, "拒绝配对的路径也不写身份");

    const pairBadInvite = await runNode([PAIR_ENTRY, "--invite-file", join(home, "missing.txt")]);
    assert(pairBadInvite.code === 2, "pair.mjs 邀请文件不存在时退出 2", pairBadInvite.code);

    const badLink = await runNode([
      PAIR_ENTRY,
      "--invite",
      "https://example.invalid/#/pair?relay=https%3A%2F%2Frelay.example.com&room=room-12&invite=short",
    ]);
    assert(badLink.code === 2, "pair.mjs 拒绝解析不了的邀请链接（exit 2）", badLink.code);
    assert(badLink.stderr.includes("无法解析"), "pair.mjs 说明链接格式问题", badLink.stderr.split("\n")[0]);

    const mismatched = await runNode(
      [
        PAIR_ENTRY,
        "--invite",
        `https://example.invalid/#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-1234&invite=${"a".repeat(24)}`,
      ],
      { env: { AGENT_BRIDGE_MCP_HOME: home } },
    );
    assert(mismatched.code === 2, "pair.mjs 拒绝与 profile.relayUrl 不一致的中继（自建 relay 要显式 --allow-relay）", mismatched.code);
    assert(mismatched.stderr.includes("不一致"), "pair.mjs 说明中继不一致", mismatched.stderr.split("\n")[0]);
    assert((await readJson(join(home, "identity.json"))) === null, "中继守卫拒绝后仍无身份文件");

    const blocked = await runNode([CLIENT_ENTRY, "call-tool", "--name", "shell.exec", "--arguments-file", "/dev/null"], {
      env: { AGENT_BRIDGE_MCP_HOME: home },
    });
    assert(blocked.code === 2, "client 本地拒绝 ALLOWED_TOOLS 外的工具（exit 2）", blocked.code);
    assert(blocked.stderr.includes("不在 ALLOWED_TOOLS"), "client 明确说明被拒原因", blocked.stderr.trim().split("\n")[0]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 7. 权限/不泄密

async function testSecretsAndPermissions() {
  section("状态文件权限与凭据不外泄");
  const home = await mkdtemp(join(tmpdir(), "agent-bridge-secrets-"));
  const previous = process.env.AGENT_BRIDGE_MCP_HOME;
  process.env.AGENT_BRIDGE_MCP_HOME = home;
  try {
    await ensureStateDir();
    const dirMode = (await stat(home)).mode & 0o777;
    assert(dirMode === 0o700, "状态目录权限 0700（实测）", dirMode.toString(8));

    const identityPath = statePaths().identity;
    await writeSecretJson(identityPath, {
      version: 1,
      deviceId: "abcdefgh-1111-2222-3333-444444444444",
      deviceName: "Muse (MCP)",
      publicKey: "00".repeat(32),
      privateKey: SENTINEL_SECRET,
      bridgePublicKey: "11".repeat(32),
      reconnectToken: SENTINEL_SECRET,
      roomId: "room-1234",
      relayUrl: "https://relay.example.com",
    });
    const identityMode = (await stat(identityPath)).mode & 0o777;
    assert(identityMode === 0o600, "identity.json 权限 0600（实测）", identityMode.toString(8));

    const identity = await loadIdentity();
    assert(identity.deviceId === "abcdefgh-1111-2222-3333-444444444444", "loadIdentity 读取并校验必填字段");
    registerSecret(identity.reconnectToken);

    // 日志脱敏：即使有人把秘密塞进日志，也不应出现在输出里。
    const captured = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      log(`debug token=${identity.reconnectToken} key=${identity.privateKey}`);
    } finally {
      process.stderr.write = originalWrite;
    }
    const joined = captured.join("");
    assert(joined.includes("[redacted]"), "日志把已知秘密替换为 [redacted]");
    assert(!joined.includes(identity.reconnectToken), "日志里不出现重连令牌明文");

    // 静态检查：MCP 关键路径不得用 console.log（state.mjs 的确认门提示只给 pair.mjs 用）。
    const libFiles = (await readdir(join(HERE, "lib"))).filter((name) => name.endsWith(".mjs") && name !== "state.mjs");
    for (const name of libFiles) {
      const source = await readFile(join(HERE, "lib", name), "utf8");
      assert(!source.includes("console.log("), `lib/${name} 无 console.log（stdout 留给 JSON-RPC）`);
    }
    const indexSource = await readFile(SERVER_ENTRY, "utf8");
    assert(!indexSource.includes("console.log("), "server/index.mjs 无 console.log");
    const pairSource = await readFile(PAIR_ENTRY, "utf8");
    assert(!/console\.log\([^)]*reconnectToken/.test(pairSource) && !/console\.log\([^)]*privateKey/.test(pairSource), "pair.mjs 不打印令牌/私钥");

    // 已配对但 bridge 不可达时的错误必须清楚（用 RFC5737 文档地址 + 极短超时，不发真实请求）。
    assert(
      identity.relayUrl === "https://relay.example.com",
      "身份文件保留中继地址（连接层可配置，不写死）",
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_MCP_HOME;
    else process.env.AGENT_BRIDGE_MCP_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }

  const all = capturedOutput.join("\n");
  assert(!all.includes(SENTINEL_SECRET), "所有子进程 stdout/stderr 里都没有哨兵令牌值");
  assert(!/reconnectToken["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/.test(all), "输出里没有重连令牌的赋值形态");
}

// ---------------------------------------------------------------- 入口

async function main() {
  console.log(`Agent Bridge MCP selftest · node ${process.version}`);
  const noise = await testCrypto();
  section("PeerClient 内存回环（请求/响应/错误/超时）");
  await runPeerLoopbackTest(noise, { assert, assertEqual });
  testProtocol();
  await withTempHome((home) => testProfile(home));
  testStateDirResolution();
  await withTempHome(() => testRegistry());
  await testRegistryConcurrency();
  await testLockStalePolicy();
  await testRegistryCopyCompat();
  testMessages();
  await testUnpaired();
  await testSecretsAndPermissions();

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
