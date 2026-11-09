export interface StoredDevice {
  relayUrl: string;
  roomId: string;
  deviceId: string;
  reconnectToken: string;
  expiresAt: number | null;
  name: string;
  bridgePublicKey: string;
  privateKey: string;
  publicKey: string;
  pairedAt: number;
  bridge: { name: string; version: string; platform: string };
}

const STORAGE_KEY = "agent-bridge:devices:v1";

function read(): StoredDevice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredDevice => {
      const value = item as Partial<StoredDevice> | null;
      return (
        typeof value === "object" &&
        value !== null &&
        typeof value.relayUrl === "string" &&
        typeof value.roomId === "string" &&
        typeof value.deviceId === "string" &&
        typeof value.reconnectToken === "string" &&
        typeof value.privateKey === "string" &&
        typeof value.publicKey === "string" &&
        typeof value.bridgePublicKey === "string"
      );
    });
  } catch {
    return [];
  }
}

function write(devices: StoredDevice[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

export function listDevices(): StoredDevice[] {
  return read().sort((a, b) => b.pairedAt - a.pairedAt);
}

export function findDevice(relayUrl: string, roomId: string): StoredDevice | null {
  return read().find((device) => device.relayUrl === relayUrl && device.roomId === roomId) ?? null;
}

export function saveDevice(device: StoredDevice): void {
  const devices = read().filter(
    (item) => !(item.relayUrl === device.relayUrl && item.roomId === device.roomId),
  );
  devices.push(device);
  write(devices);
}

export function removeDevice(relayUrl: string, roomId: string): void {
  write(read().filter((item) => !(item.relayUrl === relayUrl && item.roomId === roomId)));
}

export function expireLabel(expiresAt: number | null): string {
  if (expiresAt === null) return "长期有效（可在 Mac 上撤销）";
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "已过期";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟后到期`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时后到期`;
  return `${Math.floor(hours / 24)} 天后到期`;
}
