import { randomBytes } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";

const OVERRIDES_KEY = "lm:catalog:overrides";
const CURRENT_VERSION_KEY = "lm:catalog:current-version";
const VERSION_INDEX_KEY = "lm:catalog:versions";
const VERSION_PREFIX = "lm:catalog:version:";
const MAX_VERSIONS = 100;

function safeOverrides(value) {
  return value && typeof value === "object" && value.products && typeof value.products === "object"
    ? value
    : { products: {} };
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
  const script = [
    "if redis.call('GET', KEYS[1]) then return redis.call('GET', KEYS[1]) end",
    "redis.call('SET', KEYS[2], ARGV[1])",
    "redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])",
    "redis.call('SET', KEYS[1], ARGV[3])",
    "return ARGV[3]",
  ].join(" ");
  const result = await redisEval([
    "EVAL", script, "3",
    CURRENT_VERSION_KEY, VERSION_PREFIX + id, VERSION_INDEX_KEY,
    JSON.stringify(record), String(Date.now()), id,
  ]);
  return clean(result, 120) || id;
}

export async function getCatalogVersion(id) {
  return parseJson(await redisCmd(["GET", VERSION_PREFIX + clean(id, 120)]));
}

export async function listCatalogVersions(limit = 30) {
  const currentVersion = clean(await redisCmd(["GET", CURRENT_VERSION_KEY]), 120);
  const ids = await redisCmd(["ZREVRANGE", VERSION_INDEX_KEY, "0", String(Math.max(0, Math.min(99, Number(limit || 30)) - 1))]);
  if (!Array.isArray(ids) || ids.length === 0) return { currentVersion, versions: [] };
  const rows = pipelineRows(await redisPipeline(ids.map((id) => ["GET", VERSION_PREFIX + id])));
  return { currentVersion, versions: rows.map((row) => parseJson(row)).filter(Boolean) };
}

export async function commitCatalogVersion({ overrides, previousOverrides, expectedVersion, actor, source = "save", note = "", rollbackFrom = "" }) {
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
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if current ~= ARGV[1] then return {'CONFLICT', current or ''} end",
    "redis.call('SET', KEYS[2], ARGV[2])",
    "redis.call('SET', KEYS[3], ARGV[3])",
    "redis.call('ZADD', KEYS[4], ARGV[4], ARGV[5])",
    "redis.call('SET', KEYS[1], ARGV[5])",
    "return {'OK', ARGV[5]}",
  ].join(" ");
  const result = await redisEval([
    "EVAL", script, "4",
    CURRENT_VERSION_KEY, OVERRIDES_KEY, VERSION_PREFIX + id, VERSION_INDEX_KEY,
    expected, JSON.stringify(safeOverrides(overrides)), JSON.stringify(record), String(Date.now()), id,
  ]);
  if (Array.isArray(result) && result[0] === "CONFLICT") return { ok: false, conflict: true, currentVersion: clean(result[1], 120) };
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
