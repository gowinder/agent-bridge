import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedSessionManager } from "../dist/hosted/manager.js";

// 托管 codex 会去找 codex 可执行文件：测试里指向 node 自己，进程是假的，只要路径存在。
process.env.AGENT_BRIDGE_CODEX_PATH = process.execPath;

const THREAD = "0190aabb-ccdd-7ee0-8f11-223344556677";
const TURN = "0190aabb-9999-7000-8111-223344556677";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 6161;
    this.chunks = [];
    this.signals = [];
    this.stdin = {
      write: (chunk) => {
        this.chunks.push(chunk);
        return true;
      },
      end: () => undefined,
    };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    this.emit("exit", 0, null);
    return true;
  }

  emitJson(payload) {
    this.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  }

  writes() {
    return this.chunks.map((chunk) => JSON.parse(chunk.trim()));
  }
}

function harness(stateDir) {
  const root = mkdtempSync(join(tmpdir(), "codex-appserver-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const dir = stateDir ?? join(root, "state");
  mkdirSync(dir, { recursive: true });
  if (!stateDir) {
    writeFileSync(join(dir, "hosted.json"), JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000 }));
  }
  const spawns = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    spawns.push({ command, args, options, child });
    return child;
  };
  const manager = new HostedSessionManager({ stateDir: dir, spawn });
  return { root, repo, stateDir: dir, spawns, manager };
}

async function waitFor(check, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`没有等到 ${label}`);
}

/** 等到第 index 条某个方法（0 起）：握手是两条消息一来一回，顺序不能猜。 */
function writeOf(child, method, index = 0) {
  return child.writes().filter((item) => item.method === method)[index];
}

async function waitWrite(child, method, index = 0) {
  return waitFor(() => writeOf(child, method, index), `第 ${index + 1} 条 ${method}`);
}

/** 回一条 codex 请求的回执；回执 id 必须对上请求的 id，否则协议客户端只会当超时。 */
async function reply(child, method, result) {
  const request = await waitWrite(child, method, writeIndexOf(child, method));
  child.emitJson({ id: request.id, result });
  return request;
}

function writeIndexOf(child, method) {
  return Math.max(0, child.writes().filter((item) => item.method === method).length - 1);
}

/** 走完「握手 + 建线程」：之后才能发消息。 */
async function handshake(child, thread = { id: THREAD }) {
  const init = await waitWrite(child, "initialize");
  child.emitJson({ id: init.id, result: { userAgent: "codex-appserver-test" } });
  await waitWrite(child, "initialized");
  const start = await waitWrite(child, "thread/start");
  child.emitJson({ id: start.id, result: { thread } });
  return start;
}

function lastMessage(manager, sessionId, predicate) {
  const list = manager.messagesFor(sessionId, { limit: 50 }).messages;
  return [...list].reverse().find(predicate);
}

test("create spawns app-server, initializes with the bridge client name and starts a thread", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver", title: "codex 活验" });
  assert.equal(session.hostedAgent, "codex-appserver");
  assert.equal(session.hosted, true);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0].args, ["app-server", "--listen", "stdio://"]);
  assert.equal(h.spawns[0].options.cwd, realpathSync(h.repo));

  const init = await waitWrite(h.spawns[0].child, "initialize");
  // 线程的 originator 用的是这个名字：桌面 app 里能区分「谁建的」。
  assert.equal(init.params.clientInfo.name, "agent-bridge");
  assert.equal(typeof init.params.clientInfo.version, "string");
  h.spawns[0].child.emitJson({ id: init.id, result: {} });

  await waitFor(() => writeOf(h.spawns[0].child, "initialized"), "initialized 通知");
  const start = await waitWrite(h.spawns[0].child, "thread/start");
  assert.equal(start.params.cwd, realpathSync(h.repo));
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "on-request");
  // 本机 config.toml 可能把审批路由设成 auto_review：必须显式要求路由到人。
  assert.equal(start.params.approvalsReviewer, "user");
  // 防扫描准则走 developerInstructions（codex 没有 --append-system-prompt）。
  assert.match(start.params.developerInstructions, /不要递归扫描用户主目录/);

  h.spawns[0].child.emitJson({ id: start.id, result: { thread: { id: THREAD, cwd: realpathSync(h.repo) } } });
  // 线程 id 记进会话记录：重启后要靠它续上同一条线程。
  const nameRequest = await waitWrite(h.spawns[0].child, "thread/name/set");
  assert.equal(nameRequest.params.name, "codex 活验");
  h.spawns[0].child.emitJson({ id: nameRequest.id, result: {} });
  const registry = await waitFor(() => {
    const raw = JSON.parse(readFileSync(join(h.stateDir, "hosted", "sessions.json"), "utf8"));
    return raw.sessions.find((item) => item.codexThreadId === THREAD);
  }, "codexThreadId 落盘");
  assert.equal(registry.agent, "codex-appserver");
});

test("a turn streams deltas into one assistant message and turn/completed ends it", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "回一句 APPSERVER-OK");
  await handshake(child);
  const turnStart = await reply(child, "turn/start", { turn: { id: TURN } });
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "回一句 APPSERVER-OK" }]);
  assert.equal(turnStart.params.threadId, THREAD);
  assert.equal((await sending).accepted, true);
  // 一轮没结束前侧栏要显示「运行中」。
  assert.equal(h.manager.session(session.sessionId).busy, true);

  child.emitJson({ method: "item/started", params: { item: { type: "agentMessage", id: "m1", text: "" }, threadId: THREAD, turnId: TURN } });
  child.emitJson({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "APPSERVER", threadId: THREAD, turnId: TURN } });
  child.emitJson({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "-OK", threadId: THREAD, turnId: TURN } });
  child.emitJson({
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "m1", text: "" }, threadId: THREAD, turnId: TURN },
  });

  const assistant = await waitFor(
    () => lastMessage(h.manager, session.sessionId, (item) => item.role === "assistant" && item.blocks[0]?.type === "text"),
    "助手消息",
  );
  // 分片的 delta 要拼成一条，不能一段一条消息。
  assert.deepEqual(assistant.blocks, [{ type: "text", text: "APPSERVER-OK" }]);

  child.emitJson({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed", error: null } } });
  await waitFor(() => h.manager.session(session.sessionId).busy === false, "回合收尾");
  const raw = JSON.parse(readFileSync(join(h.stateDir, "hosted", "sessions.json"), "utf8"));
  assert.equal(raw.sessions.find((item) => item.codexThreadId === THREAD)?.pendingText, undefined);
});

test("tool items show up as tool blocks like the other hosted engines", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "跑一下测试");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;

  child.emitJson({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "c1",
        command: "npm run check",
        exitCode: 1,
        status: "failed",
        cwd: realpathSync(h.repo),
      },
      threadId: THREAD,
      turnId: TURN,
    },
  });
  const tool = await waitFor(
    () => lastMessage(h.manager, session.sessionId, (item) => item.blocks[0]?.type === "tool"),
    "工具消息",
  );
  assert.equal(tool.blocks[0].text, "Bash npm run check（退出码 1）");

  // 用户消息也会以 item 形式回放：不能画成工具活动。
  child.emitJson({
    method: "item/completed",
    params: {
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "跑一下测试" }] },
      threadId: THREAD,
      turnId: TURN,
    },
  });
  child.emitJson({
    method: "item/completed",
    params: { item: { type: "reasoning", id: "r1", summary: [] }, threadId: THREAD, turnId: TURN },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const toolTexts = h.manager
    .messagesFor(session.sessionId, { limit: 50 })
    .messages.filter((item) => item.blocks[0]?.type === "tool")
    .map((item) => item.blocks[0].text);
  assert.deepEqual(toolTexts, ["Bash npm run check（退出码 1）"]);
});

test("an approval request becomes a pending block and the answer goes back over the wire", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "清理产物目录");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;

  // codex 的审批是反方向的请求（server→client）：不应答就会一直挂着。
  child.emitJson({
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "c1",
      threadId: THREAD,
      turnId: TURN,
      startedAtMs: Date.now(),
      command: "rm -rf build",
      reason: "清理产物",
    },
  });
  const pending = await waitFor(
    () => lastMessage(h.manager, session.sessionId, (item) => item.blocks[0]?.type === "next-step"),
    "待批准消息",
  );
  assert.equal(pending.blocks[0].text, "rm -rf build");
  assert.match(pending.blocks[0].ask, /允许执行这条命令吗/);
  assert.equal(pending.blocks[0].pending, true);
  assert.equal(h.manager.session(session.sessionId).needsDecision, true);

  await h.manager.send(session.sessionId, "允许");
  const answer = await waitFor(
    () => child.writes().find((item) => item.id === 77 && item.result),
    "审批应答",
  );
  assert.deepEqual(answer.result, { decision: "accept" });
  // 批准之后这一轮还在跑，不能提前当成结束。
  assert.equal(h.manager.session(session.sessionId).needsDecision, false);
});

test("declining an approval answers decline and keeps the turn running", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "改文件");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;

  child.emitJson({
    id: 88,
    method: "item/fileChange/requestApproval",
    params: { itemId: "f1", threadId: THREAD, turnId: TURN, startedAtMs: Date.now(), grantRoot: null },
  });
  await waitFor(
    () => lastMessage(h.manager, session.sessionId, (item) => item.blocks[0]?.type === "next-step"),
    "待批准消息",
  );
  await h.manager.send(session.sessionId, "拒绝");
  const answer = await waitFor(() => child.writes().find((item) => item.id === 88 && item.result), "审批应答");
  assert.deepEqual(answer.result, { decision: "decline" });
  assert.equal(h.manager.session(session.sessionId).busy, true);
});

test("interrupt sends turn/interrupt instead of killing the process", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "长任务");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;

  const result = h.manager.interrupt(session.sessionId);
  assert.equal(result.interrupted, true);
  const interrupt = await waitFor(() => writeOf(child, "turn/interrupt"), "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: THREAD, turnId: TURN });
  // 进程要留着：停的只是这一轮。
  assert.deepEqual(child.signals, []);
  const notice = await waitFor(
    () => lastMessage(h.manager, session.sessionId, (item) => item.role === "system"),
    "停止提示",
  );
  assert.equal(notice.blocks[0].text, "已停止当前回合");

  // codex 随后报 interrupted：记录里保持「已中断」，但不能再写一条系统消息。
  child.emitJson({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "interrupted" } } });
  await waitFor(() => h.manager.session(session.sessionId).busy === false, "回合收尾");
});

test("stop interrupts the running turn before closing the process", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  const sending = h.manager.send(session.sessionId, "长任务");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;

  // 真 codex 会回 turn/interrupt 的回执；这里替它回，别让停止流程白等 5 秒。
  const answered = new Set();
  const ticker = setInterval(() => {
    for (const write of child.writes()) {
      if (write.method !== "turn/interrupt" || answered.has(write.id)) continue;
      answered.add(write.id);
      child.emitJson({ id: write.id, result: {} });
    }
  }, 5);
  await h.manager.stop(session.sessionId);
  clearInterval(ticker);
  assert.ok(writeOf(child, "turn/interrupt"), "应当先 turn/interrupt");
  assert.ok(child.signals.includes("SIGTERM"), "之后再关进程");
});

test("a resumed session reuses the recorded thread id, and adopt takes a given thread", async (t) => {
  const first = harness();
  const session = first.manager.create({ path: first.repo, agent: "codex-appserver" });
  const child = first.spawns[0].child;
  const sending = first.manager.send(session.sessionId, "第一轮");
  await handshake(child);
  await reply(child, "turn/start", { turn: { id: TURN } });
  await sending;
  child.emitJson({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } });
  await waitFor(() => first.manager.session(session.sessionId).busy === false, "回合收尾");
  first.manager.dispose();

  // 换个进程重启 Bridge：记录里的线程 id 要读回来，续的是同一条线程。
  const second = harness(first.stateDir);
  t.after(() => second.manager.dispose());
  second.manager.setDirs([second.repo]);
  second.manager.resume(session.sessionId);
  const resumedChild = second.spawns[0].child;
  const init = await waitWrite(resumedChild, "initialize");
  resumedChild.emitJson({ id: init.id, result: {} });
  await waitWrite(resumedChild, "initialized");
  const resume = await waitWrite(resumedChild, "thread/resume");
  assert.equal(resume.params.threadId, THREAD);
  assert.equal(resume.params.excludeTurns, true);
  assert.equal(writeOf(resumedChild, "thread/start"), undefined);
});

test("adopt resumes a thread given at creation, and rejects one outside the allowlist", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver", threadId: THREAD });
  const child = h.spawns[0].child;
  const init = await waitWrite(child, "initialize");
  child.emitJson({ id: init.id, result: {} });
  await waitWrite(child, "initialized");
  const resume = await waitWrite(child, "thread/resume");
  assert.equal(resume.params.threadId, THREAD);
  child.emitJson({ id: resume.id, result: { thread: { id: THREAD, cwd: realpathSync(h.repo) } } });
  await reply(child, "thread/turns/list", { data: [], nextCursor: null });
  // 线程 id 不合法直接拒绝，别把任意字符串送进 thread/resume。
  assert.throws(
    () => h.manager.create({ path: h.repo, agent: "codex-appserver", threadId: "../../etc/passwd" }),
    /线程 id 不合法/,
  );
  assert.equal(h.manager.session(session.sessionId).hostedAgent, "codex-appserver");
});

test("taking over a thread imports codex's own history into the transcript", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver", threadId: THREAD });
  const child = h.spawns[0].child;
  const init = await waitWrite(child, "initialize");
  child.emitJson({ id: init.id, result: {} });
  await waitWrite(child, "initialized");
  const resume = await waitWrite(child, "thread/resume");
  child.emitJson({ id: resume.id, result: { thread: { id: THREAD, cwd: realpathSync(h.repo) } } });
  const listed = await waitWrite(child, "thread/turns/list");
  assert.equal(listed.params.itemsView, "full");
  assert.equal(listed.params.sortDirection, "asc");
  child.emitJson({
    id: listed.id,
    result: {
      data: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "userMessage", id: "u1", content: [{ type: "text", text: "接管前的提问" }], startedAtMs: 1_700_000_000_000 },
            { type: "reasoning", id: "r1", summary: ["想一想"], content: [] },
            { type: "agentMessage", id: "a1", text: "接管前的回答", startedAtMs: 1_700_000_001_000 },
            { type: "commandExecution", id: "c1", command: "ls -la", exitCode: 0, startedAtMs: 1_700_000_002_000 },
          ],
        },
      ],
      nextCursor: null,
    },
  });
  const messages = await waitFor(
    () => {
      const list = h.manager.messagesFor(session.sessionId, { limit: 50 }).messages;
      return list.length >= 3 ? list : null;
    },
    "导入历史",
  );
  assert.deepEqual(
    messages.map((item) => [item.role, item.blocks.map((block) => block.type)]),
    [
      ["user", ["text"]],
      ["assistant", ["text"]],
      ["assistant", ["tool"]],
    ],
  );
  assert.equal(messages[0].blocks[0].text, "接管前的提问");
  assert.equal(messages[1].blocks[0].text, "接管前的回答");
  assert.match(messages[2].blocks[0].text, /^Bash ls -la/);
});

test("context usage uses the last turn snapshot, not the cumulative total", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "codex-appserver" });
  const child = h.spawns[0].child;
  await handshake(child);
  child.emitJson({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: { totalTokens: 28_000_000, inputTokens: 27_500_000, cachedInputTokens: 27_000_000, cacheWriteInputTokens: 0, outputTokens: 500_000, reasoningOutputTokens: 0 },
        last: { totalTokens: 13_500, inputTokens: 12_000, cachedInputTokens: 10_000, cacheWriteInputTokens: 0, outputTokens: 1_500, reasoningOutputTokens: 0 },
        modelContextWindow: 475_000,
      },
    },
  });
  const context = await waitFor(
    () => h.manager.messagesFor(session.sessionId, { limit: 10 }).context,
    "上下文用量",
  );
  assert.equal(context.usedTokens, 12_000);
  assert.equal(context.windowTokens, 475_000);
  assert.equal(context.windowEstimated, undefined);
});
