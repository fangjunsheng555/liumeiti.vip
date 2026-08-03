import { createHash } from "node:crypto";
import { formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";
import { recordHealthStatus } from "./_health.js";

const RESTORE_PREFIX = "lm:restore-drill:";
const DEFAULT_BACKUP_PART_LIMIT = 40 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["string", "list", "set", "zset", "hash", "stream"]);

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry));
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeHash(value) {
  if (Array.isArray(value)) {
    const pairs = [];
    for (let index = 0; index + 1 < value.length; index += 2) pairs.push([String(value[index]), String(value[index + 1])]);
    return pairs.sort((a, b) => a[0].localeCompare(b[0])).flat();
  }
  if (value && typeof value === "object") {
    return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, item]) => [String(key), String(item)]);
  }
  return [];
}

function normalizeSet(value) {
  return (Array.isArray(value) ? value : []).map(String).sort();
}

function normalizeZset(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && value[0] && typeof value[0] === "object" && !Array.isArray(value[0])) {
    return value.map((entry) => [String(entry.member ?? entry.value ?? ""), String(entry.score ?? 0)])
      .sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0])).flat();
  }
  const pairs = [];
  for (let index = 0; index + 1 < value.length; index += 2) pairs.push([String(value[index]), String(value[index + 1])]);
  return pairs.sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0])).flat();
}

function normalizeStream(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (Array.isArray(entry)) return [String(entry[0]), normalizeHash(entry[1])];
    if (entry && typeof entry === "object") return [String(entry.id || "*"), normalizeHash(entry.message || entry.fields || {})];
    return null;
  }).filter(Boolean);
}

function normalizeValue(type, value) {
  if (type === "hash") return normalizeHash(value);
  if (type === "set") return normalizeSet(value);
  if (type === "zset") return normalizeZset(value);
  if (type === "stream") return normalizeStream(value);
  if (type === "list") return (Array.isArray(value) ? value : []).map(String);
  return value == null ? "" : String(value);
}

function readCommand(key, type) {
  if (type === "string") return ["GET", key];
  if (type === "list") return ["LRANGE", key, "0", "-1"];
  if (type === "set") return ["SMEMBERS", key];
  if (type === "zset") return ["ZRANGE", key, "0", "-1", "WITHSCORES"];
  if (type === "hash") return ["HGETALL", key];
  if (type === "stream") return ["XRANGE", key, "-", "+"];
  return null;
}

async function scanAllKeys() {
  const keys = new Set();
  let cursor = "0";
  let rounds = 0;
  do {
    const result = await redisCmd(["SCAN", cursor, "COUNT", "500"]);
    if (!Array.isArray(result) || !Array.isArray(result[1])) throw new Error("redis_scan_failed");
    cursor = String(result[0] || "0");
    result[1].forEach((key) => {
      const value = String(key || "");
      if (value && !value.startsWith(RESTORE_PREFIX)) keys.add(value);
    });
    rounds += 1;
    if (rounds > 100000) throw new Error("redis_scan_limit");
  } while (cursor !== "0");
  return Array.from(keys).sort();
}

async function readEntries(keys) {
  const entries = [];
  for (let offset = 0; offset < keys.length; offset += 120) {
    const chunk = keys.slice(offset, offset + 120);
    const metadataCommands = chunk.flatMap((key) => [["TYPE", key], ["PTTL", key]]);
    const metadata = pipelineRows(await redisPipeline(metadataCommands));
    if (metadata.length !== metadataCommands.length || metadata.some((item) => item == null)) {
      throw new Error("backup_metadata_incomplete");
    }
    const readable = [];
    chunk.forEach((key, index) => {
      const type = String(metadata[index * 2] || "none").toLowerCase();
      const pttl = Number(metadata[index * 2 + 1]);
      if (type === "none") return;
      if (!SUPPORTED_TYPES.has(type)) throw new Error(`unsupported_redis_type:${type}:${key}`);
      readable.push({ key, type, pttl: Number.isFinite(pttl) ? pttl : -1 });
    });
    const valueCommands = readable.map((entry) => readCommand(entry.key, entry.type));
    const values = pipelineRows(await redisPipeline(valueCommands));
    if (values.length !== valueCommands.length || values.some((item) => item == null)) {
      throw new Error("backup_values_incomplete");
    }
    readable.forEach((entry, index) => {
      entries.push({ ...entry, value: normalizeValue(entry.type, values[index]) });
    });
  }
  return entries;
}

export async function createCompleteBackup() {
  const startedAt = new Date();
  const keys = await scanAllKeys();
  const entries = await readEntries(keys);
  if (entries.length !== keys.length) throw new Error("backup_snapshot_incomplete");
  const typeCounts = entries.reduce((out, entry) => {
    out[entry.type] = (out[entry.type] || 0) + 1;
    return out;
  }, {});
  return {
    site: "liumeiti.vip",
    version: 2,
    format: "redis-logical-snapshot",
    complete: true,
    generatedAt: startedAt.toISOString(),
    generatedAtBeijing: formatBeijingTime(startedAt),
    keyCount: entries.length,
    typeCounts,
    checksum: canonicalHash(entries),
    entries,
  };
}

function restoreCommands(entry, targetKey) {
  const commands = [["DEL", targetKey]];
  const value = entry.value;
  if (entry.type === "string") commands.push(["SET", targetKey, String(value)]);
  if (entry.type === "list" && value.length) commands.push(["RPUSH", targetKey, ...value]);
  if (entry.type === "set" && value.length) commands.push(["SADD", targetKey, ...value]);
  if (entry.type === "hash" && value.length) commands.push(["HSET", targetKey, ...value]);
  if (entry.type === "zset" && value.length) {
    const args = [];
    for (let index = 0; index + 1 < value.length; index += 2) args.push(String(value[index + 1]), String(value[index]));
    commands.push(["ZADD", targetKey, ...args]);
  }
  if (entry.type === "stream" && value.length) {
    value.forEach(([id, fields]) => { if (fields.length) commands.push(["XADD", targetKey, id, ...fields]); });
  }
  commands.push(["PEXPIRE", targetKey, "300000"]);
  return commands;
}

function validateCompleteSnapshot(snapshot) {
  if (!snapshot || snapshot.complete !== true || snapshot.version !== 2 || snapshot.format !== "redis-logical-snapshot") {
    return { ok: false, error: "restore_snapshot_incomplete" };
  }
  if (!Array.isArray(snapshot.entries) || !Number.isSafeInteger(snapshot.keyCount) || snapshot.keyCount !== snapshot.entries.length) {
    return { ok: false, error: "restore_snapshot_incomplete" };
  }
  if (!snapshot.checksum || snapshot.checksum !== canonicalHash(snapshot.entries)) {
    return { ok: false, error: "restore_snapshot_checksum_mismatch" };
  }
  const validEntries = snapshot.entries.every((entry) => (
    entry && typeof entry.key === "string" && entry.key.length > 0 && SUPPORTED_TYPES.has(entry.type)
  ));
  return validEntries ? { ok: true } : { ok: false, error: "restore_snapshot_incomplete" };
}

export async function runRestoreDrill(snapshot) {
  const validation = validateCompleteSnapshot(snapshot);
  if (!validation.ok) {
    return {
      ok: false,
      verified: 0,
      total: Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0,
      mismatches: [validation.error],
    };
  }
  const runId = Date.now().toString(36);
  let verified = 0;
  const mismatches = [];
  for (let offset = 0; offset < snapshot.entries.length; offset += 40) {
    const chunk = snapshot.entries.slice(offset, offset + 40);
    const targets = chunk.map((entry, index) => `${RESTORE_PREFIX}${runId}:${offset + index}:${createHash("sha1").update(entry.key).digest("hex").slice(0, 12)}`);
    const restore = [];
    chunk.forEach((entry, index) => restore.push(...restoreCommands(entry, targets[index])));
    const restored = pipelineRows(await redisPipeline(restore));
    if (restored.length !== restore.length || restored.some((item) => item == null)) throw new Error("restore_write_failed");
    const readCommands = chunk.map((entry, index) => readCommand(targets[index], entry.type));
    const values = pipelineRows(await redisPipeline(readCommands));
    if (values.length !== readCommands.length || values.some((item) => item == null)) {
      throw new Error("restore_verify_read_failed");
    }
    chunk.forEach((entry, index) => {
      const expected = canonicalHash({ type: entry.type, value: normalizeValue(entry.type, entry.value) });
      const actual = canonicalHash({ type: entry.type, value: normalizeValue(entry.type, values[index]) });
      if (expected === actual) verified += 1;
      else mismatches.push(entry.key);
    });
    await redisPipeline(targets.map((key) => ["DEL", key]));
    if (mismatches.length) break;
  }
  const ok = verified === snapshot.entries.length && mismatches.length === 0;
  return { ok, verified, total: snapshot.entries.length, mismatches: mismatches.slice(0, 20) };
}

function datedFilename(snapshot, suffix = "") {
  const stamp = snapshot.generatedAt.slice(0, 19).replace(/[T:]/g, "-");
  return `liumeiti-complete-backup-${stamp}${suffix}.json`;
}

export function buildBackupFiles(snapshot, maxBytes = DEFAULT_BACKUP_PART_LIMIT) {
  const fullText = JSON.stringify(snapshot);
  if (Buffer.byteLength(fullText) <= maxBytes) return [{ name: datedFilename(snapshot), text: fullText, checksum: canonicalHash(fullText), entries: snapshot.keyCount }];

  const groups = [];
  let current = [];
  let size = 0;
  for (const entry of snapshot.entries) {
    const entrySize = Buffer.byteLength(JSON.stringify(entry)) + 2;
    if (current.length && size + entrySize > maxBytes * 0.88) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entrySize;
  }
  if (current.length) groups.push(current);
  const parts = groups.map((entries, index) => {
    const part = {
      site: snapshot.site,
      version: snapshot.version,
      format: snapshot.format,
      generatedAt: snapshot.generatedAt,
      generatedAtBeijing: snapshot.generatedAtBeijing,
      snapshotChecksum: snapshot.checksum,
      part: index + 1,
      totalParts: groups.length,
      keyCount: entries.length,
      checksum: canonicalHash(entries),
      entries,
    };
    const text = JSON.stringify(part);
    return { name: datedFilename(snapshot, `-part-${String(index + 1).padStart(2, "0")}`), text, checksum: part.checksum, entries: entries.length };
  });
  const manifest = {
    site: snapshot.site,
    version: snapshot.version,
    format: `${snapshot.format}-manifest`,
    generatedAt: snapshot.generatedAt,
    generatedAtBeijing: snapshot.generatedAtBeijing,
    keyCount: snapshot.keyCount,
    snapshotChecksum: snapshot.checksum,
    parts: parts.map(({ name, checksum, entries }) => ({ name, checksum, entries })),
  };
  return [{ name: datedFilename(snapshot, "-manifest"), text: JSON.stringify(manifest), checksum: canonicalHash(manifest), entries: 0 }, ...parts];
}

function beijingWeekKey(now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const date = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

export async function runWeeklyTelegramBackup({ force = false } = {}) {
  const week = beijingWeekKey();
  // Telegram is a notification channel, never a backup destination. Redis can
  // contain users, orders, sessions and provider tokens, so automatic exports
  // remain disabled until encrypted object storage is explicitly configured.
  await recordHealthStatus("telegram_backup", {
    status: "disabled",
    summary: "安全对象存储未配置，自动备份已停用",
    metrics: { week },
  });
  await recordHealthStatus("restore_drill", {
    status: "disabled",
    summary: "没有完整的安全快照，恢复演练已停用",
    metrics: { week },
  });
  return {
    ok: true,
    disabled: true,
    skipped: true,
    reason: "secure_backup_storage_not_configured",
    week,
    forceIgnored: Boolean(force),
  };
}

export const backupInternals = {
  canonicalHash,
  normalizeHash,
  normalizeSet,
  normalizeZset,
  normalizeStream,
  normalizeValue,
  restoreCommands,
  validateCompleteSnapshot,
  beijingWeekKey,
};
