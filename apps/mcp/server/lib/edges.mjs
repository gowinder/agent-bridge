/**
 * 完成边沿检测（纯函数，无 IO、无时间依赖）。
 *
 * listener 每个轮询周期给每个 active watch 喂一份「会话快照」：
 *   { busy, needsDecision, messageCount, lastMessageId }   会话在 session.list 里
 *   null                                                    会话不在列表里（消失）
 * 返回 { watch: 更新后的 watch, events: [{type, messageCount}] }。
 *
 * 规则（spec v2 §3）：
 *   - needs-user：needsDecision false→true；回落到 false 才重新武装（同一段提问只报一次）。
 *   - completed：busy true→false 且消息数增长（> watermarkMessageCount）；
 *     busy 从没观察到 true（快任务）时，第一次看到 busy=false 且已增长也算 completed。
 *     为了超长会话（message.list 分页总量有上限）不丢增长，watermarkLastMessageId
 *     发生变化也算增长。
 *   - gone：连续 GONE_ABSENCE_POLLS 次不在 session.list 里。
 *   - completed/gone 把 watch 置 status:"done"（永不重复触发）；needs-user 不关 watch。
 *
 * watch 的 lastBusy / lastNeedsDecision / missingPolls / watermarkLastMessageId 是
 * listener 独占的边沿状态；watch.mjs 只碰注册字段。
 */

export const GONE_ABSENCE_POLLS = 3;

export const EVENT_TYPES = Object.freeze({ completed: "completed", needsUser: "needs-user", gone: "gone" });

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function stepWatch(watch, snapshot, { goneAfter = GONE_ABSENCE_POLLS } = {}) {
  const next = { ...watch };
  const events = [];
  if (watch.status !== "active") return { watch: next, events };

  // --- gone：会话从 session.list 里消失（可能被归档后又删掉、或 bridge 重启）
  if (snapshot === null || snapshot === undefined) {
    const missing = (isPositiveInt(watch.missingPolls) ? watch.missingPolls : 0) + 1;
    next.missingPolls = missing;
    if (missing >= goneAfter) {
      events.push({ type: EVENT_TYPES.gone, messageCount: null });
      next.status = "done";
    }
    return { watch: next, events };
  }
  next.missingPolls = 0;

  const busy = snapshot.busy === true;
  const needsDecision = snapshot.needsDecision === true;
  const messageCount = isPositiveInt(snapshot.messageCount) ? snapshot.messageCount : null;
  const lastMessageId = typeof snapshot.lastMessageId === "string" ? snapshot.lastMessageId : null;
  const lastBusy = watch.lastBusy === undefined ? null : watch.lastBusy;
  const lastNeedsDecision = watch.lastNeedsDecision === true;

  // --- needs-user：false→true 触发，回落 false 后重新武装
  if (needsDecision && !lastNeedsDecision) {
    events.push({ type: EVENT_TYPES.needsUser, messageCount });
    next.lastNeedsDecision = true;
  } else if (!needsDecision) {
    next.lastNeedsDecision = false;
  }

  // --- completed：只在「空闲 + 有增长」时成立
  const watermarkCount = isPositiveInt(watch.watermarkMessageCount) ? watch.watermarkMessageCount : null;
  const watermarkLastId = typeof watch.watermarkLastMessageId === "string" ? watch.watermarkLastMessageId : null;
  const grewByCount = watermarkCount !== null && messageCount !== null && messageCount > watermarkCount;
  const grewById = watermarkLastId !== null && lastMessageId !== null && lastMessageId !== watermarkLastId;
  // 只要「当前空闲 + 有增长」就算完成：busy 从没变过 true（快任务，两次轮询之间就跑完）
  // 也必须能报，否则快任务会永远沉默。仍然 busy=true 时绝不报。
  if (!busy && (grewByCount || grewById)) {
    events.push({ type: EVENT_TYPES.completed, messageCount });
    next.status = "done";
  }
  next.lastBusy = busy;
  return { watch: next, events };
}

/**
 * 一轮多 watch：纯函数入口，selftest 用脚本化快照序列驱动。
 * watchList: watch[]；snapshots: Map<watchId, snapshot|null>（缺省视为 null）。
 */
export function stepAll(watchList, snapshots, options) {
  const watches = [];
  const events = [];
  for (const watch of watchList) {
    const snapshot = snapshots instanceof Map ? (snapshots.has(watch.id) ? snapshots.get(watch.id) : null) : (snapshots?.[watch.id] ?? null);
    const result = stepWatch(watch, snapshot, options);
    watches.push(result.watch);
    for (const event of result.events) events.push({ ...event, watchId: watch.id });
  }
  return { watches, events };
}
