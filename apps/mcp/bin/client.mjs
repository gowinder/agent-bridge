#!/usr/bin/env node
/**
 * Agent Bridge MCP 的 CLI client（调用方 agent 用 exec 调它）。
 *
 *   node bin/client.mjs list-tools
 *   node bin/client.mjs call-tool --name session_list --arguments-file args.json
 *
 * 它管理 server 子进程（stdio JSON-RPC）：initialize → notifications/initialized →
 * tools/list 或 tools/call。只有 ALLOWED_TOOLS 里的工具名会被放行，其余在本地拒绝。
 * 传输成功 != 工具成功：结果带 isError 或 JSON-RPC 报错时退出码 1，且不重放调用。
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

/** 已审阅、允许调用的工具（与 server/tools.mjs 的 v1 白名单一致）。新增工具必须人工复核后再加。 */
export const ALLOWED_TOOLS = Object.freeze([
  "bridge_status",
  "session_list",
  "session_open",
  "session_read",
  "session_wait",
  "session_send",
  "session_stop",
  "session_archive",
  "session_adopt",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, "..", "server", "index.mjs");
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 660_000;
const PROTOCOL_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "agent-bridge-mcp-client", title: "Agent Bridge MCP client", version: "1.0.0" };

const USAGE = `用法：
  node bin/client.mjs list-tools
  node bin/client.mjs call-tool --name <tool> --arguments-file <json 文件>

说明：
  - 只有 ALLOWED_TOOLS 内的工具可调（${ALLOWED_TOOLS.join(", ")}）。
  - arguments 是一个 JSON 对象文件，里面不要放任何凭据。
  - 退出码：0 成功；1 工具报错/JSON-RPC 报错/超时；2 用法或权限拒绝。
`;

class RpcClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #stderr = [];

  constructor({ serverPath = SERVER_ENTRY, env = process.env } = {}) {
    this.#child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const rl = createInterface({ input: this.#child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => this.#onLine(line));
    this.#child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.#stderr.push(text);
      if (this.#stderr.length > 200) this.#stderr.shift();
      process.stderr.write(text);
    });
    this.#child.on("error", (error) => {
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    });
    this.#child.on("close", (code) => {
      for (const { reject } of this.#pending.values()) {
        reject(new Error(`server 已退出（code=${code}）`));
      }
      this.#pending.clear();
    });
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[client] 忽略非 JSON 输出：${trimmed.slice(0, 200)}\n`);
      return;
    }
    if (message.id === undefined || message.id === null) {
      // server 主动通知（本 server 不发，但别把协议放宽到「静默丢弃」以外）。
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.resolve({ error: message.error });
      return;
    }
    pending.resolve({ result: message.result });
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`等待 server 响应超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    const payload = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (response.error) throw rpcError("initialize", response.error);
    const version = response.result?.protocolVersion;
    if (typeof version !== "string") throw new Error("server 没有返回 protocolVersion");
    this.notify("notifications/initialized");
    return response.result;
  }

  close() {
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, 1500).unref();
  }

  /** 等 server 自然退出（最多等 2s），避免把僵尸进程留在调用方 shell 里。 */
  async finished() {
    if (this.#child.exitCode !== null) return this.#child.exitCode;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(this.#child.exitCode ?? 0), 2000);
      this.#child.once("close", (code) => {
        clearTimeout(timer);
        resolvePromise(code ?? 0);
      });
    });
  }
}

function rpcError(method, error) {
  const err = new Error(`${method} 失败：${error?.message ?? JSON.stringify(error)}`);
  err.rpc = error;
  return err;
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`参数 ${item} 缺值`);
      flags.set(item.slice(2), next);
      i += 1;
      continue;
    }
    positional.push(item);
  }
  return { positional, flags };
}

async function loadArgumentsFile(path) {
  const text = await readFile(resolve(path), "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`arguments 文件不是合法 JSON：${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("arguments 文件必须是单个 JSON 对象");
  }
  return value;
}

function printPayload(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
}

function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return text;
}

async function runListTools(client) {
  const response = await client.request("tools/list", {});
  if (response.error) throw rpcError("tools/list", response.error);
  const tools = Array.isArray(response.result?.tools) ? response.result.tools : [];
  const allowed = new Set(ALLOWED_TOOLS);
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    allowedTools: ALLOWED_TOOLS,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      allowed: allowed.has(tool.name),
    })),
    blockedTools: tools.filter((tool) => !allowed.has(tool.name)).map((tool) => tool.name),
  };
  if (payload.blockedTools.length > 0) {
    process.stderr.write(
      `[client] server 暴露了 ALLOWED_TOOLS 之外的 ${payload.blockedTools.length} 个工具，已标记 allowed=false 且调用会被本地拒绝：${payload.blockedTools.join(", ")}\n`,
    );
  }
  printPayload(payload);
  return 0;
}

async function runCallTool(client, flags) {
  const name = flags.get("name");
  const argsFile = flags.get("arguments-file");
  if (!name) throw new UsageError("call-tool 需要 --name <tool>");
  if (!argsFile) throw new UsageError("call-tool 需要 --arguments-file <json 文件>");
  if (!ALLOWED_TOOLS.includes(name)) {
    throw new PermissionError(
      `工具 ${name} 不在 ALLOWED_TOOLS 内，已拒绝调用。允许的工具：${ALLOWED_TOOLS.join(", ")}`,
    );
  }
  const args = await loadArgumentsFile(argsFile);

  const waitMs = Number.isInteger(args.timeoutMs) ? args.timeoutMs : 0;
  const timeoutMs = Math.min(Math.max(DEFAULT_TIMEOUT_MS, waitMs + DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const response = await client.request("tools/call", { name, arguments: args }, timeoutMs);
  if (response.error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: response.error }, null, 2)}\n`);
    return 1;
  }
  const result = response.result ?? {};
  const text = extractText(result);
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // 不是 JSON 就原样输出
  }
  printPayload(payload);
  if (result.isError === true) {
    process.stderr.write(`[client] 工具 ${name} 返回 isError=true\n`);
    return 1;
  }
  return 0;
}

class UsageError extends Error {}
class PermissionError extends Error {}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const [command] = parsed.positional;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command !== "list-tools" && command !== "call-tool") {
    process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
    return 2;
  }

  const client = new RpcClient();
  let code = 0;
  try {
    const info = await client.initialize();
    process.stderr.write(`[client] server=${info?.serverInfo?.name ?? "?"} v${info?.serverInfo?.version ?? "?"} protocol=${info?.protocolVersion ?? "?"}\n`);
    code = command === "list-tools" ? await runListTools(client) : await runCallTool(client, parsed.flags);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      code = 2;
    } else if (error instanceof PermissionError) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "tool_not_allowed", message: error.message } }, null, 2)}\n`);
      code = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "client_error", message: error.message } }, null, 2)}\n`);
      code = 1;
    }
  } finally {
    client.close();
    await client.finished();
  }
  return code;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[client] 未处理错误：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
