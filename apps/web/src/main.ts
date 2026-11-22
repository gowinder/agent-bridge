import { DEFAULT_COMPACTION_TRIGGER_PERCENT, MAX_TRANSFER_CHARS, TAG_COLORS } from "@craftstead/protocol";
import type {
  AppInfo,
  AppListResult,
  ContextUsage,
  DeviceSummary,
  DevtoolsStatus,
  ErrorCode,
  FileUploadBeginResult,
  FileUploadChunkResult,
  FileUploadFinishResult,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsRoot,
  FsRootsResult,
  HostedAgent,
  HostedCreateDefaults,
  HostedDirsResult,
  HostedInterruptResult,
  HostedOptionsResult,
  HostedPermissionMode,
  HostInfoResult,
  MessageAttachment,
  MessageBlock,
  MessageListResult,
  MessageQuestion,
  MessageRecord,
  MessageSendResult,
  SessionTagRef,
  SessionTagsResult,
  SessionTokens,
  TokenUsage,
  MessageTextResult,
  Method,
  ModelOption,
  NextStepAction,
  ProjectInfo,
  ProjectListResult,
  PushInfoResult,
  PushSubscribeResult,
  RailRow,
  RailTask,
  SessionCompactResult,
  SessionCreateResult,
  SessionGetResult,
  SessionListResult,
  SessionModelsResult,
  SessionRailResult,
  SessionRenameResult,
  SessionSearchResult,
  SessionSummary,
  ShellCancelResult,
  ShellEventData,
  ShellExecResult,
  TagColor,
  TagDef,
  TagListResult,
  TodoItem,
  TodoKind,
  TodoListResult,
  TransferCommitResult,
  TransferPrepareResult,
} from "@craftstead/protocol";
import {
  expireLabel,
  getDeviceSecrets,
  hasVault,
  isExpiringSoon,
  listDevices,
  LockedError,
  needsUnlock,
  removeDevice,
  renameDevice,
  resetCredentials,
  setupPassword,
  unlock,
  type DeviceMeta,
  type DeviceSecrets,
} from "./credentials.js";
import { isPreviewDeployment } from "./deployment.js";
import { parsePairingInput, takeInviteLink, type PairingLink } from "./link.js";
import { renderMarkdown } from "./markdown.js";
import { stepView } from "./tool-steps.js";
import { connectDevice, finishPairing, startPairing, type PairingChallenge } from "./pairing.js";
import { PeerError, type PeerClient } from "./peer.js";
import { RelayError, type RelayConnection } from "./relay.js";
import "./style.css";
import { LANGS, langId, locale, serverTr, setLang, tr } from "./i18n";

const RELAY_ERRORS: Record<string, string> = {
  invite_expired: tr("邀请已过期，请在 Mac 上重新生成配对链接。"),
  invite_used: tr("邀请已被使用，请在 Mac 上重新生成配对链接。"),
  device_expired: tr("设备授权已到期，请重新配对。"),
  device_revoked: tr("设备已被撤销，请重新配对。"),
  bridge_offline: tr("Mac 上的 Bridge 没有连接中继，请确认它正在运行。"),
  channel_in_use: tr("连接通道已被占用，请稍后重试。"),
  invalid_credential: tr("凭据无效，请重新配对。"),
  not_found: tr("找不到该房间，请重新配对。"),
  rate_limited: tr("请求太频繁，稍等片刻再试。"),
};

function messageOf(error: unknown): string {
  if (error instanceof RelayError) return RELAY_ERRORS[error.code] ?? tr(`中继拒绝：{0}`, error.message);
  return error instanceof Error ? error.message : String(error);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, className = "btn"): HTMLButtonElement {
  const node = el("button", { className, text: label, attrs: { type: "button" } });
  node.addEventListener("click", onClick);
  return node;
}

/** 正在输入法组合中的输入框：那一下回车是给输入法的，不能当成提交。 */
const imeComposing = new WeakSet<EventTarget>();

function trackIme(input: HTMLElement): void {
  input.addEventListener("compositionstart", () => imeComposing.add(input));
  input.addEventListener("compositionend", () => {
    // Safari 在 compositionend 之后紧跟的 Enter 已经不带 isComposing：晚一拍再放开。
    window.setTimeout(() => imeComposing.delete(input), 0);
  });
}

/** 中文输入法用回车确认候选词时会发 keydown Enter（keyCode 229），不能触发提交。 */
function isImeEnter(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  return imeComposing.has(event.currentTarget as EventTarget);
}

const ICONS = {
  chevron:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  back:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>',
  share:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="m4.8 5.2 3.2-3.2 3.2 3.2"/><path d="M3 9.5v3.1c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V9.5"/></svg>',
  copy:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.4" y="5.4" width="7.6" height="7.6" rx="1.4"/><path d="M10.6 5.4v-1A1.4 1.4 0 0 0 9.2 3H4.4A1.4 1.4 0 0 0 3 4.4v4.8a1.4 1.4 0 0 0 1.4 1.4h1"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  plus:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>',
  device:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3" width="11.6" height="7.6" rx="1.4"/><path d="M5.6 13.2h4.8"/></svg>',
  download:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4v8.2"/><path d="m4.8 7.6 3.2 3.2 3.2-3.2"/><path d="M2.8 13.2h10.4"/></svg>',
  swap:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h9.5"/><path d="m10 3 2.5 2.5L10 8"/><path d="M13 10.5H3.5"/><path d="M6 8 3.5 10.5 6 13"/></svg>',
  clip:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.9 4.6 6 9.5a2.1 2.1 0 0 0 3 3l4.9-4.9a3.5 3.5 0 0 0-5-5L4.2 7.3a4.9 4.9 0 0 0 6.9 6.9l3.1-3.1"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="9" rx="1.6"/><circle cx="6" cy="7" r="1.1"/><path d="m3.2 11.4 3.1-3 2.2 2.1 2-1.9 2.4 2.3"/></svg>',
  file:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
  pencil:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L6 12.8l-3.2.8.8-3.2z"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/><path d="M13.4 2.6v2.9h-2.9"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.7"/><path d="M2.6 2.6v2.9h2.9"/><path d="M8 5.4V8l1.9 1.1"/></svg>',
  stop:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><rect x="5.8" y="5.8" width="4.4" height="4.4" rx="1" fill="currentColor" stroke="none"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 8.4l2.8 2.8 6-6.2"/></svg>',
  rail:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3" width="11.6" height="10" rx="1.6"/><path d="M9.6 3v10"/><path d="M4.4 6.2h2.4M4.4 8.6h2.4"/></svg>',
  bell:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 6.8a3.8 3.8 0 0 1 7.6 0c0 3 1 4.2 1.6 4.7H2.6c.6-.5 1.6-1.7 1.6-4.7Z"/><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/></svg>',
  bellOff:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 6.8a3.8 3.8 0 0 1 5.6-3.3M11.8 7.4c.1 2 1 3.1 1.5 3.6H5.2"/><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/><path d="m2.8 2.8 10.4 10.4"/></svg>',
  unread:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.3" fill="currentColor" stroke="none"/></svg>',
  expand:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.6H2.6V6"/><path d="M10 2.6h3.4V6"/><path d="M13.4 10v3.4H10"/><path d="M6 13.4H2.6V10"/></svg>',
  collapse:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 6H6V2.6"/><path d="M13.4 6H10V2.6"/><path d="M10 13.4V10h3.4"/><path d="M6 13.4V10H2.6"/></svg>',
  menu:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>',
  more:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><circle cx="3.6" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.4" cy="8" r="1.25"/></svg>',
  pin:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 1.9h5.6"/><path d="M6.4 1.9v3.3L4.5 7.5a.9.9 0 0 0-.45.78v.42h7.9v-.42a.9.9 0 0 0-.45-.78L9.6 5.2V1.9"/><path d="M8 8.7v5.4"/></svg>',
  pinOff:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 1.9h5.6"/><path d="M6.4 1.9v3.3L4.5 7.5a.9.9 0 0 0-.45.78v.42h7.9v-.42a.9.9 0 0 0-.45-.78L9.6 5.2V1.9"/><path d="M8 8.7v5.4"/><path d="m2.4 2.4 11.2 11.2"/></svg>',
  archive:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.4" y="3" width="11.2" height="3" rx="1"/><path d="M3.6 6v6.4c0 .6.4 1 1 1h6.8c.6 0 1-.4 1-1V6"/><path d="M6.4 8.6h3.2"/></svg>',
  unarchive:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.4" y="3" width="11.2" height="3" rx="1"/><path d="M3.6 6v6.4c0 .6.4 1 1 1h6.8c.6 0 1-.4 1-1V6"/><path d="M8 12.4V8.4"/><path d="m6.4 9.8 1.6-1.6 1.6 1.6"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.6h10"/><path d="M6.2 4.6V3.2c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.4"/><path d="M4.4 4.6l.6 8.2c0 .6.5 1 1 1h4c.5 0 1-.4 1-1l.6-8.2"/><path d="M6.8 7v4M9.2 7v4"/></svg>',
} as const;

function backButton(onClick: () => void): HTMLButtonElement {
  const node = button("", onClick, "back-btn");
  node.append(icon("back"), el("span", { className: "back-label", text: tr("返回") }));
  node.setAttribute("aria-label", tr("返回"));
  return node;
}

function icon(name: keyof typeof ICONS, className = "icon"): HTMLElement {
  const span = el("span", { className });
  span.innerHTML = ICONS[name];
  return span;
}

/** Matches dist/version.json; "dev" disables the update check under `vite dev`. */
const APP_VERSION = __APP_VERSION__;
const VERSION_POLL_MS = 60_000;

function showUpdateBanner(version: string): void {
  if (document.querySelector(".update-banner")) return;
  const bar = el("div", { className: "update-banner", attrs: { role: "status" } });
  bar.append(
    el("span", { className: "update-text", text: tr("前端已更新，刷新后使用新版本") }),
    button(
      tr("刷新"),
      () => {
        const url = new URL(location.href);
        url.searchParams.set("v", version);
        location.replace(url.toString());
      },
      "btn primary small",
    ),
  );
  document.body.append(bar);
}

/** Prompts the user to reload when the deployed bundle is newer than the running one. */
function watchForUpdates(): void {
  if (APP_VERSION === "dev") return;
  let pending = false;
  const check = async (): Promise<void> => {
    if (pending) return;
    try {
      const response = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data: unknown = await response.json();
      const version =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)["version"]
          : undefined;
      if (typeof version !== "string" || version === APP_VERSION) return;
      pending = true;
      showUpdateBanner(version);
    } catch {
      // Offline or no version.json; the next tick tries again.
    }
  };
  void check();
  window.setInterval(() => void check(), VERSION_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error(tr("缺少 #app 容器"));
const app: HTMLDivElement = root;

let active: PeerClient | null = null;
let generation = 0;
/** 可见时的心跳间隔与判定窗口；手机挂起后回来靠它第一时间发现「假活」。 */
const HEARTBEAT_MS = 20_000;
/**
 * Bridge 的请求是一条串行队列：搜索预算 8 秒、压缩能跑两分钟。探活给的时间比队列
 * 里最长的那类任务短，就会把「正在忙」误判成「已经死了」并主动拆链。
 */
const HEARTBEAT_TIMEOUT_MS = 20_000;
/** 连续两次探活都没回音才算死：一次超时可能只是它排在长任务后面。 */
const HEARTBEAT_MISSES = 2;
/** 请求超时/回到前台时的短探活：够快，又不至于把慢请求误判成断线。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 探活失败计数，见 HEARTBEAT_MISSES。 */
let heartbeatMisses = 0;
/** 心跳定时器：页面可见时每 20 秒 ping 一次，隐藏时停掉省电。 */
let heartbeatTimer: number | null = null;
/** 刚配对完回到首页时提示一句回落地页的入口；只影响一次渲染。 */
let justPaired = false;
let retryTimer: number | null = null;
let pollTimer: number | null = null;
let renderToken = 0;
let deferredListRender = false;
/** 新建托管会话表单的草稿：中途重连重绘时把已填内容还回去，不打断输入。 */
let hostedDraft: {
  projectId: string;
  title: string;
  model: string;
  /** pi 会话的主模型，和 Claude Code 的 `model` 分开存：两份清单不通用。 */
  piModel: string;
  effort: string;
  mode: string;
  agent: HostedAgent;
  subagentModel: string;
  /** pi 的思考等级（`--thinking`）；空串表示跟随 pi 设置。 */
  piThinking: string;
  /** 子代理的思考等级（`subagents.defaultThinking`）；空串表示跟随 pi 设置。 */
  subagentThinking: string;
} | null = null;
/**
 * 上一次新建托管会话时用的选项，存在 Bridge 的 hosted.json 里（换浏览器也在），
 * 会话列表页先取一次，点「新建」时就能直接拿来填默认值。
 */
let hostedCreateDefaults: HostedCreateDefaults | null = null;

/**
 * 点「新建」时现取一次：别的标签页或浏览器刚建过会话，缓存就会过期，
 * 拿旧值预填再直接提交会把刚记住的选项又覆盖回去。`hosted.dirs` 是轻量的那份。
 */
async function fetchHostedCreateDefaults(): Promise<HostedCreateDefaults | null> {
  try {
    const config = await call<HostedDirsResult>("hosted.dirs");
    hostedCreateDefaults = config.lastCreate ?? null;
  } catch {
    // 取不到就沿用缓存（可能为空），按默认值建也不影响创建。
  }
  return hostedCreateDefaults;
}
/** 会话列表页是否显示已归档的会话；只影响本页，不进快照。 */
let showArchived = false;
/** 桌面客户端（dsh）新建会话面板的草稿，同样在重绘时保留。 */
let desktopDraft: { projectId: string; text: string } | null = null;
/** Lets a soft reconnect refresh the open chat in place instead of re-rendering it. */
let chatResumeKey: string | null = null;
let chatResume: (() => void) | null = null;

let progressBar: HTMLElement | null = null;
let reconnectMessage: string | null = null;

function progressStart(): void {
  if (!progressBar) {
    progressBar = el("div", { className: "progress-bar", attrs: { role: "progressbar", "aria-label": tr("正在加载") } });
    document.body.append(progressBar);
  }
  progressBar.classList.add("active");
}

function progressDone(): void {
  progressBar?.classList.remove("active");
}

function reconnectChip(): HTMLElement {
  return el("span", { className: "reconnect-chip", attrs: { role: "status", "aria-live": "polite" } }, [
    el("span", { className: "reconnect-dot" }),
    el("span", { className: "reconnect-text" }),
  ]);
}

function setReconnecting(message: string | null): void {
  reconnectMessage = message;
  document.documentElement.classList.toggle("offline", message !== null);
  const actions = app.querySelector<HTMLElement>(".topbar-actions");
  if (!actions) return;
  const existing = actions.querySelector<HTMLElement>(".reconnect-chip");
  if (message === null) {
    existing?.remove();
    return;
  }
  const chip = existing ?? reconnectChip();
  if (!existing) actions.prepend(chip);
  const text = chip.querySelector(".reconnect-text");
  if (text) text.textContent = message;
}

interface ConnectedState {
  device: DeviceMeta;
  info: HostInfoResult;
  devices: DeviceSummary[];
}
let connected: ConnectedState | null = null;

interface Snapshot {
  apps: AppInfo[];
  projects: ProjectInfo[];
  sessions: SessionSummary[];
  /** 标签库：Bridge 级的，与桌面端共用的那一份。 */
  tags: TagDef[];
  note?: string;
}
let snapshot: Snapshot | null = null;

const UNREAD_KEY = "ab.unreadSessions";
const NOTIFY_KEY = "ab.completionNotifications";

/** sessionId -> completion time, kept across reloads until the chat is opened again. */
function readUnread(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

let unreadSessions = readUnread();

function persistUnread(): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(unreadSessions));
  } catch {
    // storage unavailable; the badge still lives in memory
  }
}

function markUnread(sessionId: string, at: number): void {
  unreadSessions[sessionId] = at;
  persistUnread();
  paintUnreadTitle();
}

function markRead(sessionId: string): void {
  if (!(sessionId in unreadSessions)) return;
  delete unreadSessions[sessionId];
  persistUnread();
  paintUnreadTitle();
}

function unreadAt(sessionId: string): number | undefined {
  return unreadSessions[sessionId];
}

function unreadCount(sessions: SessionSummary[]): number {
  return sessions.filter((session) => unreadAt(session.sessionId) !== undefined).length;
}

/** 页面原本的标题；未读数量以 `(n) ` 前缀叠在上面，换页时重新记一次。 */
let baseTitle = "";

function paintUnreadTitle(): void {
  if (!baseTitle) return;
  const unread = snapshot ? unreadCount(snapshot.sessions) : Object.keys(unreadSessions).length;
  document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
}

function setTitle(title: string): void {
  baseTitle = title;
  paintUnreadTitle();
}

/** 手机浏览器关掉页面后只剩 Service Worker 推送能把提醒送到通知中心。 */
function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
}

function notificationsSupported(): boolean {
  return pushSupported() || "Notification" in window;
}

/** iPhone / iPad 上的 Safari 只有「添加到主屏幕」后的独立窗口才能收推送。 */
function iosNeedsInstall(): boolean {
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return false;
  const standalone =
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return !standalone;
}

const IOS_HINT = tr("iPhone 需要先在 Safari 里用「添加到主屏幕」，再从主屏幕打开，才能收到后台提醒。");

/** 有的浏览器只提供 Service Worker 推送，没有 Notification 构造器。 */
function notificationPermission(): NotificationPermission {
  if (!("Notification" in window)) return "granted";
  return Notification.permission;
}

function notificationsOn(): boolean {
  if (!notificationsSupported()) return false;
  if (notificationPermission() !== "granted") return false;
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "0";
  } catch {
    return true;
  }
}

const PUSH_KEY = "ab.pushSubscribed";

function pushOn(): boolean {
  try {
    return localStorage.getItem(PUSH_KEY) === "1";
  } catch {
    return false;
  }
}

function setPushFlag(on: boolean): void {
  try {
    localStorage.setItem(PUSH_KEY, on ? "1" : "0");
  } catch {
    // 存储不可用时只影响下次刷新，当前页面仍按内存里的状态走
  }
}

let swReady: Promise<ServiceWorkerRegistration> | null = null;

function serviceWorker(): Promise<ServiceWorkerRegistration> {
  if (!swReady) swReady = navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return swReady;
}

function keyBytes(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

function bytesKey(value: ArrayBuffer | null): string {
  if (!value) return "";
  let raw = "";
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 订阅系统推送并把地址交给 Bridge。返回失败原因，成功返回 null：调用方决定要不要
 * 把原因显示给用户（自动同步时静默）。
 */
async function subscribePush(): Promise<string | null> {
  if (!pushSupported()) return tr("这个浏览器不支持后台推送");
  const registration = await serviceWorker();
  const info = await call<PushInfoResult>("push.info");
  let subscription = await registration.pushManager.getSubscription();
  // Bridge 换过 VAPID 密钥（比如重装了数据目录）时，旧订阅在推送服务那端已经失效。
  if (subscription && bytesKey(subscription.options.applicationServerKey as ArrayBuffer | null) !== info.publicKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(info.publicKey),
    });
  }
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys["p256dh"] || !keys["auth"]) return tr("浏览器没有给出推送地址");
  await call<PushSubscribeResult>("push.subscribe", {
    endpoint: json.endpoint,
    keys: { p256dh: keys["p256dh"], auth: keys["auth"] },
  });
  setPushFlag(true);
  return null;
}

async function unsubscribePush(): Promise<void> {
  setPushFlag(false);
  if (!pushSupported()) return;
  try {
    const registration = await serviceWorker();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await call("push.unsubscribe", { endpoint });
  } catch {
    // 连接已断时也得让按钮关得掉；本地标记已经清了，订阅会随浏览器过期。
  }
}

/** 重连后补一次订阅：VAPID 换过或 Bridge 清过订阅都能自动恢复。 */
async function syncPush(): Promise<void> {
  if (!notificationsOn() || !pushSupported()) return;
  try {
    await subscribePush();
  } catch {
    // 自动同步失败不打扰用户，下次重连再试
  }
}

function notifyCompletion(session: SessionSummary): void {
  // 推送已订阅时由 Bridge 统一发，页面里再弹一次就是重复提醒。
  if (!notificationsOn() || pushOn()) return;
  const appName = snapshot?.apps.find((item) => item.appId === session.appId)?.name ?? "Agent Bridge";
  try {
    const note = new Notification(session.title || tr("对话已完成"), {
      body: tr(`{0} · 回复已完成`, appName),
      tag: `ab-complete-${session.sessionId}`,
    });
    note.onclick = () => {
      window.focus();
      note.close();
      navigate({
        level: "chat",
        appId: session.appId,
        projectId: session.projectId,
        sessionId: session.sessionId,
      });
    };
  } catch {
    // Notification constructor refused; the unread badge still marks the chat.
  }
}

/** The last busy flag seen per chat; a true -> false edge is a finished turn. */
const busySeen = new Map<string, boolean>();
let watchedAt = 0;

function observeSessions(sessions: SessionSummary[]): void {
  const route = parseRoute();
  for (const session of sessions) {
    const busy = session.busy === true;
    const was = busySeen.get(session.sessionId);
    busySeen.set(session.sessionId, busy);
    const viewing =
      route.level === "chat" &&
      route.sessionId === session.sessionId &&
      document.visibilityState === "visible";
    if (viewing) {
      // A background completion can land while this chat stays open without re-rendering,
      // so clear the badge here instead of only on the busy edge below.
      markRead(session.sessionId);
      continue;
    }
    if (was !== true || busy) continue;
    markUnread(session.sessionId, Date.now());
    notifyCompletion(session);
  }
}

/**
 * Chat pages do not rebuild the snapshot, so a finished turn in another chat would go
 * unnoticed; re-read the session list in the background and only record the edges.
 */
async function watchSessions(): Promise<void> {
  if (!active || !snapshot) return;
  const now = Date.now();
  if (now - watchedAt < 8_000) return;
  watchedAt = now;
  const apps = snapshot.apps;
  try {
    const pages = await Promise.all(
      apps.map((app) =>
        call<SessionListResult>("session.list", { appId: app.appId, includeArchived: true, limit: 500 }),
      ),
    );
    const sessions = pages.flatMap((page) => page.sessions);
    if (!snapshot) return;
    const before = snapshotSignature();
    // Chrome pages keep their own session summary; refreshing the list in place lets the
    // back navigation show what the background watch saw without another reload.
    snapshot = { ...snapshot, sessions };
    observeSessions(sessions);
    // The list poller compares against this snapshot, so a change seen here would otherwise
    // never repaint; re-render the visible list from the data this watcher just stored.
    if (document.visibilityState !== "visible") return;
    if (snapshotSignature() === before) return;
    const route = parseRoute();
    if (route.level === "clients" || route.level === "projects" || route.level === "sessions") {
      repaintList();
      return;
    }
    // 停在聊天/任务页时整页重绘会打断正在输入的内容，只把侧栏的状态角标换掉。
    syncDockSessions();
  } catch {
    // The connection layer already reports disconnects; the next tick retries.
  }
}

let watchTimer: number | null = null;
let dockRenderDeferred = false;

/** Every page watches completions, including while the tab is hidden or showing another route. */
function startSessionWatch(): void {
  if (watchTimer !== null) return;
  watchTimer = window.setInterval(() => void watchSessions(), 10_000);
  document.addEventListener("visibilitychange", onWatchVisible);
  void syncPush();
}

/** Background tabs throttle the timer, so returning to the tab refreshes at once. */
function onWatchVisible(): void {
  if (document.visibilityState !== "visible") return;
  watchedAt = 0;
  void watchSessions();
}

function stopSessionWatch(): void {
  document.removeEventListener("visibilitychange", onWatchVisible);
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

type Route =
  | { level: "clients" }
  | { level: "projects"; appId: string }
  | { level: "sessions"; appId: string; projectId: string }
  | { level: "chat"; appId: string; projectId: string; sessionId: string; taskId?: string }
  | { level: "devices" };

/** 手改地址栏或旧链接里的 `%` 不是合法转义时 decodeURIComponent 会抛，退回原文。 */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean).map(safeDecode);
  if (parts[0] === "devices") return { level: "devices" };
  if (parts[0] !== "clients") return { level: "clients" };
  const appId = parts[1];
  if (!appId) return { level: "clients" };
  const projectId = parts[2] === "projects" ? parts[3] : undefined;
  if (!projectId) return { level: "projects", appId };
  const sessionId = parts[4] === "sessions" ? parts[5] : undefined;
  if (!sessionId) return { level: "sessions", appId, projectId };
  const taskId = parts[6] === "tasks" ? parts[7] : undefined;
  return taskId
    ? { level: "chat", appId, projectId, sessionId, taskId }
    : { level: "chat", appId, projectId, sessionId };
}

function hashFor(route: Route): string {
  switch (route.level) {
    case "clients":
      return "#/clients";
    case "devices":
      return "#/devices";
    case "projects":
      return `#/clients/${encodeURIComponent(route.appId)}`;
    case "sessions":
      return `#/clients/${encodeURIComponent(route.appId)}/projects/${encodeURIComponent(route.projectId)}`;
    case "chat":
      return `#/clients/${encodeURIComponent(route.appId)}/projects/${encodeURIComponent(route.projectId)}/sessions/${encodeURIComponent(route.sessionId)}${
        route.taskId ? `/tasks/${encodeURIComponent(route.taskId)}` : ""
      }`;
  }
}

function navigate(route: Route, replace = false): void {
  // 窄屏抽屉里点条目就跳走，跳之前先收起，免得新页面还压着遮罩。
  if (dockOpen) setDockOpen(false);
  const hash = hashFor(route);
  if (location.hash === hash) {
    void renderRoute();
    return;
  }
  if (replace) {
    history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
    void renderRoute();
    return;
  }
  location.hash = hash;
}

// 点通知时 Service Worker 会让已经开着的页面换到那条会话，而不是再开一个窗口。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (!data || data.type !== "ab.navigate" || typeof data.url !== "string") return;
    const index = data.url.indexOf("#");
    if (index !== -1 && data.url.slice(index) !== location.hash) location.hash = data.url.slice(index);
  });
}

function stopActive(): void {
  generation += 1;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  stopPolling();
  stopHeartbeat();
  stopSessionWatch();
  active?.stop();
  active = null;
  connected = null;
  snapshot = null;
  interruptShellRuns();
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  // 后台标签页的定时器本来就会被节流，这里干脆不发，省电也省流量。
  if (document.visibilityState !== "visible") return;
  heartbeatTimer = window.setInterval(() => void heartbeatTick(), HEARTBEAT_MS);
}

/** 通道还在但可能已经死了：只有 Bridge 真的回话才能证明它活着。 */
/**
 * `host.ping` 是 0.11.4 才有的空方法。更早的 Bridge 不认识它：`parseWireMessage`
 * 按 METHODS 白名单校验，不在表里整帧丢弃，既不回包也不报错 —— 探活必然超时，
 * 网页就会每 20 秒断一次链（而网页是随部署立即生效的）。这类旧 Bridge 退回
 * 用各版本都有的 `host.info` 做探活。
 */
/** `0.11.4-rc.17` → 按 0.11.4 比（预发布后缀不参与）。 */
function atLeastVersion(version: string, want: [number, number, number]): boolean {
  const base = (version.split("-")[0] ?? "").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const have = base[index] ?? 0;
    const need = want[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

function heartbeatMethod(): "host.ping" | "host.info" {
  const version = connected?.info.version;
  return version !== undefined && atLeastVersion(version, [0, 11, 4]) ? "host.ping" : "host.info";
}

async function pingHost(timeoutMs: number): Promise<boolean> {
  const client = active;
  if (!client) return false;
  try {
    await client.request(heartbeatMethod(), undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 丢掉当前连接并进入重连。故意保留 `connected`/`snapshot`：
 * 页面继续显示断线前的数据，重连成功后 `renderRoute(soft)` 会把它们刷新掉，
 * 用户不会突然看到白屏或者被踢回首页。
 */
function connectionLost(message: string): void {
  const device = connected?.device;
  if (!device) return;
  // 已经在重连的路上：重复调度会把退避重置回第 1 次。
  if (active === null && retryTimer !== null) return;
  stopPolling();
  stopHeartbeat();
  active?.stop();
  active = null;
  setReconnecting(message);
  scheduleRetry(device, 1);
}

async function heartbeatTick(): Promise<void> {
  if (!active || document.visibilityState !== "visible") return;
  if (await pingHost(HEARTBEAT_TIMEOUT_MS)) {
    heartbeatMisses = 0;
    return;
  }
  heartbeatMisses += 1;
  if (heartbeatMisses < HEARTBEAT_MISSES) return;
  heartbeatMisses = 0;
  connectionLost(tr("连接无响应，正在重连…"));
}

/** 一次请求超时可能只是它慢（压缩能跑两分钟），用短探活区分「慢」和「死了」。 */
let probing = false;

async function probeAfterTimeout(): Promise<void> {
  // 轮询与多个请求可能同时超时：只发一次探活，别把刚恢复的链路再压死。
  if (probing) return;
  probing = true;
  try {
    if (await pingHost(PROBE_TIMEOUT_MS)) {
      heartbeatMisses = 0;
      return;
    }
    // 请求超时最常见的原因就是 Bridge 正忙着跑长任务，这时探活也答不上来。
    // 记一次，等心跳累计到两次再判死，不然会把好好的连接掐掉。
    heartbeatMisses += 1;
    if (heartbeatMisses < HEARTBEAT_MISSES) return;
    heartbeatMisses = 0;
    connectionLost(tr("连接无响应，正在重连…"));
  } finally {
    probing = false;
  }
}

/**
 * 「重试」按钮的语义：连接还在就重发请求；连接已经没了就先重建连接 ——
 * 直接重发只会再等一次超时，用户会以为按钮坏了。
 */
function retryAction(retry: () => void): () => void {
  return () => {
    if (active && !active.isDead) {
      retry();
      return;
    }
    const device = connected?.device;
    if (!device) {
      retry();
      return;
    }
    scheduleRetry(device, 1);
  };
}

// 回到前台先探活：手机挂起时 socket 常常已经死了但 close 事件不会来。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopHeartbeat();
    return;
  }
  if (!active) return;
  startHeartbeat();
  void probeAfterTimeout();
});

function showHome(): void {
  stopActive();
  chatResume = null;
  chatResumeKey = null;
  progressDone();
  setReconnecting(null);
  app.replaceChildren(renderHome());
}

function showPairError(message: string): void {
  const box = el("div", { className: "notice error", text: message });
  const retry = button(tr("重新粘贴配对链接"), showHome, "btn secondary");
  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: tr("配对") }),
      el("h1", { className: "display", text: tr("配对失败") }),
      box,
      el("div", { className: "actions" }, [retry]),
    ]),
  );
}

/** RPC 层失败：把桥端给的 `error.code` 带出来，重试与否按 code 判断而不是猜文案。 */
class RpcCallError extends Error {
  constructor(
    readonly code: ErrorCode | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

/** 等等再试有意义：限流、桥端内部错误、这一轮还在跑、适配器刚起来、游标过期。 */
const RETRYABLE_RPC_CODES = new Set<ErrorCode>([
  "rate_limited",
  "internal",
  "conflict",
  "adapter_unavailable",
  "stale_cursor",
]);

/** 中继侧：Bridge 刚起来、通道被占、限流；重新连一次或稍等就能过。 */
const RETRYABLE_RELAY_CODES = new Set(["bridge_offline", "channel_in_use", "rate_limited"]);

/**
 * 值得就地重试的错误：请求超时、通道断开、Bridge 没连上中继、限流这类。
 * 参数错了、找不到、没权限之类重试也没用，不给「重试」按钮。
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof PeerError) return true;
  if (error instanceof RpcCallError) {
    return error.code !== undefined && RETRYABLE_RPC_CODES.has(error.code);
  }
  if (error instanceof RelayError) return RETRYABLE_RELAY_CODES.has(error.code);
  // 浏览器把网络层失败统一报成 TypeError（Failed to fetch）：重发一次可能就成功。
  return error instanceof TypeError;
}

/**
 * 浮在最下层的临时提示。超时这类错误带上「重试」，就地重发，不用刷新整页。
 * 带重试时留得久一点（15 秒），否则 5 秒就收。
 */
function flashNotice(message: string, retry?: () => void): void {
  // 浮条固定定位、彼此完全重叠：新的顶掉旧的，否则两条摞在一起只看得到一条。
  for (const node of document.querySelectorAll(".float-notice")) node.remove();
  const box = el("div", { className: "notice error float-notice", attrs: { role: "status" } }, [
    el("span", { className: "float-notice-text", text: message }),
  ]);
  if (retry) {
    box.classList.add("has-action");
    box.append(
      button(
        tr("重试"),
        () => {
          box.remove();
          retryAction(retry)();
        },
        "btn primary small float-notice-retry",
      ),
    );
  }
  document.body.append(box);
  window.setTimeout(() => box.remove(), retry ? 15_000 : 5_000);
}

/** 操作失败的统一提示：超时/断线的额外给一个「重试」。 */
function noticeFailure(prefix: string, error: unknown, retry: () => void): void {
  flashNotice(`${prefix}：${messageOf(error)}`, isRetryableError(error) ? retry : undefined);
}

/** 聊天页底部的状态行报错：超时就地给「重试」，不用刷新页面。 */
function statusError(state: ChatState, error: unknown, retry: () => void): void {
  const text = messageOf(error);
  state.status.classList.add("error");
  if (!isRetryableError(error)) {
    state.status.textContent = text;
    return;
  }
  state.status.replaceChildren(
    el("span", { text }),
    button(
      tr("重试"),
      retryAction(() => {
        state.retrying = true;
        state.status.classList.remove("error");
        state.status.textContent = tr("正在重试…");
        retry();
      }),
      "btn ghost small status-retry",
    ),
  );
}

function renderHome(): HTMLElement {
  const devices = listDevices();
  const page = el("main", { className: "page narrow" }, [
    el("header", { className: "hero" }, [
      // 还没配对的人也要能切语言，顶栏这时候还没渲染出来。
      el("div", { className: "hero-lang" }, [languageButton()]),
      el("p", { className: "eyebrow", text: "Agent Bridge" }),
      el("h1", { className: "display", text: tr("桌面会话，从这里接管") }),
      el("p", {
        className: "lede",
        text: tr("在浏览器里浏览 Mac 上 Claude Code 与 ChatGPT 的工程与会话，并把任意一段消息转发到另一个客户端。"),
      }),
    ]),
  ]);

  const section = el("section", { className: "panel" });
  const expiring = devices.filter((device) => isExpiringSoon(device.expiresAt));
  if (expiring.length > 0) {
    section.append(
      el("p", {
        className: "notice warn",
        text: tr(`{0}的凭据将在 3 天内过期。到期后会无法连接，请在 Mac 上重新生成配对链接并重新配对。`, expiring.length === 1 ? tr("有一台设备") : tr(`有 {0} 台设备`, expiring.length)),
      }),
    );
  }
  section.append(el("h2", { className: "panel-title", text: tr("已配对设备") }));
  if (devices.length === 0) {
    section.append(
      emptyState(tr("还没有配对设备"), tr("在 Mac 上运行 agent-bridge invite，把生成的配对链接粘贴到下方。")),
    );
  } else {
    const list = el("ul", { className: "device-list" });
    for (const device of devices) list.append(renderDeviceRow(device));
    section.append(list);
  }
  page.append(section);

  const form = el("form", { className: "panel" });
  form.append(el("h2", { className: "panel-title", text: tr("使用配对链接") }));
  form.append(
    el("p", { className: "hint", text: tr("配对秘密只在本机内存中使用，不会发送给中继以外的服务。") }),
  );
  const input = el("input", {
    className: "input",
    attrs: { type: "text", placeholder: tr("粘贴 http…/#/pair?relay=…&room=…&invite=…"), autocomplete: "off", spellcheck: "false" },
  });
  const error = el("p", { className: "notice error hidden" });
  form.append(
    input,
    error,
    el("div", { className: "actions" }, [
      button(tr("开始配对"), () => {
        const link = parsePairingInput(input.value);
        if (!link) {
          error.textContent = tr("无法识别配对链接");
          error.classList.remove("hidden");
          return;
        }
        void beginPairing(link);
      }, "btn primary"),
    ]),
  );
  form.addEventListener("submit", (event) => event.preventDefault());
  page.append(form);

  const auto = devices.length === 1 ? devices[0]! : null;
  if (auto) {
    const status = el("p", { className: "hint", text: tr("正在连接已配对设备…") });
    page.append(status);
    void connectAndShow(auto).catch((error: unknown) => {
      status.textContent = messageOf(error);
    });
  }

  page.append(
    el("p", { className: "hint bookmark-hint" }, [
      el("a", { attrs: { href: location.origin + "/" }, text: location.host }),
      tr(" 可以收藏或添加到主屏幕，下次直接打开，不必再粘贴配对链接。"),
    ]),
  );

  if (justPaired) {
    justPaired = false;
    page.append(
      el("p", { className: "hint bookmark-hint" }, [
        tr("配对完成，"),
        el("a", { attrs: { href: craftsteadLanding(true) }, text: tr("回到 Craftstead 落地页") }),
        tr(" 查看已配对状态。"),
      ]),
    );
  }
  return page;
}

function renderDeviceRow(device: DeviceMeta): HTMLElement {
  const soon = isExpiringSoon(device.expiresAt);
  const status = el("span", { className: soon ? "pill warn" : "pill", text: expireLabel(device.expiresAt) });
  const row = el("li", { className: "device-row" }, [
    el("div", { className: "row-main" }, [
      el("strong", { text: device.bridge?.name ? `${device.bridge.name}` : device.name }),
      el("span", { className: "meta", text: `${device.name} · ${new URL(device.relayUrl).host}` }),
    ]),
    el("div", { className: "row-actions" }, [
      status,
      button(tr("连接"), () => {
        void connectAndShow(device).catch((error: unknown) => {
          status.textContent = messageOf(error);
          status.classList.add("error");
        });
      }, "btn small"),
      button(tr("移除"), () => {
        if (!window.confirm(tr(`移除「{0}」？这台设备的配对凭据会从浏览器里删掉，要连回来得重新配对。`, device.bridge?.name ?? device.name))) {
          return;
        }
        void removeDevice(device.relayUrl, device.roomId).then(() => showHome());
      }, "btn ghost small"),
    ]),
  ]);
  if (soon) {
    row.append(el("p", {
      className: "hint warn",
      text: tr("这台设备的凭据即将过期，到期后就无法连接。请在 Mac 上重新生成配对链接并重新配对。"),
    }));
  }
  return row;
}

async function beginPairing(link: PairingLink): Promise<void> {
  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: tr("配对") }),
      el("h1", { className: "display", text: tr("正在建立加密通道") }),
      el("p", { className: "lede", text: tr("通过中继与 Mac 上的 Bridge 握手，稍候…") }),
    ]),
  );
  let challenge: PairingChallenge;
  try {
    challenge = await startPairing(link);
  } catch (error) {
    showPairError(messageOf(error));
    return;
  }
  showConfirm(challenge);
}

function showConfirm(challenge: PairingChallenge): void {
  const remembered = rememberedDeviceName();
  const initial = remembered || defaultDeviceName();
  const nameInput = el("input", {
    className: "input",
    attrs: { type: "text", value: initial, maxlength: "64" },
  });
  // UA-CH 的高熵值要异步取，拿到更具体的机型／系统版本后再补；用户已经动过输入框就不覆盖。
  if (!remembered) {
    void suggestedDeviceName().then((suggested) => {
      if (nameInput.value === initial) nameInput.value = suggested;
    });
  }
  const error = el("p", { className: "notice error hidden" });
  const confirm = button(tr("确认码一致，完成配对"), () => {
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = tr("请输入设备名称");
      error.classList.remove("hidden");
      return;
    }
    confirm.disabled = true;
    void (async () => {
      // 私钥要落盘，必须先有加密口令；用户在对话框里取消就当作放弃配对。
      await ensureVault();
      await finishPairing(challenge, name);
    })()
      .then(() => {
        rememberDeviceName(name);
        justPaired = true;
        showHome();
      })
      .catch((failure: unknown) => {
        confirm.disabled = false;
        error.textContent = messageOf(failure);
        error.classList.remove("hidden");
      });
  }, "btn primary");
  const cancel = button(tr("取消"), () => {
    challenge.connection.close();
    showHome();
  }, "btn secondary");

  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: tr("配对") }),
      el("h1", { className: "display", text: tr("核对确认码") }),
      el("p", { className: "lede", text: tr("Mac 上 Bridge 的终端应显示同一确认码。不一致说明通道被篡改，请取消。") }),
      el("div", { className: "code", text: challenge.confirmCode }),
      el("p", { className: "hint", text: relayTargetText(challenge.link.relayUrl) }),
      el("label", { className: "field" }, [el("span", { text: tr("设备名称") }), nameInput]),
      el("p", { className: "hint", text: tr("浏览器拿不到电脑名称，默认值只能取设备类型、系统版本和浏览器；改成你认得出的名字，Mac 菜单栏和其它设备都会按它显示，之后也能随时改。") }),
      error,
      el("div", { className: "actions" }, [confirm, cancel]),
    ]),
  );
}

/**
 * 配对链接把人连到哪个中继，必须在确认码旁边说清楚：确认码只能证明信道一致，
 * 看不出中继是不是用户以为的那个站点。
 */
function relayTargetText(relayUrl: string): string {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return tr(`中继：{0}，注意：不是你当前所在的站点`, relayUrl);
  }
  if (url.origin === location.origin) return tr(`中继：{0}（本站）`, url.host);
  return tr(`中继：{0}，注意：不是你当前所在的站点`, url.host);
}

const DEVICE_NAME_KEY = "ab.deviceName";

/** 上一次给这台浏览器起的名字，下次配对时直接沿用。 */
function rememberedDeviceName(): string {
  try {
    return (localStorage.getItem(DEVICE_NAME_KEY) ?? "").trim().slice(0, 64);
  } catch {
    return "";
  }
}

function rememberDeviceName(name: string): void {
  try {
    localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    // 隐私模式下写不了本地存储，只影响下次的默认值。
  }
}

interface NameParts {
  kind: string;
  os: string;
  browser: string;
}

/**
 * 浏览器读不到电脑名称和主机名（隐私限制），能拿到的只有设备类型、系统版本和浏览器。
 * Android / ChromeOS 的 UA-CH 高熵值还能给出具体机型，桌面端和 Safari 没有。
 */
function nameParts(): NameParts {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  let kind = tr("浏览器");
  if (/iPhone/.test(ua)) kind = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) kind = "iPad";
  else if (/Android/.test(ua)) kind = tr("Android 设备");
  else if (/Macintosh|Mac OS X/.test(ua)) kind = "Mac";
  else if (/Windows/.test(ua)) kind = "Windows";
  else if (/Linux/.test(ua)) kind = "Linux";

  let os = "";
  const ios = /(?:iPhone|CPU) OS (\d+)[._](\d+)/.exec(ua);
  const android = /Android (\d+)/.exec(ua);
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (ios) os = `iOS ${ios[1]}.${ios[2]}`;
  else if (android) os = `Android ${android[1]}`;
  else if (kind === "Mac" && mac) os = `macOS ${mac[1]}.${mac[2]}`;
  return { kind, os, browser: browserLabel() };
}

function composeDeviceName(parts: NameParts): string {
  return [parts.kind, parts.os, parts.browser].filter(Boolean).join(" · ").slice(0, 64);
}

function defaultDeviceName(): string {
  return composeDeviceName(nameParts());
}

interface UaHints {
  model: string;
  platform: string;
  platformVersion: string;
}

async function highEntropyHints(): Promise<UaHints | null> {
  const data = (navigator as unknown as {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>> };
  }).userAgentData;
  if (!data?.getHighEntropyValues) return null;
  try {
    const values = await data.getHighEntropyValues(["model", "platform", "platformVersion"]);
    const text = (key: string): string => (typeof values[key] === "string" ? (values[key] as string).trim() : "");
    return { model: text("model"), platform: text("platform"), platformVersion: text("platformVersion") };
  } catch {
    return null;
  }
}

/** UA-CH 报的是 Windows 的平台版本号：13 起是 Windows 11，之前是 Windows 10。 */
function osLabel(platform: string, version: string): string {
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) return "";
  const minor = version.split(".")[1];
  const withMinor = minor && minor !== "0" ? `.${minor}` : "";
  if (platform === "macOS") return `macOS ${major}${withMinor}`;
  if (platform === "iOS") return `iOS ${major}${withMinor}`;
  if (platform === "Android") return `Android ${major}`;
  if (platform === "Windows") return major >= 13 ? "Windows 11" : "Windows 10";
  if (platform === "Chrome OS") return `ChromeOS ${major}`;
  return "";
}

/** UA-CH 是异步的，能拿到具体机型和系统版本时用它盖掉 UA 里的粗粒度信息。 */
async function suggestedDeviceName(): Promise<string> {
  const parts = nameParts();
  const hints = await highEntropyHints();
  if (!hints) return composeDeviceName(parts);
  if (hints.model) parts.kind = hints.model;
  const os = osLabel(hints.platform, hints.platformVersion);
  if (os) parts.os = os;
  return composeDeviceName(parts);
}

/** Chromium 的 UA 里 Chrome/Safari 互相嵌套，顺序不能换。 */
function browserLabel(): string {
  const ua = navigator.userAgent;
  const rules: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Version\/(\d+)[\d.]* Safari\//, "Safari"],
  ];
  for (const [pattern, name] of rules) {
    const match = ua.match(pattern);
    if (match?.[1]) return `${name} ${match[1]}`;
  }
  return "";
}

/**
 * Secrets live encrypted on disk; the password is asked once and the derived key is
 * dropped after 30 minutes without use, so an idle tab cannot reconnect on its own.
 */
async function ensureSecrets(device: DeviceMeta): Promise<DeviceSecrets> {
  if (!hasVault()) {
    // 还没有口令：先把老版本的明文迁移进加密存储；没有可迁移的凭据就只能重新配对。
    if (!getDeviceSecrets(device)) throw new Error(tr("本地没有这台设备的凭据，需要重新配对"));
    await ensureVault();
  } else if (needsUnlock()) {
    await ensureVault();
  }
  const found = getDeviceSecrets(device);
  if (!found) throw new Error(tr("本地没有这台设备的凭据，需要重新配对"));
  return found;
}

/** Pairing stores a private key, so a password must exist and be unlocked before saving. */
async function ensureVault(): Promise<void> {
  if (!hasVault()) {
    const created = await passwordDialog({
      title: tr("设置凭据密码"),
      hint: tr("设备私钥会用这个密码加密后保存在本机，密码不会离开浏览器。忘记密码只能重新配对。"),
      confirm: true,
      submit: async (password) => {
        try {
          await setupPassword(password);
        } catch (error) {
          // 另一个标签页刚好先设好了口令：不覆盖它，回到解锁流程。
          if (!(error instanceof LockedError && hasVault())) throw error;
        }
      },
    });
    if (created === null) throw new LockedError(tr("未设置密码，操作已取消"));
    // 另一个标签页抢先设好了口令：接着走解锁流程，而不是覆盖那份存储。
    if (needsUnlock()) return ensureVault();
    return;
  }
  if (!needsUnlock()) return;
  const password = await passwordDialog({
    title: tr("解锁设备凭据"),
    hint: tr("设备私钥已加密保存在本机。输入密码后 30 分钟内不需要再次输入。"),
    submit: unlock,
    // 密码不可找回，唯一出路是清空本机凭据后重新配对，所以给一个显式出口。
    forgot: async () => {
      if (!window.confirm(tr("清除本机保存的所有设备凭据？之后需要重新配对。"))) return false;
      await resetCredentials();
      return true;
    },
  });
  if (password === null) throw new LockedError();
}

function passwordDialog(options: {
  title: string;
  hint: string;
  confirm?: boolean;
  submit: (password: string) => Promise<void>;
  /** Resolves true once the credentials are gone and the dialog should close. */
  forgot?: () => Promise<boolean>;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el("input", {
      className: "input",
      attrs: {
        type: "password",
        autocomplete: options.confirm ? "new-password" : "current-password",
        placeholder: tr("密码"),
      },
    }) as HTMLInputElement;
    const again = el("input", {
      className: "input",
      attrs: { type: "password", autocomplete: "new-password", placeholder: tr("再输入一次") },
    }) as HTMLInputElement;
    const error = el("p", { className: "notice error hidden" });
    const mask = el("div", { className: "sheet-mask" });
    let busy = false;

    const finish = (value: string | null): void => {
      document.removeEventListener("keydown", onKey);
      mask.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(null);
    };
    const submit = button(tr("继续"), () => {
      void run();
    }, "btn primary");
    const cancel = button(tr("取消"), () => finish(null), "btn secondary");
    const fail = (message: string): void => {
      error.textContent = message;
      error.classList.remove("hidden");
      busy = false;
      submit.disabled = false;
    };
    const run = async (): Promise<void> => {
      if (busy) return;
      const value = input.value;
      if (value.length < 8) return fail(tr("密码至少 8 位"));
      if (options.confirm && again.value !== value) return fail(tr("两次输入的密码不一致"));
      busy = true;
      submit.disabled = true;
      try {
        await options.submit(value);
        finish(value);
      } catch (failure) {
        fail(messageOf(failure));
      }
    };
    for (const field of options.confirm ? [input, again] : [input]) {
      trackIme(field);
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !isImeEnter(event)) void run();
      });
    }
    document.addEventListener("keydown", onKey);
    mask.addEventListener("click", (event) => {
      if (event.target === mask) finish(null);
    });

    const fields = [el("label", { className: "field" }, [el("span", { text: tr("密码") }), input])];
    if (options.confirm) {
      fields.push(el("label", { className: "field" }, [el("span", { text: tr("确认密码") }), again]));
    }
    const leading = el("div", {});
    const forgot = options.forgot;
    if (forgot) {
      leading.append(
        button(tr("忘记密码"), () => {
          if (busy) return;
          busy = true;
          void (async () => {
            try {
              if (await forgot()) finish(null);
            } finally {
              busy = false;
            }
          })();
        }, "btn ghost"),
      );
    }
    mask.append(
      el("aside", { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": options.title } }, [
        el("header", { className: "sheet-head" }, [
          el("h2", { className: "sheet-title", text: options.title }),
        ]),
        el("p", { className: "sheet-source", text: options.hint }),
        ...fields,
        error,
        el("footer", { className: "sheet-foot" }, [
          leading,
          el("div", { className: "actions" }, [cancel, submit]),
        ]),
      ]),
    );
    document.body.append(mask);
    input.focus();
  });
}

/** 列表行上的小操作按钮（置顶、归档、删除）。 */
function rowAction(content: HTMLElement, label: string, onClick: () => void, extra = ""): HTMLButtonElement {
  const node = button("", onClick, `row-action ${extra}`.trim());
  node.append(content);
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

/** 列表排序口径：置顶的在前，其余按更新时间；两段内部都是新的在前。 */
function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** 已归档的会话默认不出现，除非列表页打开了「显示已归档」。 */
function visibleSessions(sessions: SessionSummary[], includeArchived = false): SessionSummary[] {
  return sortSessions(includeArchived ? sessions : sessions.filter((item) => !item.archived));
}

/** 会话状态变了就地更新快照，不用重拉整份列表。 */
function patchSession(session: SessionSummary): void {
  if (!snapshot) return;
  snapshot = {
    ...snapshot,
    sessions: snapshot.sessions.map((item) => (item.sessionId === session.sessionId ? session : item)),
  };
}

function dropSession(sessionId: string): void {
  if (!snapshot) return;
  snapshot = { ...snapshot, sessions: snapshot.sessions.filter((item) => item.sessionId !== sessionId) };
}

async function setSessionPinned(session: SessionSummary, pinned: boolean): Promise<void> {
  try {
    const result = await call<SessionGetResult>("session.pin", { sessionId: session.sessionId, pinned });
    patchSession(result.session);
    await renderRoute();
    flashNotice(pinned ? tr("已置顶，排在列表最前面") : tr("已取消置顶"));
  } catch (error) {
    flashNotice(tr(`置顶失败：{0}`, messageOf(error)));
  }
}

async function setSessionArchived(session: SessionSummary, archived: boolean): Promise<void> {
  try {
    const result = await call<SessionGetResult>("hosted.archive", {
      sessionId: session.sessionId,
      archived,
    });
    patchSession(result.session);
    const route = parseRoute();
    if (archived && route.level === "chat" && route.sessionId === session.sessionId) {
      navigate({ level: "sessions", appId: session.appId, projectId: session.projectId });
      flashNotice(tr("已归档，可在「显示已归档」里找回"));
      return;
    }
    await renderRoute();
    flashNotice(archived ? tr("已归档，可在「显示已归档」里找回") : tr("已取消归档"));
  } catch (error) {
    flashNotice(tr(`归档失败：{0}`, messageOf(error)));
  }
}

async function deleteHostedSession(session: SessionSummary): Promise<void> {
  if (!window.confirm(tr(`删除「{0}」？进程会停掉，Bridge 这边的聊天记录也会删掉，无法恢复。`, session.title))) return;
  try {
    await call("hosted.delete", { sessionId: session.sessionId });
    dropSession(session.sessionId);
    const route = parseRoute();
    if (route.level === "chat" && route.sessionId === session.sessionId) {
      navigate({ level: "sessions", appId: session.appId, projectId: session.projectId });
      flashNotice(tr("已删除"));
      return;
    }
    await renderRoute();
    flashNotice(tr("已删除"));
  } catch (error) {
    flashNotice(tr(`删除失败：{0}`, messageOf(error)));
  }
}

/**
 * 重命名会话：Bridge 托管的会话直接改标题，其它来源只保存 Bridge 侧覆盖名，
 * 因此弹层会同时展示源应用里的原名。
 */
function renameSessionSheet(summary: SessionSummary, onSaved: (session: SessionSummary) => void): void {
  const input = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: "60", placeholder: tr("会话名称") },
  }) as HTMLInputElement;
  input.value = summary.title;
  const error = el("p", { className: "notice error hidden" });
  const mask = el("div", { className: "sheet-mask" });
  let busy = false;

  const finish = (): void => {
    document.removeEventListener("keydown", onKey);
    mask.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") finish();
  };
  const fail = (message: string): void => {
    error.textContent = message;
    error.classList.remove("hidden");
    busy = false;
    save.disabled = false;
  };
  const submit = async (title: string | null): Promise<void> => {
    if (busy) return;
    busy = true;
    save.disabled = true;
    try {
      const result = await call<SessionRenameResult>("session.rename", {
        sessionId: summary.sessionId,
        title,
      });
      finish();
      onSaved(result.session);
    } catch (failure) {
      fail(messageOf(failure));
    }
  };
  const save = button(tr("保存"), () => {
    void submit(input.value.trim() || null);
  }, "btn primary");
  const reset = summary.originalTitle
    ? button(tr("恢复原名"), () => {
        void submit(null);
      }, "btn ghost")
    : null;
  const cancel = button(tr("取消"), finish, "btn secondary");

  trackIme(input);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !isImeEnter(event)) void submit(input.value.trim() || null);
  });
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) finish();
  });

  mask.append(
    el(
      "aside",
      { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": tr("重命名会话") } },
      [
        el("header", { className: "sheet-head" }, [el("h2", { className: "sheet-title", text: tr("重命名会话") })]),
        el("label", { className: "field" }, [el("span", { text: tr("显示名称") }), input]),
        ...(summary.originalTitle
          ? [el("p", { className: "sheet-note", text: tr(`原名：{0}`, summary.originalTitle) })]
          : []),
        error,
        el("footer", { className: "sheet-foot" }, [
          ...(reset ? [el("div", {}, [reset])] : []),
          el("div", { className: "actions" }, [cancel, save]),
        ]),
      ],
    ),
  );
  document.body.append(mask);
  input.focus();
  input.select();
}

function showLocked(device: DeviceMeta): void {
  // 锁屏会替换掉聊天 DOM，旧的恢复闭包和连接状态必须一起丢掉，
  // 否则解锁后会被当成软重连，去恢复已经不存在的界面。
  stopActive();
  chatResume = null;
  chatResumeKey = null;
  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: tr("凭据已锁定") }),
      el("h1", { className: "display", text: tr("需要解锁") }),
      el("p", {
        className: "lede",
        text: tr("设备私钥已加密保存在本机，超过 30 分钟没有使用就需要重新输入密码。"),
      }),
      el("div", { className: "actions" }, [
        button(tr("输入密码"), () => {
          void connectAndShow(device);
        }, "btn primary"),
        button(tr("返回"), () => showHome(), "btn secondary"),
      ]),
    ]),
  );
}

async function connectAndShow(device: DeviceMeta, attempt = 0): Promise<void> {
  const gen = generation;
  const soft = connected !== null;
  if (soft) {
    progressStart();
    setReconnecting(attempt <= 1 ? tr("连接已断开，正在重连…") : tr(`第 {0} 次重连中…`, attempt));
  } else {
    app.replaceChildren(
      el("main", { className: "page narrow" }, [
        el("p", { className: "eyebrow", text: tr("连接") }),
        el("h1", { className: "display", text: attempt === 0 ? tr("正在连接") : tr("正在重连") }),
        el("p", { className: "lede", text: tr("正在与 Mac 建立加密通道…") }),
      ]),
    );
  }
  let opened: { client: PeerClient; connection: RelayConnection };
  try {
    opened = await connectDevice({ ...device, ...(await ensureSecrets(device)) });
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof LockedError) {
      progressDone();
      // 用户可能在解锁框里清空了本机凭据，这时设备已经不存在，回首页重新配对。
      if (!hasVault() && listDevices().length === 0) showHome();
      else showLocked(device);
      return;
    }
    if (attempt >= 5) {
      progressDone();
      setReconnecting(tr("重连失败，30 秒后继续重试…"));
      throw error;
    }
    scheduleRetry(device, attempt + 1, messageOf(error));
    return;
  }
  if (gen !== generation) {
    opened.client.stop();
    return;
  }
  stopActive();
  active = opened.client;
  opened.client.onEvent((message) => {
    if (message.event === "shell.output") handleShellEvent(message.data as ShellEventData);
  });
  // 读循环自己判死时走这条：socket 可能还开着，`closed()` 永远不会 resolve。
  opened.client.onDead(() => {
    if (gen + 1 !== generation || active !== opened.client) return;
    connectionLost(tr("连接已断开，正在重连…"));
  });
  let infoResponse: Awaited<ReturnType<typeof opened.client.request>>;
  let devicesResponse: Awaited<ReturnType<typeof opened.client.request>>;
  try {
    infoResponse = await opened.client.request("host.info");
    devicesResponse = await opened.client.request("device.list");
  } catch (error) {
    // 握手成功了但通道马上又断：这里不能把 active 留在半初始化状态，
    // 否则页面停在「正在连接」，之后也没有任何代码会去重连它。
    opened.client.stop();
    active = null;
    throw error;
  }
  if (!infoResponse.ok || !devicesResponse.ok) {
    opened.client.stop();
    active = null;
    throw new Error(infoResponse.error?.message ?? devicesResponse.error?.message ?? tr("读取主机信息失败"));
  }
  connected = {
    device,
    info: infoResponse.result as HostInfoResult,
    devices: (devicesResponse.result as { devices: DeviceSummary[] }).devices,
  };
  snapshot = null;
  if (!soft && !location.hash.startsWith("#/clients") && !location.hash.startsWith("#/devices")) {
    history.replaceState(null, "", `${location.pathname}${location.search}#/clients`);
  }
  await renderRoute(soft);
  startSessionWatch();
  startHeartbeat();
  progressDone();
  setReconnecting(null);
  void opened.connection.closed().then((info) => {
    if (gen + 1 !== generation || active !== opened.client) return;
    if (info.code === 4003) {
      stopPolling();
      stopHeartbeat();
      active = null;
      showHome();
      return;
    }
    connectionLost(tr("连接已断开，正在重连…"));
  });
}

function scheduleRetry(device: DeviceMeta, attempt: number, message?: string): void {
  const gen = generation;
  const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  if (connected) {
    setReconnecting(message ?? tr(`连接已断开，{0} 秒后重连…`, Math.round(delay / 1000)));
  } else {
    progressDone();
    app.replaceChildren(
      el("main", { className: "page narrow" }, [
        el("p", { className: "eyebrow", text: tr("连接") }),
        el("h1", { className: "display", text: tr("连接已断开") }),
        el("p", { className: "lede", text: message ?? tr(`加密通道中断，{0} 秒后重连…`, Math.round(delay / 1000)) }),
      ]),
    );
  }
  // 旧的定时器必须清掉：不清的话两条重试链会同时存在，各自建一条 socket。
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (gen !== generation) return;
    void connectAndShow(device, attempt).catch((error: unknown) => {
      if (gen !== generation) return;
      scheduleRetry(device, Math.min(attempt + 1, 5), messageOf(error));
    });
  }, delay);
}

async function call<T>(method: Method, params?: unknown, timeoutMs = 20_000): Promise<T> {
  const client = active;
  if (!client || client.isDead) throw new PeerError("closed", tr("连接已断开"));
  let response: Awaited<ReturnType<PeerClient["request"]>>;
  try {
    response = await client.request(method, params, timeoutMs);
  } catch (error) {
    // 超时后先短探活判死：连接真死了就要停下来重连，
    // 否则「重试」会继续往死通道发帧，Bridge 那边还会真的重复执行一次。
    if (error instanceof PeerError && error.code === "timeout") void probeAfterTimeout();
    throw error;
  }
  if (!response.ok) {
    throw new RpcCallError(response.error?.code, response.error?.message ?? tr(`{0} 失败`, method));
  }
  return response.result as T;
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error(tr("读取文件失败")));
    reader.readAsDataURL(blob);
  });
}

async function uploadAttachment(
  sessionId: string,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<MessageAttachment> {
  const begin = await call<FileUploadBeginResult>(
    "file.upload.begin",
    { sessionId, name: file.name, mime: file.type || "application/octet-stream", size: file.size },
    30_000,
  );
  const chunkSize = Math.max(1, begin.chunkSize);
  let index = 0;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const data = await blobBase64(slice);
    await call<FileUploadChunkResult>(
      "file.upload.chunk",
      { uploadId: begin.uploadId, index, data },
      60_000,
    );
    index += 1;
    onProgress(Math.min(1, (offset + slice.size) / file.size));
  }
  const done = await call<FileUploadFinishResult>("file.upload.finish", { uploadId: begin.uploadId }, 30_000);
  onProgress(1);
  return { name: done.name, mime: done.mime, size: done.size, path: done.path, kind: done.kind };
}

const COMPOSER_DRAFTS_KEY = "ab.drafts";

function readDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function draftFor(sessionId: string): string {
  return readDrafts()[sessionId] ?? "";
}

function saveDraft(sessionId: string, text: string): void {
  const drafts = readDrafts();
  if (text) drafts[sessionId] = text;
  else delete drafts[sessionId];
  try {
    localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // storage unavailable; the draft still lives in the textarea
  }
}

const COMPOSER_COLLAPSED_KEY = "ab.composerCollapsed";

function readComposerCollapsed(): boolean {
  try {
    return localStorage.getItem(COMPOSER_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeComposerCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COMPOSER_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable; collapse state stays in memory
  }
}

async function ensureSnapshot(force = false): Promise<Snapshot> {  if (snapshot && !force) return snapshot;
  const apps = await call<AppListResult>("app.list");
  // 按客户端分别取会话：共用一个 500 条上限时，会话多的客户端会把另一个客户端的
  // 工程挤掉，表现为「新建的会话刷新不出来」。
  // 标签是 0.11.5 才有的 RPC。老 Bridge 不认识的方法帧在协议层就被丢掉、不会回错误，
  // 只能按版本判定；版本还没拿到时试一次，但把超时压短，别让首屏白等 20 秒。
  const hostVersion = connected?.info.version;
  tagsSupported = hostVersion === undefined || atLeastVersion(hostVersion, [0, 11, 5]);
  const [projects, tagList, ...sessionPages] = await Promise.all([
    call<ProjectListResult>("project.list"),
    tagsSupported
      ? call<TagListResult>("tag.list", undefined, 3_000).catch(() => ({ tags: [] }))
      : Promise.resolve<TagListResult>({ tags: [] }),
    ...apps.apps.map((app) =>
      call<SessionListResult>("session.list", { appId: app.appId, includeArchived: true, limit: 500 }),
    ),
  ]);
  const notes = sessionPages.flatMap((page) => (page.note ? [page.note] : []));
  snapshot = {
    apps: apps.apps,
    projects: projects.projects,
    sessions: sessionPages.flatMap((page) => page.sessions),
    tags: tagList.tags,
    ...(notes.length > 0 ? { note: notes.join("；") } : {}),
  };
  observeSessions(snapshot.sessions);
  return snapshot;
}

interface Crumb {
  label: string;
  href?: string;
}

function crumbsFor(route: Route): Crumb[] {
  const data = snapshot;
  const crumbs: Crumb[] = [{ label: tr("客户端"), href: hashFor({ level: "clients" }) }];
  if (route.level === "devices") return [{ label: tr("已授权设备") }];
  if (route.level === "clients") return [];
  const app = data?.apps.find((item) => item.appId === route.appId);
  crumbs.push(
    route.level === "projects"
      ? { label: app?.name ? serverTr(app.name) : tr("客户端") }
      : { label: app?.name ? serverTr(app.name) : tr("客户端"), href: hashFor({ level: "projects", appId: route.appId }) },
  );
  if (route.level === "sessions" || route.level === "chat") {
    const project = data?.projects.find((item) => item.projectId === route.projectId);
    crumbs.push(
      route.level === "sessions"
        ? { label: project?.name ?? tr("工程") }
        : { label: project?.name ?? tr("工程"), href: hashFor({ level: "sessions", appId: route.appId, projectId: route.projectId }) },
    );
  }
  if (route.level === "chat") {
    const session = data?.sessions.find((item) => item.sessionId === route.sessionId);
    crumbs.push(
      route.taskId
        ? { label: session?.title ?? tr("会话"), href: hashFor({ level: "chat", appId: route.appId, projectId: route.projectId, sessionId: route.sessionId }) }
        : { label: session?.title ?? tr("会话") },
    );
    if (route.taskId) crumbs.push({ label: tr("后台任务") });
  }
  return crumbs;
}

function renderShell(content: HTMLElement, crumbs: Crumb[]): void {
  // 整页重绘会把 dock 里的待办输入框整个换掉：先记下焦点与光标，画完再放回去。
  const focus = captureDockFocus();
  app.replaceChildren(
    renderTopbar(crumbs),
    el("div", { className: "shell" }, [
      dockSidebar(parseRoute()),
      ...(dockOpen ? [dockScrim()] : []),
      el("div", { className: "shell-main" }, [content]),
    ]),
  );
  document.body.classList.toggle("dock-open", dockOpen);
  restoreDockFocus(focus);
}

/**
 * dock 里正在编辑的输入框（新增待办 / 就地编辑 / 历史搜索）：整页重建后要还原焦点，
 * 否则打字被打断。列表页每 5 秒就可能因为某个会话换了状态整页重绘，搜索框是最容易撞上的。
 */
interface DockFocus {
  target: "new" | "edit" | "search";
  value: string;
  start: number | null;
  end: number | null;
}

function captureDockFocus(): DockFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  const target = active.classList.contains("todo-input")
    ? "new"
    : active.classList.contains("todo-edit-input")
      ? "edit"
      : active.classList.contains("dock-search-input")
        ? "search"
        : null;
  if (!target) return null;
  return { target, value: active.value, start: active.selectionStart, end: active.selectionEnd };
}

function restoreDockFocus(saved: DockFocus | null): void {
  if (!saved) return;
  const selector =
    saved.target === "new"
      ? ".dock-todos .todo-input"
      : saved.target === "edit"
        ? ".dock-todos .todo-edit-input"
        : ".dock-search-input";
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input || input.disabled) return;
  input.value = saved.value;
  if (saved.target === "new") todoDraft.title = saved.value;
  else if (saved.target === "edit") todoEditDraft.title = saved.value;
  // 搜索框的值由 dockSearchQuery 保存，重画时会回填；这里只负责把焦点和光标放回去。
  // preventScroll：重绘发生在输入框上方时别把页面拉过去。
  input.focus({ preventScroll: true });
  if (saved.start !== null && saved.end !== null) input.setSelectionRange(saved.start, saved.end);
}

const DOCK_TAB_KEY = "ab.dockTab";
const DOCK_SESSIONS_PER_PROJECT = 8;
const DOCK_HISTORY_LIMIT = 30;
type DockTab = "tree" | "history" | "todo";

function readDockTab(): DockTab {
  try {
    const value = localStorage.getItem(DOCK_TAB_KEY);
    return value === "history" || value === "todo" ? value : "tree";
  } catch {
    return "tree";
  }
}

function writeDockTab(tab: DockTab): void {
  try {
    localStorage.setItem(DOCK_TAB_KEY, tab);
  } catch {
    // storage unavailable; the chosen tab just won't be remembered
  }
}

function agentLabel(kind: string, hostedAgent?: HostedAgent): string {
  if (kind === "codex" || kind === "codex-cli" || kind === "codex-thread") return "ChatGPT";
  if (kind === "antigravity" || kind === "antigravity-desktop") return "Antigravity";
  if (kind === "dsh") return "DeepSeek";
  if (kind === "pi") return "pi";
  if (kind === "hosted") {
    // 托管会话的 kind 只说明「由 Bridge 托管」，具体引擎藏在 hostedAgent 里。
    if (hostedAgent === "pi") return tr("pi 托管");
    if (hostedAgent === "claude") return tr("Claude 托管");
    return tr("托管");
  }
  return "Claude";
}

/** 当前路由落在 dock 的哪一层，用来展开并高亮对应条目。 */
function dockActive(route: Route): { appId?: string; projectId?: string; sessionId?: string } {
  if (route.level === "clients" || route.level === "devices") return {};
  return {
    appId: route.appId,
    ...("projectId" in route ? { projectId: route.projectId } : {}),
    ...(route.level === "chat" ? { sessionId: route.sessionId } : {}),
  };
}

/**
 * 侧栏行上的状态：正在跑、等用户回答、有你没看过的新回复，
 * 与会话列表页的口径保持一致，免得左栏看起来「都一样」。
 */
function dockStatePills(session: SessionSummary): HTMLElement[] {
  const pills: HTMLElement[] = [];
  if (session.busy) {
    pills.push(
      el("span", { className: "pill tiny busy" }, [el("span", { className: "spinner" }), document.createTextNode(tr("运行中"))]),
    );
    // 忙着一轮但很久没有输出：多半是子进程挂在系统授权弹窗上，界面必须说出来，
    // 否则用户看到的就是「在跑」却永远不动。
    if (session.stalledSince) pills.push(el("span", { className: "pill tiny warn", text: tr("疑似卡住") }));
  } else if (session.needsDecision) {
    pills.push(el("span", { className: "pill tiny warn", text: tr("待回答") }));
  }
  if (unreadAt(session.sessionId) !== undefined) {
    pills.push(el("span", { className: "pill tiny unread", text: tr("未读") }));
  }
  return pills;
}

/** 侧栏条目上会随快照变化的那几位：运行中 / 有进程 / 未读 / 待回答。 */
function dockStateKey(session: SessionSummary): string {
  return [
    session.busy ? 1 : 0,
    session.live ? 1 : 0,
    unreadAt(session.sessionId) !== undefined ? 1 : 0,
    session.needsDecision ? 1 : 0,
    session.stalledSince ? 1 : 0,
    // 历史行右侧写着「· 3 分钟前」：只看状态会让这串时间停在上次整页重绘那一刻。
    Math.floor(session.updatedAt / 60_000),
  ].join(":");
}

/**
 * 聊天页不重建整页，但侧栏那份会话状态不能一直停在上次进来时的样子：只把状态变了的
 * 条目换成新按钮，历史搜索的输入框、列表滚动位置都不动。
 */
function syncDockSessions(): void {
  if (!snapshot) return;
  const byId = new Map(snapshot.sessions.map((item) => [item.sessionId, item]));
  const current = dockActive(parseRoute()).sessionId;
  for (const node of [...document.querySelectorAll<HTMLElement>(".dock-session, .dock-history-row")]) {
    const sessionId = node.dataset.sessionId;
    const session = sessionId ? byId.get(sessionId) : undefined;
    if (!session) continue;
    const state = dockStateKey(session);
    if (node.dataset.state === state) continue;
    if (node.classList.contains("dock-history-row")) {
      // 历史行的标题与滚动位置要留着（可能正在搜索），只换右边那组状态。
      const facts = node.querySelector(".dock-history-facts");
      if (!facts) continue;
      facts.replaceChildren(
        el("span", {
          className: "dock-history-meta",
          text: `${agentLabel(session.kind, session.hostedAgent)} · ${recentTime(session.updatedAt)}`,
        }),
        ...dockStatePills(session),
      );
      node.dataset.state = state;
      node.classList.toggle("is-active", current === session.sessionId);
      continue;
    }
    const focused = document.activeElement === node;
    const next = dockSessionButton(session, node.classList.contains("is-active"));
    node.replaceWith(next);
    if (focused) next.focus();
  }
}

function dockSessionButton(session: SessionSummary, active: boolean): HTMLButtonElement {
  const pills = dockStatePills(session);
  const dots = tagDots(session.tags);
  const node = el("button", { className: `dock-session${active ? " is-active" : ""}`, attrs: { type: "button" } }, [
    el("span", {
      className: `mark ${session.busy ? "busy" : session.live ? "live" : ""}`,
      text: agentMark(session.kind, session.hostedAgent),
    }),
    el("span", { className: "dock-session-title", text: session.title }),
    ...(dots ? [dots] : []),
    ...(pills.length > 0 ? [el("span", { className: "dock-session-pills" }, pills)] : []),
  ]);
  node.title = session.title;
  node.dataset.sessionId = session.sessionId;
  node.dataset.state = dockStateKey(session);
  if (active) node.setAttribute("aria-current", "page");
  node.addEventListener("click", () => {
    navigate({
      level: "chat",
      appId: session.appId,
      projectId: session.projectId,
      sessionId: session.sessionId,
    });
  });
  return node;
}

/** 第一个 tab：agent → project → session 的树，当前路径默认展开。 */
function dockTree(route: Route): HTMLElement {
  const wrap = el("div", { className: "dock-list" });
  const data = snapshot;
  if (!data) {
    wrap.append(el("p", { className: "hint", text: tr("正在读取会话…") }));
    return wrap;
  }
  const active = dockActive(route);
  let rendered = 0;
  for (const appInfo of data.apps) {
    const projects = data.projects.filter((item) => item.appId === appInfo.appId);
    const sessionsOf = (projectId: string): SessionSummary[] =>
      visibleSessions(data.sessions.filter((item) => item.projectId === projectId));
    const rows = projects.map((project) => ({ project, sessions: sessionsOf(project.projectId) }));
    const visible = rows.filter((row) => row.sessions.length > 0);
    if (visible.length === 0) continue;
    const total = visible.reduce((sum, row) => sum + row.project.sessionCount, 0);

    const appNode = el("details", { className: "dock-app" });
    appNode.open = rendered === 0 || active.appId === appInfo.appId;
    appNode.append(
      el("summary", { className: "dock-app-head" }, [
        el("span", { className: "dock-app-name", text: shortAgentName(appInfo) }),
        el("span", { className: "dock-count", text: String(total) }),
      ]),
    );
    for (const { project, sessions } of visible) {
      const projectNode = el("details", { className: "dock-project" });
      projectNode.open = active.projectId === project.projectId;
      const head = el("summary", { className: "dock-project-head" }, [
        el("span", { className: "dock-project-name", text: project.name }),
        el("span", { className: "dock-count", text: String(project.sessionCount) }),
      ]);
      if (active.projectId === project.projectId) head.classList.add("is-active");
      projectNode.append(head);
      for (const session of sessions.slice(0, DOCK_SESSIONS_PER_PROJECT)) {
        projectNode.append(dockSessionButton(session, active.sessionId === session.sessionId));
      }
      const rest = sessions.length - DOCK_SESSIONS_PER_PROJECT;
      if (rest > 0) {
        projectNode.append(
          button(tr(`还有 {0} 条…`, rest), () => {
            navigate({ level: "sessions", appId: project.appId, projectId: project.projectId });
          }, "dock-more"),
        );
      }
      appNode.append(projectNode);
    }
    wrap.append(appNode);
    rendered += 1;
  }
  if (rendered === 0) wrap.append(el("p", { className: "hint", text: tr("还没有会话。") }));
  return wrap;
}

/** 第二个 tab：所有会话按最近更新排序。 */
/**
 * 历史面板：搜索框常驻（重建列表时不能把它一起换掉，否则每敲一个字都丢焦点），
 * 默认按标题过滤；勾了「搜内容」才去问 Bridge 要全文命中。
 */
const DOCK_SEARCH_DEBOUNCE_MS = 350;
const DOCK_SEARCH_MAX_IDS = 80;
/** 搜索时最多看多少条会话（内容搜索另有 80 条的预算，多传的会被 Bridge 截掉）。 */
const DOCK_SEARCH_LIMIT = 200;

let dockSearchQuery = "";
let dockSearchDeep = false;
let dockSearchMatches: Set<string> | null = null;
let dockSearchBusy = false;
let dockSearchPartial = false;
/** Mac 上的 Bridge 不认识 session.search（旧版本）：别再反复请求，直接把原因写出来。 */
let dockSearchStale = false;
/** 这次搜索失败的原因；有内容时状态行显示它，而不是「没搜到」。 */
let dockSearchNote = "";
let dockSearchErrors = 0;
let dockSearchTimer: number | null = null;
let dockSearchToken = 0;
let dockHistoryView: {
  wrap: HTMLElement;
  list: HTMLElement;
  input: HTMLInputElement;
  check: HTMLInputElement;
  status: HTMLElement;
} | null = null;

/** 标签库由 snapshot 带下来，新建/删除后本地同步，不用整份重拉。 */
/** 老 Bridge 没有标签 RPC：入口要明说，别让人点了等超时。 */
let tagsSupported = true;

function allTags(): TagDef[] {
  return snapshot?.tags ?? [];
}

function tagDot(tag: { name: string; color: TagColor }): HTMLElement {
  return el("span", {
    className: `tag-dot tag-${tag.color}`,
    attrs: { title: tag.name, "aria-label": tag.name },
  });
}

function tagDots(tags: SessionTagRef[] | undefined): HTMLElement | null {
  if (!tags || tags.length === 0) return null;
  return el(
    "span",
    { className: "tag-dots" },
    tags.map((tag) => tagDot(tag)),
  );
}

const TAG_COLOR_LABELS: Record<TagColor, string> = {
  red: "红",
  orange: "橙",
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  purple: "紫",
  gray: "灰",
};

const TAG_FILTER_KEY = "ab.dockTagFilter";

function readTagFilter(): string[] {
  try {
    const raw = localStorage.getItem(TAG_FILTER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeTagFilter(): void {
  try {
    localStorage.setItem(TAG_FILTER_KEY, JSON.stringify([...dockTagFilter]));
  } catch {
    // storage unavailable; the filter still applies in this tab
  }
}

/** 多选筛选按「命中任一标签」算，跟 Finder 的标签筛选一致。 */
let dockTagFilter = new Set<string>(readTagFilter());

function dockTagMatch(session: SessionSummary): boolean {
  if (dockTagFilter.size === 0) return true;
  return (session.tags ?? []).some((tag) => dockTagFilter.has(tag.tagId));
}

let dockTagFilterHost: HTMLElement | null = null;

function renderTagFilter(): void {
  const host = dockTagFilterHost;
  if (!host) return;
  const tags = allTags();
  host.hidden = tags.length === 0;
  if (tags.length === 0) {
    host.replaceChildren();
    return;
  }
  const nodes: Node[] = [];
  for (const tag of tags) {
    const on = dockTagFilter.has(tag.tagId);
    const chip = el("button", { className: `dock-tag-chip${on ? " is-on" : ""}`, attrs: { type: "button" } }, [
      tagDot(tag),
      el("span", { text: tag.name }),
    ]);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.addEventListener("click", () => {
      if (on) dockTagFilter.delete(tag.tagId);
      else dockTagFilter.add(tag.tagId);
      writeTagFilter();
      renderTagFilter();
      renderDockHistoryList();
    });
    nodes.push(chip);
  }
  if (dockTagFilter.size > 0) {
    const clear = el("button", { className: "dock-tag-chip is-clear", attrs: { type: "button" }, text: tr("清除筛选") });
    clear.addEventListener("click", () => {
      dockTagFilter = new Set();
      writeTagFilter();
      renderTagFilter();
      renderDockHistoryList();
    });
    nodes.push(clear);
  }
  host.replaceChildren(...nodes);
}

let tagMenu: { sessionId: string; anchor: HTMLElement } | null = null;
let tagMenuEl: HTMLElement | null = null;
/** 正在编辑的标签：tagId，或 "new" 表示新建。 */
let tagEditing: string | null = null;
let tagEditDraft: { name: string; color: TagColor } = { name: "", color: "blue" };
let tagMenuStatus = "";

function closeTagMenu(): void {
  tagMenuEl?.remove();
  tagMenuEl = null;
  tagMenu = null;
  tagEditing = null;
  tagMenuStatus = "";
}

function positionTagMenu(): void {
  const node = tagMenuEl;
  const anchor = tagMenu?.anchor;
  if (!node || !anchor || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const left = Math.min(Math.max(8, window.innerWidth - width - 8), Math.max(8, rect.right - width));
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function openTagMenu(sessionId: string, anchor: HTMLElement): void {
  if (tagMenu?.sessionId === sessionId) {
    closeTagMenu();
    return;
  }
  if (!tagsSupported) {
    flashNotice(tr("Mac 上的 Bridge 还是旧版本，升级后才能用标签"));
    return;
  }
  closeTagMenu();
  tagMenu = { sessionId, anchor };
  tagMenuEl = el("div", { className: "tag-menu", attrs: { role: "dialog", "aria-label": tr("标签") } });
  document.body.append(tagMenuEl);
  renderTagMenu();
}

function tagEditor(editing: string): HTMLElement {
  const wrap = el("div", { className: "tag-editor" });
  const input = el("input", {
    className: "tag-editor-name",
    attrs: { type: "text", placeholder: tr("标签名"), "aria-label": tr("标签名"), maxlength: "24" },
  });
  input.value = tagEditDraft.name;
  input.addEventListener("input", () => {
    tagEditDraft.name = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTagDraft();
    }
  });
  const colors = el("div", { className: "tag-editor-colors" });
  for (const color of TAG_COLORS) {
    const label = TAG_COLOR_LABELS[color];
    const swatch = el("button", {
      className: `tag-swatch tag-${color}${tagEditDraft.color === color ? " is-on" : ""}`,
      attrs: { type: "button", title: label, "aria-label": tr(`颜色：{0}`, label) },
    });
    swatch.addEventListener("click", () => {
      tagEditDraft.color = color;
      renderTagMenu();
    });
    colors.append(swatch);
  }
  const save = el("button", { className: "btn small", attrs: { type: "button" }, text: tr("保存") });
  save.addEventListener("click", () => void saveTagDraft());
  const cancel = el("button", { className: "btn small ghost", attrs: { type: "button" }, text: tr("取消") });
  cancel.addEventListener("click", () => {
    tagEditing = null;
    tagMenuStatus = "";
    renderTagMenu();
  });
  const actions = el("div", { className: "tag-editor-actions" }, [save, cancel]);
  if (editing !== "new") {
    const remove = el("button", { className: "btn small danger", attrs: { type: "button" }, text: tr("删除标签") });
    remove.addEventListener("click", () => void deleteTagDef(editing));
    actions.append(remove);
  }
  wrap.append(input, colors, actions);
  window.setTimeout(() => input.focus(), 0);
  return wrap;
}

function renderTagMenu(): void {
  const node = tagMenuEl;
  const sessionId = tagMenu?.sessionId;
  const session = sessionId ? snapshot?.sessions.find((item) => item.sessionId === sessionId) : undefined;
  if (!node || !session) return;
  const current = new Set((session.tags ?? []).map((tag) => tag.tagId));
  const list = el("div", { className: "tag-menu-list" });
  const tags = allTags();
  if (tags.length === 0 && tagEditing !== "new") {
    list.append(el("p", { className: "tag-menu-empty", text: tr("还没有标签") }));
  }
  for (const tag of tags) {
    if (tagEditing === tag.tagId) {
      list.append(tagEditor(tag.tagId));
      continue;
    }
    const on = current.has(tag.tagId);
    const item = el("button", { className: `tag-menu-item${on ? " is-on" : ""}`, attrs: { type: "button" } }, [
      el("span", { className: "tag-menu-check", text: on ? "✓" : "" }),
      tagDot(tag),
      el("span", { className: "tag-menu-name", text: tag.name }),
    ]);
    item.setAttribute("aria-pressed", on ? "true" : "false");
    item.addEventListener("click", () => void toggleSessionTag(session.sessionId, tag.tagId, !on));
    const edit = el("button", {
      className: "tag-menu-edit",
      attrs: { type: "button", title: tr("改名、换颜色或删除"), "aria-label": tr("编辑标签") },
      text: "⋯",
    });
    edit.addEventListener("click", () => {
      tagEditing = tag.tagId;
      tagEditDraft = { name: tag.name, color: tag.color };
      tagMenuStatus = "";
      renderTagMenu();
    });
    list.append(el("div", { className: "tag-menu-row" }, [item, edit]));
  }
  if (tagEditing === "new") list.append(tagEditor("new"));
  const add = el("button", { className: "tag-menu-add", attrs: { type: "button" }, text: tr("新建标签…") });
  add.addEventListener("click", () => {
    tagEditing = "new";
    tagEditDraft = { name: "", color: "blue" };
    tagMenuStatus = "";
    renderTagMenu();
  });
  const nodes: Node[] = [el("p", { className: "tag-menu-head", text: session.title })];
  nodes.push(list, el("div", { className: "tag-menu-sep" }), add);
  if (tagMenuStatus) nodes.push(el("p", { className: "tag-menu-status", text: tagMenuStatus }));
  node.replaceChildren(...nodes);
  positionTagMenu();
}

function patchSessionTags(sessionId: string, tags: SessionTagRef[]): void {
  const data = snapshot;
  if (!data) return;
  snapshot = {
    ...data,
    sessions: data.sessions.map((item) =>
      item.sessionId === sessionId ? (tags.length > 0 ? { ...item, tags } : { ...item, tags: undefined }) : item,
    ),
  };
  renderDockHistoryList();
  renderTagMenu();
}

async function toggleSessionTag(sessionId: string, tagId: string, on: boolean): Promise<void> {
  const session = snapshot?.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return;
  const ids = new Set((session.tags ?? []).map((tag) => tag.tagId));
  if (on) ids.add(tagId);
  else ids.delete(tagId);
  try {
    const result = await call<SessionTagsResult>("session.tags", { sessionId, tagIds: [...ids] }, 5_000);
    tagMenuStatus = "";
    patchSessionTags(sessionId, result.tags);
  } catch (error) {
    tagMenuStatus = messageOf(error);
    renderTagMenu();
  }
}

async function saveTagDraft(): Promise<void> {
  const name = tagEditDraft.name.trim();
  if (!name) {
    tagMenuStatus = tr("标签名不能为空");
    renderTagMenu();
    return;
  }
  const editing = tagEditing;
  try {
    const saved = await call<TagDef>(
      "tag.save",
      {
        ...(editing && editing !== "new" ? { tagId: editing } : {}),
        name,
        color: tagEditDraft.color,
      },
      5_000,
    );
    const data = snapshot;
    if (data) {
      const exists = data.tags.some((tag) => tag.tagId === saved.tagId);
      snapshot = {
        ...data,
        tags: exists ? data.tags.map((tag) => (tag.tagId === saved.tagId ? saved : tag)) : [...data.tags, saved],
        sessions: data.sessions.map((item) =>
          item.tags?.some((tag) => tag.tagId === saved.tagId)
            ? { ...item, tags: item.tags.map((tag) => (tag.tagId === saved.tagId ? saved : tag)) }
            : item,
        ),
      };
    }
    tagEditing = null;
    tagMenuStatus = "";
    // 新建的标签直接挂到当前会话上，省一次点击。
    if (!editing || editing === "new") {
      if (tagMenu) {
        await toggleSessionTag(tagMenu.sessionId, saved.tagId, true);
        renderTagFilter();
        renderTagMenu();
        return;
      }
    }
    renderTagFilter();
    renderDockHistoryList();
    renderTagMenu();
  } catch (error) {
    tagMenuStatus = messageOf(error);
    renderTagMenu();
  }
}

async function deleteTagDef(tagId: string): Promise<void> {
  try {
    await call("tag.delete", { tagId }, 5_000);
  } catch (error) {
    tagMenuStatus = messageOf(error);
    renderTagMenu();
    return;
  }
  const data = snapshot;
  if (data) {
    snapshot = {
      ...data,
      tags: data.tags.filter((tag) => tag.tagId !== tagId),
      sessions: data.sessions.map((item) => {
        if (!item.tags?.some((tag) => tag.tagId === tagId)) return item;
        const rest = item.tags.filter((tag) => tag.tagId !== tagId);
        return rest.length > 0 ? { ...item, tags: rest } : { ...item, tags: undefined };
      }),
    };
  }
  dockTagFilter.delete(tagId);
  writeTagFilter();
  tagEditing = null;
  tagMenuStatus = "";
  renderTagFilter();
  renderDockHistoryList();
  renderTagMenu();
}

/** 点空白处或按 Esc 收起标签面板；只装一次。 */
function watchTagMenu(): void {
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node | null;
    if (!target || !tagMenuEl) return;
    if (tagMenuEl.contains(target) || tagMenu?.anchor.contains(target)) return;
    closeTagMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tagMenuEl) closeTagMenu();
  });
  window.addEventListener("resize", () => {
    if (tagMenuEl) closeTagMenu();
  });
}

function dockHistorySessions(): SessionSummary[] {
  const data = snapshot;
  if (!data) return [];
  const all = visibleSessions(data.sessions);
  // 不搜索时列表只画最近 30 条；一开始搜就放开到全部（最多 DOCK_SEARCH_LIMIT 条），
  // 否则排在 30 名之外的会话连标题都搜不到，用户会以为「明明有却搜不出来」。
  const limit = dockSearchQuery.trim() ? DOCK_SEARCH_LIMIT : DOCK_HISTORY_LIMIT;
  return all.slice(0, limit);
}

function dockHistoryMatch(session: SessionSummary): boolean {
  const query = dockSearchQuery.trim().toLowerCase();
  if (!query) return true;
  // 标题永远在本地过滤：改写过的标题和原名都算。
  const title = `${session.title} ${session.originalTitle ?? ""}`.toLowerCase();
  if (title.includes(query)) return true;
  return dockSearchDeep && dockSearchMatches?.has(session.sessionId) === true;
}

function renderDockHistoryList(): void {
  const view = dockHistoryView;
  if (!view) return;
  const active = dockActive(parseRoute());
  const all = dockHistorySessions();
  const sessions = all.filter(dockHistoryMatch).filter(dockTagMatch);
  const nodes: HTMLElement[] = [];
  if (sessions.length === 0) {
    nodes.push(
      el("p", {
        className: "hint",
        text:
          dockTagFilter.size > 0 && dockSearchQuery.trim() === ""
            ? tr("没有带这些标签的会话。")
            : dockSearchQuery.trim() === ""
              ? tr("还没有会话。")
              : dockSearchBusy
                ? tr("正在搜索…")
                : tr("没有匹配的会话。"),
      }),
    );
  }
  for (const session of sessions) {
    const current = active.sessionId === session.sessionId;
    const open = el("button", { className: "dock-history-open", attrs: { type: "button" } }, [
      el("span", { className: "dock-history-title" }, [
        ...(session.pinned ? [icon("pin", "icon pin-mark")] : []),
        document.createTextNode(session.title),
      ]),
      el("span", { className: "dock-history-facts" }, [
        el("span", {
          className: "dock-history-meta",
          text: `${agentLabel(session.kind, session.hostedAgent)} · ${recentTime(session.updatedAt)}`,
        }),
        ...dockStatePills(session),
      ]),
    ]);
    open.title = `${session.title}\n${session.projectId}`;
    if (current) open.setAttribute("aria-current", "page");
    open.addEventListener("click", () => {
      navigate({
        level: "chat",
        appId: session.appId,
        projectId: session.projectId,
        sessionId: session.sessionId,
      });
    });
    const tagButton = el(
      "button",
      {
        className: `dock-tag-btn${session.tags?.length ? " is-set" : ""}`,
        attrs: { type: "button", title: tr("标签"), "aria-label": tr("给这个会话打标签") },
      },
      session.tags?.length
        ? session.tags.slice(0, 3).map((tag) => tagDot(tag))
        : [el("span", { className: "tag-dot tag-none" })],
    );
    tagButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openTagMenu(session.sessionId, tagButton);
    });
    const node = el("div", { className: `dock-history-row${current ? " is-active" : ""}` }, [open, tagButton]);
    node.dataset.sessionId = session.sessionId;
    node.dataset.state = dockStateKey(session);
    nodes.push(node);
  }
  view.list.replaceChildren(...nodes);

  const query = dockSearchQuery.trim();
  if (!dockSearchDeep || query === "") {
    view.status.hidden = true;
    view.status.textContent = "";
    return;
  }
  view.status.hidden = false;
  const unread = dockSearchErrors > 0 ? tr(`，{0} 个会话读不到`, dockSearchErrors) : "";
  if (dockSearchStale) {
    view.status.textContent = tr("Mac 上的 Bridge 还是旧版本，升级后才能搜对话内容");
  } else if (dockSearchBusy) {
    view.status.textContent = tr("正在搜索对话内容…");
  } else if (dockSearchNote) {
    view.status.textContent = tr(`搜索失败：{0}`, dockSearchNote);
  } else if (dockSearchMatches === null) {
    view.status.textContent = tr("勾选后按对话内容搜索");
  } else {
    const count = dockSearchMatches.size;
    view.status.textContent =
      count === 0
        ? dockSearchPartial
          ? tr(`内容没搜到（超时，可能没搜完）{0}`, unread)
          : tr(`内容没搜到{0}`, unread)
        : dockSearchPartial
          ? tr(`内容命中 {0} 个会话（超时，可能没搜完）{1}`, count, unread)
          : tr(`内容命中 {0} 个会话{1}`, count, unread);
  }
}

function scheduleDeepSearch(): void {
  if (dockSearchTimer !== null) {
    window.clearTimeout(dockSearchTimer);
    dockSearchTimer = null;
  }
  const query = dockSearchQuery.trim();
  if (!dockSearchDeep || query === "") {
    dockSearchToken += 1;
    dockSearchBusy = false;
    dockSearchMatches = null;
    dockSearchPartial = false;
    dockSearchNote = "";
    dockSearchErrors = 0;
    renderDockHistoryList();
    return;
  }
  if (dockSearchStale) {
    dockSearchBusy = false;
    renderDockHistoryList();
    return;
  }
  dockSearchBusy = true;
  renderDockHistoryList();
  dockSearchTimer = window.setTimeout(() => {
    dockSearchTimer = null;
    void runDeepSearch(query);
  }, DOCK_SEARCH_DEBOUNCE_MS);
}

async function runDeepSearch(query: string): Promise<void> {
  dockSearchToken += 1;
  const token = dockSearchToken;
  const sessionIds = dockHistorySessions()
    .slice(0, DOCK_SEARCH_MAX_IDS)
    .map((session) => session.sessionId);
  const peer = active;
  if (!peer) {
    dockSearchBusy = false;
    dockSearchMatches = new Set();
    dockSearchNote = tr("没连上 Mac，只按标题搜");
    renderDockHistoryList();
    return;
  }

  // 比网页还旧的 Bridge 连 METHOD 都不认识：帧在协议层就被丢掉，不会回错误，
  // 等下去只会白等到超时。直接按版本判定，省掉这一次干等。
  const hostVersion = connected?.info.version;
  if (hostVersion !== undefined && !atLeastVersion(hostVersion, [0, 11, 4])) {
    dockSearchStale = true;
    dockSearchBusy = false;
    dockSearchMatches = new Set();
    dockSearchNote = "";
    renderDockHistoryList();
    return;
  }

  // 直接用 request 而不是 call()：要拿到错误码，才能把「Bridge 太旧」和「网络断了」分开说。
  let response;
  try {
    // 桥端预算 8 秒，超时给到 10 秒就够；再长只会让人干等。
    response = await peer.request("session.search", { query, sessionIds }, 10_000);
  } catch (error) {
    if (token !== dockSearchToken) return;
    dockSearchBusy = false;
    dockSearchMatches = new Set();
    dockSearchNote = error instanceof Error ? error.message : tr("搜索失败");
    // 连不上 / 没回音时也按「Bridge 太旧或不在线」降级，别再每敲一个字等 10 秒。
    const code =
      error instanceof PeerError || error instanceof RpcCallError ? error.code : undefined;
    if (code === "timeout" || code === "unsupported") dockSearchStale = true;
    renderDockHistoryList();
    return;
  }
  if (token !== dockSearchToken) return;
  dockSearchBusy = false;

  if (!response.ok) {
    // 老版本 Bridge 抛的是普通 Error，包成 internal 后只留下这句话；两种都算「太旧」。
    const stale =
      response.error?.code === "unsupported" ||
      /unsupported method/i.test(response.error?.message ?? "");
    if (stale) {
      // 老版本 Bridge 没有这个 RPC：记住别再问，正文搜索整体降级。
      dockSearchStale = true;
      dockSearchNote = "";
    } else {
      dockSearchNote = response.error?.message ?? tr("搜索失败");
    }
    dockSearchMatches = new Set();
    dockSearchPartial = false;
    renderDockHistoryList();
    return;
  }

  const result = response.result as SessionSearchResult;
  dockSearchMatches = new Set(result.matches);
  dockSearchPartial = result.partial === true;
  dockSearchErrors = result.errors ?? 0;
  dockSearchNote = "";
  renderDockHistoryList();
}

/** 「快速清理」的时间档：按会话最后更新时间倒推。 */
const CLEANUP_RANGES: Array<{ ms: number; label: string }> = [
  { ms: 12 * 3_600_000, label: "12 小时" },
  { ms: 24 * 3_600_000, label: "1 天" },
  { ms: 3 * 86_400_000, label: "3 天" },
  { ms: 5 * 86_400_000, label: "5 天" },
  { ms: 7 * 86_400_000, label: "7 天" },
  { ms: 15 * 86_400_000, label: "15 天" },
];

/**
 * 快速清理只归档 Bridge 托管会话（桌面会话由各自应用管）；置顶、正在跑、等回答的都跳过。
 * 用 `updatedAt` 而不是 `createdAt`：一小时前还在用的会话不该因为建得早被清掉。
 */
function cleanupCandidates(ms: number): SessionSummary[] {
  const cutoff = Date.now() - ms;
  return visibleSessions(snapshot?.sessions ?? []).filter(
    (session) =>
      session.hosted === true &&
      session.updatedAt < cutoff &&
      session.pinned !== true &&
      session.busy !== true &&
      session.needsDecision !== true,
  );
}

/** 历史面板上的「快速清理」：先选时间档，再在弹层里核对标题后批量归档。 */
function cleanupControl(): HTMLElement {
  const wrap = el("div", { className: "dock-cleanup" });
  const menu = el("div", { className: "dock-cleanup-menu", attrs: { role: "menu" } });
  menu.hidden = true;
  const trigger = el(
    "button",
    {
      className: "dock-cleanup-btn",
      attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" },
    },
    [icon("trash", "icon"), el("span", { text: tr("快速清理") })],
  );

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target || wrap.contains(target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside);
    document.removeEventListener("keydown", onKey);
  }

  for (const range of CLEANUP_RANGES) {
    const item = el(
      "button",
      { className: "dock-cleanup-item", attrs: { type: "button", role: "menuitem" } },
      [el("span", { text: tr(`归档超过 {0} 未更新的托管会话`, tr(range.label)) })],
    );
    item.addEventListener("click", () => {
      close();
      cleanupSheet(range.ms, tr(range.label));
    });
    menu.append(item);
  }

  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onKey);
  });

  wrap.append(trigger, menu);
  return wrap;
}

/** 核对弹层：列出会归档的标题，确认后逐个走 `hosted.archive`。 */
function cleanupSheet(ms: number, rangeLabel: string): void {
  const candidates = cleanupCandidates(ms);
  const mask = el("div", { className: "sheet-mask" });
  const progress = el("p", { className: "sheet-note", text: "" });
  progress.hidden = true;
  let busy = false;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !busy) finish();
  };
  function finish(): void {
    document.removeEventListener("keydown", onKey);
    mask.remove();
  }

  const confirm = button("", () => void run(), "btn primary");
  const cancel = button(
    tr("取消"),
    () => {
      if (!busy) finish();
    },
    "btn secondary",
  );

  function paintConfirm(): void {
    confirm.textContent = tr("归档 {0} 个", candidates.length);
    confirm.disabled = busy || candidates.length === 0;
    cancel.disabled = busy;
  }

  async function run(): Promise<void> {
    if (busy || candidates.length === 0) return;
    busy = true;
    paintConfirm();
    progress.hidden = false;
    let archived = 0;
    const archivedIds = new Set<string>();
    const failures: string[] = [];
    for (const [index, session] of candidates.entries()) {
      progress.textContent = tr("正在归档 {0}/{1}", index + 1, candidates.length);
      try {
        const result = await call<SessionGetResult>("hosted.archive", {
          sessionId: session.sessionId,
          archived: true,
        });
        patchSession(result.session);
        archivedIds.add(session.sessionId);
        archived += 1;
      } catch (error) {
        failures.push(`${session.title}：${messageOf(error)}`);
      }
    }
    busy = false;
    finish();
    renderDockHistoryList();
    syncDockSessions();
    // 正在看的那条也被清掉时，跟单条归档一样退回工程页，免得停在一个已归档的聊天里。
    const route = parseRoute();
    if (route.level === "chat" && archivedIds.has(route.sessionId)) {
      navigate({ level: "sessions", appId: route.appId, projectId: route.projectId });
    } else if (route.level === "sessions") {
      void renderRoute();
    }
    flashNotice(tr("已归档 {0} 个，失败 {1} 个", archived, failures.length));
    for (const line of failures) console.warn(`[cleanup] ${line}`);
  }

  const body = el("div", { className: "sheet-body" });
  if (candidates.length === 0) {
    body.append(el("p", { className: "hint", text: tr("没有符合条件的托管会话") }));
  } else {
    const list = el("div", { className: "list cleanup-list" });
    for (const session of candidates) {
      list.append(
        el("div", { className: "cleanup-item" }, [
          el("span", { className: "cleanup-item-title", text: session.title }),
          el("span", {
            className: "cleanup-item-meta",
            text: `${recentProjectName(session.projectId)} · ${recentTime(session.updatedAt)}`,
          }),
        ]),
      );
    }
    body.append(list);
  }

  paintConfirm();
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (event) => {
    if (event.target === mask && !busy) finish();
  });

  mask.append(
    el(
      "aside",
      { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": tr("快速清理") } },
      [
        el("header", { className: "sheet-head" }, [el("h2", { className: "sheet-title", text: tr("快速清理") })]),
        el("p", { className: "sheet-note", text: tr(`归档超过 {0} 未更新的托管会话`, rangeLabel) }),
        body,
        el("p", {
          className: "sheet-note",
          text: tr("只处理 Bridge 托管的会话，桌面会话请在原应用里归档。"),
        }),
        el("p", {
          className: "sheet-note",
          text: tr("归档后不再出现在历史里，可在工程页「显示已归档」找回。"),
        }),
        progress,
        el("footer", { className: "sheet-foot" }, [el("div", { className: "actions" }, [cancel, confirm])]),
      ],
    ),
  );
  document.body.append(mask);
  confirm.focus();
}

function dockHistory(): HTMLElement {
  if (!dockHistoryView) {
    const wrap = el("div", { className: "dock-history" });
    const search = el("div", { className: "dock-search" });
    const input = el("input", {
      className: "dock-search-input",
      attrs: {
        type: "search",
        placeholder: tr("搜索历史对话…"),
        "aria-label": tr("搜索历史对话"),
        autocomplete: "off",
      },
    });
    input.value = dockSearchQuery;
    input.addEventListener("input", () => {
      dockSearchQuery = input.value;
      if (dockSearchDeep) {
        // 内容搜索要防抖，先把标题命中的结果画出来
        scheduleDeepSearch();
      } else {
        renderDockHistoryList();
      }
    });
    const label = el("label", { className: "dock-search-check" });
    const check = el("input", { attrs: { type: "checkbox", "aria-label": tr("同时搜索对话内容") } });
    check.checked = dockSearchDeep;
    check.addEventListener("change", () => {
      dockSearchDeep = check.checked;
      scheduleDeepSearch();
    });
    label.append(check, document.createTextNode(tr("搜内容")));
    search.append(input, label);
    const status = el("p", { className: "dock-search-status" });
    status.hidden = true;
    const filters = el("div", { className: "dock-tag-filter", attrs: { role: "group", "aria-label": tr("按标签筛选") } });
    dockTagFilterHost = filters;
    const list = el("div", { className: "dock-list dock-history-list" });
    wrap.append(search, cleanupControl(), filters, status, list);
    dockHistoryView = { wrap, list, input, check, status };
    renderTagFilter();
  }
  renderTagFilter();
  renderDockHistoryList();
  return dockHistoryView.wrap;
}

/** 待办面板的本地状态：切换 tab 会重绘，草稿与上次数据留着。 */
let todoDraft: { title: string; kind: TodoKind } = { title: "", kind: "feature" };
/** 点开的待办：列表里标题是单行截断的，展开后才看得到整段。桌面和手机同一套。 */
let expandedTodoId: string | null = null;
let todoCache: TodoListResult | null = null;
let todoError = "";
/** 待办读取失败时点「重试」要怎么重来；不懂重试的错误留 null。 */
let todoRetry: (() => void) | null = null;
/** 正在就地编辑的待办；重绘后靠它回到编辑态。 */
let editingTodoId: string | null = null;
let todoEditDraft: { title: string; kind: TodoKind } = { title: "", kind: "feature" };

/** 当前聊天页的输入框：点待办时往这里填文字，不发送。 */
let composerRef: HTMLTextAreaElement | null = null;

function todoKindLabel(kind: TodoKind): string {
  if (kind === "bug") return "bug";
  if (kind === "feature") return tr("功能");
  return tr("其他");
}

/** 待办写进输入框的文案：分类放在前面，跟手写的时候一样的习惯。 */
function todoPrompt(item: TodoItem): string {
  if (item.kind === "other") return item.title;
  return `${todoKindLabel(item.kind)}: ${item.title}`;
}

/** 把文字接在输入框末尾（不发送）；没有打开的会话时提示一下。 */
function fillComposer(text: string): boolean {
  const input = composerRef;
  if (!input || !input.isConnected) {
    flashNotice(tr("先打开一个会话，再把待办填进输入框"));
    return false;
  }
  const current = input.value.trimEnd();
  input.value = current ? `${current}\n${text}` : text;
  // 走一次 input 事件：草稿、高度和发送按钮状态都靠它更新。
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

/** 左侧 dock 的待办：未完成的在上面，最近完成的在下面。 */
function dockTodos(): HTMLElement {
  const wrap = el("div", { className: "dock-todos" });
  const select = el("select", { className: "todo-kind", attrs: { "aria-label": tr("待办分类") } });
  for (const [value, label] of [["feature", tr("功能")], ["bug", "bug"], ["other", tr("其他")]] as const) {
    const option = el("option", { text: label, attrs: { value } });
    if (todoDraft.kind === value) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => {
    todoDraft.kind = select.value as TodoKind;
  });

  const input = el("input", {
    className: "todo-input",
    attrs: { type: "text", placeholder: tr("记一条待办…"), maxlength: "500" },
  });
  input.value = todoDraft.title;
  input.addEventListener("input", () => {
    todoDraft.title = input.value;
  });
  trackIme(input);

  const list = el("div", { className: "todo-list" });
  const addButton = button("", () => void add(), "btn primary todo-add");
  addButton.append(icon("plus"));
  addButton.setAttribute("aria-label", tr("添加待办"));
  addButton.setAttribute("title", tr("添加待办"));

  const refresh = async (): Promise<void> => {
    try {
      const result = await call<TodoListResult>("todo.list");
      if (!result || !Array.isArray(result.open) || !Array.isArray(result.done)) {
        throw new Error(tr("这个 Bridge 还不支持待办，需要更新 App"));
      }
      todoCache = result;
      todoError = "";
      todoRetry = null;
    } catch (error) {
      todoError = messageOf(error);
      todoRetry = isRetryableError(error) ? () => void refresh() : null;
    }
    paintList();
  };

  let adding = false;
  const add = async (): Promise<void> => {
    // 连按回车不能把同一条存两遍、也不能把输入框里的文字拆成好几条。
    if (adding) return;
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    adding = true;
    addButton.disabled = true;
    try {
      await call("todo.add", { title, kind: select.value });
      const kind = select.value as TodoKind;
      todoDraft = { title: "", kind };
      // 提交期间整页重绘会换掉输入框，清当前那个，否则旧文本会被还原回来又提交一次。
      const live = document.querySelector<HTMLInputElement>(".dock-todos .todo-input");
      (live ?? input).value = "";
      await refresh();
    } catch (error) {
      todoError = messageOf(error);
      paintList();
    } finally {
      adding = false;
      addButton.disabled = false;
    }
  };

  const setChecked = async (item: TodoItem, checked: boolean): Promise<void> => {
    try {
      await call("todo.check", { todoId: item.todoId, checked });
      await refresh();
    } catch (error) {
      todoError = messageOf(error);
      paintList();
    }
  };

  const remove = async (item: TodoItem): Promise<void> => {
    if (!window.confirm(tr(`删除待办「{0}」？`, item.title))) return;
    try {
      await call("todo.remove", { todoId: item.todoId });
      await refresh();
    } catch (error) {
      todoError = messageOf(error);
      paintList();
    }
  };

  /** 点条目：先填进输入框，填成功才标记完成——没会话时不能白白勾掉。 */
  const use = async (item: TodoItem): Promise<void> => {
    if (!fillComposer(todoPrompt(item))) return;
    if (item.checkedAt === null) await setChecked(item, true);
  };

  const row = (item: TodoItem): HTMLElement => {
    const done = item.checkedAt !== null;
    if (item.todoId === editingTodoId) return editRow(item, done);
    const expanded = expandedTodoId === item.todoId;
    const main = el(
      "button",
      {
        className: "todo-main",
        attrs: { type: "button", title: expanded ? tr("收起") : tr("展开查看全文") },
      },
      [
        el("span", { className: `todo-tag is-${item.kind}`, text: todoKindLabel(item.kind) }),
        el("span", { className: "todo-title", text: item.title }),
      ],
    );
    // 点条目只做一件事：展开/收起全文。填到输入框挪到右侧按钮，
    // 否则长待办永远看不全，点一下又会被勾成完成。
    main.addEventListener("click", () => {
      expandedTodoId = expanded ? null : item.todoId;
      paintList();
    });
    const action = (name: keyof typeof ICONS, label: string, run: () => void): HTMLElement => {
      const node = el(
        "button",
        { className: "todo-action", attrs: { type: "button", "aria-label": label, title: label } },
        [icon(name)],
      );
      node.addEventListener("click", run);
      return node;
    };
    const actions = el("div", { className: "todo-actions" }, [
      action("swap", tr("填到输入框"), () => void use(item)),
      ...(done ? [action("refresh", tr("标记未完成"), () => void setChecked(item, false))] : []),
      action("pencil", tr("编辑"), () => startEdit(item)),
      action("trash", tr("删除待办"), () => void remove(item)),
    ]);
    return el(
      "div",
      {
        className: `todo-item${done ? " is-done" : ""}${expanded ? " is-expanded" : ""}`,
      },
      [main, actions],
    );
  };

  /** 就地编辑：标题、分类都能改，改完才发 RPC。 */
  const editRow = (item: TodoItem, done: boolean): HTMLElement => {
    const select = el("select", { className: "todo-kind", attrs: { "aria-label": tr("待办分类") } });
    for (const [value, label] of [["feature", tr("功能")], ["bug", "bug"], ["other", tr("其他")]] as const) {
      const option = el("option", { text: label, attrs: { value } });
      if (todoEditDraft.kind === value) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      todoEditDraft.kind = select.value as TodoKind;
    });

    const input = el("input", {
      className: "todo-edit-input",
      attrs: { type: "text", maxlength: "500", "aria-label": tr("待办内容") },
    });
    input.value = todoEditDraft.title;
    input.addEventListener("input", () => {
      todoEditDraft.title = input.value;
    });
    trackIme(input);

    const cancel = (): void => {
      editingTodoId = null;
      paintList();
    };

    const save = async (): Promise<void> => {
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      try {
        await call("todo.update", { todoId: item.todoId, title, kind: select.value });
        editingTodoId = null;
        await refresh();
      } catch (error) {
        todoError = messageOf(error);
        paintList();
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        // 输入法上屏的回车不保存，否则半截文字就被存下、输入框又被清空。
        if (isImeEnter(event)) return;
        event.preventDefault();
        void save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });

    const saveButton = button("", () => void save(), "btn primary todo-save");
    saveButton.append(icon("check"));
    saveButton.setAttribute("aria-label", tr("保存"));
    saveButton.setAttribute("title", tr("保存"));
    const cancelButton = button("", cancel, "btn ghost todo-save");
    cancelButton.append(icon("close"));
    cancelButton.setAttribute("aria-label", tr("取消"));
    cancelButton.setAttribute("title", tr("取消"));

    const form = el("div", { className: `todo-edit${done ? " is-done" : ""}` }, [
      select,
      input,
      saveButton,
      cancelButton,
    ]);
    // 刚插进 DOM 后再聚焦，光标放到末尾。
    window.setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return form;
  };

  const startEdit = (item: TodoItem): void => {
    editingTodoId = item.todoId;
    todoEditDraft = { title: item.title, kind: item.kind };
    paintList();
  };

  const paintList = (): void => {
    const parts: HTMLElement[] = [];
    if (todoError) {
      parts.push(
        el("p", { className: "hint warn" }, [
          el("span", { text: todoError }),
          ...(todoRetry ? [button(tr("重试"), todoRetry, "btn small")] : []),
        ]),
      );
    }
    const data = todoCache;
    if (!data) {
      if (!todoError) parts.push(el("p", { className: "hint", text: tr("正在读取待办…") }));
    } else {
      if (data.open.length === 0) {
        parts.push(el("p", { className: "hint", text: tr("没有待办。") }));
      } else {
        parts.push(el("div", { className: "todo-group" }, data.open.map(row)));
      }
      if (data.done.length > 0) {
        parts.push(el("p", { className: "todo-heading", text: tr("最近完成") }));
        parts.push(el("div", { className: "todo-group" }, data.done.map(row)));
        const hidden = data.doneTotal - data.done.length;
        if (hidden > 0) parts.push(el("p", { className: "hint todo-hidden", text: tr(`还有 {0} 条已完成`, hidden) }));
      }
    }
    list.replaceChildren(...parts);
  };

  input.addEventListener("keydown", (event) => {
    // 中文输入法用回车确认候选词：这一下是给输入法的，提交了就会把一条待办拆成几条。
    if (event.key !== "Enter" || isImeEnter(event)) return;
    event.preventDefault();
    void add();
  });

  paintList();
  void refresh();
  wrap.append(
    el("p", {
      className: "hint todo-note",
      text: tr("待办存在 Bridge 自己的数据库里，换浏览器、清缓存都不会丢；换一台主机就是另一个库。"),
    }),
    el("div", { className: "todo-form" }, [select, input, addButton]),
    list,
  );
  return wrap;
}

/**
 * 窄屏没有常驻 dock，导航折进左侧抽屉：同一个 dock 加 `is-open` 就是抽屉，
 * 宽屏的 CSS 不认这个类，桌面布局不受影响。
 */
let dockOpen = false;
let dockKeyHandler: ((event: KeyboardEvent) => void) | null = null;
/**
 * 重画 dock 内容。dock 是进入这条路由时画好的，停在聊天页时别的会话完成了、
 * 未读变了它也还是一份旧 DOM；窄屏抽屉每次打开时得用它刷一次。
 */
let dockRepaint: (() => void) | null = null;

function setDockOpen(open: boolean): void {
  if (dockOpen === open) return;
  dockOpen = open;
  const dock = document.querySelector<HTMLElement>(".dock");
  dock?.classList.toggle("is-open", open);
  if (open) {
    // 先重画再显示：否则抽屉里永远是进入当前会话时那份旧数据（未读、运行中都是旧的）。
    dockRepaint?.();
  }
  if (open && dock) {
    if (!document.querySelector(".dock-scrim")) dock.after(dockScrim());
  } else {
    document.querySelector(".dock-scrim")?.remove();
  }
  document.querySelector(".dock-toggle")?.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("dock-open", open);
  if (dockKeyHandler) {
    document.removeEventListener("keydown", dockKeyHandler);
    dockKeyHandler = null;
  }
  if (open) {
    // 手机上没键盘也用不上，桌面窄窗口时按 Esc 能收起。
    dockKeyHandler = (event) => {
      if (event.key === "Escape") setDockOpen(false);
    };
    document.addEventListener("keydown", dockKeyHandler);
  }
}

/** 抽屉背后的遮罩：点一下就收起。 */
function dockScrim(): HTMLElement {
  const node = el("div", { className: "dock-scrim", attrs: { "aria-hidden": "true" } });
  node.addEventListener("click", () => setDockOpen(false));
  return node;
}

/** 顶栏左侧的抽屉开关，只在窄屏出现（宽屏已有常驻 dock）。 */
function dockToggleButton(): HTMLButtonElement {
  const node = button("", () => setDockOpen(!dockOpen), "btn ghost small dock-toggle");
  node.append(icon("menu"));
  node.setAttribute("aria-label", tr("打开会话导航"));
  node.setAttribute("aria-haspopup", "dialog");
  node.setAttribute("aria-controls", "dock-nav");
  node.setAttribute("aria-expanded", String(dockOpen));
  return node;
}

/** 桌面宽屏左侧的 dock：结构树、历史与待办三个 tab，选中的 tab 记在 localStorage。 */
function dockSidebar(route: Route): HTMLElement {
  // 换一页就重建侧栏：历史面板里的 DOM（搜索框）跟着换新，搜索词本身留着。
  dockHistoryView = null;
  let tab = readDockTab();
  const nav = el("nav", {
    className: `dock${dockOpen ? " is-open" : ""}`,
    attrs: { "aria-label": tr("会话导航"), id: "dock-nav" },
  });
  // 抽屉头部只在窄屏出现：宽屏 dock 是常驻侧栏，不需要标题和关闭按钮。
  const closeButton: HTMLButtonElement = button("", () => setDockOpen(false), "btn ghost small dock-close");
  closeButton.append(icon("close"));
  closeButton.setAttribute("aria-label", tr("关闭会话导航"));
  nav.append(
    el("div", { className: "dock-head" }, [
      el("span", { className: "dock-head-title", text: tr("会话导航") }),
      closeButton,
    ]),
  );
  const tabs = el("div", { className: "dock-tabs", attrs: { role: "tablist" } });
  const body = el("div", { className: "dock-body" });
  const makeTab = (id: DockTab, label: string): HTMLButtonElement => {
    const node = el("button", { className: "dock-tab", text: label, attrs: { type: "button", role: "tab" } });
    node.addEventListener("click", () => {
      if (tab === id) return;
      // 标签面板挂在 body 上，换 tab 时按钮会被换掉，浮层要一起收。
      closeTagMenu();
      tab = id;
      writeDockTab(id);
      paint();
    });
    return node;
  };
  const treeTab = makeTab("tree", tr("结构"));
  const historyTab = makeTab("history", tr("历史"));
  const todoTab = makeTab("todo", tr("待办"));
  tabs.append(treeTab, historyTab, todoTab);
  const paint = (): void => {
    for (const [id, node] of [
      ["tree", treeTab],
      ["history", historyTab],
      ["todo", todoTab],
    ] as const) {
      node.classList.toggle("is-active", tab === id);
      node.setAttribute("aria-selected", String(tab === id));
    }
    body.replaceChildren(
      tab === "tree" ? dockTree(route) : tab === "history" ? dockHistory() : dockTodos(),
    );
  };
  paint();
  nav.append(tabs, body);
  dockRepaint = () => {
    // 页面切走后这份 nav 已经脱离文档，别再去改它。
    if (!nav.isConnected) return;
    paint();
  };
  return nav;
}

function shortAgentName(app: AppInfo): string {
  if (app.kind === "claude-code") return "Claude";
  if (app.kind === "claude-code-cli") return "Claude CLI";
  if (app.kind === "codex") return "ChatGPT";
  if (app.kind === "codex-cli") return "Codex CLI";
  if (app.kind === "antigravity" || app.kind === "antigravity-desktop") return "Antigravity";
  if (app.kind === "dsh") return "DeepSeek";
  if (app.kind === "pi") return "pi";
  return app.name.split(/[·\s]/)[0] ?? app.name;
}

function agentMark(kind: SessionSummary["kind"] | AppInfo["kind"], hostedAgent?: HostedAgent): string {
  if (kind === "codex" || kind === "codex-cli" || kind === "codex-thread") return "CX";
  if (kind === "antigravity" || kind === "antigravity-desktop") return "AG";
  if (kind === "dsh") return "DS";
  if (kind === "pi") return "PI";
  // 托管会话按实际引擎显示，别再一律当成 Claude Code。
  if (kind === "hosted") {
    if (hostedAgent === "pi") return "PI";
    if (hostedAgent === "claude") return "CC";
    return "BH";
  }
  return "CC";
}

const RECENT_SESSIONS_KEY = "ab.recentSessions";
const RECENT_LIMIT = 20;

const TRAIL_LIMIT = 10;
let trail: Array<{ hash: string; title: string }> = [];
let trailIndex = -1;

/**
 * 记住看过的会话，顶部「上一个对话」靠它在两条会话之间来回切换。
 * 用指针而不是简单出栈：点按钮先把指针回退再跳转，来回切换不会把轨迹撑满。
 */
function noteSessionTrail(hash: string, title: string): void {
  const current = trail[trailIndex];
  if (current?.hash === hash) {
    current.title = title;
    return;
  }
  trail = trail.slice(0, trailIndex + 1);
  trail.push({ hash, title });
  if (trail.length > TRAIL_LIMIT) trail.shift();
  trailIndex = trail.length - 1;
}

function previousTrailEntry(): { hash: string; title: string; step: "back" | "forward" } | null {
  const prev = trailIndex > 0 ? trail[trailIndex - 1] : undefined;
  if (prev) return { ...prev, step: "back" };
  // 刚通过按钮退到轨迹起点时，上一步就在后面：再点一下回到刚才那条会话。
  const next = trail[trailIndex + 1];
  if (trailIndex >= 0 && next) return { ...next, step: "forward" };
  return null;
}

interface RecentSession {
  sessionId: string;
  title: string;
  appId: string;
  projectId: string;
  at: number;
}

function readRecentSessions(): RecentSession[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_SESSIONS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is RecentSession => {
        if (typeof item !== "object" || item === null) return false;
        const value = item as Record<string, unknown>;
        return (
          typeof value["sessionId"] === "string" &&
          typeof value["title"] === "string" &&
          typeof value["appId"] === "string" &&
          typeof value["projectId"] === "string" &&
          typeof value["at"] === "number"
        );
      })
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function rememberSession(summary: SessionSummary): void {
  const entry: RecentSession = {
    sessionId: summary.sessionId,
    title: summary.title,
    appId: summary.appId,
    projectId: summary.projectId,
    at: Date.now(),
  };
  const list = [
    entry,
    ...readRecentSessions().filter((item) => item.sessionId !== entry.sessionId),
  ].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable; recents are best-effort
  }
}

function recentTime(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return tr("刚刚");
  if (minutes < 60) return tr(`{0} 分钟前`, minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr(`{0} 小时前`, hours);
  return tr(`{0} 天前`, Math.floor(hours / 24));
}

function recentProjectName(projectId: string): string {
  const known = snapshot?.projects.find((item) => item.projectId === projectId);
  if (known) return known.name;
  const parts = projectId.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectId;
}

function recentSessionsButton(): HTMLElement | null {
  const sessions = readRecentSessions();
  if (sessions.length === 0) return null;

  const trigger = el("button", {
    className: "btn ghost small recents-btn",
    attrs: {
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": tr("最近访问的会话"),
    },
  });
  const titles = sessions.slice(0, 6).map((item) => item.title);
  const run = el("span", { className: "recents-run" });
  for (const title of titles) run.append(el("span", { className: "recents-item", text: title }));
  // 滚动放在内层：外层只负责裁剪和渐隐，内层平移动画才不会盖到左侧图标上。
  const track = el("span", { className: "recents-track" });
  const marquee = el("span", { className: "recents-marquee" });
  marquee.append(run);
  if (titles.length > 1) {
    const clone = el("span", { className: "recents-run" });
    for (const title of titles) clone.append(el("span", { className: "recents-item", text: title }));
    marquee.append(clone);
    marquee.classList.add("is-scrolling");
  }
  track.append(marquee);
  trigger.append(icon("clock"), track);

  const menu = el("div", { className: "recent-menu", attrs: { role: "menu" } });
  menu.hidden = true;
  const wrap = el("div", { className: "recent-switch" }, [trigger, menu]);

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside);
  }

  function onOutside(event: MouseEvent): void {
    if (!wrap.isConnected) {
      document.removeEventListener("click", onOutside);
      return;
    }
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    close();
  }

  function fillMenu(): void {
    menu.replaceChildren();
    const items = readRecentSessions();
    if (items.length === 0) {
      menu.append(el("div", { className: "recent-empty", text: tr("还没有访问记录") }));
      return;
    }
    menu.append(el("div", { className: "recent-menu-title", text: tr("最近访问") }));
    for (const item of items.slice(0, 12)) {
      const app = snapshot?.apps.find((candidate) => candidate.appId === item.appId);
      const meta = [app ? shortAgentName(app) : item.appId, recentProjectName(item.projectId), recentTime(item.at)];
      // 最近访问只存了标题等静态信息，执行状态要回到当前快照里查。
      const running = snapshot?.sessions.some(
        (session) => session.sessionId === item.sessionId && session.busy === true,
      ) === true;
      const unread = unreadAt(item.sessionId) !== undefined;
      const entry = button(
        "",
        () => {
          close();
          navigate({
            level: "chat",
            appId: item.appId,
            projectId: item.projectId,
            sessionId: item.sessionId,
          });
        },
        "recent-menu-item",
      );
      entry.setAttribute("role", "menuitem");
      entry.append(
        el("span", { className: "recent-menu-name" }, [
          ...(running ? [el("span", { className: "spinner recent-spinner" })] : []),
          ...(unread
            ? [el("span", { className: "unread-dot", attrs: { role: "img", title: tr("未读"), "aria-label": tr("未读") } })]
            : []),
          el("span", { className: "recent-menu-text", text: item.title }),
        ]),
        el("span", { className: "recent-menu-meta", text: meta.join(" · ") }),
      );
      menu.append(entry);
    }
  }

  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    fillMenu();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside);
  });

  return wrap;
}

/**
 * 顶栏会话切换键：先回上一条会话，再点就回到刚才那条，
 * 两条会话之间可以一直这样来回切。
 */
function previousSessionButton(): HTMLElement | null {
  const prev = previousTrailEntry();
  if (!prev) return null;
  const label = prev.step === "back" ? tr("上一个对话") : tr("回到刚才");
  const node = button(
    "",
    () => {
      const target = previousTrailEntry();
      if (!target) return;
      // 先把指针挪到目标上：那一页渲染时轨迹命中同一项，不会再往后追加。
      trailIndex += target.step === "back" ? -1 : 1;
      location.hash = target.hash;
    },
    "btn ghost small prev-session-btn",
  );
  node.append(icon("swap"), el("span", { className: "prev-session-label", text: label }));
  node.setAttribute("aria-label", `${label}：${prev.title}`);
  node.title = `${label}：${prev.title}`;
  return node;
}

function agentSwitcher(route: Route): HTMLElement | null {
  const apps = snapshot?.apps ?? [];
  if (apps.length === 0) return null;
  const current = "appId" in route ? apps.find((item) => item.appId === route.appId) : undefined;
  const trigger = el("button", {
    className: "btn ghost small agent-switch-btn",
    attrs: {
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": tr("切换 Agent"),
    },
  });
  trigger.append(
    icon("swap"),
    el("span", { className: "agent-switch-label", text: current ? shortAgentName(current) : "Agent" }),
    icon("chevron", "icon agent-switch-chev"),
  );
  const menu = el("div", { className: "agent-menu", attrs: { role: "menu" } });
  menu.hidden = true;
  const wrap = el("div", { className: "agent-switch" }, [trigger, menu]);

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside);
  }

  function onOutside(event: MouseEvent): void {
    if (!wrap.isConnected) {
      document.removeEventListener("click", onOutside);
      return;
    }
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    close();
  }

  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside);
  });

  for (const item of apps) {
    const active = item.appId === current?.appId;
    const entry = button(
      "",
      () => {
        close();
        navigate({ level: "projects", appId: item.appId });
      },
      `agent-menu-item${active ? " is-active" : ""}`,
    );
    entry.setAttribute("role", "menuitem");
    entry.append(
      el("span", { className: "agent-menu-name", text: item.name }),
      el("span", { className: "agent-menu-state", text: active ? tr("当前") : statusLabel(item.status) }),
    );
    menu.append(entry);
  }
  return wrap;
}

/**
 * 落地页地址。预览客户端在自有预览域（旧部署仍在 workers.dev）上，写不到 pages.dev 的 cookie，
 * 所以回链用非敏感的 ?ab_paired=1 标记让落地页切到已配对状态；生产仍只靠 cookie。
 */
function craftsteadLanding(paired: boolean): string {
  if (!isPreviewDeployment()) return "https://craftstead.app/agent-bridge";
  const base = "https://develop.craftstead.pages.dev/agent-bridge";
  return paired ? base + "?ab_paired=1" : base;
}

function renderTopbar(crumbs: Crumb[]): HTMLElement {
  // 预览部署在预览域上，回链也停在预览官网，别把试用的人送去生产。
  const landing = craftsteadLanding(true);
  const nav = el("nav", { className: "crumbs", attrs: { "aria-label": tr("位置") } });
  crumbs.forEach((crumb, index) => {
    if (index > 0) nav.append(el("span", { className: "crumb-sep", text: "/" }));
    if (crumb.href && index < crumbs.length - 1) {
      const link = el("a", { className: "crumb", text: crumb.label, attrs: { href: crumb.href } });
      nav.append(link);
    } else {
      nav.append(el("span", { className: "crumb current", text: crumb.label }));
    }
  });

  const right = el("div", { className: "topbar-actions" });
  if (reconnectMessage) {
    const chip = reconnectChip();
    const text = chip.querySelector(".reconnect-text");
    if (text) text.textContent = reconnectMessage;
    right.append(chip);
  }
  if (connected) {
    if (parseRoute().level === "chat") {
      const previous = previousSessionButton();
      if (previous) right.append(previous);
    }
    const recents = recentSessionsButton();
    if (recents) right.append(recents);
    const switcher = agentSwitcher(parseRoute());
    if (switcher) right.append(switcher);
    // 桌面上直接平铺；手机上这几个按钮会把顶栏撑出屏宽，折进「更多」菜单。
    const secondary = el("div", { className: "topbar-secondary" });
    const notify = notifyButton();
    if (notify) secondary.append(notify);
    secondary.append(
      el("span", { className: "conn", attrs: { title: `Bridge ${connected.info.version}` } }, [
        el("span", { className: "dot" }),
        el("span", { text: connected.info.name }),
        el("span", { className: "conn-version", text: `v${connected.info.version}` }),
      ]),
      languageButton(),
      button(tr("设备"), () => navigate({ level: "devices" }), "btn ghost small"),
      button(tr("断开"), showHome, "btn ghost small"),
    );
    right.append(topbarOverflow(secondary));
  }
  return el("header", { className: "topbar" }, [
    el("a", { className: "brand", attrs: { href: hashFor({ level: "clients" }) } }, [
      el("span", { className: "brand-mark", text: "AB" }),
      el("span", { className: "brand-name", text: "Agent Bridge" }),
    ]),
    dockToggleButton(),
    el(
      "a",
      {
        className: "craftstead-mark",
        attrs: {
          href: landing,
          "aria-label": "Built by Craftstead",
          title: "Built by Craftstead",
        },
      },
      [
        el("span", { className: "craftstead-dot", attrs: { "aria-hidden": "true" } }),
        el("span", { className: "craftstead-name", text: "Craftstead" }),
      ],
    ),
    nav,
    right,
  ]);
}

/**
 * 窄屏顶栏放不下「提醒 / 设备 / 断开」，收进一个下拉；宽屏用 CSS 把面板展开平铺，
 * 同一批按钮在两种布局里共用，状态（提醒开没开）不用维护两份。
 */
function topbarOverflow(panel: HTMLElement): HTMLElement {
  const toggle = button("", () => setOpen(!panel.classList.contains("is-open")), "btn ghost small topbar-more");
  toggle.append(icon("more"));
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", tr("更多操作"));

  const wrap = el("div", { className: "topbar-more-wrap" }, [toggle, panel]);

  function onOutside(event: MouseEvent): void {
    if (!wrap.isConnected) {
      document.removeEventListener("click", onOutside);
      return;
    }
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    setOpen(false);
  }

  function setOpen(open: boolean): void {
    panel.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) document.addEventListener("click", onOutside);
    else document.removeEventListener("click", onOutside);
  }

  return wrap;
}

/**
 * 语言切换：下拉里每一条都用该语言的自称，点了整页重载。
 */
function languageButton(): HTMLSelectElement {
  const node = el("select", {
    className: "btn ghost small lang-btn",
    attrs: { "aria-label": tr("切换语言"), title: tr("切换语言") },
  }) as HTMLSelectElement;
  for (const item of LANGS) {
    const option = el("option", { text: item.label, attrs: { value: item.id } }) as HTMLOptionElement;
    if (item.id === langId()) option.selected = true;
    node.append(option);
  }
  node.addEventListener("change", () => setLang(node.value as (typeof LANGS)[number]["id"]));
  return node;
}

/**
 * Completion notifications need the browser's permission, which only a user gesture can
 * request in Safari; the topbar button is that gesture, and it also switches them off.
 */
function notifyButton(): HTMLButtonElement | null {
  // iPhone 的 Safari 窗口里没有推送能力，但按钮留着才能告诉用户先装到主屏幕。
  if (!notificationsSupported() && !iosNeedsInstall()) return null;
  const denied = notificationPermission() === "denied";
  const enabled = notificationsOn();
  const node = button("", () => void toggleNotifications(), `btn ghost small notify-btn${enabled ? " is-on" : ""}`);
  node.append(icon(enabled ? "bell" : "bellOff"), el("span", { text: enabled ? tr("提醒已开") : tr("开启提醒") }));
  node.title = !notificationsSupported()
    ? IOS_HINT
    : denied
      ? tr("通知已被浏览器禁止，请在站点设置中允许通知")
      : enabled
        ? tr("关闭完成与待回答提醒")
        : tr("开启浏览器提醒：对话完成或等你回答时推送到通知中心");
  return node;
}

async function toggleNotifications(): Promise<void> {
  if (!notificationsSupported()) {
    if (iosNeedsInstall()) window.alert(IOS_HINT);
    return;
  }
  if (notificationsOn() || pushOn()) {
    await unsubscribePush();
    try {
      localStorage.setItem(NOTIFY_KEY, "0");
    } catch {
      // storage unavailable; the choice lasts this page only
    }
    void renderRoute(true);
    return;
  }
  if (notificationPermission() === "denied") {
    window.alert(tr(`通知已被浏览器禁止。请在浏览器的站点设置中允许通知，然后刷新页面。\n\n{0}`, IOS_HINT));
    return;
  }
  if (notificationPermission() !== "granted") {
    let result: NotificationPermission = "denied";
    try {
      result = await Notification.requestPermission();
    } catch {
      result = "denied";
    }
    if (result !== "granted") return;
  }
  try {
    localStorage.setItem(NOTIFY_KEY, "1");
  } catch {
    // storage unavailable; the choice lasts this page only
  }
  let problem: string | null = null;
  if (pushSupported()) {
    try {
      problem = await subscribePush();
    } catch (error) {
      problem = messageOf(error);
    }
  } else {
    problem = tr("这个浏览器只能在页面打开时提醒");
  }
  if (problem) window.alert(`${problem}。\n\n${IOS_HINT}`);
  void renderRoute(true);
}

async function renderRoute(soft = false): Promise<void> {
  stopPolling();
  if (!connected) {
    showHome();
    return;
  }
  const route = parseRoute();
  // 整页重绘后旧表单容器已经不在页面上，之前挂起的延迟重绘也就没有意义了。
  deferredListRender = false;
  if (hostedDraft && (route.level !== "sessions" || route.projectId !== hostedDraft.projectId)) {
    hostedDraft = null;
  }
  if (desktopDraft && (route.level !== "sessions" || route.projectId !== desktopDraft.projectId)) {
    desktopDraft = null;
  }
  if (soft && chatResume && chatResumeKey === hashFor(route)) {
    chatResume();
    // 重连会清空快照；这里补拉一次，分享等依赖全局数据的操作才不会静默失效。
    if (!snapshot) void ensureSnapshot().catch(() => {});
    return;
  }
  const token = ++renderToken;
  chatResume = null;
  chatResumeKey = null;
  if (!snapshot) {
    if (!soft) renderShell(skeletonView(route), crumbsFor(route));
    try {
      await ensureSnapshot();
    } catch (error) {
      progressDone();
      if (token !== renderToken) return;
      renderShell(errorView(tr("读取失败"), messageOf(error)), crumbsFor(route));
      return;
    }
    progressDone();
    if (token !== renderToken) return;
  }
  if (route.level === "clients") renderClients();
  else if (route.level === "projects") renderProjects(route);
  else if (route.level === "sessions") renderSessions(route);
  else if (route.level === "devices") renderDevices();
  else if (route.taskId) await renderTask({ ...route, taskId: route.taskId }, token);
  else await renderChat(route, token);
  if (route.level === "clients" || route.level === "projects" || route.level === "sessions") {
    startSnapshotPolling(token);
  }
}

/**
 * 列表页只加载一次快照的话，桌面上新建的会话要整页重载才看得到；这里按固定间隔重新拉取，
 * 内容有变化才重绘，避免打断正在看列表的人。
 */
function startSnapshotPolling(token: number): void {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshSnapshot(token);
  }, 5_000);
}

/**
 * 聊天页只轮询当前会话，侧栏那批会话走的是 session.list 快照（10 秒一次）。
 * 发送或回合状态一变就先按已知状态改掉快照里的这一条，侧栏「运行中」才不会滞后。
 */
function markSessionState(sessionId: string, busy: boolean): void {
  if (!snapshot) return;
  const index = snapshot.sessions.findIndex((item) => item.sessionId === sessionId);
  const session = snapshot.sessions[index];
  if (!session) return;
  if (session.busy === busy && (!busy || session.live)) return;
  const sessions = [...snapshot.sessions];
  sessions[index] = busy ? { ...session, busy: true, live: true } : { ...session, busy: false };
  snapshot = { ...snapshot, sessions };
  syncDockSessions();
}

function snapshotSignature(): string {
  if (!snapshot) return "";
  return [
    snapshot.apps.length,
    snapshot.projects.length,
    ...snapshot.sessions.map(
      (session) =>
        `${session.sessionId}:${session.updatedAt}:${session.live ? 1 : 0}:${session.busy ? 1 : 0}:${
          unreadAt(session.sessionId) !== undefined ? 1 : 0
        }`,
    ),
  ].join("|");
}

async function refreshSnapshot(token: number): Promise<void> {
  const before = snapshotSignature();
  try {
    await ensureSnapshot(true);
  } catch {
    return;
  }
  // 拉取期间可能已经打开会话或切到别的页：那次渲染有自己的 renderToken，
  // 这里再 renderRoute() 会把正在编辑的输入区整个重建掉。
  if (token !== renderToken) return;
  if (snapshotSignature() === before) return;
  repaintList();
}

/**
 * 列表数据变了就重绘。新建托管会话的表单是就地展开的，整页重绘会清掉正在输入的标题，
 * 所以表单打开期间先记下来，等它从页面上消失后再补画一次。
 */
/**
 * dock 里正在编辑时把整页重绘推迟到失焦之后。列表轮询每 5 秒一次，
 * 直接 renderRoute() 会把待办输入框和光标一起换掉，看起来就是「输入没完就被刷新」。
 * 返回 true 表示这次先不画。
 */
function deferForDockFocus(): boolean {
  if (!captureDockFocus()) return false;
  if (dockRenderDeferred) return true;
  dockRenderDeferred = true;
  document.activeElement?.addEventListener(
    "blur",
    () => {
      if (!dockRenderDeferred) return;
      dockRenderDeferred = false;
      // 失焦后立刻重绘可能赶不上用户点回输入框，稍等一下再确认。
      window.setTimeout(() => {
        if (captureDockFocus()) return;
        void renderRoute();
      }, 300);
    },
    { once: true },
  );
  return true;
}

function repaintList(): void {
  // 待办输入框正在打字：先别整页重绘，等失焦了再补一次。
  if (deferForDockFocus()) return;
  const host = document.querySelector(".hosted-create-host");
  if (!host || host.childElementCount === 0) {
    void renderRoute();
    return;
  }
  if (deferredListRender) return;
  deferredListRender = true;
  const observer = new MutationObserver(() => {
    if (host.childElementCount > 0) return;
    observer.disconnect();
    const pending = deferredListRender;
    deferredListRender = false;
    // 表单被整页替换（提交后跳到聊天页）时那次导航已经画过了，不要再画一遍。
    if (pending && host.isConnected) void renderRoute();
  });
  observer.observe(host, { childList: true });
}

function viewHead(eyebrow: string, title: string, meta: string, extra?: HTMLElement): HTMLElement {
  return el("header", { className: "view-head" }, [
    el("div", { className: "view-head-main" }, [
      el("p", { className: "eyebrow", text: eyebrow }),
      el("h1", { className: "display", text: title }),
      el("p", { className: "meta", text: meta }),
    ]),
    ...(extra ? [extra] : []),
  ]);
}

function renderClients(): void {
  const data = snapshot!;
  const route: Route = { level: "clients" };
  const totalProjects = data.projects.length;
  const totalSessions = data.sessions.length;
  setTitle(tr("客户端 · Agent Bridge"));

  const list = el("ul", { className: "list" });
  if (data.apps.length === 0) {
    list.append(el("li", {}, [emptyState(tr("没有可用的客户端"), tr("Bridge 没有发现任何桌面适配器。"))]));
  }
  for (const item of data.apps) {
    const projects = data.projects.filter((project) => project.appId === item.appId);
    const sessions = data.sessions.filter((session) => session.appId === item.appId);
    const unread = unreadCount(sessions);
    const row = el("button", { className: `row client-row${item.status === "ready" ? "" : " muted-row"}`, attrs: { type: "button" } }, [
      el("span", { className: "mark", text: agentMark(item.kind) }),
      el("span", { className: "row-main" }, [
        el("strong", { className: "row-title", text: item.name }),
        el("span", {
          className: "meta",
          text: tr(`{0} 个工程 · {1} 个会话{2} · 枚举{3} · 读取{4} · {5}`, projects.length, sessions.length, unread > 0 ? tr(` · {0} 未读`, unread) : "", completenessLabel(item.capabilities.enumerate), completenessLabel(item.capabilities.read), item.capabilities.send ? tr("可发送") : tr("不可发送")),
        }),
        ...(item.capabilities.reason || item.capabilities.sendDetail
          ? [el("span", { className: "meta dim", text: item.capabilities.reason ?? item.capabilities.sendDetail ?? "" })]
          : []),
      ]),
      el("span", { className: item.status === "ready" ? "pill ok" : "pill warn", text: statusLabel(item.status) }),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () => navigate({ level: "projects", appId: item.appId }));
    list.append(el("li", {}, [row]));
  }

  renderShell(
    el("main", { className: "main" }, [
      viewHead(tr("客户端"), tr("已连接的客户端"), tr(`{0} 个客户端 · {1} 个工程 · {2} 个会话`, data.apps.length, totalProjects, totalSessions)),
      ...(connected ? [selfDeviceCard()] : []),
      list,
      button(tr("刷新列表"), () => {
        snapshot = null;
        void renderRoute();
      }, "btn ghost"),
    ]),
    crumbsFor(route),
  );
}

function renderProjects(route: Route & { level: "projects" }): void {
  const data = snapshot!;
  const appInfo = data.apps.find((item) => item.appId === route.appId);
  setTitle(tr(`{0} · Agent Bridge`, appInfo?.name ?? tr("客户端")));
  const projects = data.projects.filter((project) => project.appId === route.appId);

  const list = el("ul", { className: "list" });
  if (projects.length === 0) {
    list.append(el("li", {}, [emptyState(tr("这个客户端还没有工程"), tr("桌面应用里创建或打开一个工程后，再回来刷新。"))]));
  }
  for (const project of projects) {
    const sessions = data.sessions.filter((session) => session.projectId === project.projectId);
    const unread = unreadCount(sessions);
    const row = el("button", { className: "row", attrs: { type: "button" } }, [
      el("span", { className: "mark mono", text: initials(project.name) }),
      el("span", { className: "row-main" }, [
        el("strong", { className: "row-title", text: project.name }),
        el("span", { className: "meta mono path", text: project.cwd ?? project.projectId }),
      ]),
      el("span", {
        className: "row-count",
        text: tr(`{0} 个会话{1}`, sessions.length || project.sessionCount, unread > 0 ? tr(` · {0} 未读`, unread) : ""),
      }),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () => navigate({ level: "sessions", appId: route.appId, projectId: project.projectId }));
    list.append(el("li", {}, [row]));
  }

  const isHosted = route.appId === "hosted";
  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "clients" })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: appInfo?.name ?? tr("客户端") }),
          el("h1", { className: "display", text: tr("工程") }),
          el("p", {
            className: "meta",
            // 白名单只在这台 Mac 上改：远程设备连读到的列表都不该能自己扩。
            text: tr(`{0} 个工程，按会话数量排列{1}`, projects.length, isHosted ? tr("；托管目录只能在 Mac 菜单栏的「设定」里修改") : ""),
          }),
        ]),
        button(
          tr("刷新"),
          () => {
            snapshot = null;
            void renderRoute();
          },
          "btn ghost small",
        ),
      ]),
      list,
    ]),
    crumbsFor(route),
  );
}

function renderSessions(route: Route & { level: "sessions" }): void {
  const data = snapshot!;
  const project = data.projects.find((item) => item.projectId === route.projectId);
  const appInfo = data.apps.find((item) => item.appId === route.appId);
  setTitle(tr(`{0} · Agent Bridge`, project?.name ?? tr("工程")));
  const projectSessions = data.sessions.filter((session) => session.projectId === route.projectId);
  const archivedCount = projectSessions.filter((session) => session.archived).length;
  const sessions = visibleSessions(projectSessions, showArchived);
  const createDetail = appInfo && !appInfo.capabilities.create ? appInfo.capabilities.createDetail : undefined;
  const isHosted = appInfo?.appId === "hosted";
  const canCreateHosted = isHosted && appInfo?.capabilities.create === true && Boolean(project?.cwd);
  // 桌面客户端（例如 dsh）也能从网页新建：Bridge 代它起一次无界面运行，第一条消息随创建发出。
  const canCreateDesktop = !isHosted && appInfo?.capabilities.create === true && Boolean(project?.cwd);
  const panelHost = canCreateHosted || canCreateDesktop ? el("div", { className: "hosted-create-host" }) : null;
  const draft = project && hostedDraft?.projectId === project.projectId ? hostedDraft : null;
  if (panelHost && project && draft) panelHost.append(hostedCreatePanel(project, draft));
  const desktopPanelDraft = project && desktopDraft?.projectId === project.projectId ? desktopDraft : null;
  if (panelHost && project && appInfo && desktopPanelDraft) {
    panelHost.append(desktopCreatePanel(project, appInfo, desktopPanelDraft));
  }
  const openCreate = async (): Promise<void> => {
    if (!panelHost || !project || !appInfo) return;
    if (canCreateDesktop) {
      desktopDraft = { projectId: project.projectId, text: "" };
      panelHost.replaceChildren(desktopCreatePanel(project, appInfo, desktopDraft));
    } else {
      // 默认沿用上一次创建时的选项；Bridge 没记过（第一次用）就退回手动 / Claude Code。
      // 现取一次而不是用页面里缓存的：别的标签页建过会话后缓存就是旧的。
      const last = await fetchHostedCreateDefaults();
      hostedDraft = {
        projectId: project.projectId,
        title: "",
        model: last?.model ?? "",
        piModel: last?.piModel ?? "",
        effort: last?.effort ?? "",
        mode: last?.permissionMode ?? "manual",
        agent: last?.agent ?? "claude",
        subagentModel: last?.subagentModel ?? "",
        piThinking: last?.piThinking ?? "",
        subagentThinking: last?.subagentThinking ?? "",
      };
      panelHost.replaceChildren(hostedCreatePanel(project, hostedDraft));
    }
    panelHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const list = el("ul", { className: "list" });
  if (sessions.length === 0) {
    list.append(
      el("li", {}, [
        isHosted
          ? emptyState(tr("还没有托管会话"), tr("点「新建托管会话」，由这台 Mac 上的 Bridge 启动一个 Claude Code 或 pi 进程。"))
          : canCreateDesktop
            ? emptyState(tr("这个工程还没有会话"), tr(`点「新对话」，由这台 Mac 上的 Bridge 启动一次 {0}。`, appInfo?.name ?? tr("桌面客户端")))
            : emptyState(tr("这个工程还没有会话"), tr("在桌面应用里开始一次对话后，再回来刷新。")),
      ]),
    );
  }
  for (const session of sessions) {
    const busy = session.busy === true;
    const unread = unreadAt(session.sessionId) !== undefined;
    const state = busy
      ? tr("正在执行")
      : session.hosted
        ? session.canSend
          ? session.live
            ? tr("Bridge 托管进程运行中")
            : tr("Bridge 托管，发送时自动恢复")
          : (session.sendBlockedReason ?? tr("只读"))
        : session.canSend
          ? session.live
            ? tr("桌面运行中，可发送")
            : sendStateLabel(session)
          : (session.sendBlockedReason ?? tr("只读"));
    // 托管会话的模型和权限模式在列表里也常驻显示，不必点进侧栏才知道。
    const hostedFacts = session.hosted
      ? tr(` · 模型 {0} · {1}`, hostedModelLabel(session.model), hostedModeFact(session))
      : "";
    const row = el("button", { className: "row", attrs: { type: "button" } }, [
      el(
        "span",
        { className: `mark ${busy ? "busy" : session.live ? "live" : ""}` },
        busy
          ? [el("span", { className: "spinner mark-spinner" })]
          : [document.createTextNode(agentMark(session.kind, session.hostedAgent))],
      ),
      el("span", { className: "row-main" }, [
        el("strong", { className: "row-title" }, [
          ...(session.pinned ? [icon("pin", "icon pin-mark")] : []),
          document.createTextNode(session.title),
        ]),
        ...(session.originalTitle
          ? [el("span", { className: "row-original", text: tr(`原名：{0}`, session.originalTitle) })]
          : []),
        el("span", {
          className: "meta",
          text: `${timeLabel(session.updatedAt)} · ${state}${hostedFacts}`,
        }),
      ]),
      busy
        ? el("span", { className: "pill busy" }, [
            el("span", { className: "spinner" }),
            document.createTextNode(tr("执行中")),
          ])
        : el("span", { className: session.canSend ? "pill ok" : "pill", text: sendStateLabel(session) }),
      ...(unread ? [el("span", { className: "pill unread", text: tr("未读") })] : []),
      ...(session.archived ? [el("span", { className: "pill", text: tr("已归档") })] : []),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () =>
      navigate({ level: "chat", appId: route.appId, projectId: route.projectId, sessionId: session.sessionId }),
    );
            // 行上的操作浮在右侧，鼠标移上来才出现，免得和行本身的状态标挤在一起。
    const actions = el("div", { className: "row-menu" }, [
      ...(unread
        ? []
        : [
            rowAction(icon("unread"), tr("标为未读"), () => {
              markUnread(session.sessionId, Date.now());
              syncDockSessions();
              void renderRoute();
            }),
          ]),
      rowAction(
        session.pinned ? icon("pinOff") : icon("pin"),
        session.pinned ? tr("取消置顶") : tr("置顶"),
        () => void setSessionPinned(session, !session.pinned),
      ),
      ...(session.hosted
        ? [
            rowAction(
              session.archived ? icon("unarchive") : icon("archive"),
              session.archived ? tr("取消归档") : tr("归档"),
              () => void setSessionArchived(session, !session.archived),
            ),
            rowAction(icon("trash"), tr("删除"), () => void deleteHostedSession(session), "danger"),
          ]
        : []),
    ]);
    list.append(el("li", { className: session.archived ? "row-item is-archived" : "row-item" }, [row, actions]));
  }

  const createHosted = canCreateHosted || canCreateDesktop ? button("", () => void openCreate(), "btn small create-btn") : null;
  if (createHosted) {
    createHosted.append(
      el("span", {
        className: "create-label-full",
        text: canCreateHosted ? tr("新建托管会话") : tr("新对话"),
      }),
      el("span", { className: "create-label-short", text: tr("新建") }),
    );
  }

  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "projects", appId: route.appId })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: tr(`{0}{1}`, appInfo?.name ?? tr("客户端"), project?.cwd ? ` · ${project.cwd}` : "") }),
          el("h1", { className: "display", text: project?.name ?? tr("会话") }),
          el("p", {
            className: "meta",
            text: isHosted
              ? tr(`{0} 个会话 · 由这台 Mac 上的 Bridge 托管，不出现在桌面应用`, sessions.length)
              : tr(`{0} 个会话 · 置顶在前，其余按最近更新{1}`, sessions.length, createDetail ? tr(" · 无法新建对话") : ""),
          }),
        ]),
        ...(archivedCount > 0
          ? [
              button(
                showArchived ? tr(`隐藏已归档（{0}）`, archivedCount) : tr(`显示已归档（{0}）`, archivedCount),
                () => {
                  showArchived = !showArchived;
                  void renderRoute();
                },
                `btn ghost small${showArchived ? " is-on" : ""}`,
              ),
            ]
          : []),
        ...(createHosted ? [createHosted] : []),
        ...(createDetail && !isHosted && !canCreateDesktop
          ? [
              el("button", {
                className: "btn ghost small create-btn",
                text: tr("新对话"),
                attrs: { type: "button", disabled: "", title: createDetail },
              }),
            ]
          : []),
        button(
          tr("刷新"),
          () => {
            snapshot = null;
            void renderRoute();
          },
          "btn ghost small",
        ),
      ]),
      ...(data.note ? [el("p", { className: "hint", text: data.note })] : []),
      ...(panelHost ? [panelHost] : []),
      list,
    ]),
    crumbsFor(route),
  );
}

/** 权限模式的说明文案；bridge 只下发部分模式，未知值不显示说明。 */
const HOSTED_MODE_HELP: Record<string, { short: string; detail: string }> = {
  manual: {
    short: tr("每次操作都要确认"),
    detail: tr("文件编辑、shell 命令、联网访问都会停下来等你确认。最安全的日常模式。"),
  },
  acceptEdits: {
    short: tr("工作目录内编辑免确认"),
    detail: tr("工作目录内的文件编辑，以及 mkdir/rm/mv/cp/sed 等常见文件命令自动放行；目录外路径、受保护路径（.git/.claude 等）和其它 shell 命令仍要确认。"),
  },
  plan: {
    short: tr("先出计划不动手"),
    detail: tr("只读代码并给出计划，不修改源码；计划批准后才按选定方式执行。不是完全只读。"),
  },
  dontAsk: {
    short: tr("不问，需要确认的直接拒绝"),
    detail: tr("不会弹出确认：凡是需要确认的操作一律自动拒绝，只运行只读命令和已预先授权的操作。无人值守时最安全，但联网、写文件常被拒。"),
  },
  auto: {
    short: tr("分类器自动判定"),
    detail: tr("由分类器逐个审查动作：明显危险的被拦下并说明原因，其余自动放行；只有少数情况仍会询问。"),
  },
  bypassPermissions: {
    short: tr("跳过权限检查"),
    detail: tr("不再询问、跳过安全检查，deny 规则和 sandbox（文件/网络隔离）仍然生效。只应在隔离环境里用。"),
  },
};

/** 会话列表与聊天页顶部用：权限模式的中文短名，未知值原样显示。 */
function hostedModeShort(mode: string | undefined): string {
  if (!mode) return "manual";
  return HOSTED_MODE_HELP[mode]?.short ?? mode;
}

/** 托管会话的权限事实：pi 没有权限模式，写引擎名，免得显示一个不生效的 manual。 */
function hostedModeFact(session: SessionSummary): string {
  return session.hostedAgent === "pi" ? tr("pi 托管") : tr(`权限 {0}`, hostedModeShort(session.permissionMode));
}

/** 托管会话的模型：记录过就用记录值，否则说明沿用 CLI 默认。 */
function hostedModelLabel(model: string | undefined): string {
  return model ? model : tr("CLI 默认");
}

function effortLabel(level: string): string {
  const known: Record<string, string> = {
    off: tr("关闭"),
    minimal: tr("最少"),
    low: tr("低"),
    medium: tr("中"),
    high: tr("高"),
    xhigh: tr("更高"),
    max: tr("最高"),
  };
  return known[level] ? `${known[level]}（${level}）` : level;
}

/** pi 的思考等级：`pi --thinking` 与子代理的 `defaultThinking` 共用这一套取值。 */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 新建托管会话时加的启动参数：列表与勾选状态都记在浏览器本地。 */
interface HostedArgPref {
  value: string;
  enabled: boolean;
}

const HOSTED_ARGS_KEY = "ab.hostedArgs";
const MAX_HOSTED_ARGS = 24;
let hostedArgPrefs: HostedArgPref[] | null = null;

function loadHostedArgPrefs(): HostedArgPref[] {
  if (hostedArgPrefs) return hostedArgPrefs;
  let items: HostedArgPref[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HOSTED_ARGS_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      items = raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          value: String(item["value"] ?? "").trim(),
          enabled: item["enabled"] !== false,
        }))
        .filter((item) => item.value !== "")
        .slice(0, MAX_HOSTED_ARGS);
    }
  } catch {
    items = [];
  }
  hostedArgPrefs = items;
  return items;
}

function saveHostedArgPrefs(): void {
  if (!hostedArgPrefs) return;
  try {
    localStorage.setItem(HOSTED_ARGS_KEY, JSON.stringify(hostedArgPrefs));
  } catch {
    // 隐私模式下写不进去：这一次照样生效，只是下次不再记住。
  }
}

function hostedCreatePanel(
  project: ProjectInfo,
  draft: {
    title: string;
    model: string;
    piModel: string;
    effort: string;
    mode: string;
    agent: HostedAgent;
    subagentModel: string;
    piThinking: string;
    subagentThinking: string;
  },
): HTMLElement {
  const form = el("form", { className: "panel hosted-create" });
  const status = el("p", { className: "hint", text: tr("正在读取 Bridge 允许的目录与权限模式…") });
  const agent = el("select", { className: "input", attrs: { "aria-label": tr("托管引擎") } });
  agent.append(el("option", { text: "Claude Code", attrs: { value: "claude" } }));
  const mode = el("select", { className: "input" });
  const modeHint = el("p", { className: "hint" });
  const model = el("select", { className: "input", attrs: { "aria-label": tr("模型") } });
  model.append(el("option", { text: tr("CLI 默认"), attrs: { value: "" } }));
  const effort = el("select", { className: "input", attrs: { "aria-label": tr("思考程度") } });
  effort.append(el("option", { text: tr("CLI 默认"), attrs: { value: "" } }));
  // pi 的主模型：清单来自 pi 自己的模型配置（hosted.options 的 piModels）。
  const piModel = el("select", { className: "input", attrs: { "aria-label": tr("pi 模型") } });
  piModel.append(el("option", { text: tr("pi 默认"), attrs: { value: "" } }));
  piModel.addEventListener("change", () => {
    draft.piModel = piModel.value;
  });
  // 子代理模型只认 pi 认识的模型名：清单来自 hosted.options 的 piModels，读不到才手填。
  const subagentSelect = el("select", { className: "input", attrs: { "aria-label": tr("子代理模型") } });
  subagentSelect.append(el("option", { text: tr("跟随 pi 设置"), attrs: { value: "" } }));
  subagentSelect.hidden = true;
  subagentSelect.addEventListener("change", () => {
    draft.subagentModel = subagentSelect.value;
  });
  const subagentModel = el("input", {
    className: "input mono",
    attrs: {
      type: "text",
      placeholder: tr("例如 group/dsgroup；留空跟随 pi 设置"),
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": tr("子代理模型"),
    },
  });
  subagentModel.value = draft.subagentModel;
  subagentModel.addEventListener("input", () => {
    draft.subagentModel = subagentModel.value;
  });
  // pi 的思考等级：主模型用 `--thinking`，子代理写进 settings.json 的 defaultThinking。
  const piThinking = el("select", { className: "input", attrs: { "aria-label": tr("pi 思考等级") } });
  piThinking.append(el("option", { text: tr("跟随 pi 设置"), attrs: { value: "" } }));
  piThinking.append(
    ...PI_THINKING_LEVELS.map((level) => el("option", { text: effortLabel(level), attrs: { value: level } })),
  );
  piThinking.value = draft.piThinking;
  piThinking.addEventListener("change", () => {
    draft.piThinking = piThinking.value;
  });
  const subagentThinking = el("select", { className: "input", attrs: { "aria-label": tr("子代理思考等级") } });
  subagentThinking.append(el("option", { text: tr("跟随 pi 设置"), attrs: { value: "" } }));
  subagentThinking.append(
    ...PI_THINKING_LEVELS.map((level) => el("option", { text: effortLabel(level), attrs: { value: level } })),
  );
  subagentThinking.value = draft.subagentThinking;
  subagentThinking.addEventListener("change", () => {
    draft.subagentThinking = subagentThinking.value;
  });
  let piModelList: ModelOption[] = [];
  const optionsHint = el("p", { className: "hint", text: tr("正在读取本机 CLI 支持的模型与思考程度…") });
  const effortHint = el("p", { className: "hint", text: tr("思考程度越高，回答更细致，但更慢也更费额度。") });
  const title = el("input", {
    className: "input",
    attrs: { type: "text", placeholder: tr("标题（可选）"), maxlength: "60" },
  });
  model.addEventListener("change", () => {
    draft.model = model.value;
  });
  effort.addEventListener("change", () => {
    draft.effort = effort.value;
  });
  title.value = draft.title;
  title.addEventListener("input", () => {
    draft.title = title.value;
  });
  const argsInput = el("input", {
    className: "input",
    attrs: { type: "text", placeholder: tr("例如 --agent mix-agent，回车添加"), "aria-label": tr("启动参数") },
  });
  const argsList = el("div", { className: "arg-list" });
  const renderArgs = (): void => {
    const prefs = loadHostedArgPrefs();
    if (prefs.length === 0) {
      argsList.replaceChildren(el("p", { className: "hint", text: tr("还没有保存过启动参数。") }));
      return;
    }
    argsList.replaceChildren(
      ...prefs.map((pref) => {
        const box = el("input", { attrs: { type: "checkbox" } });
        box.checked = pref.enabled;
        box.addEventListener("change", () => {
          pref.enabled = box.checked;
          saveHostedArgPrefs();
        });
        const remove = button("×", () => {
          const list = loadHostedArgPrefs();
          const at = list.indexOf(pref);
          if (at >= 0) list.splice(at, 1);
          saveHostedArgPrefs();
          renderArgs();
        }, "arg-remove");
        remove.title = tr("删除这个参数");
        remove.setAttribute("aria-label", tr(`删除 {0}`, pref.value));
        return el("div", { className: "arg-row" }, [
          el("label", { className: "arg-check" }, [box, el("span", { className: "arg-value", text: pref.value })]),
          remove,
        ]);
      }),
    );
  };
  const addArg = (raw: string): void => {
    const value = raw.trim();
    if (!value) return;
    const prefs = loadHostedArgPrefs();
    const existing = prefs.find((item) => item.value === value);
    if (existing) {
      existing.enabled = true;
    } else if (prefs.length < MAX_HOSTED_ARGS) {
      prefs.push({ value, enabled: true });
    }
    saveHostedArgPrefs();
    renderArgs();
  };
  trackIme(argsInput);
  argsInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || isImeEnter(event)) return;
    // 回车只加参数，不提交表单。
    event.preventDefault();
    addArg(argsInput.value);
    argsInput.value = "";
  });
  renderArgs();
  const submit = button(tr("创建"), () => {
    const cwd = project.cwd;
    if (!cwd) return;
    submit.disabled = true;
    status.classList.remove("error");
    const piSelected = draft.agent === "pi";
    status.textContent = tr(`正在启动 {0}…`, piSelected ? "pi" : "Claude Code");
    const permissionMode = (mode.value || "manual") as HostedPermissionMode;
    const extraArgs = loadHostedArgPrefs().filter((item) => item.enabled).map((item) => item.value);
    const chosenModel = piSelected ? draft.piModel.trim() : model.value.trim();
    void call<SessionGetResult>("hosted.create", {
      path: cwd,
      agent: draft.agent,
      permissionMode,
      ...(chosenModel ? { model: chosenModel } : {}),
      ...(!piSelected && effort.value.trim() ? { effort: effort.value.trim() } : {}),
      ...(piSelected && draft.piThinking.trim() ? { thinking: draft.piThinking.trim() } : {}),
      ...(piSelected && draft.subagentModel.trim() ? { subagentModel: draft.subagentModel.trim() } : {}),
      ...(piSelected && draft.subagentThinking.trim() ? { subagentThinking: draft.subagentThinking.trim() } : {}),
      ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
    }, 30_000)
      .then((result) => {
        hostedDraft = null;
        // Chat pages read the cached snapshot, so the new session must be in it
        // before navigating; otherwise the page reports it as missing.
        if (snapshot && !snapshot.sessions.some((item) => item.sessionId === result.session.sessionId)) {
          snapshot = { ...snapshot, sessions: [result.session, ...snapshot.sessions] };
        }
        navigate({
          level: "chat",
          appId: "hosted",
          projectId: result.session.projectId,
          sessionId: result.session.sessionId,
        });
      })
      .catch((error) => {
        submit.disabled = false;
        status.classList.add("error");
        status.textContent = messageOf(error);
      });
  }, "btn small");
  form.addEventListener("submit", (event) => event.preventDefault());
  const syncModeHint = (): void => {
    const help = HOSTED_MODE_HELP[mode.value];
    modeHint.textContent = help ? help.detail : "";
  };
  mode.addEventListener("change", () => {
    draft.mode = mode.value;
    syncModeHint();
  });
  const modeField = el("label", { className: "field" }, [el("span", { text: tr("权限模式") }), mode]);
  const modelField = el("label", { className: "field" }, [el("span", { text: tr("模型") }), model]);
  const piModelField = el("label", { className: "field" }, [el("span", { text: tr("模型") }), piModel]);
  const piThinkingField = el("label", { className: "field" }, [el("span", { text: tr("思考等级") }), piThinking]);
  const effortField = el("label", { className: "field" }, [el("span", { text: tr("思考程度") }), effort]);
  const subagentField = el("label", { className: "field" }, [
    el("span", { text: tr("子代理模型（可选）") }),
    subagentSelect,
    subagentModel,
  ]);
  const subagentThinkingField = el("label", { className: "field" }, [
    el("span", { text: tr("子代理思考等级（可选）") }),
    subagentThinking,
  ]);
  const subagentHint = el("p", { className: "hint" });
  const argsHint = el("p", { className: "hint" });
  const agentHint = el("p", { className: "hint" });
  const syncAgent = (): void => {
    const pi = draft.agent === "pi";
    // pi 没有权限模式与思考程度；模型清单也要等它跑过一次才拿得到，选 pi 时一并收起。
    for (const node of [modeField, modeHint, modelField, effortField, effortHint, optionsHint]) node.hidden = pi;
    piModelField.hidden = !pi;
    piThinkingField.hidden = !pi;
    subagentField.hidden = !pi;
    subagentThinkingField.hidden = !pi;
    subagentHint.hidden = !pi;
    const useSelect = piModelList.length > 0;
    subagentSelect.hidden = !useSelect;
    subagentModel.hidden = useSelect;
    argsHint.textContent = pi
      ? tr("打钩的参数随新建一起传给 pi；--mode、--session 这类会话与协议旗标不接受。")
      : tr("打钩的参数随新建一起传给 claude；会话身份、输出协议与权限相关的旗标不接受。");
    agentHint.textContent = pi
      ? tr("pi 用 `pi --mode rpc` 常驻，斜杠命令、扩展提问与换模型都能在网页里用。")
      : "";
    agentHint.hidden = !pi;
  };
  agent.addEventListener("change", () => {
    draft.agent = agent.value === "pi" ? "pi" : "claude";
    syncAgent();
  });
  form.append(
    el("p", { className: "panel-title", text: tr("新建 Bridge 托管会话") }),
    el("label", { className: "field" }, [
      el("span", { text: tr("工作目录（仅限 Mac 上的允许列表）") }),
      el("input", { className: "input", attrs: { type: "text", value: project.cwd ?? "", readOnly: "" } }),
    ]),
    el("label", { className: "field" }, [el("span", { text: tr("托管引擎") }), agent]),
    agentHint,
    modeField,
    modeHint,
    modelField,
    piModelField,
    piThinkingField,
    effortField,
    effortHint,
    optionsHint,
    subagentField,
    subagentThinkingField,
    subagentHint,
    el("div", { className: "field" }, [el("span", { text: tr("启动参数（可选）") }), argsInput, argsList]),
    argsHint,
    el("label", { className: "field" }, [el("span", { text: tr("标题") }), title]),
    status,
    el("div", { className: "row-actions" }, [submit]),
  );
  syncAgent();
  void call<HostedOptionsResult>("hosted.options")
    .then((info) => {
      const groups: Array<[string, ModelOption[]]> = [
        [tr("自定义"), info.models.filter((item) => item.section === "custom")],
        [tr("常用"), info.models.filter((item) => (item.section ?? "main") === "main")],
        [tr("更多"), info.models.filter((item) => item.section === "overflow")],
      ];
      const modelNodes: Array<Node | string> = [el("option", { text: tr("CLI 默认"), attrs: { value: "" } })];
      // 之前选过、这次清单里没有的模型（换了 CLI 版本）也留着，别把草稿静默改掉。
      if (draft.model && !info.models.some((item) => item.id === draft.model)) {
        modelNodes.push(el("option", { text: tr(`{0}（清单里没有）`, draft.model), attrs: { value: draft.model } }));
      }
      for (const [label, group] of groups) {
        if (group.length === 0) continue;
        modelNodes.push(
          el("optgroup", { attrs: { label } }, group.map((item) => el("option", { text: item.name, attrs: { value: item.id } }))),
        );
      }
      model.replaceChildren(...modelNodes);
      model.value = draft.model;

      const effortNodes: Array<Node | string> = [el("option", { text: tr("CLI 默认"), attrs: { value: "" } })];
      if (draft.effort && !info.efforts.includes(draft.effort)) {
        effortNodes.push(el("option", { text: tr(`{0}（当前 CLI 不认）`, draft.effort), attrs: { value: draft.effort } }));
      }
      effortNodes.push(...info.efforts.map((level) => el("option", { text: effortLabel(level), attrs: { value: level } })));
      effort.replaceChildren(...effortNodes);
      effort.value = draft.effort;

      optionsHint.textContent = info.note ?? "";
      optionsHint.hidden = !info.note;

      piModelList = info.piModels ?? [];
      const piOptionNodes = (current: string, fallback: string): Array<Node | string> => {
        const nodes: Array<Node | string> = [el("option", { text: fallback, attrs: { value: "" } })];
        // 之前选过、这次清单里没有的模型（换了 pi 配置）也留着，别把草稿静默改掉。
        if (current && !piModelList.some((item) => item.id === current)) {
          nodes.push(el("option", { text: tr(`{0}（清单里没有）`, current), attrs: { value: current } }));
        }
        // pi 的清单可能上百项，按 provider 分组，选项里只写模型名（id 在 value 里）。
        const groups = new Map<string, ModelOption[]>();
        for (const item of piModelList) {
          const cut = item.id.indexOf("/");
          const provider = cut > 0 ? item.id.slice(0, cut) : item.id;
          const group = groups.get(provider);
          if (group) group.push(item);
          else groups.set(provider, [item]);
        }
        for (const [provider, group] of groups) {
          nodes.push(
            el(
              "optgroup",
              { attrs: { label: provider } },
              group.map((item) =>
                el("option", {
                  text: item.name === item.id ? item.id.slice(provider.length + 1) : item.name,
                  attrs: { value: item.id },
                }),
              ),
            ),
          );
        }
        return nodes;
      };
      piModel.replaceChildren(...piOptionNodes(draft.piModel, tr("pi 默认")));
      piModel.value = draft.piModel;
      subagentSelect.replaceChildren(...piOptionNodes(draft.subagentModel, tr("跟随 pi 设置")));
      subagentSelect.value = draft.subagentModel;
      subagentHint.textContent =
        piModelList.length > 0
          ? tr("只影响之后新派生的子代理，主模型不动。")
          : tr("读不到 pi 的模型配置，先手填 `厂商/模型`；留空跟随 pi 设置。");

      const agentOptions = info.agents ?? [{ id: "claude" as const, label: "Claude Code", available: true }];
      agent.replaceChildren(
        ...agentOptions.map((item) =>
          el("option", {
            text: item.available ? item.label : tr(`{0}（不可用）`, item.label),
            attrs: {
              value: item.id,
              ...(item.available ? {} : { disabled: "" }),
              ...(item.detail ? { title: item.detail } : {}),
            },
          }),
        ),
      );
      const usable = agentOptions.filter((item) => item.available).map((item) => item.id);
      if (!usable.includes(draft.agent)) draft.agent = usable[0] ?? "claude";
      agent.value = draft.agent;
      syncAgent();
    })
    .catch((error) => {
      optionsHint.classList.add("error");
      optionsHint.textContent = tr(`读不到模型与思考程度：{0}`, messageOf(error));
    });
  void call<HostedDirsResult>("hosted.dirs")
    .then((config) => {
      mode.replaceChildren(
        ...config.permissionModes.map((item) => el("option", {
          text: HOSTED_MODE_HELP[item] ? `${item} — ${HOSTED_MODE_HELP[item].short}` : item,
          attrs: { value: item },
        })),
      );
      mode.value = config.permissionModes.includes(draft.mode as HostedPermissionMode)
        ? draft.mode
        : "manual";
      draft.mode = mode.value;
      syncModeHint();
      const idle = Math.round(config.idleTimeoutMs / 60_000);
      const bypassNote = config.allowBypassPermissions
        ? ""
        : tr("；bypassPermissions 未开放（Mac 侧 hosted.json 的 allowBypassPermissions）");
      // 目录加进白名单不等于能读：macOS 的文件访问授权是第一次真读时才生效的。
      const unauthorized = config.dirs.filter(
        (dir) =>
          dir.allowed !== false &&
          (dir.auth === "denied" || dir.auth === "pending" || dir.auth === "unknown"),
      ).length;
      const authNote = unauthorized > 0 ? tr("；{0} 个目录还没有 macOS 的文件访问授权，索引和读取会失败：到 Mac 上点「允许」，或在菜单栏设置里重新添加一次", unauthorized) : "";
      status.textContent = config.enabled
        ? tr(`只在 {0} 中运行；网页断开不会结束进程，空闲 {1} 分钟后自动停止，再发消息时 resume。{2}`, project.cwd ?? "", idle, bypassNote) + authNote
        : (config.note ?? tr("Bridge 还没有配置可托管的目录。"));
      submit.disabled = !config.enabled;
    })
    .catch((error) => {
      status.classList.add("error");
      status.textContent = messageOf(error);
      submit.disabled = true;
    });
  return form;
}

/** 桌面客户端的新建会话：起点是一条消息，会话由该客户端的无界面模式在工程目录里创建。 */
function desktopCreatePanel(project: ProjectInfo, appInfo: AppInfo, draft: { text: string }): HTMLElement {
  const form = el("form", { className: "panel hosted-create" });
  const status = el("p", { className: "hint", text: appInfo.capabilities.createDetail ?? "" });
  const text = el("textarea", {
    className: "input",
    attrs: { rows: "4", placeholder: tr("第一条消息"), "aria-label": tr("第一条消息") },
  });
  text.value = draft.text;
  text.addEventListener("input", () => {
    draft.text = text.value;
  });
  const submit = button(tr("创建"), () => {
    const message = text.value.trim();
    if (!message) {
      status.classList.add("error");
      status.textContent = tr("先写下第一条消息");
      return;
    }
    submit.disabled = true;
    status.classList.remove("error");
    status.textContent = tr(`正在启动 {0}…`, appInfo.name);
    void call<SessionCreateResult>(
      "session.create",
      { appId: appInfo.appId, projectId: project.projectId, text: message },
      45_000,
    )
      .then((result) => {
        desktopDraft = null;
        // 聊天页读的是缓存快照，新会话要先放进去，否则会被当成「找不到这个会话」。
        if (snapshot && !snapshot.sessions.some((item) => item.sessionId === result.session.sessionId)) {
          snapshot = { ...snapshot, sessions: [result.session, ...snapshot.sessions] };
        }
        navigate({
          level: "chat",
          appId: appInfo.appId,
          projectId: result.session.projectId,
          sessionId: result.session.sessionId,
        });
      })
      .catch((error) => {
        submit.disabled = false;
        status.classList.add("error");
        status.textContent = messageOf(error);
      });
  }, "btn small");
  form.addEventListener("submit", (event) => event.preventDefault());
  form.append(
    el("p", { className: "panel-title", text: tr(`新建 {0} 会话`, appInfo.name) }),
    el("label", { className: "field" }, [
      el("span", { text: tr("工作目录") }),
      el("input", { className: "input", attrs: { type: "text", value: project.cwd ?? "", readOnly: "" } }),
    ]),
    el("label", { className: "field" }, [el("span", { text: tr("第一条消息") }), text]),
    status,
    el("div", { className: "row-actions" }, [submit]),
  );
  return form;
}

/** 首页的「本设备」卡片：显示这台浏览器在 Bridge 里的名字，并且就地改名。 */
function selfDeviceCard(): HTMLElement {
  const panel = el("section", { className: "panel self-device" });
  const showName = (): void => {
    const name = connected?.device.name ?? "";
    panel.replaceChildren(
      el("h2", { className: "panel-title", text: tr("本设备") }),
      el("p", { className: "hint", text: tr("这台浏览器在 Bridge 里的名字，Mac 菜单栏和其它设备都按它显示。") }),
      el("div", { className: "row-main" }, [el("strong", { className: "row-title", text: name })]),
      el("div", { className: "actions" }, [button(tr("改名"), showForm, "btn ghost small")]),
    );
  };
  const showForm = (): void => {
    const input = el("input", {
      className: "input",
      attrs: { type: "text", value: connected?.device.name ?? "", maxlength: "64" },
    });
    const error = el("p", { className: "notice error hidden" });
    const save = button(tr("保存"), () => {
      const name = input.value.trim();
      if (!name) {
        error.textContent = tr("请输入设备名称");
        error.classList.remove("hidden");
        return;
      }
      save.disabled = true;
      void renameSelfDevice(name)
        .then(showName)
        .catch((failure: unknown) => {
          save.disabled = false;
          error.textContent = messageOf(failure);
          error.classList.remove("hidden");
        });
    }, "btn small");
    panel.replaceChildren(
      el("h2", { className: "panel-title", text: tr("本设备") }),
      el("label", { className: "field" }, [el("span", { text: tr("设备名称") }), input]),
      error,
      el("div", { className: "actions" }, [save, button(tr("取消"), showName, "btn ghost small")]),
    );
    input.focus();
    input.select();
  };
  showName();
  return panel;
}

function renderDevices(): void {
  const state = connected!;
  setTitle(tr("已授权设备 · Agent Bridge"));
  const list = el("ul", { className: "list" });
  const status = el("p", { className: "hint" });
  for (const item of state.devices) {
    const revoked = item.revokedAt !== null;
    const self = item.deviceId === state.device.deviceId;
    const label = el("div", { className: "row-main" }, [
      el("strong", {}, [
        item.name,
        // MCP 客户端自己报的标记，文本固定，不走 i18n。
        ...(item.clientType === "mcp" ? [el("span", { className: "pill mcp", text: "MCP" })] : []),
      ]),
      el("span", { className: "meta", text: `${expireLabel(item.expiresAt)} · ${new Date(item.createdAt).toLocaleString(locale())}` }),
    ]);
    list.append(
      el("li", { className: "device-row" }, [
        label,
        el("div", { className: "row-actions" }, revoked
          ? [el("span", { className: "pill", text: tr("已撤销") })]
          : self
            ? [
              el("span", { className: "pill", text: tr("本机") }),
              button(tr("重命名"), () => beginRename(item, label), "btn ghost small"),
            ]
            : [el("span", { className: "meta", text: tr("在 Mac 上撤销") })]),
      ]),
    );
  }

  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "clients" })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: state.info.name }),
          el("h1", { className: "display", text: tr("已授权设备") }),
          el("p", { className: "meta", text: tr(`Bridge {0} · 前端 {1} · {2} · 通道已加密（Noise IK）`, state.info.version, APP_VERSION, state.info.platform) }),
        ]),
      ]),
      list,
      status,
      el("div", { className: "actions" }, [
        button(tr("刷新"), () => {
          const device = state.device;
          void connectAndShow(device).catch((error: unknown) => {
            status.textContent = messageOf(error);
          });
        }, "btn secondary"),
      ]),
    ]),
    crumbsFor({ level: "devices" }),
  );
}

/**
 * 只改当前设备自己的名字：先让 Bridge 改记录，再同步本地凭据和内存里的状态，
 * Mac 菜单栏、其它设备和首页列表都按新名字显示，不用重连。
 */
async function renameSelfDevice(name: string): Promise<void> {
  const local = connected?.device;
  if (!local) throw new Error(tr("还没有连接 Bridge"));
  await call<{ ok: boolean }>("device.rename", { deviceId: local.deviceId, name });
  local.name = name;
  for (const item of connected?.devices ?? []) {
    if (item.deviceId === local.deviceId) item.name = name;
  }
  rememberDeviceName(name);
  await renameDevice(local.relayUrl, local.roomId, name).catch(() => undefined);
}

/** 只改当前设备自己的名字，改完同步本地记录，首页列表不用重连就能看到新名字。 */
function beginRename(item: DeviceSummary, label: HTMLElement): void {
  const input = el("input", {
    className: "input",
    attrs: { type: "text", value: item.name, maxlength: "64" },
  });
  const error = el("p", { className: "notice error hidden" });
  const save = button(tr("保存"), () => {
    const name = input.value.trim();
    if (!name) {
      error.textContent = tr("请输入设备名称");
      error.classList.remove("hidden");
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    void renameSelfDevice(name)
      .then(() => renderDevices())
      .catch((failure: unknown) => {
        save.disabled = false;
        cancel.disabled = false;
        error.textContent = messageOf(failure);
        error.classList.remove("hidden");
      });
  }, "btn small");
  const cancel = button(tr("取消"), () => renderDevices(), "btn ghost small");
  label.replaceChildren(
    input,
    el("div", { className: "actions" }, [save, cancel]),
    error,
  );
  input.focus();
  input.select();
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "··";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function completenessLabel(value: string): string {
  return value === "complete" ? tr("完整") : value === "partial" ? tr("部分") : value === "unknown" ? tr("未知") : tr("不可用");
}

function statusLabel(status: AppInfo["status"]): string {
  return status === "ready" ? tr("可用") : status === "needs_permission" ? tr("需要授权") : tr("不可用");
}

function hostedControlButton(summary: SessionSummary): HTMLButtonElement {
  const node = button(
    summary.live ? tr("停止进程") : tr("恢复进程"),
    () => {
      node.disabled = true;
      const method: Method = summary.live ? "hosted.stop" : "hosted.resume";
      void call<unknown>(method, { sessionId: summary.sessionId }, 30_000)
        .then(() => {
          snapshot = null;
          void renderRoute();
        })
        .catch((error) => {
          node.disabled = false;
          node.textContent = messageOf(error);
        });
    },
    "btn ghost small",
  );
  node.title = summary.live
    ? tr("结束这台 Mac 上的托管进程；会话记录保留，之后可恢复")
    : tr("在这台 Mac 上 resume 这个托管会话");
  return node;
}

function sendStateLabel(session: SessionSummary): string {
  if (session.hosted) {
    if (!session.canSend) return tr("只读");
    return session.live ? tr("托管运行中") : tr("可恢复");
  }
  if (session.live) return tr("桌面运行中");
  if (!session.canSend) return tr("只读");
  return tr("可发送");
}

function timeLabel(timestamp: number): string {
  if (!timestamp) return tr("时间未知");
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return tr("刚刚");
  if (diff < 3_600_000) return tr(`{0} 分钟前`, Math.floor(diff / 60_000));
  if (diff < 86_400_000) return tr(`{0} 小时前`, Math.floor(diff / 3_600_000));
  return new Date(timestamp).toLocaleDateString(locale());
}

interface QueuedMessage {
  id: string;
  /** Text typed by the user, used to match the transcript once it catches up. */
  match: string;
  display: string;
  at: number;
  /** The desktop acknowledged the message while it was still busy, so it waits there. */
  held: boolean;
}

interface ChatState {
  session: SessionSummary;
  messages: MessageRecord[];
  known: Set<string>;
  queued: QueuedMessage[];
  note: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  loading: boolean;
  busy: boolean;
  /** The latest turn was stopped by the user. */
  interrupted: boolean;
  context?: ContextUsage;
  /** 整个会话的 token 累计与每轮明细；客户端没上报时没有。 */
  tokens?: SessionTokens;
  /** 客户端报告的斜杠命令与技能（名字不带斜杠），输入「/」时提示。 */
  slashCommands?: string[];
  /** 「停止」按钮：只在 Bridge 托管的会话且回合还在跑时出现。 */
  stopButton?: HTMLButtonElement;
  /** 拿到 slashCommands / 忙闲状态之后，重新决定「开新对话」显不显示。 */
  paintReset?: () => void;
  /** 压缩请求的状态；弹层重绘后仍保留，避免重复提交或丢失反馈。 */
  compact?: { pending: boolean; error?: string; note?: string };
  /** 点击压缩的时间；早于它发出的轮询不能用来判断压缩是否完成。 */
  compactSince?: number;
  /** 改自动压缩阈值的状态；与 compact 分开，避免互相覆盖提示。 */
  compaction?: { pending: boolean; error?: string; note?: string };
  /** 已经作答的问题（按块文本 + 问题文本索引）；重绘后仍显示「已发送」，避免重复提交。 */
  answers?: Map<string, string[]>;
  /** 点击了状态行的「重试」：成功后要把「正在重试…」收回去。 */
  retrying?: boolean;
  /** 已经翻到最早一条：轮询拿到的 nextBefore 不能再把「加载更早」解禁。 */
  historyEnd?: boolean;
  /** 手动折叠起来的消息（按回合首条 messageId）；5 秒轮询重绘后仍保持折叠。 */
  folded?: Set<string>;
  contextButton: HTMLButtonElement;
  contextPop: HTMLElement;
  rail?: RailState;
}

async function renderChat(route: Route & { level: "chat" }, token: number): Promise<void> {
  const data = snapshot!;
  const summary = data.sessions.find((item) => item.sessionId === route.sessionId);
  const project = data.projects.find((item) => item.projectId === route.projectId);
  if (!summary) {
    renderShell(
      errorView(tr("找不到这个会话"), tr("它可能已经从桌面应用中删除，返回列表刷新试试。"), () => {
        // 快照里没有它：先重拉一次再判断，否则只是用同一份旧快照重画同一个错误页。
        snapshot = null;
        void renderRoute();
      }),
      crumbsFor(route),
    );
    return;
  }
  setTitle(`${summary.title} · Agent Bridge`);
  rememberSession(summary);
  noteSessionTrail(hashFor(route), summary.title);
  markRead(summary.sessionId);

  const note = el("p", { className: "hint" });
  const list = el("div", { className: "transcript-body" });
  const status = el("p", { className: "hint" });
  // 翻历史与 5 秒轮询是两条独立请求：共用一个 loading 会让点击被轮询默默吞掉。
  let loadingOlder = false;
  const loadOlder = button("", () => {
    void loadOlderPage(state);
  }, "icon-btn composer-tool");
  loadOlder.append(icon("history"));
  loadOlder.setAttribute("aria-label", tr("加载更早的消息"));
  loadOlder.title = tr("加载更早的消息");
  loadOlder.disabled = true;

  const contextButton = el("button", {
    className: "icon-btn context-btn",
    attrs: { type: "button", "aria-label": tr("上下文用量"), title: tr("上下文用量"), "aria-expanded": "false" },
  });
  contextButton.hidden = true;
  const contextPop = el("div", { className: "context-pop" });
  contextPop.hidden = true;

  const state: ChatState = {
    session: summary,
    messages: [],
    known: new Set(),
    queued: [],
    note,
    list,
    status,
    loading: false,
    busy: false,
    interrupted: false,
    contextButton,
    contextPop,
  };
  const pending: PendingAttachment[] = [];
  const canSend = summary.canSend;
  const sendBlockedReason = summary.sendBlockedReason;

  const input = el("textarea", {
    className: "input composer-input",
    attrs: {
      rows: "1",
      placeholder: canSend ? tr("发送到这个会话…") : (sendBlockedReason ?? tr("该会话当前不可发送")),
    },
  });
  input.value = draftFor(summary.sessionId);
  // 待办面板要通过它把文字填进当前会话的输入框。
  composerRef = input;

  // 截图直接粘贴：把剪贴板里的图片文件交给现有上传流程，文本粘贴保持原样。
  input.addEventListener("paste", (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const files = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  });

  const slashMenu = el("div", { className: "slash-menu" });
  slashMenu.hidden = true;
  let slashItems: string[] = [];
  let slashIndex = 0;

  /** 「/」之后还没空格的这一段就是要匹配的命令名。 */
  function slashQuery(): { start: number; text: string } | null {
    if (input.selectionStart !== input.selectionEnd) return null;
    const caret = input.selectionStart ?? input.value.length;
    const match = /(^|\s)\/([^\s/]*)$/.exec(input.value.slice(0, caret));
    if (!match) return null;
    const text = match[2] ?? "";
    return { start: caret - text.length - 1, text };
  }

  function closeSlashMenu(): void {
    slashMenu.hidden = true;
    slashItems = [];
    slashIndex = 0;
  }

  function renderSlashMenu(): void {
    const query = slashQuery();
    const commands = state.slashCommands ?? [];
    if (!query || commands.length === 0) {
      closeSlashMenu();
      return;
    }
    const needle = query.text.toLowerCase();
    const matches = commands
      .filter((name) => name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const byPrefix =
          Number(b.toLowerCase().startsWith(needle)) - Number(a.toLowerCase().startsWith(needle));
        return byPrefix !== 0 ? byPrefix : a.localeCompare(b);
      })
      .slice(0, 40);
    if (matches.length === 0) {
      closeSlashMenu();
      return;
    }
    slashItems = matches;
    if (slashIndex >= slashItems.length) slashIndex = 0;
    slashMenu.replaceChildren(
      ...slashItems.map((name, index) =>
        el("button", {
          className: `slash-item${index === slashIndex ? " is-active" : ""}`,
          attrs: { type: "button" },
          text: `/${name}`,
        }),
      ),
    );
    [...slashMenu.children].forEach((item, index) => {
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const name = slashItems[index];
        if (name) applySlash(name);
      });
    });
    slashMenu.hidden = false;
  }

  /** 把光标所在的那段命令替换成选中的命令，光标留在命令后面。 */
  function applySlash(name: string): void {
    const query = slashQuery();
    if (!query) return;
    const rest = input.value.slice(query.start + query.text.length + 1).replace(/^\s+/, "");
    input.value = `${input.value.slice(0, query.start)}/${name}${rest ? ` ${rest}` : " "}`;
    const caret = query.start + name.length + 2;
    input.setSelectionRange(caret, caret);
    closeSlashMenu();
    input.dispatchEvent(new Event("input"));
    input.focus();
  }

  function autoGrow(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
  }

  function updateSendState(): void {
    if (!canSend) {
      sendButton.disabled = true;
      return;
    }
    const uploading = pending.some((item) => item.status === "uploading");
    const ready = pending.filter((item) => item.status === "ready" && item.attachment).length;
    sendButton.disabled = uploading || (input.value.trim().length === 0 && ready === 0);
  }

  /**
   * 「开新对话」：勾上之后先发一条新建会话的命令，再发这条消息。
   * pi 用 `/new`（换一个会话文件，上下文清空），托管 Claude 用 `/clear`。
   * 只有客户端把其中一条报上来才显示（`slashCommands`），否则勾了也发不出去。
   * 勾选只对这一次发送生效，发完自动收回，免得下次误清。
   */
  function resetCommand(): string | null {
    const commands = state.slashCommands ?? [];
    if (commands.includes("new")) return "new";
    if (commands.includes("clear")) return "clear";
    return null;
  }

  const resetToggle = el("input", { attrs: { type: "checkbox", "aria-label": tr("开新对话") } });
  const resetLabel = el("label", { className: "composer-reset" }, [
    resetToggle,
    el("span", { className: "composer-reset-text", text: tr("开新对话") }),
  ]);
  resetLabel.hidden = true;

  function paintResetToggle(): void {
    const command = resetCommand();
    // `/new`、`/clear` 都要独占空闲进程：这一轮还在跑的时候不显示，免得勾了发不出去。
    const supported = command !== null && canSend && !state.busy;
    resetLabel.hidden = !supported;
    resetLabel.title = command ? tr("先发送 {0}，再发这条", `/${command}`) : "";
    if (!supported) resetToggle.checked = false;
  }
  state.paintReset = paintResetToggle;

  const submit = (): void => {
    if (sendButton.disabled) return;
    void submitWithOptionalReset();
  };

  async function submitWithOptionalReset(): Promise<void> {
    const command = resetCommand();
    if (command !== null && !resetLabel.hidden && resetToggle.checked) {
      sendButton.disabled = true;
      status.classList.remove("error");
      status.textContent = tr("正在开新对话…");
      try {
        await call<MessageSendResult>("message.send", { sessionId: state.session.sessionId, text: `/${command}` }, 60_000);
      } catch (error) {
        status.classList.add("error");
        status.textContent = messageOf(error);
        updateSendState();
        return;
      }
      resetToggle.checked = false;
    }
    await sendMessage(state, input, status, sendButton, loadOlder, pending, renderAttachments, updateSendState, () => {
      // 窄屏发送后收起输入区，把空间让给对话；桌面端保持展开，不打断连续输入。
      if (window.matchMedia("(max-width: 720px)").matches) setCollapsed(true);
    });
  }

  const sendButton = button(tr("发送"), submit, "btn primary");
  sendButton.disabled = !canSend;

  // 托管会话的回合可以从网页直接停：进程留着，CLI 收到 interrupt 后回到可输入状态。
  const stopButton = button(tr("停止"), () => void stopTurn(), "btn secondary stop-turn");
  stopButton.title = tr("停止当前回合（会话和进程保留）");
  stopButton.hidden = true;
  stopButton.disabled = true;
  state.stopButton = stopButton;
  let stopping = false;
  async function stopTurn(): Promise<void> {
    if (stopping || !state.busy) return;
    stopping = true;
    stopButton.disabled = true;
    state.status.textContent = tr("正在停止当前回合…");
    try {
      const result = await call<HostedInterruptResult>("hosted.interrupt", {
        sessionId: state.session.sessionId,
      });
      if (result.session) state.session = result.session;
      if (result.interrupted) {
        state.busy = false;
        state.interrupted = true;
        state.status.textContent = tr("已停止当前回合");
      } else {
        state.status.textContent = tr("当前没有在跑的回合");
      }
      renderMessages(state);
    } catch (error) {
      state.status.textContent = messageOf(error);
    } finally {
      stopping = false;
      paintStopButton(state);
    }
  }

  const attachList = el("div", { className: "attach-list" });
  const fileInput = el("input", { className: "file-input", attrs: { type: "file", multiple: "" } });
  const attachButton = el("button", {
    className: "icon-btn attach-btn",
    attrs: { type: "button", title: tr("添加图片或文件"), "aria-label": tr("添加图片或文件") },
  }, [icon("clip")]);
  attachButton.addEventListener("click", () => fileInput.click());

  const refreshButton = button("", () => {
    void refreshTail(state);
  }, "icon-btn composer-tool");
  refreshButton.append(icon("refresh"));
  refreshButton.setAttribute("aria-label", tr("刷新消息"));
  refreshButton.title = tr("刷新消息");

  const onContextKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeContext();
  };
  const onContextOutside = (event: Event): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (contextPop.contains(target) || contextButton.contains(target)) return;
    closeContext();
  };
  function closeContext(): void {
    contextPop.hidden = true;
    contextButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onContextOutside);
    document.removeEventListener("keydown", onContextKey);
  }
  contextButton.addEventListener("click", () => {
    const open = contextPop.hidden;
    if (!open) {
      closeContext();
      return;
    }
    paintContext(state);
    contextPop.hidden = false;
    contextButton.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onContextOutside);
    document.addEventListener("keydown", onContextKey);
  });

  const collapseButton = el("button", {
    className: "icon-btn composer-collapse",
    attrs: { type: "button", "aria-expanded": "true", "aria-label": tr("收起输入区"), title: tr("收起输入区") },
  }, [icon("chevron", "icon composer-chev")]);
  collapseButton.addEventListener("click", () => setCollapsed(true, true));

  const restore = button("", () => setCollapsed(false, true), "composer-restore");
  restore.append(icon("pencil"), el("span", { text: tr("写消息…") }));

  const composer = el("form", { className: "composer" }, [
    attachList,
    fileInput,
    slashMenu,
    el("div", { className: "composer-row" }, [
      attachButton,
      input,
      loadOlder,
      refreshButton,
      contextButton,
      stopButton,
      resetLabel,
      sendButton,
      collapseButton,
    ]),
    restore,
    contextPop,
  ]);

  function setCollapsed(collapsed: boolean, focus = false): void {
    composer.classList.toggle("is-collapsed", collapsed);
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    writeComposerCollapsed(collapsed);
    if (!collapsed) {
      autoGrow();
      if (focus) input.focus();
    }
  }

  function renderAttachments(): void {
    attachList.hidden = pending.length === 0;
    attachList.replaceChildren(
      ...pending.map((item) => {
        const chip = el("div", { className: `attach-chip is-${item.status}` });
        chip.append(icon(item.kind === "image" ? "image" : "file", "icon attach-chip-icon"));
        chip.append(el("span", { className: "attach-chip-name", text: item.name, attrs: { title: item.name } }));
        const stateText =
          item.status === "uploading"
            ? `${Math.round(item.progress * 100)}%`
            : item.status === "error"
              ? (item.error ?? tr("上传失败"))
              : sizeLabel(item.attachment?.size ?? 0);
        chip.append(el("span", { className: "attach-chip-state", text: stateText }));
        const remove = el("button", {
          className: "attach-chip-remove",
          attrs: { type: "button", "aria-label": tr(`移除 {0}`, item.name) },
        }, [icon("close")]);
        remove.addEventListener("click", () => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          renderAttachments();
          updateSendState();
          if (pending.length === 0) status.textContent = "";
          else if (pending.every((entry) => entry.status === "ready")) {
            status.textContent = tr(`{0} 个附件已就绪`, pending.length);
          }
        });
        chip.append(remove);
        return chip;
      }),
    );
  }

  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (pending.length >= MAX_ATTACHMENTS) {
        status.textContent = tr(`附件最多 {0} 个`, MAX_ATTACHMENTS);
        break;
      }
      if (file.size === 0) {
        status.textContent = tr(`{0} 是空文件`, file.name);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        status.textContent = tr(`{0} 超过 25 MB`, file.name);
        continue;
      }
      const item: PendingAttachment = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        kind: file.type.startsWith("image/") ? "image" : "file",
        progress: 0,
        shown: -1,
        status: "uploading",
      };
      pending.push(item);
      renderAttachments();
      updateSendState();
      status.classList.remove("error");
      status.textContent = tr(`正在上传 {0}…`, file.name);
      try {
        const attachment = await uploadAttachment(state.session.sessionId, file, (ratio) => {
          item.progress = ratio;
          if (ratio < 1 && item.shown >= 0 && ratio - item.shown < 0.05) return;
          item.shown = ratio;
          if (pending.includes(item)) renderAttachments();
        });
        item.status = "ready";
        item.attachment = attachment;
        item.progress = 1;
      } catch (error) {
        item.status = "error";
        item.error = messageOf(error);
        status.classList.add("error");
        status.textContent = `${file.name}：${messageOf(error)}`;
      }
      if (pending.includes(item)) renderAttachments();
      updateSendState();
    }
    if (!pending.some((item) => item.status !== "ready")) {
      status.classList.remove("error");
      status.textContent = pending.length > 0 ? tr(`{0} 个附件已就绪`, pending.length) : "";
    }
  }

  input.addEventListener("input", () => {
    saveDraft(state.session.sessionId, input.value);
    autoGrow();
    updateSendState();
    renderSlashMenu();
  });
  input.addEventListener("keydown", (event) => {
    if (!slashMenu.hidden && slashItems.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
        renderSlashMenu();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !isImeEnter(event)) {
        event.preventDefault();
        const name = slashItems[slashIndex];
        if (name) applySlash(name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      renderSlashMenu();
    }
  });
  input.addEventListener("click", () => renderSlashMenu());
  input.addEventListener("blur", () => closeSlashMenu());
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    void addFiles(files);
  });

  const back = backButton(() => navigate({ level: "sessions", appId: route.appId, projectId: route.projectId }));

  const modelButton = el("button", {
    className: "model-chip",
    attrs: {
      type: "button",
      "aria-label": tr("当前模型"),
      "aria-expanded": "false",
      "aria-haspopup": "true",
    },
  });
  modelButton.hidden = true;
  const modelPop = el("div", { className: "model-pop" });
  modelPop.hidden = true;
  const modelWrap = el("div", { className: "model-wrap" }, [modelButton, modelPop]);
  // 模型选择属于输入区：放在输入框工具栏里，和上下文用量同一行。
  contextButton.before(modelWrap);

  function onModelKey(event: KeyboardEvent): void {
    if (event.key === "Escape") closeModels();
  }
  function onModelOutside(event: Event): void {
    const target = event.target as Node | null;
    if (!target) return;
    if (modelPop.contains(target) || modelButton.contains(target)) return;
    closeModels();
  }
  function closeModels(): void {
    modelPop.hidden = true;
    modelButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onModelOutside);
    document.removeEventListener("keydown", onModelKey);
  }

  /** 一条模型选项：当前项只标「当前」，可切换的其余项点一下就换。 */
  const modelRow = (
    item: ModelOption,
    current: boolean,
    canSwitch: boolean,
    pick: (id: string) => void,
    action: string,
  ): HTMLElement => {
    const content = [
      el("div", { className: "model-item-main" }, [
        el("span", { className: "model-item-name", text: item.name }),
        ...(item.id ? [el("span", { className: "model-item-id", text: item.id })] : []),
      ]),
      ...(current ? [el("span", { className: "model-item-tag", text: tr("当前") })] : []),
    ];
    if (canSwitch && !current) {
      // 托管会话可以从网页直接换模型：换完停掉进程，下一条消息按新模型 resume。
      const row = el(
        "button",
        { className: "model-item is-switchable", attrs: { type: "button", title: `${action}：${item.name}` } },
        content,
      );
      row.addEventListener("click", () => pick(item.id));
      return row;
    }
    return el("div", { className: `model-item${current ? " is-current" : ""}` }, content);
  };

  /** 子代理模型一行；id 为空表示「跟随 pi 设置」，选它就把覆盖清掉。 */
  const subagentRow = (item: ModelOption, current: boolean, pick: (id: string) => void): HTMLElement =>
    modelRow(item, current, true, pick, tr("子代理用"));

  /** 思考等级：一排小 chip，比模型那种长列表省地方；null 表示跟随 pi 设置。 */
  const thinkingChips = (
    levels: string[],
    current: string | undefined,
    pick: (level: string | null) => void,
    action: string,
  ): HTMLElement => {
    const chip = (value: string | null, label: string, isCurrent: boolean): HTMLElement => {
      const node = el("button", {
        className: `thinking-chip${isCurrent ? " is-current" : ""}`,
        text: label,
        attrs: {
          type: "button",
          title: `${action}：${label}`,
          "aria-pressed": isCurrent ? "true" : "false",
        },
      });
      if (!isCurrent) node.addEventListener("click", () => pick(value));
      return node;
    };
    return el("div", { className: "model-chips" }, [
      chip(null, tr("跟随 pi 设置"), !current),
      ...levels.map((level) => chip(level, level, current === level)),
    ]);
  };

  const paintModels = (info: SessionModelsResult): void => {
    const label = info.currentName ?? info.current;
    if (!label && info.models.length === 0) {
      modelButton.hidden = true;
      modelPop.hidden = true;
      return;
    }
    modelButton.hidden = false;
    modelButton.replaceChildren(
      el("span", { className: "model-chip-label", text: tr("模型") }),
      el("span", { className: "model-chip-value", text: label ?? tr("未知") }),
      icon("chevron", "icon model-chev"),
    );
    modelButton.title = tr(
      `当前模型：{0}{1}{2}`,
      label ?? tr("未知"),
      info.canSwitchThinking ? tr(` · 思考：{0}`, info.thinking ?? tr("跟随 pi 设置")) : "",
      info.canSwitchSubagent ? tr(` · 子代理：{0}`, info.subagentModel ?? tr("跟随 pi 设置")) : "",
    );
    const rows: HTMLElement[] = [];
    for (const section of ["main", "custom", "overflow"] as const) {
      const items = info.models.filter((item) => (item.section ?? "main") === section);
      if (items.length === 0) continue;
      rows.push(
        el("p", {
          className: "model-pop-group",
          text: section === "main" ? tr("常用") : section === "custom" ? tr("自定义") : tr("更多"),
        }),
      );
      for (const item of items) {
        rows.push(modelRow(item, item.id === info.current, info.canSwitch, applyModel, tr("切换模型")));
      }
    }
    // pi 的子代理模型是单独的设置：只影响之后新派生的子代理，主模型不动。
    if (info.canSwitchSubagent) {
      rows.push(el("p", { className: "model-pop-group", text: tr("子代理模型") }));
      rows.push(
        subagentRow(
          { id: "", name: tr("跟随 pi 设置"), section: undefined },
          !info.subagentModel,
          applySubagentModel,
        ),
      );
      for (const item of info.models) {
        rows.push(subagentRow(item, item.id === info.subagentModel, applySubagentModel));
      }
    }
    // pi 的思考等级：主会话走 --thinking（进程在跑可直接改），子代理写进 settings.json。
    if (info.canSwitchThinking) {
      rows.push(el("p", { className: "model-pop-group", text: tr("思考等级") }));
      rows.push(thinkingChips(info.thinkingLevels ?? [], info.thinking, applyThinking, tr("切换思考等级")));
    }
    if (info.canSwitchSubagentThinking) {
      rows.push(el("p", { className: "model-pop-group", text: tr("子代理思考等级") }));
      rows.push(
        thinkingChips(
          info.thinkingLevels ?? [],
          info.subagentThinking,
          applySubagentThinking,
          tr("切换子代理思考等级"),
        ),
      );
    }
    if (info.note) rows.push(el("p", { className: "model-pop-note", text: info.note }));
    modelPop.replaceChildren(...rows);
  };

  /** 上一次画出来的模型信息；轮询时没变化就不重绘。 */
  let modelsKey = "";
  const loadModels = async (): Promise<void> => {
    try {
      const info = await call<SessionModelsResult>("session.models", { sessionId: summary.sessionId });
      if (token !== renderToken) return;
      const key = JSON.stringify(info);
      if (key === modelsKey) return;
      modelsKey = key;
      paintModels(info);
    } catch {
      // 拿不到模型信息就不显示这块，不影响聊天。
    }
  };

  async function applyModel(model: string): Promise<void> {
    closeModels();
    try {
      await call("hosted.setModel", { sessionId: route.sessionId, model });
      modelsKey = "";
      await loadModels();
      flashNotice(tr(`模型已换成 {0}，下一条消息按新模型运行`, model));
    } catch (error) {
      flashNotice(tr(`换模型失败：{0}`, messageOf(error)));
    }
  }

  /** 只换子代理模型：主模型不动，之后新派生的子代理按它跑。 */
  async function applySubagentModel(model: string): Promise<void> {
    closeModels();
    try {
      await call("hosted.setSubagentModel", { sessionId: route.sessionId, model: model || null });
      modelsKey = "";
      await loadModels();
      flashNotice(model ? tr(`子代理模型已换成 {0}，新派生的子代理按它运行`, model) : tr("子代理模型改回跟随 pi 设置"));
    } catch (error) {
      flashNotice(tr(`换子代理模型失败：{0}`, messageOf(error)));
    }
  }

  /** 换主会话的思考等级；null 表示改回跟随 pi 设置。 */
  async function applyThinking(level: string | null): Promise<void> {
    closeModels();
    try {
      await call("hosted.setThinking", { sessionId: route.sessionId, level });
      modelsKey = "";
      await loadModels();
      flashNotice(level ? tr(`思考等级已换成 {0}`, level) : tr("思考等级改回跟随 pi 设置"));
    } catch (error) {
      flashNotice(tr(`换思考等级失败：{0}`, messageOf(error)));
    }
  }

  /** 只换子代理的思考等级：主会话不动，之后新派生的子代理按它跑。 */
  async function applySubagentThinking(level: string | null): Promise<void> {
    closeModels();
    try {
      await call("hosted.setSubagentThinking", { sessionId: route.sessionId, level });
      modelsKey = "";
      await loadModels();
      flashNotice(
        level
          ? tr(`子代理思考等级已换成 {0}，新派生的子代理按它运行`, level)
          : tr("子代理思考等级改回跟随 pi 设置"),
      );
    } catch (error) {
      flashNotice(tr(`换子代理思考等级失败：{0}`, messageOf(error)));
    }
  }

  modelButton.addEventListener("click", () => {
    if (!modelPop.hidden) {
      closeModels();
      return;
    }
    modelPop.hidden = false;
    modelButton.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onModelOutside);
    document.addEventListener("keydown", onModelKey);
    void loadModels();
  });
  void loadModels();

  // 桌面端也默认收起，把高度让给聊天记录；需要时点「展开」。
  const collapsed = true;
  const head = el("section", { className: `view-head chat-head${collapsed ? " is-collapsed" : ""}` });
  const headToggle = button("", () => {
    const isCollapsed = head.classList.toggle("is-collapsed");
    headToggle.setAttribute("aria-expanded", String(!isCollapsed));
    headToggle.setAttribute("aria-label", isCollapsed ? tr("展开会话信息") : tr("收起会话信息"));
    headToggle.replaceChildren(
      icon("chevron", "icon head-chev"),
      el("span", { text: isCollapsed ? tr("展开") : tr("收起") }),
    );
  }, "head-toggle");
  headToggle.setAttribute("aria-expanded", String(!collapsed));
  headToggle.setAttribute("aria-label", collapsed ? tr("展开会话信息") : tr("收起会话信息"));
  headToggle.append(icon("chevron", "icon head-chev"), el("span", { text: collapsed ? tr("展开") : tr("收起") }));
  const railToggle = button("", () => {
    const open = !rail.root.classList.contains("is-open");
    rail.setOpen(open);
    writeRailOpen(open);
  }, "icon-btn rail-toggle");
  railToggle.append(icon("rail", "icon"), el("span", { className: "rail-toggle-label", text: tr("侧栏") }));
  railToggle.setAttribute("aria-label", tr("显示会话侧栏"));
  railToggle.title = tr("显示环境、上下文、连接器与后台任务");

  const chatMeta = summary.hosted
    ? tr(`{0}更新 · 由 Bridge 托管，不出现在桌面应用 · 模型 {1} · {2} · {3}{4}`, timeLabel(summary.updatedAt), hostedModelLabel(
        summary.model,
      ), hostedModeFact(summary), summary.live ? tr("进程运行中") : tr("进程已停止，发送时自动恢复"), summary.canSend ? "" : tr(` · {0}`, summary.sendBlockedReason ?? tr("只读")))
    : tr(`{0}更新 · {1}{2}`, timeLabel(summary.updatedAt), summary.live ? tr("桌面正在运行这个会话") : summary.canSend ? tr("桌面未运行该会话，发送时自动打开") : tr("桌面未打开"), summary.canSend ? "" : tr(` · {0}`, summary.sendBlockedReason ?? tr("只读")));
  // Bridge 侧覆盖了显示名时同时展示原名，回源应用里仍能认出这条会话。
  const rename = button("", () => {
    renameSessionSheet(summary, (renamed) => {
      if (snapshot) {
        snapshot = {
          ...snapshot,
          sessions: snapshot.sessions.map((item) =>
            item.sessionId === renamed.sessionId ? renamed : item,
          ),
        };
      }
      void renderRoute();
    });
  }, "icon-btn rename-btn");
  rename.append(icon("pencil"));
  rename.setAttribute("aria-label", tr("重命名会话"));
  rename.title = tr("重命名会话");

  const pinButton = button("", () => void setSessionPinned(summary, !summary.pinned), "icon-btn pin-btn");
  pinButton.append(icon(summary.pinned ? "pinOff" : "pin"));
  pinButton.setAttribute("aria-label", summary.pinned ? tr("取消置顶") : tr("置顶会话"));
  pinButton.setAttribute("aria-pressed", String(summary.pinned === true));
  pinButton.title = summary.pinned ? tr("取消置顶") : tr("置顶会话");
  const archiveButton = summary.hosted
    ? button("", () => void setSessionArchived(summary, !summary.archived), "icon-btn archive-btn")
    : null;
  if (archiveButton) {
    archiveButton.append(icon(summary.archived ? "unarchive" : "archive"));
    archiveButton.setAttribute("aria-label", summary.archived ? tr("取消归档") : tr("归档会话"));
    archiveButton.title = summary.archived ? tr("取消归档") : tr("归档会话");
  }
  const deleteButton = summary.hosted
    ? button("", () => void deleteHostedSession(summary), "icon-btn danger delete-btn")
    : null;
  if (deleteButton) {
    deleteButton.append(icon("trash"));
    deleteButton.setAttribute("aria-label", tr("删除会话"));
    deleteButton.title = tr("删除会话（停进程、删聊天记录）");
  }

  head.append(
    back,
    el("div", { className: "view-head-main" }, [
      el("p", { className: "eyebrow", text: tr(`{0} · {1}`, data.apps.find((item) => item.appId === route.appId)?.name ?? tr("客户端"), project?.name ?? tr("工程")) }),
      el("h1", { className: "display chat-title", text: summary.title }),
      (() => {
        const metaText = tr(`{0}{1}`, chatMeta, summary.originalTitle ? tr(` · 原名：{0}`, summary.originalTitle) : "");
        // 桌面端头部只留一行，说明会被省略号截断，完整内容挂在 title 上。
        return el("p", { className: "meta", text: metaText, attrs: { title: metaText } });
      })(),
    ]),
    el("div", { className: "chat-head-side" }, [
      el("span", { className: summary.canSend ? "pill ok" : "pill", text: sendStateLabel(summary) }),
      rename,
      pinButton,
      ...(archiveButton ? [archiveButton] : []),
      ...(deleteButton ? [deleteButton] : []),
      ...(summary.hosted ? [hostedControlButton(summary)] : []),
      railToggle,
      headToggle,
    ]),
  );

  // 工作树会话的项目是原仓库，但远程工具要落在它真正工作的目录。
  const cwd = summary.cwd ?? project?.cwd;
  previewRoot = cwd;
  previewSessionId = summary.sessionId;
  const rail = createRail(summary.sessionId, summary.appId, cwd);
  railToggle.setAttribute("aria-pressed", String(rail.root.classList.contains("is-open")));
  state.rail = rail.state;
  const main = el("main", { className: `main chat${rail.root.classList.contains("is-open") ? " has-rail" : ""}` }, [
    head,
    el("div", { className: "chat-body" }, [
      el("section", { className: "transcript" }, [
        note,
        list,
      ]),
      composer,
      status,
    ]),
    rail.root,
    rail.backdrop,
  ]);
  rail.onChange = (open) => {
    main.classList.toggle("has-rail", open);
    railToggle.setAttribute("aria-pressed", String(open));
    railToggle.setAttribute("aria-label", open ? tr("隐藏会话侧栏") : tr("显示会话侧栏"));
    railToggle.title = open ? tr("隐藏会话侧栏") : tr("显示环境、上下文、连接器与后台任务");
  };  renderShell(main, crumbsFor(route));
  if (rail.root.classList.contains("is-open")) void refreshRail(rail.state);
  const form = app.querySelector<HTMLFormElement>(".composer");
  form?.addEventListener("submit", (event) => event.preventDefault());
  setCollapsed(readComposerCollapsed());
  if (input.value) autoGrow();

  const startPolling = (): void => {
    stopPolling();
    pollTimer = window.setInterval(() => {
      if (token !== renderToken) return;
      if (document.visibilityState !== "visible" || state.loading) return;
      void refreshTail(state);
      void loadModels();
    }, 5_000);
  };

  const page = await refreshTail(state);
  if (token !== renderToken) return;
  if (page?.nextBefore && !state.historyEnd) loadOlder.disabled = false;
  startPolling();
  chatResumeKey = hashFor(route);
  chatResume = () => {
    void refreshTail(state);
    void loadModels();
    startPolling();
  };

  async function loadOlderPage(current: ChatState): Promise<void> {
    const oldest = current.messages[0]?.messageId;
    if (!oldest || loadingOlder) return;
    loadingOlder = true;
    loadOlder.disabled = true;
    try {
      const result = await call<MessageListResult>("message.list", {
        sessionId: current.session.sessionId,
        limit: 50,
        before: oldest,
      });
      const fresh = result.messages.filter((message) => !current.known.has(message.messageId));
      for (const message of fresh) current.known.add(message.messageId);
      if (fresh.length > 0) {
        current.messages = [...fresh, ...current.messages];
        renderMessages(current);
        // 停在原地等于什么也没发生：视口要挪到刚读出来的最早一条，
        // 否则用户在底部点一下，新内容全在视口上方，看着像没反应。
        current.list.scrollTop = 0;
      }
      // 没有新消息（游标重复）或后端说没有更早的了，都当成翻到头，别再让人白点。
      if (fresh.length === 0 || !result.nextBefore) current.historyEnd = true;
    } catch (error) {
      statusError(current, error, () => void loadOlderPage(current));
    } finally {
      loadingOlder = false;
      loadOlder.disabled = current.historyEnd === true;
    }
  }
}

async function renderTask(route: Route & { level: "chat"; taskId: string }, token: number): Promise<void> {
  const data = snapshot!;
  const summary = data.sessions.find((item) => item.sessionId === route.sessionId);
  if (!summary) {
    renderShell(
      errorView(tr("找不到这个会话"), tr("它可能已经从桌面应用中删除，返回列表刷新试试。"), () => {
        // 快照里没有它：先重拉一次再判断，否则只是用同一份旧快照重画同一个错误页。
        snapshot = null;
        void renderRoute();
      }),
      crumbsFor(route),
    );
    return;
  }
  setTitle(tr(`后台任务 · {0} · Agent Bridge`, summary.title));
  markRead(summary.sessionId);
  previewRoot = data.projects.find((item) => item.projectId === route.projectId)?.cwd;
  previewSessionId = summary.sessionId;

  const note = el("p", { className: "hint", text: tr("正在读取子任务记录…") });
  const list = el("div", { className: "transcript-body" });
  const status = el("p", { className: "hint" });
  const loadOlder = button(tr("加载更早"), () => void older(), "btn secondary small");
  loadOlder.hidden = true;

  const back = backButton(() =>
    navigate({
      level: "chat",
      appId: route.appId,
      projectId: route.projectId,
      sessionId: route.sessionId,
    }),
  );
  const head = el("section", { className: "view-head chat-head" }, [
    back,
    el("div", { className: "view-head-main" }, [
      el("p", { className: "eyebrow", text: tr("后台任务 · 子代理记录") }),
      el("h1", { className: "display chat-title", text: route.taskId }),
      el("p", { className: "meta", text: summary.title }),
    ]),
  ]);

  renderShell(
    el("main", { className: "main chat task-view" }, [
      head,
      el("div", { className: "chat-body" }, [
        el("section", { className: "transcript" }, [note, list, loadOlder]),
        status,
      ]),
    ]),
    crumbsFor(route),
  );

  let messages: MessageRecord[] = [];
  const known = new Set<string>();

  const paint = (): void => {
    list.replaceChildren();
    if (messages.length === 0) {
      list.append(emptyState(tr("没有可读取的记录"), tr("这个子任务可能只做了工具调用，或者记录尚未写入。")));
      return;
    }
    let turn: MessageRecord[] = [];
    let turnStartedAt = 0;
    const flush = (): void => {
      if (turn.length === 0) return;
      list.append(assistantTurn(null, turn, null, null, null, turnStartedAt || turn[0]?.createdAt || 0));
      turn = [];
    };
    for (const message of messages) {
      if (message.role === "assistant") {
        turn.push(message);
        continue;
      }
      flush();
      list.append(messageBubble(null, message));
      if (message.role === "user") turnStartedAt = message.createdAt;
    }
    flush();
  };

  const load = async (before?: string): Promise<MessageListResult | null> => {
    try {
      return await call<MessageListResult>("task.messages", {
        sessionId: route.sessionId,
        taskId: route.taskId,
        limit: 50,
        ...(before ? { before } : {}),
      });
    } catch (error) {
      status.textContent = messageOf(error);
      return null;
    }
  };

  async function older(): Promise<void> {
    const oldest = messages[0]?.messageId;
    if (!oldest) return;
    loadOlder.disabled = true;
    const page = await load(oldest);
    loadOlder.disabled = false;
    if (!page || token !== renderToken) return;
    const fresh = page.messages.filter((message) => !known.has(message.messageId));
    for (const message of fresh) known.add(message.messageId);
    messages = [...fresh, ...messages];
    loadOlder.hidden = !page.nextBefore;
    paint();
  }

  const first = await load();
  if (token !== renderToken) return;
  if (first) {
    for (const message of first.messages) known.add(message.messageId);
    messages = [...first.messages];
    note.textContent = first.note ?? "";
    loadOlder.hidden = !first.nextBefore;
    paint();
    setTitle(tr(`后台任务 · {0} · Agent Bridge`, summary.title));
  } else {
    note.textContent = "";
  }

  try {
    const rail = await call<SessionRailResult>("session.rail", { sessionId: route.sessionId });
    const task = rail.tasks.find((item) => item.taskId === route.taskId);
    if (task && token === renderToken) {
      const title = head.querySelector<HTMLElement>(".chat-title");
      if (title) title.textContent = task.name;
      const meta = head.querySelector<HTMLElement>(".chat-head .meta");
      if (meta) {
        const parts = [summary.title, railTaskMeta(task)];
        if (task.updatedAt) parts.push(tr(`{0}更新`, timeLabel(task.updatedAt)));
        meta.textContent = parts.join(" · ");
      }
      setTitle(tr(`后台任务 · {0}`, task.name));
    }
  } catch {
    // the rail is decoration here; the record itself already loaded
  }
}

const RAIL_KEY = "ab.rail";

function readRailOpen(): boolean {
  try {
    const stored = localStorage.getItem(RAIL_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // private mode: fall back to the viewport
  }
  return window.matchMedia("(min-width: 1180px)").matches;
}

function writeRailOpen(open: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

type RailTab = "overview" | "files" | "shell";

interface FileBrowserState {
  roots: FsRoot[];
  root: FsRoot | null;
  path: string;
  parent: string | null;
  entries: FsEntry[];
  preview: FsReadResult | null;
  error: string | null;
  /** 出错时点「重试」要重做的那一步（读根目录 / 列目录 / 读文件）。 */
  retry: (() => void) | null;
  loading: boolean;
}

interface ShellPaneState {
  output: HTMLPreElement;
  input: HTMLInputElement;
  run: HTMLButtonElement;
  stop: HTMLButtonElement;
  cwdLine: HTMLElement;
  history: string[];
  historyIndex: number;
  cwd?: string;
  /** A shell.exec request is in flight; its execId is not known yet. */
  pending: boolean;
  /** Last request error, shown after the run buffer so a repaint cannot swallow it. */
  notice?: string;
}

/**
 * A command started from a chat's command tab. Kept outside the rail so switching
 * chats does not lose the running execution or its stop control.
 */
interface ShellRun {
  sessionId: string;
  command: string;
  cwd: string;
  text: string;
  done: boolean;
}

/** execId -> run, plus the run each chat last started, and events that beat the response. */
const shellRuns = new Map<string, ShellRun>();
const sessionRuns = new Map<string, string>();
const shellEarly = new Map<string, ShellEventData[]>();
const SHELL_MAX_CHARS = 400_000;

interface RailState {
  sessionId: string;
  appId: string;
  root: HTMLElement;
  body: HTMLElement;
  loading: boolean;
  signature: string;
  devtools: DevtoolsStatus | undefined;
  /** Project directory of this chat; every file and command call is confined to it. */
  projectRoot: string | undefined;
  tabBar: HTMLElement;
  tab: RailTab;
  panes: Record<RailTab, HTMLElement>;
  tabs: HTMLButtonElement[];
  files: FileBrowserState | null;
  shell: ShellPaneState | null;
}

interface RailHandle {
  root: HTMLElement;
  backdrop: HTMLElement;
  state: RailState;
  setOpen(open: boolean): void;
  onChange?: (open: boolean) => void;
}

function createRail(sessionId: string, appId: string, projectCwd: string | undefined): RailHandle {
  const overview = el("div", { className: "rail-body" });
  const files = el("div", { className: "rail-body rail-pane" });
  const shell = el("div", { className: "rail-body rail-pane" });
  files.hidden = true;
  shell.hidden = true;
  const panes: Record<RailTab, HTMLElement> = { overview, files, shell };
  const state: RailState = {
    sessionId,
    appId,
    root: el("div"),
    body: overview,
    loading: false,
    signature: "",
    devtools: connected?.info.devtools,
    projectRoot: projectCwd,
    tabBar: el("div"),
    tab: "overview",
    panes,
    tabs: [],
    files: null,
    shell: null,
  };
  const close = el("button", {
    className: "icon-btn",
    attrs: { type: "button", "aria-label": tr("关闭侧栏"), title: tr("关闭侧栏") },
  }, [icon("close")]);
  const tabBar = el("div", { className: "rail-tabs", attrs: { role: "tablist" } });
  state.tabBar = tabBar;
  const labels: Array<[RailTab, string]> = [
    ["overview", tr("概览")],
    ["files", tr("文件")],
    ["shell", tr("命令")],
  ];
  for (const [tab, label] of labels) {
    const node = button(label, () => selectRailTab(state, tab), "rail-tab");
    node.setAttribute("role", "tab");
    node.dataset["tab"] = tab;
    node.setAttribute("aria-selected", String(tab === "overview"));
    state.tabs.push(node);
    tabBar.append(node);
  }
  paintRailHint(state);
  const root = el("aside", { className: "rail", attrs: { "aria-label": tr("会话侧栏") } });
  // The header's toggle reads state.root when clicked, so bind the real node before building it.
  state.root = root;
  root.append(
    el("div", { className: "rail-head" }, [
      el("span", { className: "rail-title", text: tr("会话侧栏") }),
      el("div", { className: "rail-head-actions" }, [railExpandButton(state), close]),
    ]),
    tabBar,
    overview,
    files,
    shell,
  );
  const backdrop = el("div", { className: "rail-backdrop" });
  const handle: RailHandle = {
    root,
    backdrop,
    state,
    setOpen(open: boolean) {
      root.classList.toggle("is-open", open);
      if (!open) root.classList.remove("is-expanded", "is-preview-full");
      syncRailToggles(root);
      backdrop.classList.toggle("is-open", open);
      if (open) void refreshRail(state);
      handle.onChange?.(open);
    },
  };
  const open = readRailOpen();
  root.classList.toggle("is-open", open);
  backdrop.classList.toggle("is-open", open);
  const dismiss = (): void => {
    handle.setOpen(false);
    writeRailOpen(false);
  };
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", dismiss);
  currentRail = handle;
  return handle;
}

function selectRailTab(state: RailState, tab: RailTab): void {
  state.tab = tab;
  for (const [name, pane] of Object.entries(state.panes)) {
    pane.hidden = name !== tab;
  }
  for (const node of state.tabs) {
    node.setAttribute("aria-selected", String(node.dataset["tab"] === tab));
  }
  if (tab === "overview") void refreshRail(state);
  if (tab === "files") void openFilesPane(state);
  if (tab === "shell") void openShellPane(state);
}

/** The rail only learns the switch state at connect time, so panes re-ask before they open. */
async function refreshDevtools(state: RailState): Promise<void> {
  try {
    const info = await call<HostInfoResult>("host.info");
    state.devtools = info.devtools;
  } catch {
    return;
  }
  paintRailHint(state);
}

function paintRailHint(state: RailState): void {
  const files = state.devtools?.files.enabled === true;
  const terminal = state.devtools?.terminal.enabled === true;
  const hint =
    files && terminal
      ? tr("文件浏览与命令执行已开启")
      : files
        ? tr("文件浏览已开启")
        : terminal
          ? tr("命令执行已开启")
          : undefined;
  if (hint) state.tabBar.dataset["hint"] = hint;
  else delete state.tabBar.dataset["hint"];
}

/** The rail of the chat on screen; one document key listener serves every render. */
let currentRail: RailHandle | null = null;

function dismissRail(): void {
  const rail = currentRail;
  if (!rail || !rail.root.classList.contains("is-open")) return;
  // Escape unwinds fullscreen first: reader, then the whole rail, and only then closes it.
  if (rail.root.classList.contains("is-preview-full")) {
    rail.root.classList.remove("is-preview-full");
    syncRailToggles(rail.root);
    return;
  }
  if (rail.root.classList.contains("is-expanded")) {
    rail.root.classList.remove("is-expanded");
    syncRailToggles(rail.root);
    return;
  }
  rail.setOpen(false);
  writeRailOpen(false);
}

async function refreshRail(state: RailState): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const result = await call<SessionRailResult>("session.rail", { sessionId: state.sessionId });
    paintRail(state, result);
  } catch (error) {
    state.signature = "";
    state.body.replaceChildren(
      el("div", { className: "rail-empty" }, [
        el("p", { text: messageOf(error) }),
        ...(isRetryableError(error) ? [button(tr("重试"), () => void refreshRail(state), "btn small")] : []),
      ]),
    );
  } finally {
    state.loading = false;
  }
}

function paintRail(state: RailState, result: SessionRailResult): void {
  const signature = JSON.stringify(result);
  if (signature === state.signature) return;
  state.signature = signature;
  const scroll = state.body.scrollTop;
  state.body.replaceChildren(
    railSection(tr("环境"), result.environment.map(railRow)),
    railSection(tr("上下文"), [railContext(result.context)]),
    railSection(tr("用量"), [railTokens(result.tokens)], result.tokens?.turns.length),
    railSection(
      tr("连接器"),
      result.servers.length > 0
        ? [el("div", { className: "rail-chips" }, result.servers.map((server) => railChip(server)))]
        : [el("p", { className: "rail-empty", text: tr("没有挂载 MCP 连接器") })],
      result.servers.length,
    ),
    railSection(tr("后台任务"), railTasks(state, result.tasks), result.tasks.length),
  );
  if (result.note) state.body.append(el("p", { className: "rail-note", text: result.note }));
  state.body.scrollTop = scroll;
}

// ---- rail: files ----

async function openFilesPane(state: RailState): Promise<void> {
  await refreshDevtools(state);
  if (!state.devtools?.files.enabled) {
    state.files = null;
    state.panes.files.replaceChildren(
      el("p", { className: "rail-empty", text: tr("文件浏览未开启，请在 Mac 菜单栏的「远程工具」中打开。") }),
    );
    return;
  }
  if (!state.projectRoot) {
    state.files = null;
    state.panes.files.replaceChildren(
      el("p", { className: "rail-empty", text: tr("这个会话没有项目目录，无法浏览文件。") }),
    );
    return;
  }
  if (state.files) {
    if (state.files.roots.length === 0 && !state.files.loading) await loadFileRoots(state);
    return;
  }
  state.files = {
    roots: [],
    root: null,
    path: "",
    parent: null,
    entries: [],
    preview: null,
    error: null,
    retry: null,
    loading: false,
  };
  paintFiles(state, tr("正在读取项目目录…"));
  await loadFileRoots(state);
}

async function loadFileRoots(state: RailState): Promise<void> {
  const files = state.files;
  if (!files) return;
  files.loading = true;
  paintFiles(state, tr("正在读取项目目录…"));
  try {
    if (!state.projectRoot) throw new Error(tr("这个会话没有项目目录"));
    const result = await call<FsRootsResult>("fs.roots", {
      sessionId: state.sessionId,
      root: state.projectRoot,
    });
    files.roots = result.roots;
    files.error = result.roots.length === 0 ? tr("没有可浏览的项目目录") : null;
    files.retry = null;
  } catch (error) {
    files.error = messageOf(error);
    files.retry = isRetryableError(error) ? () => void loadFileRoots(state) : null;
  }
  files.loading = false;
  const first = files.roots[0];
  if (!first) {
    paintFiles(state);
    return;
  }
  files.root = first;
  await listFiles(state, first.path);
}

async function listFiles(state: RailState, path: string): Promise<void> {
  const files = state.files;
  if (!files) return;
  files.loading = true;
  files.preview = null;
  paintFiles(state, tr("正在读取…"));
  try {
    if (!state.projectRoot) throw new Error(tr("这个会话没有项目目录"));
    const result = await call<FsListResult>("fs.list", {
      sessionId: state.sessionId,
      root: state.projectRoot,
      path,
    });
    files.path = result.path;
    files.parent = result.parent;
    files.entries = result.entries;
    files.error = null;
    files.retry = null;
  } catch (error) {
    files.error = messageOf(error);
    files.retry = isRetryableError(error) ? () => void listFiles(state, path) : null;
  }
  files.loading = false;
  paintFiles(state);
}

async function openFile(state: RailState, path: string): Promise<void> {
  const files = state.files;
  if (!files) return;
  files.loading = true;
  paintFiles(state, tr("正在读取文件…"));
  try {
    if (!state.projectRoot) throw new Error(tr("这个会话没有项目目录"));
    files.preview = await call<FsReadResult>("fs.read", {
      sessionId: state.sessionId,
      root: state.projectRoot,
      path,
    });
    files.error = null;
    files.retry = null;
  } catch (error) {
    files.error = messageOf(error);
    files.retry = isRetryableError(error) ? () => void openFile(state, path) : null;
  }
  files.loading = false;
  paintFiles(state);
}

/** In the rail header: the whole rail takes the viewport, tabs and all. */
function railExpandButton(state: RailState): HTMLButtonElement {
  return classToggleButton(
    state.root,
    "is-expanded",
    tr("全屏侧栏"),
    tr("退出全屏侧栏"),
  );
}

/** In the file preview header: only the reader goes fullscreen, no rail chrome. */
/** 侧栏预览头部的小图标按钮：和全屏按钮同一行、同样尺寸。 */
function railIconButton(name: Parameters<typeof icon>[0], title: string, onClick: () => void): HTMLButtonElement {
  const node = button("", onClick, "icon-btn rail-icon-btn");
  node.append(icon(name, "icon"));
  node.title = title;
  node.setAttribute("aria-label", title);
  return node;
}

function previewFullButton(state: RailState): HTMLButtonElement {
  return classToggleButton(state.root, "is-preview-full", tr("全屏查看文件"), tr("退出全屏查看"));
}

const toggleTargets = new WeakMap<HTMLButtonElement, HTMLElement>();

function classToggleButton(
  target: HTMLElement,
  className: string,
  title: string,
  activeTitle: string,
): HTMLButtonElement {
  const node = button("", () => {
    target.classList.toggle(className);
    syncToggle(node);
  }, "icon-btn rail-icon-btn rail-toggle-btn");
  toggleTargets.set(node, target);
  node.dataset["toggle"] = className;
  node.dataset["title"] = title;
  node.dataset["activeTitle"] = activeTitle;
  syncToggle(node);
  return node;
}

/** Esc and tab switches change the rail classes outside the button; repaint from the class. */
function syncToggle(node: HTMLButtonElement): void {
  const rail = toggleTargets.get(node) ?? node.closest(".rail");
  const className = node.dataset["toggle"];
  if (!rail || !className) return;
  const active = rail.classList.contains(className);
  node.replaceChildren(icon(active ? "collapse" : "expand", "icon"));
  node.title = (active ? node.dataset["activeTitle"] : node.dataset["title"]) ?? "";
  node.setAttribute("aria-label", node.title);
  node.setAttribute("aria-pressed", String(active));
}

function syncRailToggles(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLButtonElement>(".rail-toggle-btn")) syncToggle(node);
}

function paintFiles(state: RailState, placeholder?: string): void {
  const files = state.files;
  const pane = state.panes.files;
  pane.replaceChildren();
  if (!files) return;
  if (files.preview) {
    pane.append(filePreview(state, files.preview));
    return;
  }
  const bar = el("div", { className: "rail-filebar" });
  if (files.roots.length > 1) {
    const select = el("select", { className: "input rail-root-select" });
    for (const root of files.roots) {
      select.append(el("option", { text: root.name, attrs: { value: root.path } }));
    }
    select.value = files.root?.path ?? "";
    select.addEventListener("change", () => {
      const next = files.roots.find((item) => item.path === select.value);
      if (!next) return;
      files.root = next;
      void listFiles(state, next.path);
    });
    bar.append(select);
  } else if (files.root) {
    bar.append(el("span", { className: "rail-filebar-name", text: files.root.name, attrs: { title: files.root.path } }));
  }
  const refresh = button("", () => {
    if (files.path) void listFiles(state, files.path);
    else void loadFileRoots(state);
  }, "icon-btn rail-icon-btn");
  refresh.append(icon("refresh", "icon"));
  refresh.title = tr("刷新目录");
  bar.append(refresh);
  pane.append(bar);

  if (files.root) pane.append(fileCrumbs(state));
  if (files.loading) {
    pane.append(el("p", { className: "rail-empty", text: placeholder ?? tr("正在读取…") }));
    return;
  }
  if (files.error) {
    // 断线、超时、Bridge 刚起来这类错误，用户不该只能反复点标签页来重来。
    const retry = files.retry;
    pane.append(
      el("div", { className: "rail-empty rail-error" }, [
        el("p", { text: files.error }),
        ...(retry ? [button(tr("重试"), retry, "btn small")] : []),
      ]),
    );
    return;
  }
  if (files.entries.length === 0) {
    pane.append(el("p", { className: "rail-empty", text: tr("这个目录是空的") }));
    return;
  }
  const list = el("div", { className: "rail-files" });
  for (const entry of files.entries) list.append(fileRow(state, entry));
  pane.append(list);
}

function fileCrumbs(state: RailState): HTMLElement {
  const files = state.files!;
  const root = files.root!;
  const bar = el("div", { className: "rail-crumbs" });
  if (files.parent) {
    const up = button("", () => void listFiles(state, files.parent!), "rail-crumb rail-crumb-up");
    up.append(icon("back"));
    up.title = tr("上一级");
    bar.append(up);
  }
  bar.append(button(root.name || "/", () => void listFiles(state, root.path), "rail-crumb"));
  const rel = files.path === root.path ? "" : files.path.slice(root.path.length + 1);
  if (!rel) return bar;
  let acc = root.path;
  for (const part of rel.split("/")) {
    acc = `${acc}/${part}`;
    const at = acc;
    bar.append(el("span", { className: "rail-crumb-sep", text: "/" }));
    bar.append(button(part, () => void listFiles(state, at), "rail-crumb"));
  }
  return bar;
}

function fileRow(state: RailState, entry: FsEntry): HTMLElement {
  const row = button("", () => {
    if (entry.type === "dir") void listFiles(state, entry.path);
    else void openFile(state, entry.path);
  }, `rail-file${entry.type === "dir" ? " is-dir" : ""}`);
  row.append(icon(entry.type === "dir" ? "chevron" : "file", "rail-file-icon"));
  row.append(el("span", { className: "rail-file-name", text: entry.name, attrs: { title: entry.path } }));
  row.append(el("span", { className: "rail-file-meta", text: entry.type === "dir" ? "" : sizeLabel(entry.size ?? 0) }));
  return row;
}

function filePreview(state: RailState, file: FsReadResult): HTMLElement {
  const wrap = el("div", { className: "rail-preview" });
  const back = button("", () => {
    const files = state.files;
    if (!files) return;
    files.preview = null;
    state.root.classList.remove("is-preview-full");
    paintFiles(state);
  }, "icon-btn rail-icon-btn");
  back.append(icon("back"));
  back.title = tr("返回目录");
  const hasText = typeof file.text === "string" && file.text.length > 0;
  const copy = railIconButton("copy", tr("复制文件内容"), () => {
    if (!hasText) return;
    void navigator.clipboard.writeText(file.text ?? "").then(
      () => {
        copy.replaceChildren(icon("check", "icon"));
        window.setTimeout(() => copy.replaceChildren(icon("copy", "icon")), 1_500);
      },
      () => flashNotice(tr("复制失败：浏览器拒绝了剪贴板访问")),
    );
  });
  copy.disabled = !hasText;
  wrap.append(
    el("div", { className: "rail-filebar" }, [
      back,
      el("span", { className: "rail-filebar-name", text: file.name, attrs: { title: file.path } }),
      railIconButton("download", tr(`下载 {0}`, file.name), () => downloadPreviewFile(file, file.name)),
      copy,
      previewFullButton(state),
    ]),
  );
  if (file.dataBase64) {
    wrap.append(
      el("img", {
        className: "rail-preview-img",
        attrs: { src: `data:${file.mime};base64,${file.dataBase64}`, alt: file.name },
      }),
    );
  } else if (file.mime === "text/markdown") {
    const body = el("div", { className: "markdown rail-markdown" });
    body.append(renderMarkdown(file.text ?? "", MARKDOWN_OPTIONS));
    wrap.append(body);
  } else {
    wrap.append(el("pre", { className: "rail-preview-text", text: file.text ?? "" }));
  }
  wrap.append(
    el("p", {
      className: "rail-note",
      text: tr(`{0} · {1}{2}`, sizeLabel(file.size), new Date(file.mtime).toLocaleString(locale()), file.truncated ? tr(" · 只显示前 1 MB") : ""),
    }),
  );
  return wrap;
}

// ---- rail: single-command shell ----

async function openShellPane(state: RailState): Promise<void> {
  await refreshDevtools(state);
  const pane = state.panes.shell;
  if (!state.devtools?.terminal.enabled) {
    state.shell = null;
    pane.replaceChildren(
      el("p", { className: "rail-empty", text: tr("命令执行未开启，请在 Mac 菜单栏的「远程工具」中打开。") }),
    );
    return;
  }
  if (!state.projectRoot) {
    state.shell = null;
    pane.replaceChildren(
      el("p", { className: "rail-empty", text: tr("这个会话没有项目目录，无法执行命令。") }),
    );
    return;
  }
  if (state.shell) {
    state.shell.input.focus();
    return;
  }
  pane.replaceChildren();
  const output = el("pre", { className: "shell-output" });
  const cwdLine = el("p", { className: "shell-cwd" });
  const input = el("input", {
    className: "input shell-input",
    attrs: { type: "text", placeholder: tr("输入命令后回车"), autocomplete: "off", spellcheck: "false" },
  });
  const run = button(tr("执行"), () => void runShell(state), "btn primary shell-run");
  const stop = button(tr("停止"), () => void stopShell(state), "btn secondary shell-stop");
  stop.hidden = true;
  const form = el("form", { className: "shell-form" }, [input, run, stop]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runShell(state);
  });
  input.addEventListener("keydown", (event) => {
    const shell = state.shell;
    if (!shell) return;
    if (event.key === "ArrowUp" && shell.history.length > 0) {
      event.preventDefault();
      shell.historyIndex = Math.max(0, shell.historyIndex - 1);
      input.value = shell.history[shell.historyIndex] ?? "";
    } else if (event.key === "ArrowDown" && shell.history.length > 0) {
      event.preventDefault();
      shell.historyIndex = Math.min(shell.history.length, shell.historyIndex + 1);
      input.value = shell.history[shell.historyIndex] ?? "";
    }
  });
  const cwd = state.projectRoot;
  pane.append(
    el("p", { className: "rail-empty shell-hint", text: tr("在项目目录里执行单条命令，输出实时返回。远程工具关闭后立刻不可用。") }),
    cwdLine,
    output,
    form,
  );
  if (cwd) cwdLine.textContent = cwd;
  state.shell = {
    output,
    input,
    run,
    stop,
    cwdLine,
    history: [],
    historyIndex: 0,
    cwd,
    pending: false,
  };
  syncShellPane(state);
  input.focus();
}

/** The run a chat last started, if any; survives the rail being rebuilt. */
function shellRunOf(state: RailState): ShellRun | null {
  const execId = sessionRuns.get(state.sessionId);
  return execId ? shellRuns.get(execId) ?? null : null;
}

/** Repaints the pane from the run's buffer, so a rebuilt rail shows what happened meanwhile. */
function syncShellPane(state: RailState): void {
  const shell = state.shell;
  if (!shell) return;
  const run = shellRunOf(state);
  shell.output.textContent = `${run?.text ?? ""}${shell.notice ?? ""}`;
  shell.output.scrollTop = shell.output.scrollHeight;
  const running = (run !== null && !run.done) || shell.pending;
  shell.run.disabled = running;
  shell.stop.hidden = run === null || run.done;
  if (run) {
    shell.cwd = run.cwd;
    shell.cwdLine.textContent = run.cwd;
  }
}

function capShellText(text: string): string {
  return text.length > SHELL_MAX_CHARS ? text.slice(-SHELL_MAX_CHARS + 100_000) : text;
}

/** Events can arrive before the exec response names the id; hold them until it does. */
function queueShellEvent(data: ShellEventData): void {
  const list = shellEarly.get(data.execId) ?? [];
  if (list.length > 64) return;
  list.push(data);
  shellEarly.set(data.execId, list);
}

function applyShellEvent(run: ShellRun, data: ShellEventData): void {
  if (data.type === "exit") {
    run.done = true;
    const tail = data.killed ? tr("已终止") : tr(`退出码 {0}`, data.code ?? data.signal ?? "?");
    run.text = capShellText(
      tr(`{0}\n[{1}{2} · {3}s]\n`, run.text, tail, data.truncated ? tr("，输出已截断") : "", (data.durationMs / 1000).toFixed(1)),
    );
  } else {
    run.text = capShellText(run.text + data.data);
  }
}

function handleShellEvent(data: ShellEventData): void {
  const run = shellRuns.get(data.execId);
  if (!run) {
    queueShellEvent(data);
    return;
  }
  applyShellEvent(run, data);
  // Only the chat that owns the run repaints; other chats keep the buffer for later.
  const rail = currentRail;
  if (rail && rail.state.sessionId === run.sessionId) syncShellPane(rail.state);
}

async function runShell(state: RailState): Promise<void> {
  const shell = state.shell;
  if (!shell || shell.pending) return;
  const previous = shellRunOf(state);
  if (previous && !previous.done) return;
  const command = shell.input.value.trim();
  if (!command) return;
  shell.input.value = "";
  shell.history.push(command);
  shell.historyIndex = shell.history.length;
  shell.notice = undefined;
  shell.pending = true;
  syncShellPane(state);
  shell.output.textContent = capShellText(`${shell.output.textContent ?? ""}$ ${command}\n`);
  shell.output.scrollTop = shell.output.scrollHeight;
  try {
    if (!state.projectRoot) throw new Error(tr("这个会话没有项目目录"));
    const result = await call<ShellExecResult>(
      "shell.exec",
      { sessionId: state.sessionId, root: state.projectRoot, command, cwd: shell.cwd },
      20_000,
    );
    const run: ShellRun = {
      sessionId: state.sessionId,
      command,
      cwd: result.cwd,
      text: `$ ${command}\n`,
      done: false,
    };
    shellRuns.set(result.execId, run);
    const stale = sessionRuns.get(state.sessionId);
    if (stale) shellRuns.delete(stale);
    sessionRuns.set(state.sessionId, result.execId);
    const early = shellEarly.get(result.execId) ?? [];
    shellEarly.delete(result.execId);
    for (const event of early) applyShellEvent(run, event);
    shell.pending = false;
    syncShellPane(state);
  } catch (error) {
    shell.pending = false;
    // Kept in state so the repaint cannot wipe the reason the command never started.
    shell.notice = `${messageOf(error)}\n`;
    syncShellPane(state);
  }
}

async function stopShell(state: RailState): Promise<void> {
  const shell = state.shell;
  const execId = sessionRuns.get(state.sessionId);
  if (!shell || !execId) return;
  try {
    await call<ShellCancelResult>("shell.cancel", { execId });
    const run = shellRuns.get(execId);
    if (run) run.text = capShellText(tr(`{0}\n^C 已请求停止\n`, run.text));
    syncShellPane(state);
  } catch (error) {
    shell.notice = `${messageOf(error)}\n`;
    syncShellPane(state);
  }
}

/** A dropped device channel kills its commands silently, so mark them interrupted. */
function interruptShellRuns(): void {
  for (const run of shellRuns.values()) {
    if (run.done) continue;
    run.done = true;
    run.text = capShellText(tr(`{0}\n[连接已断开，命令已终止]\n`, run.text));
  }
  const rail = currentRail;
  if (rail?.state.shell) {
    // An exec whose response never arrived would otherwise keep the form locked.
    rail.state.shell.pending = false;
    syncShellPane(rail.state);
  }
}

function railSection(title: string, children: Node[], count?: number): HTMLElement {
  const head = el("div", { className: "rail-section-head" }, [
    el("h2", { className: "rail-section-title", text: title }),
  ]);
  if (count !== undefined && count > 0) head.append(el("span", { className: "rail-count", text: String(count) }));
  const section = el("section", { className: "rail-section" }, [head]);
  for (const child of children) section.append(child);
  return section;
}

function railRow(row: RailRow): HTMLElement {
  return el("div", { className: "rail-row" }, [
    el("span", { className: "rail-label", text: serverTr(row.label) }),
    el("span", { className: "rail-value", text: serverTr(row.value), attrs: { title: serverTr(row.value) } }),
  ]);
}

function railChip(server: { name: string; detail?: string }): HTMLElement {
  const chip = el("span", { className: "rail-chip", text: server.name, attrs: { title: server.detail ?? server.name } });
  return chip;
}

function railContext(context: ContextUsage | undefined): HTMLElement {
  if (!context) return el("p", { className: "rail-empty", text: tr("这个会话还没有上下文用量") });
  const window = Math.max(1, context.windowTokens);
  const ratio = Math.min(1, context.usedTokens / window);
  const percent = Math.max(2, Math.round(ratio * 100));
  const meter = el("div", {
    className: "rail-meter",
    attrs: { role: "img", "aria-label": tr(`上下文已用 {0}%`, percent) },
  }, [el("span", { className: "rail-meter-fill", attrs: { style: `width:${percent}%` } })]);
  const wrap = el("div", { className: "rail-context" }, [
    el("div", { className: "rail-context-line" }, [
      el("strong", { text: `${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)}` }),
      el("span", { className: "rail-context-pct", text: `${Math.round(ratio * 100)}%` }),
    ]),
    meter,
  ]);
  if (context.windowEstimated) wrap.append(el("p", { className: "rail-note", text: tr("窗口大小为估算值") }));
  return wrap;
}

/** Claude 的 input_tokens 只统计没命中缓存的部分，用户想看的「输入」是三者之和。 */
function totalInput(usage: TokenUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead;
}

function turnUsageOf(tokens: SessionTokens | undefined, messageId: string): TokenUsage | undefined {
  return tokens?.turns.find((turn) => turn.messageId === messageId)?.usage;
}

function turnUsageRow(usage: TokenUsage): HTMLElement {
  const item = (label: string, value: number): HTMLElement =>
    el("span", { className: "turn-usage-item" }, [
      el("span", { className: "turn-usage-label", text: label }),
      el("strong", { text: formatTokens(value) }),
    ]);
  return el("div", { className: "turn-usage" }, [
    el("span", { className: "turn-usage-tag", text: tr("本轮") }),
    item(tr("输入"), totalInput(usage)),
    item(tr("缓存命中"), usage.cacheRead),
    item(tr("输出"), usage.output),
  ]);
}

function railTokens(tokens: SessionTokens | undefined): HTMLElement {
  if (!tokens) return el("p", { className: "rail-empty", text: tr("这个会话还没有 token 用量") });
  const wrap = el("div", { className: "rail-tokens" });
  const rows: Array<[string, number]> = [
    [tr("输入"), totalInput(tokens)],
    [tr("缓存命中"), tokens.cacheRead],
    [tr("缓存写入"), tokens.cacheWrite],
    [tr("输出"), tokens.output],
  ];
  for (const [label, value] of rows) {
    wrap.append(
      el("div", { className: "rail-token-row" }, [
        el("span", { className: "rail-label", text: label }),
        el("strong", { className: "rail-token-value", text: formatTokens(value) }),
      ]),
    );
  }
  if (tokens.turns.length > 0) {
    const details = el("details", { className: "rail-turns" });
    details.append(
      el("summary", { text: tr("每轮明细（{0}）", tokens.turns.length) }),
    );
    const table = el("div", { className: "rail-turn-table" });
    table.append(
      el("div", { className: "rail-turn-head" }, [
        el("span", { text: "" }),
        el("span", { text: tr("输入") }),
        el("span", { text: tr("命中") }),
        el("span", { text: tr("输出") }),
      ]),
    );
    tokens.turns.forEach((turn, index) => {
      table.append(
        el("div", { className: "rail-turn-row" }, [
          el("span", { className: "rail-turn-index", text: String(index + 1) }),
          el("span", { text: formatTokens(totalInput(turn.usage)) }),
          el("span", { text: formatTokens(turn.usage.cacheRead) }),
          el("span", { text: formatTokens(turn.usage.output) }),
        ]),
      );
    });
    details.append(table);
    wrap.append(details);
  }
  return wrap;
}

function railTasks(state: RailState, tasks: RailTask[]): Node[] {
  if (tasks.length === 0) {
    return [
      el("p", {
        className: "rail-empty",
        text: state.appId === "codex" ? tr("Codex 线程没有可读取的子任务记录") : tr("没有正在运行的后台任务"),
      }),
    ];
  }
  return tasks.map((task) => {
    const row = el("button", {
      className: `rail-task is-${task.status}`,
      attrs: { type: "button", title: task.detail ?? task.name },
    }, [
      el("span", { className: "rail-task-dot", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "rail-task-main" }, [
        el("span", { className: "rail-task-name", text: task.name }),
        el("span", { className: "rail-task-meta", text: railTaskMeta(task) }),
      ]),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () => {
      const route = parseRoute();
      if (route.level !== "chat") return;
      navigate({
        level: "chat",
        appId: route.appId,
        projectId: route.projectId,
        sessionId: route.sessionId,
        taskId: task.taskId,
      });
    });
    return row;
  });
}

function railTaskMeta(task: RailTask): string {
  const parts: string[] = [];
  if (task.agentType) parts.push(task.agentType);
  if (task.model) parts.push(task.model);
  if (task.status === "running") parts.push(tr("运行中"));
  if (typeof task.depth === "number" && task.depth > 1) parts.push(tr(`第 {0} 层`, task.depth));
  return parts.join(" · ") || (task.status === "running" ? tr("运行中") : tr("已结束"));
}

async function refreshTail(state: ChatState, force = false): Promise<MessageListResult | null> {
  // force：用户点了「重试」，轮询那一轮还在飞也不能把这次默默丢弃。
  if (state.loading && !force) return null;
  const startedAt = Date.now();
  state.loading = true;
  try {
    const result = await call<MessageListResult>("message.list", {
      sessionId: state.session.sessionId,
      limit: 50,
    });
    let added = false;
    const fresh: MessageRecord[] = [];
    for (const message of result.messages) {
      if (state.known.has(message.messageId)) continue;
      state.known.add(message.messageId);
      state.messages.push(message);
      fresh.push(message);
      added = true;
    }
    if (state.queued.length > 0) {
      const freshUserTexts = fresh
        .filter((message) => message.role === "user")
        .map((message) => message.blocks.map((block) => block.text).join("\n"));
      const now = Date.now();
      const before = state.queued.length;
      state.queued = state.queued.filter(
        (item) =>
          now - item.at < 180_000 &&
          !(item.match !== "" && freshUserTexts.some((text) => text.includes(item.match))),
      );
      if (state.queued.length !== before) added = true;
    }
    // The adapter's completeness note ("仅主链文本与工具调用摘要…") is noise in the
    // chat view; only surface it when there is nothing else to show.
    state.note.textContent = state.messages.length === 0 ? (result.note ?? "") : "";
    let compactChanged = false;
    // 点击压缩之前发出的轮询可能在压缩请求之后才返回，它看不到 pending，不能据此判定完成。
    if (state.compactSince === undefined || startedAt >= state.compactSince) {
      if (result.compact) {
        state.compact = result.compact.pending
          ? { pending: true }
          : { pending: false, error: result.compact.error };
        compactChanged = true;
      } else if (state.compact?.pending) {
        // 先前确认的压缩请求已经不在客户端的待办里：完成或失效，按完成提示。
        state.compact = { pending: false, note: tr("已压缩上下文") };
        state.status.textContent = tr("客户端已完成上下文压缩");
        compactChanged = true;
      }
    }
    if (result.context) {
      // 轮询每 5 秒一次，上下文没变就不重建弹层：重建会打断正在输入的阈值。
      const changed = JSON.stringify(result.context) !== JSON.stringify(state.context);
      state.context = result.context;
      if (changed || compactChanged) paintContext(state);
    } else if (compactChanged) {
      paintContext(state);
    }
    // 无条件覆盖：客户端换了会话或没上报用量时，旧数字不能留着。
    state.tokens = result.tokens;
    if (result.slashCommands) state.slashCommands = result.slashCommands;
    const busyChanged = (result.busy === true) !== state.busy;
    state.busy = result.busy === true;
    // 放在 busy 之后：「开新对话」要按最新的忙闲状态决定显不显示。
    state.paintReset?.();
    markSessionState(state.session.sessionId, state.busy);
    const interruptedChanged = (result.interrupted === true) !== state.interrupted;
    state.interrupted = result.interrupted === true;
    if (busyChanged) paintStopButton(state);
    if (added || busyChanged || interruptedChanged || state.messages.length === 0) {
      renderMessages(state);
    }
    if (state.rail?.root.classList.contains("is-open")) void refreshRail(state.rail);
    // 手动重试成功了：把「正在重试…」与 error 类收回去，不要永久留着。
    if (state.retrying) {
      state.retrying = false;
      state.status.classList.remove("error");
      state.status.textContent = "";
    }
    return result;
  } catch (error) {
    if (active) statusError(state, error, () => void refreshTail(state, true));
    return null;
  } finally {
    state.loading = false;
  }
}

function processFold(steps: MessageBlock[]): HTMLDetailsElement {
  const fold = el("details", { className: "turn-steps" });
  fold.append(
    el("summary", { className: "turn-steps-summary" }, [
      icon("chevron", "icon turn-chev"),
      el("span", { text: tr(`执行过程 · {0} 步`, steps.length) }),
    ]),
    el(
      "div",
      { className: "turn-steps-body" },
      steps.map((block) => {
        const view = stepView(block);
        const step = el("details", { className: "turn-step" });
        const summary = el("summary", { className: "turn-step-summary" }, [
          icon("chevron", "icon turn-step-chev"),
        ]);
        if (view.label && !view.described) {
          summary.append(el("span", { className: "turn-step-tag", text: tr(view.label) }));
        }
        summary.append(el("span", { className: "turn-step-title", text: view.detail || tr("过程") }));
        const body = el("div", { className: "turn-step-body", text: view.body });
        if (block.truncated) body.append(el("span", { className: "turn-step-note", text: tr("…（已截断）") }));
        step.append(summary, body);
        return step;
      }),
    ),
  );
  return fold;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Paints the context ring on the composer and the details popover it opens. */
function paintContext(state: ChatState): void {
  const usage = state.context;
  const btn = state.contextButton;
  const pop = state.contextPop;
  if (!usage || usage.windowTokens <= 0) {
    btn.hidden = true;
    pop.hidden = true;
    return;
  }
  btn.hidden = false;
  const ratio = Math.max(0, Math.min(1, usage.usedTokens / usage.windowTokens));
  const percent = Math.round(ratio * 100);
  const level = ratio >= 0.85 ? "is-hot" : ratio >= 0.65 ? "is-warn" : "";
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  btn.className = `icon-btn context-btn ${level}`.trim();
  btn.title = tr(`上下文已用 {0}%`, percent);
  btn.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <circle class="context-track" cx="10" cy="10" r="${radius}" fill="none" stroke-width="2.6"/>
    <circle class="context-arc" cx="10" cy="10" r="${radius}" fill="none" stroke-width="2.6" stroke-linecap="round" transform="rotate(-90 10 10)" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(2)}"/>
  </svg>`;

  // 弹层每轮轮询都会重建：正在输入的阈值不能被清掉，先记下草稿与光标，重建后还原。
  const draft = contextDraft(pop, state);
  pop.replaceChildren(
    el("div", { className: "context-head" }, [
      el("span", { className: "context-percent", text: `${percent}%` }),
      el("span", { className: "context-sub", text: `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.windowTokens)} tokens` }),
    ]),
    el("div", { className: "context-bar" }, [
      (() => {
        const fill = el("span", { className: "context-bar-fill" });
        fill.style.width = `${Math.max(2, percent)}%`;
        return fill;
      })(),
    ]),
    ...(usage.model
      ? [el("p", { className: "context-model", text: tr(`{0}{1}`, usage.model, usage.windowEstimated ? tr(" · 窗口按 200k 估算") : "") })]
      : []),
    ...(usage.details && usage.details.length > 0
      ? [el("dl", { className: "context-details" }, usage.details.flatMap((detail) => [
          el("dt", { text: detail.label }),
          el("dd", { text: detail.value }),
        ]))]
      : []),
    ...(percent >= 50 ? [contextCompactActions(state)] : []),
    ...(state.session.hostedAgent === "pi" ? [contextCompactionSetting(state)] : []),
  );
  restoreContextDraft(pop, draft);
}

/** 上下文弹层里正在编辑的输入框草稿；保存中或没有焦点时不保留。 */
interface ContextDraft {
  value: string;
  start: number | null;
  end: number | null;
}

function contextDraft(pop: HTMLElement, state: ChatState): ContextDraft | null {
  if (state.compaction?.pending) return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  if (active.dataset["persist"] !== "compaction" || !pop.contains(active)) return null;
  return { value: active.value, start: active.selectionStart, end: active.selectionEnd };
}

function restoreContextDraft(pop: HTMLElement, draft: ContextDraft | null): void {
  if (!draft) return;
  const next = pop.querySelector<HTMLInputElement>('input[data-persist="compaction"]');
  if (!next || next.disabled) return;
  next.value = draft.value;
  // preventScroll：重绘发生在滚动位置之上时，别把页面拉回输入框。
  next.focus({ preventScroll: true });
  if (draft.start !== null && draft.end !== null) next.setSelectionRange(draft.start, draft.end);
}

/** 上下文过半时在弹层里给出压缩入口：客户端能自己压就调用，否则复制命令让用户粘贴。 */
function contextCompactActions(state: ChatState): HTMLElement {
  const row = el("div", { className: "context-actions" });
  const hint = el("p", { className: "context-hint" });
  if (state.session.canCompact) {
    const pending = state.compact?.pending === true;
    const btn = el("button", {
      className: "context-action",
      text: pending ? tr("压缩中…") : tr("压缩上下文"),
      attrs: { type: "button" },
    });
    btn.disabled = pending;
    if (state.compact?.error) {
      hint.textContent = state.compact.error;
      hint.classList.add("is-error");
    } else if (state.compact?.note) {
      hint.textContent = state.compact.note;
    } else {
      hint.textContent = tr("由桌面客户端自己压缩，摘要会写回该会话。");
    }
    btn.addEventListener("click", () => {
      void runCompact(state);
    });
    row.append(btn, hint);
    return row;
  }
  const btn = el("button", {
    className: "context-action",
    text: tr("复制 /compact"),
    attrs: { type: "button" },
  });
  hint.textContent = tr("浏览器无法直接操作客户端输入框；复制后粘贴到输入框发送。");
  btn.addEventListener("click", () => {
    if (!navigator.clipboard) {
      hint.textContent = tr("当前页面不能写剪贴板，请在客户端输入框手动输入 /compact");
      hint.classList.add("is-error");
      return;
    }
    void navigator.clipboard.writeText("/compact").then(
      () => {
        btn.textContent = tr("已复制");
        setTimeout(() => {
          btn.textContent = tr("复制 /compact");
        }, 1_500);
      },
      () => {
        hint.textContent = tr("复制失败，请在客户端输入框手动输入 /compact");
        hint.classList.add("is-error");
      },
    );
  });
  row.append(btn, hint);
  return row;
}

/**
 * pi 托管会话的自动压缩触发点：上下文用到模型窗口的这个百分比时 pi 自己压缩。
 * pi 原生只认「预留多少 token」，大窗口模型几乎永远不触发，所以这里按百分比填，
 * 由 Bridge 按当前模型窗口换算。改完会重启 pi 进程。
 */
function contextCompactionSetting(state: ChatState): HTMLElement {
  const row = el("div", { className: "context-actions" });
  const pending = state.compaction?.pending === true;
  const current = state.session.compactionTriggerPercent;
  const legacy = state.session.compactionReserveTokens;
  const window = state.context?.windowTokens;
  const percent = typeof current === "number" ? current : DEFAULT_COMPACTION_TRIGGER_PERCENT;
  const input = el("input", {
    className: "context-input",
    attrs: {
      type: "number",
      min: "1",
      max: "100",
      step: "1",
      inputmode: "numeric",
      placeholder: String(DEFAULT_COMPACTION_TRIGGER_PERCENT),
      "data-persist": "compaction",
    },
  });
  if (typeof current === "number") input.value = String(current);
  input.disabled = pending;
  input.setAttribute("aria-label", tr("自动压缩触发点（窗口百分比）"));
  const save = el("button", {
    className: "context-action",
    text: pending ? tr("保存中…") : tr("保存"),
    attrs: { type: "button" },
  });
  save.disabled = pending;
  const follow = el("button", {
    className: "context-action",
    text: tr("恢复默认"),
    attrs: { type: "button" },
  });
  follow.disabled = pending;
  const triggerLabel = window ? Math.round((window * percent) / 100).toLocaleString("en-US") : undefined;
  const hint = el("p", { className: "context-hint" });
  if (state.compaction?.error) {
    hint.textContent = state.compaction.error;
    hint.classList.add("is-error");
  } else if (state.compaction?.note) {
    hint.textContent = state.compaction.note;
  } else if (typeof legacy === "number") {
    // 老记录里存的是固定预留量：按当前窗口折算成触发点，避免两套说法并存。
    hint.textContent = window
      ? tr(`当前按旧设置预留 {0} tokens（约窗口用到 {1}%）；填百分比保存即换成新算法。`, legacy.toLocaleString("en-US"), Math.round(((window - legacy) / window) * 100))
      : tr(`当前按旧设置预留 {0} tokens；填百分比保存即换成新算法。`, legacy.toLocaleString("en-US"));
  } else if (typeof current === "number") {
    hint.textContent = window
      ? tr(`当前：窗口用到 {0}%（约 {1} / {2} tokens）时压缩；改完重启 pi 进程，下一条消息生效。`, current, triggerLabel ?? "", window.toLocaleString("en-US"))
      : tr(`当前：窗口用到 {0}% 时压缩（窗口大小未知，启动后按实际模型换算）；改完重启 pi 进程，下一条消息生效。`, current);
  } else {
    hint.textContent = window
      ? tr(`当前：默认窗口用到 {0}%（约 {1} / {2} tokens）时压缩；改完重启 pi 进程，下一条消息生效。`, DEFAULT_COMPACTION_TRIGGER_PERCENT, triggerLabel ?? "", window.toLocaleString("en-US"))
      : tr(`当前：默认窗口用到 {0}% 时压缩；改完重启 pi 进程，下一条消息生效。`, DEFAULT_COMPACTION_TRIGGER_PERCENT);
  }
  save.addEventListener("click", () => {
    const raw = input.value.trim();
    const value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value < 1 || value > 100) {
      hint.textContent = tr("填 1 到 100 之间的整数（百分比）");
      hint.classList.add("is-error");
      return;
    }
    void runSetCompaction(state, value);
  });
  follow.addEventListener("click", () => {
    void runSetCompaction(state, null);
  });
  // pi 只在启动时读配置：进程里的值和这里的设置不一致，说明还在按旧值压，得重启进程。
  const effective = state.session.compactionEffectiveReserveTokens;
  const intended =
    typeof legacy === "number"
      ? legacy
      : window
        ? Math.max(0, window - Math.round((window * percent) / 100))
        : undefined;
  const stale =
    typeof effective === "number" && intended !== undefined && effective !== intended
      ? el("p", {
          className: "context-hint is-warn",
          text: window
            ? tr(
                `运行中的 pi 进程仍按旧预留 {0} tokens（约 {1} / {2} tokens 时压缩）；停止后再发消息或等它空闲退出即按新设置重启。`,
                effective.toLocaleString("en-US"),
                Math.max(0, window - effective).toLocaleString("en-US"),
                window.toLocaleString("en-US"),
              )
            : tr(
                `运行中的 pi 进程仍按旧预留 {0} tokens；停止后再发消息或等它空闲退出即按新设置重启。`,
                effective.toLocaleString("en-US"),
              ),
        })
      : null;
  row.append(
    el("p", { className: "context-label", text: tr("自动压缩触发点（窗口百分比）") }),
    el("div", { className: "context-compaction-row" }, [input, save, follow]),
    hint,
    ...(stale ? [stale] : []),
  );
  return row;
}

async function runSetCompaction(state: ChatState, percent: number | null): Promise<void> {
  if (state.compaction?.pending) return;
  state.compaction = { pending: true };
  paintContext(state);
  try {
    const result = await call<SessionGetResult>(
      "hosted.setCompaction",
      { sessionId: state.session.sessionId, triggerPercent: percent },
      60_000,
    );
    state.session = result.session;
    state.compaction = {
      pending: false,
      note:
        percent === null
          ? tr(`已恢复默认触发点（窗口用到 {0}%），下一条消息生效。`, DEFAULT_COMPACTION_TRIGGER_PERCENT)
          : tr(`已设为窗口用到 {0}% 时压缩，下一条消息生效。`, percent),
    };
  } catch (error) {
    state.compaction = { pending: false, error: messageOf(error) };
  }
  paintContext(state);
}

async function runCompact(state: ChatState): Promise<void> {
  if (state.compact?.pending) return;
  state.compactSince = Date.now();
  state.compact = { pending: true };
  paintContext(state);
  try {
    const result = await call<SessionCompactResult>(
      "session.compact",
      { sessionId: state.session.sessionId },
      130_000,
    );
    if (result.compacted) {
      state.compact = { pending: false, note: result.detail ?? tr("已压缩上下文") };
      state.status.textContent = result.detail ?? tr("已在客户端压缩上下文");
      void refreshTail(state);
    } else {
      state.compact = { pending: false, error: result.detail ?? tr("客户端没有执行压缩") };
    }
  } catch (error) {
    state.compact = { pending: false, error: messageOf(error) };
  }
  paintContext(state);
}

function queuedBubble(item: QueuedMessage): HTMLElement {
  const bubble = el("article", { className: "message user is-queued" });
  bubble.append(
    el("div", { className: "message-meta" }, [
      el("span", { className: "role user", text: tr("用户") }),
      el("span", { className: "pill tiny", text: item.held ? tr("排队中") : tr("已发送") }),
      el("span", { className: "meta mono", text: new Date(item.at).toLocaleTimeString(locale()) }),
    ]),
    el("div", { className: "message-text", text: item.display }),
  );
  return bubble;
}

function messageBubble(
  session: SessionSummary | null,
  message: MessageRecord,
  folded?: Set<string> | null,
): HTMLElement {
  const bubble = el("article", { className: `message ${message.role}` });
  const text = message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  const hasText = text !== "";
  const meta = el("div", { className: "message-meta" }, [
    el("span", { className: `role ${message.role}`, text: message.role === "user" ? tr("用户") : message.role === "assistant" ? tr("助手") : tr("系统") }),
    ...(message.origin === "peer" ? [el("span", { className: "pill tiny", text: tr("Bridge 注入") })] : []),
    ...(message.createdAt ? [el("span", { className: "meta mono", text: new Date(message.createdAt).toLocaleTimeString(locale()) })] : []),
  ]);
  if (hasText && session) {
    meta.append(
      messageActions([
        copyButton(copySource(session.sessionId, [message])),
        shareButton(session, message),
        downloadButton(session, [message]),
      ]),
    );
  }
  bubble.append(meta);
  // 预览插在 meta 之后、正文之前，折叠时就地替换掉正文的位置。
  if (hasText && folded) {
    const toggle = foldButton(bubble, folded, message.messageId, text);
    if (toggle) meta.append(toggle);
  }
  for (const block of message.blocks) {
    bubble.append(
      block.type === "tool"
        ? el("div", { className: "message-tool", text: block.truncated ? tr(`{0}\n…（已截断）`, block.text) : block.text })
        : block.type === "next-step"
          ? nextStepBox(block, null)
          : block.type === "ask"
            ? askBox(block)
            : markdownBlock(
                block.text,
                block.truncated,
                session ? () => void openMessageFullText(session.sessionId, message) : null,
              ),
    );
  }
  if (hasText && session) {
    // 长消息读到底也能复制/分享，不用再滚回消息头。
    const foot = messageFoot([
      copyButton(copySource(session.sessionId, [message])),
      shareButton(session, message),
    ]);
    if (foot) bubble.append(foot);
  }
  return bubble;
}

/** 提问块里的一个问题在作答记录里的键；同一块里的多个问题各自独立。 */
function askKey(block: MessageBlock, question: MessageQuestion): string {
  return `${block.text}｜${question.question}`;
}

/** 桌面端弹出的结构化提问：点选后把选项文本作为一条消息发给会话。 */
function askBox(block: MessageBlock, state: ChatState | null = null): HTMLElement {
  const box = el("div", { className: "message-ask" });
  const questions = block.questions ?? [];
  if (questions.length === 0) {
    box.append(el("p", { className: "ask-question-text", text: block.text }));
    return box;
  }
  const answered = questions
    .map((question) => state?.answers?.get(askKey(block, question)))
    .filter((labels): labels is string[] => labels !== undefined);
  // 提问在等答案时回合仍在跑；回合结束后的旧提问不能再点，否则会当新消息重发。
  // 终端会话靠 herdr 往面板 pty 按键代答，所以 canSend 为 false 时选项仍可点。
  // herdr 只代答单题单选，多题多选仍要在终端里答。
  const herdrSingle =
    state?.session.askChannel === "herdr" && questions.length === 1 && !questions[0]?.multiSelect;
  const canAnswer = state !== null && state.busy && (state.session.canSend || herdrSingle);
  // 一个问题：点选即发送。多个问题：逐个选完，最后统一提交一条消息。
  const batch = questions.length > 1;
  const picks = new Map<string, Set<string>>();
  const batchButtons: HTMLButtonElement[] = [];
  const labelsOf = (question: MessageQuestion): string[] => {
    const already = state?.answers?.get(askKey(block, question));
    if (already) return already;
    const picked = picks.get(question.question);
    return question.options.map((option) => option.label).filter((label) => picked?.has(label));
  };
  let batchSubmit: HTMLButtonElement | null = null;
  const syncBatch = (): void => {
    if (!batchSubmit) return;
    batchSubmit.disabled = questions.some((question) => labelsOf(question).length === 0);
  };

  for (const question of questions) {
    const sent = state?.answers?.get(askKey(block, question));
    const selectable = canAnswer && sent === undefined;
    const card = el("div", { className: "ask-question" });
    card.append(
      el("div", { className: "ask-question-head" }, [
        ...(question.header ? [el("span", { className: "ask-header", text: question.header })] : []),
        el("span", { className: "ask-question-text", text: question.question }),
        ...(question.multiSelect ? [el("span", { className: "ask-multi", text: tr("多选") })] : []),
      ]),
    );
    if (question.options.length > 0) {
      const row = el("div", { className: "ask-options" });
      const picked = new Set<string>();
      picks.set(question.question, picked);
      const choices: HTMLButtonElement[] = [];
      const submit = selectable && question.multiSelect && !batch
        ? el("button", { className: "ask-submit", text: tr("提交选择"), attrs: { type: "button" } })
        : null;
      for (const option of question.options) {
        const children = [
          el("span", { className: "ask-option-label", text: option.label }),
          ...(option.description
            ? [el("span", { className: "ask-option-desc", text: option.description })]
            : []),
        ];
        if (!selectable) {
          row.append(el("div", { className: "ask-option" }, children));
          continue;
        }
        const choice = el(
          "button",
          {
            className: "ask-option is-selectable",
            attrs: { type: "button", "aria-pressed": "false", "data-label": option.label },
          },
          children,
        );
        choice.addEventListener("click", () => {
          if (batch) {
            if (question.multiSelect) {
              if (picked.has(option.label)) picked.delete(option.label);
              else picked.add(option.label);
            } else {
              picked.clear();
              picked.add(option.label);
            }
            for (const item of choices) {
              item.setAttribute("aria-pressed", picked.has(item.dataset["label"] ?? "") ? "true" : "false");
            }
            syncBatch();
            return;
          }
          if (!question.multiSelect) {
            void submitAskAnswers(
              state,
              [{ key: askKey(block, question), labels: [option.label] }],
              option.label,
              choices,
            );
            return;
          }
          if (picked.has(option.label)) picked.delete(option.label);
          else picked.add(option.label);
          choice.setAttribute("aria-pressed", picked.has(option.label) ? "true" : "false");
          if (submit) submit.disabled = picked.size === 0;
        });
        choices.push(choice);
        batchButtons.push(choice);
        row.append(choice);
      }
      if (submit) {
        submit.disabled = true;
        submit.addEventListener("click", () => {
          // 按选项原本的顺序发出，避免跟点选顺序绑在一起。
          const labels = labelsOf(question);
          if (labels.length === 0) return;
          void submitAskAnswers(
            state,
            [{ key: askKey(block, question), labels }],
            labels.join("、"),
            [...choices, submit],
          );
        });
        row.append(submit);
      }
      card.append(row);
    }
    box.append(card);
  }

  if (batch && canAnswer) {
    const submit = el("button", { className: "ask-submit", text: tr("提交答案"), attrs: { type: "button" } });
    submit.disabled = true;
    submit.addEventListener("click", () => {
      const answers = questions.map((question) => ({ key: askKey(block, question), labels: labelsOf(question) }));
      if (answers.some((entry) => entry.labels.length === 0)) return;
      // 多选答案内部用「/」连接：只有问题之间用「、」，否则 Bridge 按「、」切分会串位。
      const text = answers.map((entry) => entry.labels.join("/")).join("、");
      void submitAskAnswers(state, answers, text, [...batchButtons, submit]);
    });
    batchSubmit = submit;
    box.append(submit);
    syncBatch();
  }

  box.append(
    el("p", {
      className: "ask-note",
      text:
        answered.length > 0
          ? tr(`已发送：{0}`, answered.flat().join("、"))
          : canAnswer
            ? batch
              ? tr("逐个选好后点「提交答案」，会作为一条消息发到会话；桌面上的提问框不会自动关闭。")
              : state?.session.askChannel === "herdr"
                ? tr("点选后会在终端面板里替你按键选中这个选项。")
                : tr("点选后会把选项当消息发到会话；桌面上的提问框不会自动关闭。")
            : state?.session.askChannel === "herdr"
              ? tr("这个提问有多道题或是多选，请在终端里回答")
              : (state?.session.sendBlockedReason ?? tr("请在桌面端回答这个提问")),
    }),
  );
  return box;
}

/** 答案按问题顺序拼成一条消息发出；桌面端的提问对话框仍由桌面收尾。 */
async function submitAskAnswers(
  state: ChatState | null,
  answers: Array<{ key: string; labels: string[] }>,
  text: string,
  buttons: HTMLButtonElement[],
): Promise<void> {
  if (!state) return;
  for (const item of buttons) item.disabled = true;
  state.status.classList.remove("error");
  state.status.textContent = tr("正在发送选择…");
  try {
    const result = await call<MessageSendResult>("message.send", {
      sessionId: state.session.sessionId,
      text,
    }, 60_000);
    if (!result.accepted) {
      state.status.textContent = result.detail ?? tr("未确认投递");
      state.status.classList.add("error");
      for (const item of buttons) item.disabled = false;
      return;
    }
    state.answers ??= new Map<string, string[]>();
    for (const entry of answers) state.answers.set(entry.key, entry.labels);
    state.queued.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      match: text,
      display: text,
      at: Date.now(),
      held: !result.delivered && (result.detail ?? "").includes("排队"),
    });
    state.busy = true;
    state.interrupted = false;
    paintStopButton(state);
    renderMessages(state);
    state.status.textContent = result.delivered
      ? tr("已发送选择")
      : (result.detail ?? tr("已提交，等待桌面执行"));
    window.setTimeout(() => {
      void refreshTail(state);
    }, 800);
  } catch (error) {
    state.status.textContent = messageOf(error);
    state.status.classList.add("error");
    for (const item of buttons) item.disabled = false;
  }
}

/** 桌面端回合结束时的「下一步」盒子：一句话加若干按钮。 */
function nextStepBox(block: MessageBlock, state: ChatState | null): HTMLElement {
  const box = el("div", { className: "next-step" });
  box.append(el("p", { className: "next-step-ask", text: serverTr(block.ask ?? block.text) }));
  const actions = block.actions ?? [];
  if (!state || actions.length === 0) return box;
  const row = el("div", { className: "next-step-actions" });
  for (const action of actions) {
    const btn = el("button", {
      className: "next-step-btn",
      attrs: {
        type: "button",
        ...(action.action ? { title: tr("桥接端没有桌面宿主的执行通道，会以消息通知会话执行这一步") } : {}),
      },
      text: serverTr(action.label),
    });
    btn.addEventListener("click", () => {
      const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
      for (const item of buttons) item.disabled = true;
      void sendNextStep(state, action, buttons);
    });
    row.append(btn);
  }
  box.append(row);
  return box;
}

/** 回复型按钮就是一句话，原样发出；应用动作（合并、提交…）只能作为指令发过去。 */
async function sendNextStep(
  state: ChatState,
  action: NextStepAction,
  buttons: HTMLButtonElement[],
): Promise<void> {
  const text = action.action ? tr(`点击了「{0}」，请执行这一步。`, action.label) : action.label;
  state.status.classList.remove("error");
  state.status.textContent = tr("正在发送…");
  try {
    const result = await call<MessageSendResult>("message.send", {
      sessionId: state.session.sessionId,
      text,
    }, 60_000);
    if (!result.accepted) {
      state.status.textContent = result.detail ?? tr("未确认投递");
      state.status.classList.add("error");
      for (const item of buttons) item.disabled = false;
      return;
    }
    state.queued.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      match: text,
      display: text,
      at: Date.now(),
      held: !result.delivered && (result.detail ?? "").includes("排队"),
    });
    state.busy = true;
    state.interrupted = false;
    paintStopButton(state);
    renderMessages(state);
    state.status.textContent = state.session.hosted
      ? result.delivered
        ? tr("已写入托管会话")
        : (result.detail ?? tr("已提交"))
      : result.delivered
        ? tr("已投递到桌面会话")
        : (result.detail ?? tr("已提交，等待桌面执行"));
    window.setTimeout(() => {
      void refreshTail(state);
    }, 800);
  } catch (error) {
    state.status.textContent = messageOf(error);
    state.status.classList.add("error");
    for (const item of buttons) item.disabled = false;
  }
}

// ---- local files referenced by a transcript ----

/** Project directory of the chat on screen; file previews are scoped to it. */
let previewRoot: string | undefined;
/** fs.read 要 sessionId 才会放行：文件预览落在哪个会话的项目里就带哪个。 */
let previewSessionId: string | undefined;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/**
 * The Mac-side path behind a transcript link, or null for anything else.
 * Antigravity writes `cci:<n>://file:///…`, other clients use `file:///…`,
 * absolute paths, or paths relative to the project directory.
 */
function fileRefPath(href: string): string | null {
  let raw = href.trim().replace(/^<|>$/g, "");
  if (/^cci:\d*:\/\//i.test(raw)) raw = raw.replace(/^cci:\d*:\/\//i, "");
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  // Editor-style references carry a line (and column) number.
  const path = raw.replace(/:\d+(?::\d+)?$/, "").trim();
  if (!path) return null;
  if (path.startsWith("/")) return path;
  if (!path.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(path)) return null;
  return path;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

async function readLocalFile(path: string): Promise<FsReadResult> {
  const root = previewRoot;
  const sessionId = previewSessionId;
  if (!root || !sessionId) throw new Error(tr("这个会话没有项目目录，无法预览文件"));
  const full = path.startsWith("/") ? path : `${root}/${path.replace(/^\.\//, "")}`;
  return call<FsReadResult>("fs.read", { sessionId, root, path: full });
}

/**
 * A `src` for an image response, or null when the file has to be shown as text.
 * The bridge returns raster images as base64, but reads SVG as text.
 */
function imageSource(file: FsReadResult, path: string): string | null {
  if (file.dataBase64) return `data:${file.mime};base64,${file.dataBase64}`;
  if (!file.truncated && /\.svg$/i.test(path) && typeof file.text === "string") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
  }
  return null;
}

function fileRefChip(label: string, path: string): HTMLElement {
  const chip = el("button", { className: "file-ref", attrs: { type: "button", title: path } }, [
    icon("file", "file-ref-icon"),
    el("span", { className: "file-ref-name", text: label }),
  ]);
  chip.addEventListener("click", () => void openFilePreview(path));
  return chip;
}

/**
 * 正文里裸写的本地路径（`apps/web/src/main.ts:12`）：变成和 markdown 链接一样的引用，
 * 点了直接预览，不用去右侧文件树里找。`~/...` 不认（设备端不展开 home）。
 */
function localPathChip(path: string, line: string): HTMLElement | null {
  if (path.startsWith("~/")) return null;
  const cleaned = fileRefPath(path);
  if (!cleaned) return null;
  const chip = fileRefChip(fileName(cleaned), cleaned);
  if (line) chip.title = `${cleaned}${line}`;
  return chip;
}

/** markdown 渲染选项：本地链接、图片、正文里裸写的路径都走同一套本地文件处理。 */
const MARKDOWN_OPTIONS = {
  localLink: localFileLink,
  localImage: localFileImage,
  localPath: localPathChip,
};

/** A transcript link that points at a local file becomes a preview button. */
function localFileLink(label: string, href: string): HTMLElement | null {
  const path = fileRefPath(href);
  return path ? fileRefChip(label || fileName(path), path) : null;
}

/** Local images render as a thumbnail that loads once scrolled into view. */
function localFileImage(alt: string, href: string): HTMLElement | null {
  const path = fileRefPath(href);
  if (!path || !IMAGE_EXT.test(path)) return null;
  const label = alt || fileName(path);
  const button = el("button", { className: "md-figure-open", attrs: { type: "button", title: tr(`查看 {0}`, label) } });
  const img = el("img", { className: "md-img is-loading", attrs: { alt: label, loading: "lazy" } });
  button.append(img);
  const figure = el("figure", { className: "md-figure" }, [button, el("figcaption", { className: "md-figcaption", text: label })]);
  button.addEventListener("click", () => void openFilePreview(path));
  const load = (): void => {
    void readLocalFile(path).then(
      (file) => {
        const src = imageSource(file, path);
        if (!src) {
          figure.replaceWith(fileRefChip(label, path));
          return;
        }
        img.src = src;
        img.classList.remove("is-loading");
      },
      // Outside the project directory, or file browsing switched off.
      () => figure.replaceWith(fileRefChip(label, path)),
    );
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "300px" },
    );
    observer.observe(figure);
  } else {
    load();
  }
  return figure;
}

let filePreviewOverlay: HTMLElement | null = null;
let filePreviewBody: HTMLElement | null = null;
let filePreviewTitle: HTMLElement | null = null;
let filePreviewNote: HTMLElement | null = null;
/** 预览头部右侧的操作区：文本文档放「复制」，图片等二进制不放。 */
let filePreviewActions: HTMLElement | null = null;
/** Increments per open/close so a late response cannot overwrite a newer preview. */
let previewRequest = 0;

function ensureFilePreview(): HTMLElement {
  if (filePreviewOverlay) return filePreviewOverlay;
  const overlay = el("div", { className: "file-preview", attrs: { role: "dialog", "aria-modal": "true", hidden: "" } });
  const backdrop = el("div", { className: "file-preview-backdrop" });
  backdrop.addEventListener("click", closeFilePreview);
  filePreviewTitle = el("span", { className: "file-preview-name" });
  const close = el("button", {
    className: "icon-btn file-preview-close",
    attrs: { type: "button", "aria-label": tr("关闭预览"), title: tr("关闭预览") },
  }, [icon("close")]);
  close.addEventListener("click", closeFilePreview);
  filePreviewBody = el("div", { className: "file-preview-body" });
  filePreviewNote = el("p", { className: "file-preview-note" });
  filePreviewActions = el("span", { className: "file-preview-actions" });
  overlay.append(
    backdrop,
    el("div", { className: "file-preview-card" }, [
      el("header", { className: "file-preview-head" }, [filePreviewTitle, filePreviewActions, close]),
      filePreviewBody,
      filePreviewNote,
    ]),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && filePreviewOverlay && !filePreviewOverlay.hidden) closeFilePreview();
  });
  document.body.append(overlay);
  filePreviewOverlay = overlay;
  return overlay;
}

function closeFilePreview(): void {
  previewRequest += 1;
  if (!filePreviewOverlay) return;
  filePreviewOverlay.hidden = true;
  document.body.classList.remove("has-file-preview");
  filePreviewBody?.replaceChildren();
  filePreviewActions?.replaceChildren();
}

async function openFilePreview(path: string): Promise<void> {
  const overlay = ensureFilePreview();
  const request = (previewRequest += 1);
  overlay.hidden = false;
  document.body.classList.add("has-file-preview");
  if (filePreviewTitle) {
    filePreviewTitle.textContent = fileName(path);
    filePreviewTitle.title = path;
  }
  if (filePreviewNote) filePreviewNote.textContent = "";
  filePreviewActions?.replaceChildren();
  filePreviewBody?.replaceChildren(el("p", { className: "file-preview-note", text: tr("正在读取…") }));
  try {
    const file = await readLocalFile(path);
    // A newer preview (or a close) superseded this one while it was loading.
    if (request !== previewRequest) return;
    const src = imageSource(file, path);
    if (src) {
      filePreviewBody?.replaceChildren(el("img", { className: "file-preview-img", attrs: { src, alt: file.name } }));
    } else if (file.mime === "text/markdown") {
      const body = el("div", { className: "markdown file-preview-md" });
      body.append(renderMarkdown(file.text ?? "", MARKDOWN_OPTIONS));
      filePreviewBody?.replaceChildren(body);
    } else {
      filePreviewBody?.replaceChildren(el("pre", { className: "file-preview-text", text: file.text ?? "" }));
    }
    // 复制的是文件原文（markdown、svg 也复制源码）；下载对图片与文本都提供。
    const actions: HTMLElement[] = [];
    if (typeof file.text === "string" && file.text.length > 0) {
      actions.push(copyButton(file.text, tr("复制全部内容")));
    }
    actions.push(previewDownloadButton(file, path));
    filePreviewActions?.replaceChildren(...actions);
    if (filePreviewNote) {
      filePreviewNote.textContent = tr(`{0} · {1}{2}`, sizeLabel(file.size), new Date(file.mtime).toLocaleString(locale()), file.truncated ? tr(" · 只显示前 1 MB") : "");
    }
  } catch (error) {
    if (request !== previewRequest) return;
    filePreviewBody?.replaceChildren(
      el("div", { className: "file-preview-note is-error" }, [
        el("p", { text: messageOf(error) }),
        ...(isRetryableError(error) ? [button(tr("重试"), () => void openFilePreview(path), "btn small")] : []),
      ]),
    );
  }
}

/**
 * 长回复被列表截断（只给前几千字）时点「读取全文」：弹层里按 markdown 显示原文，
 * 复制按钮拿的也是全文。弹层复用文件预览的卡片，关掉/按 Esc 就能回到会话。
 * `sessionId` 用会话的（带 `hosted:` 这类前缀），不能用消息里存的裸 id。
 */
async function openMessageFullText(sessionId: string, message: MessageRecord): Promise<void> {
  const overlay = ensureFilePreview();
  const request = (previewRequest += 1);
  overlay.hidden = false;
  document.body.classList.add("has-file-preview");
  if (filePreviewTitle) {
    filePreviewTitle.textContent = message.role === "user" ? tr("完整消息") : tr("完整回复");
    filePreviewTitle.title = "";
  }
  if (filePreviewNote) filePreviewNote.textContent = "";
  filePreviewActions?.replaceChildren();
  filePreviewBody?.replaceChildren(el("p", { className: "file-preview-note", text: tr("正在读取全文…") }));
  try {
    const result = await call<MessageTextResult>(
      "message.text",
      { sessionId, messageId: message.messageId },
      60_000,
    );
    if (request !== previewRequest) return;
    const body = el("div", { className: "markdown file-preview-md" });
    body.append(renderMarkdown(result.text, MARKDOWN_OPTIONS));
    filePreviewBody?.replaceChildren(body);
    filePreviewActions?.replaceChildren(copyButton(result.text, tr("复制全文")));
    if (filePreviewNote) {
      filePreviewNote.textContent = tr(`{0} 字{1}`, result.length.toLocaleString(locale()), result.truncated ? tr(` · 只显示前 {0} 字`, result.text.length.toLocaleString(locale())) : "");
    }
  } catch (error) {
    if (request !== previewRequest) return;
    filePreviewBody?.replaceChildren(
      el("div", { className: "file-preview-note is-error" }, [
        el("p", { text: messageOf(error) }),
        ...(isRetryableError(error)
          ? [button(tr("重试"), () => void openMessageFullText(sessionId, message), "btn small")]
          : []),
      ]),
    );
  }
}

/** Renders transcript text as Markdown; truncation offers the full text behind a click. */
function markdownBlock(text: string, truncated?: boolean, onLoadFull?: (() => void) | null): HTMLElement {
  const node = el("div", { className: "message-text md" });
  try {
    node.append(renderMarkdown(text, MARKDOWN_OPTIONS));
  } catch {
    // A rendering failure must never blank the transcript; fall back to plain text.
    node.textContent = text;
  }
  if (truncated) {
    if (onLoadFull) {
      const more = el("button", {
        className: "md-note md-note-more",
        attrs: { type: "button" },
        text: tr("…（已截断）读取全文"),
      });
      more.addEventListener("click", onLoadFull);
      node.append(more);
    } else {
      node.append(el("p", { className: "md-note", text: tr("…（已截断）") }));
    }
  }
  return node;
}

function shareButton(session: SessionSummary, message: MessageRecord): HTMLButtonElement {
  const share = el("button", {
    className: "share-btn",
    attrs: { type: "button", title: tr("分享到其他客户端"), "aria-label": tr("分享这条消息") },
  }, [icon("share"), el("span", { text: tr("分享") })]);
  share.addEventListener("click", () => {
    void openShare(session, message);
  });
  return share;
}

/** 复制一段输出；写剪贴板失败时给出可见反馈，不静默。 */
function copyButton(text: string | (() => Promise<string>), title = tr("复制这段输出")): HTMLButtonElement {
  const label = el("span", { text: tr("复制") });
  const copy = el("button", {
    className: "share-btn copy-btn",
    attrs: { type: "button", title, "aria-label": title },
  }, [icon("copy"), label]);
  const flash = (next: string): void => {
    label.textContent = next;
    setTimeout(() => {
      label.textContent = tr("复制");
    }, 1_500);
  };
  copy.addEventListener("click", () => {
    if (!navigator.clipboard) {
      flash(tr("无法复制"));
      return;
    }
    // 正文被截断的回复要先回 Bridge 拿全文，再写剪贴板；取失败时不能假装复制成功。
    if (typeof text === "string") {
      void navigator.clipboard.writeText(text).then(
        () => flash(tr("已复制")),
        () => flash(tr("复制失败")),
      );
      return;
    }
    flash(tr("读取中…"));
    void text()
      .then((full) => navigator.clipboard.writeText(full))
      .then(
        () => flash(tr("已复制")),
        () => flash(tr("复制失败")),
      );
  });
  return copy;
}

/** 消息头右侧的操作区：分享、复制。 */
function messageActions(buttons: (HTMLElement | null)[]): HTMLElement {
  return el("span", { className: "message-actions" }, buttons.filter((item): item is HTMLElement => item !== null));
}

/** 正文短到这个程度就没有折叠的必要，折起来只是多一步操作。 */
const FOLD_MIN_CHARS = 240;
const FOLD_MIN_LINES = 4;

/**
 * 消息头右侧的折叠按钮，折叠后只留「头一行 + 末一行」两行预览。
 * 状态记在 `folded` 里（按回合首条 messageId），否则 5 秒轮询重绘会把它翻开。
 */
function foldButton(
  bubble: HTMLElement,
  folded: Set<string>,
  key: string,
  text: string,
): HTMLElement | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (trimmed.length < FOLD_MIN_CHARS && lines.length < FOLD_MIN_LINES) return null;
  // 两行正好放「头」和「尾」：首行太长就截断，末行同理，中间省略不占行。
  const clip = (line: string): string => (line.length > 64 ? `${line.slice(0, 64)}…` : line);
  const head = clip(lines[0] ?? "");
  const last = lines.length > 1 ? clip(lines[lines.length - 1] ?? "") : "";
  const preview = el("div", {
    className: "message-fold-preview",
    text: last !== "" && last !== head ? `${head}\n${last}` : head,
  });
  bubble.append(preview);

  const describe = (): string => (folded.has(key) ? tr("展开这条消息") : tr("折叠这条消息"));
  const toggle = el(
    "button",
    { className: "share-btn fold-btn", attrs: { type: "button", "aria-expanded": String(!folded.has(key)) } },
    [icon("chevron", "icon fold-chev")],
  );
  const sync = (): void => {
    const isFolded = folded.has(key);
    bubble.classList.toggle("is-folded", isFolded);
    toggle.setAttribute("aria-expanded", String(!isFolded));
    toggle.title = describe();
    toggle.setAttribute("aria-label", describe());
  };
  toggle.addEventListener("click", () => {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    sync();
  });
  sync();
  return toggle;
}

/**
 * 消息卡片底部的操作区：长消息读到底就能复制/分享，不用再滚回消息头。
 * 顶部那排保留，两处按钮是同一套。
 */
function messageFoot(buttons: (HTMLElement | null)[]): HTMLElement | null {
  const items = buttons.filter((item): item is HTMLElement => item !== null);
  if (items.length === 0) return null;
  return el("div", { className: "message-foot" }, items);
}

/** 消息里所有正文块，按顺序拼回纯文本。 */
function textBlocks(messages: MessageRecord[]): string {
  return messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** 列表里的长回复只给了前几千字；被截断的那条要回 Bridge 拿原文再拼。 */
async function fullTextOf(sessionId: string, messages: MessageRecord[]): Promise<string> {
  const parts: string[] = [];
  for (const message of messages) {
    const blocks = message.blocks.filter((block) => block.type === "text");
    if (blocks.length === 0) continue;
    if (blocks.every((block) => !block.truncated)) {
      parts.push(blocks.map((block) => block.text).join("\n\n"));
      continue;
    }
    const result = await call<MessageTextResult>(
      "message.text",
      { sessionId, messageId: message.messageId },
      60_000,
    );
    parts.push(result.text);
  }
  return parts.join("\n\n").trim();
}

/** 复制/下载用：有截断就现取全文，否则直接用列表里的正文。 */
function copySource(sessionId: string, messages: MessageRecord[]): string | (() => Promise<string>) {
  const truncated = messages.some((message) =>
    message.blocks.some((block) => block.type === "text" && block.truncated),
  );
  return truncated ? () => fullTextOf(sessionId, messages) : textBlocks(messages);
}

/** 下载名：`<会话名>-<年月日-时分>.md`，把文件名里的非法字符换掉。 */
function downloadName(title: string, messages: MessageRecord[]): string {
  const at = new Date(messages[messages.length - 1]?.createdAt || Date.now());
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const base = (title || tr("回复")).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return tr(`{0}-{1}.md`, base || tr("回复"), stamp);
}

/** 浏览器里生成文件并点一下下载；不经过剪贴板，Safari 上也能用。 */
function saveTextFile(text: string, name: string): void {
  saveBlobFile(new Blob([text], { type: "text/markdown;charset=utf-8" }), name);
}

/** 浏览器里生成文件并点一下下载；不经过剪贴板，Safari 上也能用。 */
function saveBlobFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = el("a", { attrs: { href: url, download: name } });
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 有的浏览器来不及取文件，留一会儿再清。
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 预览弹层里的下载：图片按原始字节，文本按 UTF-8（超过 1 MB 的文本是截断后的部分）。 */
function previewDownloadButton(file: FsReadResult, path: string): HTMLButtonElement {
  const name = fileName(path);
  const node = el(
    "button",
    { className: "share-btn", attrs: { type: "button", title: tr(`下载 {0}`, name), "aria-label": tr("下载文件") } },
    [icon("download"), el("span", { text: tr("下载") })],
  );
  node.addEventListener("click", () => downloadPreviewFile(file, name));
  return node;
}

/** 下载一个已读到的文件：图片按原始字节，文本按 UTF-8（弹层与侧栏共用）。 */
function downloadPreviewFile(file: FsReadResult, name: string): void {
  try {
    if (file.dataBase64) {
      const bytes = Uint8Array.from(atob(file.dataBase64), (ch) => ch.charCodeAt(0));
      saveBlobFile(new Blob([bytes], { type: file.mime || "application/octet-stream" }), name);
      return;
    }
    saveBlobFile(new Blob([file.text ?? ""], { type: file.mime || "text/plain;charset=utf-8" }), name);
  } catch (error) {
    flashNotice(tr(`下载失败：{0}`, messageOf(error)));
  }
}

/** 下载这段回复（markdown）；正文被截断时先回 Bridge 取全文。 */
function downloadButton(session: SessionSummary, messages: MessageRecord[]): HTMLButtonElement {
  const title = tr("下载这段回复（Markdown）");
  const node = el(
    "button",
    { className: "share-btn", attrs: { type: "button", title, "aria-label": tr("下载这段回复") } },
    [icon("download")],
  );
  node.addEventListener("click", () => {
    void (async () => {
      try {
        const text = await fullTextOf(session.sessionId, messages);
        if (!text.trim()) {
          flashNotice(tr("这段回复没有可下载的正文"));
          return;
        }
        saveTextFile(text, downloadName(session.title, messages));
      } catch (error) {
        flashNotice(tr(`下载失败：{0}`, messageOf(error)));
      }
    })();
  });
  return node;
}

/** 一回合的耗时：不到一分钟用秒，不到一小时用分+秒，再长用小时+分。 */
function turnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return tr("{0} 秒", seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tr("{0} 分 {1} 秒", minutes, seconds % 60);
  return tr("{0} 小时 {1} 分", Math.floor(minutes / 60), minutes % 60);
}

/** 回合头部的耗时随时在走：只改文本，不重绘整条消息。 */
function paintTurnDurations(): void {
  let live = false;
  // 只碰还在跑的回合：历史回合的耗时是定值，每秒重写一遍纯属浪费。
  for (const node of document.querySelectorAll<HTMLElement>("[data-turn-duration][data-running='1']")) {
    const start = Number(node.dataset["start"] ?? "");
    if (!Number.isFinite(start) || start <= 0) continue;
    live = true;
    node.textContent = tr("持续 {0}", turnDuration(Date.now() - start));
  }
  // 没在跑的回合就不用每秒叫醒一次。
  if (!live && turnClock !== null) {
    window.clearInterval(turnClock);
    turnClock = null;
  }
}

let turnClock: number | null = null;

/** 有还在跑的回合就开一个 1 秒的计时器，结束时自己停。 */
function syncTurnClock(): void {
  if (turnClock !== null) return;
  if (!document.querySelector("[data-turn-duration][data-running='1']")) return;
  turnClock = window.setInterval(paintTurnDurations, 1000);
}

function turnClockText(at: number): string {
  return new Date(at).toLocaleTimeString(locale());
}

function assistantTurn(
  session: SessionSummary | null,
  messages: MessageRecord[],
  state: ChatState | null = null,
  /** 最新一回合才有；提问在等答案时回合是忙的，不能和下一步按钮共用同一个门槛。 */
  askState: ChatState | null = null,
  /** 折叠状态（按回合首条 messageId）；任务页不传，就没有折叠按钮。 */
  folded?: Set<string> | null,
  /** 这一轮的开始时间（用户消息的 createdAt）；不传就退回本轮首条助手消息。 */
  startedAt = 0,
  /** 这一轮还在跑：耗时按现在算，并每秒刷新。 */
  running = false,
): HTMLElement {
  const bubble = el("article", { className: "message assistant" });
  const steps: MessageBlock[] = [];
  const nextSteps: MessageBlock[] = [];
  let peer = false;
  let lastText: MessageRecord | undefined;
  for (const message of messages) {
    if (message.origin === "peer") peer = true;
    let hasText = false;
    for (const block of message.blocks) {
      if (block.type === "text") {
        hasText = true;
      } else if (block.type === "next-step") {
        nextSteps.push(block);
      } else if (block.type === "ask") {
        continue;
      } else {
        steps.push(block);
      }
    }
    if (hasText) lastText = message;
  }
  const last = messages[messages.length - 1];
  const start = startedAt > 0 ? startedAt : (messages[0]?.createdAt ?? 0);
  const times =
    start > 0
      ? el("span", { className: "turn-times" }, [
          el("span", { text: tr("开始 {0}", turnClockText(start)) }),
          el("span", {
            attrs: {
              "data-turn-duration": "",
              "data-start": String(start),
              "data-running": running ? "1" : "0",
            },
            text: tr(
              "持续 {0}",
              turnDuration(running ? Date.now() - start : Math.max(0, (last?.createdAt ?? start) - start)),
            ),
          }),
          ...(last?.createdAt ? [el("span", { text: tr("更新 {0}", turnClockText(last.createdAt)) })] : []),
        ])
      : null;
  const meta = el("div", { className: "message-meta" }, [
    el("span", { className: "role assistant", text: tr("助手") }),
    ...(peer ? [el("span", { className: "pill tiny", text: tr("Bridge 注入") })] : []),
    ...(times ? [times] : []),
  ]);
  if (session) {
    // 复制/下载整回合的输出（被截断的那条现取全文），分享仍沿用最后一条带正文的消息。
    const copyText = textBlocks(messages);
    meta.append(
      messageActions([
        copyText ? copyButton(copySource(session.sessionId, messages)) : null,
        lastText ? shareButton(session, lastText) : null,
        copyText ? downloadButton(session, messages) : null,
      ]),
    );
  }
  bubble.append(meta);
  const foldKey = messages[0]?.messageId ?? "";
  if (folded && foldKey) {
    const toggle = foldButton(bubble, folded, foldKey, textBlocks(messages));
    if (toggle) meta.append(toggle);
  }
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "text") {
        bubble.append(
          markdownBlock(
            block.text,
            block.truncated,
            session ? () => void openMessageFullText(session.sessionId, message) : null,
          ),
        );
      } else if (block.type === "next-step") {
        continue;
      } else if (block.type === "ask") {
        bubble.append(askBox(block, askState));
      }
    }
  }
  // 执行过程一律放在回合末尾：上一版按第一个工具调用插在中间，长回合里它被后面的正文
  // 顶到上面，停在最新输出上既看不到到底跑没跑，也得先滚回去才能展开。现在就在底部，
  // 原地展开。
  if (steps.length > 0) bubble.append(processFold(steps));
  // 只有最新一回合的盒子可以点；历史回合保留文字说明。
  const latest = nextSteps[nextSteps.length - 1];
  if (latest) bubble.append(nextStepBox(latest, latest.pending ? (askState ?? state) : state));
  if (session) {
    // 整回合的复制放在底部：读完长回复就能直接点，和消息头那排是同一套动作。
    const footText = textBlocks(messages);
    const lastText = [...messages]
      .reverse()
      .find((message) => message.blocks.some((block) => block.type === "text"));
    const foot = messageFoot([
      footText ? copyButton(copySource(session.sessionId, messages)) : null,
      lastText ? shareButton(session, lastText) : null,
    ]);
    if (foot) bubble.append(foot);
  }
  return bubble;
}

function spinner(): HTMLElement {
  return el("span", { className: "spinner", attrs: { "aria-hidden": "true" } });
}

/** 只有 Bridge 托管的会话能从网页停回合，别的来源由桌面应用自己控制。 */
function paintStopButton(state: ChatState): void {
  const node = state.stopButton;
  if (!node) return;
  node.hidden = state.session.hosted !== true || !state.busy;
  node.disabled = !state.busy;
}

/** Marks the last assistant turn with its state: running, stopped, or finished. */
function markTurnState(list: HTMLElement, state: ChatState): void {
  const bubbles = list.querySelectorAll<HTMLElement>("article.message.assistant");
  const last = bubbles[bubbles.length - 1];
  const tone = state.busy ? "busy" : state.interrupted ? "stopped" : "done";
  const badge = (): HTMLElement[] =>
    tone === "busy"
      ? [spinner(), el("span", { className: "thinking-label", text: tr("进行中") })]
      : tone === "stopped"
        ? [icon("stop", "icon turn-stop"), el("span", { className: "thinking-label stopped-label", text: tr("已中断") })]
        : [icon("check", "icon turn-done"), el("span", { className: "thinking-label done-label", text: tr("已完成") })];
  if (!last) {
    if (tone === "done") return;
    const row = el("div", { className: "thinking-row" });
    row.append(
      ...(tone === "busy"
        ? [spinner(), el("span", { className: "thinking-label", text: tr("思考中…") })]
        : [icon("stop", "icon turn-stop"), el("span", { className: "thinking-label stopped-label", text: tr("该回合已被中断") })]),
    );
    list.append(row);
    return;
  }
  // 执行过程固定排在回合末尾，状态灯就挂在它的标题上：底部输出、折叠标题、展开后的
  // 步骤都在同一屏，展开也是原地展开，不用再往上跳。
  const summaries = last.querySelectorAll<HTMLElement>(".turn-steps-summary");
  const summary = summaries[summaries.length - 1];
  if (summary) {
    summary.append(...badge());
  } else {
    const row = el("div", { className: "thinking-row" });
    row.append(...badge());
    last.append(row);
  }
  last.classList.add(`is-${tone}`);
}

function renderMessages(state: ChatState): void {
  const list = state.list;
  const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  const stick = distanceFromBottom < 80;
  list.replaceChildren();
  const appendQueued = (): void => {
    for (const item of state.queued) list.append(queuedBubble(item));
  };
  if (state.messages.length === 0) {
    list.append(emptyState(tr("没有可读取的消息"), tr("这个会话在桌面应用中可能只有工具调用，或者还没有开始。")));
    appendQueued();
    if (state.busy || state.interrupted) markTurnState(list, state);
    return;
  }
  const folded = state.folded ?? (state.folded = new Set<string>());
  let turn: MessageRecord[] = [];
  /** 这一轮开始的那条用户消息时间：回合头部显示「开始 / 持续」。 */
  let turnStartedAt = 0;
  /** 当前回合的首条用户消息 id；用量按它去 tokens.turns 里找。 */
  let turnId = "";
  const lastMessage = state.messages[state.messages.length - 1];
  const canAct = state.session.canSend && !state.busy && !state.interrupted && state.queued.length === 0;
  const flush = (): void => {
    if (turn.length === 0) return;
    const isLastTurn = turn[turn.length - 1] === lastMessage;
    list.append(
      assistantTurn(
        state.session,
        turn,
        isLastTurn && canAct ? state : null,
        isLastTurn ? state : null,
        folded,
        turnStartedAt || turn[0]?.createdAt || 0,
        isLastTurn && state.busy && state.queued.length === 0,
      ),
    );
    // 回合末尾补一行用量：整轮加起来比逐条更接近「这轮花了多少」。
    const usage = turnUsageOf(state.tokens, turnId || turn[0]?.messageId || "");
    if (usage) list.append(turnUsageRow(usage));
    turn = [];
  };
  for (const message of state.messages) {
    if (message.role === "assistant") {
      turn.push(message);
      continue;
    }
    flush();
    list.append(messageBubble(state.session, message, folded));
    if (message.role === "user") {
      turnStartedAt = message.createdAt;
      turnId = message.messageId;
    }
  }
  flush();
  appendQueued();
  markTurnState(list, state);
  syncTurnClock();
  if (stick) list.scrollTop = list.scrollHeight;
}

async function sendMessage(
  state: ChatState,
  input: HTMLTextAreaElement,
  status: HTMLElement,
  sendButton: HTMLButtonElement,
  loadOlder: HTMLButtonElement,
  pending: PendingAttachment[],
  renderAttachments: () => void,
  updateSendState: () => void,
  onSent: () => void,
): Promise<void> {
  if (pending.some((item) => item.status === "uploading")) {
    status.textContent = tr("附件还在上传，请稍候");
    return;
  }
  const text = input.value.trim();
  const attachments = pending
    .map((item) => item.attachment)
    .filter((item): item is MessageAttachment => item !== undefined);
  if (!text && attachments.length === 0) return;
  sendButton.disabled = true;
  status.classList.remove("error");
  status.textContent = state.session.hosted
    ? state.session.live
      ? tr("正在写入托管会话…")
      : tr("正在恢复托管进程…")
    : state.session.live
      ? tr("正在发送…")
      : tr("正在请求桌面打开该会话…");
  try {
    const result = await call<MessageSendResult>("message.send", {
      sessionId: state.session.sessionId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }, 60_000);
    input.value = "";
    saveDraft(state.session.sessionId, "");
    pending.length = 0;
    renderAttachments();
    if (result.accepted) {
      const names = attachments.map((attachment) => attachment.name);
      const attachmentLine = names.length > 0 ? tr(`附件：{0}`, names.join("、")) : "";
      state.queued.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        match: text !== "" ? text : (names[0] ?? ""),
        display: [text, attachmentLine].filter(Boolean).join("\n"),
        at: Date.now(),
        held: !result.delivered && (result.detail ?? "").includes("排队"),
      });
      state.busy = true;
      state.interrupted = false;
      paintStopButton(state);
      markSessionState(state.session.sessionId, true);
      renderMessages(state);
    }
    status.textContent = state.session.hosted
      ? result.delivered
        ? tr("已写入托管会话")
        : (result.detail ?? tr("已提交"))
      : result.delivered
        ? tr("已投递到桌面会话")
        : result.accepted
          ? (result.detail ?? tr("已提交，等待桌面执行"))
          : (result.detail ?? tr("未确认投递"));
    // 发送落地后收起输入区，把空间让给对话；需要时点「写消息…」再展开。
    if (result.accepted) onSent();
    window.setTimeout(() => {
      void refreshTail(state).then((page) => {
        if (page?.nextBefore && !state.historyEnd) loadOlder.disabled = false;
      });
    }, 800);
  } catch (error) {
    status.classList.add("error");
    status.textContent = messageOf(error);
  } finally {
    updateSendState();
  }
}

interface PendingAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  progress: number;
  /** Last progress ratio painted, so chunk updates do not re-render constantly. */
  shown: number;
  status: "uploading" | "ready" | "error";
  attachment?: MessageAttachment;
  error?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SharePick {
  appId: string | null;
  projectId: string | null;
  sessionId: string | null;
}

async function openShare(source: SessionSummary, message: MessageRecord): Promise<void> {
  // 重连会清空快照；点分享时补拉一次，别让按钮静默失效。
  let data: Snapshot;
  if (snapshot) {
    data = snapshot;
  } else {
    try {
      data = await ensureSnapshot();
    } catch (error) {
      noticeFailure(tr("读取会话列表失败"), error, () => void openShare(source, message));
      return;
    }
  }
  const exclude = new Set([source.sessionId]);
  const pick: SharePick = { appId: null, projectId: null, sessionId: null };
  let prepared: TransferPrepareResult | null = null;
  let shareEditor: HTMLTextAreaElement | null = null;
  let sending = false;
  let done = false;

  const mask = el("div", { className: "sheet-mask" });
  const body = el("div", { className: "sheet-body" });
  const steps = el("ol", { className: "steps", attrs: { "aria-label": tr("转发步骤") } });
  const note = el("p", { className: "sheet-note" });
  const status = el("p", { className: "sheet-note" });
  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    mask.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) close();
  });

  const cancel = button(tr("取消"), close, "btn secondary");
  const send = button(tr("发送"), () => {
    void commit();
  }, "btn primary");
  send.disabled = true;
  const viewTarget = button(tr("查看目标会话"), () => {
    close();
    if (pick.appId && pick.projectId && pick.sessionId) {
      navigate({ level: "chat", appId: pick.appId, projectId: pick.projectId, sessionId: pick.sessionId });
    }
  }, "btn");
  viewTarget.classList.add("hidden");
  const back = button(tr("上一步"), () => {
    if (pick.sessionId) pick.sessionId = null;
    else if (pick.projectId) pick.projectId = null;
    else if (pick.appId) pick.appId = null;
    void render();
  }, "btn ghost");
  back.classList.add("hidden");

  const closeButton = el("button", { className: "icon-btn", attrs: { type: "button", "aria-label": tr("关闭") } }, [icon("close")]);
  closeButton.addEventListener("click", close);

  const sheet = el("aside", { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": tr("分享消息") } }, [
    el("header", { className: "sheet-head" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: tr("分享") }),
        el("h2", { className: "sheet-title", text: tr("把这条消息发送到另一个客户端") }),
      ]),
      closeButton,
    ]),
    el("p", { className: "sheet-source", text: tr(`来源：{0} · {1} · {2}`, source.title, message.role === "user" ? tr("用户") : message.role === "assistant" ? tr("助手") : tr("系统"), message.createdAt ? new Date(message.createdAt).toLocaleString(locale()) : "") }),
    steps,
    body,
    el("footer", { className: "sheet-foot" }, [
      el("div", { className: "sheet-notes" }, [note, status]),
      el("div", { className: "actions" }, [back, cancel, send, viewTarget]),
    ]),
  ]);
  mask.append(sheet);
  document.body.append(mask);

  const appName = (appId: string | null): string => data.apps.find((item) => item.appId === appId)?.name ?? tr("客户端");
  const projectName = (projectId: string | null): string => data.projects.find((item) => item.projectId === projectId)?.name ?? tr("工程");
  const sessionOf = (sessionId: string | null): SessionSummary | null =>
    data.sessions.find((item) => item.sessionId === sessionId) ?? null;

  function renderSteps(): void {
    const active = pick.sessionId ? 3 : pick.projectId ? 2 : pick.appId ? 1 : 0;
    const labels = [tr("客户端"), tr("工程"), tr("会话"), tr("预览")];
    steps.replaceChildren();
    labels.forEach((label, index) => {
      const state = index < active ? "done" : index === active ? "active" : "todo";
      const chip = el("li", { className: `step ${state}` }, [
        el("span", { className: "step-index", text: String(index + 1) }),
        el("span", { text: label }),
      ]);
      steps.append(chip);
    });
  }

  function rowButton(options: { title: string; meta: string; disabled?: boolean; badge?: string; onClick: () => void }): HTMLButtonElement {
    const node = el("button", {
      className: `row${options.disabled ? " muted-row" : ""}`,
      attrs: { type: "button", ...(options.disabled ? { disabled: "" } : {}) },
    }, [
      el("span", { className: "row-main" }, [
        el("strong", { className: "row-title", text: options.title }),
        el("span", { className: "meta", text: options.meta }),
      ]),
      ...(options.badge ? [el("span", { className: "pill", text: options.badge })] : []),
      icon("chevron", "icon chev"),
    ]);
    if (!options.disabled) node.addEventListener("click", options.onClick);
    return node;
  }

  async function render(): Promise<void> {
    renderSteps();
    body.replaceChildren();
    shareEditor = null;
    note.textContent = "";
    status.classList.remove("error");
    status.textContent = "";
    back.classList.toggle("hidden", !pick.appId);
    send.textContent = tr("发送");
    send.disabled = true;

    if (!pick.appId) {
      note.textContent = pick.appId === null && pick.projectId === null ? tr("选择要发送到的客户端") : "";
      const list = el("ul", { className: "list compact" });
      for (const item of data.apps) {
        const count = data.projects.filter((project) => project.appId === item.appId).length;
        list.append(el("li", {}, [
          rowButton({
            title: item.name,
            meta: tr(`{0} 个工程 · {1}`, count, item.capabilities.send ? tr("可发送") : tr("仅可读")),
            disabled: count === 0 || !item.capabilities.send,
            badge: statusLabel(item.status),
            onClick: () => {
              pick.appId = item.appId;
              void render();
            },
          }),
        ]));
      }
      body.append(list);
      return;
    }

    if (!pick.projectId) {
      note.textContent = tr(`来自 {0}，选择目标工程`, appName(pick.appId));
      const projects = data.projects.filter((project) => project.appId === pick.appId);
      const list = el("ul", { className: "list compact" });
      for (const project of projects) {
        const sendable = data.sessions.some((session) => session.projectId === project.projectId && session.canSend && !exclude.has(session.sessionId));
        list.append(el("li", {}, [
          rowButton({
            title: project.name,
            meta: `${project.cwd ?? project.projectId}`,
            disabled: !sendable,
            badge: sendable ? undefined : tr("无可发送会话"),
            onClick: () => {
              pick.projectId = project.projectId;
              void render();
            },
          }),
        ]));
      }
      if (projects.length === 0) body.append(emptyState(tr("这个客户端没有工程"), tr("换一个客户端试试。")));
      else body.append(list);
      return;
    }

    if (!pick.sessionId) {
      const project = data.projects.find((item) => item.projectId === pick.projectId);
      note.textContent = tr(`{0} · 选择目标会话`, project?.name ?? tr("工程"));
      const search = el("input", { className: "input search", attrs: { type: "text", placeholder: tr("筛选会话标题…"), autocomplete: "off" } });
      const list = el("ul", { className: "list compact" });
      const sessions = data.sessions
        .filter((session) => session.projectId === pick.projectId && !exclude.has(session.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const paint = (): void => {
        const term = search.value.trim().toLowerCase();
        list.replaceChildren();
        const visible = sessions.filter((session) => !term || session.title.toLowerCase().includes(term));
        if (visible.length === 0) {
          list.append(el("li", {}, [emptyState(tr("没有匹配的会话"), tr("换个关键词，或者换一个工程。"))]));
          return;
        }
        for (const session of visible) {
          list.append(el("li", {}, [
            rowButton({
              title: session.title,
              meta: `${timeLabel(session.updatedAt)} · ${sendStateLabel(session)}`,
              disabled: !session.canSend,
              badge: session.canSend ? undefined : tr("不可发送"),
              onClick: () => {
                pick.sessionId = session.sessionId;
                void render();
              },
            }),
          ]));
        }
      };
      search.addEventListener("input", paint);
      paint();
      body.append(search, list);
      return;
    }

    const target = sessionOf(pick.sessionId);
    note.textContent = tr(`目标：{0} / {1} / {2}`, appName(pick.appId), projectName(pick.projectId), target?.title ?? tr("会话"));
    const editor = el("textarea", {
      className: "preview preview-editor",
      attrs: { spellcheck: "false", "aria-label": tr("待发送内容，可直接编辑"), placeholder: tr("正在生成预览…") },
    });
    editor.readOnly = true;
    shareEditor = editor;
    body.append(editor);
    await prepare(editor);
  }

  async function prepare(editor: HTMLTextAreaElement): Promise<void> {
    prepared = null;
    if (!pick.sessionId) return;
    send.disabled = true;
    editor.readOnly = true;
    status.classList.remove("error");
    status.textContent = tr("正在校验目标会话…");
    try {
      prepared = await call<TransferPrepareResult>(
        "transfer.prepare",
        {
          sourceSessionId: source.sessionId,
          messageId: message.messageId,
          targetSessionId: pick.sessionId,
        },
        60_000,
      );
      editor.value = prepared.text;
      editor.readOnly = false;
      const sync = (): void => {
        const text = editor.value;
        const tooLong = text.length > MAX_TRANSFER_CHARS;
        const blocked = !prepared?.target.canSend;
        // 超长和空内容在本地就拦住：服务端拒绝时会清掉 prepared，编辑内容也会一起丢。
        status.textContent = !text.trim()
          ? tr("内容为空，无法发送")
          : tooLong
            ? tr(`已超出上限（{0} / {1} 字符）`, text.length, MAX_TRANSFER_CHARS)
            : tr(`{0} 字符 · {1}{2}`, text.length, text === prepared?.text ? tr("发送内容与预览一致") : tr("已编辑，将发送当前内容"), prepared?.note ? ` · ${prepared.note}` : "");
        status.classList.toggle("error", tooLong || !text.trim() || blocked);
        send.disabled = blocked || sending || done || tooLong || !text.trim();
      };
      editor.addEventListener("input", sync);
      sync();
    } catch (error) {
      editor.placeholder = tr("无法生成预览");
      editor.readOnly = true;
      status.classList.add("error");
      status.textContent = messageOf(error);
    }
  }

  async function commit(): Promise<void> {
    if (!prepared || sending || done || !prepared.target.canSend) return;
    const text = shareEditor?.value ?? prepared.text;
    if (!text.trim() || text.length > MAX_TRANSFER_CHARS) {
      status.classList.add("error");
      status.textContent = text.trim()
        ? tr(`已超出上限（{0} / {1} 字符）`, text.length, MAX_TRANSFER_CHARS)
        : tr("消息不能为空");
      return;
    }
    sending = true;
    send.disabled = true;
    if (shareEditor) shareEditor.readOnly = true;
    status.classList.remove("error");
    status.textContent = tr("正在发送…");
    try {
      const result = await call<TransferCommitResult>(
        "transfer.commit",
        text === prepared.text ? { transferId: prepared.transferId } : { transferId: prepared.transferId, text },
        60_000,
      );
      done = true;
      status.textContent = result.delivered
        ? tr(`已投递给「{0}」（{1} 字符）`, prepared.target.title, result.textLength)
        : (result.detail ?? tr("已提交，但目标会话尚未确认投递"));
      if (!result.delivered && !result.accepted) status.classList.add("error");
      send.textContent = tr("已发送");
      cancel.textContent = tr("关闭");
      viewTarget.classList.remove("hidden");
      back.classList.add("hidden");
    } catch (error) {
      prepared = null;
      if (shareEditor) shareEditor.readOnly = false;
      status.classList.add("error");
      status.textContent = tr(`{0}；重新选择会话可再试`, messageOf(error));
      send.disabled = true;
    } finally {
      sending = false;
    }
  }

  await render();
}

function emptyState(title: string, hint: string): HTMLElement {
  return el("div", { className: "empty" }, [
    el("span", { className: "empty-mark", text: "·" }),
    el("strong", { text: title }),
    el("span", { className: "hint", text: hint }),
  ]);
}

function errorView(title: string, message: string, retry?: () => void): HTMLElement {
  return el("main", { className: "main" }, [
    el("p", { className: "eyebrow", text: tr("出错了") }),
    el("h1", { className: "display", text: title }),
    el("div", { className: "notice error", text: message }),
    el("div", { className: "actions" }, [
      button(tr("重试"), retry ?? (() => void renderRoute()), "btn primary"),
      button(tr("返回客户端"), () => navigate({ level: "clients" }), "btn secondary"),
    ]),
  ]);
}

function skeletonView(route: Route): HTMLElement {
  const rows = el("div", { className: "list" });
  for (let index = 0; index < 4; index += 1) {
    rows.append(el("div", { className: "row skeleton" }, [
      el("span", { className: "mark skeleton-block" }),
      el("span", { className: "row-main" }, [
        el("span", { className: "skeleton-line", attrs: { style: "width: 42%" } }),
        el("span", { className: "skeleton-line thin", attrs: { style: "width: 68%" } }),
      ]),
    ]));
  }
  return el("main", { className: "main" }, [
    el("p", { className: "eyebrow", text: route.level === "chat" ? tr("会话") : tr("客户端") }),
    el("div", { className: "skeleton-title" }),
    rows,
  ]);
}

/**
 * 预览和生产客户端常常并排在两个标签页里，图标默认一模一样。预览换成带 P 角标的那份，
 * 生产、本地开发保持 index.html 里的原图标；PWA 安装图标（manifest）也照旧，只动标签页图标。
 */
if (isPreviewDeployment()) {
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", "/icon-preview.svg");
}

const bootUrl = new URL(location.href);
if (bootUrl.searchParams.has("v")) {
  bootUrl.searchParams.delete("v");
  history.replaceState(null, "", bootUrl.toString());
}
watchForUpdates();
watchTagMenu();

const initialLink = takeInviteLink();
if (initialLink) {
  void beginPairing(initialLink);
} else {
  showHome();
}

window.addEventListener("hashchange", () => {
  const link = takeInviteLink();
  if (link) void beginPairing(link);
  else void renderRoute();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismissRail();
});
