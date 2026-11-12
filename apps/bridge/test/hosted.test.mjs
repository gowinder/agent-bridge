import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedAdapter } from "../dist/adapters/hosted.js";
import { HostedSessionManager } from "../dist/hosted/manager.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
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

function harness(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "hosted-test-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(outside);
  mkdirSync(stateDir);
  writeFileSync(
    join(stateDir, "hosted.json"),
    JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000, ...config }),
  );
  const spawns = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    spawns.push({ command, args, options, child });
    return child;
  };
  const manager = new HostedSessionManager({ stateDir, spawn });
  return { root, repo, outside, stateDir, spawns, manager };
}

test("create spawns stream-json CLI with an explicit non-bypass mode", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, permissionMode: "manual" });
  assert.equal(session.hosted, true);
  assert.equal(session.appId, "hosted");
  assert.equal(session.permissionMode, "manual");
  assert.equal(h.spawns.length, 1);
  const { args, options } = h.spawns[0];
  assert.deepEqual(args.slice(0, 6), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "host");
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
  assert.equal(args[args.indexOf("--session-id") + 1], session.sessionId.replace("hosted:", ""));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(options.cwd, realpathSync(h.repo));
});

test("bypassPermissions is off by default and rejected at create", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const config = h.manager.configForClient();
  assert.equal(config.allowBypassPermissions, false);
  assert.ok(!config.permissionModes.includes("bypassPermissions"));
  assert.throws(
    () => h.manager.create({ path: h.repo, permissionMode: "bypassPermissions" }),
    (error) => error.code === "unsupported",
  );
  assert.equal(h.spawns.length, 0);
});

test("allowBypassPermissions opens bypass for hosted sessions", (t) => {
  const h = harness({ allowBypassPermissions: true });
  t.after(() => h.manager.dispose());
  const config = h.manager.configForClient();
  assert.equal(config.allowBypassPermissions, true);
  assert.ok(config.permissionModes.includes("bypassPermissions"));
  const session = h.manager.create({ path: h.repo, permissionMode: "bypassPermissions" });
  assert.equal(session.permissionMode, "bypassPermissions");
  const args = h.spawns[0].args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("turning allowBypassPermissions off blocks resuming a bypass session", (t) => {
  const h = harness({ allowBypassPermissions: true });
  const session = h.manager.create({ path: h.repo, permissionMode: "bypassPermissions" });
  h.manager.stop(session.sessionId);
  h.manager.dispose();
  writeFileSync(
    join(h.stateDir, "hosted.json"),
    JSON.stringify({ dirs: [h.repo], idleTimeoutMs: 60_000 }),
  );
  const spawns = [];
  const next = new HostedSessionManager({
    stateDir: h.stateDir,
    spawn: (...args) => {
      spawns.push(args);
      return new FakeChild();
    },
  });
  t.after(() => next.dispose());
  assert.equal(next.session(session.sessionId).permissionMode, "bypassPermissions");
  assert.throws(
    () => next.resume(session.sessionId),
    (error) => error.code === "unsupported",
  );
  assert.equal(spawns.length, 0);
});

test("send writes a plain user turn and streams the assistant reply back", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  return h.manager.send(session.sessionId, "改一个文件并提交").then((result) => {
    assert.equal(result.accepted, true);
    assert.equal(result.delivered, true);
    const first = h.spawns[0].child.writes()[0];
    assert.equal(first.type, "user");
    assert.equal(first.message.content[0].text, "改一个文件并提交");
    assert.equal(first.parent_tool_use_id, null);

    h.spawns[0].child.emitJson({
      type: "assistant",
      message: { content: [{ type: "text", text: "已提交" }] },
    });
    h.spawns[0].child.emitJson({ type: "result", is_error: false, result: "已提交" });
    const page = h.manager.messagesFor(session.sessionId, { limit: 50 });
    assert.equal(page.busy, false);
    const roles = page.messages.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant"]);
    const last = page.messages[page.messages.length - 1];
    assert.equal(last.blocks[0].text, "已提交");
  });
});

test("tool permission requests surface as buttons and answer over stdin", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  return h.manager.send(session.sessionId, "提交").then(async () => {
    const child = h.spawns[0].child;
    child.emitJson({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git commit -m x" } },
    });
    const page = h.manager.messagesFor(session.sessionId, { limit: 50 });
    const ask = page.messages.find((message) =>
      message.blocks.some((block) => block.type === "next-step"),
    );
    assert.ok(ask, "expected a next-step block");
    assert.equal(page.busy, true);
    assert.equal(h.manager.session(session.sessionId).needsDecision, true);

    await h.manager.send(session.sessionId, "允许");
    const response = child.writes().filter((item) => item.type === "control_response").at(-1);
    assert.equal(response.response.subtype, "success");
    assert.equal(response.response.request_id, "req-1");
    assert.equal(response.response.response.behavior, "allow");
    assert.equal(response.response.response.updatedInput.command, "git commit -m x");
    assert.equal(h.manager.session(session.sessionId).needsDecision, false);
  });
});

test("AskUserQuestion answers map back to the question text", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  return h.manager.send(session.sessionId, "开始").then(async () => {
    const child = h.spawns[0].child;
    child.emitJson({
      type: "control_request",
      request_id: "req-ask",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            { question: "提交到哪里？", options: [{ label: "develop" }, { label: "main" }] },
          ],
        },
      },
    });
    await h.manager.send(session.sessionId, "develop");
    const response = child.writes().filter((item) => item.type === "control_response").at(-1);
    assert.equal(response.response.response.behavior, "allow");
    assert.equal(response.response.response.updatedInput.answers["提交到哪里？"], "develop");
  });
});

test("stop kills the process and resume starts it again with --resume", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  const stopped = h.manager.stop(session.sessionId);
  assert.equal(stopped.stopped, true);
  assert.equal(h.spawns[0].child.signals[0], "SIGTERM");
  assert.equal(stopped.session.live, false);
  assert.equal(stopped.session.canSend, true);

  const resumed = h.manager.resume(session.sessionId);
  assert.equal(resumed.live, true);
  assert.equal(h.spawns.length, 2);
  const args = h.spawns[1].args;
  assert.equal(args[args.indexOf("--resume") + 1], session.sessionId.replace("hosted:", ""));
  assert.ok(!args.includes("--session-id"));
});

test("directories outside the allowlist are rejected", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  assert.throws(
    () => h.manager.create({ path: h.outside }),
    (error) => error.code === "unauthorized",
  );
  assert.equal(h.spawns.length, 0);
});

test("adapter refuses unknown sessions without touching any stdin", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const adapter = new HostedAdapter(h.manager);
  return adapter.send("hosted:missing", "hi").then(
    () => assert.fail("expected not_found"),
    (error) => assert.equal(error.code, "not_found"),
  );
});

test("sessions survive a manager restart through the registry", (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  h.manager.dispose();
  const next = new HostedSessionManager({ stateDir: h.stateDir, spawn: () => new FakeChild() });
  t.after(() => next.dispose());
  const restored = next.session(session.sessionId);
  assert.ok(restored);
  assert.equal(restored.cwd, session.cwd);
  assert.equal(restored.permissionMode, "manual");
  assert.equal(restored.live, false);
  const page = next.messagesFor(session.sessionId, { limit: 50 });
  assert.equal(page.completeness, "complete");
});
