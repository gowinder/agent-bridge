#!/usr/bin/env node
/**
 * watch 登记册 CLI（调用方 agent 在派活时登记、收尾时注销）。JSON 进/出，不打印凭据。
 *
 *   node bin/watch.mjs add --session <sessionId> --chat <chatId> --purpose <text> [--message-count <n>]
 *   node bin/watch.mjs list
 *   node bin/watch.mjs remove --id <watchId>
 *   node bin/watch.mjs done --id <watchId>
 *
 * 分工：本 CLI 只写「注册字段」（sessionId/chatId/purpose/watermark/status）；
 * lastBusy、lastNeedsDecision、missingPolls、watermarkLastMessageId 这些边沿状态由
 * server/listener.mjs 独占写入。watches.json 用 tmp + rename 原子写，两边并发安全。
 *
 * 状态目录：$AB_LISTENER_STATE_DIR 或 <主状态目录>/listener/（0700，文件 0600）。
 * 退出码：0 成功；1 运行错误（例如 watch 不存在）；2 用法错误。
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureListenerStateDir, listenerPaths, listenerStateDir, loadWatches, saveWatches } from "../server/lib/listener-state.mjs";

const USAGE = `用法：
  node bin/watch.mjs add --session <sessionId> --chat <chatId> --purpose <text> [--message-count <n>]
  node bin/watch.mjs list
  node bin/watch.mjs remove --id <watchId>
  node bin/watch.mjs done --id <watchId>

说明：
  - 状态目录：$AB_LISTENER_STATE_DIR 或 <主状态目录>/listener/（0700，文件 0600）。
  - add 的 watermarkMessageCount 缺省为 null：listener 第一次轮询时用当时的消息数初始化，
    不会把派活前就存在的消息误当成新产出。
  - 退出码：0 成功；1 运行错误；2 用法错误。
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`参数 ${item} 缺值`);
      flags.set(item.slice(2), next);
      i += 1;
      continue;
    }
    positional.push(item);
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`缺少 --${name} <值>`);
  return value.trim();
}

function printPayload(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withRegistry(mutator) {
  await ensureListenerStateDir();
  const registry = await loadWatches();
  const result = await mutator(registry);
  const saved = await saveWatches(registry);
  return { ...result, registry: saved };
}

async function runAdd(flags) {
  const sessionId = requireFlag(flags, "session");
  const chatId = requireFlag(flags, "chat");
  const purpose = requireFlag(flags, "purpose");
  let watermarkMessageCount = null;
  if (flags.has("message-count")) {
    const raw = flags.get("message-count");
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError("--message-count 必须是非负整数");
    watermarkMessageCount = parsed;
  }
  const createdAt = new Date().toISOString();
  const watch = {
    id: randomUUID(),
    sessionId,
    chatId,
    purpose,
    createdAt,
    watermarkMessageCount,
    lastBusy: null,
    lastNeedsDecision: false,
    status: "active",
  };
  const { registry } = await withRegistry((current) => {
    current.watches.push(watch);
    return { watch };
  });
  printPayload({ ok: true, watch, activeWatches: registry.watches.filter((item) => item.status === "active").length });
  return 0;
}

async function runList() {
  await ensureListenerStateDir();
  const registry = await loadWatches();
  printPayload({
    ok: true,
    stateDir: listenerStateDir(),
    watchesPath: listenerPaths().watches,
    count: registry.watches.length,
    activeWatches: registry.watches.filter((item) => item.status === "active").length,
    watches: registry.watches,
  });
  return 0;
}

async function runRemove(flags) {
  const id = requireFlag(flags, "id");
  let found = null;
  await withRegistry((current) => {
    const index = current.watches.findIndex((item) => item.id === id);
    if (index === -1) return;
    found = current.watches[index];
    current.watches.splice(index, 1);
  });
  if (!found) {
    printPayload({ ok: false, error: { code: "watch_not_found", message: `没有 id=${id} 的 watch。` } });
    return 1;
  }
  printPayload({ ok: true, removed: true, watch: found });
  return 0;
}

async function runDone(flags) {
  const id = requireFlag(flags, "id");
  let found = null;
  await withRegistry((current) => {
    const watch = current.watches.find((item) => item.id === id);
    if (!watch) return;
    watch.status = "done";
    watch.doneAt = new Date().toISOString();
    watch.doneBy = "watch.mjs";
    found = watch;
  });
  if (!found) {
    printPayload({ ok: false, error: { code: "watch_not_found", message: `没有 id=${id} 的 watch。` } });
    return 1;
  }
  printPayload({ ok: true, watch: found });
  return 0;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const [command] = parsed.positional;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  try {
    switch (command) {
      case "add":
        return await runAdd(parsed.flags);
      case "list":
        return await runList();
      case "remove":
        return await runRemove(parsed.flags);
      case "done":
        return await runDone(parsed.flags);
      default:
        process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    printPayload({ ok: false, error: { code: "watch_error", message: error?.message ?? String(error) } });
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[watch] 未处理错误：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
