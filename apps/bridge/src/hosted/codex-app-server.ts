import type { ContextUsage, MessageBlock } from "@craftstead/protocol";
import { toolSummaryOf } from "../tool-summary.js";
import { BRIDGE_VERSION } from "../version.js";

/** 一次性请求（握手、建/续线程、改名）的回执上限。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** turn/interrupt 的回执上限：停止流程不能在这里挂住。 */
const INTERRUPT_TIMEOUT_MS = 5_000;
const MAX_TOOL_CHARS = 300;
/** 接管线程时读历史的分页口径：每页回合数、最多翻几页（防止超长线程把启动卡住）。 */
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 4;

/** 从 codex 读回来的一条历史消息（messageId / sessionId 由 manager 补）。 */
export interface CodexHistoryMessage {
  role: "user" | "assistant";
  blocks: MessageBlock[];
  createdAt: number;
}

/** 会话能用的 sandbox 档位；v1 固定 workspace-write，和现有引擎的默认口径一致。 */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
/** 审批口径：on-request = 只在需要时问人（不用 never 把审批绕过去）。 */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
/**
 * 审批路由必须是 user：本机 config.toml 可能把它设成 auto_review，
 * 那样 on-request 的请求会被子代理自动审掉，网页根本收不到。
 */
export type CodexApprovalsReviewer = "user" | "auto_review";

export type CodexApprovalKind = "command" | "fileChange" | "permissions";

/** 一条等待用户批/拒的 server→client 请求。 */
export interface CodexApproval {
  /** 应答时要带回去的 JSON-RPC id（codex 用数字）。 */
  id: string | number;
  method: string;
  kind: CodexApprovalKind;
  /** 网页上方的提问文案。 */
  ask: string;
  /** 正文：命令、改动路径或权限摘要。 */
  text: string;
  /** codex 自己给的理由（reason / justification）。 */
  reason?: string;
  params: Record<string, unknown>;
}

export interface CodexHandlers {
  /** 一条完整的助手消息（文本或工具活动）。流式 delta 在这里才拼成一条。 */
  assistant(blocks: MessageBlock[]): void;
  system(text: string): void;
  context(usage: ContextUsage): void;
  /** 需要用户批/拒的请求；null 表示已经答完。 */
  approval(pending: CodexApproval | null): void;
  title(name: string): void;
  /** 会话绑定的 codex 线程 id（新建或接管后报回）。 */
  thread(threadId: string): void;
  /** 一轮结束：status 取 completed / interrupted / failed。 */
  turnDone(status: string, error?: string): void;
  log(line: string): void;
}

/**
 * codex 的 `app-server` 协议：stdio 上换行分隔的 JSON-RPC。
 *
 * 客户端方向（initialize / thread / turn）由我们发；审批是反方向（server→client 请求），
 * 必须应答，否则那一轮会一直等在那里。这里只管协议本身，进程与记录由
 * HostedSessionManager 持有。
 */
export class CodexAppServer {
  private buffer = "";
  private counter = 0;
  private readonly waiting = new Map<string, (record: Record<string, unknown>) => void>();
  /** 助手消息是按 itemId 分片的 delta，收尾时才拼成一条。 */
  private readonly deltas = new Map<string, string>();
  private pending: CodexApproval | null = null;
  private threadId = "";
  private turnId = "";

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly handlers: CodexHandlers,
  ) {}

  /** 握手：initialize 必填 params.clientInfo，之后补一条 initialized 通知。 */
  async initialize(): Promise<{ error?: string }> {
    const record = await this.call("initialize", {
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: BRIDGE_VERSION },
    });
    if (record["error"] !== undefined) return { error: reasonOf(record) };
    this.send({ method: "initialized", params: {} });
    return {};
  }

  /** 新建线程；`name` 要在 thread/start 之后用 thread/name/set 单独设。 */
  async startThread(input: {
    cwd: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    approvalsReviewer?: CodexApprovalsReviewer;
    developerInstructions?: string;
    model?: string;
  }): Promise<{ threadId?: string; cwd?: string; error?: string }> {
    return this.threadCall("thread/start", "thread/start", {
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
      ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
  }

  /**
   * 接管已有线程：桌面 app 建的线程也能从 Bridge 接着聊，历史留在 codex 自己的 transcript 里。
   * excludeTurns：历史由 Bridge 自己的转录呈现，别再拉一遍。
   */
  async resumeThread(input: {
    threadId: string;
    cwd: string;
    sandbox?: CodexSandbox;
    approvalPolicy?: CodexApprovalPolicy;
    approvalsReviewer?: CodexApprovalsReviewer;
    developerInstructions?: string;
    model?: string;
  }): Promise<{ threadId?: string; cwd?: string; error?: string }> {
    return this.threadCall("thread/resume", "thread/resume", {
      threadId: input.threadId,
      cwd: input.cwd,
      excludeTurns: true,
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
  }

  /**
   * 接管来的线程：把 codex 自己记的历史读回来，否则网页上只有接管之后的消息。
   * 走 `thread/turns/list`（asc 分页，itemsView=full），最多翻 MAX_HISTORY_PAGES 页。
   */
  async history(
    threadId: string,
    limit = HISTORY_PAGE_SIZE,
  ): Promise<CodexHistoryMessage[]> {
    const messages: CodexHistoryMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const record = await this.call("thread/turns/list", {
        threadId,
        limit,
        sortDirection: "asc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      if (record["error"] !== undefined) {
        this.handlers.log(`codex: 读历史失败：${reasonOf(record)}`);
        break;
      }
      const result = resultOf(record);
      const turns = Array.isArray(result["data"]) ? result["data"] : [];
      for (const turn of turns) messages.push(...historyOfTurn(turn));
      const next = typeof result["nextCursor"] === "string" ? result["nextCursor"] : "";
      if (!next || turns.length === 0) break;
      cursor = next;
    }
    return messages;
  }

  /** 发一轮用户消息。已经在跑的时候 codex 会拒绝，由调用方决定排队还是报错。 */
  async startTurn(text: string): Promise<{ turnId?: string; error?: string }> {
    if (!this.threadId) return { error: "线程还没建好" };
    const record = await this.call("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
    });
    if (record["error"] !== undefined) return { error: reasonOf(record) };
    const turn = isRecord(resultOf(record)["turn"]) ? (resultOf(record)["turn"] as Record<string, unknown>) : {};
    const turnId = typeof turn["id"] === "string" ? turn["id"] : "";
    if (turnId) this.turnId = turnId;
    return turnId ? { turnId } : {};
  }

  /** 只停当前回合（先中断，别让 turn 落成 interrupted 残回合再杀进程）。 */
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, INTERRUPT_TIMEOUT_MS);
    this.turnId = "";
  }

  /** 线程改名：桌面 app 的会话列表按这个名字显示。 */
  async setName(name: string): Promise<{ error?: string }> {
    const trimmed = name.trim();
    if (!this.threadId || !trimmed) return {};
    const record = await this.call("thread/name/set", { threadId: this.threadId, name: trimmed });
    return record["error"] === undefined ? {} : { error: reasonOf(record) };
  }

  /** 当前线程 id；进程是接管来的（Bridge 重启后 attach）时可能一开始就已知。 */
  get thread(): string {
    return this.threadId;
  }

  /** 接管打回来的线程时先把 id 记上：之后的 turn/start 直接用。 */
  adoptThread(threadId: string): void {
    this.threadId = threadId;
  }

  get waitingFor(): CodexApproval | null {
    return this.pending;
  }

  /** 批/拒一条审批请求。用户没答（停止、超时、断线）也走这里，按拒绝处理。 */
  respond(accept: boolean, message?: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.handlers.approval(null);
    this.send({ id: pending.id, result: approvalResult(pending, accept) });
    if (!accept && message) this.handlers.log(`codex: 拒绝 ${pending.method}：${message}`);
  }

  /** stdout 片段进这里：按 LF 切。 */
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
        this.handlers.log(`codex: 无法解析的一行输出：${line.slice(0, 200)}`);
        continue;
      }
      if (isRecord(record)) this.handle(record);
    }
  }

  private handle(record: Record<string, unknown>): void {
    const method = typeof record["method"] === "string" ? record["method"] : "";
    const id = record["id"];
    // 带 method 又带 id 的是反方向的请求：审批就走这条路，必须应答。
    if (method && (typeof id === "string" || typeof id === "number")) {
      this.handleServerRequest(method, id, isRecord(record["params"]) ? record["params"] : {});
      return;
    }
    if (method) {
      this.handleNotification(method, isRecord(record["params"]) ? record["params"] : {});
      return;
    }
    if (id === undefined || id === null) return;
    const key = String(id);
    const callback = this.waiting.get(key);
    if (!callback) return;
    this.waiting.delete(key);
    callback(record);
  }

  private handleServerRequest(method: string, id: string | number, params: Record<string, unknown>): void {
    const approval = approvalOf(method, id, params);
    if (approval) {
      // 上一轮还没答完又来一条：codex 按回合串行，出现这种说明状态错乱，先拒新的。
      if (this.pending) {
        this.send({ id, result: approvalResult(approval, false) });
        this.handlers.log(`codex: 同时出现两条审批请求，已拒掉 ${method}`);
        return;
      }
      this.pending = approval;
      this.handlers.approval(approval);
      return;
    }
    // 不支持的反方向请求（表单、动态工具、鉴权刷新等）：明确回错误，别让它等着。
    this.send({ id, error: { code: -32601, message: `agent-bridge 不支持 ${method}` } });
    this.handlers.log(`codex: 拒绝了不支持的反方向请求 ${method}`);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "thread/started") {
      const thread = isRecord(params["thread"]) ? params["thread"] : {};
      this.learnThread(thread);
      return;
    }
    if (method === "thread/name/updated") {
      // 线上字段叫 threadName（params.name 是别处抄错的版本），写错就永远学不到 codex 改的名字。
      const name = textOf(params["threadName"]).trim();
      if (name) this.handlers.title(name);
      return;
    }
    if (method === "turn/started") {
      const turn = isRecord(params["turn"]) ? params["turn"] : {};
      if (typeof turn["id"] === "string") this.turnId = turn["id"];
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = textOf(params["itemId"]);
      const delta = textOf(params["delta"]);
      if (!itemId) return;
      this.deltas.set(itemId, `${this.deltas.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (method === "item/started") {
      const item = isRecord(params["item"]) ? params["item"] : {};
      // 助手消息的正文要到 delta 里来；先把之前同 id 的残留清掉，别把两轮拼在一起。
      if (item["type"] === "agentMessage" && typeof item["id"] === "string") {
        this.deltas.set(item["id"], typeof item["text"] === "string" ? item["text"] : "");
      }
      return;
    }
    if (method === "item/completed") {
      const item = isRecord(params["item"]) ? params["item"] : {};
      this.itemCompleted(item);
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(params["turn"]) ? params["turn"] : {};
      const status = textOf(turn["status"]) || "completed";
      const error = isRecord(turn["error"]) ? textOf(turn["error"]["message"]) : "";
      this.turnId = "";
      this.deltas.clear();
      this.handlers.turnDone(status, error || undefined);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = isRecord(params["tokenUsage"]) ? params["tokenUsage"] : {};
      const context = contextOf(usage);
      if (context) this.handlers.context(context);
      return;
    }
    if (method === "thread/status/changed") {
      const status = isRecord(params["status"]) ? textOf(params["status"]["type"]) : "";
      if (status === "systemError") this.handlers.system("codex 线程进入错误状态");
      return;
    }
    if (method === "error") {
      const error = isRecord(params["error"]) ? params["error"] : {};
      const message = textOf(error["message"]) || "未知错误";
      const retry = params["willRetry"] === true;
      this.handlers.system(retry ? `codex 出错，正在重试：${message}` : `codex 出错：${message}`);
      return;
    }
    // 其余通知（reasoning、mcp 状态、账户更新等）v1 不呈现。
  }

  /** 一条 item 收尾：助手消息拼成一条文本，其余工具 item 按工具活动呈现。 */
  private itemCompleted(item: Record<string, unknown>): void {
    const type = textOf(item["type"]);
    const itemId = textOf(item["id"]);
    if (type === "agentMessage") {
      const streamed = itemId ? (this.deltas.get(itemId) ?? "") : "";
      if (itemId) this.deltas.delete(itemId);
      // item.text 是权威值（非流式时也有）；delta 只在 item.text 为空时兜底。
      const text = (textOf(item["text"]) || streamed).trim();
      if (text) this.handlers.assistant([{ type: "text", text }]);
      return;
    }
    const block = toolBlockOf(item);
    if (block) this.handlers.assistant([block]);
  }

  private learnThread(thread: Record<string, unknown>): void {
    const id = textOf(thread["id"]);
    if (id && id !== this.threadId) {
      this.threadId = id;
      this.handlers.thread(id);
    }
    const name = textOf(thread["name"]).trim();
    if (name) this.handlers.title(name);
  }

  /** thread/start 与 thread/resume 的回执形状一样：{ thread: {...} }。 */
  private async threadCall(
    method: string,
    label: string,
    params: Record<string, unknown>,
  ): Promise<{ threadId?: string; cwd?: string; error?: string }> {
    const record = await this.call(method, params);
    if (record["error"] !== undefined) return { error: reasonOf(record) };
    const result = resultOf(record);
    const thread = isRecord(result["thread"]) ? result["thread"] : {};
    const threadId = textOf(thread["id"]);
    if (!threadId) return { error: `${label} 没有报回线程 id` };
    this.threadId = threadId;
    this.handlers.thread(threadId);
    const name = textOf(thread["name"]).trim();
    if (name) this.handlers.title(name);
    const cwd = textOf(thread["cwd"]);
    return { threadId, ...(cwd ? { cwd } : {}) };
  }

  /** 一次性请求：等回执；进程刚好退出时按超时收尾，别让调用方一直挂着。 */
  private call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let settled = false;
      const id = this.request(method, params, (record) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(record);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 回执永远不会来了：把回调清掉，否则反复发命令会一直累积。
        this.waiting.delete(id);
        resolve({ id, error: { message: `${method} 没有回执` } });
      }, timeoutMs);
      timer.unref();
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    callback: (record: Record<string, unknown>) => void,
  ): string {
    this.counter += 1;
    const id = `bridge-${this.counter}`;
    this.waiting.set(id, callback);
    this.send({ id, method, params });
    return id;
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.writeLine(JSON.stringify(payload));
    } catch {
      // 进程刚退出时写不进去：下一轮发送会重新拉起。
    }
  }
}

/** 反方向请求里能映射成审批的那几种；其余返回 null（由调用方回错误）。 */
function approvalOf(method: string, id: string | number, params: Record<string, unknown>): CodexApproval | null {
  const reason = textOf(params["reason"]).trim();
  if (method === "item/commandExecution/requestApproval") {
    const command = textOf(params["command"]).trim() || describeActions(params["commandActions"]);
    return {
      id,
      method,
      kind: "command",
      ask: "允许执行这条命令吗？",
      text: command || "（没有给出命令）",
      ...(reason ? { reason } : {}),
      params,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const root = textOf(params["grantRoot"]).trim();
    return {
      id,
      method,
      kind: "fileChange",
      ask: root ? "允许写入这个目录吗？" : "允许应用这次文件改动吗？",
      text: root || textOf(params["itemId"]) || "（没有给出路径）",
      ...(reason ? { reason } : {}),
      params,
    };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = isRecord(params["permissions"]) ? params["permissions"] : {};
    const fs = isRecord(permissions["fileSystem"]) ? permissions["fileSystem"] : {};
    const entries = Array.isArray(fs["entries"]) ? fs["entries"] : [];
    const paths = entries
      .map((entry) => (isRecord(entry) && isRecord(entry["path"]) ? textOf(entry["path"]["path"]) : ""))
      .filter(Boolean);
    const network = isRecord(permissions["network"]) && permissions["network"]["enabled"] === true;
    return {
      id,
      method,
      kind: "permissions",
      ask: "允许这次额外的权限申请吗？",
      text: [...(paths.length > 0 ? [`路径：${paths.join("、")}`] : []), ...(network ? ["网络：开启"] : [])].join("；") ||
        textOf(params["cwd"]) ||
        "（没有给出细节）",
      ...(reason ? { reason } : {}),
      params,
    };
  }
  return null;
}

/** 应答体按请求类型不同：命令与文件改动只回 decision，权限回授予的 overlay。 */
function approvalResult(pending: CodexApproval, accept: boolean): Record<string, unknown> {
  if (pending.kind === "permissions") {
    const permissions = isRecord(pending.params["permissions"]) ? pending.params["permissions"] : {};
    // 拒绝就回空 overlay：什么都没多给，这一轮会按 sandbox 的原权限继续。
    return { permissions: accept ? permissions : {} };
  }
  return { decision: accept ? "accept" : "decline" };
}

/**
 * 上下文用量只认 `last`（本回合快照）：`total` 是整条线程所有回合的累加，
 * 拿它除以上下文窗口会直接顶到 100%（接管一条长线程时就是 28M / 475k）。
 * 另外 `inputTokens` 本身已经包含缓存命中，再加 `cachedInputTokens` 是重复计数。
 */
function contextOf(usage: Record<string, unknown>): ContextUsage | undefined {
  const snapshot = isRecord(usage["last"]) ? usage["last"] : {};
  const total = isRecord(usage["total"]) ? usage["total"] : {};
  const pick = (source: Record<string, unknown>, key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  };
  const last = Object.keys(snapshot).length > 0 ? snapshot : total;
  const input = pick(last, "inputTokens");
  const cacheRead = pick(last, "cachedInputTokens");
  const cacheWrite = pick(last, "cacheWriteInputTokens");
  const output = pick(last, "outputTokens");
  const used = input > 0 ? input : cacheRead + cacheWrite;
  if (used <= 0) return undefined;
  const window = typeof usage["modelContextWindow"] === "number" ? Math.round(usage["modelContextWindow"]) : 0;
  return {
    usedTokens: used,
    windowTokens: window > 0 ? window : 200_000,
    ...(window > 0 ? {} : { windowEstimated: true }),
    details: [
      { label: "输入（含缓存）", value: used.toLocaleString("en-US") },
      { label: "缓存读", value: cacheRead.toLocaleString("en-US") },
      { label: "缓存写", value: cacheWrite.toLocaleString("en-US") },
      { label: "输出", value: output.toLocaleString("en-US") },
    ],
  };
}

/** 一条历史回合 → 网页上的消息：用户输入一条，助手文本与工具活动各一条。 */
function historyOfTurn(turn: unknown): CodexHistoryMessage[] {
  const record = isRecord(turn) ? turn : {};
  const items = Array.isArray(record["items"]) ? record["items"] : [];
  const out: CodexHistoryMessage[] = [];
  for (const entry of items) {
    const item = isRecord(entry) ? entry : {};
    const at = typeof item["startedAtMs"] === "number" ? item["startedAtMs"] : Date.now();
    const type = textOf(item["type"]);
    if (type === "userMessage") {
      const text = userTextOf(item["content"]);
      if (text) out.push({ role: "user", blocks: [{ type: "text", text }], createdAt: at });
      continue;
    }
    if (type === "agentMessage") {
      const text = textOf(item["text"]).trim();
      if (text) out.push({ role: "assistant", blocks: [{ type: "text", text }], createdAt: at });
      continue;
    }
    const block = toolBlockOf(item);
    if (block) out.push({ role: "assistant", blocks: [block], createdAt: at });
  }
  return out;
}

/** 用户输入的 content 数组里只取文本；图片、音频这类历史里不展开。 */
function userTextOf(content: unknown): string {
  const list = Array.isArray(content) ? content : [];
  return list
    .map((entry) => (isRecord(entry) && entry["type"] === "text" ? textOf(entry["text"]) : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** 会当工具活动呈现的 item 类型；其余（userMessage、reasoning、plan…）不该画成工具。 */
const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"]);

/** 工具 item → 现有托管引擎用的 tool block 形状（工作区里终端与网页都按它渲染）。 */
function toolBlockOf(item: Record<string, unknown>): MessageBlock | null {
  const type = textOf(item["type"]);
  if (!TOOL_ITEMS.has(type)) return null;
  const text = cut(`${toolNameOf(type, item)} ${toolDetailOf(type, item)}`.trim());
  if (!text) return null;
  const summary = toolSummaryOf(item["commandActions"] ?? item["arguments"] ?? item["action"]);
  return { type: "tool", text, ...(summary ? { summary } : {}) };
}

function toolNameOf(type: string, item: Record<string, unknown>): string {
  if (type === "commandExecution") return "Bash";
  if (type === "fileChange") return "Edit";
  if (type === "webSearch") return "WebSearch";
  if (type === "mcpToolCall") {
    const server = textOf(item["server"]);
    const tool = textOf(item["tool"]);
    return server && tool ? `${server}.${tool}` : tool || server || "mcp";
  }
  if (type === "dynamicToolCall") return textOf(item["tool"]) || "tool";
  return type || "tool";
}

function toolDetailOf(type: string, item: Record<string, unknown>): string {
  if (type === "commandExecution") {
    const command = textOf(item["command"]);
    const exit = typeof item["exitCode"] === "number" ? item["exitCode"] : null;
    return exit !== null && exit !== 0 ? `${command}（退出码 ${exit}）` : command;
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
    const paths = changes
      .map((change) => (isRecord(change) ? textOf(change["path"]) : ""))
      .filter(Boolean)
      .slice(0, 5);
    return paths.join("、");
  }
  if (type === "webSearch") return textOf(item["query"]);
  if (type === "mcpToolCall" || type === "dynamicToolCall") return safeJson(item["arguments"]);
  return "";
}

function describeActions(value: unknown): string {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((entry) => (isRecord(entry) ? textOf(entry["command"]) : ""))
    .filter(Boolean)
    .join(" && ");
}

function cut(text: string): string {
  return text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function resultOf(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record["result"]) ? record["result"] : {};
}

function reasonOf(record: Record<string, unknown>): string {
  const error = record["error"];
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  if (typeof error === "string") return error;
  return "未知原因";
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
