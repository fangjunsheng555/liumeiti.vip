// 站点设置覆盖层(服务端)。默认在 lib/settings-defaults.js;后台写覆盖到 Redis lm:settings;
// getSettings() 返回「默认+覆盖」合并值。无覆盖 = 默认,行为不变。
import { redisCmd, redisPipeline } from "./_utils.js";
import { SETTINGS_DEFAULTS, mergeSettings } from "../lib/settings-defaults.js";

const SETTINGS_KEY = "lm:settings";

export async function getSettingsOverrides() {
  try {
    const raw = await redisCmd(["GET", SETTINGS_KEY]);
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) { return {}; }
}

export async function getSettings(overrides = null) {
  const ov = overrides || await getSettingsOverrides();
  return mergeSettings(ov);
}

export async function getSettingsStrict() {
  const rawResponse = await redisPipeline([["GET", SETTINGS_KEY], ["PING"]]);
  const response = Array.isArray(rawResponse)
    ? rawResponse
    : Array.isArray(rawResponse?.result) ? rawResponse.result : [];
  if (!Array.isArray(response) || response.length !== 2) {
    const error = new Error("settings_store_unavailable");
    error.code = "settings_store_unavailable";
    throw error;
  }
  const values = response.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) return undefined;
    return entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
  });
  if (values[1] !== "PONG" || values[0] === undefined) {
    const error = new Error("settings_store_unavailable");
    error.code = "settings_store_unavailable";
    throw error;
  }
  if (values[0] == null) return mergeSettings({});
  let overrides;
  try { overrides = typeof values[0] === "string" ? JSON.parse(values[0]) : values[0]; } catch {}
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    const error = new Error("settings_store_corrupt");
    error.code = "settings_store_corrupt";
    throw error;
  }
  return mergeSettings(overrides);
}

export async function saveSettings(overrides) {
  // 先合并校验一遍(过滤未知字段/非法值),只存合并后认可的结构。
  const clean = mergeSettings(overrides && typeof overrides === "object" ? overrides : {});
  const ok = await redisCmd(["SET", SETTINGS_KEY, JSON.stringify(clean)]);
  return ok === "OK";
}

export { SETTINGS_DEFAULTS };
