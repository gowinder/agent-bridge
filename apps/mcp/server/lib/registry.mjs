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
import { ensureStateDir, readJson, statePaths, writeStateJson } from "./state.mjs";

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
  await writeStateJson(path, next);
  return next;
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
