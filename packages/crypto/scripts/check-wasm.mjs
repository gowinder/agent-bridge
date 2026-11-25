#!/usr/bin/env node
/**
 * 发布前置守卫：wasm/noise.wasm 是构建产物（不入 git），但必须进 npm 包。
 * 缺了它的版本一旦发布，所有消费者运行时都会 wasm_unavailable，而 npm 版本号不可复用——
 * 所以宁可让 prepublishOnly 失败。
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "wasm", "noise.wasm");

try {
  const { size } = statSync(wasmPath);
  if (size === 0) throw new Error("文件为空");
  console.log(`wasm 就绪：wasm/noise.wasm（${size} 字节）`);
} catch (error) {
  console.error(
    [
      `发布中止：缺少 ${wasmPath}（${error?.code ?? error?.message ?? error}）。`,
      "该文件是构建产物，不在 git 里。任选其一生成后再发布：",
      "  1) cd packages/crypto && npm run build:wasm   （需要 rustup + wasm32-unknown-unknown）",
      '  2) cp "/Applications/AgentBridge.app/Contents/Resources/bridge/node_modules/@craftstead/crypto/wasm/noise.wasm" packages/crypto/wasm/noise.wasm',
    ].join("\n"),
  );
  process.exit(1);
}
