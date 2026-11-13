import { execFile } from "node:child_process";

/**
 * herdr 面板：终端里的 claude 跑在 herdr 的 pty 里，herdr 的 socket API 能把按键送进那个 pty。
 * 这是终端会话唯一能被外部回答 AskUserQuestion 的通道（peer socket 与 tty 都做不到）。
 */
const HERDR_BIN = process.env["AGENT_BRIDGE_HERDR_PATH"] || "herdr";
const SNAPSHOT_MS = 5_000;
const FAILURE_BACKOFF_MS = 60_000;
const READ_LINES = 80;

export interface HerdrPane {
  paneId: string;
  /** herdr 从转录里认出的 claude 会话 id，与 transcript 文件名同一个 uuid。 */
  agentSessionId: string;
  cwd: string;
}

let snapshot: { at: number; panes: HerdrPane[]; ok: boolean } | null = null;
let inflight: Promise<void> | null = null;

function run(args: string[], timeoutMs = 4_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      HERDR_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function load(): Promise<HerdrPane[]> {
  const parsed = JSON.parse(await run(["pane", "list"])) as {
    result?: { panes?: unknown };
  };
  const raw = parsed.result?.panes;
  const panes: HerdrPane[] = [];
  if (!Array.isArray(raw)) return panes;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const pane = item as Record<string, unknown>;
    const paneId = typeof pane["pane_id"] === "string" ? pane["pane_id"] : "";
    if (!paneId) continue;
    const session = pane["agent_session"];
    const agentSessionId =
      typeof session === "object" && session !== null
        ? String((session as Record<string, unknown>)["value"] ?? "")
        : "";
    const cwd = typeof pane["cwd"] === "string" ? pane["cwd"] : "";
    panes.push({ paneId, agentSessionId, cwd });
  }
  return panes;
}

/** `sessions()` 是同步的：这里只读最近一次快照，过期就后台刷新。 */
export function herdrPanes(): HerdrPane[] {
  const now = Date.now();
  const stale =
    !snapshot || now - snapshot.at > (snapshot.ok ? SNAPSHOT_MS : FAILURE_BACKOFF_MS);
  if (stale) void refreshHerdrPanes().catch(() => undefined);
  return snapshot?.panes ?? [];
}

export async function refreshHerdrPanes(): Promise<HerdrPane[]> {
  if (!inflight) {
    inflight = load()
      .then(
        (panes) => {
          snapshot = { at: Date.now(), panes, ok: true };
        },
        () => {
          // herdr 没装或没在跑：别每 5 秒再试一次。
          snapshot = { at: Date.now(), panes: [], ok: false };
        },
      )
      .finally(() => {
        inflight = null;
      });
  }
  await inflight;
  return snapshot?.panes ?? [];
}

export function herdrPaneText(paneId: string): Promise<string> {
  return run(["pane", "read", paneId, "--lines", String(READ_LINES), "--format", "text"], 3_000);
}

export function herdrSendKeys(paneId: string, keys: string[]): Promise<string> {
  return run(["pane", "send-keys", paneId, ...keys], 3_000);
}

/** 面板里当前高亮（`❯` 那行）的选项下标；认不出来返回 null。 */
export function highlightedOption(paneText: string, labels: string[]): number | null {
  for (const line of paneText.split("\n")) {
    if (!line.includes("❯")) continue;
    let best = -1;
    let bestLength = 0;
    labels.forEach((label, index) => {
      if (label && line.includes(label) && label.length > bestLength) {
        best = index;
        bestLength = label.length;
      }
    });
    if (best >= 0) return best;
  }
  return null;
}

/** 从当前高亮走到目标选项要按的键；最后补 Enter 提交。 */
export function keyPlan(from: number, to: number): string[] {
  const keys: string[] = [];
  const delta = to - from;
  for (let step = 0; step < Math.abs(delta); step += 1) keys.push(delta > 0 ? "down" : "up");
  keys.push("enter");
  return keys;
}
