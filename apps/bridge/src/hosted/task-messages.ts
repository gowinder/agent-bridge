// 托管会话的「后台任务」记录：pi 的子代理 run 和 Claude Code 的子代理转录是两种格式，
// 这里都转成网页里同一套 MessageRecord。桌面会话走各自的适配器，不经过这里。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MessageBlock, MessageRecord } from "@craftstead/protocol";
import { subagentDirsFor } from "../subagents.js";
import { piRunDir } from "./pi-subagents.js";

/** events.jsonl 可能很大（工具输出全在里面），超过这个就不读，免得一次塞进内存。 */
const MAX_RUN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BLOCK_CHARS = 4_000;
/** 工具调用只留一行摘要，完整参数对看过程没多大用。 */
const MAX_TOOL_CHARS = 300;

/** pi 后台 run 的记录；run 不存在或不属于这个会话时返回 null。 */
export function piTaskMessages(piSessionId: string, taskId: string): MessageRecord[] | null {
  const dir = piRunDir(piSessionId, taskId);
  if (!dir) return null;
  const path = join(dir, "events.jsonl");
  let text: string;
  try {
    if (statSync(path).size > MAX_RUN_FILE_BYTES) return [];
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const sessionId = `hosted:${piSessionId}`;
  const messages: MessageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // 最后一行可能正写到一半。
      continue;
    }
    if (!isObject(entry) || entry["type"] !== "message_end") continue;
    const message = entry["message"];
    if (!isObject(message)) continue;
    const role = message["role"];
    const blocks = blocksOf(message["content"]);
    if (blocks.length === 0) continue;
    // system 是子代理的启动提示词，几千字且对看过程没有帮助。
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const createdAt =
      typeof message["timestamp"] === "number"
        ? message["timestamp"]
        : typeof entry["observedAt"] === "number"
          ? entry["observedAt"]
          : 0;
    messages.push({
      messageId: `${sessionId}#${taskId}:${messages.length}`,
      sessionId,
      role: role === "user" ? "user" : "assistant",
      createdAt,
      blocks,
      origin: "local",
    });
  }
  return messages;
}

/** Claude Code 子代理转录（`<taskId>.jsonl`）的记录；找不到文件时返回 null。 */
export function claudeTaskMessages(
  sessionId: string,
  taskId: string,
  root?: string,
): MessageRecord[] | null {
  if (!/^agent-[A-Za-z0-9]+$/.test(taskId)) return null;
  const file = subagentDirsFor([sessionId], root)
    .map((dir) => join(dir, `${taskId}.jsonl`))
    .find((path) => existsSync(path));
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const messages: MessageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    const type = entry["type"];
    if (type !== "user" && type !== "assistant") continue;
    const inner = isObject(entry["message"]) ? entry["message"] : null;
    const blocks = blocksOf(inner?.["content"], true);
    if (blocks.length === 0) continue;
    const timestamp = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : 0;
    messages.push({
      messageId: `${sessionId}#${taskId}:${messages.length}`,
      sessionId,
      role: type,
      createdAt: Number.isFinite(timestamp) ? timestamp : 0,
      blocks,
      origin: "local",
    });
  }
  return messages;
}

/** pi 用 toolCall/toolResult，Claude Code 用 tool_use/tool_result：两套都认。 */
function blocksOf(content: unknown, claude = false): MessageBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", ...truncate(text, MAX_BLOCK_CHARS) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (const raw of content) {
    if (!isObject(raw)) continue;
    const kind = raw["type"];
    if (kind === "text" && typeof raw["text"] === "string") {
      const text = raw["text"].trim();
      if (text) blocks.push({ type: "text", ...truncate(text, MAX_BLOCK_CHARS) });
    } else if (kind === (claude ? "tool_use" : "toolCall")) {
      const name = typeof raw["name"] === "string" ? raw["name"] : "tool";
      const input = claude ? raw["input"] : raw["arguments"];
      const args = input === undefined ? "" : JSON.stringify(input);
      blocks.push({ type: "tool", ...truncate(`调用 ${name} ${args}`.trim(), MAX_TOOL_CHARS) });
    } else if (kind === (claude ? "tool_result" : "toolResult")) {
      const text = resultText(raw["content"]);
      if (text) blocks.push({ type: "tool", ...truncate(text, MAX_BLOCK_CHARS) });
    }
  }
  return blocks;
}

/** pi 的 toolResult 内容在 content 里，Claude Code 的在块自己的 content 里。 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") parts.push(raw);
    else if (isObject(raw) && typeof raw["text"] === "string") parts.push(raw["text"]);
  }
  return parts.join("\n").trim();
}

function truncate(text: string, max: number): { text: string; truncated?: true } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
