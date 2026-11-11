import type { SessionAdapters } from "./adapters/index.js";
import type { Pusher } from "./push.js";
import type { SessionSummary } from "@craftstead/protocol";

/** 一次轮询的间隔；回合结束后 10 秒内应该能看到提醒。 */
const POLL_MS = 10_000;
/** 更久没动过的会话不可能还在跑，跳过它们省掉 transcript 扫描。 */
const STALE_MS = 12 * 3600 * 1000;

interface Seen {
  busy: boolean;
  needsDecision: boolean;
}

/**
 * 网页端的「完成」提示只在页面活着时有效，手机锁屏后就没了。这里在 Bridge 里做同样的
 * 边沿检测，再通过 Web Push 把提醒送到系统通知中心：回合结束、开始等待用户回答。
 */
export class SessionNotifier {
  private readonly seen = new Map<string, Seen>();
  private timer: NodeJS.Timeout | null = null;
  private seeded = false;
  private running = false;

  constructor(
    private readonly adapters: SessionAdapters,
    private readonly pusher: Pusher,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 供测试与手动触发；正常由定时器驱动。 */
  async tick(): Promise<void> {
    if (this.running || !this.pusher.hasSubscriptions()) return;
    this.running = true;
    try {
      const { sessions } = await this.adapters.sessions({ limit: 200 });
      const appNames = new Map(this.adapters.apps().apps.map((app) => [app.appId, app.name]));
      const now = Date.now();
      const next = new Map<string, Seen>();
      const firstRun = !this.seeded;
      this.seeded = true;
      for (const session of sessions) {
        if (now - session.updatedAt > STALE_MS) continue;
        const busy = session.busy === true;
        const needsDecision = busy && session.needsDecision === true;
        next.set(session.sessionId, { busy, needsDecision });
        if (firstRun) continue;
        const before = this.seen.get(session.sessionId);
        if (!before) continue;
        const appName = appNames.get(session.appId) ?? "Agent Bridge";
        if (before.busy && !busy) {
          await this.send(session, {
            title: session.title || "对话已完成",
            body: `${appName} · 回复已完成`,
            tag: `ab-done-${session.sessionId}`,
          });
        } else if (!before.needsDecision && needsDecision) {
          await this.send(session, {
            title: session.title || "等待你的决定",
            body: `${appName} · 有提问等你回答`,
            tag: `ab-ask-${session.sessionId}`,
          });
        }
      }
      this.seen.clear();
      for (const [sessionId, state] of next) this.seen.set(sessionId, state);
    } catch (error) {
      this.log(`提醒轮询失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async send(
    session: SessionSummary,
    message: { title: string; body: string; tag: string },
  ): Promise<void> {
    await this.pusher.send({
      ...message,
      url: `/#/clients/${encodeURIComponent(session.appId)}/projects/${encodeURIComponent(
        session.projectId,
      )}/sessions/${encodeURIComponent(session.sessionId)}`,
    });
  }
}
