import { createHash } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";
import { recordHealthStatus } from "./_health.js";

const RESTORE_PREFIX = "lm:restore-drill:";
const WEEKLY_DONE_PREFIX = "lm:backup:weekly:done:";
const WEEKLY_LOCK_PREFIX = "lm:backup:weekly:lock:";
const TELEGRAM_FILE_LIMIT = 40 * 1024 * 1024;
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
    const metadata = pipelineRows(await redisPipeline(chunk.flatMap((key) => [["TYPE", key], ["PTTL", key]])));
    const readable = [];
    chunk.forEach((key, index) => {
      const type = String(metadata[index * 2] || "none").toLowerCase();
      const pttl = Number(metadata[index * 2 + 1]);
      if (type === "none") return;
      if (!SUPPORTED_TYPES.has(type)) throw new Error(`unsupported_redis_type:${type}:${key}`);
      readable.push({ key, type, pttl: Number.isFinite(pttl) ? pttl : -1 });
    });
    const values = pipelineRows(await redisPipeline(readable.map((entry) => readCommand(entry.key, entry.type))));
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
  const typeCounts = entries.reduce((out, entry) => {
    out[entry.type] = (out[entry.type] || 0) + 1;
    return out;
  }, {});
  return {
    site: "liumeiti.vip",
    version: 2,
    format: "redis-logical-snapshot",
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

export async function runRestoreDrill(snapshot) {
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
    const values = pipelineRows(await redisPipeline(chunk.map((entry, index) => readCommand(targets[index], entry.type))));
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

export function buildBackupFiles(snapshot, maxBytes = TELEGRAM_FILE_LIMIT) {
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

async function sendTelegramFile(file, caption = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("telegram_not_configured");
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("document", new Blob([file.text], { type: "application/json" }), file.name);
  if (caption) form.set("caption", caption.slice(0, 1000));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`telegram_send_failed:${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload?.ok) throw new Error("telegram_send_rejected");
  return payload.result?.document?.file_id || "";
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
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    await recordHealthStatus("telegram_backup", { status: "disabled", summary: "Telegram 备份未配置", metrics: { week } });
    return { ok: true, skipped: true, reason: "telegram_not_configured", week };
  }
  const doneKey = WEEKLY_DONE_PREFIX + week;
  if (!force && await redisCmd(["GET", doneKey])) return { ok: true, skipped: true, reason: "already_completed", week };
  const lockKey = WEEKLY_LOCK_PREFIX + week;
  if ((await redisCmd(["SET", lockKey, "1", "NX", "EX", "1800"])) !== "OK") return { ok: true, skipped: true, reason: "in_progress", week };
  try {
    const snapshot = await createCompleteBackup();
    const drill = await runRestoreDrill(snapshot);
    if (!drill.ok) throw new Error(`restore_drill_mismatch:${drill.mismatches.join(",")}`);
    const files = buildBackupFiles(snapshot);
    const caption = [
      "冒央会社 · 每周完整备份",
      `时间: ${snapshot.generatedAtBeijing}`,
      `Redis 键: ${snapshot.keyCount}`,
      `恢复演练: ${drill.verified}/${drill.total} 通过`,
      `SHA-256: ${snapshot.checksum}`,
    ].join("\n");
    for (let index = 0; index < files.length; index += 1) await sendTelegramFile(files[index], index === 0 ? caption : "");
    const result = { ok: true, week, keyCount: snapshot.keyCount, checksum: snapshot.checksum, fileCount: files.length, drill };
    await redisCmd(["SET", doneKey, JSON.stringify({ ...result, completedAt: new Date().toISOString() }), "EX", String(180 * 86400)]);
    await recordHealthStatus("telegram_backup", { status: "ok", summary: "每周完整备份已发送", metrics: { week, keyCount: snapshot.keyCount, fileCount: files.length, checksum: snapshot.checksum.slice(0, 16) } });
    await recordHealthStatus("restore_drill", { status: "ok", summary: "恢复演练通过", metrics: { verified: drill.verified, total: drill.total } });
    return result;
  } catch (error) {
    await recordHealthStatus("telegram_backup", { status: "error", summary: "每周备份失败", error: error?.message || "backup_failed", metrics: { week } });
    if (String(error?.message || "").startsWith("restore_")) {
      await recordHealthStatus("restore_drill", { status: "error", summary: "恢复演练失败", error: error.message });
    }
    return { ok: false, week, error: clean(error?.message || "backup_failed", 300) };
  }
}

export const backupInternals = {
  canonicalHash,
  normalizeHash,
  normalizeSet,
  normalizeZset,
  normalizeStream,
  normalizeValue,
  restoreCommands,
  beijingWeekKey,
};
