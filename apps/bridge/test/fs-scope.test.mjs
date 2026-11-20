import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FS_SCOPE_LOG_PREFIX, FsScope, FsScopeError, scopeCheck } from "../dist/fs-scope.js";
import { HostedSessionManager } from "../dist/hosted/manager.js";

/**
 * 枚举闸门：受保护的用户目录（桌面/文档/下载/音乐/照片）一碰就是 macOS 的
 * 「文件与文件夹」授权弹窗，弹窗不点掉进程就一直挂着。所以闸门必须在碰文件系统
 * 之前就拒绝，而且拒绝要留日志。
 */
function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), "fs-scope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const name of ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Library"]) {
    mkdirSync(join(home, name), { recursive: true });
  }
  mkdirSync(join(home, "Downloads", "invoice"), { recursive: true });
  writeFileSync(join(home, "Downloads", "invoice", "a.txt"), "x");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, "Library", "Application Support", "AgentBridge"), { recursive: true });
  return home;
}

test("受保护的用户目录一律拒绝，并写明命中的是哪一条", (t) => {
  const home = fakeHome(t);
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  for (const name of ["Downloads", "Documents", "Desktop", "Music", "Pictures", "Movies"]) {
    const check = scope.check(join(home, name));
    assert.equal(check.ok, false, name);
    assert.match(check.because, /受保护目录/, name);
    const nested = scope.check(join(home, name, "sub", "file.txt"));
    assert.equal(nested.ok, false, `${name}/sub/file.txt`);
  }
  // 主目录本身也不能当成根：那就是「从 home 开始扫再过滤」。
  assert.equal(scopeCheck(home, [], { home }).ok, false);
});

test("主目录点目录与 Library 数据目录放行，其它主目录路径拒绝", (t) => {
  const home = fakeHome(t);
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  assert.equal(scope.check(join(home, ".pi", "agent", "sessions")).ok, true);
  assert.equal(scope.check(join(home, ".claude", "projects")).ok, true);
  assert.equal(scope.check(join(home, "Library", "Application Support", "AgentBridge", "bridge.db")).ok, true);
  assert.equal(scope.check(join(home, "some-random-folder")).ok, false);
  // 主目录之外不归这道闸门管：系统目录不会弹授权。
  assert.equal(scope.check("/opt/homebrew/bin/pi").ok, true);
  // 外接磁盘另有一道授权（「可移除的宗卷」），没被当成根就不许枚举。
  assert.equal(scope.check("/Volumes/USB-DISK/backup").ok, false);
});

test("用户点过头的根（包括落在桌面上的工程）照旧能进", (t) => {
  const home = fakeHome(t);
  const project = join(home, "Desktop", "my-project");
  mkdirSync(project, { recursive: true });
  const logs = [];
  const scope = new FsScope({ home, roots: () => [project], log: (line) => logs.push(line) });
  assert.equal(scope.check(join(project, "src", "index.ts")).ok, true);
  // 同一个受保护目录里的别的路径仍然拒绝：授权是给这个根的，不是给整个桌面。
  assert.equal(scope.check(join(home, "Desktop", "other")).ok, false);
  assert.throws(() => scope.assert(join(home, "Desktop", "other"), "files.list"), FsScopeError);
  assert.ok(logs.some((line) => line.startsWith(FS_SCOPE_LOG_PREFIX)));
  assert.equal(scope.recentRefusals[0].reason, "files.list");
});

test("工程索引后补登记的根立刻生效", (t) => {
  const home = fakeHome(t);
  const project = join(home, "Documents", "late-project");
  mkdirSync(project, { recursive: true });
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  assert.equal(scope.check(project).ok, false);
  scope.setExtraRoots([project]);
  assert.equal(scope.check(project).ok, true);
});

test("拒绝的路径不会被真正枚举，也不会抛出系统错误", (t) => {
  const home = fakeHome(t);
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  // 目录确实存在：如果闸门放在 readdir 之后，这里就会拿到 invoice 这一项。
  assert.throws(
    () => scope.readdir(join(home, "Downloads"), "files.list"),
    (error) => error instanceof FsScopeError && /受保护目录/.test(error.message),
  );
  assert.throws(() => scope.stat(join(home, "Downloads"), "files.list"), FsScopeError);
  assert.throws(() => scope.realpath(join(home, "Downloads", "invoice"), "files.resolve"), FsScopeError);
  assert.throws(() => scope.open(join(home, "Downloads", "invoice", "a.txt"), "files.read", { flags: "r" }), FsScopeError);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4343;
    this.stdin = { write: () => true, end: () => undefined };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.emit("exit", 0, null);
    return true;
  }
}

function hostedHarness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "hosted-stall-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000 }));
  const children = [];
  const manager = new HostedSessionManager({
    stateDir,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    ...options,
  });
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, repo, children };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("一轮忙了很久没有输出就标成疑似卡住，恢复输出后清掉", async (t) => {
  const { manager, repo, children } = hostedHarness(t, { stallMs: 40, stallCheckMs: 10 });
  const session = manager.create({ path: repo });
  // 发一条消息就不再有 result：live.busy 置位，之后完全取决于有没有输出。
  await manager.send(session.sessionId, "你好");
  assert.equal(manager.session(session.sessionId)?.busy, true);
  assert.equal(manager.session(session.sessionId)?.stalledSince, undefined);

  await sleep(120);
  const stalled = manager.session(session.sessionId);
  assert.equal(stalled?.busy, true);
  assert.equal(typeof stalled?.stalledSince, "number");

  // 子进程一旦有输出，卡住标记立刻消失。
  children[0].stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init" })}\n`);
  assert.equal(manager.session(session.sessionId)?.stalledSince, undefined);
});
