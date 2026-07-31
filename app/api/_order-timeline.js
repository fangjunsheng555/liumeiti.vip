import { clean, formatBeijingTime, redisCmd } from "./_utils.js";

const TIMELINE_PREFIX = "liumeiti:order-timeline:";
const MAX_EVENTS = 100;

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
