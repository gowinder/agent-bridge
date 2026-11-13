import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedSessionManager } from "../dist/hosted/manager.js";
import { SessiondClient } from "../dist/hosted/sessiond/client.js";
import { startSessiondServer } from "../dist/hosted/sessiond/server.js";

/**
 * 假 CLI：忽略参数，按 stream-json 回显用户消息；SIGUSR2 用来在 Bridge 断开时
 * 触发一段输出（模拟一轮还在跑），收到 control_response 时发 result 收尾。
 */
const FAKE_CLI = `#!/usr/bin/env node
let buffer = "";
let offline = 0;
const out = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });

process.on("SIGUSR2", () => {
  offline += 1;
  say("离线输出 " + offline);
});

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === "control_response") {
      out({ type: "result", is_error: false, result: "answered" });
      continue;
    }
    if (message.type !== "user") continue;
    const text = message.message?.content?.[0]?.text ?? "";
    if (text === "permission") {
      out({
        type: "control_request",
        request_id: "req-recover",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la" } },
      });
      continue;
    }
    say("echo " + text);
    out({ type: "result", is_error: false, result: "ok" });
  }
});
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 旧版守护进程：hello 一律回版本错误，收到 shutdown 才退出并删掉 socket 文件。 */
const OLD_SESSIOND = `#!/usr/bin/env node
import { createServer } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const [socketPath] = process.argv.slice(2);
mkdirSync(dirname(socketPath), { recursive: true });
const server = createServer((socket) => {
  socket.on("data", (chunk) => {
    for (const line of chunk.toString().split("\\n")) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.op === "hello") {
        socket.write(JSON.stringify({ id: message.id, ok: false, error: "version" }) + "\\n");
      } else if (message.op === "shutdown") {
        server.close(() => {
          try { unlinkSync(socketPath); } catch {}
          process.exit(0);
        });
      }
    }
  });
});
server.listen(socketPath);
`;

async function waitFor(predicate, label, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

async function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "sessiond-bridge-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(stateDir);
  const cli = join(root, "fake-claude.mjs");
  writeFileSync(cli, FAKE_CLI, { mode: 0o755 });
  chmodSync(cli, 0o755);
  writeFileSync(
    join(stateDir, "hosted.json"),
    JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000, cliPath: cli }),
  );
  // 真实的守护进程：Bridge 侧只负责连接，子进程由它持有。
  const server = await startSessiondServer({ stateDir, log: () => {} });
  t.after(() => server.close());
  return { root, repo, stateDir, cli, server };
}

function managerFor(stateDir) {
  return new HostedSessionManager({ stateDir, log: () => {} });
}

function textsOf(manager, sessionId) {
  return manager
    .messagesFor(sessionId, { limit: 200 })
    .messages.flatMap((message) => message.blocks.map((block) => block.text));
}

function processLabel(manager, sessionId) {
  return manager.rail(sessionId).environment.find((item) => item.label === "进程")?.value ?? "";
}

function pidOf(manager, sessionId) {
  const match = /pid (\d+)/.exec(processLabel(manager, sessionId));
  assert.ok(match, `没有 pid：${processLabel(manager, sessionId)}`);
  return Number(match[1]);
}

function sessionUuid(sessionId) {
  return sessionId.replace(/^hosted:/, "");
}

/** socket 文件出现不等于已经能连：真正握手成功一次再让 Bridge 去连，避免抢跑。 */
async function waitForListener(socketPath, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await SessiondClient.connect(socketPath, 200, { hello: false });
      probe.close();
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`守护进程没有开始监听：${socketPath}`);
}

/** 新版守护进程是 bridge 在后台拉起的：握手成功之前一直重试。 */
async function connectEventually(socketPath, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await SessiondClient.connect(socketPath, 500);
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError ?? new Error(`连接失败：${socketPath}`);
}

test("sessiond 托管：stdout 带 seq，stdin 写入能到子进程", async (t) => {
  const h = await harness(t);
  const manager = managerFor(h.stateDir);
  t.after(() => manager.dispose());
  const session = manager.create({ path: h.repo });
  await manager.send(session.sessionId, "你好");

  await waitFor(() => textsOf(manager, session.sessionId).includes("echo 你好"), "子进程回显");
  assert.deepEqual(
    manager.messagesFor(session.sessionId, { limit: 50 }).messages.map((message) => message.role),
    ["user", "assistant"],
  );

  // pid 来自 sessiond 的 start 回执：证明进程确实由守护进程持有。
  assert.match(processLabel(manager, session.sessionId), /运行中（pid \d+）/);

  // 注册表里的 stdoutSeq 推进过，说明 manager 收到了带 seq 的 stdout 并落了盘。
  const registry = JSON.parse(readFileSync(join(h.stateDir, "hosted", "sessions.json"), "utf8"));
  assert.ok(registry.sessions[0].stdoutSeq >= 1, JSON.stringify(registry));
});

test("Bridge 重启：attach 补上断线期间的输出，live 恢复", async (t) => {
  const h = await harness(t);
  const first = managerFor(h.stateDir);
  t.after(() => first.dispose());
  const session = first.create({ path: h.repo });
  await first.send(session.sessionId, "第一轮");
  await waitFor(() => textsOf(first, session.sessionId).includes("echo 第一轮"), "首轮回显");
  const pid = pidOf(first, session.sessionId);

  // 模拟 Bridge 退出：只断开 socket，sessiond 里的子进程继续跑。
  first.exitHandler();
  process.kill(pid, "SIGUSR2");
  await delay(150);
  process.kill(pid, "SIGUSR2");
  await delay(150);

  // 直接看守护进程的 backlog：两段断线输出都还在，等着 attach 回放。
  const socketPath = join(h.stateDir, "hosted", "sessiond.sock");
  const probe = await SessiondClient.connect(socketPath);
  const view = await probe.request({ op: "attach", sessionId: sessionUuid(session.sessionId), ack: 0 });
  assert.equal(view.running, true);
  assert.equal(view.gap, false);
  const backlogText = view.backlog.map((chunk) => chunk.data).join("");
  assert.ok(backlogText.includes("离线输出 1"), backlogText);
  assert.ok(backlogText.includes("离线输出 2"), backlogText);
  probe.close();

  const second = managerFor(h.stateDir);
  t.after(() => second.dispose());
  await waitFor(() => second.session(session.sessionId)?.live === true, "重连后 live");
  const restored = second.session(session.sessionId);
  assert.equal(restored.busy, false);
  const texts = await waitFor(
    () => {
      const all = textsOf(second, session.sessionId);
      return all.includes("离线输出 1") && all.includes("离线输出 2") ? all : null;
    },
    "断线输出补进 transcript",
  );
  assert.ok(texts.includes("echo 第一轮"));
});

test("kill 后 exit 事件到达，live 变 false", async (t) => {
  const h = await harness(t);
  const manager = managerFor(h.stateDir);
  t.after(() => manager.dispose());
  const session = manager.create({ path: h.repo });
  await waitFor(() => /pid \d+/.test(processLabel(manager, session.sessionId)), "子进程已启动");

  const stopped = manager.stop(session.sessionId);
  assert.equal(stopped.stopped, true);
  await waitFor(
    () => textsOf(manager, session.sessionId).some((text) => text.startsWith("托管进程已结束")),
    "exit 事件",
  );
  assert.equal(manager.session(session.sessionId).live, false);
});

test("Bridge 重启后待批准的权限请求重新挂上，且不重复追加", async (t) => {
  const h = await harness(t);
  const first = managerFor(h.stateDir);
  t.after(() => first.dispose());
  const session = first.create({ path: h.repo });
  await first.send(session.sessionId, "permission");
  await waitFor(() => first.session(session.sessionId)?.needsDecision === true, "首轮待批准");

  // 原始行落进注册表，重启后才有可能把这条请求重新挂上。
  const registry = JSON.parse(readFileSync(join(h.stateDir, "hosted", "sessions.json"), "utf8"));
  assert.ok(registry.sessions[0].pendingLine.includes("req-recover"), JSON.stringify(registry));

  first.exitHandler();
  const second = managerFor(h.stateDir);
  t.after(() => second.dispose());
  await waitFor(() => second.session(session.sessionId)?.live === true, "重连后 live");
  await waitFor(() => second.session(session.sessionId)?.needsDecision === true, "恢复待批准");

  const asks = second
    .messagesFor(session.sessionId, { limit: 100 })
    .messages.filter((message) => message.blocks.some((block) => block.type === "next-step"));
  assert.equal(asks.length, 1, "待批准消息只应有一条");

  // 回答仍然走 control_response，并且这条 pending 被清掉。
  await second.send(session.sessionId, "允许");
  await waitFor(() => second.session(session.sessionId)?.needsDecision === false, "已答复");
});

test("协议版本不一致：shutdown 旧守护进程后拉起新实例", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sessiond-version-"));
  const stateDir = join(root, "state");
  const hostedDir = join(stateDir, "hosted");
  mkdirSync(hostedDir, { recursive: true });
  const socketPath = join(hostedDir, "sessiond.sock");
  const script = join(root, "old-sessiond.mjs");
  writeFileSync(script, OLD_SESSIOND);

  const old = spawn(process.execPath, [script, socketPath], { stdio: "ignore" });
  const oldExited = new Promise((resolve) => old.once("exit", resolve));
  t.after(() => {
    try {
      old.kill("SIGKILL");
    } catch {
      // 已经退出。
    }
  });
  await waitForListener(socketPath);

  const logs = [];
  const manager = new HostedSessionManager({ stateDir, log: (line) => logs.push(line) });
  t.after(() => manager.dispose());

  await waitFor(
    () => logs.some((line) => line.includes("sessiond 版本不一致")),
    "版本不一致日志",
  );
  await oldExited;

  // 能通过新版的 hello 握手，说明 bridge 换掉的确实是协议不一致的旧实例。
  const client = await connectEventually(socketPath);
  assert.deepEqual(await client.request({ op: "list" }), []);
  client.send({ op: "shutdown" });
  await delay(100);
  client.close();
  await waitFor(() => !existsSync(socketPath), "新实例收摊");
});
