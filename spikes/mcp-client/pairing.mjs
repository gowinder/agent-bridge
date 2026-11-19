import {
  confirmCode,
  derivePairPsk,
  fromHex,
  NoiseHandshake,
  pairPrologue,
  randomBytes,
  reconnectPrologue,
  toHex,
} from "@craftstead/crypto";
import { loadNoiseNode } from "@craftstead/crypto/node";
import { PeerClient } from "./peer.mjs";
import { helloMessage, RelayConnection } from "./relay.mjs";

/**
 * `apps/web/src/link.ts` 的 credentialsFromFragment。
 * 差异：网页允许「页面本身是 http」时连 http 中继（本地开发），Node 没有页面，
 * 所以只放行 https 与回环 http。
 */
const ROOM_ID = /^[a-z0-9-]{8,64}$/;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export function credentialsFromFragment(hash) {
  if (!hash.startsWith("#/pair?")) return null;
  const params = new URLSearchParams(hash.slice("#/pair?".length));
  const relay = params.get("relay");
  const room = params.get("room");
  const invite = params.get("invite");
  if (!relay || !room || !invite) return null;
  if (!ROOM_ID.test(room)) return null;
  if (!INVITE_TOKEN.test(invite)) return null;
  let relayUrl;
  try {
    relayUrl = new URL(relay);
  } catch {
    return null;
  }
  const loopback =
    relayUrl.hostname === "localhost" ||
    relayUrl.hostname === "127.0.0.1" ||
    relayUrl.hostname === "[::1]";
  if (relayUrl.protocol !== "https:" && !(relayUrl.protocol === "http:" && loopback)) return null;
  return { relayUrl: relayUrl.origin, roomId: room, inviteToken: invite };
}

/** 从整条邀请链接里取出 fragment。 */
export function parsePairingLink(text) {
  const value = text.trim();
  if (!value) return null;
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return null;
  return credentialsFromFragment(value.slice(hashIndex));
}

/** 中继只看到这个哈希；原始 token 留在 fragment 里，不上传。 */
async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function loadNoise() {
  return loadNoiseNode();
}

/**
 * `apps/web/src/pairing.ts` startPairing：xxpsk3，浏览器做 initiator。
 * 握手帧是裸的 Noise 帧，一写一读循环到 finished。
 */
export async function startPairing(noise, link, onClosed = () => {}) {
  const keys = noise.generateKeyPair();
  const channel = toHex(randomBytes(16));
  const tokenHash = await sha256Hex(link.inviteToken);
  const { connection, ready } = RelayConnection.connect(
    link.relayUrl,
    link.roomId,
    helloMessage(link.roomId, channel, { kind: "invite", tokenHash }),
    onClosed,
  );
  await ready;
  console.log(`中继已就绪：channel=${channel}`);

  const handshake = new NoiseHandshake(noise, {
    pattern: "xxpsk3",
    initiator: true,
    localKeys: keys,
    psk: await derivePairPsk(link.inviteToken, link.roomId),
    prologue: pairPrologue(link.roomId, channel),
  });
  connection.sendBinary(handshake.write());
  while (!handshake.finished) {
    handshake.read(await connection.nextFrame());
    if (!handshake.finished) connection.sendBinary(handshake.write());
  }
  const remote = handshake.remoteStatic;
  if (!remote) throw new Error("握手未得到 Bridge 公钥");
  const code = await confirmCode(keys.publicKey, remote);
  const secure = handshake.intoChannel();
  return {
    connection,
    secure,
    keys,
    channel,
    bridgePublicKey: toHex(remote),
    confirmCode: code,
    link,
  };
}

/**
 * `apps/web/src/pairing.ts` connectDevice：ik 模式重连，设备密钥与 Bridge 公钥都从状态目录来。
 */
export async function connectDevice(noise, device, onClosed = () => {}) {
  const channel = toHex(randomBytes(16));
  const { connection, ready } = RelayConnection.connect(
    device.relayUrl,
    device.roomId,
    helloMessage(device.roomId, channel, {
      kind: "device",
      deviceId: device.deviceId,
      token: device.reconnectToken,
    }),
    onClosed,
  );
  try {
    await ready;
    console.log(`中继已就绪：channel=${channel}`);
    const handshake = new NoiseHandshake(noise, {
      pattern: "ik",
      initiator: true,
      localKeys: {
        privateKey: fromHex(device.privateKey),
        publicKey: fromHex(device.publicKey),
      },
      remotePublicKey: fromHex(device.bridgePublicKey),
      prologue: reconnectPrologue(device.roomId, channel, device.deviceId),
    });
    connection.sendBinary(handshake.write());
    handshake.read(await connection.nextFrame());
    if (!handshake.finished) throw new Error("重连握手未完成");
    const secure = handshake.intoChannel();
    console.log("Noise ik 握手完成");
    return { client: new PeerClient(connection, secure), connection };
  } catch (error) {
    // 握手失败也要关 socket：否则这条通道会一直挂在 relay 和 Bridge 上。
    connection.close(1000, "connect failed");
    throw error;
  }
}
