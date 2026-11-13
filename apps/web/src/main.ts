import { MAX_TRANSFER_CHARS } from "@craftstead/protocol";
import type {
  AppInfo,
  AppListResult,
  ContextUsage,
  DeviceSummary,
  DevtoolsStatus,
  FileUploadBeginResult,
  FileUploadChunkResult,
  FileUploadFinishResult,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsRoot,
  FsRootsResult,
  HostedAgent,
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
  SessionSummary,
  ShellCancelResult,
  ShellEventData,
  ShellExecResult,
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
import { parsePairingInput, takeInviteLink, type PairingLink } from "./link.js";
import { renderMarkdown } from "./markdown.js";
import { connectDevice, finishPairing, startPairing, type PairingChallenge } from "./pairing.js";
import type { PeerClient } from "./peer.js";
import { RelayError, type RelayConnection } from "./relay.js";
import "./style.css";

const RELAY_ERRORS: Record<string, string> = {
  invite_expired: "邀请已过期，请在 Mac 上重新生成配对链接。",
  invite_used: "邀请已被使用，请在 Mac 上重新生成配对链接。",
  device_expired: "设备授权已到期，请重新配对。",
  device_revoked: "设备已被撤销，请重新配对。",
  bridge_offline: "Mac 上的 Bridge 没有连接中继，请确认它正在运行。",
  channel_in_use: "连接通道已被占用，请稍后重试。",
  invalid_credential: "凭据无效，请重新配对。",
  not_found: "找不到该房间，请重新配对。",
  rate_limited: "请求太频繁，稍等片刻再试。",
};

function messageOf(error: unknown): string {
  if (error instanceof RelayError) return RELAY_ERRORS[error.code] ?? `中继拒绝：${error.message}`;
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
  device:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3" width="11.6" height="7.6" rx="1.4"/><path d="M5.6 13.2h4.8"/></svg>',
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
  expand:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.6H2.6V6"/><path d="M10 2.6h3.4V6"/><path d="M13.4 10v3.4H10"/><path d="M6 13.4H2.6V10"/></svg>',
  collapse:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 6H6V2.6"/><path d="M13.4 6H10V2.6"/><path d="M10 13.4V10h3.4"/><path d="M6 13.4V10H2.6"/></svg>',
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
  node.append(icon("back"), el("span", { className: "back-label", text: "返回" }));
  node.setAttribute("aria-label", "返回");
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
    el("span", { className: "update-text", text: "前端已更新，刷新后使用新版本" }),
    button(
      "刷新",
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
if (!root) throw new Error("缺少 #app 容器");
const app: HTMLDivElement = root;

let active: PeerClient | null = null;
let generation = 0;
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
  effort: string;
  mode: string;
  agent: HostedAgent;
  subagentModel: string;
} | null = null;
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
    progressBar = el("div", { className: "progress-bar", attrs: { role: "progressbar", "aria-label": "正在加载" } });
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
}

function markRead(sessionId: string): void {
  if (!(sessionId in unreadSessions)) return;
  delete unreadSessions[sessionId];
  persistUnread();
}

function unreadAt(sessionId: string): number | undefined {
  return unreadSessions[sessionId];
}

function unreadCount(sessions: SessionSummary[]): number {
  return sessions.filter((session) => unreadAt(session.sessionId) !== undefined).length;
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

const IOS_HINT = "iPhone 需要先在 Safari 里用「添加到主屏幕」，再从主屏幕打开，才能收到后台提醒。";

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
  if (!pushSupported()) return "这个浏览器不支持后台推送";
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
  if (!json.endpoint || !keys["p256dh"] || !keys["auth"]) return "浏览器没有给出推送地址";
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
    const note = new Notification(session.title || "对话已完成", {
      body: `${appName} · 回复已完成`,
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
    const route = parseRoute();
    if (route.level !== "clients" && route.level !== "projects" && route.level !== "sessions") return;
    if (snapshotSignature() !== before) repaintList();
  } catch {
    // The connection layer already reports disconnects; the next tick retries.
  }
}

let watchTimer: number | null = null;

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

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
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
  const retry = button("重新粘贴配对链接", showHome, "btn secondary");
  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: "配对" }),
      el("h1", { className: "display", text: "配对失败" }),
      box,
      el("div", { className: "actions" }, [retry]),
    ]),
  );
}

function flashNotice(message: string): void {
  const box = el("div", { className: "notice error float-notice", attrs: { role: "status" }, text: message });
  document.body.append(box);
  window.setTimeout(() => box.remove(), 5000);
}

function renderHome(): HTMLElement {
  const devices = listDevices();
  const page = el("main", { className: "page narrow" }, [
    el("header", { className: "hero" }, [
      el("p", { className: "eyebrow", text: "Agent Bridge" }),
      el("h1", { className: "display", text: "桌面会话，从这里接管" }),
      el("p", {
        className: "lede",
        text: "在浏览器里浏览 Mac 上 Claude Code 与 ChatGPT 的工程与会话，并把任意一段消息转发到另一个客户端。",
      }),
    ]),
  ]);

  const section = el("section", { className: "panel" });
  const expiring = devices.filter((device) => isExpiringSoon(device.expiresAt));
  if (expiring.length > 0) {
    section.append(
      el("p", {
        className: "notice warn",
        text: `${expiring.length === 1 ? "有一台设备" : `有 ${expiring.length} 台设备`}的凭据将在 3 天内过期。到期后会无法连接，请在 Mac 上重新生成配对链接并重新配对。`,
      }),
    );
  }
  section.append(el("h2", { className: "panel-title", text: "已配对设备" }));
  if (devices.length === 0) {
    section.append(
      emptyState("还没有配对设备", "在 Mac 上运行 agent-bridge invite，把生成的配对链接粘贴到下方。"),
    );
  } else {
    const list = el("ul", { className: "device-list" });
    for (const device of devices) list.append(renderDeviceRow(device));
    section.append(list);
  }
  page.append(section);

  const form = el("form", { className: "panel" });
  form.append(el("h2", { className: "panel-title", text: "使用配对链接" }));
  form.append(
    el("p", { className: "hint", text: "配对秘密只在本机内存中使用，不会发送给中继以外的服务。" }),
  );
  const input = el("input", {
    className: "input",
    attrs: { type: "text", placeholder: "粘贴 http…/#/pair?relay=…&room=…&invite=…", autocomplete: "off", spellcheck: "false" },
  });
  const error = el("p", { className: "notice error hidden" });
  form.append(
    input,
    error,
    el("div", { className: "actions" }, [
      button("开始配对", () => {
        const link = parsePairingInput(input.value);
        if (!link) {
          error.textContent = "无法识别配对链接";
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
    const status = el("p", { className: "hint", text: "正在连接已配对设备…" });
    page.append(status);
    void connectAndShow(auto).catch((error: unknown) => {
      status.textContent = messageOf(error);
    });
  }

  page.append(
    el("p", { className: "hint bookmark-hint" }, [
      el("a", { attrs: { href: location.origin + "/" }, text: location.host }),
      " 可以收藏或添加到主屏幕，下次直接打开，不必再粘贴配对链接。",
    ]),
  );
  if (justPaired) {
    justPaired = false;
    page.append(
      el("p", { className: "hint bookmark-hint" }, [
        "配对完成，",
        el("a", { attrs: { href: craftsteadLanding(true) }, text: "回到 Craftstead 落地页" }),
        " 查看已配对状态。",
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
      button("连接", () => {
        void connectAndShow(device).catch((error: unknown) => {
          status.textContent = messageOf(error);
          status.classList.add("error");
        });
      }, "btn small"),
      button("移除", () => {
        if (!window.confirm(`移除「${device.bridge?.name ?? device.name}」？这台设备的配对凭据会从浏览器里删掉，要连回来得重新配对。`)) {
          return;
        }
        void removeDevice(device.relayUrl, device.roomId).then(() => showHome());
      }, "btn ghost small"),
    ]),
  ]);
  if (soon) {
    row.append(el("p", {
      className: "hint warn",
      text: "这台设备的凭据即将过期，到期后就无法连接。请在 Mac 上重新生成配对链接并重新配对。",
    }));
  }
  return row;
}

async function beginPairing(link: PairingLink): Promise<void> {
  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: "配对" }),
      el("h1", { className: "display", text: "正在建立加密通道" }),
      el("p", { className: "lede", text: "通过中继与 Mac 上的 Bridge 握手，稍候…" }),
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
  const confirm = button("确认码一致，完成配对", () => {
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = "请输入设备名称";
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
  const cancel = button("取消", () => {
    challenge.connection.close();
    showHome();
  }, "btn secondary");

  app.replaceChildren(
    el("main", { className: "page narrow" }, [
      el("p", { className: "eyebrow", text: "配对" }),
      el("h1", { className: "display", text: "核对确认码" }),
      el("p", { className: "lede", text: "Mac 上 Bridge 的终端应显示同一确认码。不一致说明通道被篡改，请取消。" }),
      el("div", { className: "code", text: challenge.confirmCode }),
      el("p", { className: "hint", text: relayTargetText(challenge.link.relayUrl) }),
      el("label", { className: "field" }, [el("span", { text: "设备名称" }), nameInput]),
      el("p", { className: "hint", text: "浏览器拿不到电脑名称，默认值只能取设备类型、系统版本和浏览器；改成你认得出的名字，Mac 菜单栏和其它设备都会按它显示，之后也能随时改。" }),
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
    return `中继：${relayUrl}，注意：不是你当前所在的站点`;
  }
  if (url.origin === location.origin) return `中继：${url.host}（本站）`;
  return `中继：${url.host}，注意：不是你当前所在的站点`;
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
  let kind = "浏览器";
  if (/iPhone/.test(ua)) kind = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) kind = "iPad";
  else if (/Android/.test(ua)) kind = "Android 设备";
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
    if (!getDeviceSecrets(device)) throw new Error("本地没有这台设备的凭据，需要重新配对");
    await ensureVault();
  } else if (needsUnlock()) {
    await ensureVault();
  }
  const found = getDeviceSecrets(device);
  if (!found) throw new Error("本地没有这台设备的凭据，需要重新配对");
  return found;
}

/** Pairing stores a private key, so a password must exist and be unlocked before saving. */
async function ensureVault(): Promise<void> {
  if (!hasVault()) {
    const created = await passwordDialog({
      title: "设置凭据密码",
      hint: "设备私钥会用这个密码加密后保存在本机，密码不会离开浏览器。忘记密码只能重新配对。",
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
    if (created === null) throw new LockedError("未设置密码，操作已取消");
    // 另一个标签页抢先设好了口令：接着走解锁流程，而不是覆盖那份存储。
    if (needsUnlock()) return ensureVault();
    return;
  }
  if (!needsUnlock()) return;
  const password = await passwordDialog({
    title: "解锁设备凭据",
    hint: "设备私钥已加密保存在本机。输入密码后 30 分钟内不需要再次输入。",
    submit: unlock,
    // 密码不可找回，唯一出路是清空本机凭据后重新配对，所以给一个显式出口。
    forgot: async () => {
      if (!window.confirm("清除本机保存的所有设备凭据？之后需要重新配对。")) return false;
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
        placeholder: "密码",
      },
    }) as HTMLInputElement;
    const again = el("input", {
      className: "input",
      attrs: { type: "password", autocomplete: "new-password", placeholder: "再输入一次" },
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
    const submit = button("继续", () => {
      void run();
    }, "btn primary");
    const cancel = button("取消", () => finish(null), "btn secondary");
    const fail = (message: string): void => {
      error.textContent = message;
      error.classList.remove("hidden");
      busy = false;
      submit.disabled = false;
    };
    const run = async (): Promise<void> => {
      if (busy) return;
      const value = input.value;
      if (value.length < 8) return fail("密码至少 8 位");
      if (options.confirm && again.value !== value) return fail("两次输入的密码不一致");
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
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void run();
      });
    }
    document.addEventListener("keydown", onKey);
    mask.addEventListener("click", (event) => {
      if (event.target === mask) finish(null);
    });

    const fields = [el("label", { className: "field" }, [el("span", { text: "密码" }), input])];
    if (options.confirm) {
      fields.push(el("label", { className: "field" }, [el("span", { text: "确认密码" }), again]));
    }
    const leading = el("div", {});
    const forgot = options.forgot;
    if (forgot) {
      leading.append(
        button("忘记密码", () => {
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
    flashNotice(pinned ? "已置顶，排在列表最前面" : "已取消置顶");
  } catch (error) {
    flashNotice(`置顶失败：${messageOf(error)}`);
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
      flashNotice("已归档，可在「显示已归档」里找回");
      return;
    }
    await renderRoute();
    flashNotice(archived ? "已归档，可在「显示已归档」里找回" : "已取消归档");
  } catch (error) {
    flashNotice(`归档失败：${messageOf(error)}`);
  }
}

async function deleteHostedSession(session: SessionSummary): Promise<void> {
  if (!window.confirm(`删除「${session.title}」？进程会停掉，Bridge 这边的聊天记录也会删掉，无法恢复。`)) return;
  try {
    await call("hosted.delete", { sessionId: session.sessionId });
    dropSession(session.sessionId);
    const route = parseRoute();
    if (route.level === "chat" && route.sessionId === session.sessionId) {
      navigate({ level: "sessions", appId: session.appId, projectId: session.projectId });
      flashNotice("已删除");
      return;
    }
    await renderRoute();
    flashNotice("已删除");
  } catch (error) {
    flashNotice(`删除失败：${messageOf(error)}`);
  }
}

/**
 * 重命名会话：Bridge 托管的会话直接改标题，其它来源只保存 Bridge 侧覆盖名，
 * 因此弹层会同时展示源应用里的原名。
 */
function renameSessionSheet(summary: SessionSummary, onSaved: (session: SessionSummary) => void): void {
  const input = el("input", {
    className: "input",
    attrs: { type: "text", maxlength: "60", placeholder: "会话名称" },
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
  const save = button("保存", () => {
    void submit(input.value.trim() || null);
  }, "btn primary");
  const reset = summary.originalTitle
    ? button("恢复原名", () => {
        void submit(null);
      }, "btn ghost")
    : null;
  const cancel = button("取消", finish, "btn secondary");

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submit(input.value.trim() || null);
  });
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) finish();
  });

  mask.append(
    el(
      "aside",
      { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "重命名会话" } },
      [
        el("header", { className: "sheet-head" }, [el("h2", { className: "sheet-title", text: "重命名会话" })]),
        el("label", { className: "field" }, [el("span", { text: "显示名称" }), input]),
        ...(summary.originalTitle
          ? [el("p", { className: "sheet-note", text: `原名：${summary.originalTitle}` })]
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
      el("p", { className: "eyebrow", text: "凭据已锁定" }),
      el("h1", { className: "display", text: "需要解锁" }),
      el("p", {
        className: "lede",
        text: "设备私钥已加密保存在本机，超过 30 分钟没有使用就需要重新输入密码。",
      }),
      el("div", { className: "actions" }, [
        button("输入密码", () => {
          void connectAndShow(device);
        }, "btn primary"),
        button("返回", () => showHome(), "btn secondary"),
      ]),
    ]),
  );
}

async function connectAndShow(device: DeviceMeta, attempt = 0): Promise<void> {
  const gen = generation;
  const soft = connected !== null;
  if (soft) {
    progressStart();
    setReconnecting(attempt <= 1 ? "连接已断开，正在重连…" : `第 ${attempt} 次重连中…`);
  } else {
    app.replaceChildren(
      el("main", { className: "page narrow" }, [
        el("p", { className: "eyebrow", text: "连接" }),
        el("h1", { className: "display", text: attempt === 0 ? "正在连接" : "正在重连" }),
        el("p", { className: "lede", text: "正在与 Mac 建立加密通道…" }),
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
      setReconnecting("重连失败，30 秒后继续重试…");
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
  const infoResponse = await opened.client.request("host.info");
  const devicesResponse = await opened.client.request("device.list");
  if (!infoResponse.ok || !devicesResponse.ok) {
    throw new Error(infoResponse.error?.message ?? devicesResponse.error?.message ?? "读取主机信息失败");
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
  progressDone();
  setReconnecting(null);
  void opened.connection.closed().then((info) => {
    if (gen + 1 !== generation || active !== opened.client) return;
    active = null;
    stopPolling();
    if (info.code === 4003) {
      showHome();
      return;
    }
    setReconnecting("连接已断开，正在重连…");
    scheduleRetry(device, 1);
  });
}

function scheduleRetry(device: DeviceMeta, attempt: number, message?: string): void {
  const gen = generation;
  const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  if (connected) {
    setReconnecting(message ?? `连接已断开，${Math.round(delay / 1000)} 秒后重连…`);
  } else {
    progressDone();
    app.replaceChildren(
      el("main", { className: "page narrow" }, [
        el("p", { className: "eyebrow", text: "连接" }),
        el("h1", { className: "display", text: "连接已断开" }),
        el("p", { className: "lede", text: message ?? `加密通道中断，${Math.round(delay / 1000)} 秒后重连…` }),
      ]),
    );
  }
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
  if (!active) throw new Error("连接已断开");
  const response = await active.request(method, params, timeoutMs);
  if (!response.ok) throw new Error(response.error?.message ?? `${method} 失败`);
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
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
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
  const [projects, ...sessionPages] = await Promise.all([
    call<ProjectListResult>("project.list"),
    ...apps.apps.map((app) =>
      call<SessionListResult>("session.list", { appId: app.appId, includeArchived: true, limit: 500 }),
    ),
  ]);
  const notes = sessionPages.flatMap((page) => (page.note ? [page.note] : []));
  snapshot = {
    apps: apps.apps,
    projects: projects.projects,
    sessions: sessionPages.flatMap((page) => page.sessions),
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
  const crumbs: Crumb[] = [{ label: "客户端", href: hashFor({ level: "clients" }) }];
  if (route.level === "devices") return [{ label: "已授权设备" }];
  if (route.level === "clients") return [];
  const app = data?.apps.find((item) => item.appId === route.appId);
  crumbs.push(
    route.level === "projects"
      ? { label: app?.name ?? "客户端" }
      : { label: app?.name ?? "客户端", href: hashFor({ level: "projects", appId: route.appId }) },
  );
  if (route.level === "sessions" || route.level === "chat") {
    const project = data?.projects.find((item) => item.projectId === route.projectId);
    crumbs.push(
      route.level === "sessions"
        ? { label: project?.name ?? "工程" }
        : { label: project?.name ?? "工程", href: hashFor({ level: "sessions", appId: route.appId, projectId: route.projectId }) },
    );
  }
  if (route.level === "chat") {
    const session = data?.sessions.find((item) => item.sessionId === route.sessionId);
    crumbs.push(
      route.taskId
        ? { label: session?.title ?? "会话", href: hashFor({ level: "chat", appId: route.appId, projectId: route.projectId, sessionId: route.sessionId }) }
        : { label: session?.title ?? "会话" },
    );
    if (route.taskId) crumbs.push({ label: "后台任务" });
  }
  return crumbs;
}

function renderShell(content: HTMLElement, crumbs: Crumb[]): void {
  app.replaceChildren(
    renderTopbar(crumbs),
    el("div", { className: "shell" }, [
      dockSidebar(parseRoute()),
      el("div", { className: "shell-main" }, [content]),
    ]),
  );
}

const DOCK_TAB_KEY = "ab.dockTab";
const DOCK_SESSIONS_PER_PROJECT = 8;
const DOCK_HISTORY_LIMIT = 30;
type DockTab = "tree" | "history";

function readDockTab(): DockTab {
  try {
    return localStorage.getItem(DOCK_TAB_KEY) === "history" ? "history" : "tree";
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

function agentLabel(kind: string): string {
  if (kind === "codex" || kind === "codex-cli" || kind === "codex-thread") return "ChatGPT";
  if (kind === "antigravity" || kind === "antigravity-desktop") return "Antigravity";
  if (kind === "dsh") return "DeepSeek";
  if (kind === "pi") return "pi";
  if (kind === "hosted") return "托管";
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
      el("span", { className: "pill tiny busy" }, [el("span", { className: "spinner" }), document.createTextNode("运行中")]),
    );
  } else if (session.needsDecision) {
    pills.push(el("span", { className: "pill tiny warn", text: "待回答" }));
  }
  if (unreadAt(session.sessionId) !== undefined) {
    pills.push(el("span", { className: "pill tiny unread", text: "未读" }));
  }
  return pills;
}

function dockSessionButton(session: SessionSummary, active: boolean): HTMLButtonElement {
  const pills = dockStatePills(session);
  const node = el("button", { className: `dock-session${active ? " is-active" : ""}`, attrs: { type: "button" } }, [
    el("span", {
      className: `mark ${session.busy ? "busy" : session.live ? "live" : ""}`,
      text: agentMark(session.kind),
    }),
    el("span", { className: "dock-session-title", text: session.title }),
    ...(pills.length > 0 ? [el("span", { className: "dock-session-pills" }, pills)] : []),
  ]);
  node.title = session.title;
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
    wrap.append(el("p", { className: "hint", text: "正在读取会话…" }));
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
          button(`还有 ${rest} 条…`, () => {
            navigate({ level: "sessions", appId: project.appId, projectId: project.projectId });
          }, "dock-more"),
        );
      }
      appNode.append(projectNode);
    }
    wrap.append(appNode);
    rendered += 1;
  }
  if (rendered === 0) wrap.append(el("p", { className: "hint", text: "还没有会话。" }));
  return wrap;
}

/** 第二个 tab：所有会话按最近更新排序。 */
function dockHistory(): HTMLElement {
  const wrap = el("div", { className: "dock-list" });
  const data = snapshot;
  if (!data) {
    wrap.append(el("p", { className: "hint", text: "正在读取会话…" }));
    return wrap;
  }
  const active = dockActive(parseRoute());
  const sessions = visibleSessions(data.sessions).slice(0, DOCK_HISTORY_LIMIT);
  if (sessions.length === 0) {
    wrap.append(el("p", { className: "hint", text: "还没有会话。" }));
    return wrap;
  }
  for (const session of sessions) {
    const current = active.sessionId === session.sessionId;
    const node = el("button", { className: `dock-history-row${current ? " is-active" : ""}`, attrs: { type: "button" } }, [
      el("span", { className: "dock-history-title", text: session.title }),
      el("span", { className: "dock-history-facts" }, [
        el("span", {
          className: "dock-history-meta",
          text: `${agentLabel(session.kind)} · ${recentTime(session.updatedAt)}`,
        }),
        ...dockStatePills(session),
      ]),
    ]);
    node.title = `${session.title}\n${session.projectId}`;
    if (current) node.setAttribute("aria-current", "page");
    node.addEventListener("click", () => {
      navigate({
        level: "chat",
        appId: session.appId,
        projectId: session.projectId,
        sessionId: session.sessionId,
      });
    });
    wrap.append(node);
  }
  return wrap;
}

/** 桌面宽屏左侧的 dock：结构树与历史两个 tab，选中的 tab 记在 localStorage。 */
function dockSidebar(route: Route): HTMLElement {
  let tab = readDockTab();
  const nav = el("nav", { className: "dock", attrs: { "aria-label": "会话导航" } });
  const tabs = el("div", { className: "dock-tabs", attrs: { role: "tablist" } });
  const body = el("div", { className: "dock-body" });
  const makeTab = (id: DockTab, label: string): HTMLButtonElement => {
    const node = el("button", { className: "dock-tab", text: label, attrs: { type: "button", role: "tab" } });
    node.addEventListener("click", () => {
      if (tab === id) return;
      tab = id;
      writeDockTab(id);
      paint();
    });
    return node;
  };
  const treeTab = makeTab("tree", "结构");
  const historyTab = makeTab("history", "历史");
  tabs.append(treeTab, historyTab);
  const paint = (): void => {
    for (const [id, node] of [["tree", treeTab], ["history", historyTab]] as const) {
      node.classList.toggle("is-active", tab === id);
      node.setAttribute("aria-selected", String(tab === id));
    }
    body.replaceChildren(tab === "tree" ? dockTree(route) : dockHistory());
  };
  paint();
  nav.append(tabs, body);
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

function agentMark(kind: SessionSummary["kind"] | AppInfo["kind"]): string {
  if (kind === "codex" || kind === "codex-cli" || kind === "codex-thread") return "CX";
  if (kind === "antigravity" || kind === "antigravity-desktop") return "AG";
  if (kind === "dsh") return "DS";
  if (kind === "pi") return "PI";
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
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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
      "aria-label": "最近访问的会话",
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
      menu.append(el("div", { className: "recent-empty", text: "还没有访问记录" }));
      return;
    }
    menu.append(el("div", { className: "recent-menu-title", text: "最近访问" }));
    for (const item of items.slice(0, 12)) {
      const app = snapshot?.apps.find((candidate) => candidate.appId === item.appId);
      const meta = [app ? shortAgentName(app) : item.appId, recentProjectName(item.projectId), recentTime(item.at)];
      // 最近访问只存了标题等静态信息，执行状态要回到当前快照里查。
      const running = snapshot?.sessions.some(
        (session) => session.sessionId === item.sessionId && session.busy === true,
      ) === true;
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
  const label = prev.step === "back" ? "上一个对话" : "回到刚才";
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
      "aria-label": "切换 Agent",
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
      el("span", { className: "agent-menu-state", text: active ? "当前" : statusLabel(item.status) }),
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
  const preview =
    location.hostname === "agent-bridge-preview.craftstead.app" ||
    location.hostname.endsWith(".workers.dev");
  if (!preview) return "https://craftstead.app/agent-bridge";
  const base = "https://develop.craftstead.pages.dev/agent-bridge";
  return paired ? base + "?ab_paired=1" : base;
}

function renderTopbar(crumbs: Crumb[]): HTMLElement {
  // 预览部署在预览域上，回链也停在预览官网，别把试用的人送去生产。
  const landing = craftsteadLanding(true);
  const nav = el("nav", { className: "crumbs", attrs: { "aria-label": "位置" } });
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
      button("设备", () => navigate({ level: "devices" }), "btn ghost small"),
      button("断开", showHome, "btn ghost small"),
    );
    right.append(topbarOverflow(secondary));
  }
  return el("header", { className: "topbar" }, [
    el("a", { className: "brand", attrs: { href: hashFor({ level: "clients" }) } }, [
      el("span", { className: "brand-mark", text: "AB" }),
      el("span", { className: "brand-name", text: "Agent Bridge" }),
    ]),
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
  toggle.setAttribute("aria-label", "更多操作");

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
 * Completion notifications need the browser's permission, which only a user gesture can
 * request in Safari; the topbar button is that gesture, and it also switches them off.
 */
function notifyButton(): HTMLButtonElement | null {
  // iPhone 的 Safari 窗口里没有推送能力，但按钮留着才能告诉用户先装到主屏幕。
  if (!notificationsSupported() && !iosNeedsInstall()) return null;
  const denied = notificationPermission() === "denied";
  const enabled = notificationsOn();
  const node = button("", () => void toggleNotifications(), `btn ghost small notify-btn${enabled ? " is-on" : ""}`);
  node.append(icon(enabled ? "bell" : "bellOff"), el("span", { text: enabled ? "提醒已开" : "开启提醒" }));
  node.title = !notificationsSupported()
    ? IOS_HINT
    : denied
      ? "通知已被浏览器禁止，请在站点设置中允许通知"
      : enabled
        ? "关闭完成与待回答提醒"
        : "开启浏览器提醒：对话完成或等你回答时推送到通知中心";
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
    window.alert(`通知已被浏览器禁止。请在浏览器的站点设置中允许通知，然后刷新页面。\n\n${IOS_HINT}`);
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
    problem = "这个浏览器只能在页面打开时提醒";
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
      renderShell(errorView("读取失败", messageOf(error)), crumbsFor(route));
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
function repaintList(): void {
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
  document.title = "客户端 · Agent Bridge";

  const list = el("ul", { className: "list" });
  if (data.apps.length === 0) {
    list.append(el("li", {}, [emptyState("没有可用的客户端", "Bridge 没有发现任何桌面适配器。")]));
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
          text: `${projects.length} 个工程 · ${sessions.length} 个会话${unread > 0 ? ` · ${unread} 未读` : ""} · 枚举${completenessLabel(item.capabilities.enumerate)} · 读取${completenessLabel(item.capabilities.read)} · ${item.capabilities.send ? "可发送" : "不可发送"}`,
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
      viewHead("客户端", "已连接的客户端", `${data.apps.length} 个客户端 · ${totalProjects} 个工程 · ${totalSessions} 个会话`),
      ...(connected ? [selfDeviceCard()] : []),
      list,
      button("刷新列表", () => {
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
  document.title = `${appInfo?.name ?? "客户端"} · Agent Bridge`;
  const projects = data.projects.filter((project) => project.appId === route.appId);

  const list = el("ul", { className: "list" });
  if (projects.length === 0) {
    list.append(el("li", {}, [emptyState("这个客户端还没有工程", "桌面应用里创建或打开一个工程后，再回来刷新。")]));
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
        text: `${sessions.length || project.sessionCount} 个会话${unread > 0 ? ` · ${unread} 未读` : ""}`,
      }),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () => navigate({ level: "sessions", appId: route.appId, projectId: project.projectId }));
    list.append(el("li", {}, [row]));
  }

  const isHosted = route.appId === "hosted";
  const addForm = isHosted
    ? hostedAddDirForm(() => {
        snapshot = null;
        void renderRoute();
      })
    : null;
  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "clients" })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: appInfo?.name ?? "客户端" }),
          el("h1", { className: "display", text: "工程" }),
          el("p", {
            className: "meta",
            text: `${projects.length} 个工程，按会话数量排列${isHosted ? "；托管目录可在本页添加" : ""}`,
          }),
        ]),
        ...(addForm
          ? [
              button(
                "添加目录",
                () => {
                  addForm.hidden = !addForm.hidden;
                  if (!addForm.hidden) addForm.querySelector("input")?.focus();
                },
                "btn ghost small",
              ),
            ]
          : []),
        button(
          "刷新",
          () => {
            snapshot = null;
            void renderRoute();
          },
          "btn ghost small",
        ),
      ]),
      ...(addForm ? [addForm] : []),
      list,
    ]),
    crumbsFor(route),
  );
}

/** 把本机目录加入托管白名单：必须是已存在的绝对路径，添加后立刻出现在工程列表里。 */
function hostedAddDirForm(onAdded: () => void): HTMLElement {
  const input = el("input", {
    className: "input mono",
    attrs: { type: "text", placeholder: "/Users/you/code/project", spellcheck: "false", autocomplete: "off" },
  });
  const status = el("p", { className: "hint", text: "填这台 Mac 上已存在的绝对路径，添加后即可从这里新建托管会话。" });
  const form = el("div", { className: "add-dir" }, [input, button("添加", () => void submitPath(), "btn primary small"), status]);
  form.hidden = true;
  const submitPath = async (): Promise<void> => {
    const path = input.value.trim();
    if (!path) {
      status.classList.add("error");
      status.textContent = "先填目录路径。";
      return;
    }
    status.classList.remove("error");
    status.textContent = "正在添加…";
    try {
      await call<HostedDirsResult>("hosted.addDir", { path });
      onAdded();
    } catch (error) {
      status.classList.add("error");
      status.textContent = messageOf(error);
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submitPath();
  });
  return form;
}

function renderSessions(route: Route & { level: "sessions" }): void {
  const data = snapshot!;
  const project = data.projects.find((item) => item.projectId === route.projectId);
  const appInfo = data.apps.find((item) => item.appId === route.appId);
  document.title = `${project?.name ?? "工程"} · Agent Bridge`;
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
  const openCreate = (): void => {
    if (!panelHost || !project || !appInfo) return;
    if (canCreateDesktop) {
      desktopDraft = { projectId: project.projectId, text: "" };
      panelHost.replaceChildren(desktopCreatePanel(project, appInfo, desktopDraft));
    } else {
      hostedDraft = {
        projectId: project.projectId,
        title: "",
        model: "",
        effort: "",
        mode: "manual",
        agent: "claude",
        subagentModel: "",
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
          ? emptyState("还没有托管会话", "点「新建托管会话」，由这台 Mac 上的 Bridge 启动一个 Claude Code 或 pi 进程。")
          : canCreateDesktop
            ? emptyState("这个工程还没有会话", `点「新对话」，由这台 Mac 上的 Bridge 启动一次 ${appInfo?.name ?? "桌面客户端"}。`)
            : emptyState("这个工程还没有会话", "在桌面应用里开始一次对话后，再回来刷新。"),
      ]),
    );
  }
  for (const session of sessions) {
    const busy = session.busy === true;
    const unread = unreadAt(session.sessionId) !== undefined;
    const state = busy
      ? "正在执行"
      : session.hosted
        ? session.canSend
          ? session.live
            ? "Bridge 托管进程运行中"
            : "Bridge 托管，发送时自动恢复"
          : (session.sendBlockedReason ?? "只读")
        : session.canSend
          ? session.live
            ? "桌面运行中，可发送"
            : sendStateLabel(session)
          : (session.sendBlockedReason ?? "只读");
    // 托管会话的模型和权限模式在列表里也常驻显示，不必点进侧栏才知道。
    const hostedFacts = session.hosted
      ? ` · 模型 ${hostedModelLabel(session.model)} · ${hostedModeFact(session)}`
      : "";
    const row = el("button", { className: "row", attrs: { type: "button" } }, [
      el(
        "span",
        { className: `mark ${busy ? "busy" : session.live ? "live" : ""}` },
        busy
          ? [el("span", { className: "spinner mark-spinner" })]
          : [document.createTextNode(agentMark(session.kind))],
      ),
      el("span", { className: "row-main" }, [
        el("strong", { className: "row-title" }, [
          ...(session.pinned ? [icon("pin", "icon pin-mark")] : []),
          document.createTextNode(session.title),
        ]),
        ...(session.originalTitle
          ? [el("span", { className: "row-original", text: `原名：${session.originalTitle}` })]
          : []),
        el("span", {
          className: "meta",
          text: `${timeLabel(session.updatedAt)} · ${state}${hostedFacts}`,
        }),
      ]),
      busy
        ? el("span", { className: "pill busy" }, [
            el("span", { className: "spinner" }),
            document.createTextNode("执行中"),
          ])
        : el("span", { className: session.canSend ? "pill ok" : "pill", text: sendStateLabel(session) }),
      ...(unread ? [el("span", { className: "pill unread", text: "未读" })] : []),
      ...(session.archived ? [el("span", { className: "pill", text: "已归档" })] : []),
      icon("chevron", "icon chev"),
    ]);
    row.addEventListener("click", () =>
      navigate({ level: "chat", appId: route.appId, projectId: route.projectId, sessionId: session.sessionId }),
    );
    // 行上的操作浮在右侧，鼠标移上来才出现，免得和行本身的状态标挤在一起。
    const actions = el("div", { className: "row-menu" }, [
      rowAction(
        session.pinned ? icon("pinOff") : icon("pin"),
        session.pinned ? "取消置顶" : "置顶",
        () => void setSessionPinned(session, !session.pinned),
      ),
      ...(session.hosted
        ? [
            rowAction(
              session.archived ? icon("unarchive") : icon("archive"),
              session.archived ? "取消归档" : "归档",
              () => void setSessionArchived(session, !session.archived),
            ),
            rowAction(icon("trash"), "删除", () => void deleteHostedSession(session), "danger"),
          ]
        : []),
    ]);
    list.append(el("li", { className: session.archived ? "row-item is-archived" : "row-item" }, [row, actions]));
  }

  const createHosted = canCreateHosted || canCreateDesktop ? button("", openCreate, "btn small create-btn") : null;
  if (createHosted) {
    createHosted.append(
      el("span", {
        className: "create-label-full",
        text: canCreateHosted ? "新建托管会话" : "新对话",
      }),
      el("span", { className: "create-label-short", text: "新建" }),
    );
  }

  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "projects", appId: route.appId })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: `${appInfo?.name ?? "客户端"}${project?.cwd ? ` · ${project.cwd}` : ""}` }),
          el("h1", { className: "display", text: project?.name ?? "会话" }),
          el("p", {
            className: "meta",
            text: isHosted
              ? `${sessions.length} 个会话 · 由这台 Mac 上的 Bridge 托管，不出现在桌面应用`
              : `${sessions.length} 个会话 · 置顶在前，其余按最近更新${createDetail ? " · 无法新建对话" : ""}`,
          }),
        ]),
        ...(archivedCount > 0
          ? [
              button(
                showArchived ? `隐藏已归档（${archivedCount}）` : `显示已归档（${archivedCount}）`,
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
                text: "新对话",
                attrs: { type: "button", disabled: "", title: createDetail },
              }),
            ]
          : []),
        button(
          "刷新",
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
    short: "每次操作都要确认",
    detail: "文件编辑、shell 命令、联网访问都会停下来等你确认。最安全的日常模式。",
  },
  acceptEdits: {
    short: "工作目录内编辑免确认",
    detail: "工作目录内的文件编辑，以及 mkdir/rm/mv/cp/sed 等常见文件命令自动放行；目录外路径、受保护路径（.git/.claude 等）和其它 shell 命令仍要确认。",
  },
  plan: {
    short: "先出计划不动手",
    detail: "只读代码并给出计划，不修改源码；计划批准后才按选定方式执行。不是完全只读。",
  },
  dontAsk: {
    short: "不问，需要确认的直接拒绝",
    detail: "不会弹出确认：凡是需要确认的操作一律自动拒绝，只运行只读命令和已预先授权的操作。无人值守时最安全，但联网、写文件常被拒。",
  },
  auto: {
    short: "分类器自动判定",
    detail: "由分类器逐个审查动作：明显危险的被拦下并说明原因，其余自动放行；只有少数情况仍会询问。",
  },
  bypassPermissions: {
    short: "跳过权限检查",
    detail: "不再询问、跳过安全检查，deny 规则和 sandbox（文件/网络隔离）仍然生效。只应在隔离环境里用。",
  },
};

/** 会话列表与聊天页顶部用：权限模式的中文短名，未知值原样显示。 */
function hostedModeShort(mode: string | undefined): string {
  if (!mode) return "manual";
  return HOSTED_MODE_HELP[mode]?.short ?? mode;
}

/** 托管会话的权限事实：pi 没有权限模式，写引擎名，免得显示一个不生效的 manual。 */
function hostedModeFact(session: SessionSummary): string {
  return session.hostedAgent === "pi" ? "pi 托管" : `权限 ${hostedModeShort(session.permissionMode)}`;
}

/** 托管会话的模型：记录过就用记录值，否则说明沿用 CLI 默认。 */
function hostedModelLabel(model: string | undefined): string {
  return model ? model : "CLI 默认";
}

function effortLabel(level: string): string {
  const known: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };
  return known[level] ? `${known[level]}（${level}）` : level;
}

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
  draft: { title: string; model: string; effort: string; mode: string; agent: HostedAgent; subagentModel: string },
): HTMLElement {
  const form = el("form", { className: "panel hosted-create" });
  const status = el("p", { className: "hint", text: "正在读取 Bridge 允许的目录与权限模式…" });
  const agent = el("select", { className: "input", attrs: { "aria-label": "托管引擎" } });
  agent.append(el("option", { text: "Claude Code", attrs: { value: "claude" } }));
  const mode = el("select", { className: "input" });
  const modeHint = el("p", { className: "hint" });
  const model = el("select", { className: "input", attrs: { "aria-label": "模型" } });
  model.append(el("option", { text: "CLI 默认", attrs: { value: "" } }));
  const effort = el("select", { className: "input", attrs: { "aria-label": "思考程度" } });
  effort.append(el("option", { text: "CLI 默认", attrs: { value: "" } }));
  // pi 的模型清单要跑过一次才拿得到，新建时只能手填 `厂商/模型`。
  const subagentModel = el("input", {
    className: "input mono",
    attrs: {
      type: "text",
      placeholder: "例如 group/dsgroup；留空跟随 pi 设置",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "子代理模型",
    },
  });
  subagentModel.value = draft.subagentModel;
  subagentModel.addEventListener("input", () => {
    draft.subagentModel = subagentModel.value;
  });
  const optionsHint = el("p", { className: "hint", text: "正在读取本机 CLI 支持的模型与思考程度…" });
  const effortHint = el("p", { className: "hint", text: "思考程度越高，回答更细致，但更慢也更费额度。" });
  const title = el("input", {
    className: "input",
    attrs: { type: "text", placeholder: "标题（可选）", maxlength: "60" },
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
    attrs: { type: "text", placeholder: "例如 --agent mix-agent，回车添加", "aria-label": "启动参数" },
  });
  const argsList = el("div", { className: "arg-list" });
  const renderArgs = (): void => {
    const prefs = loadHostedArgPrefs();
    if (prefs.length === 0) {
      argsList.replaceChildren(el("p", { className: "hint", text: "还没有保存过启动参数。" }));
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
        remove.title = "删除这个参数";
        remove.setAttribute("aria-label", `删除 ${pref.value}`);
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
  argsInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    // 回车只加参数，不提交表单。
    event.preventDefault();
    addArg(argsInput.value);
    argsInput.value = "";
  });
  renderArgs();
  const submit = button("创建", () => {
    const cwd = project.cwd;
    if (!cwd) return;
    submit.disabled = true;
    status.classList.remove("error");
    const piSelected = draft.agent === "pi";
    status.textContent = `正在启动 ${piSelected ? "pi" : "Claude Code"}…`;
    const permissionMode = (mode.value || "manual") as HostedPermissionMode;
    const extraArgs = loadHostedArgPrefs().filter((item) => item.enabled).map((item) => item.value);
    void call<SessionGetResult>("hosted.create", {
      path: cwd,
      agent: draft.agent,
      permissionMode,
      ...(!piSelected && model.value.trim() ? { model: model.value.trim() } : {}),
      ...(!piSelected && effort.value.trim() ? { effort: effort.value.trim() } : {}),
      ...(piSelected && subagentModel.value.trim() ? { subagentModel: subagentModel.value.trim() } : {}),
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
  const modeField = el("label", { className: "field" }, [el("span", { text: "权限模式" }), mode]);
  const modelField = el("label", { className: "field" }, [el("span", { text: "模型" }), model]);
  const effortField = el("label", { className: "field" }, [el("span", { text: "思考程度" }), effort]);
  const subagentField = el("label", { className: "field" }, [el("span", { text: "子代理模型（可选）" }), subagentModel]);
  const argsHint = el("p", { className: "hint" });
  const agentHint = el("p", { className: "hint" });
  const syncAgent = (): void => {
    const pi = draft.agent === "pi";
    // pi 没有权限模式与思考程度；模型清单也要等它跑过一次才拿得到，选 pi 时一并收起。
    for (const node of [modeField, modeHint, modelField, effortField, effortHint, optionsHint]) node.hidden = pi;
    subagentField.hidden = !pi;
    argsHint.textContent = pi
      ? "打钩的参数随新建一起传给 pi；--mode、--session 这类会话与协议旗标不接受。"
      : "打钩的参数随新建一起传给 claude；会话身份、输出协议与权限相关的旗标不接受。";
    agentHint.textContent = pi
      ? "pi 用 `pi --mode rpc` 常驻，斜杠命令、扩展提问与换模型都能在网页里用。"
      : "";
    agentHint.hidden = !pi;
  };
  agent.addEventListener("change", () => {
    draft.agent = agent.value === "pi" ? "pi" : "claude";
    syncAgent();
  });
  form.append(
    el("p", { className: "panel-title", text: "新建 Bridge 托管会话" }),
    el("label", { className: "field" }, [
      el("span", { text: "工作目录（仅限 Mac 上的允许列表）" }),
      el("input", { className: "input", attrs: { type: "text", value: project.cwd ?? "", readOnly: "" } }),
    ]),
    el("label", { className: "field" }, [el("span", { text: "托管引擎" }), agent]),
    agentHint,
    modeField,
    modeHint,
    modelField,
    effortField,
    effortHint,
    optionsHint,
    subagentField,
    el("div", { className: "field" }, [el("span", { text: "启动参数（可选）" }), argsInput, argsList]),
    argsHint,
    el("label", { className: "field" }, [el("span", { text: "标题" }), title]),
    status,
    el("div", { className: "row-actions" }, [submit]),
  );
  syncAgent();
  void call<HostedOptionsResult>("hosted.options")
    .then((info) => {
      const groups: Array<[string, ModelOption[]]> = [
        ["自定义", info.models.filter((item) => item.section === "custom")],
        ["常用", info.models.filter((item) => (item.section ?? "main") === "main")],
        ["更多", info.models.filter((item) => item.section === "overflow")],
      ];
      const modelNodes: Array<Node | string> = [el("option", { text: "CLI 默认", attrs: { value: "" } })];
      // 之前选过、这次清单里没有的模型（换了 CLI 版本）也留着，别把草稿静默改掉。
      if (draft.model && !info.models.some((item) => item.id === draft.model)) {
        modelNodes.push(el("option", { text: `${draft.model}（清单里没有）`, attrs: { value: draft.model } }));
      }
      for (const [label, group] of groups) {
        if (group.length === 0) continue;
        modelNodes.push(
          el("optgroup", { attrs: { label } }, group.map((item) => el("option", { text: item.name, attrs: { value: item.id } }))),
        );
      }
      model.replaceChildren(...modelNodes);
      model.value = draft.model;

      const effortNodes: Array<Node | string> = [el("option", { text: "CLI 默认", attrs: { value: "" } })];
      if (draft.effort && !info.efforts.includes(draft.effort)) {
        effortNodes.push(el("option", { text: `${draft.effort}（当前 CLI 不认）`, attrs: { value: draft.effort } }));
      }
      effortNodes.push(...info.efforts.map((level) => el("option", { text: effortLabel(level), attrs: { value: level } })));
      effort.replaceChildren(...effortNodes);
      effort.value = draft.effort;

      optionsHint.textContent = info.note ?? "";
      optionsHint.hidden = !info.note;

      const agentOptions = info.agents ?? [{ id: "claude" as const, label: "Claude Code", available: true }];
      agent.replaceChildren(
        ...agentOptions.map((item) =>
          el("option", {
            text: item.available ? item.label : `${item.label}（不可用）`,
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
      optionsHint.textContent = `读不到模型与思考程度：${messageOf(error)}`;
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
        : "；bypassPermissions 未开放（Mac 侧 hosted.json 的 allowBypassPermissions）";
      status.textContent = config.enabled
        ? `只在 ${project.cwd ?? ""} 中运行；网页断开不会结束进程，空闲 ${idle} 分钟后自动停止，再发消息时 resume。${bypassNote}`
        : (config.note ?? "Bridge 还没有配置可托管的目录。");
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
    attrs: { rows: "4", placeholder: "第一条消息", "aria-label": "第一条消息" },
  });
  text.value = draft.text;
  text.addEventListener("input", () => {
    draft.text = text.value;
  });
  const submit = button("创建", () => {
    const message = text.value.trim();
    if (!message) {
      status.classList.add("error");
      status.textContent = "先写下第一条消息";
      return;
    }
    submit.disabled = true;
    status.classList.remove("error");
    status.textContent = `正在启动 ${appInfo.name}…`;
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
    el("p", { className: "panel-title", text: `新建 ${appInfo.name} 会话` }),
    el("label", { className: "field" }, [
      el("span", { text: "工作目录" }),
      el("input", { className: "input", attrs: { type: "text", value: project.cwd ?? "", readOnly: "" } }),
    ]),
    el("label", { className: "field" }, [el("span", { text: "第一条消息" }), text]),
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
      el("h2", { className: "panel-title", text: "本设备" }),
      el("p", { className: "hint", text: "这台浏览器在 Bridge 里的名字，Mac 菜单栏和其它设备都按它显示。" }),
      el("div", { className: "row-main" }, [el("strong", { className: "row-title", text: name })]),
      el("div", { className: "actions" }, [button("改名", showForm, "btn ghost small")]),
    );
  };
  const showForm = (): void => {
    const input = el("input", {
      className: "input",
      attrs: { type: "text", value: connected?.device.name ?? "", maxlength: "64" },
    });
    const error = el("p", { className: "notice error hidden" });
    const save = button("保存", () => {
      const name = input.value.trim();
      if (!name) {
        error.textContent = "请输入设备名称";
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
      el("h2", { className: "panel-title", text: "本设备" }),
      el("label", { className: "field" }, [el("span", { text: "设备名称" }), input]),
      error,
      el("div", { className: "actions" }, [save, button("取消", showName, "btn ghost small")]),
    );
    input.focus();
    input.select();
  };
  showName();
  return panel;
}

function renderDevices(): void {
  const state = connected!;
  document.title = "已授权设备 · Agent Bridge";
  const list = el("ul", { className: "list" });
  const status = el("p", { className: "hint" });
  for (const item of state.devices) {
    const revoked = item.revokedAt !== null;
    const self = item.deviceId === state.device.deviceId;
    const label = el("div", { className: "row-main" }, [
      el("strong", { text: item.name }),
      el("span", { className: "meta", text: `${expireLabel(item.expiresAt)} · ${new Date(item.createdAt).toLocaleString()}` }),
    ]);
    list.append(
      el("li", { className: "device-row" }, [
        label,
        el("div", { className: "row-actions" }, revoked
          ? [el("span", { className: "pill", text: "已撤销" })]
          : self
            ? [
              el("span", { className: "pill", text: "本机" }),
              button("重命名", () => beginRename(item, label), "btn ghost small"),
            ]
            : [el("span", { className: "meta", text: "在 Mac 上撤销" })]),
      ]),
    );
  }

  renderShell(
    el("main", { className: "main" }, [
      el("section", { className: "view-head" }, [
        backButton(() => navigate({ level: "clients" })),
        el("div", { className: "view-head-main" }, [
          el("p", { className: "eyebrow", text: state.info.name }),
          el("h1", { className: "display", text: "已授权设备" }),
          el("p", { className: "meta", text: `Bridge ${state.info.version} · 前端 ${APP_VERSION} · ${state.info.platform} · 通道已加密（Noise IK）` }),
        ]),
      ]),
      list,
      status,
      el("div", { className: "actions" }, [
        button("刷新", () => {
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
  if (!local) throw new Error("还没有连接 Bridge");
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
  const save = button("保存", () => {
    const name = input.value.trim();
    if (!name) {
      error.textContent = "请输入设备名称";
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
  const cancel = button("取消", () => renderDevices(), "btn ghost small");
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
  return value === "complete" ? "完整" : value === "partial" ? "部分" : value === "unknown" ? "未知" : "不可用";
}

function statusLabel(status: AppInfo["status"]): string {
  return status === "ready" ? "可用" : status === "needs_permission" ? "需要授权" : "不可用";
}

function hostedControlButton(summary: SessionSummary): HTMLButtonElement {
  const node = button(
    summary.live ? "停止进程" : "恢复进程",
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
    ? "结束这台 Mac 上的托管进程；会话记录保留，之后可恢复"
    : "在这台 Mac 上 resume 这个托管会话";
  return node;
}

function sendStateLabel(session: SessionSummary): string {
  if (session.hosted) {
    if (!session.canSend) return "只读";
    return session.live ? "托管运行中" : "可恢复";
  }
  if (session.live) return "桌面运行中";
  if (!session.canSend) return "只读";
  return "可发送";
}

function timeLabel(timestamp: number): string {
  if (!timestamp) return "时间未知";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString();
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
  /** 客户端报告的斜杠命令与技能（名字不带斜杠），输入「/」时提示。 */
  slashCommands?: string[];
  /** 「停止」按钮：只在 Bridge 托管的会话且回合还在跑时出现。 */
  stopButton?: HTMLButtonElement;
  /** 压缩请求的状态；弹层重绘后仍保留，避免重复提交或丢失反馈。 */
  compact?: { pending: boolean; error?: string; note?: string };
  /** 点击压缩的时间；早于它发出的轮询不能用来判断压缩是否完成。 */
  compactSince?: number;
  /** 已经作答的问题（按块文本 + 问题文本索引）；重绘后仍显示「已发送」，避免重复提交。 */
  answers?: Map<string, string[]>;
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
      errorView("找不到这个会话", "它可能已经从桌面应用中删除，返回列表刷新试试。"),
      crumbsFor(route),
    );
    return;
  }
  document.title = `${summary.title} · Agent Bridge`;
  rememberSession(summary);
  noteSessionTrail(hashFor(route), summary.title);
  markRead(summary.sessionId);

  const note = el("p", { className: "hint" });
  const list = el("div", { className: "transcript-body" });
  const status = el("p", { className: "hint" });
  const loadOlder = button("", () => {
    void loadOlderPage(state);
  }, "icon-btn composer-tool");
  loadOlder.append(icon("history"));
  loadOlder.setAttribute("aria-label", "加载更早的消息");
  loadOlder.title = "加载更早的消息";
  loadOlder.disabled = true;

  const contextButton = el("button", {
    className: "icon-btn context-btn",
    attrs: { type: "button", "aria-label": "上下文用量", title: "上下文用量", "aria-expanded": "false" },
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
      placeholder: canSend ? "发送到这个会话…" : (sendBlockedReason ?? "该会话当前不可发送"),
    },
  });
  input.value = draftFor(summary.sessionId);

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

  const submit = (): void => {
    if (sendButton.disabled) return;
    void sendMessage(state, input, status, sendButton, loadOlder, pending, renderAttachments, updateSendState, () => setCollapsed(true));
  };
  const sendButton = button("发送", submit, "btn primary");
  sendButton.disabled = !canSend;

  // 托管会话的回合可以从网页直接停：进程留着，CLI 收到 interrupt 后回到可输入状态。
  const stopButton = button("停止", () => void stopTurn(), "btn secondary stop-turn");
  stopButton.title = "停止当前回合（会话和进程保留）";
  stopButton.hidden = true;
  stopButton.disabled = true;
  state.stopButton = stopButton;
  let stopping = false;
  async function stopTurn(): Promise<void> {
    if (stopping || !state.busy) return;
    stopping = true;
    stopButton.disabled = true;
    state.status.textContent = "正在停止当前回合…";
    try {
      const result = await call<HostedInterruptResult>("hosted.interrupt", {
        sessionId: state.session.sessionId,
      });
      if (result.session) state.session = result.session;
      if (result.interrupted) {
        state.busy = false;
        state.interrupted = true;
        state.status.textContent = "已停止当前回合";
      } else {
        state.status.textContent = "当前没有在跑的回合";
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
    attrs: { type: "button", title: "添加图片或文件", "aria-label": "添加图片或文件" },
  }, [icon("clip")]);
  attachButton.addEventListener("click", () => fileInput.click());

  const refreshButton = button("", () => {
    void refreshTail(state);
  }, "icon-btn composer-tool");
  refreshButton.append(icon("refresh"));
  refreshButton.setAttribute("aria-label", "刷新消息");
  refreshButton.title = "刷新消息";

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
    attrs: { type: "button", "aria-label": "收起输入区", title: "收起输入区" },
  }, [icon("chevron", "icon composer-chev")]);
  collapseButton.addEventListener("click", () => setCollapsed(true, true));

  const restore = button("", () => setCollapsed(false, true), "composer-restore");
  restore.append(icon("pencil"), el("span", { text: "写消息…" }));

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
      sendButton,
      collapseButton,
    ]),
    restore,
    contextPop,
  ]);

  function setCollapsed(collapsed: boolean, focus = false): void {
    composer.classList.toggle("is-collapsed", collapsed);
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
              ? (item.error ?? "上传失败")
              : sizeLabel(item.attachment?.size ?? 0);
        chip.append(el("span", { className: "attach-chip-state", text: stateText }));
        const remove = el("button", {
          className: "attach-chip-remove",
          attrs: { type: "button", "aria-label": `移除 ${item.name}` },
        }, [icon("close")]);
        remove.addEventListener("click", () => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          renderAttachments();
          updateSendState();
          if (pending.length === 0) status.textContent = "";
          else if (pending.every((entry) => entry.status === "ready")) {
            status.textContent = `${pending.length} 个附件已就绪`;
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
        status.textContent = `附件最多 ${MAX_ATTACHMENTS} 个`;
        break;
      }
      if (file.size === 0) {
        status.textContent = `${file.name} 是空文件`;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        status.textContent = `${file.name} 超过 25 MB`;
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
      status.textContent = `正在上传 ${file.name}…`;
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
      status.textContent = pending.length > 0 ? `${pending.length} 个附件已就绪` : "";
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
      if (event.key === "Enter" || event.key === "Tab") {
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
      "aria-label": "当前模型",
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
      ...(current ? [el("span", { className: "model-item-tag", text: "当前" })] : []),
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
    modelRow(item, current, true, pick, "子代理用");

  const paintModels = (info: SessionModelsResult): void => {
    const label = info.currentName ?? info.current;
    if (!label && info.models.length === 0) {
      modelButton.hidden = true;
      modelPop.hidden = true;
      return;
    }
    modelButton.hidden = false;
    modelButton.replaceChildren(
      el("span", { className: "model-chip-label", text: "模型" }),
      el("span", { className: "model-chip-value", text: label ?? "未知" }),
      icon("chevron", "icon model-chev"),
    );
    modelButton.title = `当前模型：${label ?? "未知"}${
      info.canSwitchSubagent ? ` · 子代理：${info.subagentModel ?? "跟随 pi 设置"}` : ""
    }`;
    const rows: HTMLElement[] = [];
    for (const section of ["main", "custom", "overflow"] as const) {
      const items = info.models.filter((item) => (item.section ?? "main") === section);
      if (items.length === 0) continue;
      rows.push(
        el("p", {
          className: "model-pop-group",
          text: section === "main" ? "常用" : section === "custom" ? "自定义" : "更多",
        }),
      );
      for (const item of items) {
        rows.push(modelRow(item, item.id === info.current, info.canSwitch, applyModel, "切换模型"));
      }
    }
    // pi 的子代理模型是单独的设置：只影响之后新派生的子代理，主模型不动。
    if (info.canSwitchSubagent) {
      rows.push(el("p", { className: "model-pop-group", text: "子代理模型" }));
      rows.push(
        subagentRow(
          { id: "", name: "跟随 pi 设置", section: undefined },
          !info.subagentModel,
          applySubagentModel,
        ),
      );
      for (const item of info.models) {
        rows.push(subagentRow(item, item.id === info.subagentModel, applySubagentModel));
      }
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
      flashNotice(`模型已换成 ${model}，下一条消息按新模型运行`);
    } catch (error) {
      flashNotice(`换模型失败：${messageOf(error)}`);
    }
  }

  /** 只换子代理模型：主模型不动，之后新派生的子代理按它跑。 */
  async function applySubagentModel(model: string): Promise<void> {
    closeModels();
    try {
      await call("hosted.setSubagentModel", { sessionId: route.sessionId, model: model || null });
      modelsKey = "";
      await loadModels();
      flashNotice(model ? `子代理模型已换成 ${model}，新派生的子代理按它运行` : "子代理模型改回跟随 pi 设置");
    } catch (error) {
      flashNotice(`换子代理模型失败：${messageOf(error)}`);
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
    headToggle.setAttribute("aria-label", isCollapsed ? "展开会话信息" : "收起会话信息");
    headToggle.replaceChildren(
      icon("chevron", "icon head-chev"),
      el("span", { text: isCollapsed ? "展开" : "收起" }),
    );
  }, "head-toggle");
  headToggle.setAttribute("aria-expanded", String(!collapsed));
  headToggle.setAttribute("aria-label", collapsed ? "展开会话信息" : "收起会话信息");
  headToggle.append(icon("chevron", "icon head-chev"), el("span", { text: collapsed ? "展开" : "收起" }));
  const railToggle = button("", () => {
    const open = !rail.root.classList.contains("is-open");
    rail.setOpen(open);
    writeRailOpen(open);
  }, "icon-btn rail-toggle");
  railToggle.append(icon("rail", "icon"), el("span", { className: "rail-toggle-label", text: "侧栏" }));
  railToggle.setAttribute("aria-label", "显示会话侧栏");
  railToggle.title = "显示环境、上下文、连接器与后台任务";

  const chatMeta = summary.hosted
    ? `${timeLabel(summary.updatedAt)}更新 · 由 Bridge 托管，不出现在桌面应用 · 模型 ${hostedModelLabel(
        summary.model,
      )} · ${hostedModeFact(summary)} · ${
        summary.live ? "进程运行中" : "进程已停止，发送时自动恢复"
      }${summary.canSend ? "" : ` · ${summary.sendBlockedReason ?? "只读"}`}`
    : `${timeLabel(summary.updatedAt)}更新 · ${summary.live ? "桌面正在运行这个会话" : summary.canSend ? "桌面未运行该会话，发送时自动打开" : "桌面未打开"}${summary.canSend ? "" : ` · ${summary.sendBlockedReason ?? "只读"}`}`;
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
  rename.setAttribute("aria-label", "重命名会话");
  rename.title = "重命名会话";

  const pinButton = button("", () => void setSessionPinned(summary, !summary.pinned), "icon-btn pin-btn");
  pinButton.append(icon(summary.pinned ? "pinOff" : "pin"));
  pinButton.setAttribute("aria-label", summary.pinned ? "取消置顶" : "置顶会话");
  pinButton.setAttribute("aria-pressed", String(summary.pinned === true));
  pinButton.title = summary.pinned ? "取消置顶" : "置顶会话";
  const archiveButton = summary.hosted
    ? button("", () => void setSessionArchived(summary, !summary.archived), "icon-btn archive-btn")
    : null;
  if (archiveButton) {
    archiveButton.append(icon(summary.archived ? "unarchive" : "archive"));
    archiveButton.setAttribute("aria-label", summary.archived ? "取消归档" : "归档会话");
    archiveButton.title = summary.archived ? "取消归档" : "归档会话";
  }
  const deleteButton = summary.hosted
    ? button("", () => void deleteHostedSession(summary), "icon-btn danger delete-btn")
    : null;
  if (deleteButton) {
    deleteButton.append(icon("trash"));
    deleteButton.setAttribute("aria-label", "删除会话");
    deleteButton.title = "删除会话（停进程、删聊天记录）";
  }

  head.append(
    back,
    el("div", { className: "view-head-main" }, [
      el("p", { className: "eyebrow", text: `${data.apps.find((item) => item.appId === route.appId)?.name ?? "客户端"} · ${project?.name ?? "工程"}` }),
      el("h1", { className: "display chat-title", text: summary.title }),
      (() => {
        const metaText = `${chatMeta}${summary.originalTitle ? ` · 原名：${summary.originalTitle}` : ""}`;
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
    railToggle.setAttribute("aria-label", open ? "隐藏会话侧栏" : "显示会话侧栏");
    railToggle.title = open ? "隐藏会话侧栏" : "显示环境、上下文、连接器与后台任务";
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
  if (page?.nextBefore) loadOlder.disabled = false;
  startPolling();
  chatResumeKey = hashFor(route);
  chatResume = () => {
    void refreshTail(state);
    void loadModels();
    startPolling();
  };

  async function loadOlderPage(current: ChatState): Promise<void> {
    const oldest = current.messages[0]?.messageId;
    if (!oldest || current.loading) return;
    current.loading = true;
    try {
      const result = await call<MessageListResult>("message.list", {
        sessionId: current.session.sessionId,
        limit: 50,
        before: oldest,
      });
      const fresh = result.messages.filter((message) => !current.known.has(message.messageId));
      for (const message of fresh) current.known.add(message.messageId);
      current.messages = [...fresh, ...current.messages];
      renderMessages(current);
      if (!result.nextBefore) loadOlder.disabled = true;
    } catch (error) {
      current.status.textContent = messageOf(error);
    } finally {
      current.loading = false;
    }
  }
}

async function renderTask(route: Route & { level: "chat"; taskId: string }, token: number): Promise<void> {
  const data = snapshot!;
  const summary = data.sessions.find((item) => item.sessionId === route.sessionId);
  if (!summary) {
    renderShell(
      errorView("找不到这个会话", "它可能已经从桌面应用中删除，返回列表刷新试试。"),
      crumbsFor(route),
    );
    return;
  }
  document.title = `后台任务 · ${summary.title} · Agent Bridge`;
  markRead(summary.sessionId);
  previewRoot = data.projects.find((item) => item.projectId === route.projectId)?.cwd;
  previewSessionId = summary.sessionId;

  const note = el("p", { className: "hint", text: "正在读取子任务记录…" });
  const list = el("div", { className: "transcript-body" });
  const status = el("p", { className: "hint" });
  const loadOlder = button("加载更早", () => void older(), "btn secondary small");
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
      el("p", { className: "eyebrow", text: "后台任务 · 子代理记录" }),
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
      list.append(emptyState("没有可读取的记录", "这个子任务可能只做了工具调用，或者记录尚未写入。"));
      return;
    }
    let turn: MessageRecord[] = [];
    const flush = (): void => {
      if (turn.length === 0) return;
      list.append(assistantTurn(null, turn));
      turn = [];
    };
    for (const message of messages) {
      if (message.role === "assistant") {
        turn.push(message);
        continue;
      }
      flush();
      list.append(messageBubble(null, message));
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
    document.title = `后台任务 · ${summary.title} · Agent Bridge`;
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
        if (task.updatedAt) parts.push(`${timeLabel(task.updatedAt)}更新`);
        meta.textContent = parts.join(" · ");
      }
      document.title = `后台任务 · ${task.name}`;
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
    attrs: { type: "button", "aria-label": "关闭侧栏", title: "关闭侧栏" },
  }, [icon("close")]);
  const tabBar = el("div", { className: "rail-tabs", attrs: { role: "tablist" } });
  state.tabBar = tabBar;
  const labels: Array<[RailTab, string]> = [
    ["overview", "概览"],
    ["files", "文件"],
    ["shell", "命令"],
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
  const root = el("aside", { className: "rail", attrs: { "aria-label": "会话侧栏" } });
  // The header's toggle reads state.root when clicked, so bind the real node before building it.
  state.root = root;
  root.append(
    el("div", { className: "rail-head" }, [
      el("span", { className: "rail-title", text: "会话侧栏" }),
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
      ? "文件浏览与命令执行已开启"
      : files
        ? "文件浏览已开启"
        : terminal
          ? "命令执行已开启"
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
    state.body.replaceChildren(el("p", { className: "rail-empty", text: messageOf(error) }));
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
    railSection("环境", result.environment.map(railRow)),
    railSection("上下文", [railContext(result.context)]),
    railSection(
      "连接器",
      result.servers.length > 0
        ? [el("div", { className: "rail-chips" }, result.servers.map((server) => railChip(server)))]
        : [el("p", { className: "rail-empty", text: "没有挂载 MCP 连接器" })],
      result.servers.length,
    ),
    railSection("后台任务", railTasks(state, result.tasks), result.tasks.length),
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
      el("p", { className: "rail-empty", text: "文件浏览未开启，请在 Mac 菜单栏的「远程工具」中打开。" }),
    );
    return;
  }
  if (!state.projectRoot) {
    state.files = null;
    state.panes.files.replaceChildren(
      el("p", { className: "rail-empty", text: "这个会话没有项目目录，无法浏览文件。" }),
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
    loading: false,
  };
  paintFiles(state, "正在读取项目目录…");
  await loadFileRoots(state);
}

async function loadFileRoots(state: RailState): Promise<void> {
  const files = state.files;
  if (!files) return;
  files.loading = true;
  paintFiles(state, "正在读取项目目录…");
  try {
    if (!state.projectRoot) throw new Error("这个会话没有项目目录");
    const result = await call<FsRootsResult>("fs.roots", {
      sessionId: state.sessionId,
      root: state.projectRoot,
    });
    files.roots = result.roots;
    files.error = result.roots.length === 0 ? "没有可浏览的项目目录" : null;
  } catch (error) {
    files.error = messageOf(error);
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
  paintFiles(state, "正在读取…");
  try {
    if (!state.projectRoot) throw new Error("这个会话没有项目目录");
    const result = await call<FsListResult>("fs.list", {
      sessionId: state.sessionId,
      root: state.projectRoot,
      path,
    });
    files.path = result.path;
    files.parent = result.parent;
    files.entries = result.entries;
    files.error = null;
  } catch (error) {
    files.error = messageOf(error);
  }
  files.loading = false;
  paintFiles(state);
}

async function openFile(state: RailState, path: string): Promise<void> {
  const files = state.files;
  if (!files) return;
  files.loading = true;
  paintFiles(state, "正在读取文件…");
  try {
    if (!state.projectRoot) throw new Error("这个会话没有项目目录");
    files.preview = await call<FsReadResult>("fs.read", {
      sessionId: state.sessionId,
      root: state.projectRoot,
      path,
    });
    files.error = null;
  } catch (error) {
    files.error = messageOf(error);
  }
  files.loading = false;
  paintFiles(state);
}

/** In the rail header: the whole rail takes the viewport, tabs and all. */
function railExpandButton(state: RailState): HTMLButtonElement {
  return classToggleButton(
    state.root,
    "is-expanded",
    "全屏侧栏",
    "退出全屏侧栏",
  );
}

/** In the file preview header: only the reader goes fullscreen, no rail chrome. */
function previewFullButton(state: RailState): HTMLButtonElement {
  return classToggleButton(state.root, "is-preview-full", "全屏查看文件", "退出全屏查看");
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
  refresh.title = "刷新目录";
  bar.append(refresh);
  pane.append(bar);

  if (files.root) pane.append(fileCrumbs(state));
  if (files.loading) {
    pane.append(el("p", { className: "rail-empty", text: placeholder ?? "正在读取…" }));
    return;
  }
  if (files.error) {
    pane.append(el("p", { className: "rail-empty rail-error", text: files.error }));
    return;
  }
  if (files.entries.length === 0) {
    pane.append(el("p", { className: "rail-empty", text: "这个目录是空的" }));
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
    up.title = "上一级";
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
  back.title = "返回目录";
  wrap.append(
    el("div", { className: "rail-filebar" }, [
      back,
      el("span", { className: "rail-filebar-name", text: file.name, attrs: { title: file.path } }),
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
    body.append(renderMarkdown(file.text ?? ""));
    wrap.append(body);
  } else {
    wrap.append(el("pre", { className: "rail-preview-text", text: file.text ?? "" }));
  }
  wrap.append(
    el("p", {
      className: "rail-note",
      text: `${sizeLabel(file.size)} · ${new Date(file.mtime).toLocaleString()}${file.truncated ? " · 只显示前 1 MB" : ""}`,
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
      el("p", { className: "rail-empty", text: "命令执行未开启，请在 Mac 菜单栏的「远程工具」中打开。" }),
    );
    return;
  }
  if (!state.projectRoot) {
    state.shell = null;
    pane.replaceChildren(
      el("p", { className: "rail-empty", text: "这个会话没有项目目录，无法执行命令。" }),
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
    attrs: { type: "text", placeholder: "输入命令后回车", autocomplete: "off", spellcheck: "false" },
  });
  const run = button("执行", () => void runShell(state), "btn primary shell-run");
  const stop = button("停止", () => void stopShell(state), "btn secondary shell-stop");
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
    el("p", { className: "rail-empty shell-hint", text: "在项目目录里执行单条命令，输出实时返回。远程工具关闭后立刻不可用。" }),
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
    const tail = data.killed ? "已终止" : `退出码 ${data.code ?? data.signal ?? "?"}`;
    run.text = capShellText(
      `${run.text}\n[${tail}${data.truncated ? "，输出已截断" : ""} · ${(data.durationMs / 1000).toFixed(1)}s]\n`,
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
    if (!state.projectRoot) throw new Error("这个会话没有项目目录");
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
    if (run) run.text = capShellText(`${run.text}\n^C 已请求停止\n`);
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
    run.text = capShellText(`${run.text}\n[连接已断开，命令已终止]\n`);
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
    el("span", { className: "rail-label", text: row.label }),
    el("span", { className: "rail-value", text: row.value, attrs: { title: row.value } }),
  ]);
}

function railChip(server: { name: string; detail?: string }): HTMLElement {
  const chip = el("span", { className: "rail-chip", text: server.name, attrs: { title: server.detail ?? server.name } });
  return chip;
}

function railContext(context: ContextUsage | undefined): HTMLElement {
  if (!context) return el("p", { className: "rail-empty", text: "这个会话还没有上下文用量" });
  const window = Math.max(1, context.windowTokens);
  const ratio = Math.min(1, context.usedTokens / window);
  const percent = Math.max(2, Math.round(ratio * 100));
  const meter = el("div", {
    className: "rail-meter",
    attrs: { role: "img", "aria-label": `上下文已用 ${percent}%` },
  }, [el("span", { className: "rail-meter-fill", attrs: { style: `width:${percent}%` } })]);
  const wrap = el("div", { className: "rail-context" }, [
    el("div", { className: "rail-context-line" }, [
      el("strong", { text: `${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)}` }),
      el("span", { className: "rail-context-pct", text: `${Math.round(ratio * 100)}%` }),
    ]),
    meter,
  ]);
  if (context.windowEstimated) wrap.append(el("p", { className: "rail-note", text: "窗口大小为估算值" }));
  return wrap;
}

function railTasks(state: RailState, tasks: RailTask[]): Node[] {
  if (tasks.length === 0) {
    return [
      el("p", {
        className: "rail-empty",
        text: state.appId === "codex" ? "Codex 线程没有可读取的子任务记录" : "没有正在运行的后台任务",
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
  if (task.status === "running") parts.push("运行中");
  if (typeof task.depth === "number" && task.depth > 1) parts.push(`第 ${task.depth} 层`);
  return parts.join(" · ") || (task.status === "running" ? "运行中" : "已结束");
}

async function refreshTail(state: ChatState): Promise<MessageListResult | null> {
  if (state.loading) return null;
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
        state.compact = { pending: false, note: "已压缩上下文" };
        state.status.textContent = "客户端已完成上下文压缩";
        compactChanged = true;
      }
    }
    if (result.context) state.context = result.context;
    if (result.context || compactChanged) paintContext(state);
    if (result.slashCommands) state.slashCommands = result.slashCommands;
    const busyChanged = (result.busy === true) !== state.busy;
    state.busy = result.busy === true;
    const interruptedChanged = (result.interrupted === true) !== state.interrupted;
    state.interrupted = result.interrupted === true;
    if (busyChanged) paintStopButton(state);
    if (added || busyChanged || interruptedChanged || state.messages.length === 0) {
      renderMessages(state);
    }
    if (state.rail?.root.classList.contains("is-open")) void refreshRail(state.rail);
    return result;
  } catch (error) {
    if (active) state.status.textContent = messageOf(error);
    return null;
  } finally {
    state.loading = false;
  }
}

function stepTitle(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > 76 ? `${line.slice(0, 76)}…` : line || "过程";
}

function processFold(steps: string[]): HTMLDetailsElement {
  const fold = el("details", { className: "turn-steps" });
  fold.append(
    el("summary", { className: "turn-steps-summary" }, [
      icon("chevron", "icon turn-chev"),
      el("span", { text: `执行过程 · ${steps.length} 步` }),
    ]),
    el(
      "div",
      { className: "turn-steps-body" },
      steps.map((text) => {
        const step = el("details", { className: "turn-step" });
        step.append(
          el("summary", { className: "turn-step-summary" }, [
            icon("chevron", "icon turn-step-chev"),
            el("span", { className: "turn-step-title", text: stepTitle(text) }),
          ]),
          el("div", { className: "turn-step-body", text }),
        );
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
  btn.title = `上下文已用 ${percent}%`;
  btn.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <circle class="context-track" cx="10" cy="10" r="${radius}" fill="none" stroke-width="2.6"/>
    <circle class="context-arc" cx="10" cy="10" r="${radius}" fill="none" stroke-width="2.6" stroke-linecap="round" transform="rotate(-90 10 10)" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(2)}"/>
  </svg>`;

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
      ? [el("p", { className: "context-model", text: `${usage.model}${usage.windowEstimated ? " · 窗口按 200k 估算" : ""}` })]
      : []),
    ...(usage.details && usage.details.length > 0
      ? [el("dl", { className: "context-details" }, usage.details.flatMap((detail) => [
          el("dt", { text: detail.label }),
          el("dd", { text: detail.value }),
        ]))]
      : []),
    ...(percent >= 50 ? [contextCompactActions(state)] : []),
  );
}

/** 上下文过半时在弹层里给出压缩入口：客户端能自己压就调用，否则复制命令让用户粘贴。 */
function contextCompactActions(state: ChatState): HTMLElement {
  const row = el("div", { className: "context-actions" });
  const hint = el("p", { className: "context-hint" });
  if (state.session.canCompact) {
    const pending = state.compact?.pending === true;
    const btn = el("button", {
      className: "context-action",
      text: pending ? "压缩中…" : "压缩上下文",
      attrs: { type: "button" },
    });
    btn.disabled = pending;
    if (state.compact?.error) {
      hint.textContent = state.compact.error;
      hint.classList.add("is-error");
    } else if (state.compact?.note) {
      hint.textContent = state.compact.note;
    } else {
      hint.textContent = "由桌面客户端自己压缩，摘要会写回该会话。";
    }
    btn.addEventListener("click", () => {
      void runCompact(state);
    });
    row.append(btn, hint);
    return row;
  }
  const btn = el("button", {
    className: "context-action",
    text: "复制 /compact",
    attrs: { type: "button" },
  });
  hint.textContent = "浏览器无法直接操作客户端输入框；复制后粘贴到输入框发送。";
  btn.addEventListener("click", () => {
    if (!navigator.clipboard) {
      hint.textContent = "当前页面不能写剪贴板，请在客户端输入框手动输入 /compact";
      hint.classList.add("is-error");
      return;
    }
    void navigator.clipboard.writeText("/compact").then(
      () => {
        btn.textContent = "已复制";
        setTimeout(() => {
          btn.textContent = "复制 /compact";
        }, 1_500);
      },
      () => {
        hint.textContent = "复制失败，请在客户端输入框手动输入 /compact";
        hint.classList.add("is-error");
      },
    );
  });
  row.append(btn, hint);
  return row;
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
      state.compact = { pending: false, note: result.detail ?? "已压缩上下文" };
      state.status.textContent = result.detail ?? "已在客户端压缩上下文";
      void refreshTail(state);
    } else {
      state.compact = { pending: false, error: result.detail ?? "客户端没有执行压缩" };
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
      el("span", { className: "role user", text: "用户" }),
      el("span", { className: "pill tiny", text: item.held ? "排队中" : "已发送" }),
      el("span", { className: "meta mono", text: new Date(item.at).toLocaleTimeString() }),
    ]),
    el("div", { className: "message-text", text: item.display }),
  );
  return bubble;
}

function messageBubble(session: SessionSummary | null, message: MessageRecord): HTMLElement {
  const bubble = el("article", { className: `message ${message.role}` });
  const hasText = message.blocks.some((block) => block.type === "text");
  const meta = el("div", { className: "message-meta" }, [
    el("span", { className: `role ${message.role}`, text: message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统" }),
    ...(message.origin === "peer" ? [el("span", { className: "pill tiny", text: "Bridge 注入" })] : []),
    ...(message.createdAt ? [el("span", { className: "meta mono", text: new Date(message.createdAt).toLocaleTimeString() })] : []),
  ]);
  if (hasText && session) meta.append(messageActions([copyButton(textBlocks([message])), shareButton(session, message)]));
  bubble.append(meta);
  for (const block of message.blocks) {
    bubble.append(
      block.type === "tool"
        ? el("div", { className: "message-tool", text: block.truncated ? `${block.text}\n…（已截断）` : block.text })
        : block.type === "next-step"
          ? nextStepBox(block, null)
          : block.type === "ask"
            ? askBox(block)
            : markdownBlock(block.text, block.truncated),
    );
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
        ...(question.multiSelect ? [el("span", { className: "ask-multi", text: "多选" })] : []),
      ]),
    );
    if (question.options.length > 0) {
      const row = el("div", { className: "ask-options" });
      const picked = new Set<string>();
      picks.set(question.question, picked);
      const choices: HTMLButtonElement[] = [];
      const submit = selectable && question.multiSelect && !batch
        ? el("button", { className: "ask-submit", text: "提交选择", attrs: { type: "button" } })
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
    const submit = el("button", { className: "ask-submit", text: "提交答案", attrs: { type: "button" } });
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
          ? `已发送：${answered.flat().join("、")}`
          : canAnswer
            ? batch
              ? "逐个选好后点「提交答案」，会作为一条消息发到会话；桌面上的提问框不会自动关闭。"
              : state?.session.askChannel === "herdr"
                ? "点选后会在终端面板里替你按键选中这个选项。"
                : "点选后会把选项当消息发到会话；桌面上的提问框不会自动关闭。"
            : state?.session.askChannel === "herdr"
              ? "这个提问有多道题或是多选，请在终端里回答"
              : (state?.session.sendBlockedReason ?? "请在桌面端回答这个提问"),
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
  state.status.textContent = "正在发送选择…";
  try {
    const result = await call<MessageSendResult>("message.send", {
      sessionId: state.session.sessionId,
      text,
    }, 60_000);
    if (!result.accepted) {
      state.status.textContent = result.detail ?? "未确认投递";
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
      ? "已发送选择"
      : (result.detail ?? "已提交，等待桌面执行");
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
  box.append(el("p", { className: "next-step-ask", text: block.ask ?? block.text }));
  const actions = block.actions ?? [];
  if (!state || actions.length === 0) return box;
  const row = el("div", { className: "next-step-actions" });
  for (const action of actions) {
    const btn = el("button", {
      className: "next-step-btn",
      attrs: {
        type: "button",
        ...(action.action ? { title: "桥接端没有桌面宿主的执行通道，会以消息通知会话执行这一步" } : {}),
      },
      text: action.label,
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
  const text = action.action ? `点击了「${action.label}」，请执行这一步。` : action.label;
  state.status.classList.remove("error");
  state.status.textContent = "正在发送…";
  try {
    const result = await call<MessageSendResult>("message.send", {
      sessionId: state.session.sessionId,
      text,
    }, 60_000);
    if (!result.accepted) {
      state.status.textContent = result.detail ?? "未确认投递";
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
        ? "已写入托管会话"
        : (result.detail ?? "已提交")
      : result.delivered
        ? "已投递到桌面会话"
        : (result.detail ?? "已提交，等待桌面执行");
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
  if (!root || !sessionId) throw new Error("这个会话没有项目目录，无法预览文件");
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
  const button = el("button", { className: "md-figure-open", attrs: { type: "button", title: `查看 ${label}` } });
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
    attrs: { type: "button", "aria-label": "关闭预览", title: "关闭预览" },
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
  filePreviewBody?.replaceChildren(el("p", { className: "file-preview-note", text: "正在读取…" }));
  try {
    const file = await readLocalFile(path);
    // A newer preview (or a close) superseded this one while it was loading.
    if (request !== previewRequest) return;
    const src = imageSource(file, path);
    if (src) {
      filePreviewBody?.replaceChildren(el("img", { className: "file-preview-img", attrs: { src, alt: file.name } }));
    } else if (file.mime === "text/markdown") {
      const body = el("div", { className: "markdown file-preview-md" });
      body.append(renderMarkdown(file.text ?? ""));
      filePreviewBody?.replaceChildren(body);
    } else {
      filePreviewBody?.replaceChildren(el("pre", { className: "file-preview-text", text: file.text ?? "" }));
    }
    // 复制的是文件原文（markdown、svg 也复制源码）；位图这类二进制没有可复制的文本。
    if (filePreviewActions && typeof file.text === "string" && file.text.length > 0) {
      filePreviewActions.replaceChildren(copyButton(file.text, "复制全部内容"));
    }
    if (filePreviewNote) {
      filePreviewNote.textContent = `${sizeLabel(file.size)} · ${new Date(file.mtime).toLocaleString()}${file.truncated ? " · 只显示前 1 MB" : ""}`;
    }
  } catch (error) {
    if (request !== previewRequest) return;
    filePreviewBody?.replaceChildren(el("p", { className: "file-preview-note is-error", text: messageOf(error) }));
  }
}

/** Renders transcript text as Markdown; truncation is annotated after the content. */
function markdownBlock(text: string, truncated?: boolean): HTMLElement {
  const node = el("div", { className: "message-text md" });
  try {
    node.append(renderMarkdown(text, { localLink: localFileLink, localImage: localFileImage }));
  } catch {
    // A rendering failure must never blank the transcript; fall back to plain text.
    node.textContent = text;
  }
  if (truncated) node.append(el("p", { className: "md-note", text: "…（已截断）" }));
  return node;
}

function shareButton(session: SessionSummary, message: MessageRecord): HTMLButtonElement {
  const share = el("button", {
    className: "share-btn",
    attrs: { type: "button", title: "分享到其他客户端", "aria-label": "分享这条消息" },
  }, [icon("share"), el("span", { text: "分享" })]);
  share.addEventListener("click", () => {
    void openShare(session, message);
  });
  return share;
}

/** 复制一段输出；写剪贴板失败时给出可见反馈，不静默。 */
function copyButton(text: string, title = "复制这段输出"): HTMLButtonElement {
  const label = el("span", { text: "复制" });
  const copy = el("button", {
    className: "share-btn copy-btn",
    attrs: { type: "button", title, "aria-label": title },
  }, [icon("copy"), label]);
  const flash = (next: string): void => {
    label.textContent = next;
    setTimeout(() => {
      label.textContent = "复制";
    }, 1_500);
  };
  copy.addEventListener("click", () => {
    if (!navigator.clipboard) {
      flash("无法复制");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => flash("已复制"),
      () => flash("复制失败"),
    );
  });
  return copy;
}

/** 消息头右侧的操作区：分享、复制。 */
function messageActions(buttons: (HTMLElement | null)[]): HTMLElement {
  return el("span", { className: "message-actions" }, buttons.filter((item): item is HTMLElement => item !== null));
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

function assistantTurn(
  session: SessionSummary | null,
  messages: MessageRecord[],
  state: ChatState | null = null,
  /** 最新一回合才有；提问在等答案时回合是忙的，不能和下一步按钮共用同一个门槛。 */
  askState: ChatState | null = null,
): HTMLElement {
  const bubble = el("article", { className: "message assistant" });
  const steps: string[] = [];
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
        steps.push(block.truncated ? `${block.text}\n…（已截断）` : block.text);
      }
    }
    if (hasText) lastText = message;
  }
  const last = messages[messages.length - 1];
  const meta = el("div", { className: "message-meta" }, [
    el("span", { className: "role assistant", text: "助手" }),
    ...(peer ? [el("span", { className: "pill tiny", text: "Bridge 注入" })] : []),
    ...(last?.createdAt ? [el("span", { className: "meta mono", text: new Date(last.createdAt).toLocaleTimeString() })] : []),
  ]);
  if (session) {
    // 复制整回合的输出，分享仍沿用最后一条带正文的消息。
    const copyText = textBlocks(messages);
    meta.append(messageActions([copyText ? copyButton(copyText) : null, lastText ? shareButton(session, lastText) : null]));
  }
  bubble.append(meta);
  let folded = steps.length === 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "text") {
        bubble.append(markdownBlock(block.text, block.truncated));
      } else if (block.type === "next-step") {
        continue;
      } else if (block.type === "ask") {
        bubble.append(askBox(block, askState));
      } else if (!folded) {
        bubble.append(processFold(steps));
        folded = true;
      }
    }
  }
  if (!folded) bubble.append(processFold(steps));
  // 只有最新一回合的盒子可以点；历史回合保留文字说明。
  const latest = nextSteps[nextSteps.length - 1];
  if (latest) bubble.append(nextStepBox(latest, latest.pending ? (askState ?? state) : state));
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
      ? [spinner(), el("span", { className: "thinking-label", text: "进行中" })]
      : tone === "stopped"
        ? [icon("stop", "icon turn-stop"), el("span", { className: "thinking-label stopped-label", text: "已中断" })]
        : [icon("check", "icon turn-done"), el("span", { className: "thinking-label done-label", text: "已完成" })];
  if (!last) {
    if (tone === "done") return;
    const row = el("div", { className: "thinking-row" });
    row.append(
      ...(tone === "busy"
        ? [spinner(), el("span", { className: "thinking-label", text: "思考中…" })]
        : [icon("stop", "icon turn-stop"), el("span", { className: "thinking-label stopped-label", text: "该回合已被中断" })]),
    );
    list.append(row);
    return;
  }
  const summary = last.querySelector<HTMLElement>(".turn-steps-summary");
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
    list.append(emptyState("没有可读取的消息", "这个会话在桌面应用中可能只有工具调用，或者还没有开始。"));
    appendQueued();
    if (state.busy || state.interrupted) markTurnState(list, state);
    return;
  }
  let turn: MessageRecord[] = [];
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
      ),
    );
    turn = [];
  };
  for (const message of state.messages) {
    if (message.role === "assistant") {
      turn.push(message);
      continue;
    }
    flush();
    list.append(messageBubble(state.session, message));
  }
  flush();
  appendQueued();
  markTurnState(list, state);
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
    status.textContent = "附件还在上传，请稍候";
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
      ? "正在写入托管会话…"
      : "正在恢复托管进程…"
    : state.session.live
      ? "正在发送…"
      : "正在请求桌面打开该会话…";
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
      const attachmentLine = names.length > 0 ? `附件：${names.join("、")}` : "";
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
      renderMessages(state);
    }
    status.textContent = state.session.hosted
      ? result.delivered
        ? "已写入托管会话"
        : (result.detail ?? "已提交")
      : result.delivered
        ? "已投递到桌面会话"
        : result.accepted
          ? (result.detail ?? "已提交，等待桌面执行")
          : (result.detail ?? "未确认投递");
    // 发送落地后收起输入区，把空间让给对话；需要时点「写消息…」再展开。
    if (result.accepted) onSent();
    window.setTimeout(() => {
      void refreshTail(state).then((page) => {
        if (page?.nextBefore) loadOlder.disabled = false;
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
      flashNotice(`读取会话列表失败：${messageOf(error)}`);
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
  const steps = el("ol", { className: "steps", attrs: { "aria-label": "转发步骤" } });
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

  const cancel = button("取消", close, "btn secondary");
  const send = button("发送", () => {
    void commit();
  }, "btn primary");
  send.disabled = true;
  const viewTarget = button("查看目标会话", () => {
    close();
    if (pick.appId && pick.projectId && pick.sessionId) {
      navigate({ level: "chat", appId: pick.appId, projectId: pick.projectId, sessionId: pick.sessionId });
    }
  }, "btn");
  viewTarget.classList.add("hidden");
  const back = button("上一步", () => {
    if (pick.sessionId) pick.sessionId = null;
    else if (pick.projectId) pick.projectId = null;
    else if (pick.appId) pick.appId = null;
    void render();
  }, "btn ghost");
  back.classList.add("hidden");

  const closeButton = el("button", { className: "icon-btn", attrs: { type: "button", "aria-label": "关闭" } }, [icon("close")]);
  closeButton.addEventListener("click", close);

  const sheet = el("aside", { className: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "分享消息" } }, [
    el("header", { className: "sheet-head" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "分享" }),
        el("h2", { className: "sheet-title", text: "把这条消息发送到另一个客户端" }),
      ]),
      closeButton,
    ]),
    el("p", { className: "sheet-source", text: `来源：${source.title} · ${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统"} · ${message.createdAt ? new Date(message.createdAt).toLocaleString() : ""}` }),
    steps,
    body,
    el("footer", { className: "sheet-foot" }, [
      el("div", { className: "sheet-notes" }, [note, status]),
      el("div", { className: "actions" }, [back, cancel, send, viewTarget]),
    ]),
  ]);
  mask.append(sheet);
  document.body.append(mask);

  const appName = (appId: string | null): string => data.apps.find((item) => item.appId === appId)?.name ?? "客户端";
  const projectName = (projectId: string | null): string => data.projects.find((item) => item.projectId === projectId)?.name ?? "工程";
  const sessionOf = (sessionId: string | null): SessionSummary | null =>
    data.sessions.find((item) => item.sessionId === sessionId) ?? null;

  function renderSteps(): void {
    const active = pick.sessionId ? 3 : pick.projectId ? 2 : pick.appId ? 1 : 0;
    const labels = ["客户端", "工程", "会话", "预览"];
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
    send.textContent = "发送";
    send.disabled = true;

    if (!pick.appId) {
      note.textContent = pick.appId === null && pick.projectId === null ? "选择要发送到的客户端" : "";
      const list = el("ul", { className: "list compact" });
      for (const item of data.apps) {
        const count = data.projects.filter((project) => project.appId === item.appId).length;
        list.append(el("li", {}, [
          rowButton({
            title: item.name,
            meta: `${count} 个工程 · ${item.capabilities.send ? "可发送" : "仅可读"}`,
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
      note.textContent = `来自 ${appName(pick.appId)}，选择目标工程`;
      const projects = data.projects.filter((project) => project.appId === pick.appId);
      const list = el("ul", { className: "list compact" });
      for (const project of projects) {
        const sendable = data.sessions.some((session) => session.projectId === project.projectId && session.canSend && !exclude.has(session.sessionId));
        list.append(el("li", {}, [
          rowButton({
            title: project.name,
            meta: `${project.cwd ?? project.projectId}`,
            disabled: !sendable,
            badge: sendable ? undefined : "无可发送会话",
            onClick: () => {
              pick.projectId = project.projectId;
              void render();
            },
          }),
        ]));
      }
      if (projects.length === 0) body.append(emptyState("这个客户端没有工程", "换一个客户端试试。"));
      else body.append(list);
      return;
    }

    if (!pick.sessionId) {
      const project = data.projects.find((item) => item.projectId === pick.projectId);
      note.textContent = `${project?.name ?? "工程"} · 选择目标会话`;
      const search = el("input", { className: "input search", attrs: { type: "text", placeholder: "筛选会话标题…", autocomplete: "off" } });
      const list = el("ul", { className: "list compact" });
      const sessions = data.sessions
        .filter((session) => session.projectId === pick.projectId && !exclude.has(session.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const paint = (): void => {
        const term = search.value.trim().toLowerCase();
        list.replaceChildren();
        const visible = sessions.filter((session) => !term || session.title.toLowerCase().includes(term));
        if (visible.length === 0) {
          list.append(el("li", {}, [emptyState("没有匹配的会话", "换个关键词，或者换一个工程。")]));
          return;
        }
        for (const session of visible) {
          list.append(el("li", {}, [
            rowButton({
              title: session.title,
              meta: `${timeLabel(session.updatedAt)} · ${sendStateLabel(session)}`,
              disabled: !session.canSend,
              badge: session.canSend ? undefined : "不可发送",
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
    note.textContent = `目标：${appName(pick.appId)} / ${projectName(pick.projectId)} / ${target?.title ?? "会话"}`;
    const editor = el("textarea", {
      className: "preview preview-editor",
      attrs: { spellcheck: "false", "aria-label": "待发送内容，可直接编辑", placeholder: "正在生成预览…" },
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
    status.textContent = "正在校验目标会话…";
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
          ? "内容为空，无法发送"
          : tooLong
            ? `已超出上限（${text.length} / ${MAX_TRANSFER_CHARS} 字符）`
            : `${text.length} 字符 · ${text === prepared?.text ? "发送内容与预览一致" : "已编辑，将发送当前内容"}${prepared?.note ? ` · ${prepared.note}` : ""}`;
        status.classList.toggle("error", tooLong || !text.trim() || blocked);
        send.disabled = blocked || sending || done || tooLong || !text.trim();
      };
      editor.addEventListener("input", sync);
      sync();
    } catch (error) {
      editor.placeholder = "无法生成预览";
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
        ? `已超出上限（${text.length} / ${MAX_TRANSFER_CHARS} 字符）`
        : "消息不能为空";
      return;
    }
    sending = true;
    send.disabled = true;
    if (shareEditor) shareEditor.readOnly = true;
    status.classList.remove("error");
    status.textContent = "正在发送…";
    try {
      const result = await call<TransferCommitResult>(
        "transfer.commit",
        text === prepared.text ? { transferId: prepared.transferId } : { transferId: prepared.transferId, text },
        60_000,
      );
      done = true;
      status.textContent = result.delivered
        ? `已投递给「${prepared.target.title}」（${result.textLength} 字符）`
        : (result.detail ?? "已提交，但目标会话尚未确认投递");
      if (!result.delivered && !result.accepted) status.classList.add("error");
      send.textContent = "已发送";
      cancel.textContent = "关闭";
      viewTarget.classList.remove("hidden");
      back.classList.add("hidden");
    } catch (error) {
      prepared = null;
      if (shareEditor) shareEditor.readOnly = false;
      status.classList.add("error");
      status.textContent = `${messageOf(error)}；重新选择会话可再试`;
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

function errorView(title: string, message: string): HTMLElement {
  return el("main", { className: "main" }, [
    el("p", { className: "eyebrow", text: "出错了" }),
    el("h1", { className: "display", text: title }),
    el("div", { className: "notice error", text: message }),
    el("div", { className: "actions" }, [
      button("返回客户端", () => navigate({ level: "clients" }), "btn secondary"),
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
    el("p", { className: "eyebrow", text: route.level === "chat" ? "会话" : "客户端" }),
    el("div", { className: "skeleton-title" }),
    rows,
  ]);
}

const bootUrl = new URL(location.href);
if (bootUrl.searchParams.has("v")) {
  bootUrl.searchParams.delete("v");
  history.replaceState(null, "", bootUrl.toString());
}
watchForUpdates();

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
