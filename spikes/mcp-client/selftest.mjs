import {
  confirmCode,
  derivePairPsk,
  NoiseHandshake,
  pairPrologue,
  reconnectPrologue,
} from "@craftstead/crypto";
import { loadNoiseNode } from "@craftstead/crypto/node";
import { MAX_FRAME_BYTES, parseRelayHello } from "@craftstead/protocol";
import { credentialsFromFragment } from "./pairing.mjs";
import { helloMessage, relaySocketUrl } from "./relay.mjs";

/**
 * 无网络自检：整条链路的每一块（wasm 加载、握手、分片、链接解析）单独验一遍，
 * 这样 pair/verify 实跑失败时不会卡在「到底是环境还是协议」上。
 */

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  throw new Error(`自检失败：${label}`);
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 同一进程里把两条握手对接起来：a 先写（initiator），按噪声的消息顺序推进。 */
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

async function selftestXxpsk3(noise) {
  console.log("xxpsk3 回环握手（配对用的模式）");
  const roomId = "room-1234";
  const channel = "00112233445566778899aabbccddeeff";
  const inviteToken = "invite_token_for_selftest_only_0001";
  const psk = await derivePairPsk(inviteToken, roomId);
  const prologue = pairPrologue(roomId, channel);
  assert(psk.length === 32, "derivePairPsk 得到 32 字节 psk");
  assert(sameBytes(psk, await derivePairPsk(inviteToken, roomId)), "psk 可复现");

  const clientKeys = noise.generateKeyPair();
  const bridgeKeys = noise.generateKeyPair();
  const initiator = new NoiseHandshake(noise, {
    pattern: "xxpsk3",
    initiator: true,
    localKeys: clientKeys,
    psk,
    prologue,
  });
  const responder = new NoiseHandshake(noise, {
    pattern: "xxpsk3",
    initiator: false,
    localKeys: bridgeKeys,
    psk,
    prologue,
  });
  const steps = pumpHandshake(initiator, responder);
  console.log(`  握手消息：${steps.join("，")}`);
  assert(initiator.finished && responder.finished, "双方握手都 finished");
  assert(sameBytes(initiator.remoteStatic, bridgeKeys.publicKey), "initiator 看到的 remoteStatic = Bridge 公钥");
  assert(sameBytes(responder.remoteStatic, clientKeys.publicKey), "responder 看到的 remoteStatic = 客户端公钥");

  const code = await confirmCode(clientKeys.publicKey, initiator.remoteStatic);
  assert(/^[0-9]{6}$/.test(code), "confirmCode 是 6 位数字", code);
  assert(code === (await confirmCode(clientKeys.publicKey, bridgeKeys.publicKey)), "确认码两端一致");

  const initiatorChannel = initiator.intoChannel();
  const responderChannel = responder.intoChannel();
  return { initiatorChannel, responderChannel, clientKeys, bridgeKeys, roomId, channel };
}

async function selftestIk(noise) {
  console.log("ik 回环握手（重连用的模式）");
  const roomId = "room-1234";
  const channel = "ffeeddccbbaa99887766554433221100";
  const deviceId = "11111111-2222-3333-4444-555555555555";
  const prologue = reconnectPrologue(roomId, channel, deviceId);
  const deviceKeys = noise.generateKeyPair();
  const bridgeKeys = noise.generateKeyPair();

  const initiator = new NoiseHandshake(noise, {
    pattern: "ik",
    initiator: true,
    localKeys: deviceKeys,
    remotePublicKey: bridgeKeys.publicKey,
    prologue,
  });
  const responder = new NoiseHandshake(noise, {
    pattern: "ik",
    initiator: false,
    localKeys: bridgeKeys,
    prologue,
  });
  const steps = pumpHandshake(initiator, responder);
  console.log(`  握手消息：${steps.join("，")}`);
  assert(initiator.finished && responder.finished, "双方握手都 finished");
  assert(sameBytes(responder.remoteStatic, deviceKeys.publicKey), "Bridge 侧拿到的设备公钥与本地一致");

  return { initiatorChannel: initiator.intoChannel(), responderChannel: responder.intoChannel(), deviceKeys, bridgeKeys };
}

/** 一帧一帧喂过去，模拟 peer.readLoop 的「open() 返回 null 就继续读」。 */
function openAll(frames, channel) {
  let message = null;
  for (const frame of frames) {
    const opened = channel.open(frame);
    if (opened) message = opened;
  }
  return message;
}

function sealRoundTrip(label, sender, receiver, message) {
  const frames = sender.seal(message);
  const opened = openAll(frames, receiver);
  assert(opened !== null, `${label}：接收端组出完整消息`);
  assert(JSON.stringify(opened) === JSON.stringify(message), `${label}：内容逐字节一致`);
  return frames;
}

export async function runSelftest() {
  console.log("== selftest：wasm ==");
  const noise = await loadNoiseNode();
  assert(typeof noise.generateKeyPair === "function", "loadNoiseNode 返回可用的 Noise 实例");
  const probe = noise.generateKeyPair();
  assert(probe.privateKey.length === 32 && probe.publicKey.length === 32, "密钥对是 32+32 字节");

  console.log("== selftest：握手 ==");
  const xx = await selftestXxpsk3(noise);
  const ik = await selftestIk(noise);

  console.log("== selftest：密封/解封 ==");
  const small = { v: 1, kind: "request", id: "req-1", method: "host.ping" };
  sealRoundTrip("小消息（单帧）", ik.initiatorChannel, ik.responderChannel, small);
  sealRoundTrip("反方向单帧", ik.responderChannel, ik.initiatorChannel, {
    v: 1,
    kind: "response",
    id: "req-1",
    ok: true,
    result: { at: Date.now() },
  });

  // 32768B 是 seal 的分片阈值：超过就走 chunk 分片 + 接收端重组。
  const bigText = "A".repeat(40_000);
  const big = { v: 1, kind: "response", id: "req-big", ok: true, result: { text: bigText, size: bigText.length } };
  const bigFrames = sealRoundTrip("大消息（>32KiB 分片）", xx.initiatorChannel, xx.responderChannel, big);
  assert(bigFrames.length > 1, `大消息被拆成多帧（实际 ${bigFrames.length} 帧）`);
  assert(
    bigFrames.every((frame) => frame.length <= 64 * 1024),
    "每帧都在中继的 64KiB 上限内",
    bigFrames.map((frame) => frame.length),
  );
  console.log(`  分片帧大小：${bigFrames.map((frame) => `${frame.length}B`).join(" ")}，阈值 ${MAX_FRAME_BYTES}B`);

  console.log("== selftest：邀请链接解析 ==");
  const token = "invite_token_for_selftest_only_0001";
  const link = `https://example.invalid/#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-1234&invite=${token}`;
  const parsed = credentialsFromFragment(link.slice(link.indexOf("#")));
  assert(parsed !== null, "合法链接解析成功");
  assert(parsed.relayUrl === "https://relay.example.com", "relay 取 origin", parsed.relayUrl);
  assert(parsed.roomId === "room-1234", "room 解析正确", parsed.roomId);
  assert(parsed.inviteToken === token, "invite 解析正确");
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("http://127.0.0.1:47826")}&room=room-1234&invite=${token}`)
      ?.relayUrl === "http://127.0.0.1:47826",
    "回环地址允许 http",
  );
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("http://relay.example.com")}&room=room-1234&invite=${token}`) === null,
    "非回环 http 中继被拒绝",
  );
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-12&invite=${token}`) === null,
    "room 太短被拒绝",
  );
  assert(
    credentialsFromFragment(`#/pair?relay=${encodeURIComponent("https://relay.example.com")}&room=room-1234&invite=short`) ===
      null,
    "invite 太短被拒绝",
  );
  assert(credentialsFromFragment("#/pair?relay=x&room=room-1234") === null, "缺 invite 被拒绝");
  assert(credentialsFromFragment("#/settings") === null, "非配对 fragment 被拒绝");

  console.log("== selftest：中继地址与 hello 帧 ==");
  assert(
    relaySocketUrl("https://relay.example.com", "room-1234") === "wss://relay.example.com/v1/ws?room=room-1234",
    "https 中继转 wss + 固定路径",
    relaySocketUrl("https://relay.example.com", "room-1234"),
  );
  assert(
    relaySocketUrl("http://127.0.0.1:47826", "room-1234") === "ws://127.0.0.1:47826/v1/ws?room=room-1234",
    "http 中继转 ws",
    relaySocketUrl("http://127.0.0.1:47826", "room-1234"),
  );
  const channel = "00112233445566778899aabbccddeeff";
  const inviteHello = helloMessage("room-1234", channel, { kind: "invite", tokenHash: "0".repeat(64) });
  assert(parseRelayHello(inviteHello) !== null, "邀请 hello 通过 parseRelayHello 校验");
  assert(inviteHello.role === "browser" && inviteHello.v === 2, "hello 是 browser 角色、中继协议 v2");
  const deviceHello = helloMessage("room-1234", channel, {
    kind: "device",
    deviceId: "11111111-2222-3333-4444-555555555555",
    token: "device_token_for_selftest_only_01",
  });
  assert(parseRelayHello(deviceHello) !== null, "设备 hello 通过 parseRelayHello 校验");
  assert(parseRelayHello({ ...inviteHello, channel: "short" }) === null, "短 channel 的 hello 被拒绝");

  xx.initiatorChannel.close();
  xx.responderChannel.close();
  ik.initiatorChannel.close();
  ik.responderChannel.close();

  console.log("SELFTEST PASS");
}
