/**
 * 工具自带的「一句话说明」。
 *
 * Claude Code 的 Bash 会在参数里带 `description`（"Checked status item registration"），
 * 桌面版折叠态显示的就是它；Codex 用 `justification`。有就直接拿来当这一步的标题，
 * 比把命令摊开或多写一个「运行」标签都更贴近用户在做什么。
 */
const SUMMARY_KEYS = ["description", "justification", "title", "summary"] as const;
const MAX_SUMMARY_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (isRecord(input)) return input;
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 参数是对象或 JSON 字符串都行；没有说明就返回 undefined。 */
export function toolSummaryOf(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
  }
  return undefined;
}
