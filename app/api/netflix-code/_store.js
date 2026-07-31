import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "../_utils.js";

const EVENT_PREFIX = "liumeiti:netflix-mail:event:";
const EVENT_INDEX = "liumeiti:netflix-mail:received";
const ACCOUNT_INDEX_PREFIX = "liumeiti:netflix-mail:account:";
const ACCESS_PREFIX = "liumeiti:netflix-code:access:";
const ACCESS_INDEX = "liumeiti:netflix-code:access-index";
// v2 drops locks created by the former per-poll counter. Automatic polling
// must never lock a customer who only clicked the retrieve button once.
const LOCK_PREFIX = "liumeiti:netflix-code:lock:v2:";
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60;

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function pipelineRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

function pipelineValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result") ? entry.result : entry;
}

function encryptionKey() {
  const secret = String(process.env.NETFLIX_CODE_ENCRYPTION_KEY || "");
  if (secret.length < 32) return null;
  return createHash("sha256").update(secret).digest();
}

function encryptPayload(value) {
  const key = encryptionKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
}

function decryptPayload(payload) {
  const key = encryptionKey();
  if (!key || !payload?.iv || !payload?.tag || !payload?.data) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64url")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

export function netflixAccountHash(email) {
  return createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
}

export function maskNetflixEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [local, domain] = value.split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(3, Math.min(8, local.length - 2)))}@${domain}`;
}

function eventIdFor(messageId, digest) {
  return "NM" + createHash("sha256").update(`${messageId || ""}|${digest || ""}`).digest("hex").slice(0, 24).toUpperCase();
}

function eventKey(eventId) {
  return EVENT_PREFIX + clean(eventId, 80).toUpperCase();
}

function accountIndexKey(hash) {
  return ACCOUNT_INDEX_PREFIX + clean(hash, 80).toLowerCase();
}

export async function storeNetflixMailEvent(parsed, { messageId = "", digest = "" } = {}) {
  const eventId = eventIdFor(messageId, digest);
  const accountEmails = Array.isArray(parsed?.accountEmails) ? parsed.accountEmails : [];
  const accountHashes = Array.from(new Set(accountEmails.map(netflixAccountHash).filter(Boolean)));
  const encrypted = parsed?.accepted && parsed?.value ? encryptPayload(parsed.value) : null;
  if (parsed?.accepted && !encrypted) return { ok: false, error: "encryption_not_configured" };
  const score = new Date(parsed?.receivedAt || Date.now()).getTime();
  const record = {
    eventId,
    accepted: Boolean(parsed?.accepted),
    reason: clean(parsed?.reason, 100),
    kind: parsed?.accepted ? clean(parsed?.kind, 20) : "",
    template: clean(parsed?.template, 100),
    language: clean(parsed?.language || "unknown", 20),
    receivedAt: parsed?.receivedAt || new Date().toISOString(),
    receivedAtBeijing: formatBeijingTime(parsed?.receivedAt || new Date()),
    expiresAt: parsed?.expiresAt || "",
    sender: maskNetflixEmail(parsed?.sender),
    subject: clean(parsed?.subject, 240),
    preview: clean(parsed?.preview, 240),
    accountHashes,
    accountHints: accountEmails.map(maskNetflixEmail).filter(Boolean),
    payload: encrypted,
    messageIdHash: createHash("sha256").update(String(messageId || digest || eventId)).digest("hex"),
  };
  const commands = [
    ["SET", eventKey(eventId), JSON.stringify(record), "EX", String(EVENT_TTL_SECONDS)],
    ["ZADD", EVENT_INDEX, String(score), eventId],
  ];
  for (const hash of accountHashes) commands.push(["ZADD", accountIndexKey(hash), String(score), eventId]);
  const rows = pipelineRows(await redisPipeline(commands));
  const ok = rows.length === commands.length && rows.every((entry) => !entry?.error);
  if (ok) {
    const cutoff = Date.now() - EVENT_TTL_SECONDS * 1000;
    await redisCmd(["ZREMRANGEBYSCORE", EVENT_INDEX, "-inf", String(cutoff)]);
    for (const hash of accountHashes) await redisCmd(["ZREMRANGEBYSCORE", accountIndexKey(hash), "-inf", String(cutoff)]);
  }
  return { ok, eventId, accepted: record.accepted, kind: record.kind, reason: record.reason };
}

export async function findLatestNetflixResult(email, { since = 0 } = {}) {
  const hash = netflixAccountHash(email);
  const minScore = Math.max(Date.now() - 20 * 60 * 1000, Number(since || 0) - 60 * 1000);
  const ids = await redisCmd(["ZREVRANGEBYSCORE", accountIndexKey(hash), "+inf", String(minScore), "LIMIT", "0", "20"]);
  for (const eventId of (Array.isArray(ids) ? ids : [])) {
    const record = parseJson(await redisCmd(["GET", eventKey(eventId)]));
    if (!record?.accepted || !record.accountHashes?.includes(hash)) continue;
    const receivedAt = new Date(record.receivedAt || 0).getTime();
    const expiresAt = new Date(record.expiresAt || 0).getTime();
    if (!receivedAt || receivedAt < minScore || !expiresAt || expiresAt <= Date.now()) continue;
    const value = decryptPayload(record.payload);
    if (!value) continue;
    return {
      eventId: record.eventId,
      kind: record.kind,
      value,
      language: record.language,
      receivedAt: record.receivedAt,
      receivedAtBeijing: record.receivedAtBeijing,
      expiresAt: record.expiresAt,
    };
  }
  return null;
}

export async function recordNetflixCodeAccess(entry) {
  const now = new Date();
  const id = "NA" + randomBytes(8).toString("hex").toUpperCase();
  const record = {
    id,
    orderId: clean(entry?.orderId, 80).toUpperCase(),
    accountHint: clean(entry?.accountHint, 200),
    action: clean(entry?.action, 40),
    outcome: clean(entry?.outcome, 80),
    actorType: entry?.actorType === "guest" ? "guest" : entry?.actorType === "admin" ? "admin" : "user",
    identityHash: clean(entry?.identityHash, 80),
    eventId: clean(entry?.eventId, 80),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  const score = now.getTime();
  const commands = [
    ["SET", ACCESS_PREFIX + id, JSON.stringify(record), "EX", String(ACCESS_TTL_SECONDS)],
    ["ZADD", ACCESS_INDEX, String(score), id],
  ];
  const rows = pipelineRows(await redisPipeline(commands));
  await redisCmd(["ZREMRANGEBYSCORE", ACCESS_INDEX, "-inf", String(Date.now() - ACCESS_TTL_SECONDS * 1000)]);
  return rows.length === commands.length && rows.every((entryRow) => !entryRow?.error);
}

async function recordsFromIndex(indexKey, offset, limit, prefix) {
  const ids = await redisCmd(["ZREVRANGE", indexKey, String(offset), String(offset + limit - 1)]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = pipelineRows(await redisPipeline(ids.map((id) => ["GET", prefix + id])));
  return rows.map((entry) => parseJson(pipelineValue(entry))).filter(Boolean);
}

export async function listNetflixMailEvents({ offset = 0, limit = 60 } = {}) {
  return recordsFromIndex(EVENT_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(100, Number(limit || 60))), EVENT_PREFIX);
}

export async function listNetflixCodeAccess({ offset = 0, limit = 100 } = {}) {
  return recordsFromIndex(ACCESS_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(200, Number(limit || 100))), ACCESS_PREFIX);
}

export function netflixCodeLockKey(orderId) {
  return LOCK_PREFIX + clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
}

export async function clearNetflixCodeLock(orderId) {
  return Number(await redisCmd(["DEL", netflixCodeLockKey(orderId), netflixCodeLockKey(orderId) + ":attempts"]) || 0) >= 0;
}

export function netflixCodeStoreConfigured() {
  return Boolean(encryptionKey());
}
