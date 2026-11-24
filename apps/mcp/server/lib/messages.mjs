/**
 * 消息形态与「pi 在提问」识别（DESIGN §5 模式 B 修正版）。
 *
 * 事实依据：托管 pi 的提问以普通会话消息出现（Bridge 未实现 approval.respond），
 * 所以这里只做两件事：把消息正文原样摊平、在当前回合结束后标出「最后一条像提问的消息」。
 * 逐字原则在工具层 = 返回全文，不摘要、不截断（超长靠条数分页）。
 */

/** 一条消息里所有可见文本，按 block 顺序拼接（不做任何摘要/截断）。 */
export function messageText(record) {
  if (!record || !Array.isArray(record.blocks)) return "";
  return record.blocks
    .filter((block) => block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** 工具输出里的一条消息：正文全文 + 原始块（工具块只给 summary，正文已经全在）。 */
export function messageView(record) {
  return {
    messageId: record.messageId,
    role: record.role,
    createdAt: record.createdAt,
    origin: record.origin ?? "local",
    text: messageText(record),
    textSource: "message.blocks",
    blocks: Array.isArray(record.blocks)
      ? record.blocks.map((block) => ({
          type: block.type,
          text: block.text,
          ...(block.summary ? { summary: block.summary } : {}),
          ...(block.questions ? { questions: block.questions } : {}),
          ...(block.actions ? { actions: block.actions } : {}),
          ...(block.pending === true ? { pending: true } : {}),
          ...(block.truncated === true ? { truncated: true } : {}),
        }))
      : [],
  };
}

/**
 * message.list 为了帧大小把长文本按块截到 4000 字（`blocks[].truncated`）。
 * 这类消息的正文不全，必须再用 message.text 取一次原文，才符合「返回全文、不截断」。
 */
export function hasTruncatedBlock(record) {
  return Array.isArray(record?.blocks) && record.blocks.some((block) => block?.truncated === true);
}

/** 用 message.text 的全文覆盖列表里的截断文本（只补齐，不改写内容）。 */
export function withFullText(view, full) {
  return {
    ...view,
    text: full.text,
    textSource: "message.text",
    fullTextLength: typeof full.length === "number" ? full.length : full.text.length,
    // message.text 自身也有上限（bridge 侧 200000 字）；为 true 时说明再长也没法在一次响应里取全。
    ...(full.truncated === true ? { bridgeFullTextTruncated: true } : {}),
  };
}

/** bridge 返回的 messages 顺序不一定从旧到新：统一按 createdAt 排，同一时间保持原序。 */
export function sortMessages(messages) {
  return [...messages].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /？\s*$/,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshall i\b/i,
  /\bplease (?:confirm|choose|select|let me know)\b/i,
  /\bwaiting for (?:your|user) (?:confirmation|input|response)\b/i,
  /(?:是否|要不要|需要我|要我|确认一下|请确认|请选择|请问|继续吗|可以吗|行吗)/,
];

/** 一条消息是否「像在提问 / 等确认」。保守启发式：宁可漏标，也不要把陈述句误标成提问。 */
export function looksLikeQuestion(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  const tail = value.slice(-400);
  return QUESTION_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * 回合结束后，找「pi 最后一条像提问的消息」。
 * 依据顺序：bridge 的 needsDecision 旗标 > 结构化 ask/next-step 块 > 文本启发式。
 *
 * 回合还在跑（busy=true）时只信结构化信号：这时最后一条文本可能只是半截输出，
 * 用问号启发式会误报。会话转头问用户时 bridge 的 needsDecision 会亮，所以照样能标出来。
 *
 * @returns {{messageId:string,text:string,reason:string,askedAt:number}|null}
 */
export function detectNeedsUser(messages, summary, { allowTextHeuristic = true } = {}) {
  const ordered = sortMessages(messages);
  const last = ordered.at(-1);
  if (!last) return null;
  const text = messageText(last);
  const structured = (last.blocks ?? []).find(
    (block) => block && (block.type === "ask" || (block.type === "next-step" && block.pending === true)),
  );

  if (summary?.needsDecision === true) {
    return { messageId: last.messageId, text, reason: "bridge_needs_decision", askedAt: last.createdAt };
  }
  if (structured) {
    return { messageId: last.messageId, text, reason: "structured_ask", askedAt: last.createdAt };
  }
  if (allowTextHeuristic && last.role === "assistant" && looksLikeQuestion(text)) {
    return { messageId: last.messageId, text, reason: "question_text", askedAt: last.createdAt };
  }
  return null;
}
