// Public settings reads remain fail-open; admin reads and writes use strict
// storage checks so a Redis or JSON failure can never be presented as defaults.
import { redisCmd, redisPipeline } from "./_utils.js";
import { SETTINGS_DEFAULTS, mergeSettings } from "../lib/settings-defaults.js";

const SETTINGS_KEY = "lm:settings";
const SETTINGS_REVISION_KEY = "lm:settings:revision:v1";
const SETTINGS_CAS_SCRIPT = `
local function keytype(key)
  local value=redis.call('TYPE',key)
  return type(value)=='table' and value.ok or value
end
local settingsType=keytype(KEYS[1])
local revisionType=keytype(KEYS[2])
if (settingsType~='none' and settingsType~='string') or (revisionType~='none' and revisionType~='string') then
  return '__storage_type__'
end
local expected=tonumber(ARGV[1])
if not expected or expected~=math.floor(expected) or expected<0 or expected>9007199254740990 then
  return '__invalid_version__'
end
local revisionRaw=redis.call('GET',KEYS[2])
local current=0
if revisionRaw then
  if not string.match(revisionRaw,'^%d+$') then return '__revision_corrupt__' end
  current=tonumber(revisionRaw)
  if not current or current~=math.floor(current) or current<0 or current>9007199254740990 then
    return '__revision_corrupt__'
  end
end
local existing=redis.call('GET',KEYS[1])
if not existing and current~=0 then return '__settings_corrupt__' end
if current~=expected then return '__conflict__:'..tostring(current) end
if existing then
  if not string.match(existing,'^%s*{') then return '__settings_corrupt__' end
  local existingOk,existingParsed=pcall(cjson.decode,existing)
  if not existingOk or type(existingParsed)~='table' then return '__settings_corrupt__' end
end
local parsedOk,parsed=pcall(cjson.decode,ARGV[2])
if not parsedOk or type(parsed)~='table' then return '__invalid_settings__' end
local next=current+1
redis.call('SET',KEYS[1],ARGV[2])
redis.call('SET',KEYS[2],tostring(next))
return tostring(next)`;

function unavailable(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function strictPipelineValues(value, expected, code = "settings_store_unavailable") {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.result) ? value.result : null;
  if (!rows || rows.length !== expected) throw unavailable(code);
  return rows.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) throw unavailable(code);
    const result = entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
    if (result === undefined) throw unavailable(code);
    return result;
  });
}

function parseRevision(value) {
  if (value == null) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw unavailable("settings_revision_corrupt");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw unavailable("settings_revision_corrupt");
  }
  return revision;
}

function parseOverridesStrict(value) {
  if (value == null) return null;
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch {
    throw unavailable("settings_store_corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unavailable("settings_store_corrupt");
  }
  return parsed;
}

export async function getSettingsOverrides() {
  try {
    const raw = await redisCmd(["GET", SETTINGS_KEY]);
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function getSettings(overrides = null) {
  const ov = overrides || await getSettingsOverrides();
  return mergeSettings(ov);
}

export async function getAdminSettingsStateStrict() {
  const values = strictPipelineValues(await redisPipeline([
    ["GET", SETTINGS_KEY],
    ["GET", SETTINGS_REVISION_KEY],
    ["PING"],
  ]), 3);
  if (values[2] !== "PONG") throw unavailable("settings_store_unavailable");
  const overrides = parseOverridesStrict(values[0]);
  const currentVersion = parseRevision(values[1]);
  if (overrides == null && currentVersion !== 0) throw unavailable("settings_store_corrupt");
  return { settings: mergeSettings(overrides || {}), currentVersion };
}

export async function getSettingsStrict() {
  return (await getAdminSettingsStateStrict()).settings;
}

async function readCommittedSettings() {
  const values = strictPipelineValues(await redisPipeline([
    ["GET", SETTINGS_KEY],
    ["GET", SETTINGS_REVISION_KEY],
    ["PING"],
  ]), 3);
  if (values[2] !== "PONG") throw unavailable("settings_store_unavailable");
  return { raw: typeof values[0] === "string" ? values[0] : null, currentVersion: parseRevision(values[1]) };
}

export async function saveSettings(settings, { expectedVersion } = {}) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: "invalid_base_version" };
  }
  const raw = JSON.stringify(settings);
  const response = await redisPipeline([
    ["EVAL", SETTINGS_CAS_SCRIPT, "2", SETTINGS_KEY, SETTINGS_REVISION_KEY, String(expectedVersion), raw],
    ["PING"],
  ]);
  let values = null;
  try { values = strictPipelineValues(response, 2); } catch {}
  const result = values?.[0];
  if (typeof result === "string" && result.startsWith("__conflict__:")) {
    return {
      ok: false,
      conflict: true,
      error: "version_conflict",
      currentVersion: Number(result.slice("__conflict__:".length)),
    };
  }
  if (values?.[1] === "PONG" && /^\d+$/.test(String(result || ""))) {
    const currentVersion = Number(result);
    return Number.isSafeInteger(currentVersion) && currentVersion === expectedVersion + 1
      ? { ok: true, currentVersion }
      : { ok: false, error: "settings_store_unavailable" };
  }

  // The pipeline POST may commit before its HTTP response is lost. Verify the
  // exact document before reporting failure, preventing a false failed-save UI.
  try {
    const verified = await readCommittedSettings();
    if (verified.currentVersion === expectedVersion + 1 && verified.raw === raw) {
      return { ok: true, currentVersion: verified.currentVersion, recovered: true };
    }
    if (verified.currentVersion !== expectedVersion) {
      return { ok: false, conflict: true, error: "version_conflict", currentVersion: verified.currentVersion };
    }
  } catch {}
  return {
    ok: false,
    error: String(result || "").includes("corrupt") ? "settings_store_corrupt" : "settings_store_unavailable",
  };
}

export { SETTINGS_DEFAULTS, SETTINGS_KEY, SETTINGS_REVISION_KEY };
