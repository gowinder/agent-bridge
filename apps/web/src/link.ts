export interface PairingLink {
  relayUrl: string;
  roomId: string;
  inviteToken: string;
}

const ROOM_ID = /^[a-z0-9-]{8,64}$/;

export function credentialsFromFragment(hash: string): PairingLink | null {
  if (!hash.startsWith("#/pair?")) return null;
  const params = new URLSearchParams(hash.slice("#/pair?".length));
  const relay = params.get("relay");
  const room = params.get("room");
  const invite = params.get("invite");
  if (!relay || !room || !invite) return null;
  if (!ROOM_ID.test(room)) return null;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(invite)) return null;
  let relayUrl: URL;
  try {
    relayUrl = new URL(relay);
  } catch {
    return null;
  }
  // 中继决定了设备连到哪里：非回环地址必须用 https，否则链路上的房间号与授权都在明处。
  const loopback =
    relayUrl.hostname === "localhost" ||
    relayUrl.hostname === "127.0.0.1" ||
    relayUrl.hostname === "[::1]";
  if (
    relayUrl.protocol !== "https:" &&
    !(relayUrl.protocol === "http:" && (loopback || location.protocol === "http:"))
  ) {
    return null;
  }
  return { relayUrl: relayUrl.origin, roomId: room, inviteToken: invite };
}

export function parsePairingInput(text: string): PairingLink | null {
  const value = text.trim();
  if (!value) return null;
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return null;
  return credentialsFromFragment(value.slice(hashIndex));
}

/** 配对秘密只走 fragment；捕获后立刻从地址栏清除。 */
export function takeInviteLink(): PairingLink | null {
  if (!location.hash.startsWith("#/pair?")) return null;
  const link = credentialsFromFragment(location.hash);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return link;
}
