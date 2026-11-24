#!/usr/bin/env node
/**
 * 事件排空（运行时钩子调它）：把 listener 新写的事件一行一条打到 stdout。
 *
 *   node bin/drain-events.mjs           # 打印新事件并推进游标
 *   node bin/drain-events.mjs --peek    # 只打印，不推进游标（干跑）
 *
 * 契约：
 *   - 游标 <状态目录>/drain-cursor.json 记最后一条已投递事件的 id；
 *   - 没有新事件 → 不打印任何东西，exit 0（钩子据此判断「安静」）；
 *   - 每条事件一行：`[agent-bridge] completed · <purpose> · session <id> · chat <id>`；
 *   - 打印完把游标推进到已打印的最后一条（除非 --peek）。
 *
 * 状态目录：$AB_LISTENER_STATE_DIR 或 <主状态目录>/listener/。退出码：0 正常；1 读取失败；2 用法错误。
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureListenerStateDir,
  listenerPaths,
  readDrainCursor,
  readEvents,
  writeDrainCursor,
} from "../server/lib/listener-state.mjs";

const USAGE = `用法：
  node bin/drain-events.mjs [--peek]

  --peek   打印新事件但不推进游标（干跑）

退出码：0 正常（包括「没有新事件」）；1 读取/写入失败；2 用法错误。
`;

/** 一行摘要：purpose 里的换行/多余空白压平，避免一行事件变成多行输出。 */
function compactPurpose(purpose) {
  return String(purpose ?? "").trim().replace(/\s+/g, " ") || "(no purpose)";
}

function formatEvent(event) {
  return `[agent-bridge] ${event.type} · ${compactPurpose(event.purpose)} · session ${event.sessionId} · chat ${event.chatId}`;
}

async function main(argv) {
  let peek = false;
  for (const arg of argv) {
    if (arg === "--peek") {
      peek = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`不认识的参数：${arg}\n\n${USAGE}`);
    return 2;
  }

  await ensureListenerStateDir();
  const paths = listenerPaths();
  const cursor = await readDrainCursor();
  const events = await readEvents(paths.events);

  let fresh = events;
  if (cursor.lastEventId) {
    const index = events.findIndex((event) => event.id === cursor.lastEventId);
    // 游标 id 找不到（事件文件被轮转/手工清过）→ 全部当新事件投递，宁可多报不可漏报。
    fresh = index === -1 ? events : events.slice(index + 1);
  }
  if (fresh.length === 0) return 0;

  const lines = fresh.map(formatEvent).join("\n");
  process.stdout.write(`${lines}\n`);

  if (!peek) await writeDrainCursor(fresh.at(-1).id);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[drain-events] 失败：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
