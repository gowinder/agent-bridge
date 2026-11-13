import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedSessionManager } from "../dist/hosted/manager.js";
import { PiSession } from "../dist/hosted/pi-session.js";
import { killProcess, markProcessGroup } from "../dist/hosted/process-group.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 5150;
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

  /** 回一条命令响应：按类型找到最近一条没回过的命令，带上它的 id。 */
  reply(command, data, extra = {}) {
    const sent = this.writes().filter((item) => item.type === command);
    const last = sent[sent.length - 1];
    assert.ok(last, `没有发出 ${command} 命令`);
    this.emitJson({ id: last.id, type: "response", command, success: true, data, ...extra });
  }

  writes() {
    return this.chunks.map((chunk) => JSON.parse(chunk.trim()));
  }
}

function piHarness() {
  const root = mkdtempSync(join(tmpdir(), "pi-hosted-test-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000 }));
  const spawns = [];
  const spawnFn = (command, args, options) => {
    const child = new FakeChild();
    spawns.push({ command, args, options, child });
    return child;
  };
  process.env.AGENT_BRIDGE_PI_PATH = process.execPath;
  const manager = new HostedSessionManager({ stateDir, spawn: spawnFn });
  return { repo, stateDir, spawns, manager };
}

function piHandlers() {
  const calls = [];
  const handler = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    handlers: {
      assistant: handler("assistant"),
      system: handler("system"),
      context: handler("context"),
      pending: handler("pending"),
      busy: handler("busy"),
      settled: handler("settled"),
      title: handler("title"),
      commands: handler("commands"),
      models: handler("models"),
      model: handler("model"),
      log: handler("log"),
    },
  };
}

test("creating a pi session starts rpc mode with the bridge session id", (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "pi" });
  assert.equal(h.spawns.length, 1);
  const { args } = h.spawns[0];
  assert.equal(args[0], "--mode");
  assert.equal(args[1], "rpc");
  assert.equal(args[args.indexOf("--session-id") + 1], session.sessionId.replace("hosted:", ""));
  assert.ok(args.includes("--approve"));
  assert.ok(!args.includes("--permission-mode"));
});

test("pi set_model switches in place without restarting the process", async (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "pi", model: "ncncapi/claude-opus-5-5" });
  const child = h.spawns[0].child;
  child.reply("get_state", { model: { provider: "ncncapi", id: "claude-opus-5-5" } });

  // 回合进行中也能换：pi 的 set_model 不等回合结束。
  child.emitJson({ type: "agent_start" });
  const pending = h.manager.setModel(session.sessionId, "group/dsgroup");
  const sent = child.writes().filter((item) => item.type === "set_model");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].provider, "group");
  assert.equal(sent[0].modelId, "dsgroup");
  child.emitJson({
    id: sent[0].id,
    type: "response",
    command: "set_model",
    success: true,
    data: { provider: "group", id: "dsgroup" },
  });
  const switched = await pending;
  assert.equal(switched.model, "group/dsgroup");
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(child.signals, []);
});

test("pi refusing a model surfaces the error and keeps the record", async (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "pi", model: "ncncapi/claude-opus-5-5" });
  const child = h.spawns[0].child;
  child.reply("get_state", { model: { provider: "ncncapi", id: "claude-opus-5-5" } });

  const pending = h.manager.setModel(session.sessionId, "group/dsgroup");
  const sent = child.writes().filter((item) => item.type === "set_model").at(-1);
  child.emitJson({
    id: sent.id,
    type: "response",
    command: "set_model",
    success: false,
    error: "Model not found: dsgroup",
  });
  await assert.rejects(pending, /pi 换模型失败：Model not found/);
  const kept = h.manager.sessions().find((item) => item.sessionId === session.sessionId);
  assert.equal(kept.model, "ncncapi/claude-opus-5-5");
  assert.deepEqual(child.signals, []);
});

test("pi session without a live process records the model for the next start", async (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "pi" });
  const child = h.spawns[0].child;
  child.kill("SIGTERM");

  const switched = await h.manager.setModel(session.sessionId, "group/dsgroup");
  assert.equal(switched.model, "group/dsgroup");
  // 下一条消息按新模型重启，--provider 与 --model 都带上。
  const before = h.spawns.length;
  await h.manager.send(session.sessionId, "继续");
  assert.equal(h.spawns.length, before + 1);
  const args = h.spawns.at(-1).args;
  assert.equal(args[args.indexOf("--provider") + 1], "group");
  assert.equal(args[args.indexOf("--model") + 1], "dsgroup");
});

test("PiSession answers extension dialogs and parses assistant turns", () => {
  const written = [];
  const { calls, handlers } = piHandlers();
  const pi = new PiSession((line) => written.push(JSON.parse(line)), handlers);

  pi.feed(`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "选一个", options: ["a", "b"] })}\n`);
  const pending = calls.find((call) => call.name === "pending");
  assert.equal(pending.args[0].id, "ui-1");

  pi.answer(pending.args[0], "b");
  assert.deepEqual(written.at(-1), { type: "extension_ui_response", id: "ui-1", value: "b" });

  pi.feed(
    `${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", model: { provider: "group", id: "dsgroup" }, content: [{ type: "text", text: "好了" }] },
    })}\n`,
  );
  const assistant = calls.find((call) => call.name === "assistant");
  assert.deepEqual(assistant.args[0], [{ type: "text", text: "好了" }]);
});

test("pi session rail lists its background subagent runs", (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo, agent: "pi" });
  const piId = session.sessionId.replace("hosted:", "");

  const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  const runs = join(root, "async-subagent-runs");
  const now = Date.now();
  writeRun(runs, "run-done", {
    sessionId: piId,
    state: "complete",
    startedAt: now - 60_000,
    lastActivityAt: now - 50_000,
    steps: [{ agent: "scout", sessionName: "scout: 数一下目录" }],
  });
  writeRun(runs, "run-live", {
    sessionId: piId,
    state: "running",
    startedAt: now - 5_000,
    lastActivityAt: now - 1_000,
    currentStep: 1,
    steps: [{ agent: "scout" }, { agent: "builder", sessionName: "builder: 写报告" }],
  });
  // 别的会话的 run 不能混进来。
  writeRun(runs, "run-other", { sessionId: "another-session", state: "running", steps: [{ agent: "scout" }] });

  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
  });

  const tasks = h.manager.rail(session.sessionId).tasks;
  assert.deepEqual(
    tasks.map((task) => [task.taskId, task.status, task.agentType, task.name]),
    [
      ["run-live", "running", "builder", "builder: 写报告"],
      ["run-done", "done", "scout", "scout: 数一下目录"],
    ],
  );
  assert.equal(tasks[0].detail, "2 步 · 第 2 步");
});

/** 假装用户的 pi agent 目录：真实目录里只有一个 settings.json 和一个 npm 包目录。 */
function fakeAgentDir(stateDir) {
  const source = join(stateDir, "pi-source");
  mkdirSync(join(source, "npm", "pi-subagents"), { recursive: true });
  writeFileSync(
    join(source, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-subagents"], subagents: { defaultModel: "a/b" } }),
  );
  return source;
}

function withAgentDir(t, source) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = source;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

function readSubagentModel(dir) {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).subagents.defaultModel;
}

test("pi subagent model gets its own agent dir instead of touching the user's", (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const source = fakeAgentDir(h.stateDir);
  withAgentDir(t, source);

  const session = h.manager.create({ path: h.repo, agent: "pi", subagentModel: "group/dsgroup" });
  const dir = h.spawns[0].options.env.PI_CODING_AGENT_DIR;
  assert.equal(dir, join(h.stateDir, "pi-agent", session.sessionId.replace("hosted:", "")));
  assert.equal(readSubagentModel(dir), "group/dsgroup");
  // 其余设置原样带过去，否则用户的 packages 等配置会丢。
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).packages, ["npm:pi-subagents"]);
  // npm 必须是真目录（子项软链）：整目录软链过去 pi 会当成没装扩展。
  assert.ok(lstatSync(join(dir, "npm")).isDirectory());
  assert.equal(session.subagentModel, "group/dsgroup");
  assert.equal(h.manager.models(session.sessionId).subagentModel, "group/dsgroup");
  assert.equal(h.manager.models(session.sessionId).canSwitchSubagent, true);
  const rail = h.manager.rail(session.sessionId).environment;
  assert.equal(rail.find((row) => row.label === "子代理模型")?.value, "group/dsgroup");
});

test("changing the subagent model restarts the idle pi process with the new setting", async (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  const source = fakeAgentDir(h.stateDir);
  withAgentDir(t, source);
  const session = h.manager.create({ path: h.repo, agent: "pi" });
  // 没设子代理模型就跟着用户自己的 agent 目录走，不另建。
  assert.equal(h.spawns[0].options.env.PI_CODING_AGENT_DIR, source);

  const updated = await h.manager.setSubagentModel(session.sessionId, "group/dsgroup");
  assert.equal(updated.subagentModel, "group/dsgroup");
  const before = h.spawns.length;
  await h.manager.send(session.sessionId, "继续");
  assert.equal(h.spawns.length, before + 1);
  const dir = h.spawns.at(-1).options.env.PI_CODING_AGENT_DIR;
  assert.equal(readSubagentModel(dir), "group/dsgroup");

  // 改回跟随 pi 设置：agent 目录清掉，下一次启动不再带这个环境变量。
  h.spawns.at(-1).child.kill("SIGTERM");
  await h.manager.setSubagentModel(session.sessionId, null);
  assert.equal(existsSync(dir), false);
  assert.equal(h.manager.sessions().find((item) => item.sessionId === session.sessionId).subagentModel, undefined);
});

test("subagent model is refused for claude sessions and while a turn is running", async (t) => {
  const h = piHarness();
  t.after(() => h.manager.dispose());
  withAgentDir(t, fakeAgentDir(h.stateDir));
  const claude = h.manager.create({ path: h.repo });
  await assert.rejects(h.manager.setSubagentModel(claude.sessionId, "group/dsgroup"), /只有 pi/);

  const pi = h.manager.create({ path: h.repo, agent: "pi" });
  const child = h.spawns.at(-1).child;
  child.emitJson({ type: "agent_start" });
  await assert.rejects(h.manager.setSubagentModel(pi.sessionId, "group/dsgroup"), /还在跑/);
  assert.deepEqual(child.signals, []);
});

function writeRun(runs, runId, status) {
  const dir = join(runs, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, ...status }));
}

test("stopping a hosted process takes its grandchildren with it", async (t) => {
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const parent = markProcessGroup(
    spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true }),
  );
  t.after(() => {
    try {
      killProcess(parent, "SIGKILL");
    } catch {
      // 已经退出。
    }
  });
  const grandchildPid = await new Promise((resolve, reject) => {
    let buffer = "";
    parent.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index >= 0) resolve(Number(buffer.slice(0, index)));
    });
    parent.once("error", reject);
  });
  assert.ok(grandchildPid > 0);

  killProcess(parent, "SIGTERM");
  await once(parent, "exit");
  await waitForExit(grandchildPid);
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
});

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
