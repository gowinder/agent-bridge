import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type {
  AppInfo,
  MessageSendResult,
  SessionCompactResult,
  SessionSummary,
} from "@craftstead/protocol";
import {
  CATALOG_PATH,
  CodexAdapter,
  hasCatalog,
  newestStateDb,
  type ThreadRow,
} from "./codex.js";
import { RpcError } from "./types.js";

const MAX_SESSIONS = 500;
const QUEUE_TIMEOUT_MS = 20_000;
const BUSY_MAX_AGE_MS = 30 * 60_000;

const THREAD_COLUMNS = `id, title, cwd, created_at_ms, updated_at_ms, rollout_path, archived, thread_source`;
const CATALOG_COLUMNS = `thread_id AS id, display_title AS title, cwd,
        CAST(source_created_at * 1000 AS INTEGER) AS created_at_ms,
        CAST(source_updated_at * 1000 AS INTEGER) AS updated_at_ms,
        NULL AS rollout_path, 0 AS archived, thread_source, source_kind`;

/**
 * 独立展示终端里 `codex` 创建的线程（catalog 的 source_kind='cli' / state 的 source='cli'），
 * 桌面适配器不再列出这些线程，避免同一线程出现两份入口。
 */
export class CodexCliAdapter extends CodexAdapter {
  override readonly key: string = "codex-cli";
  private cliCatalogDb: DatabaseSync | null = null;
  private cliCatalogChecked = false;
  private cliState: DatabaseSync | null = null;
  private cliStateChecked = false;
  private sendTail: Promise<unknown> = Promise.resolve();

  override app(): AppInfo {
    const db = this.cliCatalog() ? CATALOG_PATH : newestStateDb();
    return {
      appId: this.key,
      provider: "openai",
      kind: "codex-cli",
      name: "Codex · CLI",
      mode: "cli",
      status: db ? "ready" : "unavailable",
      capabilities: {
        enumerate: db ? "partial" : "unavailable",
        read: db ? "partial" : "unavailable",
        send: db !== null,
        sendDetail:
          "运行中的终端会话用 codex queue 排入；未运行时由 Bridge 用 codex exec resume 恢复一轮（沿用 ~/.codex/config.toml，非交互下需要审批的操作会被拒绝）。",
        create: false,
        createDetail: "CLI 线程由终端里的 codex 创建；Bridge 只读取并驱动已有线程。",
        reason: db ? undefined : "未找到 Codex 线程数据库",
      },
    };
  }

  override sessions(): SessionSummary[] {
    const now = Date.now();
    return this.threads().map((thread) => {
      const recent = now - (thread.updated_at_ms ?? 0) < BUSY_MAX_AGE_MS;
      return {
        sessionId: `${this.key}:${thread.id}`,
        appId: this.key,
        projectId: this.projectIdFor(thread.cwd),
        kind: "codex-thread",
        title: (thread.title || "未命名线程").slice(0, 120),
        createdAt: thread.created_at_ms ?? 0,
        updatedAt: thread.updated_at_ms ?? 0,
        archived: (thread.archived ?? 0) !== 0,
        live: false,
        ...(recent && this.threadBusy(thread) ? { busy: true } : {}),
        canSend: true,
        canCompact: false,
      };
    });
  }

  override async send(sessionId: string, text: string): Promise<MessageSendResult> {
    const task = this.sendTail.then(
      () => this.doSend(sessionId, text),
      () => this.doSend(sessionId, text),
    );
    this.sendTail = task.catch(() => undefined);
    return task;
  }

  override async compact(_sessionId: string): Promise<SessionCompactResult> {
    throw new RpcError("unsupported", "CLI 线程不支持从 Bridge 压缩上下文；请在终端里执行 /compact");
  }

  private async doSend(sessionId: string, text: string): Promise<MessageSendResult> {
    const threadId = String(sessionId).slice(this.key.length + 1);
    const thread = this.thread(threadId);
    if (!thread) throw new RpcError("not_found", "未知线程");
    if (!text.trim()) throw new RpcError("invalid_params", "消息不能为空");

    if (await this.queueMessage(threadId, text)) {
      return {
        accepted: true,
        delivered: false,
        detail: "已排入该线程；终端里的 Codex 会接手执行，稍后刷新查看回复",
      };
    }

    this.resumeTurn(thread, text);
    return {
      accepted: true,
      delivered: false,
      detail: `已用 codex exec resume 恢复该 CLI 线程执行这一轮（工作目录 ${
        thread.cwd || process.cwd()
      }）`,
    };
  }

  /** 运行中的终端会话可以收队列消息；没有 daemon 或队列失败时返回 false，改走 resume。 */
  private queueMessage(threadId: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(
        binary(),
        ["queue", "--thread", threadId, "--message", text, "--resume"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(false);
      }, QUEUE_TIMEOUT_MS);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      child.on("error", () => finish(false));
      child.on("exit", (code) => finish(code === 0));
    });
  }

  /** 线程没有运行中的 CLI 进程时，用一个 exec resume 进程接续同一 thread id。 */
  private resumeTurn(thread: ThreadRow, text: string): void {
    const child = spawn(binary(), ["exec", "resume", thread.id, "-"], {
      cwd: thread.cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.unref();
    try {
      child.stdin?.end(text);
    } catch {
      // 进程已经退出时忽略；消息没进去，网页下一轮会从 rollout 看出来。
    }
  }

  protected override threads(): ThreadRow[] {
    const byId = new Map<string, ThreadRow>();
    const state = this.openStateDb();
    if (state) {
      try {
        const rows = state
          .prepare(
            `SELECT ${THREAD_COLUMNS}
             FROM threads
             WHERE source = 'cli' AND archived = 0
               AND (thread_source IS NULL OR thread_source != 'subagent')
             ORDER BY updated_at_ms DESC
             LIMIT ${MAX_SESSIONS}`,
          )
          .all() as unknown as ThreadRow[];
        for (const row of rows) byId.set(row.id, row);
      } catch {
        // 旧库结构不同时退回到 catalog。
      }
    }
    const catalog = this.cliCatalog();
    if (catalog) {
      try {
        const rows = catalog
          .prepare(
            `SELECT ${CATALOG_COLUMNS}
             FROM local_thread_catalog
             WHERE host_id = 'local' AND source_kind = 'cli'
             ORDER BY source_updated_at DESC
             LIMIT ${MAX_SESSIONS}`,
          )
          .all() as unknown as ThreadRow[];
        for (const row of rows) {
          const prev = byId.get(row.id);
          // catalog 的标题和时间更新，rollout_path 只有 state 库有。
          byId.set(row.id, prev ? { ...prev, ...row, rollout_path: prev.rollout_path } : row);
        }
      } catch {
        // catalog 不可读时保留 state 库结果。
      }
    }
    return [...byId.values()]
      .sort((a, b) => (b.updated_at_ms ?? 0) - (a.updated_at_ms ?? 0))
      .slice(0, MAX_SESSIONS);
  }

  protected override thread(threadId: string): ThreadRow | null {
    let base: ThreadRow | null = null;
    const state = this.openStateDb();
    if (state) {
      try {
        const row = state
          .prepare(
            `SELECT ${THREAD_COLUMNS}
             FROM threads
             WHERE id = ? AND source = 'cli'`,
          )
          .get(threadId) as unknown as ThreadRow | undefined;
        base = row ?? null;
      } catch {
        // 旧库结构不同时退回到 catalog。
      }
    }
    const catalog = this.cliCatalog();
    if (catalog) {
      try {
        const row = catalog
          .prepare(
            `SELECT ${CATALOG_COLUMNS}
             FROM local_thread_catalog
             WHERE host_id = 'local' AND source_kind = 'cli' AND thread_id = ?`,
          )
          .get(threadId) as unknown as ThreadRow | undefined;
        if (row) base = base ? { ...base, ...row, rollout_path: base.rollout_path } : row;
      } catch {
        // catalog 不可读时保留 state 库结果。
      }
    }
    return base;
  }

  private cliCatalog(): DatabaseSync | null {
    if (this.cliCatalogChecked) return this.cliCatalogDb;
    this.cliCatalogChecked = true;
    if (!hasCatalog(CATALOG_PATH)) return null;
    try {
      this.cliCatalogDb = new DatabaseSync(CATALOG_PATH, { readOnly: true });
      return this.cliCatalogDb;
    } catch {
      return null;
    }
  }

  private openStateDb(): DatabaseSync | null {
    if (this.cliStateChecked) return this.cliState;
    this.cliStateChecked = true;
    const path = newestStateDb();
    if (!path) return null;
    try {
      this.cliState = new DatabaseSync(path, { readOnly: true });
      return this.cliState;
    } catch {
      return null;
    }
  }
}

function binary(): string {
  return process.env["AGENT_BRIDGE_CODEX_PATH"] || "codex";
}
