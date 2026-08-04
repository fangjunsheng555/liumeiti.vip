import { createHash } from "node:crypto";
import { clean, formatBeijingTime, redisCmd } from "./_utils.js";

const TIMELINE_PREFIX = "liumeiti:order-timeline:";
const MAX_EVENTS = 100;
const TIMELINE_ONCE_PREFIX = "liumeiti:order-timeline-once:v1:";
const APPEND_ONCE_SCRIPT = `
local markerType=redis.call('TYPE',KEYS[1])
if type(markerType)=='table' then markerType=markerType.ok end
local listType=redis.call('TYPE',KEYS[2])
if type(listType)=='table' then listType=listType.ok end
if markerType~='none' and markerType~='string' then return -2 end
if listType~='none' and listType~='list' then return -2 end
local limit=tonumber(ARGV[2])
local eventOk,event=pcall(cjson.decode,ARGV[1])
if not limit or limit~=math.floor(limit) or limit<1 or limit>10000
  or not eventOk or type(event)~='table' or type(event.id)~='string'
  or type(event.type)~='string' or type(event.createdAt)~='string' then return -2 end
local marked=redis.call('SET',KEYS[1],'1','NX')
if marked then
  redis.call('LPUSH',KEYS[2],ARGV[1])
  redis.call('LTRIM',KEYS[2],0,limit-1)
  return 1
end
return 0`;

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function timelineKey(orderId) {
  const id = normalizeOrderId(orderId);
  return id ? TIMELINE_PREFIX + id : "";
}

function parseEvent(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function safeEvent(event) {
  const createdAt = event.createdAt || new Date().toISOString();
  return {
    id: clean(event.id || `OT${Date.now().toString(36).toUpperCase()}`, 80),
    type: clean(event.type || "updated", 60),
    visibility: event.visibility === "internal" ? "internal" : "public",
    summaryZh: clean(event.summaryZh || "订单信息已更新", 240),
    summaryEn: clean(event.summaryEn || "Order details updated", 240),
    actor: clean(event.actor || "system", 80),
    createdAt,
    createdAtBeijing: clean(event.createdAtBeijing || formatBeijingTime(createdAt), 80),
    meta: event.meta && typeof event.meta === "object" ? {
      status: clean(event.meta.status, 40),
      ticketId: clean(event.meta.ticketId, 100),
    } : {},
  };
}

export async function appendOrderTimeline(orderId, event) {
  const key = timelineKey(orderId);
  if (!key) return false;
  const next = safeEvent(event || {});
  const pushed = await redisCmd(["LPUSH", key, JSON.stringify(next)]);
  if (pushed === null) return false;
  await redisCmd(["LTRIM", key, "0", String(MAX_EVENTS - 1)]);
  return true;
}

// Timeline entries are Redis-local effects, so they can be made genuinely
// exactly-once with the permanent marker and LPUSH in the same Lua script.
// Callers retry this function after a dropped response without duplicating the
// event or leaving a marker that was committed without the event.
export async function appendOrderTimelineOnce(orderId, operationId, event) {
  const key = timelineKey(orderId);
  const stableOperation = clean(operationId, 300);
  if (!key || !stableOperation) return false;
  const marker = TIMELINE_ONCE_PREFIX
    + createHash("sha256").update(`${normalizeOrderId(orderId)}\0${stableOperation}`).digest("hex");
  const next = safeEvent({
    ...(event || {}),
    id: event?.id || `OT${createHash("sha256").update(stableOperation).digest("hex").slice(0, 20).toUpperCase()}`,
  });
  const appended = await redisCmd(["EVAL", APPEND_ONCE_SCRIPT, "2", marker, key, JSON.stringify(next), String(MAX_EVENTS)]);
  return appended === 1 || appended === 0;
}

function baseEvents(order) {
  const events = [];
  const add = (id, type, createdAt, createdAtBeijing, summaryZh, summaryEn) => {
    if (!createdAt && !createdAtBeijing) return;
    events.push(safeEvent({ id, type, createdAt, createdAtBeijing, summaryZh, summaryEn }));
  };
  add("base-created", "created", order?.createdAt, order?.createdAtBeijing, "订单已提交", "Order submitted");
  add("base-quoted", "quoted", order?.quotedAt, order?.quotedAtBeijing, "报价已发送", "Quote sent");
  add("base-payment", "payment_submitted", order?.paymentSubmittedAt, order?.paymentSubmittedAtBeijing, "付款信息已提交", "Payment details submitted");
  add("base-usdt", "payment_confirmed", order?.usdtConfirmedAt, order?.usdtConfirmedAtBeijing, "USDT 付款已确认", "USDT payment confirmed");
  add("base-completed", "completed", order?.completedAt, order?.completedAtBeijing, "订单已完成", "Order completed");
  add("base-invalid", "invalid", order?.invalidAt, order?.invalidAtBeijing, "订单已标记无效", "Order marked invalid");
  return events;
}

export async function getOrderTimeline(order, { publicOnly = false } = {}) {
  const key = timelineKey(order?.orderId);
  const stored = key ? await redisCmd(["LRANGE", key, "0", String(MAX_EVENTS - 1)]) : [];
  const merged = [...(Array.isArray(stored) ? stored.map(parseEvent).filter(Boolean) : []), ...baseEvents(order)];
  const seen = new Set();
  return merged
    .map(safeEvent)
    .filter((event) => !publicOnly || event.visibility === "public")
    .filter((event) => {
      const dedupeKey = event.id || `${event.type}|${event.createdAt}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}
