import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline, validEmail } from "./_utils.js";

const DELIVERY_INDEX_KEY = "lm:mail:delivery:index";
const DELIVERY_RECORD_PREFIX = "lm:mail:delivery:record:";
const DELIVERY_MESSAGE_PREFIX = "lm:mail:delivery:message:";
const DELIVERY_EVENT_PREFIX = "lm:mail:delivery:event:";
const SMTP2GO_EVENT_PREFIX = "lm:mail:delivery:smtp2go-event:";
const MAX_RECORDS = 2000;
const MAX_EVENTS = 24;
const EVENT_TTL_SECONDS = 180 * 24 * 60 * 60;

export const DELIVERY_STATUSES = ["scheduled", "sent", "delivered", "delayed", "bounced", "complained", "failed", "suppressed"];

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

function normalizeRecipients(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [value])
    .map((item) => clean(item, 200).toLowerCase())
    .filter(validEmail)))
    .slice(0, 50);
}

function normalizedCategory(value, marketing = false) {
  const safe = clean(value || (marketing ? "marketing" : "transactional"), 40)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return safe || "transactional";
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

async function getRecordByMessageId(messageId) {
  const safeMessageId = canonicalMessageId(messageId);
  if (!safeMessageId) return null;
  const id = await redisCmd(["GET", messageKey(safeMessageId)]);
  if (!id) return null;
  return parseJson(await redisCmd(["GET", recordKey(id)]));
}

async function persistRecord(record) {
  const score = new Date(record.createdAt || record.updatedAt || Date.now()).getTime();
  const commands = [
    ["SET", recordKey(record.id), JSON.stringify(record)],
    ["ZADD", DELIVERY_INDEX_KEY, String(Number.isFinite(score) ? score : Date.now()), record.id],
  ];
  const lookupIds = Array.from(new Set([record.messageId, record.providerMessageId].map(canonicalMessageId).filter(Boolean)));
  lookupIds.forEach((messageId) => commands.push(["SET", messageKey(messageId), record.id]));
  const result = pipelineRows(await redisPipeline(commands));
  if (result.length !== commands.length || result.some((item) => item == null)) return false;
  const overflow = await redisCmd(["ZREVRANGE", DELIVERY_INDEX_KEY, String(MAX_RECORDS), "-1"]);
  if (Array.isArray(overflow) && overflow.length) {
    const cleanup = [["ZREM", DELIVERY_INDEX_KEY, ...overflow]];
    overflow.forEach((id) => cleanup.push(["DEL", recordKey(id)]));
    await redisPipeline(cleanup);
  }
  return true;
}

export async function registerEmailDelivery({ args = {}, result = {} } = {}) {
  const now = new Date();
  const messageId = canonicalMessageId(result?.messageId);
  const existing = messageId ? await getRecordByMessageId(messageId) : null;
  const recipients = normalizeRecipients(args.to);
  const status = result?.ok ? (result?.scheduled ? "scheduled" : "sent") : "failed";
  const fallbackError = clean(result?.fallbackError || "", 260);
  const sendError = clean(result?.error || result?.reason || "send_failed", 260);
  const failureReason = result?.fallbackAttempted && fallbackError
    ? clean(`${sendError}; SMTP2GO: ${fallbackError}`, 300)
    : sendError;
  const record = {
    ...(existing || {}),
    id: existing?.id || makeDeliveryId(),
    messageId,
    providerMessageId: canonicalMessageId(result?.providerMessageId || existing?.providerMessageId),
    provider: clean(result?.provider || "resend", 30),
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
    status: nextStatus(existing?.status, status),
    reason: result?.ok ? (existing?.reason || "") : failureReason,
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
  const locked = await redisCmd(["SET", lockKey, "processing", "NX", "EX", "300"]);
  if (locked !== "OK") return { ok: true, duplicate: true };
  try {
    const senderMessageId = canonicalMessageId(event?.["message-id"] || event?.message_id);
    const providerMessageId = canonicalMessageId(event?.email_id);
    let record = await getRecordByMessageId(senderMessageId);
    if (!record && providerMessageId) record = await getRecordByMessageId(providerMessageId);
    const now = new Date();
    const item = smtp2goEventItem(event, safeEventId);
    const recipients = normalizeRecipients(event?.rcpt || event?.recipients);
    const createdAt = normalizeEventTime(event?.sendtime, now);
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
    await redisCmd(["SET", lockKey, "1", "EX", String(EVENT_TTL_SECONDS)]);
    return { ok: true, record };
  } catch (error) {
    await redisCmd(["DEL", lockKey]);
    return { ok: false, error: clean(error?.message || "delivery_event_failed", 160) };
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
  if (!safeEventId || !String(event?.type || "").startsWith("email.")) return { ok: true, ignored: true };
  const lockKey = DELIVERY_EVENT_PREFIX + safeEventId;
  const locked = await redisCmd(["SET", lockKey, "processing", "NX", "EX", "300"]);
  if (locked !== "OK") return { ok: true, duplicate: true };
  try {
    const messageId = canonicalMessageId(event?.data?.email_id || event?.data?.message_id);
    let record = await getRecordByMessageId(messageId);
    const now = new Date();
    const incoming = EVENT_STATUS[event.type] || "";
    const tags = event?.data?.tags && typeof event.data.tags === "object" ? event.data.tags : {};
    const recipients = normalizeRecipients(event?.data?.to);
    const item = eventItem(event, safeEventId);
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
    await redisCmd(["SET", lockKey, "1", "EX", String(EVENT_TTL_SECONDS)]);
    return { ok: true, record };
  } catch (error) {
    await redisCmd(["DEL", lockKey]);
    return { ok: false, error: clean(error?.message || "delivery_event_failed", 160) };
  }
}

export async function listEmailDeliveries({ query = "", status = "all", category = "all", limit = 100 } = {}) {
  const ids = await redisCmd(["ZREVRANGE", DELIVERY_INDEX_KEY, "0", "499"]);
  if (!Array.isArray(ids) || !ids.length) return { records: [], counts: {}, total: 0 };
  const rows = pipelineRows(await redisPipeline(ids.map((id) => ["GET", recordKey(id)])));
  const records = rows.map(parseJson).filter(Boolean);
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
  return { records: filtered.slice(0, Math.max(1, Math.min(300, Number(limit || 100)))), counts, total: filtered.length };
}

export async function getEmailDelivery(id) {
  return parseJson(await redisCmd(["GET", recordKey(id)]));
}

export const mailDeliveryInternals = {
  EVENT_STATUS,
  SMTP2GO_EVENT_STATUS,
  canonicalMessageId,
  nextStatus,
  normalizeRecipients,
  normalizedCategory,
  normalizeEventTime,
  smtp2goEventKey,
};
