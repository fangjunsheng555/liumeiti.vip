import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline, validEmail } from "./_utils.js";

const DELIVERY_INDEX_KEY = "lm:mail:delivery:index";
const DELIVERY_RECORD_PREFIX = "lm:mail:delivery:record:";
const DELIVERY_MESSAGE_PREFIX = "lm:mail:delivery:message:";
const DELIVERY_EVENT_PREFIX = "lm:mail:delivery:event:";
const SMTP2GO_EVENT_PREFIX = "lm:mail:delivery:smtp2go-event:";
const BREVO_EVENT_PREFIX = "lm:mail:delivery:brevo-event:";
const MAX_RECORDS = 2000;
const MAX_EVENTS = 24;
const EVENT_TTL_SECONDS = 180 * 24 * 60 * 60;

export const DELIVERY_STATUSES = ["scheduled", "sent", "delivered", "recovered", "delayed", "bounced", "complained", "failed", "suppressed"];
const PROVIDER_OUTCOME_CLASSES = new Set(["success", "suppressed", "quota", "policy_retry", "uncertain", "definite_failure", "idempotency_conflict"]);

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERABLE_STATUSES = new Set(["failed", "bounced", "suppressed"]);
const SUCCESSFUL_STATUSES = new Set(["sent", "delivered"]);

const EVENT_STATUS = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

const SMTP2GO_EVENT_STATUS = {
  processed: "sent",
  delivered: "delivered",
  bounce: "bounced",
  spam: "complained",
  reject: "suppressed",
};

const BREVO_EVENT_STATUS = {
  request: "sent",
  sent: "sent",
  delivered: "delivered",
  deferred: "delayed",
  soft_bounce: "delayed",
  hard_bounce: "bounced",
  spam: "complained",
  complaint: "complained",
  invalid: "suppressed",
  blocked: "suppressed",
  error: "failed",
};

const STATUS_PRIORITY = {
  scheduled: 5,
  sent: 10,
  delayed: 20,
  delivered: 30,
  failed: 40,
  suppressed: 45,
  bounced: 50,
  complained: 60,
};

function recordKey(id) { return DELIVERY_RECORD_PREFIX + clean(id, 120); }
function canonicalMessageId(value) {
  return clean(value, 180).replace(/^<+|>+$/g, "").trim();
}
function messageKey(messageId) { return DELIVERY_MESSAGE_PREFIX + canonicalMessageId(messageId); }
function makeDeliveryId() { return `MD${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`; }

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item && typeof item === "object" && Object.hasOwn(item, "result") ? item.result : item));
}

function pipelineEntryHasError(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (Object.hasOwn(entry, "error") && entry.error != null) return true;
  return Object.hasOwn(entry, "result")
    && entry.result
    && typeof entry.result === "object"
    && Object.hasOwn(entry.result, "error")
    && entry.result.error != null;
}

function checkedPipelineRows(response, expectedLength) {
  if (!Array.isArray(response) || response.length !== expectedLength || response.some(pipelineEntryHasError)) return null;
  return pipelineRows(response);
}

function validStoredDelivery(record, expectedId = "") {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const id = clean(record.id, 120);
  const status = clean(record.status, 40).toLowerCase();
  if (!id || (expectedId && id !== clean(expectedId, 120))) return false;
  return DELIVERY_STATUSES.includes(status) || status === "recovered";
}

function normalizeRecipients(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [value])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(validEmail)))
    .slice(0, 50);
}

function normalizedCategory(value, marketing = false) {
  const safe = clean(value || (marketing ? "marketing" : "transactional"), 40)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return safe || "transactional";
}

function deliveryRecoveryFingerprint(record) {
  const recipient = normalizeRecipients(record?.to || record?.recipients?.[0] || "")[0] || "";
  const subject = clean(record?.subject || "", 180).toLowerCase();
  if (!recipient || !subject) return "";
  return [
    recipient,
    normalizedCategory(record?.category),
    clean(record?.relatedType || "", 40).toLowerCase(),
    clean(record?.relatedId || "", 120).toLowerCase(),
    subject,
  ].join("\u001f");
}

function recordTime(record) {
  const value = new Date(record?.createdAt || record?.updatedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function reconcileDeliveryStatuses(records, windowMs = RECOVERY_WINDOW_MS) {
  const latestSuccess = new Map();
  return (Array.isArray(records) ? records : []).map((record) => {
    const fingerprint = deliveryRecoveryFingerprint(record);
    const timestamp = recordTime(record);
    if (fingerprint && SUCCESSFUL_STATUSES.has(record?.status)) {
      if (!latestSuccess.has(fingerprint)) latestSuccess.set(fingerprint, record);
      return record;
    }
    const success = fingerprint ? latestSuccess.get(fingerprint) : null;
    const successTime = recordTime(success);
    if (
      success
      && RECOVERABLE_STATUSES.has(record?.status)
      && successTime >= timestamp
      && successTime - timestamp <= windowMs
    ) {
      return {
        ...record,
        status: "recovered",
        originalStatus: record.status,
        reason: "",
        recoveredBy: success.messageId || success.id || "",
        recoveredAt: success.updatedAt || success.createdAt || "",
        recoveredAtBeijing: success.updatedAtBeijing || success.createdAtBeijing || "",
      };
    }
    return record;
  });
}

function resendEventReason(event) {
  return clean(
    event?.data?.bounce?.message
      || event?.data?.failed?.reason
      || event?.data?.suppressed?.reason
      || event?.data?.reason
      || "",
    300,
  );
}

function eventItem(event, eventId) {
  const createdAt = clean(event?.created_at, 80) || new Date().toISOString();
  return {
    id: clean(eventId, 160),
    type: clean(event?.type, 80),
    status: EVENT_STATUS[event?.type] || "",
    reason: resendEventReason(event),
    createdAt,
    createdAtBeijing: formatBeijingTime(createdAt),
  };
}

function nextStatus(current, incoming) {
  if (!incoming) return current || "sent";
  if (!current) return incoming;
  return (STATUS_PRIORITY[incoming] || 0) >= (STATUS_PRIORITY[current] || 0) ? incoming : current;
}

async function readRecordByMessageId(messageId) {
  const safeMessageId = canonicalMessageId(messageId);
  if (!safeMessageId) return { ok: true, record: null };
  const lookup = await redisPipeline([["GET", messageKey(safeMessageId)]]);
  const lookupRows = checkedPipelineRows(lookup, 1);
  if (!lookupRows) return { ok: false, error: "storage_failed", record: null };
  const rawId = lookupRows[0];
  if (rawId == null) return { ok: true, record: null };
  const id = typeof rawId === "string" ? clean(rawId, 120) : "";
  if (!id || id !== rawId) {
    console.warn("[mail-delivery] corrupt message lookup", { messageId: safeMessageId });
    return { ok: false, error: "storage_corrupt", record: null };
  }
  const stored = await redisPipeline([["GET", recordKey(id)]]);
  const storedRows = checkedPipelineRows(stored, 1);
  if (!storedRows) return { ok: false, error: "storage_failed", record: null };
  const record = storedRows[0] == null ? null : parseJson(storedRows[0]);
  if (!validStoredDelivery(record, id) || ![record?.messageId, record?.providerMessageId].map(canonicalMessageId).includes(safeMessageId)) {
    console.warn("[mail-delivery] corrupt delivery record", { id, messageId: safeMessageId });
    return { ok: false, error: "storage_corrupt", record: null };
  }
  return { ok: true, record };
}

const COMPLETE_EVENT_LEASE_SCRIPT = `
if redis.call('GET',KEYS[1])==ARGV[1] then
  redis.call('SET',KEYS[1],'done','EX',ARGV[2])
  return 1
end
return 0`;

const RELEASE_EVENT_LEASE_SCRIPT = `
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end
return 0`;

async function acquireEventLease(lockKey) {
  const token = randomBytes(18).toString("hex");
  const acquired = await redisCmd(["SET", lockKey, token, "NX", "EX", "300"]);
  if (acquired === "OK") return { ok: true, token };
  const probe = await redisPipeline([["GET", lockKey]]);
  const rows = checkedPipelineRows(probe, 1);
  if (!rows) return { ok: false, error: "storage_failed", retryable: true };
  if (rows[0] === "done" || rows[0] === "1") return { ok: true, duplicate: true };
  if (rows[0]) return { ok: false, error: "event_processing", retryable: true };
  return { ok: false, error: "storage_failed", retryable: true };
}

async function completeEventLease(lockKey, token) {
  return Number(await redisCmd(["EVAL", COMPLETE_EVENT_LEASE_SCRIPT, "1", lockKey, token, String(EVENT_TTL_SECONDS)])) === 1;
}

async function releaseEventLease(lockKey, token) {
  return Number(await redisCmd(["EVAL", RELEASE_EVENT_LEASE_SCRIPT, "1", lockKey, token])) === 1;
}

function traceableOrderRelatedType(value) {
  const type = clean(value, 40).toLowerCase();
  return type === "order" || type === "quote" || type === "after_sales" || /(?:^|_)order(?:_|$)/.test(type) || /(?:^|_)quote(?:_|$)/.test(type);
}

async function appendDeliveryBusinessTrace(record, item) {
  const status = clean(item?.status || record?.status, 30).toLowerCase();
  if (!traceableOrderRelatedType(record?.relatedType) || !record?.relatedId || !["sent", "delivered", "delayed", "bounced", "complained", "failed", "suppressed"].includes(status)) return;
  try {
    const { appendBusinessTraceEvent } = await import("./_observability.js");
    await appendBusinessTraceEvent(record.relatedId, {
      stage: `email_${status}`,
      component: "mail_delivery",
      outcome: ["bounced", "complained", "failed", "suppressed"].includes(status) ? "error" : (status === "delayed" ? "retry" : "ok"),
      operationId: clean(item?.id || record?.providerMessageId || record?.messageId, 160),
      at: item?.createdAt || record?.updatedAt || new Date().toISOString(),
    });
  } catch {}
}

async function persistRecord(record) {
  const score = new Date(record.createdAt || record.updatedAt || Date.now()).getTime();
  const commands = [
    ["SET", recordKey(record.id), JSON.stringify(record)],
    ["ZADD", DELIVERY_INDEX_KEY, String(Number.isFinite(score) ? score : Date.now()), record.id],
  ];
  const lookupIds = Array.from(new Set([record.messageId, record.providerMessageId].map(canonicalMessageId).filter(Boolean)));
  lookupIds.forEach((messageId) => commands.push(["SET", messageKey(messageId), record.id]));
  const result = checkedPipelineRows(await redisPipeline(commands), commands.length);
  if (!result
      || result[0] !== "OK"
      || result[1] == null
      || !Number.isFinite(Number(result[1]))
      || result.slice(2).some((item) => item !== "OK")) return false;
  const overflow = await redisCmd(["ZREVRANGE", DELIVERY_INDEX_KEY, String(MAX_RECORDS), "-1"]);
  if (Array.isArray(overflow) && overflow.length) {
    const cleanup = [["ZREM", DELIVERY_INDEX_KEY, ...overflow]];
    overflow.forEach((id) => cleanup.push(["DEL", recordKey(id)]));
    await redisPipeline(cleanup);
  }
  return true;
}

async function applyRecipientFeedback(record, item) {
  const status = clean(item?.status || record?.status, 30).toLowerCase();
  if (!["delivered", "delayed", "bounced", "complained", "suppressed"].includes(status)) return;
  const { applyMailFeedback } = await import("./_mail-preferences.js");
  const feedback = await applyMailFeedback({
    email: record?.to || record?.recipients?.[0] || "",
    status,
    eventType: item?.type || "",
    reason: item?.reason || record?.reason || "",
    provider: record?.provider || "",
    eventId: item?.id || "",
    campaignId: record?.category === "marketing" ? record?.relatedId || "" : "",
  });
  if (feedback?.ok === false) throw new Error(feedback.error || "mail_feedback_save_failed");
  if (record?.category === "marketing" && record?.relatedId) {
    try {
      const { recordMarketingCampaignMetric } = await import("./_marketing-campaign-queue.js");
      const metric = await recordMarketingCampaignMetric(
        record.relatedId,
        status,
        `delivery:${record?.provider || "unknown"}:${item?.id || record?.messageId || record?.id}:${status}`,
      );
      if (!metric?.ok) throw new Error(metric?.error || "campaign_metric_save_failed");
    } catch (error) {
      throw new Error(error?.message || "campaign_metric_save_failed");
    }
  }
}

export async function registerEmailDelivery({ args = {}, result = {} } = {}) {
  const now = new Date(), resultValid = Boolean(result && typeof result === "object" && !Array.isArray(result) && typeof result.ok === "boolean");
  const messageId = canonicalMessageId(result?.messageId);
  const existingRead = messageId ? await readRecordByMessageId(messageId) : { ok: true, record: null };
  if (!existingRead.ok) return null;
  const existing = existingRead.record;
  const recipients = normalizeRecipients(args.to);
  if (!recipients.length && !existing?.recipients?.length) return null;
  const requestedStatus = resultValid && DELIVERY_STATUSES.includes(result?.status) ? result.status : "";
  const positiveStatus = ["scheduled", "sent", "delivered", "recovered"].includes(requestedStatus);
  const status = requestedStatus && (!positiveStatus || result.ok === true)
    ? requestedStatus
    : (resultValid && result.ok === true ? (result?.scheduled ? "scheduled" : "sent") : "failed");
  const fallbackError = clean(result?.fallbackError || "", 260);
  const requestedOutcomeClass = clean(result?.providerOutcomeClass || "", 40);
  const providerOutcomeClass = PROVIDER_OUTCOME_CLASSES.has(requestedOutcomeClass)
    ? requestedOutcomeClass
    : (existing?.providerOutcomeClass || "");
  const sendError = clean(resultValid ? (result?.error || result?.reason || "send_failed") : "invalid_delivery_result", 260);
  const fallbackLabel = result?.fallbackProvider === "brevo"
    ? "Brevo"
    : (result?.fallbackProvider === "smtp2go" ? "历史 SMTP2GO" : "备用 SMTP");
  const failureReason = result?.fallbackAttempted && fallbackError
    ? clean(`${sendError}; ${fallbackLabel}: ${fallbackError}`, 300)
    : sendError;
  const record = {
    ...(existing || {}),
    id: existing?.id || makeDeliveryId(),
    messageId,
    providerMessageId: canonicalMessageId(result?.providerMessageId || existing?.providerMessageId),
    provider: clean(result?.provider || "resend", 30),
    providerOutcomeClass,
    providerErrorCode: clean(result?.providerErrorCode || result?.errorCode || existing?.providerErrorCode || "", 80),
    providerUncertain: Boolean(result?.providerUncertain ?? result?.uncertain ?? existing?.providerUncertain),
    fallback: Boolean(result?.fallback || existing?.fallback),
    primaryProvider: clean(result?.primaryProvider || existing?.primaryProvider || "", 30),
    primaryError: clean(result?.primaryError || existing?.primaryError || "", 300),
    fallbackAttempted: Boolean(result?.fallbackAttempted || existing?.fallbackAttempted),
    fallbackProvider: clean(result?.fallbackProvider || existing?.fallbackProvider || "", 30),
    fallbackError: fallbackError || existing?.fallbackError || "",
    recipients: recipients.length ? recipients : (existing?.recipients || []),
    to: recipients[0] || existing?.to || "",
    subject: clean(args.subject || existing?.subject || "", 180),
    category: normalizedCategory(args.category || existing?.category, args.marketing),
    relatedType: clean(args.relatedType || existing?.relatedType || "", 40),
    relatedId: clean(args.relatedId || existing?.relatedId || "", 120),
    status: result?.forceStatus ? status : nextStatus(existing?.status, status),
    reason: resultValid && result.ok === true ? (existing?.reason || "") : failureReason,
    attempt: Number(result?.attempt || 1),
    events: Array.isArray(existing?.events) ? existing.events.slice(-MAX_EVENTS) : [],
    createdAt: existing?.createdAt || now.toISOString(),
    createdAtBeijing: existing?.createdAtBeijing || formatBeijingTime(now),
    updatedAt: now.toISOString(),
    updatedAtBeijing: formatBeijingTime(now),
    scheduledAt: clean(result?.scheduledAt || args?.scheduledAt || existing?.scheduledAt || "", 80),
    scheduledAtBeijing: result?.scheduledAt || args?.scheduledAt
      ? formatBeijingTime(result?.scheduledAt || args?.scheduledAt)
      : (existing?.scheduledAtBeijing || ""),
  };
  return (await persistRecord(record)) ? record : null;
}

function normalizeEventTime(value, fallback = new Date()) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback.toISOString();
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    const date = new Date(raw.length === 10 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const utcValue = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(utcValue);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function smtp2goEventReason(event) {
  let context = event?.context || "";
  if (context && typeof context === "object") {
    try { context = JSON.stringify(context); } catch (error) { context = ""; }
  }
  return clean(event?.message || context || (event?.bounce ? `${event.bounce} bounce` : ""), 300);
}

function smtp2goEventItem(event, eventId) {
  const createdAt = normalizeEventTime(event?.time);
  const eventName = clean(event?.event, 40).toLowerCase();
  return {
    id: clean(eventId, 160),
    type: `smtp2go.${eventName}`,
    status: SMTP2GO_EVENT_STATUS[eventName] || "",
    reason: smtp2goEventReason(event),
    createdAt,
    createdAtBeijing: formatBeijingTime(createdAt),
  };
}

function smtp2goEventKey(event, eventName = clean(event?.event, 40).toLowerCase()) {
  return createHash("sha256")
    .update(JSON.stringify({
      webhookId: event?.id || "",
      event: eventName,
      time: event?.time || "",
      emailId: event?.email_id || "",
      messageId: event?.["message-id"] || event?.message_id || "",
      recipient: event?.rcpt || event?.recipients || "",
    }))
    .digest("hex")
    .slice(0, 40);
}

export function verifySmtp2goWebhookAuthorization(authorization, secret) {
  const expected = String(secret || "").trim();
  const supplied = String(authorization || "").trim().replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function applySmtp2goWebhookEvent(event) {
  const eventName = clean(event?.event, 40).toLowerCase();
  const incoming = SMTP2GO_EVENT_STATUS[eventName];
  if (!incoming) return { ok: true, ignored: true };
  const safeEventId = smtp2goEventKey(event, eventName);
  const lockKey = SMTP2GO_EVENT_PREFIX + safeEventId;
  const lease = await acquireEventLease(lockKey);
  if (lease.duplicate) return { ok: true, duplicate: true };
  if (!lease.ok) return lease;
  try {
    const senderMessageId = canonicalMessageId(event?.["message-id"] || event?.message_id);
    const providerMessageId = canonicalMessageId(event?.email_id);
    let lookup = await readRecordByMessageId(senderMessageId);
    if (!lookup.ok) throw new Error("delivery_lookup_failed");
    let record = lookup.record;
    if (!record && providerMessageId) {
      lookup = await readRecordByMessageId(providerMessageId);
      if (!lookup.ok) throw new Error("delivery_lookup_failed");
      record = lookup.record;
    }
    const now = new Date();
    const item = smtp2goEventItem(event, safeEventId);
    const recipients = normalizeRecipients(event?.rcpt || event?.recipients);
    const createdAt = normalizeEventTime(event?.sendtime, now);
    const previousStatus = record?.status || "";
    record = {
      ...(record || {}),
      id: record?.id || makeDeliveryId(),
      messageId: senderMessageId || record?.messageId || providerMessageId,
      providerMessageId: providerMessageId || record?.providerMessageId || "",
      provider: "smtp2go",
      recipients: recipients.length ? recipients : (record?.recipients || []),
      to: recipients[0] || record?.to || "",
      subject: clean(event?.subject || record?.subject || "", 180),
      category: normalizedCategory(record?.category),
      relatedType: clean(record?.relatedType || "", 40),
      relatedId: clean(record?.relatedId || "", 120),
      status: nextStatus(record?.status, incoming),
      reason: item.reason || record?.reason || "",
      attempt: Number(record?.attempt || 1),
      events: [...(Array.isArray(record?.events) ? record.events.filter((entry) => entry.id !== safeEventId) : []), item].slice(-MAX_EVENTS),
      createdAt: record?.createdAt || createdAt,
      createdAtBeijing: record?.createdAtBeijing || formatBeijingTime(createdAt),
      updatedAt: item.createdAt,
      updatedAtBeijing: item.createdAtBeijing,
    };
    const saved = await persistRecord(record);
    if (!saved) throw new Error("delivery_save_failed");
    await appendDeliveryBusinessTrace(record, item);
    await applyRecipientFeedback(record, item, previousStatus);
    if (!await completeEventLease(lockKey, lease.token)) throw new Error("event_completion_failed");
    return { ok: true, record };
  } catch (error) {
    await releaseEventLease(lockKey, lease.token);
    return { ok: false, retryable: true, error: clean(error?.message || "delivery_event_failed", 160) };
  }
}

function brevoEventName(event) {
  return clean(event?.event || event?.msg_status || "", 40)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function brevoCustomMessageId(event) {
  const raw = event?.["X-Mailin-custom"] || event?.["x-mailin-custom"];
  if (!raw) return "";
  if (typeof raw === "object") return canonicalMessageId(raw.site_message_id || raw.message_id);
  try {
    const parsed = JSON.parse(String(raw));
    return canonicalMessageId(parsed?.site_message_id || parsed?.message_id);
  } catch (error) {
    const match = String(raw).match(/site_message_id["'=:\s]+<?([^>"',\s}]+)/i);
    return canonicalMessageId(match?.[1]);
  }
}

function brevoEventReason(event) {
  return clean(event?.reason || event?.description || event?.status || "", 300);
}

function brevoEventItem(event, eventId) {
  const eventName = brevoEventName(event);
  const createdAt = normalizeEventTime(event?.ts_event || event?.ts_epoch || event?.ts || event?.date);
  return {
    id: clean(eventId, 160),
    type: `brevo.${eventName}`,
    status: BREVO_EVENT_STATUS[eventName] || "",
    reason: brevoEventReason(event),
    createdAt,
    createdAtBeijing: formatBeijingTime(createdAt),
  };
}

function brevoEventKey(event, eventName = brevoEventName(event)) {
  return createHash("sha256")
    .update(JSON.stringify({
      webhookId: event?.id || "",
      event: eventName,
      time: event?.ts_event || event?.ts_epoch || event?.ts || event?.date || "",
      messageId: event?.["message-id"] || event?.messageId || "",
      recipient: event?.email || event?.to || "",
    }))
    .digest("hex")
    .slice(0, 40);
}

export function verifyBrevoWebhookToken(supplied, secret) {
  const expected = String(secret || "").trim();
  const actual = String(supplied || "").trim().replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function applyBrevoWebhookEvent(event) {
  const eventName = brevoEventName(event);
  const incoming = BREVO_EVENT_STATUS[eventName];
  if (!incoming) return { ok: true, ignored: true };
  const safeEventId = brevoEventKey(event, eventName);
  const lockKey = BREVO_EVENT_PREFIX + safeEventId;
  const lease = await acquireEventLease(lockKey);
  if (lease.duplicate) return { ok: true, duplicate: true };
  if (!lease.ok) return lease;
  try {
    const senderMessageId = brevoCustomMessageId(event);
    const providerMessageId = canonicalMessageId(event?.["message-id"] || event?.messageId);
    let lookup = senderMessageId ? await readRecordByMessageId(senderMessageId) : { ok: true, record: null };
    if (!lookup.ok) throw new Error("delivery_lookup_failed");
    let record = lookup.record;
    if (!record && providerMessageId) {
      lookup = await readRecordByMessageId(providerMessageId);
      if (!lookup.ok) throw new Error("delivery_lookup_failed");
      record = lookup.record;
    }
    const now = new Date();
    const item = brevoEventItem(event, safeEventId);
    const recipients = normalizeRecipients(event?.email || event?.to);
    const createdAt = normalizeEventTime(event?.ts || event?.ts_event || event?.date, now);
    const previousStatus = record?.status || "";
    record = {
      ...(record || {}),
      id: record?.id || makeDeliveryId(),
      messageId: senderMessageId || record?.messageId || providerMessageId,
      providerMessageId: providerMessageId || record?.providerMessageId || "",
      provider: "brevo",
      fallback: Boolean(record?.fallback),
      primaryProvider: clean(record?.primaryProvider || "", 30),
      primaryError: clean(record?.primaryError || "", 300),
      recipients: recipients.length ? recipients : (record?.recipients || []),
      to: recipients[0] || record?.to || "",
      subject: clean(event?.subject || record?.subject || "", 180),
      category: normalizedCategory(record?.category),
      relatedType: clean(record?.relatedType || "", 40),
      relatedId: clean(record?.relatedId || "", 120),
      status: nextStatus(record?.status, incoming),
      reason: item.reason || record?.reason || "",
      attempt: Number(record?.attempt || 1),
      events: [...(Array.isArray(record?.events) ? record.events.filter((entry) => entry.id !== safeEventId) : []), item].slice(-MAX_EVENTS),
      createdAt: record?.createdAt || createdAt,
      createdAtBeijing: record?.createdAtBeijing || formatBeijingTime(createdAt),
      updatedAt: item.createdAt,
      updatedAtBeijing: item.createdAtBeijing,
    };
    const saved = await persistRecord(record);
    if (!saved) throw new Error("delivery_save_failed");
    await appendDeliveryBusinessTrace(record, item);
    await applyRecipientFeedback(record, item, previousStatus);
    if (!await completeEventLease(lockKey, lease.token)) throw new Error("event_completion_failed");
    return { ok: true, record };
  } catch (error) {
    await releaseEventLease(lockKey, lease.token);
    return { ok: false, retryable: true, error: clean(error?.message || "delivery_event_failed", 160) };
  }
}

export function verifyResendWebhookSignature({ payload, id, timestamp, signature, secret, now = Date.now() }) {
  const rawPayload = String(payload || "");
  const safeId = clean(id, 180);
  const safeTimestamp = clean(timestamp, 40);
  const safeSecret = String(secret || "").replace(/^whsec_/, "");
  if (!rawPayload || !safeId || !safeTimestamp || !signature || !safeSecret) return false;
  const timestampMs = Number(safeTimestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Number(now) - timestampMs) > 5 * 60 * 1000) return false;
  let key;
  try { key = Buffer.from(safeSecret, "base64"); } catch (e) { return false; }
  if (!key.length) return false;
  const expected = createHmac("sha256", key)
    .update(`${safeId}.${safeTimestamp}.${rawPayload}`)
    .digest("base64");
  const candidates = String(signature).split(/\s+/).map((part) => part.split(",")).filter(([version, value]) => version === "v1" && value);
  return candidates.some(([, value]) => {
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  });
}

export async function applyResendWebhookEvent(event, eventId) {
  const safeEventId = clean(eventId, 160);
  const incoming = EVENT_STATUS[event?.type] || "";
  if (!safeEventId || !String(event?.type || "").startsWith("email.") || !incoming) return { ok: true, ignored: true };
  const lockKey = DELIVERY_EVENT_PREFIX + safeEventId;
  const lease = await acquireEventLease(lockKey);
  if (lease.duplicate) return { ok: true, duplicate: true };
  if (!lease.ok) return lease;
  try {
    const messageId = canonicalMessageId(event?.data?.email_id || event?.data?.message_id);
    const lookup = await readRecordByMessageId(messageId);
    if (!lookup.ok) throw new Error("delivery_lookup_failed");
    let record = lookup.record;
    const now = new Date();
    const tags = event?.data?.tags && typeof event.data.tags === "object" ? event.data.tags : {};
    const recipients = normalizeRecipients(event?.data?.to);
    const item = eventItem(event, safeEventId);
    const previousStatus = record?.status || "";
    record = {
      ...(record || {}),
      id: record?.id || makeDeliveryId(),
      messageId,
      provider: "resend",
      recipients: recipients.length ? recipients : (record?.recipients || []),
      to: recipients[0] || record?.to || "",
      subject: clean(event?.data?.subject || record?.subject || "", 180),
      category: normalizedCategory(tags.category || record?.category),
      relatedType: clean(tags.related_type || record?.relatedType || "", 40),
      relatedId: clean(tags.related_id || record?.relatedId || "", 120),
      status: nextStatus(record?.status, incoming),
      reason: item.reason || record?.reason || "",
      attempt: Number(record?.attempt || 1),
      events: [...(Array.isArray(record?.events) ? record.events.filter((entry) => entry.id !== safeEventId) : []), item].slice(-MAX_EVENTS),
      createdAt: record?.createdAt || clean(event?.data?.created_at, 80) || now.toISOString(),
      createdAtBeijing: record?.createdAtBeijing || formatBeijingTime(event?.data?.created_at || now),
      updatedAt: clean(event?.created_at, 80) || now.toISOString(),
      updatedAtBeijing: formatBeijingTime(event?.created_at || now),
    };
    const saved = await persistRecord(record);
    if (!saved) throw new Error("delivery_save_failed");
    await appendDeliveryBusinessTrace(record, item);
    await applyRecipientFeedback(record, item, previousStatus);
    if (!await completeEventLease(lockKey, lease.token)) throw new Error("event_completion_failed");
    return { ok: true, record };
  } catch (error) {
    await releaseEventLease(lockKey, lease.token);
    return { ok: false, retryable: true, error: clean(error?.message || "delivery_event_failed", 160) };
  }
}

export async function listEmailDeliveries({ query = "", status = "all", category = "all", limit = 100 } = {}) {
  const ids = await redisCmd(["ZREVRANGE", DELIVERY_INDEX_KEY, "0", "499"]);
  if (!Array.isArray(ids)) return { ok: false, error: "storage_failed", records: [], counts: {}, total: 0 };
  if (!ids.length) return { ok: true, records: [], counts: {}, total: 0 };
  const commands = [...ids.map((id) => ["GET", recordKey(id)]), ["PING"]];
  const rows = checkedPipelineRows(await redisPipeline(commands), commands.length);
  if (!rows || rows.at(-1) !== "PONG") return { ok: false, error: "storage_failed", records: [], counts: {}, total: 0 };
  const parsedRows = [];
  const skippedIds = [];
  rows.slice(0, -1).forEach((row, index) => {
    const record = row == null ? null : parseJson(row);
    if (validStoredDelivery(record, ids[index])) parsedRows.push(record);
    else skippedIds.push(clean(ids[index], 120));
  });
  if (skippedIds.length) {
    console.warn("[mail-delivery] skipped unreadable delivery records", {
      skipped: skippedIds.length,
      ids: skippedIds.filter(Boolean).slice(0, 10),
    });
  }
  const records = reconcileDeliveryStatuses(parsedRows);
  const counts = records.reduce((out, record) => {
    out[record.status || "sent"] = (out[record.status || "sent"] || 0) + 1;
    return out;
  }, {});
  const needle = clean(query, 160).toLowerCase();
  const filtered = records.filter((record) => {
    if (status !== "all" && record.status !== status) return false;
    if (category !== "all" && record.category !== category) return false;
    if (!needle) return true;
    return [record.to, record.subject, record.relatedId, record.category, record.provider, record.primaryProvider]
      .join(" ").toLowerCase().includes(needle);
  });
  return { ok: true, records: filtered.slice(0, Math.max(1, Math.min(300, Number(limit || 100)))), counts, total: filtered.length };
}

export async function getEmailDelivery(id) {
  const commands = [["GET", recordKey(id)], ["PING"]];
  const rows = checkedPipelineRows(await redisPipeline(commands), commands.length);
  if (!rows || rows[1] !== "PONG") return { ok: false, error: "storage_failed", record: null };
  const record = rows[0] == null ? null : parseJson(rows[0]);
  if (rows[0] != null && !validStoredDelivery(record, id)) {
    console.warn("[mail-delivery] corrupt delivery record", { id: clean(id, 120) });
    return { ok: false, error: "storage_corrupt", record: null };
  }
  return { ok: true, record };
}

export async function readEmailDeliveryByMessageId(messageId) {
  return readRecordByMessageId(messageId);
}

export const mailDeliveryInternals = {
  EVENT_STATUS,
  SMTP2GO_EVENT_STATUS,
  BREVO_EVENT_STATUS,
  canonicalMessageId,
  nextStatus,
  normalizeRecipients,
  normalizedCategory,
  normalizeEventTime,
  smtp2goEventKey,
  brevoEventKey,
  brevoCustomMessageId,
  deliveryRecoveryFingerprint,
  reconcileDeliveryStatuses,
};
