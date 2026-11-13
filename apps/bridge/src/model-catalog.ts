// 模型目录：桌面端拉取的 signed catalog 优先，取不到再退回 CLI 自己缓存的目录。
// 桌面会话（只展示）和托管会话（新建时可挑）共用同一份清单。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "@craftstead/protocol";

const SUPPORT_DIR = join(homedir(), "Library", "Application Support");
const CACHE_MS = 60_000;

let cache: { at: number; models: ModelOption[] } | null = null;

/** 目录里的 models 数组：只留下选择器会显示的常用与更多两组。 */
export function modelOptionsOf(list: unknown): ModelOption[] {
  if (!Array.isArray(list)) return [];
  const out: ModelOption[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    const name = typeof entry["name"] === "string" ? entry["name"] : "";
    if (!id || !name) continue;
    const section = entry["section"];
    if (section !== "main" && section !== "overflow") continue;
    out.push({ id, name, section });
  }
  return out;
}

export function modelCatalog(): ModelOption[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.models;
  const published = publishedCatalogModels();
  const base = published.length > 0 ? published : cachedCatalogModels();
  // 用户自己配的模型（magpie 路由等）排在最前：它们通常才是使用者想选的。
  const custom = pickerModels();
  const taken = new Set(custom.map((item) => item.id));
  const models = [...custom, ...base.filter((item) => !taken.has(item.id))];
  cache = { at: now, models };
  return models;
}

/**
 * `~/.claude/settings.json` 的 `modelPicker.options`：桌面/CLI 模型选择器里的自定义条目，
 * 由 magpie 之类的路由器写入。静态 catalog 里没有这些 id，托管面板要单独读一份。
 */
function pickerModels(): ModelOption[] {
  const out: ModelOption[] = [];
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"),
    ) as { modelPicker?: { options?: unknown } };
    const list = raw.modelPicker?.options;
    if (!Array.isArray(list)) return out;
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry["model"] === "string" ? entry["model"].trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = typeof entry["label"] === "string" ? entry["label"].trim() : "";
      out.push({ id, name: label || id, section: "custom" });
    }
  } catch {
    // 没配 picker 或格式变了：没有自定义模型。
  }
  return out;
}

/** 桌面端拉取的 signed catalog：surfaces.ccd 就是 Code 会话模型选择器的清单。 */
function publishedCatalogModels(): ModelOption[] {
  for (const name of ["Claude-3p", "Claude"]) {
    const path = join(SUPPORT_DIR, name, "model-catalog", "published.json");
    try {
      const outer = JSON.parse(readFileSync(path, "utf8")) as { documentBytes?: unknown };
      if (typeof outer.documentBytes !== "string") continue;
      const doc = JSON.parse(Buffer.from(outer.documentBytes, "base64").toString("utf8")) as {
        surfaces?: Record<string, { model_selector_config?: { models?: unknown }[] }>;
      };
      const configs = doc.surfaces?.["ccd"]?.model_selector_config ?? doc.surfaces?.["cc"]?.model_selector_config;
      const models = modelOptionsOf(configs?.[0]?.models);
      if (models.length > 0) return models;
    } catch {
      // 应用没写过这份缓存：试下一个目录，最后退回 CLI 的本地缓存。
    }
  }
  return [];
}

/** CLI 自己缓存的目录，字段比桌面端少一档，内容也常常落后一版。 */
function cachedCatalogModels(): ModelOption[] {
  const models: ModelOption[] = [];
  try {
    const dir = join(homedir(), ".claude", "cache", "model-catalog");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith("-ccd.json"))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { path: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const raw = files[0] ? (JSON.parse(readFileSync(files[0].path, "utf8")) as unknown) : null;
    const list = (raw as { catalog?: { config?: { models?: unknown } } } | null)?.catalog?.config?.models;
    if (Array.isArray(list)) {
      for (const item of list as Array<Record<string, unknown>>) {
        if (typeof item?.["id"] !== "string" || typeof item?.["name"] !== "string") continue;
        models.push({
          id: item["id"],
          name: item["name"],
          ...(item["section"] === "main" || item["section"] === "overflow"
            ? { section: item["section"] }
            : {}),
        });
      }
    }
  } catch {
    // 没有缓存或格式变了：调用方只会拿到空清单。
  }
  return models;
}
