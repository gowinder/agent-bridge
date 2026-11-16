/**
 * 双语支持：源码里的中文就是 key（缺翻译时原样返回），英文放在 i18n.en.ts。
 * 用中文当 key 是为了让 diff 保持可读，也省掉给每条文案起名字的成本。
 * 带插值的文案把 `${x}` 换成 `{0}`、`{1}`……，英文表按同一套占位符书写。
 */
import { EN } from "./i18n.en";

export type Lang = "zh" | "en";

const LANG_KEY = "ab.lang";

/** 英文表里没有的 key，`?i18n=missing` 时列在页面上，方便补齐。 */
const missing = new Set<string>();

function detect(): Lang {
  try {
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (fromUrl === "en" || fromUrl === "zh") {
      localStorage.setItem(LANG_KEY, fromUrl);
      return fromUrl;
    }
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // 隐私模式下没有 storage，退回浏览器语言
  }
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = detect();

export function lang(): Lang {
  return current;
}

/** 与 `toLocaleString` 配套的地区码：中文保持 zh-CN，其余按 en-US 排。 */
export function locale(): string {
  return current === "zh" ? "zh-CN" : "en-US";
}

/** 切换语言后整页重绘：文案散落在已渲染的 DOM 里，重载是最省事也最不会漏的做法。 */
export function setLang(next: Lang): void {
  if (next === current) return;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // storage 不可用时只在本次会话生效
  }
  location.reload();
}

export function toggleLang(): void {
  setLang(current === "zh" ? "en" : "zh");
}

/** 按钮上的文字显示「点一下会切到哪种语言」。 */
export function langSwitchLabel(): string {
  return current === "zh" ? "English" : "中文";
}

/**
 * 取本地化文案。`zh` 是源码里的中文原文，`args` 依次替换 `{0}`、`{1}`……
 * 英文缺这条时回落中文原文，并记录到 missing 里。
 */
export function tr(zh: string, ...args: Array<string | number>): string {
  let text = zh;
  if (current === "en") {
    const mapped = EN[zh];
    if (mapped === undefined) missing.add(zh);
    else text = mapped;
  }
  if (args.length === 0) return text;
  return text.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 服务器下发的文案（环境表、批准提示、适配器说明）也走同一张表。
 * 带插值的几条是完整句式，只能按格式认回来；认不出就原样显示中文。
 */
const SERVER_PATTERNS: Array<[RegExp, string]> = [
  [/^允许执行 (.+) 吗？$/, "允许执行 {0} 吗？"],
  [/^运行中（pid (.+)）$/, "运行中（pid {0}）"],
  [/^(\d+) 分钟$/, "{0} 分钟"],
];

export function serverTr(text: string | undefined): string {
  if (!text || current !== "en") return text ?? "";
  const mapped = EN[text];
  if (mapped !== undefined) return mapped;
  for (const [pattern, key] of SERVER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return tr(key, ...match.slice(1));
  }
  return text;
}

/** 开发自检：`?i18n=missing` 把英文缺的条目列在页面右下角。 */
export function reportMissing(): void {
  if (!new URLSearchParams(location.search).has("i18n")) return;
  if (current !== "en") return;
  if (missing.size === 0) {
    document.title = `[i18n] 0 missing · ${document.title}`;
    return;
  }
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:420px;max-height:60vh;overflow:auto;background:#1d1d1f;color:#f5f5f7;font:12px/1.5 ui-monospace,monospace;padding:8px 10px;border-radius:8px;opacity:.95";
  box.textContent = `i18n missing (${missing.size}):\n${[...missing].join("\n")}`;
  document.body.append(box);
}

document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
