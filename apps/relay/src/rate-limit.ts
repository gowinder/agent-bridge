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

/**
 * 表满时只丢已经空掉的键，仍然满就按插入顺序淘汰最老的 10%。
 * 整表清空等于给攻击者一个全局重置按钮。
 */
function evict(now: number, windowMs: number): void {
  for (const [key, hits] of buckets) {
    const last = hits[hits.length - 1];
    if (last === undefined || now - last >= windowMs) buckets.delete(key);
  }
  if (buckets.size < MAX_KEYS) return;
  let dropped = 0;
  const target = Math.max(1, Math.ceil(buckets.size / 10));
  for (const key of buckets.keys()) {
    if (dropped >= target) break;
    buckets.delete(key);
    dropped += 1;
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): RateVerdict {
  const now = Date.now();
  let hits = buckets.get(key);
  if (!hits) {
    if (buckets.size >= MAX_KEYS) evict(now, windowMs);
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

/** 把 IPv6 展开成 8 组 hextet；写法不认识就返回 null，绝不猜测。 */
function expandIpv6(value: string): string[] | null {
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

/**
 * 每个 IPv6 地址归到 /64：一个用户通常拿到整段地址，按地址逐条计数等于没限流。
 * 解析不了时退回原值，宁可少聚合，也不要把无关地址并进同一个桶。
 */
function normalizeIp(value: string): string {
  if (!value.includes(":")) return value;
  const groups = expandIpv6(value);
  if (!groups) return value;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** 只信 `cf-connecting-ip`：客户端可以自带 `x-forwarded-for`，不能拿来当身份。 */
export function clientIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return normalizeIp(direct);
  return "unknown";
}
