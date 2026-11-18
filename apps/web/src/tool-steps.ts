import type { MessageBlock } from "@craftstead/protocol";

/**
 * 工具调用在适配器里被压成一行 `调用 <name> <args JSON>`。直接把这一行摊开
 * 又长又难读（截图里满屏 `{"command":"cd …`），这里拆成「动作标签 + 一句话目标」，
 * 具体命令留给展开后的 body。
 */
export const TOOL_ACTIONS: Array<{ match: RegExp; label: string; keys: string[] }> = [
  { match: /^(bash|shell|run_command|exec_command|local_shell|terminal|zsh|sh)$/i, label: "运行", keys: ["command", "cmd", "script"] },
  { match: /^(read|read_file|readfile|view|open|cat)$/i, label: "读取", keys: ["file_path", "path", "file", "target_file"] },
  { match: /^(write|write_file|create_file|new_file)$/i, label: "写入", keys: ["file_path", "path", "file"] },
  { match: /^(edit|edit_file|str_replace|str_replace_editor|apply_patch|patch|update_file|multi_edit|multiedit)$/i, label: "编辑", keys: ["file_path", "path", "file"] },
  { match: /^(grep|search|codebase_search|rg|find_in_files|search_files)$/i, label: "搜索", keys: ["pattern", "query", "regex", "search_term"] },
  { match: /^(glob|list_dir|ls|list_files|find|file_search)$/i, label: "查找文件", keys: ["pattern", "glob", "path", "query"] },
  { match: /^(webfetch|web_fetch|fetch|browse|http|curl)$/i, label: "抓取网页", keys: ["url", "prompt"] },
  { match: /^(task|agent|subagent|dispatch|delegate)$/i, label: "子代理", keys: ["description", "prompt", "task"] },
  { match: /^(todowrite|todo_write|todo|update_plan|plan)$/i, label: "更新计划", keys: ["plan", "items", "todos"] },
  { match: /^(think|thinking)$/i, label: "思考", keys: ["thought", "text"] },
  { match: /^(websearch|web_search)$/i, label: "网络搜索", keys: ["query"] },
  { match: /^(toolsearch|tool_search)$/i, label: "查找工具", keys: ["query"] },
  { match: /^(askuserquestion|ask_user_question|ask)$/i, label: "提问", keys: ["question"] },
  { match: /^(skill)$/i, label: "技能", keys: ["name", "skill"] },
  { match: /^(taskstop|task_stop|kill_task)$/i, label: "停止任务", keys: ["task_id", "id"] },
  { match: /^(notebookedit|notebook_edit)$/i, label: "编辑", keys: ["notebook_path", "path"] },
];

/** MCP 工具名是 `mcp__server__do_thing`：认不出来就退到动作名，把下划线拆成空格。 */
export function toolAction(name: string): { label: string; keys: string[] } {
  const known = TOOL_ACTIONS.find((item) => item.match.test(name));
  if (known) return { label: known.label, keys: known.keys };
  const tail = name.split("__").pop() ?? name;
  return { label: tail.replace(/[_-]+/g, " ").trim() || name, keys: [] };
}

/**
 * 从参数 JSON 里取一个字符串值。列表里的工具调用常被截到 300 字（`{"command":"cd /Use…`），
 * 整段 json.parse 不了，所以按 key 抓引号内容，顺手把常见转义还原。
 */
export function unescapeJsonString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export function toolArg(raw: string, key: string): string | null {
  const closed = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
  if (closed) return unescapeJsonString(closed[1] ?? "");
  // 被截断时值没有收尾的引号：取到末尾，总比「没有目标」强。
  const open = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`).exec(raw);
  return open ? unescapeJsonString(open[1] ?? "") : null;
}

/** 认不出的工具：取冒号后面的第一个字符串值（键名本身也在引号里，不能直接抓引号）。 */
function firstStringValue(raw: string): string | null {
  const match = /:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  return match ? unescapeJsonString(match[1] ?? "") : null;
}

/** 一句话目标：取第一行、压掉多余空白；长路径留尾部（前面的目录名重复度高）。 */
export function summarizeArg(value: string): string {
  const line = value.split("\n").map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  const flat = line.replace(/\s+/g, " ");
  const limit = 64;
  if (flat.length <= limit) return flat;
  // 路径留尾部（文件名比前缀有用），普通句子留开头。
  if (flat.includes("/") && !/\s/.test(flat)) return `…${flat.slice(-(limit - 1))}`;
  return `${flat.slice(0, limit - 1)}…`;
}

/** 展开后的内容：能解析就按 2 空格缩进铺开，被截断的只能原样给。 */
export function prettyToolArgs(raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export interface StepView {
  label: string;
  detail: string;
  body: string;
  /** detail 是工具自己的说明（不是推断出来的目标）：这时不再加动作标签。 */
  described?: boolean;
}

/**
 * `Bash pwd; ls` 这种没有「调用」前缀的写法，只认首字母大写的名字（Claude Code 的
 * 工具名都是 `Bash`/`Read`/`WebFetch` 这种）。小写开头的句子不当工具，免得把
 * `thinking through the problem` 认成「思考」。
 */
function looksLikeToolName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

/** `调用 bash {json}` 与 `Bash pwd; ls -la` 两种写法都要认，前者是适配器生成的，后者来自转录原文。 */
function splitToolCall(text: string): { name: string; args: string } | null {
  const prefixed = /^调用\s+(\S+)\s*([\s\S]*)$/.exec(text);
  if (prefixed) return { name: prefixed[1] ?? "", args: (prefixed[2] ?? "").trim() };
  const plain = /^([A-Za-z][\w.:-]*)\s+([\s\S]+)$/.exec(text);
  if (plain && looksLikeToolName(plain[1] ?? "")) {
    return { name: plain[1] ?? "", args: (plain[2] ?? "").trim() };
  }
  return null;
}

export function stepView(block: MessageBlock): StepView {
  const text = block.text;
  const call = splitToolCall(text);
  if (!call) {
    // 不是工具调用（适配器偶尔塞纯文本进来）：保持原样，第一行当标题。
    const line = (text.split("\n")[0] ?? "").trim();
    return { label: "", detail: line.length > 76 ? `${line.slice(0, 76)}…` : line, body: text };
  }
  const name = call.name;
  const argsRaw = call.args;
  const { label, keys } = toolAction(name);
  // 工具自己写了说明（Claude Code 的 Bash description）就用它，比「运行 + 命令」更像人话。
  const described = block.summary?.trim();
  if (described) {
    return { label, detail: described, body: prettyToolArgs(argsRaw), described: true };
  }
  let detail = "";
  if (argsRaw && !argsRaw.startsWith("{")) {
    // 纯文本参数（`Bash pwd; ls -la`、`Read /path/to/file`）：它本身就是目标。
    detail = summarizeArg(argsRaw);
  } else {
    for (const key of keys) {
      const value = toolArg(argsRaw, key);
      if (value && value.trim()) {
        detail = summarizeArg(value);
        break;
      }
    }
    if (!detail) {
      // 不认识的工具：退到「冒号后第一个字符串」，还是取不到就只显示标签。
      const value = firstStringValue(argsRaw);
      if (value) detail = summarizeArg(value);
    }
  }
  return { label, detail, body: prettyToolArgs(argsRaw) };
}
