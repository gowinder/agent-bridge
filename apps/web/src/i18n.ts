/**
 * 多语言支持：源码里的中文就是 key（缺翻译时原样返回），译文按语言放在 i18n.<lang>.ts。
 * 用中文当 key 是为了让 diff 保持可读，也省掉给每条文案起名字的成本。
 * 带插值的文案把 `${x}` 换成 `{0}`、`{1}`……，英文表按同一套占位符书写。
 */
import { DE } from "./i18n.de";
import { EN } from "./i18n.en";
import { ES } from "./i18n.es";
import { FR } from "./i18n.fr";
import { JA } from "./i18n.ja";
import { KO } from "./i18n.ko";
import { PT } from "./i18n.pt";

export type Lang = "zh" | "en" | "ja" | "ko" | "es" | "fr" | "de" | "pt";

/** 语言选择器按自称排列：用户总能认出自己那一条。 */
export const LANGS: Array<{ id: Lang; label: string; locale: string }> = [
  { id: "zh", label: "中文", locale: "zh-CN" },
  { id: "en", label: "English", locale: "en-US" },
  { id: "ja", label: "日本語", locale: "ja-JP" },
  { id: "ko", label: "한국어", locale: "ko-KR" },
  { id: "es", label: "Español", locale: "es-ES" },
  { id: "fr", label: "Français", locale: "fr-FR" },
  { id: "de", label: "Deutsch", locale: "de-DE" },
  { id: "pt", label: "Português", locale: "pt-BR" },
];

/** 中文是源语言，没有表；其余语言查不到时回落到英文，再回落到中文原文。 */
const TABLES: Partial<Record<Lang, Record<string, string>>> = {
  en: EN,
  ja: JA,
  ko: KO,
  es: ES,
  fr: FR,
  de: DE,
  pt: PT,
};

const LANG_KEY = "ab.lang";

function isLang(value: string | null | undefined): value is Lang {
  return LANGS.some((item) => item.id === value);
}

/** 浏览器语言按主标签匹配，`ja-JP` / `ja` 都算日文。 */
function fromBrowser(): Lang {
  const raw = (navigator.language || "").toLowerCase();
  const base = raw.split("-")[0] ?? "";
  if (isLang(base)) return base;
  // 繁体中文也先给简体文案，总比整页英文好读。
  if (base === "zh") return "zh";
  return "en";
}

/** 英文表里没有的 key，`?i18n=missing` 时列在页面上，方便补齐。 */
const missing = new Set<string>();

function detect(): Lang {
  try {
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (isLang(fromUrl)) {
      localStorage.setItem(LANG_KEY, fromUrl);
      return fromUrl;
    }
    const stored = localStorage.getItem(LANG_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // 隐私模式下没有 storage，退回浏览器语言
  }
  return fromBrowser();
}

let current: Lang = detect();

export function lang(): Lang {
  return current;
}

/** 与 `toLocaleString` 配套的地区码。 */
export function locale(): string {
  return LANGS.find((item) => item.id === current)?.locale ?? "en-US";
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

/** 语言选择器用：当前语言的 id。 */
export function langId(): Lang {
  return current;
}

/**
 * 取本地化文案。`zh` 是源码里的中文原文，`args` 依次替换 `{0}`、`{1}`……
 * 英文缺这条时回落中文原文，并记录到 missing 里。
 */
export function tr(zh: string, ...args: Array<string | number>): string {
  let text = zh;
  if (current !== "zh") {
    const mapped = TABLES[current]?.[zh];
    if (mapped !== undefined) {
      text = mapped;
    } else if (current === "en") {
      missing.add(zh);
    } else {
      // 非英文语言缺条目时回落到英文：比中文原文更好读，也能一眼看出没翻完。
      missing.add(zh);
      text = EN[zh] ?? zh;
    }
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
  if (!text || current === "zh") return text ?? "";
  const mapped = TABLES[current]?.[text] ?? EN[text];
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
  if (current === "zh") return;
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

document.documentElement.lang = locale();
