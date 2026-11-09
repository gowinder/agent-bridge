const encoder = new TextEncoder();

/** Pairing PSK: both sides know the single-use invite token and the room id. */
export async function derivePairPsk(inviteToken: string, roomId: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(inviteToken), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("agent-bridge/pair/v1"),
      info: encoder.encode(roomId),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 6-digit code shown on both sides for the user to compare after the handshake. */
export async function confirmCode(
  browserPublicKey: Uint8Array,
  bridgePublicKey: Uint8Array,
): Promise<string> {
  const prefix = encoder.encode("agent-bridge/confirm/v1");
  const material = new Uint8Array(prefix.length + browserPublicKey.length + bridgePublicKey.length);
  material.set(prefix, 0);
  material.set(browserPublicKey, prefix.length);
  material.set(bridgePublicKey, prefix.length + browserPublicKey.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  const view = new DataView(digest.buffer, digest.byteOffset, 4);
  return String(view.getUint32(0) % 1_000_000).padStart(6, "0");
}

export function pairPrologue(roomId: string, channel: string): Uint8Array {
  return encoder.encode(`agent-bridge/pair/v1|${roomId}|${channel}`);
}

export function reconnectPrologue(roomId: string, channel: string, deviceId: string): Uint8Array {
  return encoder.encode(`agent-bridge/device/v1|${roomId}|${channel}|${deviceId}`);
}
