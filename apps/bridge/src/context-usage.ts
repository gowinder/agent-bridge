import type {
  ContextDetail,
  ContextUsage,
  MessageRecord,
  SessionTokens,
  TokenUsage,
} from "@craftstead/protocol";

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function isMillionTokenModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("[1m]") || name.includes("-1m") || name.includes("1m-context");
}

/** 用一次 assistant 调用的 usage 描述当前上下文占用；没有可用数字时返回 undefined。 */
export function contextUsageFromUsage(usage: unknown, model: string): ContextUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const input = asCount(record["input_tokens"]);
  const cacheRead = asCount(record["cache_read_input_tokens"]);
  const cacheWrite = asCount(record["cache_creation_input_tokens"]);
  const output = asCount(record["output_tokens"]);
  const used = input + cacheRead + cacheWrite;
  if (used <= 0) return undefined;
  const known = /claude|opus|sonnet|haiku/i.test(model);
  return {
    usedTokens: used,
    windowTokens: isMillionTokenModel(model) ? 1_000_000 : 200_000,
    ...(model ? { model } : {}),
    ...(known ? {} : { windowEstimated: true }),
    details: [
      { label: "输入", value: input.toLocaleString("en-US") },
      { label: "缓存读", value: cacheRead.toLocaleString("en-US") },
      { label: "缓存写", value: cacheWrite.toLocaleString("en-US") },
      { label: "输出", value: output.toLocaleString("en-US") },
    ],
  };
}

function sanitizeDetails(value: unknown): ContextDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details: ContextDetail[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row["label"] !== "string" || typeof row["value"] !== "string") continue;
    details.push({ label: row["label"], value: row["value"] });
  }
  return details.length > 0 ? details : undefined;
}

/** 注册表读回来的用量只接受自洽的数字，坏记录丢字段而不是丢整个会话。 */
export function sanitizeContextUsage(value: unknown): ContextUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const usedTokens = asCount(raw["usedTokens"]);
  const windowTokens = asCount(raw["windowTokens"]);
  if (usedTokens <= 0 || windowTokens <= 0) return undefined;
  const model = typeof raw["model"] === "string" ? raw["model"] : "";
  const details = sanitizeDetails(raw["details"]);
  return {
    usedTokens,
    windowTokens,
    ...(model ? { model } : {}),
    ...(raw["windowEstimated"] === true ? { windowEstimated: true } : {}),
    ...(details ? { details } : {}),
  };
}

function hasTokens(usage: TokenUsage): boolean {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0;
}

/** Claude Code 的 usage 是 snake_case，字段名和 pi 不同。 */
export function tokenUsageFromClaude(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const parsed: TokenUsage = {
    input: asCount(record["input_tokens"]),
    cacheRead: asCount(record["cache_read_input_tokens"]),
    cacheWrite: asCount(record["cache_creation_input_tokens"]),
    output: asCount(record["output_tokens"]),
  };
  return hasTokens(parsed) ? parsed : undefined;
}

/** pi 的 usage（input / cacheRead / cacheWrite / output）；会话级那条带 turns，不当作单次用量。 */
export function tokenUsageFromPi(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  if (record["turns"] !== undefined) return undefined;
  const parsed: TokenUsage = {
    input: asCount(record["input"]),
    cacheRead: asCount(record["cacheRead"]),
    cacheWrite: asCount(record["cacheWrite"]),
    output: asCount(record["output"]),
  };
  return hasTokens(parsed) ? parsed : undefined;
}

function emptyUsage(): TokenUsage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/**
 * 整个会话的累计用量：按用户消息切回合，助手消息的 usage 累加到所在回合。
 * 一条用户消息都没有（比如只加载了后半段）时，把开头的助手消息单独算一个回合。
 */
export function sessionTokensOf(messages: MessageRecord[]): SessionTokens | undefined {
  const total = emptyUsage();
  const turns: { messageId: string; usage: TokenUsage }[] = [];
  let current: { messageId: string; usage: TokenUsage } | undefined;
  let counted = false;
  for (const message of messages) {
    if (message.role === "user") {
      current = { messageId: message.messageId, usage: emptyUsage() };
      turns.push(current);
      continue;
    }
    const usage = message.usage;
    if (!usage) continue;
    if (!current) {
      current = { messageId: message.messageId, usage: emptyUsage() };
      turns.push(current);
    }
    current.usage.input += usage.input;
    current.usage.cacheRead += usage.cacheRead;
    current.usage.cacheWrite += usage.cacheWrite;
    current.usage.output += usage.output;
    total.input += usage.input;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.output += usage.output;
    counted = true;
  }
  if (!counted) return undefined;
  return { ...total, turns: turns.filter((turn) => hasTokens(turn.usage)) };
}
