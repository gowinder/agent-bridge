#!/usr/bin/env bash
# v2 listener 启停包装。JSON 状态输出，退出码：0 正常；1 启动失败（进程没起来）；2 用法错误。
#
#   bin/listener.sh start    # 已在跑则不动；否则 setsid/nohup 拉起，2s 后打印状态
#   bin/listener.sh stop     # 按 pidfile 发 SIGTERM（10s 不退则 SIGKILL）
#   bin/listener.sh status   # {running, pid, stateDir, heartbeat}
#
# 状态目录：$AB_LISTENER_STATE_DIR，或与 server/lib/listener-state.mjs 一致的默认值
# （$AGENT_BRIDGE_MCP_HOME / $XDG_CONFIG_HOME/agent-bridge/mcp / ~/.agent-bridge/mcp，再拼 /listener）。
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
# 覆盖值只认绝对路径（与 server/lib/state.mjs 的 absoluteOverride 一致）：相对路径在
# node 侧会被忽略，这里若照收就会让 pidfile/心跳落到另一种目录上。
abs_path() {
  case "${1:-}" in
    /*) printf '%s' "$1" ;;
    *) printf '' ;;
  esac
}
HOME_OVERRIDE="$(abs_path "${AGENT_BRIDGE_MCP_HOME:-}")"
XDG_OVERRIDE="$(abs_path "${XDG_CONFIG_HOME:-}")"
LISTENER_OVERRIDE="$(abs_path "${AB_LISTENER_STATE_DIR:-}")"
if [ -n "${AGENT_BRIDGE_MCP_HOME:-}" ] && [ -z "${HOME_OVERRIDE}" ]; then
  printf '[agent-bridge warn] AGENT_BRIDGE_MCP_HOME 必须是绝对路径，已忽略「%s」\n' "${AGENT_BRIDGE_MCP_HOME}" >&2
fi
if [ -n "${AB_LISTENER_STATE_DIR:-}" ] && [ -z "${LISTENER_OVERRIDE}" ]; then
  printf '[agent-bridge warn] AB_LISTENER_STATE_DIR 必须是绝对路径，已忽略「%s」\n' "${AB_LISTENER_STATE_DIR}" >&2
fi
if [ -n "${HOME_OVERRIDE}" ]; then
  CONFIG_ROOT="${HOME_OVERRIDE}"
elif [ -n "${XDG_OVERRIDE}" ]; then
  CONFIG_ROOT="${XDG_OVERRIDE}/agent-bridge/mcp"
else
  CONFIG_ROOT="${HOME}/.agent-bridge/mcp"
fi
STATE_DIR="${LISTENER_OVERRIDE:-${CONFIG_ROOT}/listener}"
# 把解析结果传给拉起的 node 进程，保证启动器的 pid/心跳 与 listener 自己的状态目录完全一致。
export AB_LISTENER_STATE_DIR="${STATE_DIR}"
PID_FILE="${STATE_DIR}/listener.pid"
HEARTBEAT="${STATE_DIR}/heartbeat.json"
LOG_FILE="${STATE_DIR}/listener.log"

read_pid() {
  [ -f "${PID_FILE}" ] || return 0
  tr -dc '0-9' < "${PID_FILE}" 2>/dev/null
}

is_alive() {
  local pid="${1:-}"
  [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

print_status() {
  STATE_DIR="${STATE_DIR}" PID_FILE="${PID_FILE}" HEARTBEAT="${HEARTBEAT}" node -e '
    const fs = require("node:fs");
    const read = (path) => { try { return fs.readFileSync(path, "utf8"); } catch { return null; } };
    let pid = null;
    const rawPid = read(process.env.PID_FILE);
    if (rawPid !== null) {
      const parsed = Number.parseInt(rawPid.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    }
    let running = false;
    if (pid !== null) {
      try { process.kill(pid, 0); running = true; } catch (error) { running = error.code === "EPERM"; }
    }
    let heartbeat = null;
    const rawHeartbeat = read(process.env.HEARTBEAT);
    if (rawHeartbeat !== null) { try { heartbeat = JSON.parse(rawHeartbeat); } catch { heartbeat = null; } }
    process.stdout.write(JSON.stringify({ running, pid, stateDir: process.env.STATE_DIR, heartbeat }, null, 2) + "\n");
  '
}

ensure_state_dir() {
  mkdir -p "${STATE_DIR}"
  chmod 700 "${STATE_DIR}"
}

start() {
  local pid
  pid="$(read_pid)"
  if is_alive "${pid}"; then
    echo "listener 已在运行（pid=${pid}），未重复启动。"
    print_status
    return 0
  fi
  ensure_state_dir
  : >> "${LOG_FILE}"
  chmod 600 "${LOG_FILE}"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup node "${ROOT}/server/listener.mjs" >> "${LOG_FILE}" 2>&1 < /dev/null &
  else
    nohup node "${ROOT}/server/listener.mjs" >> "${LOG_FILE}" 2>&1 < /dev/null &
  fi
  sleep 2
  pid="$(read_pid)"
  if is_alive "${pid}"; then
    print_status
    return 0
  fi
  echo "listener 没有起来（请检查 ${LOG_FILE}）：" >&2
  tail -n 20 "${LOG_FILE}" >&2 2>/dev/null || true
  print_status
  return 1
}

stop() {
  local pid i
  pid="$(read_pid)"
  if ! is_alive "${pid}"; then
    echo "listener 没在运行（pidfile: ${PID_FILE}）。"
    rm -f "${PID_FILE}"
    print_status
    return 0
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  for i in $(seq 1 20); do
    is_alive "${pid}" || break
    sleep 0.5
  done
  if is_alive "${pid}"; then
    echo "10s 内没有退出，发送 SIGKILL（pid=${pid}）。" >&2
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
  print_status
  return 0
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) print_status ;;
  *)
    echo "用法：$(basename "$0") {start|stop|status}" >&2
    exit 2
    ;;
esac
