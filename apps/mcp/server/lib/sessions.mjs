/**
 * 会话操作的小工具：摘要、查找、标签。只调用 §3 白名单内的协议方法：
 * session.list / tag.list / tag.save / session.tags。
 */

import { randomUUID } from "node:crypto";
import { ToolError } from "./errors.mjs";

export const MCP_TAG_NAME = "MCP";
export const MCP_TAG_COLOR = "blue";

export function summarize(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    title: session.title,
    appId: session.appId,
    projectId: session.projectId,
    kind: session.kind,
    cwd: session.cwd ?? null,
    archived: session.archived === true,
    hosted: session.hosted === true,
    hostedState: session.hostedState ?? null,
    hostedAgent: session.hostedAgent ?? null,
    permissionMode: session.permissionMode ?? null,
    model: session.model ?? null,
    effort: session.effort ?? null,
    subagentModel: session.subagentModel ?? null,
    busy: session.busy === true,
    needsDecision: session.needsDecision === true,
    canSend: session.canSend !== false,
    sendBlockedReason: session.sendBlockedReason ?? null,
    live: session.live === true,
    pinned: session.pinned === true,
    tags: Array.isArray(session.tags) ? session.tags.map((tag) => tag.name) : [],
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
  };
}

/**
 * 只用白名单内的 session.list（含归档）查会话摘要：
 * 不引入 session.get 这类表外方法，代价是多传一次列表。
 */
export async function findSession(link, sessionId, { timeoutMs = 60_000 } = {}) {
  const list = await link.call("session.list", { includeArchived: true }, { timeoutMs });
  return (list?.sessions ?? []).find((item) => item.sessionId === sessionId) ?? null;
}

/** 标签库是 Bridge 级的：先找同名标签，没有才建，避免 MCP 标签越建越多。 */
export async function ensureTag(link, name = MCP_TAG_NAME, color = MCP_TAG_COLOR) {
  const result = await link.call("tag.list", undefined, { timeoutMs: 30_000 });
  const tags = Array.isArray(result?.tags) ? result.tags : [];
  const found = tags.find((tag) => String(tag.name ?? "").toLowerCase() === name.toLowerCase());
  if (found) return { tag: found, created: false };
  const tag = await link.call("tag.save", { name, color }, { timeoutMs: 30_000 });
  if (!tag?.tagId) throw new ToolError("tag_save_failed", "bridge 没有返回新标签的 tagId。", { details: tag });
  return { tag, created: true };
}

/** 把标签并进会话现有标签集合（session.tags 是整体替换，必须带上原有的）。 */
export async function attachTag(link, sessionId, tagId) {
  const current = await findSession(link, sessionId, { timeoutMs: 60_000 });
  const ids = new Set(
    Array.isArray(current?.tags) ? current.tags.map((tag) => tag.tagId).filter((id) => typeof id === "string") : [],
  );
  ids.add(tagId);
  const result = await link.call(
    "session.tags",
    { sessionId, tagIds: [...ids] },
    { timeoutMs: 30_000, operationId: randomUUID() },
  );
  return Array.isArray(result?.tags) ? result.tags : [];
}

export function shortPurpose(purpose, limit = 40) {
  const value = String(purpose ?? "").trim().replace(/\s+/g, " ");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
