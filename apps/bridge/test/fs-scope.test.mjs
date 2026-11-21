import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

test("主目录外的符号链接指向受保护目录时，闸门不许跟着链接走进去", (t) => {
  const home = fakeHome(t);
  // 链接必须建在主目录之外：主目录内的路径无论如何都会按前缀规则判，测不出这条后门。
  const outside = mkdtempSync(join(tmpdir(), "fs-scope-link-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const link = join(outside, "link");
  symlinkSync(join(home, "Downloads"), link);
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  // 纯字符串看是「主目录外」，但解析链接后落在 ~/Downloads。
  const check = scope.check(link);
  assert.equal(check.ok, false);
  assert.match(check.because, /受保护目录 ~\/Downloads/);
  assert.throws(() => scope.readdir(link, "files.list"), FsScopeError);
  assert.throws(() => scope.stat(join(link, "invoice"), "files.list"), FsScopeError);
  // 链接指向允许的目录时照旧能用。
  const okLink = join(outside, "ok-link");
  symlinkSync(join(home, ".pi", "agent"), okLink);
  assert.equal(scope.check(okLink).ok, true);
});

test("闸门在文件系统调用之前：不存在的越界路径报 FsScopeError 而不是 ENOENT", (t) => {
  const home = fakeHome(t);
  const scope = new FsScope({ home, roots: () => [], log: () => undefined });
  const ghost = join(home, "Downloads", `ghost-${process.pid}-${Date.now()}`, "file.txt");
  // 闸门在后的话这里会是 ENOENT（普通 Error），足以把「先判后碰」钉住。
  assert.throws(() => scope.stat(ghost, "files.read"), (error) => error instanceof FsScopeError);
  assert.throws(() => scope.readdir(join(home, "Music"), "files.list"), (error) => error instanceof FsScopeError);
});

test("同一条越界的日志每分钟最多一条，记录也只留一份", (t) => {
  const home = fakeHome(t);
  let clock = 1_000_000;
  const logs = [];
  const scope = new FsScope({ home, roots: () => [], now: () => clock, log: (line) => logs.push(line) });
  const target = join(home, "Downloads");
  for (let index = 0; index < 5; index += 1) {
    assert.throws(() => scope.stat(target, "hosted.cwd"), FsScopeError);
  }
  assert.equal(logs.length, 1);
  assert.equal(scope.recentRefusals.length, 1);
  // 过了静默窗口才允许再记一条。
  clock += 61_000;
  assert.throws(() => scope.stat(target, "hosted.cwd"), FsScopeError);
  assert.equal(logs.length, 2);
  assert.equal(scope.recentRefusals.length, 1);
});

test("白名单目录用符号链接写法时，realpath 写法也必须是授权根", (t) => {
  const home = fakeHome(t);
  const real = join(home, "real-project");
  mkdirSync(real, { recursive: true });
  const link = join(home, "linked-project");
  symlinkSync(real, link);
  // 只登记原样写法：record.cwd 存的是 realpath 后的值，会被判成越界（历史 bug）。
  const onlyLink = new FsScope({ home, roots: () => [link], log: () => undefined });
  assert.equal(onlyLink.check(link).ok, true);
  assert.equal(onlyLink.check(real).ok, false);
  // 两种写法都登记（Bridge 的做法）才两边都认。
  const both = new FsScope({ home, roots: () => [link, real], log: () => undefined });
  assert.equal(both.check(link).ok, true);
  assert.equal(both.check(real).ok, true);
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

test("Bridge 重启的自动续跑不会按越界的工作目录拉起进程", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hosted-resume-"));
  const allowed = join(root, "allowed");
  const stateDir = join(root, "state");
  mkdirSync(allowed);
  mkdirSync(join(stateDir, "hosted"), { recursive: true });
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [allowed], idleTimeoutMs: 60_000 }));
  // 白名单收紧之后，旧记录还指着受保护目录，且上一轮没跑完（pendingText）。
  writeFileSync(
    join(stateDir, "hosted", "sessions.json"),
    JSON.stringify({
      sessions: [
        {
          id: "leftover",
          cwd: join(homedir(), "Downloads"),
          title: "旧会话",
          permissionMode: "manual",
          pendingText: "继续",
          createdAt: 1,
          updatedAt: 2,
          lastActiveAt: 2,
        },
      ],
    }),
  );
  const spawns = [];
  const logs = [];
  const manager = new HostedSessionManager({
    stateDir,
    log: (line) => logs.push(line),
    spawn: () => {
      spawns.push("spawned");
      throw new Error("不应该启动进程");
    },
  });
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  // recover() 在构造里同步跑完（没有 sessiond 时走 resumeInterrupted）。
  assert.deepEqual(spawns, []);
  assert.ok(logs.some((line) => line.includes("auto-resume skipped")));
  const session = manager.sessions().find((item) => item.title === "旧会话");
  assert.equal(session?.canSend, false);
  assert.match(session?.sendBlockedReason ?? "", /不在托管白名单里|已不存在/);
});

test("等网页回答权限的轮次不算「疑似卡住」", async (t) => {
  const { manager, repo, children } = hostedHarness(t, { stallMs: 40, stallCheckMs: 10 });
  const session = manager.create({ path: repo });
  await manager.send(session.sessionId, "你好");
  const live = manager["live"].get(session.sessionId.replace("hosted:", ""));
  assert.ok(live);
  live.pending = { requestId: "r1", toolName: "Bash", input: {} };
  await sleep(140);
  assert.equal(manager.session(session.sessionId)?.stalledSince, undefined);
  // 人答完之后继续无输出，才重新算卡住。
  live.pending = null;
  await sleep(140);
  assert.equal(typeof manager.session(session.sessionId)?.stalledSince, "number");
  void children;
});

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
