/**
 * MCP 工具面（v1 白名单，spec §3）。
 *
 * 硬规矩（代码里逐条对应）：
 *   - 只调用白名单内的协议方法；shell.exec / fs.* / file.upload.* / device.* / transfer.* /
 *     hosted.delete / push.* / approval.respond / 镜像会话方法一律不映射、内部也不调用
 *     （device.list 只在 bridge_status 里做本设备自查，不是独立工具）。
 *   - 只碰登记册内会话；session_adopt 是唯一入口，且必须用户点名 sessionId。
 *   - 同一会话同时只允许一个由本 server 发起的未完成回合（session_send 遇 busy 直接报错）。
 *   - 前端 stop / 用户插话：session_wait/session_read 如实返回外部新消息，不自动续发、不重试。
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { BridgeLink, describeIdentity, loadIdentity } from "./lib/bridge.mjs";
import { ToolError } from "./lib/errors.mjs";
import { debug } from "./lib/log.mjs";
import { detectNeedsUser, hasTruncatedBlock, messageView, sortMessages, withFullText } from "./lib/messages.mjs";
import { ENGINES, loadProfile } from "./lib/profile.mjs";
import {
  appendAudit,
  describeEntry,
  findByKey,
  findBySessionId,
  findAcceptedSend,
  messageDigest,
  normalizePurpose,
  readRegistry,
  sessionKey,
  setArchived,
  setInFlight,
  touchSession,
  updateRegistry,
  upsertSession,
} from "./lib/registry.mjs";
import {
  attachTag,
  ensureTag,
  findSession,
  MCP_TAG_COLOR,
  MCP_TAG_NAME,
  shortPurpose,
  summarize,
} from "./lib/sessions.mjs";
import { statePaths } from "./lib/state.mjs";

const POLL_INTERVAL_MS = 5_000;
const IDLE_GRACE_MS = 15_000;
const MAX_WAIT_MS = 600_000;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;

let sharedLink = null;

export async function getLink() {
  if (!sharedLink) sharedLink = new BridgeLink();
  await sharedLink.open();
  return sharedLink;
}

export function closeLink() {
  if (sharedLink) sharedLink.close();
  sharedLink = null;
}

// ---------------------------------------------------------------- 参数校验

function requireString(args, name, { max = 200_000 } = {}) {
  const value = args?.[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError("invalid_params", `参数 ${name} 必填，且必须是非空字符串。`);
  }
  if (value.length > max) {
    throw new ToolError("invalid_params", `参数 ${name} 太长（${value.length} > ${max}）。`);
  }
  return value;
}

function optionalInt(args, name, { min, max, fallback }) {
  const value = args?.[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolError("invalid_params", `参数 ${name} 必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function rejectUnknown(args, allowed) {
  const extra = Object.keys(args ?? {}).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ToolError("invalid_params", `不认识的参数：${extra.join(", ")}。允许的参数：${allowed.join(", ")}。`);
  }
}

/** 登记册闸门：不在登记册里的会话，除 session_adopt 外一律拒绝。 */
function requireRegistryEntry(registry, sessionId) {
  const entry = findBySessionId(registry, sessionId);
  if (!entry) {
    throw new ToolError(
      "not_in_registry",
      `会话 ${sessionId} 不在登记册内，本连接器不会操作它。`,
      {
        hint: "用户明确点名要接管这个会话时，用 session_adopt（参数 sessionId + purpose）；否则先用 session_open 建/复用会话。",
      },
    );
  }
  return entry;
}

/**
 * 把 message.list 的原始消息转成工具输出视图；长文本被 bridge 截断的那些再取一次 message.text。
 * 逐字原则：正文一律原文全天，取不到全文时如实标注（不静默截断）。
 */
async function messageViews(link, sessionId, records) {
  const views = [];
  for (const record of sortMessages(records)) {
    let view = messageView(record);
    if (hasTruncatedBlock(record)) {
      try {
        const full = await link.call("message.text", { sessionId, messageId: record.messageId }, { timeoutMs: 60_000 });
        view = typeof full?.text === "string"
          ? withFullText(view, full)
          : { ...view, fullTextUnavailable: true, fullTextNote: "bridge 没有返回该消息的全文" };
      } catch (error) {
        view = {
          ...view,
          fullTextUnavailable: true,
          fullTextNote: `取全文失败（${error?.code ?? "error"}）：${error?.message ?? error}；text 字段是列表里截断后的内容`,
        };
      }
    }
    views.push(view);
  }
  return views;
}

function needsUserView(detection, modeA) {
  if (!detection) return { needsUser: false, needsUserMessage: null };
  if (modeA) {
    return {
      needsUser: true,
      needsUserMessage: null,
      modeA: true,
      modeANote: "modeA 开启：只报告 pi 在提问，不提供转批便利；请在前端会话里直接回答。",
    };
  }
  return {
    needsUser: true,
    needsUserMessage: detection,
    modeA: false,
    needsUserNote: "pi 的提问以普通会话消息出现：请用户逐字确认后，用 session_send 把答复发回。",
  };
}

/** 所有工具的第一道门：未配对 → 明确的「未配对」错误（带配对指引），绝不伪造身份。 */
async function ensurePaired() {
  await loadIdentity();
}

// ---------------------------------------------------------------- 工具定义

const SESSION_ID_SCHEMA = {
  type: "string",
  description: "Bridge 会话 ID（必须是本连接器登记册内的会话；session_adopt 是唯一接管入口）",
};

export const TOOL_DEFINITIONS = [
  {
    name: "bridge_status",
    description:
      "只读：连接/设备/bridge 信息。返回本连接器设备身份（public 部分）、relay、配对时记录的 bridge 信息、device.list 自查结果与登记册概览。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_list",
    description:
      "只读：只列登记册内会话，并附带各自在 bridge 侧的实时状态（busy/hosted/归档等）。未登记的会话不会出现在这里。",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "是否包含登记册里已归档的条目（默认 false）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_open",
    description:
      "get-or-create：按 (engine, cwd, purpose) 查登记册；命中且会话还在就复用，否则用 hosted.create 新建（非空启动偏好显式传；空值不传，交给 CLI 默认），自动打 MCP 标签、标题 MCP · <purpose>，并写入登记册。cwd 必须在 bridge 托管白名单内（远程设备不能 addDir）。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "bridge 托管白名单内的绝对路径（本机 agent 的工作目录）" },
        purpose: { type: "string", description: "用途线短名，同一 (engine,cwd,purpose) 复用同一会话" },
        engine: { type: "string", enum: ENGINES, description: "托管引擎；缺省取 profile.engine" },
        model: { type: "string", description: "主模型；缺省取 profile.model" },
        thinking: { type: "string", description: "主思考等级；缺省取 profile.thinking" },
        subagentModel: { type: "string", description: "子代理模型；缺省取 profile.subagentModel" },
        subagentThinking: { type: "string", description: "子代理思考等级；缺省取 profile.subagentThinking" },
        title: { type: "string", description: "可选：覆盖默认标题 MCP · <purpose>" },
      },
      required: ["cwd", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "session_read",
    description:
      "只读：读登记册会话最近 N 条消息 + busy 状态，返回消息全文（不摘要/不截断，超长按条数分页）。回合结束后若 pi 在提问，标出 needsUser 与原文。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT, description: `条数，默认 ${DEFAULT_READ_LIMIT}` },
        before: { type: "string", description: "分页游标（上一页返回的 nextBefore）" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "session_wait",
    description:
      "轮询到 busy 变 false 或超时（默认 120s，上限 600s），返回这期间的新消息（全文）与是否在等用户回答。用户从前端 stop/插话时如实返回，不自动续发。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_WAIT_MS, description: `默认 ${DEFAULT_WAIT_MS}` },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT, description: "每次轮询取多少条（默认 50）" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "session_send",
    description:
      "写：给登记册会话发一条消息。带 operationId 幂等键（可传入复用：同一 operationId 已投递成功时不再重发）；profile.promptSuffix 非空时在末尾追加该后缀（useSubagent=false 不加）；写发送审计（只存哈希）。会话 busy 时直接报错，不排队不叠发。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        text: { type: "string", description: "消息正文（原样发送，只按规则追加后缀）" },
        useSubagent: { type: "boolean", description: "默认 true；false 时不追加 promptSuffix" },
        operationId: {
          type: "string",
          description:
            "可选幂等键（建议 UUID）：超时后重试时传同一个值。同一 operationId 已投递成功的，server 直接返回上次结果、不再发一次。",
        },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "session_stop",
    description: "写：停掉登记册会话的托管进程（hosted.stop）。",
    inputSchema: {
      type: "object",
      properties: { sessionId: SESSION_ID_SCHEMA },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "session_archive",
    description: "写：归档登记册会话（hosted.archive），并在登记册里标记 archived。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        archived: { type: "boolean", description: "默认 true；false 表示取消归档" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "session_adopt",
    description:
      "写：用户点名接管一个既有托管会话。先校验会话存在且在 bridge 侧是托管会话，再打 MCP 标签、写入登记册（参数 sessionId + purpose）。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        purpose: { type: "string", description: "接管后这条用途线的短名" },
      },
      required: ["sessionId", "purpose"],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

// ---------------------------------------------------------------- 工具实现

/**
 * 登记册并发约定（lost-update 修复，见 lib/registry.mjs 顶部注释）：
 *   - 只读快照用 readRegistry()（锁内 load，不写）；
 *   - 登记册变更用 updateRegistry()（锁内 load 最新 → 纯变更 → save）；
 *   - bridge 网络调用一律在锁外，网络之后必须重新 load，绝不保存网络之前的快照。
 */

async function bridgeStatus() {
  const identity = await loadIdentity();
  const { profile } = await loadProfile();
  const link = await getLink();
  const warnings = [];

  const devicesResult = await link.call("device.list", undefined, { timeoutMs: 30_000 }).catch((error) => {
    warnings.push(`device.list 失败：${error.message}`);
    return null;
  });
  const devices = (devicesResult?.devices ?? []).map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
    clientType: device.clientType ?? "web",
    createdAt: device.createdAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
    revokedAt: device.revokedAt ?? null,
    expiresAt: device.expiresAt ?? null,
    self: device.deviceId === identity.deviceId,
  }));
  const self = devices.find((device) => device.self) ?? null;

  const { registry } = await readRegistry();
  const active = registry.sessions.filter((entry) => !entry.archived);

  return {
    ok: true,
    connected: true,
    device: {
      ...describeIdentity(identity),
      revokedAt: self?.revokedAt ?? null,
      lastSeenAt: self?.lastSeenAt ?? null,
      clientTypeInBridge: self?.clientType ?? null,
      presentInDeviceList: Boolean(self),
    },
    bridge: identity.bridge ?? null, // 配对时 bridge 自报的 name/version/platform（本地记录）
    relayUrl: identity.relayUrl ?? profile.relayUrl,
    roomId: identity.roomId ?? null,
    profile,
    registry: {
      path: statePaths().registry,
      sessions: registry.sessions.length,
      active: active.length,
      lastUsedAt: registry.sessions.map((entry) => entry.lastUsedAt).sort().at(-1) ?? null,
    },
    devices,
    warnings,
  };
}

async function sessionList(args) {
  rejectUnknown(args, ["includeArchived"]);
  await ensurePaired();
  const includeArchived = args?.includeArchived === true;
  const link = await getLink();
  const list = await link.call("session.list", { includeArchived: true }, { timeoutMs: 60_000 });
  // 只读快照在锁内取、取完即放；网络调用不持锁。
  const { registry } = await readRegistry();
  const byId = new Map((list?.sessions ?? []).map((session) => [session.sessionId, session]));
  const entries = registry.sessions
    .filter((entry) => includeArchived || !entry.archived)
    .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))
    .map((entry) => {
      const session = byId.get(entry.sessionId) ?? null;
      return {
        ...describeEntry(entry),
        present: Boolean(session),
        sessionMissing: !session,
        bridge: summarize(session),
      };
    });
  return {
    ok: true,
    count: entries.length,
    completeness: list?.completeness ?? null,
    note: list?.note ?? null,
    unfinishedTurns: entries.filter((entry) => entry.inFlight && entry.bridge?.busy).map((entry) => entry.sessionId),
    sessions: entries,
    scopeNote: "只列登记册内会话；未登记会话请让用户明确点名后用 session_adopt 接管。",
  };
}

async function sessionOpen(args) {
  await ensurePaired();
  rejectUnknown(args, ["cwd", "purpose", "engine", "model", "thinking", "subagentModel", "subagentThinking", "title"]);
  const cwdRaw = requireString(args, "cwd", { max: 4096 });
  const purpose = requireString(args, "purpose", { max: 200 });
  if (!isAbsolute(cwdRaw)) {
    throw new ToolError("invalid_params", "cwd 必须是绝对路径（bridge 白名单里登记的就是绝对路径）。");
  }
  const cwd = resolve(cwdRaw);

  const { profile } = await loadProfile();
  const engine = args.engine ?? profile.engine;
  if (!ENGINES.includes(engine)) {
    throw new ToolError("invalid_params", `engine 只接受 ${ENGINES.join("/")}。`);
  }
  const launch = {
    model: args.model ?? profile.model,
    thinking: args.thinking ?? profile.thinking,
    subagentModel: args.subagentModel ?? profile.subagentModel,
    subagentThinking: args.subagentThinking ?? profile.subagentThinking,
  };
  for (const [key, value] of Object.entries(launch)) {
    if (typeof value !== "string") {
      throw new ToolError("invalid_params", `${key} 必须是字符串（覆盖值或 profile 值）。`);
    }
  }
  // 空字符串 = 不传该参数：协议里这些字段都是可选的，由 bridge / CLI 自己的默认决定。
  const launchParams = {};
  for (const [key, value] of Object.entries(launch)) {
    if (value.trim()) launchParams[key] = value;
  }

  const key = sessionKey({ engine, cwd, purpose });
  const warnings = [];
  const link = await getLink();

  // (a) 锁内只读一次快照做「命中」判断；不持锁做任何 bridge 调用。
  const { registry: snapshot } = await readRegistry();
  const existing = findByKey(snapshot, key);
  if (existing) {
    const session = await findSession(link, existing.sessionId).catch((error) => {
      warnings.push(`校验既有会话失败：${error.message}`);
      return null;
    });
    if (session && session.archived !== true) {
      let tag = null;
      try {
        tag = await ensureTag(link, MCP_TAG_NAME, MCP_TAG_COLOR);
        await attachTag(link, existing.sessionId, tag.tag.tagId);
      } catch (error) {
        warnings.push(`补打 MCP 标签失败（会话可继续使用）：${error.message}`);
      }
      // (c) 网络调用结束后重新 load 最新登记册，只把 lastUsedAt 这一个变更应用到最新状态上。
      const { result: entry } = await updateRegistry((registry) => {
        const target = findByKey(registry, key) ?? findBySessionId(registry, existing.sessionId);
        if (target) {
          touchSession(registry, target.sessionId);
          return describeEntry(findBySessionId(registry, target.sessionId) ?? target);
        }
        // 极端情况：期间登记册被改掉了；会话还活着就重新登记，不静默丢线。
        return describeEntry(
          upsertSession(registry, {
            key,
            engine,
            cwd,
            purpose,
            sessionId: session.sessionId,
            title: session.title ?? existing.title,
          }),
        );
      });
      return {
        ok: true,
        reused: true,
        reason: "registry_hit",
        session: summarize(session),
        registry: entry,
        tag: tag?.tag.name ?? null,
        warnings,
      };
    }
    warnings.push(
      session
        ? `登记册里的会话 ${existing.sessionId} 已归档，按规则新开一条。`
        : `登记册里的会话 ${existing.sessionId} 在 bridge 侧已不存在，按规则新开一条。`,
    );
  }

  const dirs = await link.call("hosted.dirs", undefined, { timeoutMs: 30_000 });
  if (dirs?.enabled === false) {
    throw new ToolError("hosted_disabled", "bridge 的托管会话功能未启用（hosted.enabled=false）。", {
      hint: "在 Mac 菜单栏 Agent Bridge 的设定里启用托管会话。",
    });
  }
  const usable = (dirs?.dirs ?? []).filter((dir) => dir.exists !== false && dir.allowed !== false);
  const allowed = usable.find((dir) => resolve(dir.path) === cwd);
  if (!allowed) {
    throw new ToolError(
      "cwd_not_allowlisted",
      `目录 ${cwd} 不在 bridge 托管白名单内，hosted.create 会被拒绝。`,
      {
        hint:
          "远程配对设备不能 addDir（bridge 按设计拒绝）；请用户在 Mac 菜单栏的「设定」里把该目录加入白名单，或改用下面某个已在白名单的目录。",
        details: { allowlistedDirs: usable.map((dir) => dir.path) },
      },
    );
  }

  const tag = await ensureTag(link, MCP_TAG_NAME, MCP_TAG_COLOR);
  const title = (args.title && args.title.trim()) || `MCP · ${shortPurpose(purpose)}`;
  const createParams = {
    path: allowed.path,
    agent: engine,
    ...launchParams,
    title,
  };
  debug("hosted.create", { path: createParams.path, agent: createParams.agent, title });
  const created = await link.call("hosted.create", createParams, {
    timeoutMs: 120_000,
    operationId: randomUUID(),
  });
  const session = created?.session ?? null;
  if (!session?.sessionId) {
    throw new ToolError("hosted_create_failed", "bridge 没有返回新会话的 sessionId。", { details: created });
  }

  let tagged = null;
  try {
    tagged = await attachTag(link, session.sessionId, tag.tag.tagId);
  } catch (error) {
    warnings.push(`MCP 标签没打上（会话已创建，可重试 session_open 补齐）：${error.message}`);
  }

  // (c) 登记新会话：锁内重新 load 最新登记册后整体应用（不用网络调用前的快照）。
  const { result: entry } = await updateRegistry((registry) => {
    const saved = upsertSession(registry, {
      key,
      engine,
      cwd,
      purpose,
      sessionId: session.sessionId,
      title: session.title ?? title,
    });
    appendAudit(registry, {
      action: "session_open",
      sessionId: session.sessionId,
      engine,
      cwd,
      purpose: normalizePurpose(purpose),
    });
    return describeEntry(saved);
  });

  return {
    ok: true,
    reused: false,
    reason: existing ? "replaced_missing_or_archived" : "created",
    session: summarize(session),
    registry: entry,
    tag: tag.tag.name,
    tags: tagged?.map((item) => item.name) ?? null,
    createParams,
    warnings,
  };
}

async function sessionRead(args) {
  rejectUnknown(args, ["sessionId", "limit", "before"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const limit = optionalInt(args, "limit", { min: 1, max: MAX_READ_LIMIT, fallback: DEFAULT_READ_LIMIT });
  if (args?.before !== undefined && typeof args.before !== "string") {
    throw new ToolError("invalid_params", "before 必须是字符串游标。");
  }
  const { profile } = await loadProfile();
  const { registry } = await readRegistry();
  const entry = requireRegistryEntry(registry, sessionId);
  const link = await getLink();

  const params = { sessionId, limit, ...(args?.before ? { before: args.before } : {}) };
  const page = await link.call("message.list", params, { timeoutMs: 60_000 });
  const summary = await findSession(link, sessionId).catch(() => null);
  const busy = page?.busy === true || summary?.busy === true;

  const messages = await messageViews(link, sessionId, page?.messages ?? []);
  // pi 的结构化提问（ask/next-step pending）在 bridge 侧会一直算 busy，所以
  // needsDecision 为 true 时也要标 needsUser；busy 时不跑问号启发式，避免半截输出误报。
  const detection = detectNeedsUser(page?.messages ?? [], summary, { allowTextHeuristic: !busy });

  // (c) 网络 I/O 全部结束后，锁内重新 load 最新登记册再落账（不保存前面的快照）。
  const { result: registryEntry } = await updateRegistry((registry) => {
    if (!findBySessionId(registry, sessionId)) return null;
    touchSession(registry, sessionId);
    if (!busy) setInFlight(registry, sessionId, null);
    return describeEntry(findBySessionId(registry, sessionId));
  });

  return {
    ok: true,
    sessionId,
    title: summary?.title ?? registryEntry?.title ?? entry.title,
    busy,
    needsDecision: summary?.needsDecision === true,
    messages,
    messageCount: messages.length,
    nextBefore: page?.nextBefore ?? null,
    hasMore: Boolean(page?.nextBefore),
    completeness: page?.completeness ?? null,
    note: page?.note ?? null,
    context: page?.context ?? null,
    ...needsUserView(detection, profile.modeA),
    fullTextNote: "消息正文为原文全文；超长会话按条数分页（limit/before），工具层不改写内容。",
  };
}

async function sessionWait(args) {
  rejectUnknown(args, ["sessionId", "timeoutMs", "limit"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const timeoutMs = optionalInt(args, "timeoutMs", { min: 1000, max: MAX_WAIT_MS, fallback: DEFAULT_WAIT_MS });
  const limit = optionalInt(args, "limit", { min: 1, max: MAX_READ_LIMIT, fallback: 50 });
  const { profile } = await loadProfile();
  const { registry } = await readRegistry();
  requireRegistryEntry(registry, sessionId);
  const link = await getLink();

  const started = Date.now();
  const deadline = started + timeoutMs;
  const first = await link.call("message.list", { sessionId, limit }, { timeoutMs: 60_000 });
  const baseline = new Set((first?.messages ?? []).map((record) => record.messageId));
  let page = first;
  let sawBusy = page?.busy === true;
  let timedOut = false;

  for (;;) {
    const busy = page?.busy === true;
    if (busy) sawBusy = true;
    if (!busy) {
      // 回合结束；或本来就没在跑且已经过了宽限期（给 pi 一点启动时间）。
      if (sawBusy) break;
      if (Date.now() - started >= IDLE_GRACE_MS) break;
    }
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(remaining, 0))));
    page = await link.call("message.list", { sessionId, limit }, { timeoutMs: 60_000 });
  }

  const summary = await findSession(link, sessionId).catch(() => null);
  const busy = page?.busy === true || summary?.busy === true;
  const fresh = (page?.messages ?? []).filter((record) => !baseline.has(record.messageId));
  const messages = await messageViews(link, sessionId, fresh);
  const detection = detectNeedsUser(page?.messages ?? [], summary, { allowTextHeuristic: !busy });

  // (c) 轮询可能跑了几分钟：这里必须重新 load，不能用轮询开始前的快照去盖写。
  await updateRegistry((registry) => {
    if (!findBySessionId(registry, sessionId)) return null;
    touchSession(registry, sessionId);
    if (!busy) setInFlight(registry, sessionId, null);
    return null;
  });

  return {
    ok: true,
    sessionId,
    title: summary?.title ?? null,
    busy,
    timedOut,
    waitedMs: Date.now() - started,
    pollIntervalMs: POLL_INTERVAL_MS,
    newMessages: messages,
    newMessageCount: messages.length,
    needsDecision: summary?.needsDecision === true,
    interrupted: page?.interrupted === true,
    ...needsUserView(detection, profile.modeA),
    note: timedOut
      ? `等待 ${timeoutMs}ms 后仍未观察到回合结束；会话当前 busy=${busy}，可继续 session_wait。`
      : busy
        ? "会话仍在执行。"
        : messages.length === 0
          ? "会话当前空闲，等待期间没有新消息。"
          : null,
    noAutoContinueNote:
      "本工具不续发、不重试。若新消息来自用户（前端 stop / 插话），按用户新指令处理，不要把原任务继续推到底。",
  };
}

async function sessionSend(args) {
  rejectUnknown(args, ["sessionId", "text", "useSubagent", "operationId"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const text = requireString(args, "text");
  if (args?.useSubagent !== undefined && typeof args.useSubagent !== "boolean") {
    throw new ToolError("invalid_params", "useSubagent 必须是布尔值。");
  }
  if (
    args?.operationId !== undefined &&
    (typeof args.operationId !== "string" || !args.operationId.trim() || args.operationId.length > 200)
  ) {
    throw new ToolError("invalid_params", "operationId 必须是非空字符串（≤200 字符）。");
  }
  const useSubagent = args.useSubagent !== false;
  const { profile } = await loadProfile();
  const { registry } = await readRegistry();
  const entry = requireRegistryEntry(registry, sessionId);
  const operationId = args?.operationId?.trim() || randomUUID();

  // 幂等：bridge 侧不看 operationId，所以幂等在本层做——同一 operationId 已投递成功就不再重发。
  const prior = findAcceptedSend(registry, sessionId, operationId);
  if (prior) {
    return {
      ok: true,
      deduped: true,
      sessionId,
      accepted: true,
      delivered: prior.delivered === true,
      operationId,
      promptSuffixApplied: prior.promptSuffixApplied === true,
      textSentSha256: prior.messageSha256,
      note: "同一 operationId 已经投递过（审计里 accepted=true），本次未重发。真要再发一条，请换一个 operationId。",
    };
  }

  const link = await getLink();

  const page = await link.call("message.list", { sessionId, limit: 1 }, { timeoutMs: 60_000 });
  const summary = await findSession(link, sessionId).catch(() => null);
  const busy = page?.busy === true || summary?.busy === true;
  if (busy) {
    throw new ToolError(
      "session_busy",
      `会话 ${sessionId} 正在执行上一个回合（busy=true），本次消息未发送。`,
      {
        hint: "同一会话同时只允许一个本连接器发起的回合。用 session_wait 跟进当前回合（或 session_read 查看进度），结束再发。",
        details: { inFlight: entry.inFlight ?? null },
      },
    );
  }
  // 陈旧的 inFlight 不在这里单独写：下面 (c) 会用本回合的 operationId 直接盖掉，
  // 这样网络调用失败时也不会凭空改登记册。

  const suffix = useSubagent ? String(profile.promptSuffix ?? "").trim() : "";
  const body = text.replace(/\s+$/, "");
  const finalText = suffix && !body.endsWith(suffix) ? `${body}\n${suffix}` : body;

  const ack = await link.call("message.send", { sessionId, text: finalText }, {
    timeoutMs: 60_000,
    operationId,
  });

  const digest = messageDigest(finalText);
  // (c) 发送已在锁外完成；重新 load 最新登记册，在其上置 inFlight + 追加审计。
  await updateRegistry((registry) => {
    if (!findBySessionId(registry, sessionId)) return null;
    setInFlight(registry, sessionId, { operationId, at: new Date().toISOString() });
    appendAudit(registry, {
      action: "session_send",
      sessionId,
      operationId,
      messageSha256: digest,
      chars: finalText.length,
      promptSuffixApplied: Boolean(suffix) && finalText !== body,
      useSubagent,
      accepted: ack?.accepted === true,
      delivered: ack?.delivered === true,
    });
    touchSession(registry, sessionId);
    return null;
  });

  return {
    ok: true,
    sessionId,
    accepted: ack?.accepted === true,
    delivered: ack?.delivered === true,
    detail: ack?.detail ?? null,
    operationId,
    promptSuffixApplied: Boolean(suffix) && finalText !== body,
    textSent: finalText,
    audit: {
      messageSha256: digest,
      chars: finalText.length,
      note: "登记册只存消息哈希与元数据，不存全文。",
    },
  };
}

async function sessionStop(args) {
  rejectUnknown(args, ["sessionId"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const { registry } = await readRegistry();
  requireRegistryEntry(registry, sessionId);
  const link = await getLink();

  const result = await link.call("hosted.stop", { sessionId }, {
    timeoutMs: 60_000,
    operationId: randomUUID(),
  });
  // (c) 停进程成功后再落账（锁内重新 load）。
  await updateRegistry((registry) => {
    if (!findBySessionId(registry, sessionId)) return null;
    setInFlight(registry, sessionId, null);
    touchSession(registry, sessionId);
    appendAudit(registry, { action: "session_stop", sessionId, stopped: result?.stopped === true });
    return null;
  });

  return {
    ok: true,
    sessionId,
    stopped: result?.stopped === true,
    session: summarize(result?.session ?? null),
    note: result?.stopped === true ? null : "bridge 表示没有在跑的托管进程（可能已停）。",
  };
}

async function sessionArchive(args) {
  rejectUnknown(args, ["sessionId", "archived"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const archived = args?.archived !== false;
  const { registry } = await readRegistry();
  requireRegistryEntry(registry, sessionId);
  const link = await getLink();

  const result = await link.call("hosted.archive", { sessionId, archived }, {
    timeoutMs: 60_000,
    operationId: randomUUID(),
  });
  // (c) 归档已生效，锁内重新 load 最新登记册再标 archived + 审计。
  const { result: entry } = await updateRegistry((registry) => {
    if (!findBySessionId(registry, sessionId)) return null;
    setArchived(registry, sessionId, archived);
    appendAudit(registry, { action: "session_archive", sessionId, archived });
    return describeEntry(findBySessionId(registry, sessionId));
  });

  return {
    ok: true,
    sessionId,
    archived,
    session: summarize(result?.session ?? null),
    registry: entry,
  };
}

async function sessionAdopt(args) {
  rejectUnknown(args, ["sessionId", "purpose"]);
  await ensurePaired();
  const sessionId = requireString(args, "sessionId", { max: 200 });
  const purpose = requireString(args, "purpose", { max: 200 });
  const link = await getLink();
  const warnings = [];

  const session = await findSession(link, sessionId);
  if (!session) {
    throw new ToolError("session_not_found", `bridge 里找不到会话 ${sessionId}。`, {
      hint: "让用户确认 sessionId（可在网页/菜单栏复制）；不要猜测或模糊匹配。",
    });
  }
  if (session.hosted !== true) {
    throw new ToolError("not_hosted", `会话 ${sessionId} 不是 bridge 托管会话，本连接器只碰托管会话。`, {
      details: { appId: session.appId, kind: session.kind },
    });
  }
  if (session.archived === true) {
    throw new ToolError("session_archived", `会话 ${sessionId} 已归档；先让用户在 bridge 侧取消归档再接管。`);
  }

  const engine = session.hostedAgent ?? "pi";
  const cwd = session.cwd ?? "";
  const tag = await ensureTag(link, MCP_TAG_NAME, MCP_TAG_COLOR);
  let tags = null;
  try {
    tags = await attachTag(link, sessionId, tag.tag.tagId);
  } catch (error) {
    warnings.push(`MCP 标签没打上（仍会登记）：${error.message}`);
  }

  const { result: entry } = await updateRegistry((registry) => {
    const saved = upsertSession(registry, {
      key: sessionKey({ engine, cwd, purpose }),
      engine,
      cwd,
      purpose,
      sessionId,
      title: session.title,
      createdAt: new Date(session.createdAt ?? Date.now()).toISOString(),
    });
    appendAudit(registry, { action: "session_adopt", sessionId, purpose: normalizePurpose(purpose), engine, cwd });
    return describeEntry(saved);
  });

  return {
    ok: true,
    adopted: true,
    session: summarize(session),
    registry: entry,
    tag: tag.tag.name,
    tags: tags?.map((item) => item.name) ?? null,
    warnings,
  };
}

export const HANDLERS = {
  bridge_status: bridgeStatus,
  session_list: sessionList,
  session_open: sessionOpen,
  session_read: sessionRead,
  session_wait: sessionWait,
  session_send: sessionSend,
  session_stop: sessionStop,
  session_archive: sessionArchive,
  session_adopt: sessionAdopt,
};

