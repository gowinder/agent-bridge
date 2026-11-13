import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

test("router model names with a slash reach argv and survive a restart", (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo, model: "ncncapi/claude-opus-5-5" });
  assert.equal(h.spawns[0].args[h.spawns[0].args.indexOf("--model") + 1], "ncncapi/claude-opus-5-5");
  h.manager.dispose();
  const next = new HostedSessionManager({ stateDir: h.stateDir, spawn: () => new FakeChild() });
  t.after(() => next.dispose());
  assert.equal(next.sessions().find((item) => item.sessionId === session.sessionId)?.model, "ncncapi/claude-opus-5-5");
});

test("model names that could inject argv are rejected", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  assert.throws(() => h.manager.create({ path: h.repo, model: "--dangerously-skip-permissions" }), /模型名不合法/);
  assert.throws(() => h.manager.create({ path: h.repo, model: "a b" }), /模型名不合法/);
});

test("extra args reject the flags that decide identity and permissions", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  for (const flag of [
    "--settings",
    "--settings=/tmp/x.json",
    "--dangerously-skip-permissions",
    "--permission-mode=bypassPermissions",
    "--resume",
  ]) {
    assert.throws(() => h.manager.create({ path: h.repo, args: [flag] }), /启动参数不接受/);
  }
  assert.equal(h.spawns.length, 0);
  h.manager.create({ path: h.repo, args: ["--add-dir /tmp/extra"] });
  const args = h.spawns[0].args;
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/extra");
});

test("setAllowBypassPermissions rewrites hosted.json and takes effect at once", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  assert.equal(h.manager.configForClient().allowBypassPermissions, false);
  const updated = h.manager.setAllowBypassPermissions(true);
  assert.equal(updated.allowBypassPermissions, true);
  assert.ok(updated.permissionModes.includes("bypassPermissions"));
  assert.equal(JSON.parse(readFileSync(join(h.stateDir, "hosted.json"), "utf8")).allowBypassPermissions, true);
  assert.equal(h.manager.setAllowBypassPermissions(false).allowBypassPermissions, false);
  assert.throws(
    () => h.manager.create({ path: h.repo, permissionMode: "bypassPermissions" }),
    (error) => error.code === "unsupported",
  );
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

test("two-question batch keeps multi-select answers as arrays", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  return h.manager.send(session.sessionId, "开始").then(async () => {
    const child = h.spawns[0].child;
    child.emitJson({
      type: "control_request",
      request_id: "req-ask-two",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "要做哪些？",
              multiSelect: true,
              options: [{ label: "写代码" }, { label: "跑测试" }],
            },
            { question: "提交到哪里？", options: [{ label: "develop" }, { label: "main" }] },
          ],
        },
      },
    });
    await h.manager.send(session.sessionId, "写代码/跑测试、develop");
    const response = child.writes().filter((item) => item.type === "control_response").at(-1);
    assert.deepEqual(response.response.response.updatedInput.answers["要做哪些？"], ["写代码", "跑测试"]);
    assert.equal(response.response.response.updatedInput.answers["提交到哪里？"], "develop");
  });
});

test("stop kills the process and resume starts it again with --resume", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  const stopped = await h.manager.stop(session.sessionId);
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

test("rail and messages report context usage from assistant events", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "好的" }],
      usage: {
        input_tokens: 1200,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 4_000,
        output_tokens: 300,
      },
    },
  });
  const context = h.manager.rail(session.sessionId).context;
  assert.ok(context);
  assert.equal(context.usedTokens, 35_200);
  assert.equal(context.windowTokens, 200_000);
  assert.equal(context.model, "claude-sonnet-4-5");
  assert.equal(context.windowEstimated, undefined);
  assert.deepEqual(
    context.details.map((detail) => detail.label),
    ["输入", "缓存读", "缓存写", "输出"],
  );
  assert.equal(h.manager.messagesFor(session.sessionId, { limit: 50 }).context.usedTokens, 35_200);
});

test("context usage is recorded even when the assistant event has no blocks", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "assistant",
    message: {
      model: "claude-opus-4-5[1m]",
      content: [],
      usage: { input_tokens: 10, cache_read_input_tokens: 500_000, output_tokens: 5 },
    },
  });
  const page = h.manager.messagesFor(session.sessionId, { limit: 50 });
  assert.equal(page.messages.length, 0);
  assert.equal(page.context.windowTokens, 1_000_000);
  assert.equal(page.context.usedTokens, 500_010);
});

test("unknown model names keep usage but mark the window as estimated", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "assistant",
    message: {
      model: "some-router-alias",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  });
  const context = h.manager.rail(session.sessionId).context;
  assert.equal(context.windowTokens, 200_000);
  assert.equal(context.windowEstimated, true);
});

test("context usage survives a manager restart", (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 500, cache_read_input_tokens: 1_500, output_tokens: 10 },
    },
  });
  h.manager.dispose();
  const next = new HostedSessionManager({ stateDir: h.stateDir, spawn: () => new FakeChild() });
  t.after(() => next.dispose());
  const context = next.rail(session.sessionId).context;
  assert.equal(context.usedTokens, 2_000);
  assert.deepEqual(
    context.details.map((detail) => detail.value),
    ["500", "1,500", "0", "10"],
  );
});

test("init reports slash commands without terminal-only entries", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-5",
    slash_commands: ["compact", "seo-runbook", "focus", "seo-runbook", "superpowers:brainstorm"],
    terminal_slash_commands: ["focus"],
  });
  assert.deepEqual(h.manager.messagesFor(session.sessionId, { limit: 10 }).slashCommands, [
    "compact",
    "seo-runbook",
    "superpowers:brainstorm",
  ]);
});

test("slash commands survive a manager restart", (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-5",
    slash_commands: ["compact", "design"],
  });
  h.manager.dispose();
  const next = new HostedSessionManager({ stateDir: h.stateDir, spawn: () => new FakeChild() });
  t.after(() => next.dispose());
  assert.deepEqual(next.messagesFor(session.sessionId, { limit: 10 }).slashCommands, ["compact", "design"]);
});

test("sending to a stopped session resumes the process", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.manager.stop(session.sessionId);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.manager.session(session.sessionId).live, false);

  const result = await h.manager.send(session.sessionId, "继续");
  assert.equal(result.delivered, true);
  assert.equal(h.spawns.length, 2);
  const args = h.spawns[1].args;
  assert.equal(args[args.indexOf("--resume") + 1], session.sessionId.replace("hosted:", ""));
  assert.equal(h.manager.session(session.sessionId).live, true);
});

test("a bridge restart replays the unfinished turn in a new process", async (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  await h.manager.send(session.sessionId, "跑完整条迁移");
  h.manager.dispose();

  const spawns = [];
  const next = new HostedSessionManager({
    stateDir: h.stateDir,
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawns.push({ args, options, child });
      return child;
    },
  });
  t.after(() => next.dispose());
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[spawns[0].args.indexOf("--resume") + 1], session.sessionId.replace("hosted:", ""));
  const restored = next.session(session.sessionId);
  assert.equal(restored.live, true);
  assert.equal(restored.busy, true);
  const replay = spawns[0].child.writes()[0];
  assert.equal(replay.type, "user");
  assert.equal(replay.message.content[0].text, "跑完整条迁移");
  const texts = next
    .messagesFor(session.sessionId, { limit: 50 })
    .messages.flatMap((message) => message.blocks.map((block) => block.text));
  assert.ok(texts.includes("Bridge 重启，已自动续跑上次未结束的一轮"));
});

test("stopping a session keeps a bridge restart from replaying the turn", async (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  await h.manager.send(session.sessionId, "不要续跑这一轮");
  h.manager.stop(session.sessionId);
  h.manager.dispose();

  const spawns = [];
  const next = new HostedSessionManager({
    stateDir: h.stateDir,
    spawn: (...args) => {
      spawns.push(args);
      return new FakeChild();
    },
  });
  t.after(() => next.dispose());
  assert.equal(spawns.length, 0);
  assert.equal(next.session(session.sessionId).live, false);
  const texts = next
    .messagesFor(session.sessionId, { limit: 50 })
    .messages.flatMap((message) => message.blocks.map((block) => block.text));
  assert.ok(!texts.includes("Bridge 重启，已自动续跑上次未结束的一轮"));
});

test("auto-resume gives up after three attempts and asks for a manual continue", async (t) => {
  const h = harness();
  const session = h.manager.create({ path: h.repo });
  await h.manager.send(session.sessionId, "反复中断");
  h.manager.dispose();
  const registryPath = join(h.stateDir, "hosted", "sessions.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.sessions[0].resumeAttempts = 3;
  writeFileSync(registryPath, JSON.stringify(registry));

  const spawns = [];
  const next = new HostedSessionManager({
    stateDir: h.stateDir,
    spawn: (...args) => {
      spawns.push(args);
      return new FakeChild();
    },
  });
  t.after(() => next.dispose());
  assert.equal(spawns.length, 0);
  assert.equal(next.session(session.sessionId).live, false);
  const page = next.messagesFor(session.sessionId, { limit: 50 });
  assert.equal(page.interrupted, true);
  const texts = page.messages.flatMap((message) => message.blocks.map((block) => block.text));
  assert.ok(texts.includes("上次一轮被反复中断，需要手动继续"));

  // 放弃时清掉了 pendingText，之后再重启不会再试。
  const again = new HostedSessionManager({
    stateDir: h.stateDir,
    spawn: (...args) => {
      spawns.push(args);
      return new FakeChild();
    },
  });
  t.after(() => again.dispose());
  assert.equal(spawns.length, 0);
});

test("a late exit from the stopped process keeps the resumed one tracked", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  const first = h.spawns[0].child;
  h.manager.stop(session.sessionId);
  await h.manager.send(session.sessionId, "继续");
  assert.equal(h.manager.session(session.sessionId).live, true);

  // 真实进程收到 SIGTERM 后可能过一会儿才退出：这时新进程已经在 live 里了。
  first.emit("exit", null, "SIGTERM");
  assert.equal(h.manager.session(session.sessionId).live, true);
  assert.equal(h.spawns.length, 2);
});

test("a session without an explicit model pins the model the CLI reports", (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  h.spawns[0].child.emitJson({ type: "system", subtype: "init", model: "group/dsgroup" });
  // 第一次跑起来就把模型钉住：之后本机换 CLI 默认模型，这条会话不会被一起换掉。
  assert.equal(h.manager.session(session.sessionId).model, "group/dsgroup");
  h.manager.stop(session.sessionId);
  h.manager.resume(session.sessionId);
  const args = h.spawns[1].args;
  assert.equal(args[args.indexOf("--model") + 1], "group/dsgroup");
});

test("the model can be switched from the web and the next run uses it", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, model: "group/dsgroup" });
  const models = h.manager.models(session.sessionId);
  assert.equal(models.canSwitch, true);
  assert.equal(models.current, "group/dsgroup");

  const switched = await h.manager.setModel(session.sessionId, "ncncapi/claude-opus-5-5");
  assert.equal(switched.model, "ncncapi/claude-opus-5-5");
  assert.equal(h.spawns[0].child.signals[0], "SIGTERM");
  h.manager.resume(session.sessionId);
  const args = h.spawns[1].args;
  assert.equal(args[args.indexOf("--model") + 1], "ncncapi/claude-opus-5-5");
});

test("switching back to the CLI default drops the pinned model", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, model: "group/dsgroup" });
  await h.manager.setModel(session.sessionId, null);
  assert.equal(h.manager.session(session.sessionId).model, undefined);
  h.manager.resume(session.sessionId);
  assert.ok(!h.spawns[1].args.includes("--model"));
});

test("an invalid model name is rejected instead of reaching the CLI", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  await assert.rejects(
    h.manager.setModel(session.sessionId, "--dangerously-skip-permissions"),
    /模型名不合法/,
  );
});
