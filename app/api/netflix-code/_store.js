import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline } from "../_utils.js";

const EVENT_PREFIX = "liumeiti:netflix-mail:event:";
const EVENT_INDEX = "liumeiti:netflix-mail:received";
const EVENT_SEQUENCE_KEY = "liumeiti:netflix-mail:arrival-sequence:v1";
const EVENT_SEQUENCE_EVENT_PREFIX = "liumeiti:netflix-mail:event-sequence:v1:";
const ACCOUNT_INDEX_PREFIX = "liumeiti:netflix-mail:account:";
const ACCESS_PREFIX = "liumeiti:netflix-code:access:";
// Only successful deliveries belong in the operational history. The former
// index also contained authorization and polling noise, so keep a clean index
// instead of migrating those rows into the new view.
const ACCESS_INDEX = "liumeiti:netflix-code:access-success-index:v1";
const ACCESS_DEDUPE_PREFIX = "liumeiti:netflix-code:access-success-dedupe:";
// A successful result may be viewed more than once while it is still the
// newest mail. Once a newer, unparsed mail arrives, however, that previously
// returned event must never be guessed to be the newer mail's sibling merely
// because one copy lost its SRC footer.
const RETURNED_EVENT_PREFIX = "liumeiti:netflix-code:returned-event:v1:";
const RETURNED_EVENT_GLOBAL_PREFIX = "liumeiti:netflix-code:returned-event-global:v1:";
// v2 drops locks created by the former per-poll counter. Automatic polling
// must never lock a customer who only clicked the retrieve button once.
const LOCK_PREFIX = "liumeiti:netflix-code:lock:v2:";
// Mail records are the operational log staff use to explain a past retrieval,
// so they must outlive a quiet week. Seven days silently emptied the panel
// whenever no customer requested a code, which reads as data loss. The stored
// payload is encrypted at rest and its code stops working after 15 minutes, so
// a 30-day window costs nothing in exposure while keeping the log usable.
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60;
const SIBLING_EVENT_WINDOW_MS = 15 * 1000;
const MAX_REQUEST_FINGERPRINTS = 32;
const MAX_PRIMARY_REQUEST_FINGERPRINTS = 4;
export const NETFLIX_DUAL_DELIVERY_WINDOW_MS = 120 * 1000;

function deliveryFingerprint(record) {
  const value = String(record?.deliveryFingerprint || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}

function requestFingerprints(record) {
  return Array.from(new Set((Array.isArray(record?.requestFingerprints) ? record.requestFingerprints : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/.test(value))))
    .slice(0, MAX_REQUEST_FINGERPRINTS);
}

function requestPrimaryFingerprints(record) {
  return Array.from(new Set((Array.isArray(record?.requestPrimaryFingerprints) ? record.requestPrimaryFingerprints : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/.test(value))))
    .slice(0, MAX_PRIMARY_REQUEST_FINGERPRINTS);
}

function sameNetflixRequest(left, right, newerRecord = null, allowCurrentSrc = false) {
  const leftDelivery = deliveryFingerprint(left);
  const rightDelivery = deliveryFingerprint(right);
  // Two present, unequal Netflix SRC UUIDs conclusively identify different
  // requests and must override weaker content similarities (including the
  // rare case where Netflix generates the same four digits twice).
  if (leftDelivery && rightDelivery && leftDelivery !== rightDelivery) return false;
  // Conflicting Exchange current-identity headers are not proof of either
  // request. The event may still return its own parsed result, but it cannot
  // authorize fallback to another event's code.
  if (left?.requestIdentityAmbiguous === true || right?.requestIdentityAmbiguous === true) return false;
  const leftEvidence = requestFingerprints(left);
  const rightEvidence = requestFingerprints(right);
  const leftPrimary = requestPrimaryFingerprints(left);
  const rightPrimary = requestPrimaryFingerprints(right);
  if (leftPrimary.length && rightPrimary.length) {
    const rightPrimarySet = new Set(rightPrimary);
    if (!leftPrimary.some((value) => rightPrimarySet.has(value))) return false;
  }
  if (allowCurrentSrc && leftDelivery && leftDelivery === rightDelivery
    && newerRecord?.deliveryFingerprintFromCurrent === true
    && deliveryFingerprint(newerRecord) === leftDelivery) return true;
  // New records carry one HMAC-protected current identity. When only one side
  // has the new field, compare that identity with the legacy record's full
  // evidence set; this keeps pre-deployment mail readable without letting an
  // auxiliary References thread member override two explicit identities.
  const leftCandidates = leftPrimary.length ? leftPrimary : leftEvidence;
  const rightCandidates = rightPrimary.length ? rightPrimary : rightEvidence;
  const rightSet = new Set(rightCandidates);
  return leftCandidates.some((value) => rightSet.has(value));
}

function compareArrival(left, right) {
  const receivedDifference = Number(right?.receivedAt || 0) - Number(left?.receivedAt || 0);
  if (receivedDifference) return receivedDifference;
  const leftSequence = Number(left?.record?.arrivalSequence || 0);
  const rightSequence = Number(right?.record?.arrivalSequence || 0);
  if (Number.isSafeInteger(leftSequence) && leftSequence > 0
    && Number.isSafeInteger(rightSequence) && rightSequence > 0
    && leftSequence !== rightSequence) {
    return rightSequence - leftSequence;
  }
  return 0;
}

function sameNetflixRequestEntries(left, right) {
  const leftReceivedAt = Number(left?.receivedAt || 0);
  const rightReceivedAt = Number(right?.receivedAt || 0);
  let newer = leftReceivedAt > rightReceivedAt ? left : rightReceivedAt > leftReceivedAt ? right : null;
  if (!newer) {
    const leftSequence = Number(left?.record?.arrivalSequence || 0);
    const rightSequence = Number(right?.record?.arrivalSequence || 0);
    if (Number.isSafeInteger(leftSequence) && leftSequence > 0
      && Number.isSafeInteger(rightSequence) && rightSequence > 0
      && leftSequence !== rightSequence) {
      newer = leftSequence > rightSequence ? left : right;
    }
  }
  const receivedGap = Math.abs(leftReceivedAt - rightReceivedAt);
  const allowCurrentSrc = Boolean(newer)
    && Number.isFinite(receivedGap)
    && receivedGap <= NETFLIX_DUAL_DELIVERY_WINDOW_MS;
  return sameNetflixRequest(left?.record, right?.record, newer?.record || null, allowCurrentSrc);
}

function recordRequestSentAt(entry) {
  if (entry?.record?.requestSentAtPortable !== true) return 0;
  const received = Number(entry?.receivedAt || 0);
  const candidate = new Date(entry?.record?.requestSentAt || 0).getTime();
  if (!Number.isFinite(received) || received <= 0
    || !Number.isFinite(candidate) || candidate <= 0
    || candidate < received - 7 * 24 * 60 * 60 * 1000
    || candidate > received + 10 * 60 * 1000) return 0;
  return candidate;
}

function clusterSequenceOrder(left, right) {
  const leftSequence = Number(left?.firstArrivalSequence || 0);
  const rightSequence = Number(right?.firstArrivalSequence || 0);
  const comparable = Number.isSafeInteger(leftSequence) && leftSequence > 0
    && Number.isSafeInteger(rightSequence) && rightSequence > 0
    && leftSequence !== rightSequence;
  return {
    comparable,
    difference: comparable ? rightSequence - leftSequence : 0,
  };
}

function clusterDeliveryFingerprints(entries) {
  return new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => deliveryFingerprint(entry?.record))
    .filter(Boolean));
}

function clusterPrimaryFingerprints(entries) {
  return new Set((Array.isArray(entries) ? entries : [])
    .flatMap((entry) => requestPrimaryFingerprints(entry?.record)));
}

function rankedNetflixRequestClusters(records) {
  const pool = [...(Array.isArray(records) ? records : [])]
    .filter((entry) => Number.isFinite(Number(entry?.receivedAt)) && Number(entry.receivedAt) > 0);
  const clusters = [];
  for (const entry of pool) {
    const matching = [];
    clusters.forEach((cluster, index) => {
      if (cluster.some((candidate) => sameNetflixRequestEntries(entry, candidate))) matching.push(index);
    });
    if (!matching.length) {
      clusters.push([entry]);
      continue;
    }
    // Pairwise checks are not enough when a fingerprint-less wrapper bridges
    // two evidence identities. Never create a transitive cluster containing
    // two different SRC UUIDs; that would let a newer failed request replay an
    // accepted code from an older request through the wrapper in the middle.
    const mergedFingerprints = clusterDeliveryFingerprints([
      entry,
      ...matching.flatMap((index) => clusters[index]),
    ]);
    const mergedPrimaryFingerprints = clusterPrimaryFingerprints([
      entry,
      ...matching.flatMap((index) => clusters[index]),
    ]);
    const mergeEntries = [entry, ...matching.flatMap((index) => clusters[index])];
    const sameSrcWithoutDirectProof = mergeEntries.some((left, leftIndex) => {
      const fingerprint = deliveryFingerprint(left?.record);
      if (!fingerprint) return false;
      return mergeEntries.slice(leftIndex + 1).some((right) => (
        deliveryFingerprint(right?.record) === fingerprint
        && !sameNetflixRequestEntries(left, right)
      ));
    });
    if (mergedFingerprints.size > 1 || mergedPrimaryFingerprints.size > 1 || sameSrcWithoutDirectProof) {
      clusters.push([entry]);
      continue;
    }
    const merged = [entry];
    for (let index = matching.length - 1; index >= 0; index -= 1) {
      merged.push(...clusters.splice(matching[index], 1)[0]);
    }
    clusters.push(merged);
  }

  const ranked = clusters.map((entries) => {
    const orderedEntries = [...entries].sort(compareArrival);
    const sourceTimes = entries.map(recordRequestSentAt).filter((value) => value > 0);
    const firstReceivedAt = Math.min(...entries.map((entry) => Number(entry.receivedAt)));
    const firstEntries = entries.filter((entry) => Number(entry.receivedAt) === firstReceivedAt);
    const firstSequences = firstEntries.map((entry) => Number(entry?.record?.arrivalSequence || 0));
    const firstArrivalSequence = firstSequences.length
      && firstSequences.every((value) => Number.isSafeInteger(value) && value > 0)
      ? Math.min(...firstSequences)
      : 0;
    return {
      entries: orderedEntries,
      // All copies normally carry the same original Date. If a wrapper
      // rewrites one, use the earliest value; a delayed duplicate can then
      // never advance its request cluster.
      requestTime: sourceTimes.length ? Math.min(...sourceTimes) : firstReceivedAt,
      hasTrustedRequestTime: sourceTimes.length > 0,
      firstReceivedAt,
      firstArrivalSequence,
    };
  }).sort((left, right) => {
    const sequenceDifference = clusterSequenceOrder(left, right).difference;
    return right.requestTime - left.requestTime
      || right.firstReceivedAt - left.firstReceivedAt
      || sequenceDifference
      || compareArrival(left.entries[0], right.entries[0]);
  });
  return ranked;
}

function sortNewestNetflixRequests(records) {
  return rankedNetflixRequestClusters(records).flatMap((cluster) => cluster.entries);
}

export function latestNetflixSiblingCluster(records) {
  const sorted = sortNewestNetflixRequests(records);
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
export function latestAcceptedNetflixRecords(
  records,
  windowMs = NETFLIX_DUAL_DELIVERY_WINDOW_MS,
  { excludeFallbackEventIds = [] } = {},
) {
  const rankedClusters = rankedNetflixRequestClusters(records);
  const firstCluster = rankedClusters[0];
  // Legacy events can lack the distributed sequence. If two distinct request
  // clusters then tie on every trustworthy ordering signal, Redis member order
  // cannot prove which code is newest. Fail closed instead of guessing.
  if (firstCluster && rankedClusters.slice(1).some((cluster) => (
    firstCluster.requestTime === cluster.requestTime
    && firstCluster.firstReceivedAt === cluster.firstReceivedAt
    && !clusterSequenceOrder(firstCluster, cluster).comparable
  ))) {
    return [];
  }
  // Never compare a trusted original send time with a nearby cluster whose
  // request time is unknown as though both values had equal meaning. The
  // latter may be a delayed old wrapper that merely arrived later. Outside the
  // duplicate-delivery window the existing product policy treats it as a new
  // request; inside the window the only safe result is no code.
  if (firstCluster && rankedClusters.slice(1).some((cluster) => (
    (!firstCluster.hasTrustedRequestTime
      && cluster.hasTrustedRequestTime
      && firstCluster.firstReceivedAt >= cluster.firstReceivedAt
      && firstCluster.firstReceivedAt - cluster.firstReceivedAt <= windowMs)
    || (firstCluster.hasTrustedRequestTime
      && cluster.hasTrustedRequestTime
      && firstCluster.requestTime === cluster.requestTime)
  ))) {
    return [];
  }
  const sorted = rankedClusters.flatMap((cluster) => cluster.entries);
  const newestReceivedAt = Number(sorted[0]?.receivedAt || 0);
  if (!newestReceivedAt) return [];
  const newest = sorted[0];
  // A successfully parsed newest delivery is always authoritative. Returning
  // only that record prevents an older code from being used when the customer
  // requested two different Netflix messages close together.
  if (newest.record?.accepted === true) {
    return [newest];
  }

  // An older accepted result may outrank a newer rejected copy only when both
  // prove they came from the same original Netflix request. Unequal SRC UUIDs
  // conclusively reject a match, while HMAC-protected original Message-ID or
  const excludedFallbacks = new Set(validEventIds(excludeFallbackEventIds));
  // Evidence overlap is deliberately non-transitive for fallback. References
  // is a thread-level header and a newly forwarded request can quote both an
  // older identity and its SRC footer. A bridge record must therefore never
  // turn indirect overlap into permission to replay an older accepted code.
  return (rankedClusters[0]?.entries || []).filter((entry) => {
    const receivedGap = Math.abs(newestReceivedAt - Number(entry.receivedAt));
    if (entry.record?.accepted !== true || receivedGap > windowMs) return false;
    if (excludedFallbacks.has(String(entry.record?.eventId || "").toUpperCase())) return false;
    return sameNetflixRequestEntries(newest, entry);
  }).slice(0, 1);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalAccountHashes(value) {
  return Array.isArray(value) && value.length === new Set(value).size
    && value.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}

function validMailRecord(record, expectedId = "", expectedHash = "") {
  if (!plain(record) || !/^NM[A-F0-9]{24}$/.test(record.eventId)
      || (expectedId && record.eventId !== expectedId) || typeof record.accepted !== "boolean"
      || !canonicalAccountHashes(record.accountHashes) || (expectedHash && !record.accountHashes.includes(expectedHash))
      || typeof record.receivedAt !== "string" || typeof record.expiresAt !== "string"
      || !Number.isFinite(new Date(record.receivedAt).getTime()) || !Number.isFinite(new Date(record.expiresAt).getTime())) return false;
  if (record.arrivalSequence !== undefined && (!Number.isSafeInteger(Number(record.arrivalSequence)) || Number(record.arrivalSequence) <= 0)) return false;
  if (record.accepted === true) return ["code", "link", "household"].includes(record.kind)
    && plain(record.payload) && [record.payload.iv, record.payload.tag, record.payload.data].every((value) => typeof value === "string" && value.length > 0);
  return (record.kind === "" || record.kind === undefined) && (record.payload == null);
}

function validAccessRecord(record, expectedId = "") {
  return plain(record) && /^NA[A-F0-9]{16}$/.test(record.id) && (!expectedId || record.id === expectedId)
    && clean(record.orderId, 80).toUpperCase() === record.orderId && validEventIds(record.eventId)[0] === record.eventId
    && ["code_returned", "travel_link_returned", "household_link_returned"].includes(record.outcome)
    && typeof record.createdAt === "string" && Number.isFinite(new Date(record.createdAt).getTime());
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

function protectedNetflixRequestFingerprints(parsed) {
  const fingerprints = new Set(requestFingerprints(parsed));
  const key = encryptionKey();
  if (!key) return Array.from(fingerprints).slice(0, MAX_REQUEST_FINGERPRINTS);
  for (const value of (Array.isArray(parsed?.requestEvidence) ? parsed.requestEvidence : [])) {
    const evidence = String(value || "").trim();
    if (!evidence || evidence.length > 2000) continue;
    fingerprints.add(createHmac("sha256", key)
      .update(`netflix-request-evidence-v1\0${evidence}`)
      .digest("hex"));
  }
  return Array.from(fingerprints).slice(0, MAX_REQUEST_FINGERPRINTS);
}

function protectedNetflixPrimaryRequestFingerprints(parsed) {
  const key = encryptionKey();
  if (!key) return requestPrimaryFingerprints(parsed);
  const fingerprints = new Set();
  for (const value of (Array.isArray(parsed?.requestPrimaryEvidence) ? parsed.requestPrimaryEvidence : [])) {
    const evidence = String(value || "").trim();
    if (!evidence || evidence.length > 2000) continue;
    fingerprints.add(createHmac("sha256", key)
      .update(`netflix-request-evidence-v1\0${evidence}`)
      .digest("hex"));
  }
  return Array.from(fingerprints).slice(0, MAX_PRIMARY_REQUEST_FINGERPRINTS);
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

async function arrivalSequenceFor(eventId) {
  const candidate = Number(await redisCmd(["INCR", EVENT_SEQUENCE_KEY]) || 0);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) return 0;
  const key = EVENT_SEQUENCE_EVENT_PREFIX + clean(eventId, 80).toUpperCase();
  const reserved = await redisCmd([
    "SET",
    key,
    String(candidate),
    "NX",
    "EX",
    String(EVENT_TTL_SECONDS),
  ]);
  if (reserved === "OK") return candidate;
  const existing = Number(await redisCmd(["GET", key]) || 0);
  return Number.isSafeInteger(existing) && existing > 0 ? existing : 0;
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

function returnedEventKey(orderId, eventId) {
  const normalizedOrderId = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  const normalizedEventId = validEventIds(eventId)[0] || "";
  if (!normalizedOrderId || !normalizedEventId) return "";
  return RETURNED_EVENT_PREFIX + createHash("sha256")
    .update(`${normalizedOrderId}|${normalizedEventId}`)
    .digest("hex");
}

function returnedEventGlobalKey(eventId) {
  const normalizedEventId = validEventIds(eventId)[0] || "";
  return normalizedEventId
    ? RETURNED_EVENT_GLOBAL_PREFIX + createHash("sha256").update(normalizedEventId).digest("hex")
    : "";
}

function returnedAccessDedupeKey(orderId, record) {
  const outcome = record?.kind === "code"
    ? "code_returned"
    : record?.kind === "household"
      ? "household_link_returned"
      : record?.kind === "link"
        ? "travel_link_returned"
        : "";
  return outcome ? ACCESS_DEDUPE_PREFIX + accessDedupeId({
    orderId: clean(orderId, 80).replace(/\s+/g, "").toUpperCase(),
    eventId: clean(record?.eventId, 80),
    outcome,
  }) : "";
}

function returnedAccessDedupeValue(orderId, record) {
  const key = returnedAccessDedupeKey(orderId, record);
  const digest = key.slice(ACCESS_DEDUPE_PREFIX.length);
  return digest ? `NA${digest.slice(0, 16).toUpperCase()}` : "";
}

async function returnedNetflixEventIds(orderId, records) {
  const candidates = (Array.isArray(records) ? records : [])
    .map(({ record }) => record)
    .filter((record) => record?.accepted === true
      && returnedEventGlobalKey(record.eventId)
      && returnedEventKey(orderId, record.eventId)
      && returnedAccessDedupeKey(orderId, record));
  if (!candidates.length) return { ok: true, eventIds: [] };
  // The access dedupe key predates the explicit safety marker, so checking
  // both also protects results returned before this migration was deployed.
  const commands = candidates.flatMap((record) => [
    ["GET", returnedEventGlobalKey(record.eventId)],
    ["GET", returnedEventKey(orderId, record.eventId)],
    ["GET", returnedAccessDedupeKey(orderId, record)],
  ]);
  const response = await redisPipeline(commands);
  // A failed evidence lookup is a store outage, not proof that a candidate was
  // never returned. Propagate it so the API reports 503 instead of guessing.
  if (!pipelineSucceeded(response, commands.length)) {
    return { ok: false, error: "storage_unavailable" };
  }
  const rows = pipelineRows(response);
  return { ok: true, eventIds: candidates
    .filter((record, index) => pipelineValue(rows[index * 3]) === "1"
      || pipelineValue(rows[index * 3 + 1]) === "1"
      || ["1", returnedAccessDedupeValue(orderId, record)].includes(pipelineValue(rows[index * 3 + 2])))
    .map((record) => record.eventId) };
}

function pipelineSucceeded(value, expected) {
  const rows = pipelineRows(value);
  return rows.length === expected && rows.every((entry) => !entry?.error);
}

async function strictRedisRead(commands) {
  const requested = Array.isArray(commands) ? commands : [];
  const response = await redisPipeline([...requested, ["PING"]]);
  if (!pipelineSucceeded(response, requested.length + 1)) return null;
  const rows = pipelineRows(response);
  if (String(pipelineValue(rows[requested.length]) || "").toUpperCase() !== "PONG") return null;
  return rows.slice(0, requested.length);
}

export async function storeNetflixMailEvent(parsed, { messageId = "", digest = "" } = {}) {
  const eventId = eventIdFor(messageId, digest);
  const accountEmails = normalizeNetflixAccountEmails(parsed?.accountEmails);
  const accountHashes = Array.from(new Set(accountEmails.map(netflixAccountHash).filter(Boolean)));
  const encrypted = parsed?.accepted ? protectNetflixMailResult(parsed?.value) : null;
  const accountEmailPayload = protectNetflixMailAccountEmails(accountEmails);
  if (parsed?.accepted && !encrypted) return { ok: false, error: "encryption_not_configured" };
  // Cloudflare timestamps have millisecond precision, so two distinct messages
  // can legitimately share receivedAt. Redis provides the distributed arrival
  // tiebreaker; without it we must reject storage and let the webhook retry
  // instead of guessing which distinct code is newest from its event hash.
  const arrivalSequence = await arrivalSequenceFor(eventId);
  if (!arrivalSequence) {
    return { ok: false, error: "storage_unavailable" };
  }
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
    requestSentAt: parsed?.requestSentAt || "",
    requestSentAtPortable: parsed?.requestSentAtPortable === true,
    expiresAt: parsed?.expiresAt || "",
    sender: maskNetflixEmail(parsed?.sender),
    subject: clean(parsed?.subject, 240),
    deliveryFingerprint: deliveryFingerprint(parsed),
    deliveryFingerprintFromCurrent: parsed?.deliveryFingerprintFromCurrent === true,
    requestIdentityAmbiguous: parsed?.requestIdentityAmbiguous === true,
    requestPrimaryFingerprints: protectedNetflixPrimaryRequestFingerprints(parsed),
    requestFingerprints: protectedNetflixRequestFingerprints(parsed),
    arrivalSequence,
    accountHashes,
    accountHints: accountEmails.map(maskNetflixEmail).filter(Boolean),
    accountEmailPayload,
    payload: encrypted,
    messageIdHash: createHash("sha256").update(String(messageId || digest || eventId)).digest("hex"),
    // Bind the durable record to the raw webhook body. The ingest replay
    // marker uses this value to distinguish a real committed duplicate from
    // a marker whose event write was lost.
    ingestDigestHash: createHash("sha256").update(String(digest || "")).digest("hex"),
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

export async function verifyNetflixMailEvent(eventId, digest) {
  const normalizedEventId = validEventIds(eventId)[0] || "";
  if (!normalizedEventId) return { ok: false, error: "invalid_event_id" };
  const response = await redisPipeline([
    ["GET", eventKey(normalizedEventId)],
    ["PING"],
  ]);
  if (!pipelineSucceeded(response, 2)) return { ok: false, error: "storage_unavailable" };
  const rows = pipelineRows(response);
  if (String(pipelineValue(rows[1]) || "").toUpperCase() !== "PONG") {
    return { ok: false, error: "storage_unavailable" };
  }
  const raw = pipelineValue(rows[0]);
  if (raw == null) return { ok: true, exists: false, matches: false };
  const record = parseJson(raw);
  if (!validMailRecord(record, normalizedEventId)) {
    return { ok: false, error: "event_record_invalid" };
  }
  const expectedDigestHash = createHash("sha256").update(String(digest || "")).digest("hex");
  return {
    ok: true,
    exists: true,
    matches: record.ingestDigestHash === expectedDigestHash,
    record,
  };
}

export async function findLatestNetflixMailState(email, {
  since = 0,
  excludeEventIds = [],
  orderId = "",
} = {}) {
  const hash = netflixAccountHash(email);
  // The customer normally returns after Netflix has already sent the message.
  // Keep a short lookback so a valid code received just before authorization is
  // still available, while the expiry check below rejects stale messages.
  const startedAt = Number(since || 0);
  const minScore = Math.max(Date.now() - 20 * 60 * 1000, startedAt - 5 * 60 * 1000);
  const rejectedMinScore = Math.max(Date.now() - 20 * 60 * 1000, startedAt);
  const indexRows = await strictRedisRead([
    // Selection needs the complete active window: truncating before request
    // clustering can discard the first copy of a delayed duplicate and make an
    // old code appear newest. The time range bounds this to still-live mail.
    ["ZREVRANGEBYSCORE", accountIndexKey(hash), "+inf", String(minScore)],
  ]);
  if (!indexRows) return { state: "error", error: "storage_unavailable" };
  const indexedIds = pipelineValue(indexRows[0]);
  if (!Array.isArray(indexedIds)) return { state: "error", error: "storage_unavailable" };
  const ids = validEventIds(indexedIds);
  if (ids.length !== indexedIds.length) return { state: "error", error: "storage_unavailable" };
  const records = [];
  const eventRows = ids.length
    ? await strictRedisRead(ids.map((eventId) => ["GET", eventKey(eventId)]))
    : [];
  if (eventRows == null) return { state: "error", error: "storage_unavailable" };
  for (let index = 0; index < ids.length; index += 1) {
    const raw = pipelineValue(eventRows[index]);
    const record = parseJson(raw);
    // An index member without a valid matching event is an inconsistent read,
    // not the same thing as a healthy empty inbox.
    if (!validMailRecord(record, ids[index], hash)) {
      return { state: "error", error: "storage_unavailable" };
    }
    const receivedAt = new Date(record.receivedAt || 0).getTime();
    const expiresAt = new Date(record.expiresAt || 0).getTime();
    if (!receivedAt || !expiresAt) return { state: "error", error: "storage_unavailable" };
    if (receivedAt < minScore || expiresAt <= Date.now()) continue;
    records.push({ record, receivedAt });
  }
  const siblingCluster = latestNetflixSiblingCluster(records);
  // This exclusion applies only to fallback behind a newer rejected mail.
  // The newest accepted event remains readable in the same or a later browser
  // session, so a refresh does not make a still-valid code disappear.
  const returned = orderId
    ? await returnedNetflixEventIds(orderId, records)
    : { ok: true, eventIds: [] };
  if (!returned.ok) return { state: "error", error: returned.error || "storage_unavailable" };
  const excludeFallbackEventIds = returned.eventIds;
  for (const { record } of latestAcceptedNetflixRecords(records, NETFLIX_DUAL_DELIVERY_WINDOW_MS, {
    excludeFallbackEventIds,
  })) {
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
  const rejectedEntries = siblingCluster.filter(({ record, receivedAt }) => record.accepted === false
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

  if (!await markNetflixCodeResultReturned(orderId, eventId)) return false;

  const dedupeId = accessDedupeId({ orderId, eventId, outcome });
  const now = new Date();
  const id = "NA" + dedupeId.slice(0, 16).toUpperCase();
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
  const raw = JSON.stringify(record);
  const script = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
local score=tonumber(ARGV[3]); local ttl=tonumber(ARGV[4])
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'zset')
  or not score or score~=score or not ttl or ttl~=math.floor(ttl) or ttl<1 then return -1 end
local nextOk,next=pcall(cjson.decode,ARGV[2])
if not nextOk or type(next)~='table' or tostring(next.id or '')~=ARGV[1] or tostring(next.orderId or '')~=ARGV[5]
  or tostring(next.eventId or '')~=ARGV[6] or tostring(next.outcome or '')~=ARGV[7] then return -1 end
local dedupe=redis.call('GET',KEYS[1])
if dedupe and dedupe~='1' and dedupe~=ARGV[1] then return -2 end
local existing=redis.call('GET',KEYS[2])
local existingScore=redis.call('ZSCORE',KEYS[3],ARGV[1])
if existing then
  local existingOk,doc=pcall(cjson.decode,existing)
  if not existingOk or type(doc)~='table' or tostring(doc.id or '')~=ARGV[1] or tostring(doc.orderId or '')~=ARGV[5]
    or tostring(doc.eventId or '')~=ARGV[6] or tostring(doc.outcome or '')~=ARGV[7] then return -2 end
else redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4]) end
redis.call('EXPIRE',KEYS[2],ARGV[4])
redis.call('ZADD',KEYS[3],existingScore or ARGV[3],ARGV[1])
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[4])
return existing and 0 or 1`;
  const saved = await redisCmd([
    "EVAL", script, "3", ACCESS_DEDUPE_PREFIX + dedupeId, ACCESS_PREFIX + id, ACCESS_INDEX,
    id, raw, String(score), String(ACCESS_TTL_SECONDS), orderId, eventId, outcome,
  ]);
  let ok = saved != null && [0, 1].includes(Number(saved));
  if (saved == null) {
    const recovered = await strictRedisRead([
      ["GET", ACCESS_DEDUPE_PREFIX + dedupeId], ["GET", ACCESS_PREFIX + id], ["ZSCORE", ACCESS_INDEX, id],
    ]);
    const stored = parseJson(recovered ? pipelineValue(recovered[1]) : null);
    ok = Boolean(recovered && pipelineValue(recovered[0]) === id && pipelineValue(recovered[2]) != null
      && validAccessRecord(stored, id) && stored.orderId === orderId && stored.eventId === eventId && stored.outcome === outcome);
  }
  await redisCmd(["ZREMRANGEBYSCORE", ACCESS_INDEX, "-inf", String(Date.now() - ACCESS_TTL_SECONDS * 1000)]);
  return ok;
}

export async function markNetflixCodeResultReturned(orderId, eventId) {
  const markerKey = returnedEventKey(orderId, eventId);
  const globalMarkerKey = returnedEventGlobalKey(eventId);
  if (!markerKey || !globalMarkerKey) return false;
  // The global marker prevents a shared Netflix account from replaying an old
  // result through a different order. The order-scoped v1 marker is retained
  // as migration evidence and for existing operational tooling.
  const script = `
local function validtype(key) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual=='string' end
local ttl=tonumber(ARGV[1])
if not validtype(KEYS[1]) or not validtype(KEYS[2]) or not ttl or ttl~=math.floor(ttl) or ttl<1 then return 0 end
redis.call('SET',KEYS[1],'1','EX',ARGV[1])
redis.call('SET',KEYS[2],'1','EX',ARGV[1])
return 1`;
  const saved = Number(await redisCmd(["EVAL", script, "2", globalMarkerKey, markerKey, String(EVENT_TTL_SECONDS)]));
  if (saved === 1) return true;
  const recovered = await strictRedisRead([["GET", globalMarkerKey], ["GET", markerKey]]);
  return Boolean(recovered && pipelineValue(recovered[0]) === "1" && pipelineValue(recovered[1]) === "1");
}

// A single unreadable member must never blank the whole operational log. The
// panel is what staff use to explain a delivery, so one malformed or legacy
// row is skipped and reported, while every readable row is still returned.
function reportSkippedRecords(indexKey, skipped) {
  if (!skipped.length) return;
  console.warn("[netflix-mail] skipped unreadable index members", {
    indexKey,
    skipped: skipped.length,
    ids: skipped.slice(0, 10),
  });
}

async function recordsFromIndex(indexKey, offset, limit, prefix, validator) {
  const records = [];
  const pageSize = Math.max(20, Math.min(200, limit * 2));
  let cursor = offset;
  while (records.length < limit) {
    const ids = await redisCmd(["ZREVRANGE", indexKey, String(cursor), String(cursor + pageSize - 1)]);
    if (!Array.isArray(ids)) throw new Error("netflix_record_store_unavailable");
    if (!ids.length) break;
    const response = await redisPipeline(ids.map((id) => ["GET", prefix + id]));
    if (!pipelineSucceeded(response, ids.length)) throw new Error("netflix_record_store_unavailable");
    const skipped = [];
    pipelineRows(response).forEach((entry, index) => {
      const record = parseJson(pipelineValue(entry));
      if (validator(record, ids[index])) records.push(record);
      else skipped.push(String(ids[index] || ""));
    });
    reportSkippedRecords(indexKey, skipped);
    cursor += ids.length;
    if (ids.length < pageSize) break;
  }
  return records.slice(0, limit);
}

async function allRecordsFromIndex(indexKey, prefix, validator, pageSize = 200) {
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
    if (!Array.isArray(ids)) throw new Error("netflix_record_store_unavailable");
    if (!ids.length) break;
    const response = await redisPipeline(ids.map((id) => ["GET", prefix + id]));
    if (!pipelineSucceeded(response, ids.length)) throw new Error("netflix_record_store_unavailable");
    const skipped = [];
    pipelineRows(response).forEach((entry, index) => {
      const record = parseJson(pipelineValue(entry));
      if (validator(record, ids[index])) records.push(record);
      else skipped.push(String(ids[index] || ""));
    });
    reportSkippedRecords(indexKey, skipped);
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
  const rows = await strictRedisRead(uniqueHashes.map((hash) => ["ZREVRANGE", accountIndexKey(hash), "0", "0", "WITHSCORES"]));
  if (!rows) throw new Error("netflix_record_store_unavailable");
  const receipts = {};
  uniqueHashes.forEach((hash, index) => {
    const value = pipelineValue(rows[index]);
    const score = Array.isArray(value) ? Number(value[1] || 0) : 0;
    if (Number.isFinite(score) && score > 0) receipts[hash] = score;
  });
  return receipts;
}

export async function listNetflixMailEvents({ offset = 0, limit = 60 } = {}) {
  return recordsFromIndex(EVENT_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(100, Number(limit || 60))), EVENT_PREFIX, validMailRecord);
}

export async function listNetflixCodeAccess({ offset = 0, limit = 100 } = {}) {
  return recordsFromIndex(ACCESS_INDEX, Math.max(0, Number(offset || 0)), Math.max(1, Math.min(200, Number(limit || 100))), ACCESS_PREFIX, validAccessRecord);
}

export async function listAllNetflixMailEvents() {
  return allRecordsFromIndex(EVENT_INDEX, EVENT_PREFIX, validMailRecord);
}

export async function listAllNetflixCodeAccess() {
  return allRecordsFromIndex(ACCESS_INDEX, ACCESS_PREFIX, validAccessRecord);
}

const DELETE_MAIL_EVENTS_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
local ok,plan=pcall(cjson.decode,ARGV[1])
if not ok or type(plan)~='table' or not validtype(KEYS[1],'zset') then return 0 end
for _,item in ipairs(plan) do
  local recordKey=tonumber(item.recordKey)
  if not recordKey or recordKey~=math.floor(recordKey) or not KEYS[recordKey] or not validtype(KEYS[recordKey],'string') then return 0 end
  local raw=redis.call('GET',KEYS[recordKey])
  if (item.present==true and raw~=item.raw) or (item.present~=true and raw) then return 0 end
  for _,keyIndex in ipairs(item.accountKeys or {}) do
    keyIndex=tonumber(keyIndex)
    if not keyIndex or keyIndex~=math.floor(keyIndex) or not KEYS[keyIndex] or not validtype(KEYS[keyIndex],'zset') then return 0 end
  end
end
for _,item in ipairs(plan) do
  redis.call('ZREM',KEYS[1],item.id)
  for _,keyIndex in ipairs(item.accountKeys or {}) do redis.call('ZREM',KEYS[tonumber(keyIndex)],item.id) end
  if item.present==true and redis.call('DEL',KEYS[tonumber(item.recordKey)])~=1 then return 0 end
end
return #plan`;

const DELETE_ACCESS_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
local ok,plan=pcall(cjson.decode,ARGV[1])
if not ok or type(plan)~='table' or not validtype(KEYS[1],'zset') then return 0 end
for _,item in ipairs(plan) do
  local recordKey=tonumber(item.recordKey); local dedupeKey=tonumber(item.dedupeKey or 0)
  if not recordKey or recordKey~=math.floor(recordKey) or not KEYS[recordKey] or not validtype(KEYS[recordKey],'string') then return 0 end
  if dedupeKey>0 and (not KEYS[dedupeKey] or not validtype(KEYS[dedupeKey],'string')) then return 0 end
  local raw=redis.call('GET',KEYS[recordKey])
  if (item.present==true and raw~=item.raw) or (item.present~=true and raw) then return 0 end
end
for _,item in ipairs(plan) do
  redis.call('ZREM',KEYS[1],item.id)
  if item.present==true and redis.call('DEL',KEYS[tonumber(item.recordKey)])~=1 then return 0 end
  if tonumber(item.dedupeKey or 0)>0 then redis.call('DEL',KEYS[tonumber(item.dedupeKey)]) end
end
return #plan`;

export async function deleteNetflixMailEvents(values) {
  const eventIds = validEventIds(values).slice(0, 40);
  if (!eventIds.length) return { ok: false, deleted: 0 };
  const readRows = await strictRedisRead(eventIds.map((eventId) => ["GET", eventKey(eventId)]));
  if (!readRows) return { ok: false, deleted: 0 };
  const raws = eventIds.map((eventId, index) => pipelineValue(readRows[index]));
  const records = raws.map(parseJson);
  if (records.some((record, index) => record != null && !validMailRecord(record, eventIds[index]))) return { ok: false, deleted: 0 };
  const keys = [EVENT_INDEX], keyIndexes = new Map([[EVENT_INDEX, 1]]);
  const addKey = (key) => { if (!keyIndexes.has(key)) { keys.push(key); keyIndexes.set(key, keys.length); } return keyIndexes.get(key); };
  const plan = eventIds.map((id, index) => ({
    id, raw: raws[index] || "", present: raws[index] != null, recordKey: addKey(eventKey(id)),
    accountKeys: (records[index]?.accountHashes || []).map((hash) => addKey(accountIndexKey(hash))),
  }));
  const deleted = await redisCmd(["EVAL", DELETE_MAIL_EVENTS_SCRIPT, String(keys.length), ...keys, JSON.stringify(plan)]);
  let ok = deleted != null && Number(deleted) === eventIds.length;
  if (deleted == null) {
    const commands = plan.flatMap((item) => [
      ["GET", keys[item.recordKey - 1]], ["ZSCORE", EVENT_INDEX, item.id],
      ...item.accountKeys.map((keyIndex) => ["ZSCORE", keys[keyIndex - 1], item.id]),
    ]);
    const recovered = await strictRedisRead(commands);
    ok = Boolean(recovered && recovered.every((row) => pipelineValue(row) == null));
  }
  return { ok, deleted: ok ? eventIds.length : 0 };
}

export async function deleteNetflixCodeAccessRecords(values) {
  const accessIds = validAccessIds(values).slice(0, 40);
  if (!accessIds.length) return { ok: false, deleted: 0 };
  const readRows = await strictRedisRead(accessIds.map((id) => ["GET", ACCESS_PREFIX + id]));
  if (!readRows) return { ok: false, deleted: 0 };
  const raws = accessIds.map((id, index) => pipelineValue(readRows[index]));
  const records = raws.map(parseJson);
  if (records.some((record, index) => record != null && !validAccessRecord(record, accessIds[index]))) return { ok: false, deleted: 0 };
  const keys = [ACCESS_INDEX], keyIndexes = new Map([[ACCESS_INDEX, 1]]);
  const addKey = (key) => { if (!keyIndexes.has(key)) { keys.push(key); keyIndexes.set(key, keys.length); } return keyIndexes.get(key); };
  const plan = accessIds.map((id, index) => ({
    id, raw: raws[index] || "", present: raws[index] != null, recordKey: addKey(ACCESS_PREFIX + id),
    dedupeKey: records[index] ? addKey(ACCESS_DEDUPE_PREFIX + accessDedupeId(records[index])) : 0,
  }));
  const deleted = await redisCmd(["EVAL", DELETE_ACCESS_SCRIPT, String(keys.length), ...keys, JSON.stringify(plan)]);
  let ok = deleted != null && Number(deleted) === accessIds.length;
  if (deleted == null) {
    const commands = plan.flatMap((item) => [
      ["GET", keys[item.recordKey - 1]], ["ZSCORE", ACCESS_INDEX, item.id],
      ...(item.dedupeKey ? [["GET", keys[item.dedupeKey - 1]]] : []),
    ]);
    const recovered = await strictRedisRead(commands);
    ok = Boolean(recovered && recovered.every((row) => pipelineValue(row) == null));
  }
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
