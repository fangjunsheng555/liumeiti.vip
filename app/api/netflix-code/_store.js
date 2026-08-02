import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "../_utils.js";

const EVENT_PREFIX = "liumeiti:netflix-mail:event:";
const EVENT_INDEX = "liumeiti:netflix-mail:received";
const ACCOUNT_INDEX_PREFIX = "liumeiti:netflix-mail:account:";
const ACCESS_PREFIX = "liumeiti:netflix-code:access:";
// Only successful deliveries belong in the operational history. The former
// index also contained authorization and polling noise, so keep a clean index
// instead of migrating those rows into the new view.
const ACCESS_INDEX = "liumeiti:netflix-code:access-success-index:v1";
const ACCESS_DEDUPE_PREFIX = "liumeiti:netflix-code:access-success-dedupe:";
// v2 drops locks created by the former per-poll counter. Automatic polling
// must never lock a customer who only clicked the retrieve button once.
const LOCK_PREFIX = "liumeiti:netflix-code:lock:v2:";
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60;
const SIBLING_EVENT_WINDOW_MS = 15 * 1000;

function deliveryFingerprint(record) {
  const value = String(record?.deliveryFingerprint || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}

export function latestNetflixSiblingCluster(records) {
  const sorted = [...(Array.isArray(records) ? records : [])]
    .filter((entry) => Number.isFinite(Number(entry?.receivedAt)))
    .sort((left, right) => Number(right.receivedAt) - Number(left.receivedAt));
  const newestReceivedAt = Number(sorted[0]?.receivedAt || 0);
  if (!newestReceivedAt) return [];
  const newestFingerprint = deliveryFingerprint(sorted[0]?.record);
  return sorted.filter((entry, index) => index === 0 || (
    newestFingerprint
    && deliveryFingerprint(entry?.record) === newestFingerprint
    && newestReceivedAt - Number(entry.receivedAt) <= SIBLING_EVENT_WINDOW_MS
  ));
}

// A customer mailbox often delivers the same Netflix email twice: an automatic
// forward plus an inbox rule. The copies can arrive minutes apart and one may
// be flattened beyond recognition, so any accepted record close enough to the
// newest delivery outranks a rejected copy.
export const NETFLIX_DUAL_DELIVERY_WINDOW_MS = 120 * 1000;

export function latestAcceptedNetflixRecords(records, windowMs = NETFLIX_DUAL_DELIVERY_WINDOW_MS) {
  const sorted = [...(Array.isArray(records) ? records : [])]
    .filter((entry) => Number.isFinite(Number(entry?.receivedAt)))
    .sort((left, right) => Number(right.receivedAt) - Number(left.receivedAt));
  const newestReceivedAt = Number(sorted[0]?.receivedAt || 0);
  if (!newestReceivedAt) return [];
  const newest = sorted[0];
  const newestFingerprint = deliveryFingerprint(newest?.record);
  // The newest accepted message is authoritative by itself, even when an old
  // legacy record has no delivery fingerprint. Older accepted copies may only
  // participate when they prove they belong to exactly the same Netflix SRC
  // delivery as the newest message.
  if (newest.record?.accepted) {
    return sorted.filter((entry, index) => entry.record?.accepted && (
      index === 0
      || (newestFingerprint
        && deliveryFingerprint(entry?.record) === newestFingerprint
        && newestReceivedAt - Number(entry.receivedAt) <= windowMs)
    ));
  }
  if (!newestFingerprint) return [];
  return sorted.filter((entry) => entry.record?.accepted
    && deliveryFingerprint(entry?.record) === newestFingerprint
    && newestReceivedAt - Number(entry.receivedAt) <= windowMs);
}

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

function normalizeNetflixAccountEmails(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))));
}

export function protectNetflixMailAccountEmails(values) {
  const emails = normalizeNetflixAccountEmails(values);
  return emails.length ? encryptPayload(JSON.stringify(emails)) : null;
}

export function protectNetflixMailResult(value) {
  return value ? encryptPayload(value) : null;
}

export function revealNetflixMailAccountEmails(record) {
  const raw = decryptPayload(record?.accountEmailPayload);
  if (!raw) return [];
  try { return normalizeNetflixAccountEmails(JSON.parse(raw)); } catch { return []; }
}

export function revealNetflixMailResult(record) {
  if (!record?.accepted) return "";
  const value = decryptPayload(record?.payload);
  if (record.kind === "code") return /^\d{4}$/.test(value) ? value : "";
  if (record.kind !== "link" && record.kind !== "household") return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "netflix.com" || host.endsWith(".netflix.com"))) return "";
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (record.kind === "link") {
      return path === "/account/travel/verify" && (url.searchParams.has("token") || url.searchParams.has("nftoken"))
        ? url.toString()
        : "";
    }
    return path === "/account/update-primary-location" && url.searchParams.has("nftoken")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
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

function validEventIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((value) => clean(value, 80).toUpperCase())
    .filter((value) => /^NM[A-F0-9]{24}$/.test(value))));
}

function validAccessIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((value) => clean(value, 80).toUpperCase())
    .filter((value) => /^NA[A-F0-9]{16}$/.test(value))));
}

function accessDedupeId(record) {
  return createHash("sha256")
    .update(`${record?.orderId || ""}|${record?.eventId || ""}|${record?.outcome || ""}`)
    .digest("hex");
}

function pipelineSucceeded(value, expected) {
  const rows = pipelineRows(value);
  return rows.length === expected && rows.every((entry) => !entry?.error);
}

export async function storeNetflixMailEvent(parsed, { messageId = "", digest = "" } = {}) {
  const eventId = eventIdFor(messageId, digest);
  const accountEmails = normalizeNetflixAccountEmails(parsed?.accountEmails);
  const accountHashes = Array.from(new Set(accountEmails.map(netflixAccountHash).filter(Boolean)));
  const encrypted = parsed?.accepted ? protectNetflixMailResult(parsed?.value) : null;
  const accountEmailPayload = protectNetflixMailAccountEmails(accountEmails);
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
    deliveryFingerprint: deliveryFingerprint(parsed),
    accountHashes,
    accountHints: accountEmails.map(maskNetflixEmail).filter(Boolean),
    accountEmailPayload,
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

export async function findLatestNetflixMailState(email, { since = 0, excludeEventIds = [] } = {}) {
  const hash = netflixAccountHash(email);
  // The customer normally returns after Netflix has already sent the message.
  // Keep a short lookback so a valid code received just before authorization is
  // still available, while the expiry check below rejects stale messages.
  const startedAt = Number(since || 0);
  const minScore = Math.max(Date.now() - 20 * 60 * 1000, startedAt - 5 * 60 * 1000);
  const rejectedMinScore = Math.max(Date.now() - 20 * 60 * 1000, startedAt);
  const ids = await redisCmd(["ZREVRANGEBYSCORE", accountIndexKey(hash), "+inf", String(minScore), "LIMIT", "0", "20"]);
  const records = [];
  for (const eventId of (Array.isArray(ids) ? ids : [])) {
    const record = parseJson(await redisCmd(["GET", eventKey(eventId)]));
    if (!record?.accountHashes?.includes(hash)) continue;
    const receivedAt = new Date(record.receivedAt || 0).getTime();
    const expiresAt = new Date(record.expiresAt || 0).getTime();
    if (!receivedAt || receivedAt < minScore || !expiresAt || expiresAt <= Date.now()) continue;
    records.push({ record, receivedAt });
  }
  const siblingCluster = latestNetflixSiblingCluster(records);
  for (const { record } of latestAcceptedNetflixRecords(records)) {
    const value = decryptPayload(record.payload);
    if (!value) continue;
    return {
      state: "result",
      result: {
        eventId: record.eventId,
        kind: record.kind,
        value,
        language: record.language,
        receivedAt: record.receivedAt,
        receivedAtBeijing: record.receivedAtBeijing,
        expiresAt: record.expiresAt,
      },
    };
  }
  // Rejected records the customer has already been shown are skipped so a new
  // retrieve attempt waits for the next email instead of replaying the error.
  // All sibling rejected ids are reported so one acknowledgement covers every
  // copy of a dual-delivered email.
  const seenEventIds = new Set(validEventIds(excludeEventIds));
  const rejectedEntries = siblingCluster.filter(({ record, receivedAt }) => !record.accepted
    && receivedAt >= rejectedMinScore);
  const rejected = rejectedEntries.find(({ record }) => !seenEventIds.has(record.eventId))?.record;
  return rejected ? {
    state: "rejected",
    eventId: rejected.eventId,
    eventIds: rejectedEntries.map(({ record }) => record.eventId),
    reason: rejected.reason || "supported_content_not_found",
    receivedAt: rejected.receivedAt,
    receivedAtBeijing: rejected.receivedAtBeijing,
  } : { state: "pending" };
}

export async function findLatestNetflixResult(email, options = {}) {
  const state = await findLatestNetflixMailState(email, options);
  return state.state === "result" ? state.result : null;
}

export async function recordNetflixCodeAccess(entry) {
  const outcome = clean(entry?.outcome, 80);
  if (!["code_returned", "travel_link_returned", "household_link_returned"].includes(outcome)) return true;
  const orderId = clean(entry?.orderId, 80).toUpperCase();
  const eventId = clean(entry?.eventId, 80);
  if (!orderId || !eventId) return false;

  const dedupeId = accessDedupeId({ orderId, eventId, outcome });
  const first = await redisCmd([
    "SET",
    ACCESS_DEDUPE_PREFIX + dedupeId,
    "1",
    "NX",
    "EX",
    String(ACCESS_TTL_SECONDS),
  ]);
  if (first !== "OK") return true;

  const now = new Date();
  const id = "NA" + randomBytes(8).toString("hex").toUpperCase();
  const record = {
    id,
    orderId,
    userEmail: clean(entry?.userEmail, 200).toLowerCase(),
    accountEmail: clean(entry?.accountEmail, 200).toLowerCase(),
    outcome,
    eventId,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  const score = now.getTime();
  const commands = [
    ["SET", ACCESS_PREFIX + id, JSON.stringify(record), "EX", String(ACCESS_TTL_SECONDS)],
    ["ZADD", ACCESS_INDEX, String(score), id],
  ];
  const rows = pipelineRows(await redisPipeline(commands));
  const ok = rows.length === commands.length && rows.every((entryRow) => !entryRow?.error);
  if (!ok) await redisCmd(["DEL", ACCESS_DEDUPE_PREFIX + dedupeId]);
  await redisCmd(["ZREMRANGEBYSCORE", ACCESS_INDEX, "-inf", String(Date.now() - ACCESS_TTL_SECONDS * 1000)]);
  return ok;
}

async function recordsFromIndex(indexKey, offset, limit, prefix) {
  const ids = await redisCmd(["ZREVRANGE", indexKey, String(offset), String(offset + limit - 1)]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = pipelineRows(await redisPipeline(ids.map((id) => ["GET", prefix + id])));
  return rows.map((entry) => parseJson(pipelineValue(entry))).filter(Boolean);
}

async function allRecordsFromIndex(indexKey, prefix, pageSize = 200) {
  const safePageSize = Math.max(20, Math.min(500, Number(pageSize || 200)));
  const records = [];
  let offset = 0;
  // Fetch every retained index member in bounded pipelines.  Search callers
  // filter only after this completes, so matches older than the dashboard's
  // normal 100/200-row preview are not silently lost.
  while (true) {
    const ids = await redisCmd([
      "ZREVRANGE",
      indexKey,
      String(offset),
      String(offset + safePageSize - 1),
    ]);
    if (!Array.isArray(ids) || !ids.length) break;
    const rows = pipelineRows(await redisPipeline(ids.map((id) => ["GET", prefix + id])));
    records.push(...rows.map((entry) => parseJson(pipelineValue(entry))).filter(Boolean));
    offset += ids.length;
    if (ids.length < safePageSize) break;
  }
  return records;
}

// Latest mail arrival per account hash, straight from the account indexes.
// Lets the admin panel distinguish "mail never arrived" (forwarding broken)
// from "mail arrived but was not parsed" (visible as a mail event).
export async function latestNetflixMailReceipts(hashes) {
  const uniqueHashes = Array.from(new Set((Array.isArray(hashes) ? hashes : []).filter(Boolean)));
  if (!uniqueHashes.length) return {};
  const rows = pipelineRows(await redisPipeline(uniqueHashes.map((hash) => ["ZREVRANGE", accountIndexKey(hash), "0", "0", "WITHSCORES"])));
  const receipts = {};
  uniqueHashes.forEach((hash, index) => {
    const value = pipelineValue(rows[index]);
    const score = Array.isArray(value) ? Number(value[1] || 0) : 0;
    if (Number.isFinite(score) && score > 0) receipts[hash] = score;
  });
  return receipts;
}

export async function listNetflixMailEvents({ offset = 0, limit = 60 } = {}) {
  return recordsFromIndex(EVENT_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(100, Number(limit || 60))), EVENT_PREFIX);
}

export async function listNetflixCodeAccess({ offset = 0, limit = 100 } = {}) {
  return recordsFromIndex(ACCESS_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(200, Number(limit || 100))), ACCESS_PREFIX);
}

export async function listAllNetflixMailEvents() {
  return allRecordsFromIndex(EVENT_INDEX, EVENT_PREFIX);
}

export async function listAllNetflixCodeAccess() {
  return allRecordsFromIndex(ACCESS_INDEX, ACCESS_PREFIX);
}

export async function deleteNetflixMailEvents(values) {
  const eventIds = validEventIds(values).slice(0, 40);
  if (!eventIds.length) return { ok: false, deleted: 0 };
  const rows = pipelineRows(await redisPipeline(eventIds.map((eventId) => ["GET", eventKey(eventId)])));
  const commands = [];
  eventIds.forEach((eventId, index) => {
    const record = parseJson(pipelineValue(rows[index]));
    commands.push(["ZREM", EVENT_INDEX, eventId], ["DEL", eventKey(eventId)]);
    for (const hash of (record?.accountHashes || [])) commands.push(["ZREM", accountIndexKey(hash), eventId]);
  });
  const ok = pipelineSucceeded(await redisPipeline(commands), commands.length);
  return { ok, deleted: ok ? eventIds.length : 0 };
}

export async function deleteNetflixCodeAccessRecords(values) {
  const accessIds = validAccessIds(values).slice(0, 40);
  if (!accessIds.length) return { ok: false, deleted: 0 };
  const rows = pipelineRows(await redisPipeline(accessIds.map((id) => ["GET", ACCESS_PREFIX + id])));
  const commands = [];
  accessIds.forEach((id, index) => {
    const record = parseJson(pipelineValue(rows[index]));
    commands.push(["ZREM", ACCESS_INDEX, id], ["DEL", ACCESS_PREFIX + id]);
    if (record?.orderId && record?.eventId && record?.outcome) {
      commands.push(["DEL", ACCESS_DEDUPE_PREFIX + accessDedupeId(record)]);
    }
  });
  const ok = pipelineSucceeded(await redisPipeline(commands), commands.length);
  return { ok, deleted: ok ? accessIds.length : 0 };
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
