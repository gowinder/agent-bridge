// 思考程度（CLI 的 --effort）没有独立清单接口，从 `claude --help` 里读它的取值；
// 读不到时退回当前已知的五档，新建面板不至于没有选项。
import { execFileSync } from "node:child_process";

export const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const CACHE_MS = 10 * 60_000;
let cache: { binary: string; at: number; levels: string[] } | null = null;

export function effortLevels(binary: string): string[] {
  const now = Date.now();
  if (cache && cache.binary === binary && now - cache.at < CACHE_MS) return cache.levels;
  const levels = parseEffortLevels(helpText(binary));
  cache = { binary, at: now, levels };
  return levels;
}

/** 测试用：清掉缓存，让下一次调用重新读 CLI。 */
export function resetEffortCache(): void {
  cache = null;
}

function helpText(binary: string): string {
  try {
    return execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/** `--effort <level>  Effort level for the current session (low, medium, …)`，括号可能折到下一行。 */
export function parseEffortLevels(help: string): string[] {
  const match = /--effort <level>[\s\S]{0,240}?\(([^)]*)\)/.exec(help);
  if (!match || !match[1]) return [...FALLBACK_EFFORT_LEVELS];
  const levels = match[1]
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z][a-z-]{0,15}$/.test(item));
  // 至少要有两档才当它是一份可信清单，否则是帮助文本解析到了别处。
  return levels.length >= 2 ? levels : [...FALLBACK_EFFORT_LEVELS];
}
