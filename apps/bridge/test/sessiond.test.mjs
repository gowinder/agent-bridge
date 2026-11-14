import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SESSIOND_VERSION } from "../dist/hosted/sessiond/protocol.js";
import { startSessiondServer } from "../dist/hosted/sessiond/server.js";

const ECHO_SCRIPT =
  'process.stdin.on("data", (d) => process.stdout.write(d)); process.stdin.on("end", () => process.exit(0));';

function connect(socketPath) {
  const socket = createConnection(socketPath);
  const messages = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  const send = (message) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, messages, send, ready };
}

async function waitFor(messages, predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}；已收到 ${JSON.stringify(messages)}`);
}

async function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sessiond-"));
  const server = await startSessiondServer({ stateDir: dir, log: () => {}, ...options });
  t.after(() => server.close());
  const client = connect(server.socketPath);
  await client.ready;
  t.after(() => client.socket.destroy());
  return { dir, server, client };
}

let nextId = 0;
const id = (prefix) => `${prefix}-${++nextId}`;

function hello(c, version = SESSIOND_VERSION) {
  const messageId = id("hello");
  c.send({ id: messageId, op: "hello", version });
  return messageId;
}

function start(c, sessionId, command, args, cwd) {
  const messageId = id("start");
  c.send({ id: messageId, op: "start", sessionId, command, args, cwd });
  return messageId;
}

test("sessiond: start、stdin 回显、ack 裁剪 backlog、kill 退出", async (t) => {
  const { dir, client } = await harness(t);
  assert.equal(hello(client), "hello-1");
  const helloReply = await waitFor(client.messages, (m) => m.id === "hello-1", "hello 回执");
  assert.deepEqual(helloReply, { id: "hello-1", ok: true, result: { version: SESSIOND_VERSION } });

  const sessionId = "session-echo";
  const startId = start(client, sessionId, process.execPath, ["-e", ECHO_SCRIPT], dir);
  const started = await waitFor(
    client.messages,
    (m) => m.id === startId,
    "start 回执",
  );
  assert.equal(started.ok, true);
  assert.ok(started.result.pid > 0);

  // 同一 sessionId 再 start 一次应当被拒绝。
  const again = id("start");
  client.send({ id: again, op: "start", sessionId, command: process.execPath, args: ["-e", ECHO_SCRIPT], cwd: dir });
  const rejected = await waitFor(client.messages, (m) => m.id === again, "重复 start 回执");
  assert.deepEqual(rejected, { id: again, ok: false, error: "already running" });

  client.send({ op: "stdin", sessionId, data: "a\n" });
  const first = await waitFor(
    client.messages,
    (m) => m.op === "stdout" && m.data === "a\n",
    "第一条 stdout",
  );
  assert.equal(first.seq, 1);
  assert.equal(first.sessionId, sessionId);

  client.send({ op: "stdin", sessionId, data: "b\n" });
  const second = await waitFor(client.messages, (m) => m.op === "stdout" && m.data === "b\n", "第二条 stdout");
  assert.equal(second.seq, 2);

  // ack=1 后 attach 只能拿到 seq 2 的剩余输出。
  const attach1 = id("attach");
  client.send({ id: attach1, op: "attach", sessionId, ack: 1 });
  const view = await waitFor(client.messages, (m) => m.id === attach1, "attach 回执");
  assert.equal(view.ok, true);
  assert.equal(view.result.running, true);
  assert.equal(view.result.lastSeq, 2);
  assert.deepEqual(view.result.backlog.map((chunk) => chunk.seq), [2]);
  assert.equal(view.result.gap, false);

  // 再 ack 到 2，backlog 清空，ignoredSeq 记录到 2。
  client.send({ op: "ack", sessionId, seq: 2 });
  const attach2 = id("attach");
  client.send({ id: attach2, op: "attach", sessionId, ack: 0 });
  const emptied = await waitFor(client.messages, (m) => m.id === attach2, "二次 attach 回执");
  assert.deepEqual(emptied.result.backlog, []);

  const listId = id("list");
  client.send({ id: listId, op: "list" });
  const listed = await waitFor(client.messages, (m) => m.id === listId, "list 回执");
  assert.deepEqual(
    listed.result.map(({ sessionId: sid, running, lastSeq, ignoredSeq }) => ({ sid, running, lastSeq, ignoredSeq })),
    [{ sid: sessionId, running: true, lastSeq: 2, ignoredSeq: 2 }],
  );

  const killId = id("kill");
  client.send({ id: killId, op: "kill", sessionId });
  const killed = await waitFor(client.messages, (m) => m.id === killId, "kill 回执");
  assert.equal(killed.ok, true);
  const exit = await waitFor(
    client.messages,
    (m) => m.op === "exit" && m.sessionId === sessionId,
    "exit 事件",
  );
  // 默认的 SIGTERM 处理会让子进程以 signal 结束，code 为 null。
  assert.equal(exit.signal, "SIGTERM");
  assert.equal(exit.code, null);
});

test("sessiond: hello 版本不符返回 version 错误", async (t) => {
  const { client } = await harness(t);
  const mismatch = id("hello");
  client.send({ id: mismatch, op: "hello", version: 999 });
  const reply = await waitFor(client.messages, (m) => m.id === mismatch, "版本错误回执");
  assert.deepEqual(reply, { id: mismatch, ok: false, error: "version" });
});

test("sessiond: backlog 超过 bufferBytes 时丢最老的并标记 gap", async (t) => {
  const { dir, client } = await harness(t, { bufferBytes: 8 });
  const sessionId = "session-gap";
  const startId = start(client, sessionId, process.execPath, ["-e", ECHO_SCRIPT], dir);
  await waitFor(client.messages, (m) => m.id === startId, "start 回执");

  client.send({ op: "stdin", sessionId, data: "123456" });
  await waitFor(client.messages, (m) => m.op === "stdout" && m.seq === 1, "第一段输出");
  client.send({ op: "stdin", sessionId, data: "123456" });
  await waitFor(client.messages, (m) => m.op === "stdout" && m.seq === 2, "第二段输出");

  const attachId = id("attach");
  client.send({ id: attachId, op: "attach", sessionId, ack: 0 });
  const view = await waitFor(client.messages, (m) => m.id === attachId, "attach 回执");
  assert.equal(view.result.gap, true);
  assert.equal(view.result.backlog.length, 1);
  assert.equal(view.result.backlog[0].seq, 2);
});

test("sessiond: start 把额外环境变量传给子进程", async (t) => {
  const { dir, client } = await harness(t);
  const sessionId = "session-env";
  const script = 'process.stdout.write(`dir=${process.env.PI_CODING_AGENT_DIR}\\n`);';
  const messageId = id("start");
  client.send({
    id: messageId,
    op: "start",
    sessionId,
    command: process.execPath,
    args: ["-e", script],
    cwd: dir,
    env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent-test" },
  });
  const started = await waitFor(client.messages, (m) => m.id === messageId, "start 回执");
  assert.equal(started.ok, true);
  await waitFor(
    client.messages,
    (m) => m.op === "stdout" && m.data === "dir=/tmp/pi-agent-test\n",
    "带环境变量的输出",
  );
});

test("sessiond: socket 文件权限是 0600", async (t) => {
  const { server } = await harness(t);
  const mode = statSync(server.socketPath).mode & 0o777;
  assert.equal(mode, 0o600);
});
