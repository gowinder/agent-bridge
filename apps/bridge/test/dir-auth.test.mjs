import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  // 去系统设置勾上之后，再点一次「+」就该重新探。
  result = "ok";
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(probes.length, 2);
  assert.equal(authOf(h.manager, h.allowed), "ok");
});

test("超时（弹框没人点）算 pending，不当成可用，也不写进持久化", async (t) => {
  const h = harness(t, { probeDir: () => Promise.resolve("timeout") });
  h.manager.setDirs([h.allowed]);
  await settle();
  assert.equal(authOf(h.manager, h.allowed), "pending");
  assert.equal(existsSync(join(h.stateDir, "hosted", "dir-auth.json")), false);
  // 重启后回到 unknown：下次打开设置还会再探一次。
  h.manager.dispose();
  const manager = new HostedSessionManager({
    stateDir: h.stateDir,
    log: () => undefined,
    spawn: () => {
      throw new Error("不该起会话进程");
    },
    probeDir: () => Promise.resolve("ok"),
  });
  t.after(() => manager.dispose());
  assert.equal(authOf(manager, h.allowed), "unknown");
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
