/**
 * 单实例滑动窗口限流。Workers 的 isolate 会随扩缩容更换，这里只是第一道闸门，
 * 目的是挡住脚本刷房间号与刷配对请求，不做精确计费；真正昂贵的路径还有房间凭据校验。
 */
const buckets = new Map<string, number[]>();
const MAX_KEYS = 10_000;

export interface RateVerdict {
  ok: boolean;
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateVerdict {
  const now = Date.now();
  let hits = buckets.get(key);
  if (!hits) {
    // 只在新键上做清理，避免每个请求都遍历整张表。
    if (buckets.size >= MAX_KEYS) buckets.clear();
    hits = [];
    buckets.set(key, hits);
  }
  while (hits.length > 0 && now - hits[0]! >= windowMs) hits.shift();
  if (hits.length >= limit) {
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - hits[0]!)) / 1000) };
  }
  hits.push(now);
  return { ok: true, retryAfter: 0 };
}

export function clientIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}
