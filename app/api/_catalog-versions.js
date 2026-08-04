import { randomBytes } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";

const OVERRIDES_KEY = "lm:catalog:overrides";
const CURRENT_VERSION_KEY = "lm:catalog:current-version";
const VERSION_INDEX_KEY = "lm:catalog:versions";
const VERSION_PREFIX = "lm:catalog:version:";
const MAX_VERSIONS = 100;

function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function validCatalogOverrides(value) { return plain(value) && plain(value.products); }

function safeOverrides(value) {
  return validCatalogOverrides(value) ? value : { products: {} };
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry));
}

async function redisEval(command) {
  const rows = pipelineRows(await redisPipeline([command]));
  return rows[0];
}

function makeVersionId() {
  return `CV${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
}

function validVersionRecord(record, expectedId = "") {
  const id = clean(record?.id, 120);
  return plain(record) && Boolean(id) && id === record.id && (!expectedId || id === expectedId)
    && validCatalogOverrides(record.overrides) && plain(record.summary) && plain(record.actor)
    && Boolean(clean(record.source, 30)) && Number.isFinite(Date.parse(record.createdAt || ""));
}

function flatten(value, prefix = "", out = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, out));
    if (value.length === 0) out.set(prefix, "[]");
    return out;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    keys.forEach((key) => flatten(value[key], prefix ? `${prefix}.${key}` : key, out));
    if (keys.length === 0 && prefix) out.set(prefix, "{}");
    return out;
  }
  out.set(prefix, value);
  return out;
}

function displayValue(value) {
  if (value == null) return "--";
  if (typeof value === "boolean") return value ? "是" : "否";
  return clean(value, 100) || "--";
}

export function catalogVersionDiff(beforeValue, afterValue) {
  const before = flatten(safeOverrides(beforeValue));
  const after = flatten(safeOverrides(afterValue));
  const paths = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
  const changes = [];
  const products = new Set();
  for (const path of paths) {
    const oldValue = before.get(path);
    const newValue = after.get(path);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    const match = path.match(/^products\.([^.[]+)/);
    if (match) products.add(match[1]);
    changes.push({
      path,
      product: match?.[1] || "catalog",
      before: displayValue(oldValue),
      after: displayValue(newValue),
    });
  }
  return {
    productKeys: Array.from(products),
    productCount: products.size,
    fieldCount: changes.length,
    changes: changes.slice(0, 120),
  };
}

function actorInfo(actor = {}) {
  return {
    staffId: Number(actor.staffId || 0),
    staffUsername: clean(actor.staffUsername || actor.username || "system", 60),
  };
}

function versionRecord({ id, overrides, previousOverrides, previousVersion, actor, source, note, rollbackFrom }) {
  const now = new Date();
  return {
    id,
    source: clean(source || "save", 30),
    note: clean(note || "", 160),
    rollbackFrom: clean(rollbackFrom || "", 120),
    previousVersion: clean(previousVersion || "", 120),
    actor: actorInfo(actor),
    summary: catalogVersionDiff(previousOverrides, overrides),
    overrides: safeOverrides(overrides),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
}

async function pruneVersions() {
  const oldIds = await redisCmd(["ZREVRANGE", VERSION_INDEX_KEY, String(MAX_VERSIONS), "-1"]);
  if (!Array.isArray(oldIds) || oldIds.length === 0) return;
  const commands = [["ZREM", VERSION_INDEX_KEY, ...oldIds]];
  oldIds.forEach((id) => commands.push(["DEL", VERSION_PREFIX + id]));
  await redisPipeline(commands);
}

export async function ensureCatalogBaseline(overrides, actor = {}) {
  if (!validCatalogOverrides(overrides)) throw new Error("invalid_catalog_overrides");
  const current = clean(await redisCmd(["GET", CURRENT_VERSION_KEY]), 120);
  if (current) return current;
  const id = makeVersionId();
  const record = versionRecord({
    id,
    overrides: safeOverrides(overrides),
    previousOverrides: { products: {} },
    previousVersion: "",
    actor,
    source: "baseline",
    note: "启用目录版本记录",
  });
  const script = `
local function keytype(key)
  local value=redis.call('TYPE',key)
  if type(value)=='table' then return value.ok or '' end
  return value
end
local currentType=keytype(KEYS[1])
local versionType=keytype(KEYS[2])
local indexType=keytype(KEYS[3])
if (currentType~='none' and currentType~='string')
  or (versionType~='none' and versionType~='string')
  or (indexType~='none' and indexType~='zset') then
  return {'ERROR','storage_type_error'}
end
local current=currentType=='string' and redis.call('GET',KEYS[1]) or false
if current and current~='' then return current end
if versionType~='none' then return {'ERROR','version_id_conflict'} end
local recordOk,record=pcall(cjson.decode,ARGV[1])
local score=tonumber(ARGV[2])
  if not recordOk or type(record)~='table' or tostring(record.id or '')~=ARGV[3]
    or type(record.overrides)~='table' or type(record.overrides.products)~='table'
  or not score or score~=score or score~=math.floor(score) or score<0 or score>9007199254740991
  or ARGV[3]=='' or #ARGV[3]>120 then
  return {'ERROR','invalid_version_record'}
end
redis.call('SET',KEYS[2],ARGV[1])
redis.call('ZADD',KEYS[3],ARGV[2],ARGV[3])
redis.call('SET',KEYS[1],ARGV[3])
return ARGV[3]`;
  const result = await redisEval([
    "EVAL", script, "3",
    CURRENT_VERSION_KEY, VERSION_PREFIX + id, VERSION_INDEX_KEY,
    JSON.stringify(record), String(Date.now()), id,
  ]);
  if (Array.isArray(result) && result[0] === "ERROR") {
    const error = new Error("catalog_version_storage_error");
    error.code = clean(result[1], 60) || "version_commit_failed";
    throw error;
  }
  return clean(result, 120) || id;
}

export async function getCatalogVersion(id) {
  const safeId = clean(id, 120);
  if (!safeId || safeId !== id) return null;
  const record = parseJson(await redisCmd(["GET", VERSION_PREFIX + safeId]));
  return validVersionRecord(record, safeId) ? record : null;
}

export async function listCatalogVersions(limit = 30) {
  const currentVersion = clean(await redisCmd(["GET", CURRENT_VERSION_KEY]), 120);
  const ids = await redisCmd(["ZREVRANGE", VERSION_INDEX_KEY, "0", String(Math.max(0, Math.min(99, Number(limit || 30)) - 1))]);
  if (!Array.isArray(ids) || ids.length === 0) return { currentVersion, versions: [] };
  if (ids.some((id, index) => clean(id, 120) !== id || ids.indexOf(id) !== index)) throw new Error("catalog_version_storage_corrupt");
  const response = await redisPipeline(ids.map((id) => ["GET", VERSION_PREFIX + id]));
  if (!Array.isArray(response) || response.length !== ids.length || response.some((entry) => entry?.error)) throw new Error("catalog_version_storage_error");
  const versions = pipelineRows(response).map(parseJson);
  if (versions.some((record, index) => !validVersionRecord(record, ids[index]))) throw new Error("catalog_version_storage_corrupt");
  return { currentVersion, versions };
}

export async function commitCatalogVersion({ overrides, previousOverrides, expectedVersion, actor, source = "save", note = "", rollbackFrom = "" }) {
  if (!validCatalogOverrides(overrides) || !validCatalogOverrides(previousOverrides)) return { ok: false, error: "invalid_catalog_overrides" };
  const currentVersion = await ensureCatalogBaseline(previousOverrides, actor);
  const expected = clean(expectedVersion || currentVersion, 120);
  const id = makeVersionId();
  const record = versionRecord({
    id,
    overrides,
    previousOverrides,
    previousVersion: currentVersion,
    actor,
    source,
    note,
    rollbackFrom,
  });
  const script = `
local function keytype(key)
  local value=redis.call('TYPE',key)
  if type(value)=='table' then return value.ok or '' end
  return value
end
local currentType=keytype(KEYS[1])
local overridesType=keytype(KEYS[2])
local versionType=keytype(KEYS[3])
local indexType=keytype(KEYS[4])
if currentType~='string'
  or (overridesType~='none' and overridesType~='string')
  or versionType~='none'
  or (indexType~='none' and indexType~='zset') then
  return {'ERROR','storage_type_error'}
end
local current=redis.call('GET',KEYS[1])
if current~=ARGV[1] then return {'CONFLICT',current or ''} end
local overridesOk,decodedOverrides=pcall(cjson.decode,ARGV[2])
local recordOk,decodedRecord=pcall(cjson.decode,ARGV[3])
local score=tonumber(ARGV[4])
  if not overridesOk or type(decodedOverrides)~='table' or type(decodedOverrides.products)~='table'
    or not recordOk or type(decodedRecord)~='table' or tostring(decodedRecord.id or '')~=ARGV[5]
    or type(decodedRecord.overrides)~='table' or type(decodedRecord.overrides.products)~='table'
  or not score or score~=score or score~=math.floor(score) or score<0 or score>9007199254740991
  or ARGV[5]=='' or #ARGV[5]>120 then
  return {'ERROR','invalid_version_record'}
end
redis.call('SET',KEYS[2],ARGV[2])
redis.call('SET',KEYS[3],ARGV[3])
redis.call('ZADD',KEYS[4],ARGV[4],ARGV[5])
redis.call('SET',KEYS[1],ARGV[5])
return {'OK',ARGV[5]}`;
  const result = await redisEval([
    "EVAL", script, "4",
    CURRENT_VERSION_KEY, OVERRIDES_KEY, VERSION_PREFIX + id, VERSION_INDEX_KEY,
    expected, JSON.stringify(safeOverrides(overrides)), JSON.stringify(record), String(Date.now()), id,
  ]);
  if (Array.isArray(result) && result[0] === "CONFLICT") return { ok: false, conflict: true, currentVersion: clean(result[1], 120) };
  if (Array.isArray(result) && result[0] === "ERROR") return { ok: false, error: "version_commit_failed" };
  if (!Array.isArray(result) || result[0] !== "OK") return { ok: false, error: "version_commit_failed" };
  await pruneVersions().catch(() => {});
  return { ok: true, currentVersion: id, version: record };
}

export const catalogVersionKeys = {
  OVERRIDES_KEY,
  CURRENT_VERSION_KEY,
  VERSION_INDEX_KEY,
  VERSION_PREFIX,
};
