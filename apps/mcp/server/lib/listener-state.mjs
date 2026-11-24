/**
 * v2 listener 的独立状态目录（与主设备身份严格分开）。
 *
 * 为什么另开一个目录：主状态目录里的 identity.json 是 per-call client 的设备身份；
 * listener 要常驻一条连接，必须用自己的设备身份（否则同身份两条连接会互相踩 channel）。
 * 所以 listener 有：独立的 <主状态目录>/listener/（0700）、独立的 profile/identity、watch 登记册、
 * 事件流、心跳与 pidfile。
 *
 * 覆盖方式：AB_LISTENER_STATE_DIR（测试与自建部署都用它）。
 * 目录里的文件全部 0600；watches.json 用 tmp + rename 原子写（listener 与 watch.mjs 并发）。
 */

import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { warn } from "./log.mjs";
import { absoluteOverride, readJson, stateDir } from "./state.mjs";

export const WATCHES_VERSION = 1;
export const DRAIN_CURSOR_VERSION = 1;

/** listener 自己的设备名：设备列表里一眼能和 per-call 的 `Muse (MCP)` 区分。 */
export const LISTENER_DEVICE_NAME = "Muse (MCP) Listener";

export function listenerStateDir() {
  // 与 state.mjs 同一条守卫：相对路径会让 watches/events 落到 CWD，而 state.mjs 仍回落到
  // 每用户目录 —— 两个目录一旦错位，listener 会读到主设备的 identity.json（同身份两条连接）。
  const override = absoluteOverride(process.env.AB_LISTENER_STATE_DIR);
  if (override) return override;
  const raw = process.env.AB_LISTENER_STATE_DIR?.trim();
  if (raw) warn(`AB_LISTENER_STATE_DIR 必须是绝对路径，已忽略「${raw}」`);
  return join(stateDir(), "listener");
}

export function listenerPaths() {
  const dir = listenerStateDir();
  return {
    dir,
    profile: join(dir, "profile.json"),
    identity: join(dir, "identity.json"),
    confirm: join(dir, "confirm"),
    watches: join(dir, "watches.json"),
    events: join(dir, "events.jsonl"),
    heartbeat: join(dir, "heartbeat.json"),
    pid: join(dir, "listener.pid"),
    drainCursor: join(dir, "drain-cursor.json"),
    log: join(dir, "listener.log"),
  };
}

export async function ensureListenerStateDir() {
  const dir = listenerStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 目录已存在时 mkdir 的 mode 不生效，显式收紧一次。
  await chmod(dir, 0o700);
  return dir;
}

/** watches.json 的原子写：先写同目录临时文件（0600），再 rename 覆盖。 */
export async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export function emptyWatches() {
  return { version: WATCHES_VERSION, updatedAt: new Date().toISOString(), watches: [] };
}

/** 读 watch 登记册；缺失按空表，损坏的条目丢弃（不让一条坏记录挡住整个 listener）。 */
export async function loadWatches() {
  const raw = await readJson(listenerPaths().watches);
  if (raw === null) return emptyWatches();
  if (typeof raw !== "object" || Array.isArray(raw)) return emptyWatches();
  const watches = Array.isArray(raw.watches)
    ? raw.watches.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.sessionId === "string" &&
          typeof item.chatId === "string",
      )
    : [];
  return {
    version: WATCHES_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    watches,
  };
}

export async function saveWatches(registry) {
  const next = {
    version: WATCHES_VERSION,
    updatedAt: new Date().toISOString(),
    watches: Array.isArray(registry?.watches) ? registry.watches : [],
  };
  await writeJsonAtomic(listenerPaths().watches, next);
  return next;
}

/** 事件流：一行一个 JSON 对象，只追加。 */
export async function appendEvent(path, event) {
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return event;
}

export async function readEvents(path = listenerPaths().events) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && typeof value.id === "string") events.push(value);
    } catch {
      // 半行（写到一半被 kill）不算事件，跳过即可。
    }
  }
  return events;
}

export async function writeHeartbeat(value) {
  await ensureListenerStateDir();
  await writeJsonAtomic(listenerPaths().heartbeat, { ts: new Date().toISOString(), ...value });
}

export async function readDrainCursor() {
  const raw = await readJson(listenerPaths().drainCursor);
  if (!raw || typeof raw !== "object" || typeof raw.lastEventId !== "string") {
    return { version: DRAIN_CURSOR_VERSION, lastEventId: null, updatedAt: null };
  }
  return {
    version: DRAIN_CURSOR_VERSION,
    lastEventId: raw.lastEventId,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export async function writeDrainCursor(lastEventId) {
  await writeJsonAtomic(listenerPaths().drainCursor, {
    version: DRAIN_CURSOR_VERSION,
    lastEventId,
    updatedAt: new Date().toISOString(),
  });
}

export { readJson };
