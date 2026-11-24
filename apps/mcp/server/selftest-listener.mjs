#!/usr/bin/env node
/**
 * v2 listener 离线自检：不碰网络、不碰 Mac、不碰生产实例。
 *
 * 覆盖（spec v2 §6）：
 *   1. 边沿检测纯函数：busy true→false + 增长 = 恰好一次 completed；needsDecision 上升 =
 *      一次 needs-user 且回落可重新武装；快任务（从没 busy）也报 completed；
 *      连续 3 次缺席 = gone；无增长 + busy 回落 = 不报 completed。
 *   2. watches.json CRUD：用真实子进程跑 bin/watch.mjs（临时 AB_LISTENER_STATE_DIR），
 *      含原子写、权限、错误退出码。
 *   3. events.jsonl 追加 + drain 游标推进 / --peek 语义。
 *   4. 未配对的 listener 打印配对指引并 exit 2；已有实例时 exit 3。
 *   5. bin/listener.sh status 的 JSON 形状、start 在已运行时是 no-op。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GONE_ABSENCE_POLLS, stepAll, stepWatch } from "./lib/edges.mjs";
import { runCycle } from "./listener.mjs";
import {
  appendEvent,
  ensureListenerStateDir,
  listenerPaths,
  listenerStateDir,
  loadWatches,
  readDrainCursor,
  readEvents,
} from "./lib/listener-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WATCH_ENTRY = join(ROOT, "bin", "watch.mjs");
const DRAIN_ENTRY = join(ROOT, "bin", "drain-events.mjs");
const LISTENER_ENTRY = join(HERE, "listener.mjs");
const LISTENER_SH = join(ROOT, "bin", "listener.sh");

const results = [];

function record(ok, label, detail) {
  results.push({ ok, label, detail });
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.error(`  ✗ ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  throw new Error(`自检失败：${label}`);
}

function assert(condition, label, detail) {
  record(Boolean(condition), label, detail);
}

function assertEqual(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  record(same, label, same ? undefined : { actual, expected });
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 子进程工具

function runNode(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runBash(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withTempListenerDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-listener-selftest-"));
  const previous = process.env.AB_LISTENER_STATE_DIR;
  const previousHome = process.env.AGENT_BRIDGE_MCP_HOME;
  process.env.AB_LISTENER_STATE_DIR = dir;
  delete process.env.AGENT_BRIDGE_MCP_HOME;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.AB_LISTENER_STATE_DIR;
    else process.env.AB_LISTENER_STATE_DIR = previous;
    if (previousHome === undefined) delete process.env.AGENT_BRIDGE_MCP_HOME;
    else process.env.AGENT_BRIDGE_MCP_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    record(false, `${label}：stdout 不是 JSON`, { stdout: text, error: error.message });
    return null;
  }
}

// ---------------------------------------------------------------- 1. 边沿检测

function makeWatch(overrides = {}) {
  return {
    id: "watch-1",
    sessionId: "session-1",
    chatId: "chat-1",
    purpose: "selftest · 边沿",
    createdAt: "2026-11-22T00:00:00.000Z",
    watermarkMessageCount: 10,
    watermarkLastMessageId: "m10",
    lastBusy: null,
    lastNeedsDecision: false,
    status: "active",
    ...overrides,
  };
}

function snapshot({ busy = false, needsDecision = false, messageCount = 10, lastMessageId = "m10" } = {}) {
  return { busy, needsDecision, messageCount, lastMessageId };
}

function runSequence(base, snapshots) {
  let watch = base;
  const events = [];
  const trace = [];
  for (const item of snapshots) {
    const result = stepWatch(watch, item);
    watch = result.watch;
    events.push(...result.events);
    trace.push({ in: item, out: result.watch.status, events: result.events.map((event) => event.type) });
  }
  return { watch, events, trace };
}

function testEdges() {
  section("边沿检测（纯函数）");

  // busy true→false + 增长 = 恰好一次 completed，之后的空闲轮询不再重复
  const slow = runSequence(makeWatch(), [
    snapshot({ busy: true, messageCount: 10 }),
    snapshot({ busy: false, messageCount: 12, lastMessageId: "m12" }),
    snapshot({ busy: false, messageCount: 12, lastMessageId: "m12" }),
    snapshot({ busy: false, messageCount: 12, lastMessageId: "m12" }),
  ]);
  assertEqual(slow.events.map((event) => event.type), ["completed"], "busy true→false + 增长 = completed 恰好一次");
  assert(slow.watch.status === "done", "completed 后 watch 置 done（不再触发）");
  assert(slow.events[0].messageCount === 12, "completed 事件带当时的消息数");
  assert(slow.trace[0].events.length === 0, "busy=true 且无增长时不报事件");

  // 快任务：从没观察到 busy=true，第一次看到空闲 + 增长也算 completed
  const fast = runSequence(makeWatch(), [
    snapshot({ busy: false, messageCount: 13, lastMessageId: "m13" }),
    snapshot({ busy: false, messageCount: 13, lastMessageId: "m13" }),
  ]);
  assertEqual(fast.events.map((event) => event.type), ["completed"], "快任务（未观察到 busy）= completed");
  assert(fast.trace[0].events[0] === "completed" && fast.trace[1].events.length === 0, "快任务只在第一轮报一次");

  // 无增长 + busy 回落 = 不报 completed（例如被 stop 掉、或只是用户消息未变）
  const noGrowth = runSequence(makeWatch(), [
    snapshot({ busy: true, messageCount: 10 }),
    snapshot({ busy: false, messageCount: 10 }),
    snapshot({ busy: false, messageCount: 10 }),
  ]);
  assertEqual(noGrowth.events, [], "无增长 + busy 回落 = 没有 completed");
  assert(noGrowth.watch.status === "active", "无增长时 watch 保持 active");
  assert(noGrowth.watch.lastBusy === false, "lastBusy 跟随最新快照（false）");

  // needs-user：false→true 报一次；回落 false 后重新武装；不关闭 watch
  const needs = runSequence(makeWatch({ watermarkMessageCount: 999 }), [
    snapshot({ needsDecision: false, messageCount: 5 }),
    snapshot({ needsDecision: true, messageCount: 5 }),
    snapshot({ needsDecision: true, messageCount: 5 }),
    snapshot({ needsDecision: false, messageCount: 5 }),
    snapshot({ needsDecision: true, messageCount: 5 }),
  ]);
  assertEqual(needs.events.map((event) => event.type), ["needs-user", "needs-user"], "needsDecision 上升 = 一次 needs-user，回落再上升可重新武装");
  assert(needs.watch.status === "active", "needs-user 不关闭 watch");
  assert(needs.watch.lastNeedsDecision === true, "当前 needsDecision 状态被记住");

  // gone：连续 3 次不在 session.list 里
  const gone2 = runSequence(makeWatch({ watermarkMessageCount: 999 }), [null, null]);
  assertEqual(gone2.events, [], `连续 ${GONE_ABSENCE_POLLS - 1} 次缺席不报 gone`);
  assert(gone2.watch.missingPolls === 2, "缺席计数累加");
  const gone3 = runSequence(makeWatch({ watermarkMessageCount: 999 }), [null, null, null]);
  assertEqual(gone3.events.map((event) => event.type), ["gone"], `连续 ${GONE_ABSENCE_POLLS} 次缺席 = gone`);
  assert(gone3.watch.status === "done", "gone 后 watch 置 done");
  assert(gone3.events[0].messageCount === null, "gone 事件没有消息数");

  // 缺席后重新出现：计数清零，不误报 gone
  const flap = runSequence(makeWatch({ watermarkMessageCount: 999 }), [null, null, snapshot({ messageCount: 5 })]);
  assertEqual(flap.events, [], "缺席两轮后重新出现 = 不报 gone");
  assert(flap.watch.missingPolls === 0, "重新出现后缺席计数清零");

  // 超长会话：消息数被分页上限卡住时，lastMessageId 变化也算增长
  const byId = runSequence(makeWatch(), [
    snapshot({ busy: true, messageCount: 10, lastMessageId: "m10" }),
    snapshot({ busy: false, messageCount: 10, lastMessageId: "m11" }),
  ]);
  assertEqual(byId.events.map((event) => event.type), ["completed"], "消息数不变但 lastMessageId 变化 = completed（分页上限兜底）");

  // 水位未初始化（注册时没给 --message-count）：listener 先初始化，不在这里误报
  const uninitialized = runSequence(makeWatch({ watermarkMessageCount: null, watermarkLastMessageId: null }), [
    snapshot({ messageCount: 42, lastMessageId: "m42" }),
  ]);
  assertEqual(uninitialized.events, [], "水位未初始化时不报 completed（由 listener 先写水位）");

  // 非 active 的 watch 一律不产生事件
  const closed = runSequence(makeWatch({ status: "done" }), [snapshot({ busy: false, messageCount: 99, lastMessageId: "m99" })]);
  assertEqual(closed.events, [], "status=done 的 watch 不产生事件");

  // 多 watch 一轮（stepAll）：同一快照 map 驱动，事件带 watchId
  const multi = stepAll(
    [makeWatch({ id: "w-a" }), makeWatch({ id: "w-b", watermarkMessageCount: 999 })],
    new Map([
      ["w-a", snapshot({ messageCount: 11, lastMessageId: "m11" })],
      ["w-b", snapshot({ needsDecision: true, messageCount: 3 })],
    ]),
  );
  assertEqual(
    multi.events.map((event) => `${event.watchId}:${event.type}`),
    ["w-a:completed", "w-b:needs-user"],
    "stepAll 一轮多 watch 的事件带 watchId",
  );
  assert(multi.watches.find((watch) => watch.id === "w-a").status === "done", "stepAll 回写每个 watch 的新状态");
}

// ---------------------------------------------------------------- 2. watch CRUD

async function testWatchCli() {
  section("watches.json CRUD（bin/watch.mjs 子进程）");
  await withTempListenerDir(async (dir) => {
    const env = { AB_LISTENER_STATE_DIR: dir, AGENT_BRIDGE_MCP_HOME: dir };

    const added = await runNode(
      [WATCH_ENTRY, "add", "--session", "sess-1", "--chat", "chat-1", "--purpose", "v2 listener 自检", "--message-count", "7"],
      { env },
    );
    assert(added.code === 0, "add 退出码 0", added.stderr);
    const addPayload = parseJson(added.stdout, "add");
    const watch = addPayload?.watch;
    assert(typeof watch?.id === "string" && /^[0-9a-f-]{36}$/.test(watch.id), "add 返回 uuid watchId", watch?.id);
    assertEqual(
      [watch?.sessionId, watch?.chatId, watch?.purpose, watch?.watermarkMessageCount],
      ["sess-1", "chat-1", "v2 listener 自检", 7],
      "add 注册字段齐全（含 --message-count 水位）",
    );
    assertEqual([watch?.lastBusy, watch?.lastNeedsDecision, watch?.status], [null, false, "active"], "add 初始化边沿字段与 status=active");

    const second = await runNode(
      [WATCH_ENTRY, "add", "--session", "sess-2", "--chat", "chat-2", "--purpose", "第二个 watch"],
      { env },
    );
    const secondPayload = parseJson(second.stdout, "add#2");
    assert(secondPayload?.watch?.watermarkMessageCount === null, "没给 --message-count 时水位为 null（listener 首轮初始化）");

    const listed = await runNode([WATCH_ENTRY, "list"], { env });
    const listPayload = parseJson(listed.stdout, "list");
    assertEqual([listPayload?.count, listPayload?.activeWatches], [2, 2], "list 返回 2 条、2 条 active");
    assert(listPayload?.stateDir === dir && listPayload?.watchesPath === join(dir, "watches.json"), "list 回报实际状态目录", listPayload);

    const done = await runNode([WATCH_ENTRY, "done", "--id", watch.id], { env });
    const donePayload = parseJson(done.stdout, "done");
    assert(done.code === 0 && donePayload?.watch?.status === "done", "done 把 status 置 done", donePayload);
    assert(donePayload?.watch?.doneBy === "watch.mjs", "done 记录 doneBy（区分手动收尾）");

    const afterDone = parseJson((await runNode([WATCH_ENTRY, "list"], { env })).stdout, "list#2");
    assertEqual([afterDone?.count, afterDone?.activeWatches], [2, 1], "done 之后 activeWatches 减一");

    const removed = await runNode([WATCH_ENTRY, "remove", "--id", watch.id], { env });
    assert(removed.code === 0 && parseJson(removed.stdout, "remove")?.removed === true, "remove 删除任意状态的 watch");
    const afterRemove = parseJson((await runNode([WATCH_ENTRY, "list"], { env })).stdout, "list#3");
    assert(afterRemove?.count === 1, "remove 之后只剩 1 条");

    const missing = await runNode([WATCH_ENTRY, "remove", "--id", "no-such-watch"], { env });
    assert(missing.code === 1, "remove 不存在的 id 退出码 1", missing.code);
    assert(parseJson(missing.stdout, "remove-missing")?.error?.code === "watch_not_found", "错误码 watch_not_found");

    const bad = await runNode([WATCH_ENTRY, "add", "--session", "sess-3"], { env });
    assert(bad.code === 2, "add 缺参数退出码 2", bad.code);
    assert(bad.stderr.includes("缺少 --chat"), "add 指出缺哪个参数", bad.stderr.split("\n")[0]);

    const badCount = await runNode(
      [WATCH_ENTRY, "add", "--session", "s", "--chat", "c", "--purpose", "p", "--message-count", "abc"],
      { env },
    );
    assert(badCount.code === 2, "--message-count 非整数退出码 2", badCount.code);

    const unknownVerb = await runNode([WATCH_ENTRY, "explode"], { env });
    assert(unknownVerb.code === 2, "未知动词退出码 2", unknownVerb.code);

    const fileMode = (await stat(listenerPaths().watches)).mode & 0o777;
    assert(fileMode === 0o600, "watches.json 权限 0600（实测）", fileMode.toString(8));
    const dirMode = (await stat(dir)).mode & 0o777;
    assert(dirMode === 0o700, "listener 状态目录权限 0700（实测）", dirMode.toString(8));
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
    assertEqual(leftovers, [], "原子写不留 tmp 文件");

    const reloaded = await loadWatches();
    assert(reloaded.watches.length === 1 && reloaded.watches[0].id === secondPayload.watch.id, "loadWatches 读回剩余 watch");
    assert(reloaded.version === 1 && typeof reloaded.updatedAt === "string", "watches.json 带 version/updatedAt");
  });
}

// ---------------------------------------------------------------- 3. 事件 + drain

function makeEvent(overrides = {}) {
  return {
    id: `evt-${overrides.n ?? 1}`,
    ts: "2026-11-22T00:00:00.000Z",
    type: "completed",
    watchId: "watch-1",
    sessionId: "session-1",
    chatId: "chat-1",
    purpose: "v2 listener 自检",
    messageCount: 12,
    ...overrides,
  };
}

async function testEventsAndDrain() {
  section("events.jsonl 追加与 drain 游标");
  await withTempListenerDir(async (dir) => {
    const env = { AB_LISTENER_STATE_DIR: dir, AGENT_BRIDGE_MCP_HOME: dir };
    const paths = listenerPaths();

    const empty = await runNode([DRAIN_ENTRY], { env });
    assert(empty.code === 0 && empty.stdout === "", "没有事件时 drain 不打印、退出 0", empty);
    assert((await readDrainCursor()).lastEventId === null, "没有事件时不写游标");

    await ensureListenerStateDir();
    await appendEvent(paths.events, makeEvent({ n: 1 }));
    await appendEvent(paths.events, makeEvent({ n: 2, type: "needs-user", messageCount: null }));
    await appendEvent(paths.events, {
      ...makeEvent({ n: 3, type: "gone", messageCount: null }),
      purpose: "多行\n用途   带空白",
    });
    const eventsMode = (await stat(paths.events)).mode & 0o777;
    assert(eventsMode === 0o600, "events.jsonl 权限 0600（实测）", eventsMode.toString(8));

    const first = await runNode([DRAIN_ENTRY], { env });
    assert(first.code === 0, "drain 退出码 0", first.stderr);
    const lines = first.stdout.trimEnd().split("\n");
    assertEqual(lines.length, 3, "一次 drain 打印 3 行");
    assertEqual(
      lines[0],
      "[agent-bridge] completed · v2 listener 自检 · session session-1 · chat chat-1",
      "completed 事件格式符合契约",
    );
    assertEqual(
      lines[1],
      "[agent-bridge] needs-user · v2 listener 自检 · session session-1 · chat chat-1",
      "needs-user 事件类型原样输出",
    );
    assert(lines[2].includes("[agent-bridge] gone · 多行 用途 带空白 · session session-1 · chat chat-1"), "purpose 里的换行/空白被压成一行", lines[2]);
    assert((await readDrainCursor()).lastEventId === "evt-3", "游标推进到已打印的最后一条");

    const second = await runNode([DRAIN_ENTRY], { env });
    assert(second.code === 0 && second.stdout === "", "游标之后没有事件时 drain 静默退出 0", second);
    assert((await readDrainCursor()).lastEventId === "evt-3", "静默 drain 不改游标");

    await appendEvent(paths.events, makeEvent({ n: 4 }));
    const peek = await runNode([DRAIN_ENTRY, "--peek"], { env });
    assert(peek.stdout.trimEnd().split("\n").length === 1, "--peek 打印新事件", peek.stdout);
    assert((await readDrainCursor()).lastEventId === "evt-3", "--peek 不推进游标");
    const peekAgain = await runNode([DRAIN_ENTRY, "--peek"], { env });
    assert(peekAgain.stdout === peek.stdout, "--peek 可重复干跑（同一事件重复打印）");
    const delivery = await runNode([DRAIN_ENTRY], { env });
    assert(delivery.stdout === peek.stdout, "正式 drain 打印与 --peek 相同的内容");
    assert((await readDrainCursor()).lastEventId === "evt-4", "正式 drain 推进游标");

    const badFlag = await runNode([DRAIN_ENTRY, "--nope"], { env });
    assert(badFlag.code === 2, "未知参数退出码 2", badFlag.code);

    // 游标 id 在事件文件里找不到（文件被清/轮转）→ 全部重投，不静默吞掉。
    await writeFile(paths.drainCursor, `${JSON.stringify({ version: 1, lastEventId: "evt-gone", updatedAt: null })}\n`, { mode: 0o600 });
    const replay = await runNode([DRAIN_ENTRY], { env });
    assert(replay.stdout.trimEnd().split("\n").length === 4, "游标失效时所有事件重投（宁可多报不可漏报）", replay.stdout);
  });
}

// ---------------------------------------------------------------- 4. listener 轮询周期

function messageRecord(messageId, createdAt) {
  return { messageId, sessionId: "unused", role: "assistant", createdAt, blocks: [{ type: "text", text: messageId }] };
}

async function testListenerCycle() {
  section("listener 轮询周期（runCycle + 假 bridge）");
  await withTempListenerDir(async (dir) => {
    await ensureListenerStateDir();
    const env = { AB_LISTENER_STATE_DIR: dir, AGENT_BRIDGE_MCP_HOME: dir };
    const paths = listenerPaths();

    const addWatch = async (args) => {
      const result = await runNode([WATCH_ENTRY, "add", ...args], { env });
      assert(result.code === 0, `runCycle 用例 add ${args.filter((item) => item.startsWith("sess-")).join("")} 成功`, result.stderr);
      return parseJson(result.stdout, "cycle-add").watch;
    };
    const sessions = new Map();
    const messages = new Map();
    const failingMessageList = new Set();
    const link = {
      async call(method, params) {
        if (method === "session.list") return { sessions: [...sessions.values()], completeness: "complete" };
        if (method === "message.list") {
          if (failingMessageList.has(params.sessionId)) throw new Error("message.list 模拟失败");
          const list = messages.get(params.sessionId) ?? [];
          return { messages: list.slice(Math.max(0, list.length - (params.limit ?? list.length))), completeness: "complete" };
        }
        throw new Error(`runCycle 不应调用 ${method}`);
      },
    };
    const readHeartbeat = async () => JSON.parse(await readFile(paths.heartbeat, "utf8"));
    const eventCount = async () => (await readEvents(paths.events)).length;

    // --- completed：busy 落 + 增长
    const watchA = await addWatch([
      "--session", "sess-a", "--chat", "chat-a", "--purpose", "P900 · 完成边沿", "--message-count", "2",
    ]);
    sessions.set("sess-a", { sessionId: "sess-a", busy: true, needsDecision: false });
    messages.set("sess-a", [messageRecord("m1", 1), messageRecord("m2", 2)]);
    await runCycle(link);
    assert((await eventCount()) === 0, "busy=true 且无增长：不写事件");
    const heartbeat = await readHeartbeat();
    assertEqual([heartbeat.connected, heartbeat.activeWatches], [true, 1], "heartbeat：connected + 1 个 active watch");

    sessions.set("sess-a", { sessionId: "sess-a", busy: false, needsDecision: false });
    messages.set("sess-a", [messageRecord("m1", 1), messageRecord("m2", 2), messageRecord("m3", 3)]);
    await runCycle(link);
    const eventsA = await readEvents(paths.events);
    assertEqual(eventsA.map((event) => event.type), ["completed"], "busy 落 + 增长 → 写一条 completed 事件");
    assertEqual(
      [eventsA[0].watchId, eventsA[0].sessionId, eventsA[0].chatId, eventsA[0].purpose, eventsA[0].messageCount],
      [watchA.id, "sess-a", "chat-a", "P900 · 完成边沿", 3],
      "completed 事件字段完整（含 messageCount）",
    );
    assert(typeof eventsA[0].ts === "string" && typeof eventsA[0].id === "string", "事件带 id 与 ISO 时间戳");
    const afterA = (await loadWatches()).watches.find((watch) => watch.id === watchA.id);
    assertEqual([afterA.status, afterA.sessionId, afterA.chatId, afterA.purpose], ["done", "sess-a", "chat-a", "P900 · 完成边沿"], "completed 后 watch=done 且注册字段不被覆盖");
    assertEqual([afterA.lastBusy, afterA.missingPolls], [false, 0], "listener 独占字段落盘");
    await runCycle(link);
    assert((await eventCount()) === 1, "completed 只报一次（后续轮询不重复）");
    assert((await readHeartbeat()).activeWatches === 0, "done 后 heartbeat 的 activeWatches 归零");

    // --- needs-user：上升触发、保持不重复、回落重新武装
    await addWatch(["--session", "sess-b", "--chat", "chat-b", "--purpose", "P901 · 提问边沿", "--message-count", "50"]);
    sessions.set("sess-b", { sessionId: "sess-b", busy: true, needsDecision: false });
    messages.set("sess-b", [messageRecord("b1", 1)]);
    await runCycle(link);
    sessions.set("sess-b", { sessionId: "sess-b", busy: true, needsDecision: true });
    await runCycle(link);
    await runCycle(link);
    let events = await readEvents(paths.events);
    assertEqual(events.filter((event) => event.type === "needs-user").length, 1, "needsDecision 上升只报一次 needs-user");
    assert((await loadWatches()).watches.find((watch) => watch.sessionId === "sess-b").status === "active", "needs-user 不关闭 watch");
    sessions.set("sess-b", { sessionId: "sess-b", busy: true, needsDecision: false });
    await runCycle(link);
    sessions.set("sess-b", { sessionId: "sess-b", busy: true, needsDecision: true });
    await runCycle(link);
    events = await readEvents(paths.events);
    assertEqual(events.filter((event) => event.type === "needs-user").length, 2, "needsDecision 回落再上升 = 第二次 needs-user");

    // --- gone：连续 3 次不在 session.list
    await addWatch(["--session", "sess-gone", "--chat", "chat-g", "--purpose", "P902 · 消失边沿", "--message-count", "1"]);
    await runCycle(link);
    await runCycle(link);
    assert((await readEvents(paths.events)).filter((event) => event.type === "gone").length === 0, "连续 2 次缺席不报 gone");
    await runCycle(link);
    assertEqual(
      (await readEvents(paths.events)).filter((event) => event.type === "gone").map((event) => event.sessionId),
      ["sess-gone"],
      "连续 3 次缺席写一条 gone",
    );

    // --- 水位初始化：没给 --message-count 时首轮只记水位，不把历史消息当产出
    await addWatch(["--session", "sess-d", "--chat", "chat-d", "--purpose", "P903 · 水位初始化"]);
    sessions.set("sess-d", { sessionId: "sess-d", busy: false, needsDecision: false });
    messages.set("sess-d", [messageRecord("d1", 1), messageRecord("d2", 2)]);
    await runCycle(link);
    const initialized = (await loadWatches()).watches.find((watch) => watch.sessionId === "sess-d");
    assertEqual([initialized.watermarkMessageCount, initialized.watermarkLastMessageId], [2, "d2"], "首轮用当时消息数/最新 id 初始化水位");
    assertEqual((await readEvents(paths.events)).filter((event) => event.watchId === initialized.id), [], "水位初始化本身不产生事件");
    messages.set("sess-d", [messageRecord("d1", 1), messageRecord("d2", 2), messageRecord("d3", 3)]);
    await runCycle(link);
    assertEqual(
      (await readEvents(paths.events)).filter((event) => event.watchId === initialized.id).map((event) => event.type),
      ["completed"],
      "水位之后有增长 → completed",
    );

    // --- 读消息失败不能被当成「消失」
    await addWatch(["--session", "sess-err", "--chat", "chat-err", "--purpose", "P904 · 读失败", "--message-count", "1"]);
    sessions.set("sess-err", { sessionId: "sess-err", busy: true, needsDecision: false });
    messages.set("sess-err", [messageRecord("e1", 1)]);
    failingMessageList.add("sess-err");
    await runCycle(link);
    await runCycle(link);
    await runCycle(link);
    const errored = (await loadWatches()).watches.find((watch) => watch.sessionId === "sess-err");
    assertEqual([errored.status, errored.missingPolls ?? 0], ["active", 0], "message.list 失败不计入缺席、不报 gone");
    assert((await readEvents(paths.events)).every((event) => event.sessionId !== "sess-err"), "读失败不产生事件");
    failingMessageList.delete("sess-err");
    sessions.set("sess-err", { sessionId: "sess-err", busy: false, needsDecision: false });
    messages.set("sess-err", [messageRecord("e1", 1), messageRecord("e2", 2)]);
    await runCycle(link);
    assertEqual(
      (await readEvents(paths.events)).filter((event) => event.sessionId === "sess-err").map((event) => event.type),
      ["completed"],
      "读恢复后照常检出 completed",
    );
  });
}

// ---------------------------------------------------------------- 4. listener 行为

async function testListenerGuards() {
  section("listener 未配对 / 单实例守卫");

  const unpairedDir = await mkdtemp(join(tmpdir(), "agent-bridge-listener-unpaired-"));
  try {
    const unpaired = await runNode([LISTENER_ENTRY], {
      env: { AB_LISTENER_STATE_DIR: unpairedDir, AGENT_BRIDGE_MCP_HOME: unpairedDir },
      timeoutMs: 20_000,
    });
    assert(unpaired.code === 2, "未配对时 listener 退出码 2", unpaired.code);
    assert(unpaired.stderr.includes("pair.mjs"), "未配对时打印配对命令", unpaired.stderr.split("\n")[0]);
    assert(unpaired.stderr.includes("--state-dir"), "配对指引包含 --state-dir（独立设备身份）");
    assert(unpaired.stderr.includes("Muse (MCP) Listener"), "配对指引包含 listener 设备名");
    assert((await readFile(join(unpairedDir, "listener.pid"), "utf8").catch(() => null)) === null, "未配对退出时清掉 pidfile");
  } finally {
    await rm(unpairedDir, { recursive: true, force: true });
  }

  const busyDir = await mkdtemp(join(tmpdir(), "agent-bridge-listener-busy-"));
  try {
    await writeFile(join(busyDir, "listener.pid"), `${process.pid}\n`, { mode: 0o600 });
    const duplicated = await runNode([LISTENER_ENTRY], {
      env: { AB_LISTENER_STATE_DIR: busyDir, AGENT_BRIDGE_MCP_HOME: busyDir },
      timeoutMs: 20_000,
    });
    assert(duplicated.code === 3, "已有实例在跑时 listener 退出码 3", duplicated.code);
    assert(duplicated.stderr.includes("已在运行"), "单实例守卫给出明确原因", duplicated.stderr.split("\n")[0]);
    assert((await readFile(join(busyDir, "listener.pid"), "utf8")).trim() === String(process.pid), "被拒绝的启动不覆盖别人的 pidfile");
  } finally {
    await rm(busyDir, { recursive: true, force: true });
  }
}

async function testLauncher() {
  section("bin/listener.sh start/stop/status");
  await withTempListenerDir(async (dir) => {
    const env = { AB_LISTENER_STATE_DIR: dir, AGENT_BRIDGE_MCP_HOME: dir };

    const status = await runBash([LISTENER_SH, "status"], { env });
    assert(status.code === 0, "status 退出码 0", status.stderr);
    const statusPayload = parseJson(status.stdout, "status");
    assertEqual([statusPayload?.running, statusPayload?.pid, statusPayload?.heartbeat], [false, null, null], "没有实例时 status = running:false");
    assert(statusPayload?.stateDir === dir, "status 回报实际状态目录");

    const stopIdle = await runBash([LISTENER_SH, "stop"], { env });
    assert(stopIdle.code === 0, "stop 在没运行时也是 0", stopIdle.code);

    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await writeFile(join(dir, "listener.pid"), `${sleeper.pid}\n`, { mode: 0o600 });
      await writeFile(
        join(dir, "heartbeat.json"),
        `${JSON.stringify({ ts: "2026-11-22T00:00:00.000Z", connected: true, activeWatches: 2 })}\n`,
        { mode: 0o600 },
      );
      const startAgain = await runBash([LISTENER_SH, "start"], { env });
      assert(startAgain.code === 0, "已在运行时 start 退出码 0", startAgain.stderr);
      assert(startAgain.stdout.includes("已在运行"), "已在运行时 start 是 no-op", startAgain.stdout);
      const runningPayload = parseJson(startAgain.stdout.slice(startAgain.stdout.indexOf("{")), "start-status");
      assertEqual([runningPayload?.running, runningPayload?.pid], [true, sleeper.pid], "start 打印的运行状态与实际 pid 一致");
      assert(runningPayload?.heartbeat?.activeWatches === 2, "status 透出 heartbeat 内容");
    } finally {
      sleeper.kill("SIGKILL");
      await rm(join(dir, "listener.pid"), { force: true });
    }

    const badCommand = await runBash([LISTENER_SH, "explode"], { env });
    assert(badCommand.code === 2, "未知子命令退出码 2", badCommand.code);
  });
}

async function main() {
  console.log(`Agent Bridge MCP v2 listener selftest · node ${process.version}`);
  testEdges();
  await testWatchCli();
  await testEventsAndDrain();
  await testListenerCycle();
  await testListenerGuards();
  await testLauncher();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n共 ${results.length} 项断言，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const item of failed) console.error(`  ✗ ${item.label}`);
    process.exit(1);
  }
  console.log("SELFTEST PASS");
  // 统一收尾：万一有子进程/监听器残留，不阻塞退出。
  await sleep(0);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nSELFTEST FAIL: ${error?.stack ?? error}`);
    process.exit(1);
  });
}

export { main };
