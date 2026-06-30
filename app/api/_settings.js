// 站点设置覆盖层(服务端)。默认在 lib/settings-defaults.js;后台写覆盖到 Redis lm:settings;
// getSettings() 返回「默认+覆盖」合并值。无覆盖 = 默认,行为不变。
import { redisCmd } from "./_utils.js";
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

export async function saveSettings(overrides) {
  // 先合并校验一遍(过滤未知字段/非法值),只存合并后认可的结构。
  const clean = mergeSettings(overrides && typeof overrides === "object" ? overrides : {});
  const ok = await redisCmd(["SET", SETTINGS_KEY, JSON.stringify(clean)]);
  return ok === "OK";
}

export { SETTINGS_DEFAULTS };
