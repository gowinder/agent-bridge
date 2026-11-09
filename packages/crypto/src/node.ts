import { readFile } from "node:fs/promises";
import { loadNoise, type Noise } from "./noise.js";

export async function loadNoiseNode(wasmPath?: string | URL): Promise<Noise> {
  const url = wasmPath ?? new URL("../wasm/noise.wasm", import.meta.url);
  return loadNoise(await readFile(url));
}
