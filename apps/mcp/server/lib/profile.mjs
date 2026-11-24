/**
 * 启动偏好 profile（DESIGN §8，调用方侧）：存 <状态目录>/profile.json。
 * 默认值不设任何模型/思考等级（空串 = 不传）；要固定偏好时，把 profile.example.json
 * 复制到 <状态目录>/profile.json 再改。
 *
 * 建的会话把非空的偏好显式传给 hosted.create（避免 Bridge 的 rememberCreateDefaults 串扰）；
 * 空字符串 = 不传该参数，由 bridge / CLI 自己的默认决定。
 * session_send 只在 promptSuffix 非空时追加到消息末尾（前端可见，不搞隐形注入）。
 */

import { join } from "node:path";
import { ensureStateDir, readJson, statePaths, writeStateJson } from "./state.mjs";

export const DEFAULT_PROFILE = Object.freeze({
  engine: "pi",
  model: "",
  thinking: "",
  subagentModel: "",
  subagentThinking: "",
  promptSuffix: "",
  relayUrl: "wss://agent-bridge.craftstead.app",
  modeA: false,
});

export const ENGINES = Object.freeze(["pi", "claude"]);

/** 允许空串（= 不传）的启动偏好。 */
const OPTIONAL_STRING_FIELDS = ["model", "thinking", "subagentModel", "subagentThinking", "promptSuffix"];
/** 不能为空、且要校验的字段。 */
const REQUIRED_STRING_FIELDS = ["relayUrl"];

const STRING_FIELDS = [...OPTIONAL_STRING_FIELDS, ...REQUIRED_STRING_FIELDS];

/** wss:// ↔ https:// 互转：relay.mjs 的 relaySocketUrl 按 https/http 判定，喂 wss 会被降级成 ws。 */
export function normalizeRelayUrl(value) {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`中继地址必须是 https/wss（或回环 http/ws）：${value}`);
  }
  return url.origin;
}

/**
 * 合并默认值与文件内容。只接受已知字段；非法值退回默认值并记一条 warning，
 * 不抛错（配置坏了不该让连接器整体不可用）。
 */
export function mergeProfile(base, raw) {
  const warnings = [];
  const profile = { ...base };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) warnings.push("profile 不是 JSON 对象，已忽略整份内容");
    profile.relayUrl = normalizeRelayUrl(profile.relayUrl);
    return { profile, warnings };
  }
  for (const key of ["engine", ...STRING_FIELDS]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") {
      warnings.push(`profile.${key} 不是字符串，已忽略`);
      continue;
    }
    const value = raw[key].trim();
    if (!value) {
      // 可选偏好允许空串：语义是「不传该参数」。engine / relayUrl 空串等于没配，不能接受。
      if (OPTIONAL_STRING_FIELDS.includes(key)) {
        profile[key] = "";
        continue;
      }
      warnings.push(`profile.${key} 为空，已忽略`);
      continue;
    }
    if (key === "engine" && !ENGINES.includes(value)) {
      warnings.push(`profile.engine 只接受 ${ENGINES.join("/")}，已忽略「${value}」`);
      continue;
    }
    if (key === "relayUrl") {
      try {
        profile.relayUrl = normalizeRelayUrl(value);
      } catch (error) {
        warnings.push(`profile.relayUrl 非法（${error.message}），已忽略`);
      }
      continue;
    }
    profile[key] = value;
  }
  if (raw.modeA !== undefined) {
    if (typeof raw.modeA === "boolean") profile.modeA = raw.modeA;
    else warnings.push("profile.modeA 不是布尔值，已忽略");
  }
  profile.relayUrl = normalizeRelayUrl(profile.relayUrl);
  return { profile, warnings };
}

export async function loadProfile() {
  const { profile: profilePath } = statePaths();
  const raw = await readJson(profilePath);
  if (raw === null) {
    const { profile } = mergeProfile(DEFAULT_PROFILE, null);
    await ensureStateDir();
    await writeStateJson(profilePath, profile);
    return { profile, warnings: [], created: true };
  }
  const merged = mergeProfile(DEFAULT_PROFILE, raw);
  return { ...merged, created: false };
}

export async function saveProfile(patch) {
  const { profile } = await loadProfile();
  const merged = mergeProfile({ ...profile }, patch);
  const { profilePath } = statePaths();
  await ensureStateDir();
  await writeStateJson(profilePath, merged.profile);
  return merged;
}

export function profilePathForDisplay() {
  return join(statePaths().dir, "profile.json");
}
