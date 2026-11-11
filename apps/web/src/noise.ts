import { loadNoise, type Noise } from "@craftstead/crypto";

let pending: Promise<Noise> | null = null;

export function noise(): Promise<Noise> {
  pending ??= fetch("/noise.wasm")
    .then((response) => {
      if (!response.ok) throw new Error(`Noise 模块加载失败（${response.status}）`);
      return loadNoise(response);
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
