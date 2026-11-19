// 文案表自检：每种语言的 key 必须与英文表完全一致，占位符 {0}/{1}… 也必须一一对应。
// 少一条就回落英文、写错占位符会显示成 {0}，两者都很难在页面上发现，所以放进 npm run check。
import { EN } from "../src/i18n.en.ts";
import { JA } from "../src/i18n.ja.ts";
import { KO } from "../src/i18n.ko.ts";
import { ES } from "../src/i18n.es.ts";
import { FR } from "../src/i18n.fr.ts";
import { DE } from "../src/i18n.de.ts";
import { PT } from "../src/i18n.pt.ts";

const TABLES = { ja: JA, ko: KO, es: ES, fr: FR, de: DE, pt: PT };

const placeholders = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");

let failed = false;
const enKeys = new Set(Object.keys(EN));
for (const [lang, table] of Object.entries(TABLES)) {
  const keys = new Set(Object.keys(table));
  const missing = [...enKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !enKeys.has(key));
  if (missing.length > 0) {
    failed = true;
    console.error(`[i18n] ${lang}: ${missing.length} 条缺翻译`);
    for (const key of missing.slice(0, 20)) console.error(`  - ${key}`);
  }
  if (extra.length > 0) {
    failed = true;
    console.error(`[i18n] ${lang}: ${extra.length} 条 key 在英文表里不存在`);
    for (const key of extra.slice(0, 20)) console.error(`  + ${key}`);
  }
  const bad = [];
  for (const [key, value] of Object.entries(table)) {
    if (placeholders(key) !== placeholders(value)) bad.push([key, value]);
  }
  if (bad.length > 0) {
    failed = true;
    console.error(`[i18n] ${lang}: ${bad.length} 条占位符对不上`);
    for (const [key, value] of bad.slice(0, 20)) console.error(`  ! ${key} → ${value}`);
  }
}

if (failed) process.exit(1);
console.log(`[i18n] ${Object.keys(TABLES).length} 种语言，各 ${enKeys.size} 条，全部对齐`);
