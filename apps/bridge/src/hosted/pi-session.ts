import type { ContextUsage, MessageBlock, ModelOption } from "@craftstead/protocol";

const MAX_BLOCK_CHARS = 4_000;
const MAX_TOOL_CHARS = 300;
/** 换模型等回执的上限：进程刚好退出时不能把网页一直挂着。 */
const MODEL_SWITCH_TIMEOUT_MS = 15_000;

/** pi 的扩展 UI 请求里需要网页作答的那几种。 */
export type PiDialogMethod = "select" | "confirm" | "input" | "editor";

export interface PiPending {
  id: string;
  method: PiDialogMethod;
  title: string;
  message: string;
  options: string[];
}

export interface PiHandlers {
  /** 一条助手消息（文本 + 工具调用）。 */
  assistant(blocks: MessageBlock[]): void;
  system(text: string): void;
  context(usage: ContextUsage): void;
  /** 扩展要用户选/确认/输入；null 表示已经答完。 */
  pending(pending: PiPending | null): void;
  busy(busy: boolean): void;
  /** agent_settled：这一轮彻底结束，不会再自动继续。 */
  settled(aborted: boolean): void;
  title(name: string): void;
  commands(names: string[]): void;
  models(models: ModelOption[]): void;
  model(id: string): void;
  log(line: string): void;
}

/**
 * pi 的 `--mode rpc` 协议：stdin 一行一条命令，stdout 一行一条响应或会话事件。
 * 这里只管协议本身，进程与记录由 HostedSessionManager 持有。
 */
export class PiSession {
  private buffer = "";
  private counter = 0;
  private readonly waiting = new Map<string, (record: Record<string, unknown>) => void>();
  private pending: PiPending | null = null;
  /** 模型清单里带的窗口大小：`provider/modelId` → tokens。 */
  private readonly contextWindows = new Map<string, number>();

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly handlers: PiHandlers,
  ) {}

  /** 进程起来后拉一遍状态：斜杠命令、模型清单、当前模型。 */
  prime(): void {
    this.command("get_commands", (record) => {
      const names = namesFromCommands(record);
      if (names.length > 0) this.handlers.commands(names);
    });
    this.command("get_available_models", (record) => {
      this.rememberWindows(record);
      const models = modelsFrom(record);
      if (models.length > 0) this.handlers.models(models);
    });
    this.command("get_state", (record) => {
      const data = isRecord(record["data"]) ? record["data"] : {};
      const model = modelIdOf(data["model"]);
      if (model) this.handlers.model(model);
    });
  }

  /** pi 的模型清单里带 contextWindow，留着算上下文百分比；pi 的自动压缩也按这个窗口算。 */
  private rememberWindows(record: Record<string, unknown>): void {
    const data = isRecord(record["data"]) ? record["data"] : {};
    const list = Array.isArray(data["models"]) ? data["models"] : [];
    for (const item of list) {
      const id = modelIdOf(item);
      const window = isRecord(item) && typeof item["contextWindow"] === "number" ? item["contextWindow"] : 0;
      if (id && window > 0) this.contextWindows.set(id, window);
    }
  }

  /** 助手消息里的 model 是裸 id，模型清单里是 `provider/modelId`，对一下。 */
  private windowOf(model: string): number | undefined {
    if (!model) return undefined;
    const exact = this.contextWindows.get(model);
    if (exact) return exact;
    for (const [id, window] of this.contextWindows) {
      if (id.endsWith(`/${model}`)) return window;
    }
    return undefined;
  }

  /** 发一轮用户消息。已经在跑的时候按 steer 排队，交给当前这一轮之后执行。 */
  prompt(text: string, busy: boolean): void {
    this.command(
      "prompt",
      (record) => {
        if (record["success"] !== true) {
          const reason = typeof record["error"] === "string" ? record["error"] : "未知原因";
          this.handlers.system(`pi 拒绝了这条消息：${reason}`);
          this.handlers.busy(false);
          return;
        }
        const disposition = dispositionOf(record);
        // handled：扩展命令自己消化了，不会跑模型，也不会有 agent_settled。
        if (disposition === "handled") {
          this.handlers.busy(false);
          this.handlers.settled(false);
        }
      },
      busy ? { message: text, streamingBehavior: "steer" } : { message: text },
    );
  }

  abort(): void {
    this.command("abort", () => undefined);
  }

  /**
   * 换模型：pi 的 RPC 原生支持 set_model，进程不用停，跑着的回合结束后就按新模型继续。
   * 模型名按 `provider/modelId` 拆回两个字段；没带 provider 的只发 modelId。
   */
  setModel(model: string): Promise<{ model?: string; error?: string }> {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const modelId = slash > 0 ? model.slice(slash + 1) : model;
    return new Promise((resolve) => {
      let settled = false;
      // 进程刚好退出时不会再有回执，别让网页一直等。
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ error: "pi 没有回执" });
      }, MODEL_SWITCH_TIMEOUT_MS);
      timer.unref();
      this.command(
        "set_model",
        (record) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (record["success"] !== true) {
            const reason = typeof record["error"] === "string" ? record["error"] : "未知原因";
            resolve({ error: reason });
            return;
          }
          resolve({ model: modelIdOf(record["data"]) || model });
        },
        provider ? { provider, modelId } : { modelId },
      );
    });
  }

  /** 回答一条扩展提问；confirm 用 confirmed，其余用 value。 */
  answer(pending: PiPending, text: string): void {
    const payload: Record<string, unknown> = { type: "extension_ui_response", id: pending.id };
    if (pending.method === "confirm") payload["confirmed"] = yesNo(text);
    else payload["value"] = matchOption(text, pending.options);
    this.pending = null;
    this.handlers.pending(null);
    this.writeLine(JSON.stringify(payload));
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.handlers.pending(null);
    this.writeLine(JSON.stringify({ type: "extension_ui_response", id: pending.id, cancelled: true }));
  }

  get waitingFor(): PiPending | null {
    return this.pending;
  }

  /** stdout 片段进这里：按 LF 切，不能把 U+2028/U+2029 当边界。 */
  feed(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      if (!line) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.handlers.log(`pi: 无法解析的一行输出：${line.slice(0, 200)}`);
        continue;
      }
      if (isRecord(record)) this.handle(record);
    }
  }

  private handle(record: Record<string, unknown>): void {
    const type = record["type"];
    if (type === "response") {
      const id = typeof record["id"] === "string" ? record["id"] : "";
      const callback = id ? this.waiting.get(id) : undefined;
      if (!callback) return;
      this.waiting.delete(id);
      callback(record);
      return;
    }
    if (type === "extension_ui_request") {
      this.handleUi(record);
      return;
    }
    if (type === "message_end") {
      const message = isRecord(record["message"]) ? record["message"] : null;
      if (!message || message["role"] !== "assistant") return;
      const model = modelOf(message);
      const usage = contextOf(message["usage"], model, this.windowOf(model));
      if (usage) this.handlers.context(usage);
      const blocks = blocksOf(message["content"]);
      const stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : "";
      if (blocks.length === 0) {
        if (stopReason === "error") {
          const detail = typeof message["errorMessage"] === "string" ? message["errorMessage"] : "未知错误";
          this.handlers.system(`pi 这一轮出错：${detail}`);
        }
        return;
      }
      this.handlers.assistant(blocks);
      return;
    }
    if (type === "agent_start") {
      this.handlers.busy(true);
      return;
    }
    if (type === "agent_settled") {
      this.handlers.busy(false);
      this.handlers.settled(record["aborted"] === true);
      return;
    }
    if (type === "session_info_changed") {
      const name = typeof record["name"] === "string" ? record["name"].trim() : "";
      if (name) this.handlers.title(name);
      return;
    }
    if (type === "compaction_start") {
      this.handlers.system("pi 正在压缩上下文…");
      return;
    }
    if (type === "compaction_end") {
      if (record["errorMessage"] !== undefined) {
        const detail = typeof record["errorMessage"] === "string" ? record["errorMessage"] : "未知错误";
        this.handlers.system(`压缩上下文失败：${detail}`);
      }
      return;
    }
  }

  private handleUi(record: Record<string, unknown>): void {
    const method = typeof record["method"] === "string" ? record["method"] : "";
    const id = typeof record["id"] === "string" ? record["id"] : "";
    if (!id) return;
    if (method === "notify") {
      const text = typeof record["message"] === "string" ? record["message"].trim() : "";
      if (text) this.handlers.system(text.slice(0, MAX_BLOCK_CHARS));
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
    const title = typeof record["title"] === "string" ? record["title"] : "";
    const message = typeof record["message"] === "string" ? record["message"] : "";
    const options = Array.isArray(record["options"])
      ? record["options"].filter((item): item is string => typeof item === "string")
      : [];
    this.pending = {
      id,
      method,
      title: title || message || "pi 需要你回答",
      message,
      options,
    };
    this.handlers.pending(this.pending);
  }

  private command(
    type: string,
    callback: (record: Record<string, unknown>) => void,
    extra: Record<string, unknown> = {},
  ): void {
    this.counter += 1;
    const id = `bridge-${this.counter}`;
    this.waiting.set(id, callback);
    this.writeLine(JSON.stringify({ id, type, ...extra }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namesFromCommands(record: Record<string, unknown>): string[] {
  const data = isRecord(record["data"]) ? record["data"] : {};
  const commands = Array.isArray(data["commands"]) ? data["commands"] : [];
  const names: string[] = [];
  for (const item of commands) {
    if (!isRecord(item) || typeof item["name"] !== "string" || !item["name"]) continue;
    names.push(item["name"]);
  }
  return names.slice(0, 200);
}

function modelsFrom(record: Record<string, unknown>): ModelOption[] {
  const data = isRecord(record["data"]) ? record["data"] : {};
  const list = Array.isArray(data["models"]) ? data["models"] : [];
  const models: ModelOption[] = [];
  for (const item of list) {
    const id = modelIdOf(item);
    if (!id) continue;
    const name = isRecord(item) && typeof item["name"] === "string" && item["name"] ? item["name"] : id;
    models.push({ id, name });
  }
  return models;
}

/** pi 的模型对象：{ provider, modelId, name }；拼成 `provider/modelId` 存进会话记录。 */
function modelIdOf(value: unknown): string {
  // 助手消息里的 model 是字符串，协议响应里才是对象。
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const modelId = typeof value["modelId"] === "string" ? value["modelId"] : typeof value["id"] === "string" ? value["id"] : "";
  if (!modelId) return "";
  const provider = typeof value["provider"] === "string" ? value["provider"] : "";
  return provider ? `${provider}/${modelId}` : modelId;
}

/** 助手消息把 model 和 provider 分开给，拼回 `provider/modelId`。 */
function modelOf(message: Record<string, unknown>): string {
  const model = modelIdOf(message["model"]);
  const provider = typeof message["provider"] === "string" ? message["provider"] : "";
  if (!model) return "";
  return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

function dispositionOf(record: Record<string, unknown>): string {
  const data = isRecord(record["data"]) ? record["data"] : {};
  return typeof data["disposition"] === "string" ? data["disposition"] : "";
}

function contextOf(usage: unknown, model: string, windowTokens?: number): ContextUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const count = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  };
  const input = count("input");
  const cacheRead = count("cacheRead");
  const cacheWrite = count("cacheWrite");
  const output = count("output");
  const used = input + cacheRead + cacheWrite;
  if (used <= 0) return undefined;
  return {
    usedTokens: used,
    // 窗口来自 pi 的模型清单；拿不到就按 200k 估，侧栏会标成估算值。
    windowTokens: windowTokens ?? 200_000,
    ...(windowTokens ? {} : { windowEstimated: true }),
    ...(model ? { model } : {}),
    details: [
      { label: "输入", value: input.toLocaleString("en-US") },
      { label: "缓存读", value: cacheRead.toLocaleString("en-US") },
      { label: "缓存写", value: cacheWrite.toLocaleString("en-US") },
      { label: "输出", value: output.toLocaleString("en-US") },
    ],
  };
}

function blocksOf(content: unknown): MessageBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text: cut(text, MAX_BLOCK_CHARS) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part["type"] === "text" && typeof part["text"] === "string" && part["text"].trim()) {
      const text = part["text"].trim();
      blocks.push({ type: "text", text: cut(text, MAX_BLOCK_CHARS), ...(text.length > MAX_BLOCK_CHARS ? { truncated: true } : {}) });
      continue;
    }
    if (part["type"] === "toolCall" && typeof part["name"] === "string") {
      const args = typeof part["arguments"] === "string" ? part["arguments"] : safeJson(part["arguments"]);
      blocks.push({ type: "tool", text: cut(`调用 ${part["name"]} ${args}`.trim(), MAX_TOOL_CHARS) });
    }
  }
  return blocks;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function yesNo(text: string): boolean {
  return !/^(否|不是|取消|不|no|n|false|cancel)$/i.test(text.trim());
}

/** 网页发来的是选项文案或自由文本：能对上选项就按选项回，否则原样回。 */
function matchOption(text: string, options: string[]): string {
  const trimmed = text.trim();
  const exact = options.find((option) => option === trimmed);
  if (exact) return exact;
  const folded = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  return folded ?? trimmed;
}
