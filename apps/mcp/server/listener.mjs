#!/usr/bin/env node
/**
 * v2 常驻完成监听器（plan C stage 1）。
 *
 * 它用自己的设备身份（<主状态目录>/listener/identity.json，设备名 `Muse (MCP) Listener`）
 * 维持一条常驻 ik 连接，按 AB_LISTENER_POLL_MS（默认 15s，最小 5s）轮询
 * `session.list` / `message.list`，把 watch 的边沿（completed / needs-user / gone）
 * 追加进同一目录的 events.jsonl。运行时钩子用 bin/drain-events.mjs 取事件。
 *
 * 为什么轮询：bridge 的 session.subscribe 返回 unsupported（已核实）。bridge 自己的
 * SessionNotifier 也是 10s 轮询。stage 2 若桥侧实现 subscribe，只换本文件的内部实现，
 * watch / events / hook 的对外契约不变。
 *
 * 状态目录：<主状态目录>/listener/（0700，文件 0600），或 $AB_LISTENER_STATE_DIR。
 * 退出码：0 正常（SIGTERM/SIGINT）；2 未配对（打印配对指引）；3 已有实例在跑。
 */

import { randomUUID } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BridgeLink, loadIdentity } from "./lib/bridge.mjs";
import { stepWatch } from "./lib/edges.mjs";
import { log, warn } from "./lib/log.mjs";
import { sortMessages } from "./lib/messages.mjs";
import { loadProfile } from "./lib/profile.mjs";
import { ToolError } from "./lib/errors.mjs";
import { statePaths } from "./lib/state.mjs";
import {
  LISTENER_DEVICE_NAME,
  appendEvent,
  ensureListenerStateDir,
  listenerPaths,
  listenerStateDir,
  loadWatches,
  saveWatches,
  writeHeartbeat,
} from "./lib/listener-state.mjs";

const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 5_000;
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
const SESSION_LIST_TIMEOUT_MS = 60_000;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 20;

/** listener 独占的边沿状态字段：watch.mjs 不碰这些。 */
const EDGE_FIELDS = Object.freeze([
  "lastBusy",
  "lastNeedsDecision",
  "missingPolls",
  "watermarkMessageCount",
  "watermarkLastMessageId",
  "status",
]);

const STATE_DIR_NOTE = `listener 状态目录：${listenerStateDir()}`;

function pollIntervalMs() {
  const raw = Number(process.env.AB_LISTENER_POLL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.floor(raw));
}

function pairingInstructions(identityPath) {
  const paths = listenerPaths();
  return [
    `本 listener 还没有配对设备身份（${identityPath} 不存在或字段不全）。`,
    `listener 用自己的设备身份，不要复用 per-call client 的 ${statePaths().identity}。`,
    "配对步骤（邀请不要贴进聊天）：",
    "  1. 在 Mac 菜单栏 Agent Bridge 里生成配对邀请链接；",
    `  2. 把整条链接写成本机文件，例如 ${paths.dir}/invite-listener.txt；`,
    `  3. 运行：node server/pair.mjs --invite-file <该文件> --state-dir ${paths.dir} --name "${LISTENER_DEVICE_NAME}"`,
    `  4. 比对菜单栏与终端里的 6 位确认码，一致时把 yes 写进 ${paths.confirm}；`,
    "  5. 再启动 listener：bin/listener.sh start",
  ].join("\n");
}

async function readPidFile() {
  try {
    const text = (await readFile(listenerPaths().pid, "utf8")).trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function claimPidFile() {
  const existing = await readPidFile();
  if (existing !== null && existing !== process.pid && processAlive(existing)) {
    return existing;
  }
  const path = listenerPaths().pid;
  await writeFile(path, `${process.pid}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return null;
}

async function releasePidFile() {
  const pid = await readPidFile().catch(() => null);
  if (pid === process.pid) await unlink(listenerPaths().pid).catch(() => {});
}

/**
 * 消息总数 + 最新消息 id。message.list 分页（nextBefore 指向前一页），
 * 最多翻 MAX_MESSAGE_PAGES 页；超长会话仍能用 lastMessageId 判增长。
 */
async function readMessageStats(link, sessionId) {
  let before = null;
  let count = 0;
  let lastMessageId = null;
  let pages = 0;
  for (;;) {
    const params = { sessionId, limit: MESSAGE_PAGE_SIZE, ...(before ? { before } : {}) };
    const page = await link.call("message.list", params, { timeoutMs: SESSION_LIST_TIMEOUT_MS });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    if (pages === 0) lastMessageId = sortMessages(messages).at(-1)?.messageId ?? null;
    count += messages.length;
    pages += 1;
    if (!page?.nextBefore || pages >= MAX_MESSAGE_PAGES) break;
    before = page.nextBefore;
  }
  return { count, lastMessageId, pages };
}

function edgeSnapshot(session, stats) {
  return {
    busy: session.busy === true,
    needsDecision: session.needsDecision === true,
    messageCount: stats.count,
    lastMessageId: stats.lastMessageId,
  };
}

function pickEdgeFields(watch) {
  const patch = {};
  for (const field of EDGE_FIELDS) if (watch[field] !== undefined) patch[field] = watch[field];
  return patch;
}

/**
 * 把边沿结果合并回「刚读到的」watches.json：只动 listener 独占字段，
 * 并且绝不复活已 done/removed 的 watch（watch.mjs 与 listener 并发写）。
 */
async function mergeEdgePatches(patches) {
  if (patches.length === 0) return { registry: await loadWatches() };
  const registry = await loadWatches();
  let changed = false;
  for (const { id, patch } of patches) {
    const current = registry.watches.find((item) => item.id === id);
    if (!current || current.status !== "active") continue;
    for (const [key, value] of Object.entries(patch)) {
      if (current[key] !== value) changed = true;
      current[key] = value;
    }
  }
  if (changed) await saveWatches(registry);
  return { registry };
}

async function runCycle(link) {
  const paths = listenerPaths();
  const registry = await loadWatches();
  const active = registry.watches.filter((watch) => watch.status === "active");
  const patches = [];
  const edgeEvents = [];

  if (active.length > 0) {
    const listed = await link.call("session.list", { includeArchived: true }, { timeoutMs: SESSION_LIST_TIMEOUT_MS });
    const byId = new Map(
      (Array.isArray(listed?.sessions) ? listed.sessions : []).map((session) => [session.sessionId, session]),
    );

    for (const watch of active) {
      const session = byId.get(watch.sessionId) ?? null;
      let stats = null;
      if (session) {
        try {
          stats = await readMessageStats(link, watch.sessionId);
        } catch (error) {
          // 单个会话读失败不算「消失」，本周期跳过这个 watch，下周期重试。
          warn(`watch ${watch.id} 的 message.list 失败，本周期跳过：${error.message}`);
          continue;
        }
        if (!Number.isInteger(watch.watermarkMessageCount)) {
          // 注册时没给 --message-count：用当前消息数做水位，派活前的历史消息不算新产出。
          patches.push({
            id: watch.id,
            patch: { watermarkMessageCount: stats.count, watermarkLastMessageId: stats.lastMessageId },
          });
          continue;
        }
      }
      const snapshot = session ? edgeSnapshot(session, stats) : null;
      const result = stepWatch(watch, snapshot);
      patches.push({ id: watch.id, patch: pickEdgeFields(result.watch) });
      for (const event of result.events) {
        edgeEvents.push({ ...event, watchId: watch.id, watch });
      }
    }
  }

  // 先落事件、再写 watch 状态（spec 的顺序）：磁盘/进程在两步之间出问题时，
  // 宁可下轮再报一次（重复通知无害，调用方会复核），也不让完成事件静默丢失。
  for (const event of edgeEvents) {
    const record = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: event.type,
      watchId: event.watchId,
      sessionId: event.watch.sessionId,
      chatId: event.watch.chatId,
      purpose: event.watch.purpose,
      messageCount: event.messageCount ?? null,
    };
    await appendEvent(paths.events, record);
    log(`事件 ${record.type}：watch=${record.watchId} session=${record.sessionId}`);
  }

  const { registry: merged } = await mergeEdgePatches(patches);

  await writeHeartbeat({
    connected: true,
    activeWatches: merged.watches.filter((watch) => watch.status === "active").length,
    pollIntervalMs: pollIntervalMs(),
  });
}

function sleepInterruptible(ms, handle) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      handle.wake = null;
      resolvePromise();
    }, ms);
    handle.wake = () => {
      clearTimeout(timer);
      handle.wake = null;
      resolvePromise();
    };
  });
}

async function main() {
  // listener 的身份/偏好都从它自己的状态目录来：把 lib/state.mjs（identity/profile 路径）
  // 与 listener 目录钉在同一个目录上，否则默认路径下会读到 per-call client 的身份。
  // 两个变量都写成已解析的结果，重算后不变（不会递归拼出 listener/listener）。
  const listenerDir = listenerStateDir();
  process.env.AGENT_BRIDGE_MCP_HOME = listenerDir;
  process.env.AB_LISTENER_STATE_DIR = listenerDir;

  await ensureListenerStateDir();
  const paths = listenerPaths();

  const claimedBy = await claimPidFile();
  if (claimedBy !== null) {
    console.error(`listener 已在运行（pid=${claimedBy}，pidfile ${paths.pid}），拒绝重复启动。`);
    console.error("需要重启：先 bin/listener.sh stop（或 kill 该 pid），再 start。");
    return 3;
  }

  let identity;
  try {
    identity = await loadIdentity();
  } catch (error) {
    await releasePidFile();
    if (error instanceof ToolError && error.code === "unpaired") {
      console.error(pairingInstructions(paths.identity));
      return 2;
    }
    throw error;
  }

  const { profile, warnings } = await loadProfile();
  for (const warning of warnings) warn(warning);
  log(`listener 启动：device=${identity.deviceId}（${identity.deviceName ?? LISTENER_DEVICE_NAME}）relay=${identity.relayUrl ?? profile.relayUrl}`);
  log(`${STATE_DIR_NOTE}，轮询 ${pollIntervalMs()}ms`);

  const link = new BridgeLink({ profile });
  const handle = { wake: null, stopping: false };
  let connected = false;
  let backoffIndex = 0;

  const shutdown = (signal) => {
    if (handle.stopping) return;
    handle.stopping = true;
    log(`收到 ${signal}，关闭连接并退出。`);
    handle.wake?.();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  while (!handle.stopping) {
    try {
      await link.open();
      if (handle.stopping) break;
      if (!connected) {
        connected = true;
        backoffIndex = 0;
        log("listener 已连接 bridge。");
      }
      await runCycle(link);
      await sleepInterruptible(pollIntervalMs(), handle);
    } catch (error) {
      if (handle.stopping) break;
      connected = false;
      try {
        link.close();
      } catch {
        // ignore
      }
      const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
      backoffIndex += 1;
      warn(`listener 断开：${error.message}；${Math.round(delay / 1000)}s 后重连（第 ${backoffIndex} 次）。`);
      const registry = await loadWatches().catch(() => ({ watches: [] }));
      await writeHeartbeat({
        connected: false,
        activeWatches: registry.watches.filter((watch) => watch.status === "active").length,
        lastError: String(error.message ?? error),
      }).catch(() => {});
      await sleepInterruptible(delay, handle);
    }
  }

  link.close();
  const registry = await loadWatches().catch(() => ({ watches: [] }));
  await writeHeartbeat({
    connected: false,
    activeWatches: registry.watches.filter((watch) => watch.status === "active").length,
    stopped: true,
  }).catch(() => {});
  await releasePidFile();
  return 0;
}

export { main, readMessageStats, runCycle };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
      // WebSocket/定时器可能挂住事件循环：正常收尾后显式退出。
      if (code === 0) process.exit(0);
    })
    .catch((error) => {
      console.error(`listener 未处理错误：${error?.stack ?? error}`);
      process.exit(1);
    });
}
