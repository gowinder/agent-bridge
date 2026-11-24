#!/usr/bin/env node
/**
 * Agent Bridge MCP server（stdio 传输）。
 *
 * 只实现 MCP 的最小面：initialize / notifications/initialized / ping / tools/list / tools/call。
 * stdout 只写 JSON-RPC（一行一条），所有人类日志走 stderr（lib/log.mjs）。
 * 工具面是 v1 白名单（tools.mjs 的 TOOL_DEFINITIONS），其它协议方法一律不暴露。
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log, warn } from "./lib/log.mjs";
import { closeLink, HANDLERS, TOOL_DEFINITIONS } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function serverVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVER_INFO = {
  name: "agent-bridge-mcp",
  title: "Agent Bridge (MCP)",
  version: serverVersion(),
};

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function toolResult(id, value, { isError = false } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  respond(id, {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  });
}

function safeMessage(error) {
  if (error?.code && error?.message && typeof error.toJSON === "function") return error.toJSON();
  return {
    ok: false,
    error: {
      code: "internal",
      message: `工具执行失败：${error?.message ?? String(error)}`,
    },
  };
}

async function handleToolCall(id, params) {
  const name = params?.name;
  if (typeof name !== "string" || !name) {
    respondError(id, -32602, "tools/call 需要字符串参数 name。");
    return;
  }
  if (!TOOL_NAMES.has(name)) {
    respondError(id, -32602, `未知工具：${name}（本 server 只提供 v1 白名单内的 9 个工具）。`);
    return;
  }
  const args = params?.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    respondError(id, -32602, "tools/call 的 arguments 必须是 JSON 对象。");
    return;
  }
  try {
    const result = await HANDLERS[name](args);
    toolResult(id, result);
  } catch (error) {
    if (error?.name === "ToolError" || typeof error?.toJSON === "function") {
      toolResult(id, error.toJSON(), { isError: true });
      return;
    }
    warn(`工具 ${name} 内部错误：${error?.stack ?? error}`);
    toolResult(id, safeMessage(error), { isError: true });
  }
}

async function dispatch(message) {
  const { id, method, params } = message ?? {};
  if (typeof method !== "string") {
    if (id !== undefined && id !== null) respondError(id, -32600, "无效请求：缺 method。");
    return;
  }
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PREFERRED_PROTOCOL_VERSION;
      respond(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: [
          "Agent Bridge（MCP v1）：通过 agent-bridge 中继操作 Mac 上由 bridge 托管的 pi/Claude Code 会话。",
          "只操作登记册内会话；新会话用 session_open，接管已有会话必须用户点名 sessionId 后用 session_adopt。",
          "pi 的提问以普通消息出现：session_read/session_wait 会标出 needsUser 与原文，请逐字转达用户，再用 session_send 发回答复。",
        ].join("\n"),
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: TOOL_DEFINITIONS });
      return;
    case "tools/call":
      await handleToolCall(id, params);
      return;
    default:
      if (id !== undefined && id !== null) respondError(id, -32601, `不支持的方法：${method}`);
  }
}

function start() {
  log(`Agent Bridge MCP v${SERVER_INFO.version} 就绪（stdio）`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, "JSON 解析失败。");
      return;
    }
    if (Array.isArray(message)) {
      respondError(null, -32600, "不支持 JSON-RPC 批量请求。");
      return;
    }
    // 串行处理：同一进程内不要并发执行工具，避免相互抢 id / 抢连接。
    queue = queue.then(() => dispatch(message)).catch((error) => {
      warn(`分发失败：${error?.stack ?? error}`);
    });
  });

  const shutdown = (code = 0) => {
    closeLink();
    process.exit(code);
  };

  rl.on("close", () => {
    queue.finally(() => shutdown(0));
  });
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.stdout.on("error", () => shutdown(0));
}

start();
