import { randomBytes } from "node:crypto";
import {
  QUOTE_EXPIRY_ORDER_INDEX_KEY,
  formatBeijingTime,
  getAllOrdersWithIndex,
  getOrderEntryById,
  redisCmd,
  redisPipeline,
  setOrderAt,
} from "./_utils.js";

export const QUOTE_VALID_DAY_OPTIONS = [1, 3, 7, 14];
export const DEFAULT_QUOTE_VALID_DAYS = 7;

const INDEX_READY_KEY = QUOTE_EXPIRY_ORDER_INDEX_KEY + ":ready:v1";
const INDEX_LOCK_KEY = QUOTE_EXPIRY_ORDER_INDEX_KEY + ":migration-lock";

export function normalizeQuoteValidDays(value) {
  const days = Math.floor(Number(value));
  return QUOTE_VALID_DAY_OPTIONS.includes(days) ? days : DEFAULT_QUOTE_VALID_DAYS;
}

export function quoteExpiryTime(order) {
  const value = new Date(order?.quoteExpiresAt || 0).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isQuoteExpired(order, now = Date.now()) {
  const expiresAt = quoteExpiryTime(order);
  return Boolean(order?.orderType === "proxy_payment" && order?.status === "pending_payment" && expiresAt && expiresAt <= Number(now));
}

export function effectiveQuoteStatus(order, now = Date.now()) {
  return isQuoteExpired(order, now) ? "quote_expired" : (order?.status || "received");
}

export function applyQuoteExpiry(order, now = new Date()) {
  if (!isQuoteExpired(order, now.getTime())) return order;
  order.status = "quote_expired";
  order.quoteExpiredAt = now.toISOString();
  order.quoteExpiredAtBeijing = formatBeijingTime(now);
  order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
  order.staffAudit.unshift({
    id: "OA" + Date.now().toString(36).toUpperCase(),
    staffId: 0,
    staffUsername: "system",
    label: "报价已失效",
    action: "quote_expired",
    status: "quote_expired",
    createdAt: now.toISOString(),
    createdAtBeijing: order.quoteExpiredAtBeijing,
  });
  order.staffAudit = order.staffAudit.slice(0, 30);
  return order;
}

export async function expireQuoteOrderEntry(entry, now = new Date()) {
  if (!entry?.order || !isQuoteExpired(entry.order, now.getTime())) return { changed: false, order: entry?.order || null };
  applyQuoteExpiry(entry.order, now);
  const saved = await setOrderAt(entry.index, entry.order);
  return { changed: saved, order: entry.order, saved };
}

async function releaseMigrationLock(token) {
  const script = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  await redisCmd(["EVAL", script, "1", INDEX_LOCK_KEY, token]);
}

function pipelineSucceeded(result, expected) {
  const rows = Array.isArray(result) ? result : Array.isArray(result?.result) ? result.result : [];
  return rows.length === expected && rows.every((item) => !item?.error);
}

export async function ensureQuoteExpiryIndex() {
  if (await redisCmd(["GET", INDEX_READY_KEY]) === "1") return true;
  const token = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", INDEX_LOCK_KEY, token, "NX", "EX", "90"]);
  if (locked !== "OK") return false;
  try {
    const entries = await getAllOrdersWithIndex();
    const commands = [];
    for (const entry of entries) {
      const order = entry?.order;
      const expiresAt = quoteExpiryTime(order);
      if (order?.orderType === "proxy_payment" && order.status === "pending_payment" && expiresAt) {
        commands.push(["ZADD", QUOTE_EXPIRY_ORDER_INDEX_KEY, String(expiresAt), order.orderId]);
      }
    }
    for (let offset = 0; offset < commands.length; offset += 100) {
      const batch = commands.slice(offset, offset + 100);
      if (!pipelineSucceeded(await redisPipeline(batch), batch.length)) return false;
    }
    return await redisCmd(["SET", INDEX_READY_KEY, "1"]) === "OK";
  } finally {
    await releaseMigrationLock(token).catch(() => {});
  }
}

export async function expireDueQuoteOrders({ now = Date.now(), limit = 100 } = {}) {
  await ensureQuoteExpiryIndex();
  const ids = await redisCmd([
    "ZRANGEBYSCORE",
    QUOTE_EXPIRY_ORDER_INDEX_KEY,
    "-inf",
    String(Number(now)),
    "LIMIT",
    "0",
    String(Math.max(1, Math.min(500, Number(limit || 100)))),
  ]);
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, scanned: 0, expired: 0 };

  let expired = 0;
  const stale = [];
  for (const id of ids) {
    const entry = await getOrderEntryById(id);
    if (!entry || entry.order?.orderType !== "proxy_payment" || entry.order.status !== "pending_payment") {
      stale.push(id);
      continue;
    }
    if (!isQuoteExpired(entry.order, now)) continue;
    const result = await expireQuoteOrderEntry(entry, new Date(now));
    if (result.saved) expired += 1;
  }
  if (stale.length) await redisCmd(["ZREM", QUOTE_EXPIRY_ORDER_INDEX_KEY, ...stale]);
  return { ok: true, scanned: ids.length, expired };
}

export const quoteExpiryInternals = {
  INDEX_READY_KEY,
  INDEX_LOCK_KEY,
  pipelineSucceeded,
};
