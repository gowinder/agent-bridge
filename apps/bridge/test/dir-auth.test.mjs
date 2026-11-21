import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeHostedDirs } from "../dist/adapters/index.js";
import { permissionError } from "../dist/devtools.js";
import { HostedSessionManager } from "../dist/hosted/manager.js";

/**
 * 目录授权探测：TCC 的授权只在**真读**（readdir/open）时生效，`realpath`/`stat` 不弹框。
 * 所以「加目录」这一刻要主动探一次，把授权提前到人在机器前的时候；探测结果要能持久化，
 * 否则每次重启都重新弹一遍。
 */
function harness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dir-auth-"));
  const stateDir = join(root, "state");
  const allowed = join(root, "allowed");
  const other = join(root, "other");
  for (const dir of [stateDir, allowed, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [], idleTimeoutMs: 600_000 }));
  const realAllowed = realpathSync(allowed);
  const realOther = realpathSync(other);
  const probes = [];
  const manager = new HostedSessionManager({
    stateDir,
    log: () => undefined,
    spawn: () => {
      throw new Error("探测不该起会话进程");
    },
    probeDir:
      options.probeDir ??
      ((path) => {
        probes.push(path);
        return Promise.resolve("ok");
      }),
  });
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, root, stateDir, allowed: realAllowed, other: realOther, probes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function authOf(manager, path) {
  return manager.configForClient().dirs.find((dir) => dir.path === path)?.auth;
}

test("加目录时当场探一次：先 pending，授权后变 ok 并记下来", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(t, { probeDir: () => pending });
  h.manager.setDirs([h.allowed]);
  // 探测还没回来：不能显示成可用，界面上要能提示「等待系统授权」。
  assert.equal(authOf(h.manager, h.allowed), "pending");
  release("ok");
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "ok");
  const stored = JSON.parse(readFileSync(join(h.stateDir, "hosted", "dir-auth.json"), "utf8"));
  assert.deepEqual(stored, { [h.allowed]: "ok" });
});

test("已授权的目录不再重复弹框，重启后也记得", async (t) => {
  const h = harness(t);
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(h.probes.length, 1);
  h.manager.setDirs([h.allowed, h.other]);
  await settle();
  // 只探新加的那个。
  assert.equal(h.probes.length, 2);
  assert.equal(h.probes[1], h.other);

  // 换一个 manager（相当于重启）：ok 的那两个都不再探。
  const again = [];
  const manager = new HostedSessionManager({
    stateDir: h.stateDir,
    log: () => undefined,
    spawn: () => {
      throw new Error("不该起会话进程");
    },
    probeDir: (path) => {
      again.push(path);
      return Promise.resolve("ok");
    },
  });
  t.after(() => manager.dispose());
  assert.equal(authOf(manager, h.allowed), "ok");
  manager.setDirs([h.allowed]);
  await settle();
  assert.deepEqual(again, []);
});

test("被拒绝的目录再添加一次会重新弹框（用户可能刚去系统设置授权）", async (t) => {
  let result = "denied";
  const probes = [];
  const h = harness(t, {
    probeDir: (path) => {
      probes.push(path);
      return Promise.resolve(result);
    },
  });
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "denied");
  // 整份写回（没显式要求重探）不该再弹一次。
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(probes.length, 1);
  // 去系统设置勾上之后，点「+」重新添加会带上 probe，才重新探。
  result = "ok";
  h.manager.setDirs([h.allowed], [h.allowed]);
  await settle();
  assert.equal(probes.length, 2);
  assert.equal(authOf(h.manager, h.allowed), "ok");
});

test("整份写回白名单不会把其它未授权目录再弹一遍", async (t) => {
  const probes = [];
  const h = harness(t, {
    probeDir: (path) => {
      probes.push(path);
      return Promise.resolve("denied");
    },
  });
  h.manager.setDirs([h.allowed, h.other]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(probes.length, 2);
  // 删掉一个目录（整份写回），剩下的那个虽然是 denied，也不该被重新弹框。
  h.manager.setDirs([h.allowed]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(probes.length, 2);
});

test("移除后立刻加回同一个目录，不会因为旧探测再弹一次", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const probes = [];
  const h = harness(t, {
    probeDir: (path) => {
      probes.push(path);
      return pending;
    },
  });
  h.manager.setDirs([h.allowed, h.other]);
  assert.equal(probes.length, 1);
  h.manager.setDirs([h.other]);   // 移除 allowed
  h.manager.setDirs([h.allowed, h.other], [h.allowed]); // 立刻加回
  release("ok");
  await new Promise((resolve) => setTimeout(resolve, 60));
  // allowed 只该被探两次（旧的那次 + 加回后的新一次），排队里那条被移除的不能再生效。
  assert.equal(probes.filter((path) => path === h.allowed).length, 2);
});

test("探测出错（非 EPERM）算 unknown，不冒充「没授权」", async (t) => {
  const h = harness(t, { probeDir: () => Promise.resolve("unknown") });
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "unknown");
  assert.equal(existsSync(join(h.stateDir, "hosted", "dir-auth.json")), false);
});

test("超时（弹框没人点）回到「待确认」，不当成可用，也不写进持久化", async (t) => {
  const h = harness(t, { probeDir: () => Promise.resolve("timeout") });
  h.manager.setDirs([h.allowed]);
  await settle();
  // pending 只代表「这 20 秒还在等」；没人点就回到 unknown，界面写「待确认」。
  assert.equal(authOf(h.manager, h.allowed), "unknown");
  assert.equal(existsSync(join(h.stateDir, "hosted", "dir-auth.json")), false);
});

test("一次加多个目录时弹窗一个一个来，不会同时糊一屏", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const finished = [];
  const h = harness(t, {
    probeDir: async (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      finished.push(path);
      return "ok";
    },
  });
  h.manager.setDirs([h.allowed, h.other]);
  // 两个目录都排上了队，但同一时刻只有一个在跑。
  assert.equal(authOf(h.manager, h.allowed), "pending");
  assert.equal(authOf(h.manager, h.other), "pending");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(peak, 1, "同一时刻只能有一个探测在跑");
  assert.deepEqual(finished, [h.allowed, h.other]);
  assert.equal(authOf(h.manager, h.allowed), "ok");
  assert.equal(authOf(h.manager, h.other), "ok");
});

test("同一个目录并发添加不会同时弹两个框", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const probes = [];
  const h = harness(t, {
    probeDir: (path) => {
      probes.push(path);
      return pending;
    },
  });
  h.manager.setDirs([h.allowed]);
  h.manager.setDirs([h.allowed]);
  h.manager.setDirs([h.allowed]);
  assert.equal(probes.length, 1);
  release("ok");
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "ok");
});

test("系统拒绝（EPERM/EACCES）报「缺授权」，别的错误不冒充", () => {
  const denied = permissionError(Object.assign(new Error("denied"), { code: "EPERM" }));
  assert.equal(denied?.code, "unauthorized");
  assert.match(denied?.message ?? "", /macOS/);
  assert.equal(permissionError(Object.assign(new Error("denied"), { code: "EACCES" }))?.code, "unauthorized");
  // 路径不存在、不是目录之类不能借这条文案：那会把「删掉的目录」说成「没授权」。
  assert.equal(permissionError(Object.assign(new Error("gone"), { code: "ENOENT" })), null);
  assert.equal(permissionError(new Error("boom")), null);
});

test("目录移出白名单后，授权状态与排队的探测一起清掉", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const probes = [];
  const h = harness(t, {
    probeDir: (path) => {
      probes.push(path);
      return pending;
    },
  });
  h.manager.setDirs([h.allowed, h.other]);
  // 串行：第一个在跑，第二个在排队。
  assert.equal(probes.length, 1);
  h.manager.setDirs([h.allowed]);
  assert.equal(authOf(h.manager, h.other), undefined);
  release("ok");
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "ok");
  // 被移除的目录不该再弹一次框。
  assert.equal(probes.length, 1);
  const stored = JSON.parse(readFileSync(join(h.stateDir, "hosted", "dir-auth.json"), "utf8"));
  assert.deepEqual(stored, { [h.allowed]: "ok" });
});

test("菜单栏读的 /hosted 管理接口会带上 auth（否则整块状态 UI 是死代码）", async (t) => {
  const h = harness(t);
  h.manager.setDirs([h.allowed]);
  await settle();
  const summary = summarizeHostedDirs(h.manager.configForClient());
  assert.equal(summary.dirs[0]?.auth, "ok");
});

test("打开设定复核时，授权被系统撤销就降级成 denied；启动时不再自动弹框", async (t) => {
  // 先造一份 ok 的记录。
  const first = harness(t);
  first.manager.setDirs([first.allowed]);
  await settle();
  assert.equal(authOf(first.manager, first.allowed), "ok");
  first.manager.dispose();

  // 重启：启动阶段不该自动探测（未签名构建每次更新都会让 TCC 授权作废，一启动就弹框）。
  const probes = [];
  const manager = new HostedSessionManager({
    stateDir: first.stateDir,
    log: () => undefined,
    spawn: () => {
      throw new Error("不该起会话进程");
    },
    probeDir: (path) => {
      probes.push(path);
      return Promise.resolve("denied");
    },
  });
  t.after(() => manager.dispose());
  assert.equal(authOf(manager, first.allowed), "ok");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(probes, []);
  assert.equal(authOf(manager, first.allowed), "ok");

  // 打开设定时才复核：系统那边已经撤销了，探测要把它降级。
  manager.reprobeDirs();
  await settle();
  assert.deepEqual(probes, [first.allowed]);
  assert.equal(authOf(manager, first.allowed), "denied");
});

test("probe 里的越界路径只做字符串匹配，不会被送去 realpath 或探测", async (t) => {
  const h = harness(t);
  const targets = [
    join(homedir(), "Downloads"),
    join(homedir(), "Desktop"),
    join(homedir(), "Documents"),
    "/etc/passwd",
    "/Volumes/whatever",
  ];
  // 这些都不在白名单里：既不该起探测，也不该报错（客户端可能发来旧路径）。
  h.manager.setDirs([h.allowed], targets);
  await settle();
  assert.deepEqual(h.probes, [h.allowed]);
});

test("打开设定复核会把升级前的 unknown 目录确认成 ok（不再误报未授权）", async (t) => {
  // 只有白名单、没有 dir-auth.json：就是「升级前就存在的目录」的形态。
  const root = mkdtempSync(join(tmpdir(), "dir-auth-unknown-"));
  const stateDir = join(root, "state");
  const allowed = join(root, "allowed");
  for (const dir of [stateDir, allowed]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [allowed], idleTimeoutMs: 600_000 }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new HostedSessionManager({
    stateDir,
    log: () => undefined,
    spawn: () => {
      throw new Error("不该起会话进程");
    },
    probeDir: () => Promise.resolve("ok"),
  });
  t.after(() => manager.dispose());
  // hosted.json 里是原样写法（未 canonical）：configForClient 也按原样报，两种都得认。
  assert.equal(authOf(manager, allowed), "unknown");
  manager.reprobeDirs();
  await settle();
  assert.equal(authOf(manager, allowed), "ok");
});
