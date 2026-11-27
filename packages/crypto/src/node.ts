import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadNoise, type Noise } from "./noise.js";

/**
 * 加载期完整性断言（SECURITY-AUDIT-FULL C-1）。
 *
 * 值对应当前这一份 wasm 构建产物（`npm run build:wasm -w @craftstead/crypto` 的产物，
 * 即随 @craftstead/crypto@0.1.1 发布的 wasm/noise.wasm：182570 字节）。
 * 换 wasm 必须同时改这里，否则加载即失败（fail closed，不做"先跑起来再说"）。
 */
export const NOISE_WASM_SHA256 = "32607f32a5e2aa6ab9a550abe20bde76006834b09e7cdf6449e0132bb4f6f4a7";
export const NOISE_WASM_BYTES = 182570;

/** wasm 被替换/损坏时的结构化错误：code 供上层映射，字段留证据，不抛裸字符串。 */
export class WasmIntegrityError extends Error {
  readonly code = "wasm_integrity_failed";
  readonly source: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly actualBytes: number;

  constructor(source: string, expectedSha256: string, actualSha256: string, actualBytes: number) {
    super(
      `wasm 完整性校验失败：${source} 实际 sha256=${actualSha256}（${actualBytes} 字节），` +
        `钉死值=${expectedSha256}（${NOISE_WASM_BYTES} 字节）；拒绝加载 Noise wasm。`,
    );
    this.name = "WasmIntegrityError";
    this.source = source;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
    this.actualBytes = actualBytes;
  }
}

/**
 * Node 侧唯一读取 `wasm/noise.wasm` 的位置。
 * 先算 sha256 与钉死常量比对，不一致就 fail closed（抛 WasmIntegrityError，不进入 instantiate）。
 */
export async function loadNoiseNode(wasmPath?: string | URL): Promise<Noise> {
  const url = wasmPath ?? new URL("../wasm/noise.wasm", import.meta.url);
  const source = url instanceof URL ? url.href : String(url);
  const bytes = await readFile(url);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== NOISE_WASM_SHA256 || bytes.byteLength !== NOISE_WASM_BYTES) {
    throw new WasmIntegrityError(source, NOISE_WASM_SHA256, actualSha256, bytes.byteLength);
  }
  return loadNoise(bytes);
}
