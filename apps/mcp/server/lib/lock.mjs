/**
 * 跨进程文件锁（O_EXCL 独占创建）。
 *
 * 为什么需要：每个工具调用都是短命新进程，登记册是「全量读 → 内存改 → 整文件写回」。
 * 没有锁时，两个进程各自读到同一份旧快照、先后写回，后者会把前者刚写入的条目与审计
 * 静默盖掉（registry lost-update，2026-11-27 生产实证）。
 *
 * 约定：
 *   - 锁文件内容只有 { pid, host, at, token }：够做陈旧判定与「只删自己的锁」，不含任何业务数据。
 *   - 陈旧锁回收分三条通道（安全审计 SECURITY-AUDIT-LOCKFIX §5-E2 / §8 M-1、L-2）：
 *       1) 死 pid（同机、ESRCH）：持有者都是短命进程，已退出 → 立即回收，不等锁龄。
 *       2) 活 pid 但锁龄 > staleMs（默认 120s，远大于毫秒级临界区）：**不立即抢占**，
 *          先等 ≥300ms 再重新 stat 二次确认；确认期间持有者有任何活动迹象
 *          （inode/dev 变、锁被释放或重建、token 或 pid 变了、mtime 被刷新、锁龄不再超阈值）
 *          就放弃回收，继续退避等待。这样「临界区里被 SIGSTOP/调试器/VM 挂起 >staleMs
 *          然后醒来照旧整文件写回」的 lost-update 形态不会发生。
 *       3) 锁内容不可解析/空文件（崩在 open 与 writeFile 之间）：走短确认通道——
 *          250ms 后复查，仍不可解析且 mtime 年龄 >2s 才回收；不让这种残留按 120s 堵住全量调用。
 *   - 三条通道回收前都比对 inode（+dev），避免把别人刚接手的锁删掉。
 *   - 释放时只在自己 token 仍然匹配时删除锁文件（陈旧回收后接手的进程不会被误删）。
 *   - 所有路径 finally 释放；临界区里绝不许放网络 I/O。
 *   - 时间参数（timeoutMs / staleMs / 二次确认窗口 / 不可解析通道）都可注入，便于自测压缩时间；
 *     生产默认值就是下面的常量。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { ToolError } from "./errors.mjs";
import { sleep } from "./state.mjs";

/** 生产默认定时参数（自测会读它断言口径，也可按需注入压缩时间）。 */
export const LOCK_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  /** 活持有者的锁龄阈值：临界区是毫秒级，20s 太近（审计 M-1 建议 120–300s）。 */
  staleMs: 120_000,
  /** 活持有者超龄后必须二次确认：至少等这么久再重新 stat。 */
  confirmMs: 300,
  /** 不可解析/空锁的短确认通道：等这么久再复查。 */
  unparsableConfirmMs: 250,
  /** 不可解析/空锁的 mtime 最小年龄：更新鲜的一律当作「正在创建」，不回收。 */
  unparsableMinAgeMs: 2_000,
});
const BACKOFF_MIN_MS = 4;
const BACKOFF_MAX_MS = 120;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // 信息不全时按「活着」处理，只靠锁龄判定
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但属别的用户（同一台 Mac 上会出现），仍算活着。
    return error?.code !== "ESRCH";
  }
}

async function readLockInfo(path) {
  try {
    const info = JSON.parse(await readFile(path, "utf8"));
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

async function tryCreate(path, token) {
  const payload = { pid: process.pid, host: hostname(), at: new Date().toISOString(), token };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`);
  } finally {
    await handle.close();
  }
  return payload;
}

/** 同一个文件吗：inode 相同（有 dev 时也比 dev，ino 只在单文件系统内唯一）。 */
function sameLockFile(before, after) {
  if (!before || !after) return false;
  if (before.ino !== after.ino) return false;
  if (before.dev !== undefined && after.dev !== undefined && before.dev !== after.dev) return false;
  return true;
}

/** 同一个 pid 吗：两边都缺 pid（非本库写的锁）也算同一条。 */
function samePid(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (Number.isNaN(left) && Number.isNaN(right)) return true;
  return left === right;
}

/**
 * 删除前再确认一次「还是刚才那个文件」，把 stat → unlink 的窗口收到最小。
 * 期间锁变了（别人释放后重建）就返回 true 让调用方直接重试抢锁。
 */
async function unlinkIfUnchanged(path, before) {
  const current = await stat(path).catch(() => null);
  if (!sameLockFile(before, current)) return true;
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

/**
 * 不可解析/空锁（崩溃残留，或正处在「创建后写内容之前」的微秒窗口）：
 * 250ms 后复查，仍不可解析且 mtime 年龄 >2s 才回收（同样比 inode）。
 */
async function reclaimUnparsable(path, before, { unparsableConfirmMs, unparsableMinAgeMs }) {
  // mtime 太新鲜 → 可能正是别人刚 open、还没写内容，退避等待，不回收。
  if (Date.now() - before.mtimeMs <= unparsableMinAgeMs) return false;
  await sleep(unparsableConfirmMs);
  const after = await stat(path).catch(() => null);
  if (!sameLockFile(before, after)) return true; // 期间被换掉 → 放弃回收
  if (await readLockInfo(path)) return false; // 内容已写完：交给正常判定，本次不回收
  if (Date.now() - after.mtimeMs <= unparsableMinAgeMs) return false; // 期间被写过 → 有活动
  return unlinkIfUnchanged(path, after);
}

/**
 * 只回收确实陈旧的锁。
 * 返回 true = 可以直接重试抢锁（回收成功，或锁在判定期间已经变了）；
 * 返回 false = 不回收，调用方按退避继续等。
 */
async function reclaimIfStale(path, { staleMs, confirmMs, unparsableConfirmMs, unparsableMinAgeMs }) {
  let before;
  try {
    before = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const info = await readLockInfo(path);
  if (!info) return reclaimUnparsable(path, before, { unparsableConfirmMs, unparsableMinAgeMs });

  const ageMs = Date.now() - before.mtimeMs;
  const sameHost = typeof info.host === "string" && info.host === hostname();
  const alive = sameHost ? processAlive(info?.pid) : true; // 跨机时 pid 无意义，只看锁龄

  // 通道 1：活着的持有者、锁龄未超阈值 → 正常等待。
  if (alive && ageMs <= staleMs) return false;
  // 通道 1'：同机死 pid → 立即回收（不要求锁龄，保持原有「kill -9 自愈」行为）。
  if (sameHost && !alive) return unlinkIfUnchanged(path, before);

  // 通道 2：活持有者但锁龄超阈值 → 二次确认后再决定。
  await sleep(confirmMs);
  const after = await stat(path).catch(() => null);
  if (!sameLockFile(before, after)) return true; // 锁被释放/重建/换文件 → 放弃回收
  const recheck = await readLockInfo(path);
  if (!recheck) return true; // 内容在确认期间变了（半截/被改写）→ 放弃回收
  if (String(recheck.token ?? "") !== String(info.token ?? "")) return true; // 已转手
  if (!samePid(recheck.pid, info.pid)) return true; // 记录的 pid 不再是同一个
  if (after.mtimeMs !== before.mtimeMs) return false; // 持有者刷新过锁 → 仍在活动
  if (Date.now() - after.mtimeMs <= staleMs) return false; // 锁龄已不再超阈值
  return unlinkIfUnchanged(path, after);
}

/**
 * 抢 `<path>` 这把锁，返回 release()（幂等，可重复调用）。
 * 拿不到就在 timeoutMs 内退避重试；超时抛 ToolError（结构化 code，不静默继续写）。
 */
export async function acquireFileLock(
  path,
  {
    timeoutMs = LOCK_DEFAULTS.timeoutMs,
    staleMs = LOCK_DEFAULTS.staleMs,
    confirmMs = LOCK_DEFAULTS.confirmMs,
    unparsableConfirmMs = LOCK_DEFAULTS.unparsableConfirmMs,
    unparsableMinAgeMs = LOCK_DEFAULTS.unparsableMinAgeMs,
  } = {},
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const reclaimOptions = { staleMs, confirmMs, unparsableConfirmMs, unparsableMinAgeMs };
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    const token = randomUUID();
    const payload = await tryCreate(path, token);
    if (payload) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readLockInfo(path);
        // token 不匹配说明锁已被判陈旧并转手，绝不能删别人的锁。
        if (!current || current.token !== token) return;
        await unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    }
    const reclaimed = await reclaimIfStale(path, reclaimOptions);
    if (reclaimed) continue;
    if (Date.now() >= deadline) {
      const holder = await readLockInfo(path);
      throw new ToolError(
        "lock_timeout",
        `等待文件锁超时（${Date.now() - started}ms）：${path} 仍被 pid ${holder?.pid ?? "未知"} 持有（开始于 ${holder?.at ?? "未知"}）。`,
        {
          hint: `持有者都是短命进程；它退出后锁会被立即回收；若它还活着但锁龄超过 ${Math.round(staleMs / 1000)}s 且二次确认无活动，才会被回收。持续出现请检查是否有卡住的 agent-bridge 进程。`,
          details: { path, timeoutMs, staleMs, holder },
        },
      );
    }
    await sleep(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

/** 临界区包装：无论回调成功、抛错都释放锁。 */
export async function withFileLock(path, fn, options) {
  const release = await acquireFileLock(path, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
