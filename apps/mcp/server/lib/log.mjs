/**
 * 脱敏日志：MCP server 的 stdout 只走 JSON-RPC，所有人类日志一律写 stderr。
 *
 * 硬规矩：reconnectToken、设备私钥等凭据绝不进日志。调用方（identity 加载处）
 * 通过 registerSecret() 登记已知秘密串，日志格式化时统一替换成 [redacted]，
 * 即使将来有人误把整个身份对象塞进日志也不会漏出去。
 */

const secrets = new Set();

/** 登记一个已知秘密（长度 >= 8 才有意义）；只影响日志输出，不影响内存使用。 */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

function redact(text) {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function format(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level, args) {
  const line = redact(args.map(format).join(" "));
  process.stderr.write(`[agent-bridge${level ? ` ${level}` : ""}] ${line}\n`);
}

export function log(...args) {
  emit("", args);
}

export function warn(...args) {
  emit("warn", args);
}

export function debug(...args) {
  if (process.env.AGENT_BRIDGE_DEBUG === "1") emit("debug", args);
}
