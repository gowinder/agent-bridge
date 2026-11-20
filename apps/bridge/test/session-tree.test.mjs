import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedSessionManager } from "../dist/hosted/manager.js";
import { alivePid, killTree, snapshotProcesses } from "../dist/hosted/process-tree.js";
import { startSessiondServer } from "../dist/hosted/sessiond/server.js";

/**
 * 假 CLI：收到用户消息就 detached 起一个每 100ms 写一行的孙进程。
 *
 * 对应真实场景里的 pi-subagents 后台 async runner —— 它用 `spawn(..., { detached: true })`
 * 起，setsid 之后自成一个进程组，父会话进程组 `kill(-pgid)` 收不到。孙进程把 pid 写进
 * `beat.txt.pid`，测试据此断言它到底有没有被收掉。beat.txt 放在会话工作目录里，
 * 两个会话互不干扰。
 */
const FAKE_CLI = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const beat = join(process.cwd(), "beat.txt");
let spawned = false;
const spawnChild = () => {
  if (spawned) return;
  spawned = true;
  const child = spawn("/bin/bash", ["-c", "while true; do date +%s%N >> " + beat + "; sleep 0.1; done"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(beat + ".pid", String(child.pid));
};

let buffer = "";
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
    if (message.type !== "user") continue;
    spawnChild();
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已派发" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\\n");
  }
});

setInterval(() => {}, 1000);
`;

const POSIX = process.platform !== "win32";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

const beatSize = (beat) => {
  try {
    return statSync(beat).size;
  } catch {
    return 0;
  }
};

const beatLines = (beat) => {
  try {
    return readFileSync(beat, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

function grandchildOf(beat) {
  if (!existsSync(`${beat}.pid`)) return undefined;
  const pid = Number(readFileSync(`${beat}.pid`, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

async function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "session-tree-"));
  const repo = join(root, "repo");
  const otherRepo = join(root, "repo-b");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(otherRepo);
  mkdirSync(stateDir);
  const cli = join(root, "fake-cli.mjs");
  writeFileSync(cli, FAKE_CLI, { mode: 0o755 });
  chmodSync(cli, 0o755);
  writeFileSync(
    join(stateDir, "hosted.json"),
    JSON.stringify({ dirs: [repo, otherRepo], idleTimeoutMs: 600_000, cliPath: cli }),
  );
  // 线上托管进程由 sessiond 守护进程持有，这里也走同一条路径。
  const server = await startSessiondServer({ stateDir, log: () => {} });
  t.after(() => server.close());
  return { root, repo, otherRepo, stateDir, cli, server };
}

function managerFor(stateDir) {
  return new HostedSessionManager({ stateDir, log: () => {} });
}

/** 起一个会话，等它派出孙进程并开始写文件。 */
async function sessionWithGrandchild(t, stateDir, repo) {
  const manager = managerFor(stateDir);
  t.after(() => manager.dispose());
  const session = manager.create({ path: repo });
  await manager.send(session.sessionId, "派一个后台子代理");
  const beat = join(repo, "beat.txt");
  const grandchild = await waitFor(() => grandchildOf(beat), "孙进程启动");
  await waitFor(() => beatLines(beat) >= 2, "孙进程开始写文件");
  return { manager, session, beat, grandchild };
}

function rootPidOf(manager, sessionId) {
  const label = manager.rail(sessionId).environment.find((item) => item.label === "进程")?.value ?? "";
  const match = /pid (\d+)/.exec(label);
  assert.ok(match, `没有 pid：${label}`);
  return Number(match[1]);
}

test("stop 之后 detached 的后台子代理也一起退出", { skip: !POSIX }, async (t) => {
  const h = await harness(t);
  const { manager, session, beat, grandchild } = await sessionWithGrandchild(t, h.stateDir, h.repo);
  assert.ok(alivePid(grandchild), "孙进程应该在跑");

  const result = await manager.stop(session.sessionId);
  assert.equal(result.stopped, true, JSON.stringify(result));
  // 收干净了就不该报残留。
  assert.deepEqual(result.leftover ?? [], []);

  await waitFor(() => !alivePid(grandchild), "孙进程退出");
  const sizeAtExit = beatSize(beat);
  await delay(600);
  assert.equal(beatSize(beat), sizeAtExit, "孙进程退出后文件不该再变长");
});

test("stop 是幂等的：已经停过的会话再停一次是空操作", { skip: !POSIX }, async (t) => {
  const h = await harness(t);
  const { manager, session, grandchild } = await sessionWithGrandchild(t, h.stateDir, h.repo);
  await manager.stop(session.sessionId);
  await waitFor(() => !alivePid(grandchild), "孙进程退出");

  const again = await manager.stop(session.sessionId);
  assert.equal(again.stopped, false, JSON.stringify(again));
  assert.deepEqual(again.leftover ?? [], []);
  assert.equal(again.session.hostedState, "stopped");
});

test("停一个会话不会碰到别的会话的进程树", { skip: !POSIX }, async (t) => {
  const h = await harness(t);
  const first = await sessionWithGrandchild(t, h.stateDir, h.repo);
  const second = await sessionWithGrandchild(t, h.stateDir, h.otherRepo);
  assert.notEqual(first.grandchild, second.grandchild);

  await first.manager.stop(first.session.sessionId);
  await waitFor(() => !alivePid(first.grandchild), "第一个孙进程退出");
  assert.ok(alivePid(second.grandchild), "停第一个会话不该收掉第二个会话的子代理");
  assert.ok(beatLines(second.beat) >= 2);

  await second.manager.stop(second.session.sessionId);
  await waitFor(() => !alivePid(second.grandchild), "第二个孙进程退出");
});

test("停止和子代理派发赛跑时也不留孤儿", { skip: !POSIX }, async (t) => {
  const h = await harness(t);
  // 连发 3 轮：每轮在「刚发出指令、孙进程可能正在起」的时候停，专挑这个窗口。
  for (let round = 0; round < 3; round += 1) {
    const manager = managerFor(h.stateDir);
    const session = manager.create({ path: h.repo });
    await manager.send(session.sessionId, "派一个后台子代理");
    await delay(60 + round * 60);
    const result = await manager.stop(session.sessionId);
    assert.equal(result.stopped, true, JSON.stringify(result));
    manager.dispose();
  }
  // 不管孙进程有没有真的起来，最后都不能留下带着这棵树的进程。
  await waitFor(
    () => !snapshotProcesses().some((node) => node.command.includes(h.repo)),
    "赛跑之后没有残留进程",
  );
});

test("会话进程自己退出后，也不留孤儿子代理", { skip: !POSIX }, async (t) => {
  const h = await harness(t);
  const { manager, session, beat, grandchild } = await sessionWithGrandchild(t, h.stateDir, h.repo);
  const rootPid = rootPidOf(manager, session.sessionId);
  // 先给登记表一个扫描周期：根进程一死 ppid 链就断了，只能靠这份表找回孙进程。
  await delay(1_300);

  process.kill(rootPid, "SIGTERM");
  await waitFor(() => !alivePid(grandchild), "根进程退出后孙进程也被收掉");
  const sizeAtExit = beatSize(beat);
  await delay(600);
  assert.equal(beatSize(beat), sizeAtExit, "孙进程退出后文件不该再变长");
});

test("killTree：忽略 SIGTERM 的进程会被 SIGKILL 收掉", { skip: !POSIX }, async () => {
  const child = spawn("/bin/bash", ["-c", 'trap "" TERM; while true; do sleep 0.05; done'], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const { pid } = child;
  assert.ok(pid && alivePid(pid), "顽固进程应该起来了");
  try {
    const result = await killTree(new Map(), [pid], [], { graceMs: 300, verifyMs: 800 });
    assert.ok(result.terminated.includes(pid), JSON.stringify(result));
    assert.deepEqual(result.leftover, []);
    assert.equal(alivePid(pid), false);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出。
    }
  }
});

test("killTree：登记表里的 pid 被复用时不会误杀", { skip: !POSIX }, async () => {
  const child = spawn("/bin/bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  child.unref();
  const { pid } = child;
  assert.ok(pid && alivePid(pid), "进程应该起来了");
  try {
    // 启动时刻对不上 = 这个 pid 现在是别的进程了，绝不能发信号。
    const stale = new Map([[pid, "Thu Jan  1 00:00:00 1970"]]);
    const result = await killTree(stale, [], [], { graceMs: 200, verifyMs: 200 });
    assert.deepEqual(result.leftover, []);
    assert.equal(alivePid(pid), true, "对不上的 pid 不能动");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出。
    }
  }
});

test("snapshotProcesses 能读到进程的 ppid 与 pgid", () => {
  const nodes = snapshotProcesses();
  if (!POSIX || nodes.length === 0) return;
  const self = nodes.find((node) => node.pid === process.pid);
  assert.ok(self, "自己的进程应该在快照里");
  assert.equal(self.ppid, process.ppid);
  assert.ok(self.start.length > 0);
});
