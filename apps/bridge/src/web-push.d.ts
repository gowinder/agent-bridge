/**
 * web-push 4 自带 ESM 但没有类型声明；这里只声明 Bridge 用到的几个具名导出，
 * 而不是装一份按 CJS 写的 @types（那份的默认导出在 v4 运行时不复存在）。
 */
declare module "web-push" {
  export interface PushSubscriptionJSON {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  }

  export interface WebPushError extends Error {
    statusCode: number;
    body: string;
  }

  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: PushSubscriptionJSON,
    payload?: string | Buffer,
    options?: { TTL?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string },
  ): Promise<{ statusCode: number; body: string }>;
}
