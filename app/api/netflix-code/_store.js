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
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60;
const SIBLING_EVENT_WINDOW_MS = 15 * 1000;
const MAX_REQUEST_FINGERPRINTS = 32;
const MAX_PRIMARY_REQUEST_FINGERPRINTS = 4;

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

function sameNetflixRequest(left, right) {
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
  // Equal SRC values are not sufficient positive evidence on their own. A
  // newly forwarded message can quote the previous Netflix email and retain
  // only that older SRC footer. Treating the quoted value as authoritative
  // would let a newer unparsed request replay the previous code. At least one
  // HMAC-protected original Message-ID/content identity must also overlap.
  const leftEvidence = requestFingerprints(left);
  const rightEvidence = requestFingerprints(right);
  const leftPrimary = requestPrimaryFingerprints(left);
  const rightPrimary = requestPrimaryFingerprints(right);
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
  if (Number.isSafeInteger(leftSequence) && Number.isSafeInteger(rightSequence) && leftSequence !== rightSequence) {
    return rightSequence - leftSequence;
  }
  return 0;
}

function recordRequestSentAt(entry) {
  const value = new Date(entry?.record?.requestSentAt || 0).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
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
      if (cluster.some((candidate) => sameNetflixRequest(entry?.record, candidate?.record))) matching.push(index);
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
    if (mergedFingerprints.size > 1 || mergedPrimaryFingerprints.size > 1) {
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
    const firstSequences = firstEntries
      .map((entry) => Number(entry?.record?.arrivalSequence || 0))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const firstArrivalSequence = firstSequences.length ? Math.min(...firstSequences) : 0;
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
  }).sort((left, right) => (
    right.requestTime - left.requestTime
    || right.firstReceivedAt - left.firstReceivedAt
    || right.firstArrivalSequence - left.firstArrivalSequence
    || compareArrival(left.entries[0], right.entries[0])
  ));
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
export const NETFLIX_DUAL_DELIVERY_WINDOW_MS = 120 * 1000;

export function latestAcceptedNetflixRecords(
  records,
  windowMs = NETFLIX_DUAL_DELIVERY_WINDOW_MS,
  { excludeFallbackEventIds = [] } = {},
) {
  const rankedClusters = rankedNetflixRequestClusters(records);
  const firstCluster = rankedClusters[0];
  const secondCluster = rankedClusters[1];
  // Legacy events can lack the distributed sequence. If two distinct request
  // clusters then tie on every trustworthy ordering signal, Redis member order
  // cannot prove which code is newest. Fail closed instead of guessing.
  if (firstCluster && secondCluster
    && firstCluster.requestTime === secondCluster.requestTime
    && firstCluster.firstReceivedAt === secondCluster.firstReceivedAt
    && firstCluster.firstArrivalSequence === secondCluster.firstArrivalSequence
    && compareArrival(firstCluster.entries[0], secondCluster.entries[0]) === 0) {
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
  if (newest.record?.accepted) {
    return [newest];
  }

  // An older accepted result may outrank a newer rejected copy only when both
  // prove they came from the same original Netflix request. Unequal SRC UUIDs
  // conclusively reject a match, while HMAC-protected original Message-ID or
  // canonical-content identities provide the required positive proof. An SRC
  // match alone is unsafe because a new forward may quote only the previous
  // email's footer. With no shared positive evidence the situation is
  // information-theoretically ambiguous, so fail closed instead of ever
  // returning a possibly stale code.
  const excludedFallbacks = new Set(validEventIds(excludeFallbackEventIds));
  // Evidence overlap is deliberately non-transitive for fallback. References
  // is a thread-level header and a newly forwarded request can quote both an
  // older identity and its SRC footer. A bridge record must therefore never
  // turn indirect overlap into permission to replay an older accepted code.
  return (rankedClusters[0]?.entries || []).filter((entry) => {
    if (!entry.record?.accepted || Math.abs(newestReceivedAt - Number(entry.receivedAt)) > windowMs) return false;
    if (excludedFallbacks.has(String(entry.record?.eventId || "").toUpperCase())) return false;
    return sameNetflixRequest(newest.record, entry.record);
  }).slice(0, 1);
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

async function returnedNetflixEventIds(orderId, records) {
  const candidates = (Array.isArray(records) ? records : [])
    .map(({ record }) => record)
    .filter((record) => record?.accepted
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
      || pipelineValue(rows[index * 3 + 2]) === "1")
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
    expiresAt: parsed?.expiresAt || "",
    sender: maskNetflixEmail(parsed?.sender),
    subject: clean(parsed?.subject, 240),
    deliveryFingerprint: deliveryFingerprint(parsed),
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
  if (!record || record.eventId !== normalizedEventId) {
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
    if (!record || !record?.accountHashes?.includes(hash)) {
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

  if (!await markNetflixCodeResultReturned(orderId, eventId)) return false;

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

export async function markNetflixCodeResultReturned(orderId, eventId) {
  const markerKey = returnedEventKey(orderId, eventId);
  const globalMarkerKey = returnedEventGlobalKey(eventId);
  if (!markerKey || !globalMarkerKey) return false;
  // The global marker prevents a shared Netflix account from replaying an old
  // result through a different order. The order-scoped v1 marker is retained
  // as migration evidence and for existing operational tooling.
  if (await redisCmd([
    "SET",
    globalMarkerKey,
    "1",
    "EX",
    String(EVENT_TTL_SECONDS),
  ]) !== "OK") return false;
  await redisCmd(["SET", markerKey, "1", "EX", String(EVENT_TTL_SECONDS)]);
  return true;
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
