import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import type { Store } from "./store.js";

/** 一条要发到浏览器通知中心的消息。 */
export interface PushPayload {
  title: string;
  body: string;
  /** 点通知时打开的网页路径（含 hash 路由）。 */
  url?: string;
  /** 同一 tag 的通知会互相替换，避免同一件事堆一串。 */
  tag?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** 推送服务已经丢弃的订阅（浏览器卸载、站点数据清空）会回这两个状态码。 */
const GONE_STATUS = new Set([404, 410]);

/**
 * 手机浏览器在后台不会跑网页里的定时器，只有 Web Push 才能把消息送到通知中心。
 * 订阅由网页通过加密通道登记，VAPID 密钥只存在本机 sqlite 里，不经过中继。
 */
export class Pusher {
  private readonly keys: VapidKeys;

  constructor(
    private readonly store: Store,
    private readonly log: (line: string) => void,
  ) {
    this.keys = this.loadKeys();
    setVapidDetails("mailto:agent-bridge@localhost", this.keys.publicKey, this.keys.privateKey);
  }

  publicKey(): string {
    return this.keys.publicKey;
  }

  /** 这台设备登记过的订阅数；网页据此判断要不要重新订阅。 */
  count(deviceId: string): number {
    return this.store.pushSubscriptions(deviceId).length;
  }

  hasSubscriptions(): boolean {
    return this.store.pushSubscriptions().length > 0;
  }

  subscribe(
    deviceId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): number {
    this.store.savePushSubscription({
      endpoint: subscription.endpoint,
      deviceId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      createdAt: Date.now(),
    });
    return this.count(deviceId);
  }

  unsubscribe(deviceId: string, endpoint: string): number {
    this.store.deletePushSubscription(endpoint, deviceId);
    return this.count(deviceId);
  }

  async send(payload: PushPayload): Promise<void> {
    const subscriptions = this.store.pushSubscriptions();
    if (subscriptions.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
            { TTL: 600, urgency: "high" },
          );
        } catch (error) {
          const status = Number((error as { statusCode?: unknown }).statusCode);
          if (GONE_STATUS.has(status)) {
            this.store.deletePushSubscription(subscription.endpoint);
            return;
          }
          this.log(
            `推送失败：${error instanceof Error ? error.message : String(error)}${status ? `（${status}）` : ""}`,
          );
        }
      }),
    );
  }

  private loadKeys(): VapidKeys {
    const raw = this.store.meta("push_vapid");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<VapidKeys>;
        if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
          return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
      } catch {
        // 记录损坏就重新生成；旧订阅的公钥对不上，网页下次连接会重新订阅。
      }
    }
    const generated = generateVAPIDKeys();
    this.store.setMeta("push_vapid", JSON.stringify(generated));
    return generated;
  }
}
