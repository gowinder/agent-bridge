import { readFileSync } from "node:fs";

/**
 * 版本只有一个来源：工作区根的 package.json（dist/ 三层之上）。
 * 打包进 app 时 build.sh 会写一份同布局的 bridge/package.json，两处都能解析到。
 */
export const BRIDGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();
