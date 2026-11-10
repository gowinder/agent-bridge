export interface DeviceMeta {
  relayUrl: string;
  roomId: string;
  deviceId: string;
  expiresAt: number | null;
  name: string;
  bridgePublicKey: string;
  publicKey: string;
  pairedAt: number;
  bridge: { name: string; version: string; platform: string };
}

/** The two fields that must never sit in localStorage as plaintext. */
export interface DeviceSecrets {
  privateKey: string;
  reconnectToken: string;
}

export interface StoredDevice extends DeviceMeta, DeviceSecrets {}

export class LockedError extends Error {
  constructor(message = "设备凭据已锁定，请重新输入密码") {
    super(message);
    this.name = "LockedError";
  }
}

/**
 * v2 keeps device metadata in the clear so the list can render before unlocking,
 * and puts the secrets in one AES-GCM blob whose key comes from the user's password.
 * v1 is the old plaintext layout; it is read until a password is set, then removed.
 */
const STORAGE_KEY = "agent-bridge:devices:v2";
const LEGACY_KEY = "agent-bridge:devices:v1";
/** 解锁后 30 分钟没有用到凭据就清掉内存里的密钥。 */
const UNLOCK_MS = 30 * 60 * 1000;
const ITERATIONS = 600_000;

interface Vault {
  salt: string;
  iv: string;
  data: string;
}

interface Store {
  devices: DeviceMeta[];
  vault: Vault | null;
}

let sessionKey: CryptoKey | null = null;
let secrets: Map<string, DeviceSecrets> | null = null;
let unlockTimer: ReturnType<typeof setTimeout> | null = null;
/** 后台标签页的定时器会被节流，所以除了定时器还要按时间戳兜底判断。 */
let lastUsed = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function keyOf(device: { relayUrl: string; roomId: string }): string {
  return `${device.relayUrl}#${device.roomId}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isMeta(value: unknown): value is DeviceMeta {
  const item = value as Partial<DeviceMeta> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.relayUrl === "string" &&
    typeof item.roomId === "string" &&
    typeof item.deviceId === "string" &&
    typeof item.bridgePublicKey === "string" &&
    typeof item.publicKey === "string"
  );
}

function isSecrets(value: unknown): value is DeviceSecrets {
  const item = value as Partial<DeviceSecrets> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.privateKey === "string" &&
    typeof item.reconnectToken === "string"
  );
}

function readStore(): Store | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const store = parsed as Partial<Store>;
    const devices = Array.isArray(store.devices) ? store.devices.filter(isMeta) : [];
    const vault = store.vault;
    return {
      devices,
      vault:
        typeof vault === "object" &&
        vault !== null &&
        typeof vault.salt === "string" &&
        typeof vault.iv === "string" &&
        typeof vault.data === "string"
          ? vault
          : null,
    };
  } catch {
    return null;
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** 老格式：整份设备（含私钥）明文存在 v1 里。 */
function readLegacy(): StoredDevice[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredDevice => isMeta(item) && isSecrets(item));
  } catch {
    return [];
  }
}

export function hasVault(): boolean {
  return readStore()?.vault != null;
}

/** Reading the list never needs the password: only metadata is stored in the clear. */
export function listDevices(): DeviceMeta[] {
  const store = readStore();
  const devices = store ? store.devices : readLegacy();
  return [...devices].sort((a, b) => b.pairedAt - a.pairedAt);
}

export function findDevice(relayUrl: string, roomId: string): DeviceMeta | null {
  return listDevices().find((device) => device.relayUrl === relayUrl && device.roomId === roomId) ?? null;
}

export function needsUnlock(): boolean {
  return hasVault() && (secrets === null || expired());
}

function expired(): boolean {
  return secrets !== null && Date.now() - lastUsed > UNLOCK_MS;
}

function armUnlockTimer(): void {
  lastUsed = Date.now();
  if (unlockTimer !== null) clearTimeout(unlockTimer);
  unlockTimer = setTimeout(() => {
    sessionKey = null;
    secrets = null;
    unlockTimer = null;
  }, UNLOCK_MS);
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, salt: Uint8Array<ArrayBuffer>, map: Map<string, DeviceSecrets>): Promise<Vault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(Object.fromEntries(map)));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(sealed)) };
}

export async function unlock(password: string): Promise<void> {
  const vault = readStore()?.vault;
  if (!vault) throw new Error("还没有设置密码");
  const key = await deriveKey(password, fromBase64(vault.salt));
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(vault.iv) },
      key,
      fromBase64(vault.data),
    );
  } catch {
    // AES-GCM 的认证标签校验失败就是密码不对，没有别的解释。
    throw new Error("密码不正确");
  }
  const parsed: unknown = JSON.parse(decoder.decode(plain));
  const map = new Map<string, DeviceSecrets>();
  if (typeof parsed === "object" && parsed !== null) {
    for (const [name, value] of Object.entries(parsed)) if (isSecrets(value)) map.set(name, value);
  }
  sessionKey = key;
  secrets = map;
  armUnlockTimer();
}

export function lock(): void {
  sessionKey = null;
  secrets = null;
  if (unlockTimer !== null) clearTimeout(unlockTimer);
  unlockTimer = null;
}

/**
 * Forgetting the password is unrecoverable by design; the only way forward is a clean
 * slate, which costs a fresh pairing. Metadata goes too, otherwise a device row would
 * point at secrets nobody can read.
 */
export function resetCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_KEY);
  lock();
}

/** Encrypts what is on disk now, including anything left in the old plaintext layout. */
export async function setupPassword(password: string): Promise<void> {
  const store = readStore();
  const legacy = readLegacy();
  const devices: DeviceMeta[] = store
    ? store.devices
    : legacy.map(({ privateKey: _private, reconnectToken: _token, ...meta }) => meta);
  const map = new Map<string, DeviceSecrets>();
  for (const device of legacy) {
    map.set(keyOf(device), { privateKey: device.privateKey, reconnectToken: device.reconnectToken });
  }
  for (const [name, value] of secrets ?? []) map.set(name, value);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  writeStore({ devices, vault: await seal(key, salt, map) });
  localStorage.removeItem(LEGACY_KEY);
  sessionKey = key;
  secrets = map;
  armUnlockTimer();
}

/**
 * Returns the secrets for a device, or null when they are still encrypted.
 * Callers must ask the user for the password and call `unlock` first.
 */
export function getDeviceSecrets(device: { relayUrl: string; roomId: string }): DeviceSecrets | null {
  if (secrets !== null && expired()) lock();
  if (secrets !== null) {
    const found = secrets.get(keyOf(device)) ?? null;
    if (found) armUnlockTimer();
    return found;
  }
  // 还没设置密码时，老格式里存的就是明文。
  if (!hasVault()) {
    const legacy = readLegacy().find(
      (item) => item.relayUrl === device.relayUrl && item.roomId === device.roomId,
    );
    return legacy ? { privateKey: legacy.privateKey, reconnectToken: legacy.reconnectToken } : null;
  }
  return null;
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  const { privateKey, reconnectToken, ...meta } = device;
  const store = readStore();
  if (!store || store.vault === null) {
    // 调用方应该先 setupPassword；没有密码时只能落到老格式。
    const legacy = readLegacy().filter(
      (item) => !(item.relayUrl === device.relayUrl && item.roomId === device.roomId),
    );
    legacy.push(device);
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    return;
  }
  if (sessionKey === null || secrets === null) throw new LockedError();
  const devices = store.devices.filter(
    (item) => !(item.relayUrl === device.relayUrl && item.roomId === device.roomId),
  );
  devices.push(meta);
  secrets.set(keyOf(device), { privateKey, reconnectToken });
  writeStore({ devices, vault: await seal(sessionKey, fromBase64(store.vault.salt), secrets) });
  armUnlockTimer();
}

export async function removeDevice(relayUrl: string, roomId: string): Promise<void> {
  const store = readStore();
  if (!store || store.vault === null) {
    const legacy = readLegacy().filter(
      (item) => !(item.relayUrl === relayUrl && item.roomId === roomId),
    );
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    return;
  }
  const devices = store.devices.filter(
    (item) => !(item.relayUrl === relayUrl && item.roomId === roomId),
  );
  if (sessionKey === null || secrets === null) {
    // 锁定时改不了密文，只删元数据；残留的密文条目下一次保存时会被一并覆盖。
    writeStore({ devices, vault: store.vault });
    return;
  }
  secrets.delete(keyOf({ relayUrl, roomId }));
  writeStore({ devices, vault: await seal(sessionKey, fromBase64(store.vault.salt), secrets) });
}

const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

/** 到期前 3 天就要提示重新配对，否则用户会在某天突然连不上。 */
export function isExpiringSoon(expiresAt: number | null): boolean {
  return expiresAt !== null && expiresAt - Date.now() <= EXPIRY_WARNING_MS;
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
