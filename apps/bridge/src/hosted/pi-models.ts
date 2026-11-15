// pi 的模型清单只有跑起来的会话才通过 RPC 报出来，新建会话时还没有进程可问。
// 这里直接读 pi 自己的模型配置，拼成 Bridge 的 `厂商/模型` 写法：
// - models.json：自定义 provider（带 apiKey/baseUrl），一定可用；
// - models-store.json：内置 provider 的目录，只有 auth.json 里有登录项才算可用
//   （pi 的 get_available_models 同样按登录状态过滤）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelOption } from "@craftstead/protocol";
import { piAgentSourceDir } from "./pi-agent-dir.js";

export function piModelCatalog(source: string = piAgentSourceDir()): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (provider: string, model: Record<string, unknown>): void => {
    const id = typeof model["id"] === "string" ? model["id"] : "";
    if (!id) return;
    const full = `${provider}/${id}`;
    if (seen.has(full)) return;
    seen.add(full);
    const name = typeof model["name"] === "string" && model["name"] ? model["name"] : full;
    models.push({ id: full, name });
  };

  const custom = readJson(join(source, "models.json"));
  for (const [provider, config] of Object.entries(providersOf(custom))) {
    for (const model of modelsOf(config)) add(provider, model);
  }

  const store = readJson(join(source, "models-store.json"));
  const auth = readJson(join(source, "auth.json"));
  for (const [provider, config] of Object.entries(providersOf(store))) {
    if (!auth || !(provider in auth)) continue;
    for (const model of modelsOf(config)) add(provider, model);
  }
  return models;
}

/** pi 自己当前用的默认模型（`provider/modelId`），读不到就 undefined。 */
export function piDefaultModel(source: string = piAgentSourceDir()): string | undefined {
  const settings = readJson(join(source, "settings.json"));
  const provider = typeof settings?.["defaultProvider"] === "string" ? settings["defaultProvider"] : "";
  const model = typeof settings?.["defaultModel"] === "string" ? settings["defaultModel"] : "";
  return provider && model ? `${provider}/${model}` : undefined;
}

/**
 * 模型窗口（tokens）。pi 的自动压缩按窗口算，Bridge 要按百分比换算成它认的预留量，
 * 所以启动前得先知道窗口；清单来自 pi 自己的 models.json / models-store.json。
 */
export function piModelContextWindow(model: string, source: string = piAgentSourceDir()): number | undefined {
  for (const file of ["models.json", "models-store.json"]) {
    const parsed = readJson(join(source, file));
    for (const [provider, config] of Object.entries(providersOf(parsed))) {
      for (const entry of modelsOf(config)) {
        const id = typeof entry["id"] === "string" ? entry["id"] : "";
        const window = typeof entry["contextWindow"] === "number" ? entry["contextWindow"] : 0;
        if (!id || window <= 0) continue;
        if (`${provider}/${id}` === model) return window;
      }
    }
  }
  return undefined;
}

function providersOf(file: Record<string, unknown> | null): Record<string, unknown> {
  const providers = file?.["providers"] ?? file;
  return isObject(providers) ? providers : {};
}

function modelsOf(config: unknown): Array<Record<string, unknown>> {
  if (!isObject(config) || !Array.isArray(config["models"])) return [];
  return config["models"].filter(isObject);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    // 文件不存在或写坏了：当作没有这一组模型，不能让新建面板跟着报错。
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
