/**
 * 会话登记册（spec §2 / DESIGN §3）：调用方任务线 ↔ Bridge sessionId 的映射，
 * 外加发送审计。这里绝不放消息全文，只存哈希与元数据。
 *
 * 结构：
 * {
 *   version: 1,
 *   updatedAt: ISO,
 *   sessions: [{
 *     key, engine, cwd, purpose,        // key = engine|cwd|purpose（purpose 归一化）
 *     sessionId, title,
 *     createdAt, lastUsedAt,            // ISO
 *     archived: boolean,
 *     inFlight: { operationId, at } | null   // 本 server 发起的未完成回合
 *   }],
 *   audit: [{ at, action, sessionId, ... }]   // 只追加，保留最近 AUDIT_LIMIT 条
 * }
 */

import { createHash, randomUUID } from "node:crypto";
import { acquireFileLock } from "./lock.mjs";
import { ensureStateDir, readJson, statePaths, writeStateJsonAtomic } from "./state.mjs";

export const REGISTRY_VERSION = 1;
const AUDIT_LIMIT = 500;

function nowIso() {
  return new Date().toISOString();
}

/** 用途线归一化：大小写/空白不同算同一条线，避免同一个用途被拆成多条登记。 */
export function normalizePurpose(purpose) {
  return String(purpose ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sessionKey({ engine, cwd, purpose }) {
  return `${String(engine ?? "").trim()}|${String(cwd ?? "").trim()}|${normalizePurpose(purpose)}`;
}

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, updatedAt: nowIso(), sessions: [], audit: [] };
}

/** 读登记册；文件缺失或结构损坏都退回空表（损坏时留一条 warning 给调用方）。 */
export async function loadRegistry() {
  const { registry: path } = statePaths();
  const raw = await readJson(path);
  if (raw === null) return { registry: emptyRegistry(), warnings: [] };
  const warnings = [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { registry: emptyRegistry(), warnings: ["registry.json 不是对象，已按空表处理"] };
  }
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.filter((item) => item && typeof item === "object" && typeof item.sessionId === "string")
    : [];
  if (Array.isArray(raw.sessions) && sessions.length !== raw.sessions.length) {
    warnings.push("registry.json 里有条目缺 sessionId，已丢弃");
  }
  const audit = Array.isArray(raw.audit) ? raw.audit.filter((item) => item && typeof item === "object") : [];
  return {
    registry: {
      version: REGISTRY_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
      sessions,
      audit,
    },
    warnings,
  };
}

export async function saveRegistry(registry) {
  const next = {
    ...registry,
    version: REGISTRY_VERSION,
    updatedAt: nowIso(),
    audit: registry.audit.slice(-AUDIT_LIMIT),
  };
  const { registry: path } = statePaths();
  await ensureStateDir();
  // 原子写：rename 前读方只会看到旧版本或新版本，不会看到半截 JSON。
  await writeStateJsonAtomic(path, next);
  return next;
}

/*
 * ---------------------------------------------------------------- 登记册事务
 *
 * 规矩（lost-update 修复，见 CHANGELOG「MCP server 的会话登记册加了跨进程文件锁与事务 API」）：
 *   - 任何 read-modify-write 都必须在 state/registry.json.lock 这把跨进程锁里做；
 *   - 锁内只允许纯登记册操作；网络 I/O（bridge 调用、轮询）一律放在锁外；
 *   - 「先网络、后落账」的调用点必须分两段锁：第一段只读置判断，第二段**重新 load 最新**
 *     再应用结果——绝不保存网络调用之前加载的快照。
 */

/** 读一致快照（锁内 load，不写回）。只读工具（bridge_status / session_list / 各类闸门）用。 */
export async function readRegistry(options) {
  const { registryLock } = statePaths();
  const release = await acquireFileLock(registryLock, options);
  try {
    return await loadRegistry();
  } finally {
    await release();
  }
}

/**
 * 单段临界区：锁内 load 最新 → mutator(registry) 做纯变更 → save → 解锁。
 * mutator 抛错则不保存（事务不生效），锁照样释放。
 * 返回 { registry: 落盘后的登记册, result: mutator 的返回值, warnings }。
 */
export async function updateRegistry(mutator, options) {
  const { registryLock } = statePaths();
  const release = await acquireFileLock(registryLock, options);
  try {
    const { registry, warnings } = await loadRegistry();
    const result = await mutator(registry);
    const saved = await saveRegistry(registry);
    return { registry: saved, result, warnings };
  } finally {
    await release();
  }
}

export function findByKey(registry, key) {
  return registry.sessions.find((item) => item.key === key) ?? null;
}

export function findBySessionId(registry, sessionId) {
  return registry.sessions.find((item) => item.sessionId === sessionId) ?? null;
}

/** 新建或更新一条登记（同一 key 只留一条；同一 sessionId 只留一条）。 */
export function upsertSession(registry, entry) {
  const key = entry.key ?? sessionKey(entry);
  const at = entry.lastUsedAt ?? nowIso();
  const filtered = registry.sessions.filter(
    (item) => item.key !== key && item.sessionId !== entry.sessionId,
  );
  const previous = registry.sessions.find((item) => item.key === key || item.sessionId === entry.sessionId);
  const merged = {
    key,
    engine: entry.engine,
    cwd: entry.cwd,
    purpose: entry.purpose,
    sessionId: entry.sessionId,
    title: entry.title ?? previous?.title ?? "",
    createdAt: entry.createdAt ?? previous?.createdAt ?? at,
    lastUsedAt: at,
    archived: entry.archived ?? previous?.archived ?? false,
    inFlight: entry.inFlight ?? null,
  };
  registry.sessions = [...filtered, merged];
  return merged;
}

export function touchSession(registry, sessionId) {
  const entry = findBySessionId(registry, sessionId);
  if (!entry) return null;
  entry.lastUsedAt = nowIso();
  return entry;
}

export function setArchived(registry, sessionId, archived = true) {
  const entry = findBySessionId(registry, sessionId);
  if (!entry) return null;
  entry.archived = archived === true;
  entry.lastUsedAt = nowIso();
  if (entry.archived) entry.inFlight = null;
  return entry;
}

export function setInFlight(registry, sessionId, inFlight) {
  const entry = findBySessionId(registry, sessionId);
  if (!entry) return null;
  entry.inFlight = inFlight;
  return entry;
}

export function appendAudit(registry, event) {
  registry.audit.push({ at: nowIso(), ...event });
  if (registry.audit.length > AUDIT_LIMIT) registry.audit = registry.audit.slice(-AUDIT_LIMIT);
  return registry.audit.at(-1);
}

/** 幂等查询：同一 operationId 是否已经有投递成功的发送审计（bridge 不看 operationId，幂等在本层）。 */
export function findAcceptedSend(registry, sessionId, operationId) {
  if (!operationId) return null;
  return (
    registry.audit.find(
      (item) =>
        item.action === "session_send" &&
        item.operationId === operationId &&
        item.sessionId === sessionId &&
        item.accepted === true,
    ) ?? null
  );
}

/** 消息审计只存哈希：够对账，不存正文。 */
export function messageDigest(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function operationId() {
  return randomUUID();
}

/** 给调用方看的摘录：登记册内部字段原样，但不暴露消息内容（本来也没存）。 */
export function describeEntry(entry) {
  return {
    key: entry.key,
    engine: entry.engine,
    cwd: entry.cwd,
    purpose: entry.purpose,
    sessionId: entry.sessionId,
    title: entry.title,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    archived: entry.archived === true,
    inFlight: entry.inFlight ?? null,
  };
}
