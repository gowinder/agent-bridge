import {
  confirmCode,
  derivePairPsk,
  fromHex,
  NoiseHandshake,
  pairPrologue,
  randomBytes,
  reconnectPrologue,
  toHex,
  type KeyPair,
  type SecureChannel,
} from "@craftstead/crypto";
import type { PairResult } from "@craftstead/protocol";
import { credentialsFromFragment, type PairingLink } from "./link.js";
import { noise } from "./noise.js";
import { PeerClient } from "./peer.js";
import { helloMessage, RelayConnection } from "./relay.js";
import { saveDevice, type StoredDevice } from "./credentials.js";
import { tr } from "./i18n";

export interface PairingChallenge {
  connection: RelayConnection;
  secure: SecureChannel;
  keys: KeyPair;
  bridgePublicKey: string;
  confirmCode: string;
  link: PairingLink;
}

/** The relay receives only this hash; the raw token stays in the URL fragment. */
async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function startPairing(link: PairingLink): Promise<PairingChallenge> {
  const engine = await noise();
  const keys = engine.generateKeyPair();
  const channel = toHex(randomBytes(16));
  const tokenHash = await sha256Hex(link.inviteToken);
  const { connection, ready } = RelayConnection.connect(
    link.relayUrl,
    link.roomId,
    helloMessage(link.roomId, channel, { kind: "invite", tokenHash }),
    () => {},
  );
  await ready;

  const handshake = new NoiseHandshake(engine, {
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
  if (!remote) throw new Error(tr("握手未得到 Bridge 公钥"));
  const code = await confirmCode(keys.publicKey, remote);
  const secure = handshake.intoChannel();
  return {
    connection,
    secure,
    keys,
    bridgePublicKey: toHex(remote),
    confirmCode: code,
    link,
  };
}

export async function finishPairing(
  challenge: PairingChallenge,
  deviceName: string,
): Promise<{ device: StoredDevice; result: PairResult }> {
  const client = new PeerClient(challenge.connection, challenge.secure);
  const response = await client.request("pair.request", {
    deviceName,
    platform: navigator.userAgent.slice(0, 120),
    confirmCode: challenge.confirmCode,
  });
  if (!response.ok || !response.result) {
    throw new Error(response.error?.message ?? tr("配对被拒绝"));
  }
  const result = response.result as PairResult;
  const device: StoredDevice = {
    relayUrl: challenge.link.relayUrl,
    roomId: challenge.link.roomId,
    deviceId: result.deviceId,
    reconnectToken: result.reconnectToken,
    expiresAt: result.expiresAt,
    name: deviceName,
    bridgePublicKey: challenge.bridgePublicKey,
    privateKey: toHex(challenge.keys.privateKey),
    publicKey: toHex(challenge.keys.publicKey),
    pairedAt: Date.now(),
    bridge: result.bridge,
  };
  await saveDevice(device);
  client.stop();
  return { device, result };
}

export async function connectDevice(
  device: StoredDevice,
): Promise<{ client: PeerClient; connection: RelayConnection }> {
  const engine = await noise();
  const channel = toHex(randomBytes(16));
  const { connection, ready } = RelayConnection.connect(
    device.relayUrl,
    device.roomId,
    helloMessage(device.roomId, channel, {
      kind: "device",
      deviceId: device.deviceId,
      token: device.reconnectToken,
    }),
    () => {},
  );
  try {
    await ready;
    const handshake = new NoiseHandshake(engine, {
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
    if (!handshake.finished) throw new Error(tr("重连握手未完成"));
    const secure = handshake.intoChannel();
    return { client: new PeerClient(connection, secure), connection };
  } catch (error) {
    // 握手失败也要关掉 socket：不关的话这条通道会一直挂在 relay 和 Bridge 上，
    // 而且没人再持有它，永远关不掉 —— 每次重试都会漏一条。
    connection.close(1000, "connect failed");
    throw error;
  }
}

export { credentialsFromFragment };
