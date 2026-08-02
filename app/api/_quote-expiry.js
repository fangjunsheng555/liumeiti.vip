import { randomBytes } from "node:crypto";
import {
  QUOTE_EXPIRY_ORDER_INDEX_KEY,
  clean,
  formatBeijingTime,
  getAllOrdersWithIndex,
  getOrderEntryById,
  redisCmd,
  redisPipeline,
  setOrderAt,
} from "./_utils.js";

export const QUOTE_VALID_DAY_OPTIONS = [1, 3, 7, 14];
export const DEFAULT_QUOTE_VALID_DAYS = 7;

const INDEX_READY_KEY = QUOTE_EXPIRY_ORDER_INDEX_KEY + ":ready:v2";
const INDEX_LOCK_KEY = QUOTE_EXPIRY_ORDER_INDEX_KEY + ":migration-lock";
const ORDER_UPDATE_LOCK_PREFIX = "lm:order:update-lock:";
const ORDER_UPDATE_LOCK_TTL_SECONDS = 120;
const RELEASE_LOCK_SCRIPT = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

export function normalizeQuoteOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function orderUpdateLockKey(orderId) {
  return ORDER_UPDATE_LOCK_PREFIX + normalizeQuoteOrderId(orderId);
}

async function acquireOrderUpdateLock(orderId) {
  const token = randomBytes(18).toString("hex");
  const key = orderUpdateLockKey(orderId);
  const locked = await redisCmd(["SET", key, token, "NX", "EX", String(ORDER_UPDATE_LOCK_TTL_SECONDS)]);
  return locked === "OK" ? { key, token } : null;
}

async function releaseOrderUpdateLock(lock) {
  if (!lock) return;
  await redisCmd(["EVAL", RELEASE_LOCK_SCRIPT, "1", lock.key, lock.token]);
}

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
  order.staffAudit = Array.isArray(order.staffAudit) ? [...order.staffAudit] : [];
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

async function expireQuoteOrderUnderLock(orderId, now, expectedRevision) {
  const normalizedOrderId = normalizeQuoteOrderId(orderId);
  const currentEntry = normalizedOrderId ? await getOrderEntryById(normalizedOrderId) : null;
  if (!currentEntry?.order || currentEntry.order.deleted || currentEntry.order.orderType !== "proxy_payment") {
    return { changed: false, saved: false, order: null, reason: "not_found" };
  }

  const current = currentEntry.order;
  const currentRevision = Number(current.revision || 0);
  if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
    return { changed: false, saved: false, order: current, reason: "stale_revision" };
  }
  if (current.status !== "pending_payment") {
    return { changed: false, saved: false, order: current, reason: "not_pending" };
  }
  if (!isQuoteExpired(current, now.getTime())) {
    return { changed: false, saved: false, order: current, reason: "not_due" };
  }

  const latestEntry = await getOrderEntryById(normalizedOrderId);
  const latestRevision = Number(latestEntry?.order?.revision || 0);
  if (
    !latestEntry?.order
    || latestEntry.order.deleted
    || latestEntry.order.orderType !== "proxy_payment"
    || latestEntry.order.status !== "pending_payment"
    || latestRevision !== currentRevision
    || (expectedRevision != null && latestRevision !== Number(expectedRevision))
  ) {
    return { changed: false, saved: false, order: latestEntry?.order || null, reason: "stale_revision" };
  }

  const nextOrder = {
    ...latestEntry.order,
    orderId: normalizedOrderId,
    revision: latestRevision + 1,
  };
  applyQuoteExpiry(nextOrder, now);
  const saved = await setOrderAt(latestEntry.index, nextOrder, { expectedRevision: latestRevision });
  if (!saved) {
    const afterEntry = await getOrderEntryById(normalizedOrderId);
    const stale = !afterEntry?.order
      || afterEntry.order.status !== "pending_payment"
      || Number(afterEntry.order.revision || 0) !== latestRevision;
    return {
      changed: false,
      saved: false,
      order: afterEntry?.order || latestEntry.order,
      reason: stale ? "stale_revision" : "save_failed",
    };
  }
  return { changed: saved, order: saved ? nextOrder : latestEntry.order, saved, reason: saved ? "expired" : "save_failed" };
}

export async function expireQuoteOrderEntry(entry, now = new Date(), options = {}) {
  const orderId = normalizeQuoteOrderId(entry?.order?.orderId || entry?.orderId);
  if (!orderId) return { changed: false, saved: false, order: null, reason: "not_found" };

  if (options.lockHeld) {
    return expireQuoteOrderUnderLock(orderId, now, options.expectedRevision);
  }

  const lock = await acquireOrderUpdateLock(orderId);
  if (!lock) return { changed: false, saved: false, order: null, reason: "lock_busy" };
  try {
    return await expireQuoteOrderUnderLock(orderId, now, options.expectedRevision);
  } finally {
    await releaseOrderUpdateLock(lock).catch(() => {});
  }
}

async function releaseMigrationLock(token) {
  await redisCmd(["EVAL", RELEASE_LOCK_SCRIPT, "1", INDEX_LOCK_KEY, token]);
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
    // Add canonical members without deleting the live index. Order writers do
    // not take this migration lock, so a snapshot-then-DEL rebuild could erase
    // a quote created between those two operations. Legacy raw members are
    // removed lazily by the scanner only after a canonical member is durable.
    const commands = [];
    for (const entry of entries) {
      const order = entry?.order;
      const expiresAt = quoteExpiryTime(order);
      const orderId = normalizeQuoteOrderId(order?.orderId);
      if (orderId && order?.orderType === "proxy_payment" && order.status === "pending_payment" && expiresAt) {
        commands.push(["ZADD", QUOTE_EXPIRY_ORDER_INDEX_KEY, String(expiresAt), orderId]);
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
  const seen = new Set();
  for (const rawId of ids) {
    const id = normalizeQuoteOrderId(rawId);
    if (!id || seen.has(id)) {
      stale.push(rawId);
      continue;
    }
    seen.add(id);
    const nonCanonical = String(rawId) !== id;

    // expireQuoteOrderEntry acquires the same normalized per-order lock used by
    // payment submission and rereads the order only after that lock is held.
    const result = await expireQuoteOrderEntry({ orderId: id }, new Date(now));
    if (result.saved) expired += 1;
    if (result.saved || ["not_found", "not_pending"].includes(result.reason)) {
      stale.push(id);
      if (nonCanonical) stale.push(rawId);
    }
    if (result.reason === "not_due") {
      const expiresAt = quoteExpiryTime(result.order);
      if (expiresAt) {
        const canonicalized = await redisCmd(["ZADD", QUOTE_EXPIRY_ORDER_INDEX_KEY, String(expiresAt), id]);
        if (canonicalized != null && nonCanonical) stale.push(rawId);
      }
    }
  }
  if (stale.length) await redisCmd(["ZREM", QUOTE_EXPIRY_ORDER_INDEX_KEY, ...new Set(stale)]);
  return { ok: true, scanned: ids.length, expired };
}

export const quoteExpiryInternals = {
  INDEX_READY_KEY,
  INDEX_LOCK_KEY,
  ORDER_UPDATE_LOCK_PREFIX,
  orderUpdateLockKey,
  pipelineSucceeded,
};
