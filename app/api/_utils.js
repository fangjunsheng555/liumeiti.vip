// Shared backend utilities: redis, password hashing, session signing

import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_AVATAR_IDS, isUserAvatarId, normalizeUserAvatarId } from "../lib/avatars.js";
import { hasPendingSpotifyPasswordCorrection } from "../lib/order-attention.js";
import { mergeSettings } from "../lib/settings-defaults.js";

export const ORDERS_KEY = "liumeiti:orders";
export const ORDER_INDEX_KEY = ORDERS_KEY + ":index";
export const ORDER_DELETED_INDEX_KEY = ORDERS_KEY + ":deleted-index"; // SET of soft-deleted order ids(供快速分页精确排除)
export const ORDER_RECORD_PREFIX = ORDERS_KEY + ":record:";
export const ORDER_EMAIL_INDEX_PREFIX = ORDERS_KEY + ":email:";
export const USDT_PENDING_ORDER_INDEX_KEY = ORDERS_KEY + ":usdt-pending";
export const QUOTE_EXPIRY_ORDER_INDEX_KEY = ORDERS_KEY + ":quote-expiry";
export const ORDER_OVERVIEW_HASH_KEY = ORDERS_KEY + ":overview";
const ORDER_OVERVIEW_READY_KEY = ORDER_OVERVIEW_HASH_KEY + ":ready:v4"; // v4: 增补负责人/SLA 字段,换 key 触发一次性重建
const ORDER_INDEX_MIGRATION_READY_KEY = ORDER_INDEX_KEY + ":legacy-ready";
const ORDER_INDEX_MIGRATION_LOCK_KEY = ORDER_INDEX_KEY + ":legacy-lock";
export const USERS_KEY = "liumeiti:users";

export function clean(value, limit = 500) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function pad2(value) { return String(value).padStart(2, "0"); }

export function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const ts = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  const b = new Date(ts + 8 * 60 * 60 * 1000);
  return [b.getUTCFullYear(), pad2(b.getUTCMonth() + 1), pad2(b.getUTCDate())].join("-")
    + " " + [pad2(b.getUTCHours()), pad2(b.getUTCMinutes()), pad2(b.getUTCSeconds())].join(":")
    + " 北京时间 (UTC+8)";
}

export function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export async function redisCmd(cmd) {
  const r = redisConfig();
  if (!r) return null;
  try {
    const res = await fetch(r.url + "/" + cmd.map(encodeURIComponent).join("/"), {
      headers: { Authorization: "Bearer " + r.token },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result;
  } catch (e) { return null; }
}

export async function redisPipeline(commands) {
  const r = redisConfig();
  if (!r) return null;
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function normalizeOrderIdForStorage(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmailForStorage(value) {
  return clean(value, 200).toLowerCase().trim();
}

function orderRecordKey(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  return id ? ORDER_RECORD_PREFIX + id : "";
}

function orderEmailIndexKey(email) {
  const lower = normalizeEmailForStorage(email);
  return lower ? ORDER_EMAIL_INDEX_PREFIX + lower : "";
}

function isPendingUsdtOrder(order) {
  return Boolean(
    order && !order.deleted
    && order.paidCurrency === "USDT"
    && order.status === "received"
    && !order.usdtConfirmedAt
    && Number(order.usdtPayAmount || 0) > 0
    && order.usdtQuoteId
  );
}

function pendingQuoteExpiryScore(order) {
  if (!order || order.deleted || order.orderType !== "proxy_payment" || order.status !== "pending_payment") return 0;
  const score = new Date(order.quoteExpiresAt || 0).getTime();
  return Number.isFinite(score) && score > 0 ? score : 0;
}

function orderCreatedScore(order) {
  const score = new Date(order?.createdAt || 0).getTime();
  return Number.isFinite(score) && score > 0 ? score : Date.now();
}

function orderOverviewSnapshot(order) {
  if (!order || order.deleted || !order.orderId) return null;
  // items 带 cycle/service/plan,供总览「即将到期」直接算服务到期,无需读全量订单正文。
  const items = Array.isArray(order.items) && order.items.length
    ? order.items.map((item) => ({
        amount: Number(item?.amount || 0),
        service: item?.service || "",
        label: item?.label || "",
        plan: item?.plan || item?.rocketPlan || "",
        cycle: item?.cycle || "",
      }))
    : (order.service ? [{
        amount: Number(order.finalAmount || 0),
        service: order.service || "",
        label: order.serviceLabel || "",
        plan: order.plan || order.rocketPlan || "",
        cycle: order.cycle || "",
      }] : []);
  return {
    orderId: normalizeOrderIdForStorage(order.orderId),
    status: order.status || "received",
    orderType: order.orderType || "standard",
    paymentMethod: order.paymentMethod || "alipay",
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    paidAmount: Number(order.paidAmount || 0),
    finalAmount: Number(order.finalAmount || 0),
    subtotal: Number(order.subtotal || 0),
    originalAmount: Number(order.originalAmount || 0),
    bundleFinalAmount: Number(order.bundleFinalAmount || 0),
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAt: order.completedAt || "",
    email: order.email || "",
    serviceLabel: order.serviceLabel || "",
    quoteAmount: Number(order.quoteAmount || 0),
    quoteExpiresAt: order.quoteExpiresAt || "",
    paymentSubmittedAt: order.paymentSubmittedAt || "",
    items,
    usdtPayAmount: Number(order.usdtPayAmount || 0),
    usdtQuoteId: order.usdtQuoteId || "",
    usdtConfirmedAt: order.usdtConfirmedAt || "",
    passwordCorrectionPending: hasPendingSpotifyPasswordCorrection(order),
    renewalReminderForExpiresAt: order.renewalReminderForExpiresAt || "",
    assignedStaffId: Number(order.assignedStaffId || 0),
    assignedStaffUsername: order.assignedStaffUsername || "",
    assignedAt: order.assignedAt || "",
    assignedAtBeijing: order.assignedAtBeijing || "",
    slaReminderKey: order.slaReminderKey || "",
    slaReminderSentAt: order.slaReminderSentAt || "",
  };
}

function parseOrderJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function pipelineResults(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

async function getOrderIdsFromIndex(key, start = "0", stop = "-1") {
  try {
    const rows = await redisCmd(["LRANGE", key, String(start), String(stop)]);
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows
      .map(normalizeOrderIdForStorage)
      .filter((id) => id && !seen.has(id) && seen.add(id));
  } catch (e) { return []; }
}

async function getOrdersByIds(orderIds) {
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .map(normalizeOrderIdForStorage)
    .filter(Boolean);
  if (ids.length === 0) return [];
  const response = await redisPipeline(ids.map((id) => ["GET", orderRecordKey(id)]));
  const rows = pipelineResults(response);
  return rows
    .map((entry, index) => {
      const raw = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
        ? entry.result
        : entry;
      const order = parseOrderJson(raw);
      return order ? { orderId: ids[index], order } : null;
    })
    .filter(Boolean);
}

async function getLegacyOrderEntries() {
  const r = redisConfig();
  if (!r) return [];
  try {
    const rows = await redisCmd(["LRANGE", ORDERS_KEY, "0", "-1"]);
    if (!Array.isArray(rows)) return [];
    return rows.map((raw, index) => ({ raw, index, order: parseOrderJson(raw) }));
  } catch (e) { return []; }
}

export async function saveOrderRecord(order) {
  const r = redisConfig();
  if (!r || !order?.orderId) return false;
  const orderId = normalizeOrderIdForStorage(order.orderId);
  const commands = [
    ["SET", orderRecordKey(orderId), JSON.stringify(order)],
    ["LPUSH", ORDER_INDEX_KEY, orderId],
  ];
  commands.push(isPendingUsdtOrder(order)
    ? ["ZADD", USDT_PENDING_ORDER_INDEX_KEY, String(orderCreatedScore(order)), orderId]
    : ["ZREM", USDT_PENDING_ORDER_INDEX_KEY, orderId]);
  const quoteExpiryScore = pendingQuoteExpiryScore(order);
  commands.push(quoteExpiryScore
    ? ["ZADD", QUOTE_EXPIRY_ORDER_INDEX_KEY, String(quoteExpiryScore), orderId]
    : ["ZREM", QUOTE_EXPIRY_ORDER_INDEX_KEY, orderId]);
  const overview = orderOverviewSnapshot(order);
  if (overview) commands.push(["HSET", ORDER_OVERVIEW_HASH_KEY, orderId, JSON.stringify(overview)]);
  const buyerEmailKey = orderEmailIndexKey(order.email);
  const userEmailKey = orderEmailIndexKey(order.userEmail);
  if (buyerEmailKey) commands.push(["LPUSH", buyerEmailKey, orderId]);
  if (userEmailKey && userEmailKey !== buyerEmailKey) commands.push(["LPUSH", userEmailKey, orderId]);
  try {
    const result = await redisPipeline(commands);
    const rows = pipelineResults(result);
    return rows.length === commands.length && rows.every((item) => !item?.error);
  } catch (e) { return false; }
}

export async function getOrderById(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const raw = await redisCmd(["GET", orderRecordKey(id)]);
  const stored = parseOrderJson(raw);
  if (stored) return stored.deleted ? null : stored;
  const legacy = await getLegacyOrderEntries();
  const found = legacy.find((entry) => normalizeOrderIdForStorage(entry.order?.orderId) === id);
  return found?.order && !found.order.deleted ? found.order : null;
}

// 单条订单 + 更新句柄:新记录 O(1) 直读(legacyIndex=null);仅旧列表订单才回退
// 扫有界 legacy 列表并带回 legacyIndex,保证 setOrderAt 时旧槽位同步(LSET)。
// 用于需要「按订单号找一单然后回写」的路由,避免 getAllOrdersWithIndex 全量扫描。
export async function getOrderEntryById(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const raw = await redisCmd(["GET", orderRecordKey(id)]);
  const stored = parseOrderJson(raw);
  if (stored) {
    return stored.deleted ? null : { index: { orderId: id, legacyIndex: null }, order: stored };
  }
  const legacy = await getLegacyOrderEntries();
  const found = legacy.find((entry) => normalizeOrderIdForStorage(entry.order?.orderId) === id);
  if (!found?.order || found.order.deleted) return null;
  return { index: { orderId: id, legacyIndex: found.index }, order: found.order };
}

export async function getOrdersByEmail(email, limit = 50) {
  const lower = normalizeEmailForStorage(email);
  if (!validEmail(lower)) return [];
  const ids = await getOrderIdsFromIndex(orderEmailIndexKey(lower), "0", String(Math.max(0, Number(limit || 50) - 1)));
  const indexed = (await getOrdersByIds(ids))
    .map((entry) => entry.order)
    .filter((order) =>
      order && !order.deleted &&
      ((order.email || "").toLowerCase() === lower || (order.userEmail || "").toLowerCase() === lower)
    );
  const legacy = (await getLegacyOrderEntries())
    .map((entry) => entry.order)
    .filter((order) => order && !order.deleted && ((order.email || "").toLowerCase() === lower || (order.userEmail || "").toLowerCase() === lower))
    .slice(0, Number(limit || 50));
  const seen = new Set();
  return [...indexed, ...legacy]
    .filter((order) => {
      const id = normalizeOrderIdForStorage(order?.orderId);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, Number(limit || 50));
}

// Read all stored orders, filtering tombstoned/deleted entries. New orders use
// permanent record keys; the legacy capped JSON list is still merged for old data.
export async function getAllOrders() {
  if (!redisConfig()) return [];
  const ids = await getOrderIdsFromIndex(ORDER_INDEX_KEY, "0", "-1");
  const indexed = await getOrdersByIds(ids);
  const legacy = await getLegacyOrderEntries();
  const seen = new Set();
  const merged = [];
  for (const entry of [...indexed.map((item) => ({ order: item.order })), ...legacy]) {
    const order = entry.order;
    const id = normalizeOrderIdForStorage(order?.orderId);
    if (!order || !id || order.deleted || seen.has(id)) continue;
    seen.add(id);
    merged.push(order);
  }
  return merged.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

// Read raw entries with update handles. New records update by orderId, while
// old legacy entries can still be updated by their original list index.
export async function getAllOrdersWithIndex() {
  if (!redisConfig()) return [];
  const ids = await getOrderIdsFromIndex(ORDER_INDEX_KEY, "0", "-1");
  const indexed = (await getOrdersByIds(ids)).map((entry) => ({
    index: { orderId: entry.orderId, legacyIndex: null },
    raw: entry.orderId,
    order: entry.order,
  }));
  const legacy = (await getLegacyOrderEntries()).map((entry) => ({
    index: { orderId: entry.order?.orderId || "", legacyIndex: entry.index },
    raw: entry.raw,
    order: entry.order,
  }));
  const seen = new Set();
  return [...indexed, ...legacy].filter((entry) => {
    const id = normalizeOrderIdForStorage(entry.order?.orderId);
    if (!entry.order || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Compact shadow index for the 10-second admin overview poll. The first read
// backfills historical orders once; subsequent order creates/updates maintain it.
export async function getOrderOverviewRows() {
  if (!redisConfig()) return [];
  const ready = await redisCmd(["GET", ORDER_OVERVIEW_READY_KEY]);
  if (ready === "1") {
    const values = await redisCmd(["HVALS", ORDER_OVERVIEW_HASH_KEY]);
    if (Array.isArray(values)) return values.map(parseOrderJson).filter(Boolean);
  }

  const orders = await getAllOrders();
  const snapshots = orders.map(orderOverviewSnapshot).filter(Boolean);
  let backfillOk = true;
  for (let offset = 0; offset < snapshots.length; offset += 100) {
    const commands = snapshots.slice(offset, offset + 100)
      .map((row) => ["HSET", ORDER_OVERVIEW_HASH_KEY, row.orderId, JSON.stringify(row)]);
    const result = await redisPipeline(commands);
    const rows = pipelineResults(result);
    if (rows.length !== commands.length || rows.some((item) => item?.error)) {
      backfillOk = false;
      break;
    }
  }
  if (backfillOk) await redisCmd(["SET", ORDER_OVERVIEW_READY_KEY, "1"]);
  return snapshots;
}

// Incremental USDT pending index: the chain scanner reads only unsettled USDT
// orders instead of loading every historical order on each poll.
export async function getPendingUsdtOrderEntries(limit = 500) {
  if (!redisConfig()) return [];
  const cutoff = Date.now() - 4 * 24 * 60 * 60 * 1000;
  await redisCmd(["ZREMRANGEBYSCORE", USDT_PENDING_ORDER_INDEX_KEY, "-inf", String(cutoff - 1)]);
  const ids = await redisCmd([
    "ZRANGEBYSCORE", USDT_PENDING_ORDER_INDEX_KEY, String(cutoff), "+inf",
    "LIMIT", "0", String(Math.max(1, Math.min(1000, Number(limit || 500)))),
  ]);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const entries = await getOrdersByIds(ids);
  const live = [];
  const fetchedIds = new Set(entries.map((entry) => normalizeOrderIdForStorage(entry.orderId)));
  const staleIds = ids
    .map(normalizeOrderIdForStorage)
    .filter((id) => id && !fetchedIds.has(id));
  for (const entry of entries) {
    if (isPendingUsdtOrder(entry.order)) {
      live.push({
        index: { orderId: entry.orderId, legacyIndex: null },
        raw: entry.orderId,
        order: entry.order,
      });
    } else {
      staleIds.push(entry.orderId);
    }
  }
  if (staleIds.length) {
    await redisCmd(["ZREM", USDT_PENDING_ORDER_INDEX_KEY, ...staleIds]);
  }
  return live;
}

// Update an order at a specific handle. New records update by orderId; legacy
// records also keep their old list slot in sync while being promoted to a record.
export async function setOrderAt(index, order) {
  const r = redisConfig();
  if (!r) return false;
  const handle = typeof index === "object" && index !== null ? index : { legacyIndex: index, orderId: order?.orderId };
  const orderId = normalizeOrderIdForStorage(handle.orderId || order?.orderId);
  if (orderId) {
    const commands = [["SET", orderRecordKey(orderId), JSON.stringify(order)]];
    // Promoted legacy records must enter the primary index before their old list copy can go stale.
    const indexPosition = await redisCmd(["LPOS", ORDER_INDEX_KEY, orderId]);
    if (indexPosition === null) commands.push(["RPUSH", ORDER_INDEX_KEY, orderId]);
    if (Number.isInteger(handle.legacyIndex) && handle.legacyIndex >= 0) {
      commands.push(["LSET", ORDERS_KEY, String(handle.legacyIndex), JSON.stringify(order)]);
    }
    commands.push(isPendingUsdtOrder(order)
      ? ["ZADD", USDT_PENDING_ORDER_INDEX_KEY, String(orderCreatedScore(order)), orderId]
      : ["ZREM", USDT_PENDING_ORDER_INDEX_KEY, orderId]);
    const quoteExpiryScore = pendingQuoteExpiryScore(order);
    commands.push(quoteExpiryScore
      ? ["ZADD", QUOTE_EXPIRY_ORDER_INDEX_KEY, String(quoteExpiryScore), orderId]
      : ["ZREM", QUOTE_EXPIRY_ORDER_INDEX_KEY, orderId]);
    const overview = orderOverviewSnapshot(order);
    commands.push(overview
      ? ["HSET", ORDER_OVERVIEW_HASH_KEY, orderId, JSON.stringify(overview)]
      : ["HDEL", ORDER_OVERVIEW_HASH_KEY, orderId]);
    const result = await redisPipeline(commands);
    const rows = pipelineResults(result);
    return rows.length === commands.length && rows.every((item) => !item?.error);
  }
  try {
    const res = await fetch(r.url + "/lset/" + encodeURIComponent(ORDERS_KEY) + "/" + index, {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "text/plain" },
      body: JSON.stringify(order),
    });
    return res.ok;
  } catch (e) { return false; }
}

// Soft-delete: replace the entry at index with a tombstone {deleted:true,orderId}
// getAllOrders filters these out so they vanish from queries.
export async function softDeleteOrderAt(index, orderId, meta = {}) {
  const now = new Date();
  const ok = await setOrderAt(index, {
    deleted: true,
    orderId,
    deletedAt: now.toISOString(),
    deletedAtBeijing: formatBeijingTime(now),
    ...meta,
  });
  // 记入删除集,供快速分页精确排除(失败不影响删除本身:快速路径仍会二次过滤 order.deleted)
  if (ok) { try { await redisCmd(["SADD", ORDER_DELETED_INDEX_KEY, normalizeOrderIdForStorage(orderId)]); } catch (e) {} }
  return ok;
}

async function ensureLegacyOrderIndex() {
  if (await redisCmd(["GET", ORDER_INDEX_MIGRATION_READY_KEY]) === "1") return true;
  const lockToken = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", ORDER_INDEX_MIGRATION_LOCK_KEY, lockToken, "EX", "60", "NX"]);
  if (locked !== "OK") return false;
  try {
    const legacy = await getLegacyOrderEntries();
    const existing = new Set(await getOrderIdsFromIndex(ORDER_INDEX_KEY, "0", "-1"));
    const commands = [];
    for (const entry of legacy) {
      const order = entry.order;
      const orderId = normalizeOrderIdForStorage(order?.orderId);
      if (!orderId || existing.has(orderId)) continue;
      existing.add(orderId);
      commands.push(["SET", orderRecordKey(orderId), JSON.stringify(order)]);
      commands.push(["RPUSH", ORDER_INDEX_KEY, orderId]);
      if (order?.deleted) commands.push(["SADD", ORDER_DELETED_INDEX_KEY, orderId]);
    }
    for (let offset = 0; offset < commands.length; offset += 100) {
      const batch = commands.slice(offset, offset + 100);
      const result = await redisPipeline(batch);
      const rows = pipelineResults(result);
      if (rows.length !== batch.length || rows.some((item) => item?.error)) return false;
    }
    return await redisCmd(["SET", ORDER_INDEX_MIGRATION_READY_KEY, "1"]) === "OK";
  } finally {
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await redisCmd(["EVAL", script, "1", ORDER_INDEX_MIGRATION_LOCK_KEY, lockToken]);
  }
}

// 快速分页(无筛选时用):只 GET 当前页的完整订单,不再全量拉取。
// 首次调用会把 legacy 列表补进增量索引(只增加影子记录,不删除旧数据),之后只取当前页正文。
export async function getOrdersPageFast(offset = 0, limit = 100) {
  if (!redisConfig()) return null;
  try {
    if (!await ensureLegacyOrderIndex()) return null;
    const allIds = await getOrderIdsFromIndex(ORDER_INDEX_KEY, "0", "-1"); // 已去重
    const deleted = new Set((await redisCmd(["SMEMBERS", ORDER_DELETED_INDEX_KEY])) || []);
    const liveIds = allIds.filter((id) => !deleted.has(id));
    const pageIds = liveIds.slice(offset, offset + limit);
    const fetched = await getOrdersByIds(pageIds);
    const byId = new Map(fetched.map((e) => [normalizeOrderIdForStorage(e.orderId), e.order]));
    // 保序 + 二次过滤 deleted(兼容历史未入删除集的删单)
    const orders = pageIds.map((id) => byId.get(id)).filter((o) => o && !o.deleted);
    return { orders, total: liveIds.length, hasMore: offset + limit < liveIds.length };
  } catch (e) { return null; }
}

// ── Password hashing (scrypt) ──
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const derived = scryptSync(password, salt, 32).toString("hex");
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch (e) { return false; }
}

// ── Session token signing (HMAC) ──
function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function authSecret() {
  const secret = process.env.AUTH_SECRET || "";
  if (secret && secret.length >= 32 && secret !== "dev-secret-change-me-in-production-please") return secret;
  if (isProductionRuntime()) {
    throw new Error("AUTH_SECRET must be set to a strong value in production");
  }
  return secret || "dev-secret-change-me-in-production-please";
}

export function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", authSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", authSecret()).update(data).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf-8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

export function generateCaptchaCode(length = 4) {
  const alphabet = "23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[randomInt(0, alphabet.length)];
  }
  return code;
}

function normalizeCaptchaCode(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase().slice(0, 12);
}

function captchaDigest(nonce, code) {
  return createHmac("sha256", authSecret())
    .update(`register-captcha|${nonce}|${normalizeCaptchaCode(code)}`)
    .digest("base64url");
}

export function signRegisterCaptcha(code, ttlMs = 5 * 60 * 1000) {
  const nonce = randomBytes(12).toString("base64url");
  return signSession({
    type: "register-captcha",
    nonce,
    hash: captchaDigest(nonce, code),
    exp: Date.now() + ttlMs,
  });
}

export function verifyRegisterCaptcha(token, answer) {
  const payload = verifySession(token);
  if (!payload || payload.type !== "register-captcha" || !payload.nonce || !payload.hash) return false;
  const expected = captchaDigest(payload.nonce, answer);
  try {
    return timingSafeEqual(Buffer.from(payload.hash), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// Cookie helpers
export function getCookieFromRequest(request, name) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCookieValue(name, value, maxAgeSec = 60 * 60 * 24 * 14) {
  const secure = isProductionRuntime() ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearCookieValue(name) {
  const secure = isProductionRuntime() ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function adminSessionFromRequest(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

export function adminActorFromSession(session) {
  return {
    staffId: Number(session?.staffId ?? 1),
    staffUsername: clean(session?.staffUsername || session?.username || "admin", 60),
  };
}

export function adminActorFromRequest(request) {
  return adminActorFromSession(adminSessionFromRequest(request));
}

export function isRootAdminSession(session) {
  return Number(session?.staffId || 0) === 1;
}

export function adminRoleFromSession(session) {
  if (isRootAdminSession(session) || session?.staffRoot) return "owner";
  const role = clean(session?.staffRole || session?.roleName || "operator", 40).toLowerCase();
  return role === "support" || role === "finance" ? role : "operator";
}

// 可按员工逐项覆盖的权限键(root 专属的 canManageStaff/canDeleteRecords 等不开放覆盖)。
export const STAFF_PERMISSION_KEYS = [
  "canEditOrders", "canViewUsers", "canBanUsers", "canAdjustBalance", "canViewBalanceLog",
  "canViewCodes", "canManageCodes", "canSendRedeemCodes", "canReviewWithdrawals",
  "canSendMail", "canManageStock",
];

export function adminPermissionProfile(session) {
  const role = adminRoleFromSession(session);
  const root = role === "owner";
  const operator = role === "operator";
  const support = role === "support";
  const finance = role === "finance";
  const profile = {
    role,
    root,
    canViewOrders: true,
    canEditOrders: root || operator || support,
    canViewUsers: root || finance,
    canManageUsers: root,
    canBanUsers: root,
    canDeleteUsers: root,
    canAdjustBalance: root || finance,
    canViewBalanceLog: root || finance,
    canViewCodes: root || operator || support,
    canManageCodes: root || operator,
    canSendRedeemCodes: root || operator || support,
    canReviewWithdrawals: root || finance,
    canSendMail: root || support || operator,
    canManageStaff: root,
    canDeleteRecords: root,
    canManageStock: root,
  };
  // 细粒度覆盖:登录时把员工记录里的 perms 覆盖嵌入会话(staffPerms);root 永远全权限不受覆盖。
  const overrides = session?.staffPerms;
  if (!root && overrides && typeof overrides === "object") {
    for (const key of STAFF_PERMISSION_KEYS) {
      if (typeof overrides[key] === "boolean") profile[key] = overrides[key];
    }
  }
  return profile;
}

// 只保留合法覆盖键(布尔),其余丢弃。
export function sanitizeStaffPerms(input) {
  const out = {};
  if (input && typeof input === "object") {
    for (const key of STAFF_PERMISSION_KEYS) {
      if (typeof input[key] === "boolean") out[key] = input[key];
    }
  }
  return out;
}

// ── 会话管理:强制下线(踢下线) ──
// lm:staff:kick:<id> = 毫秒时间戳;签发时间(iat)早于它的会话一律失效(middleware 对 /api/admin/* 强制)。
function staffKickKey(id) { return "lm:staff:kick:" + Number(id); }
export async function kickAdminStaff(id) {
  const ok = await redisCmd(["SET", staffKickKey(id), String(Date.now())]);
  return ok === "OK";
}
export async function getStaffKickTs(id) {
  const raw = await redisCmd(["GET", staffKickKey(id)]);
  return raw == null ? 0 : Number(raw) || 0;
}

// ── 后台两步验证(TOTP, RFC 6238)+ 登录日志 ──
// 防锁死三重保障:每账号自愿绑定;绑定时发一次性备用恢复码;env ADMIN_2FA_DISABLE=1 全局跳过。
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const s = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of s) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function totpCode(secretBase32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, "0");
}

// 验证 6 位动态码,允许 ±window 个 30 秒窗口(时钟漂移)。
export function verifyTotp(secretBase32, code, window = 1) {
  const clean6 = String(code || "").replace(/\D/g, "");
  if (clean6.length !== 6 || !secretBase32) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i += 1) {
    if (totpCode(secretBase32, counter + i) === clean6) return true;
  }
  return false;
}

// 2FA 秘密 AES-256-GCM 加密存储(密钥派生自 AUTH_SECRET)。
function twoFaKey() { return createHash("sha256").update(authSecret() + "|admin-2fa").digest(); }
export function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", twoFaKey(), iv);
  const ct = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return ["enc", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}
export function decryptTotpSecret(stored) {
  try {
    const [tag0, ivB64, tagB64, ctB64] = String(stored || "").split(":");
    if (tag0 !== "enc") return "";
    const decipher = createDecipheriv("aes-256-gcm", twoFaKey(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch (e) { return ""; }
}

// 2FA 状态存储:所有账号(含 root=1)统一存 lm:staff:2fa:<id> JSON
// { secretEnc, enabledAt, backupHashes: [sha256...] }
function staff2faKey(id) { return "lm:staff:2fa:" + Number(id); }
function backupCodeHash(code) {
  return createHash("sha256").update("backup|" + String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}
export async function getStaff2fa(id) {
  const raw = await redisCmd(["GET", staff2faKey(id)]);
  if (!raw) return null;
  try { const d = JSON.parse(raw); return d && d.secretEnc ? d : null; } catch (e) { return null; }
}
export async function setStaff2fa(id, data) {
  return (await redisCmd(["SET", staff2faKey(id), JSON.stringify(data)])) === "OK";
}
export async function clearStaff2fa(id) {
  await redisCmd(["DEL", staff2faKey(id)]);
  return true;
}
export function twoFaGloballyDisabled() {
  return process.env.ADMIN_2FA_DISABLE === "1";
}

// 生成 10 个一次性备用恢复码(明文只返回一次,存 sha256)。
export function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i += 1) {
    codes.push(randomBytes(5).toString("hex").toUpperCase()); // 10 位十六进制
  }
  return { codes, hashes: codes.map(backupCodeHash) };
}

// 校验登录提供的动态码:TOTP 或备用码(备用码命中即消耗)。
export async function verifyStaff2faCode(id, code) {
  const rec = await getStaff2fa(id);
  if (!rec) return { ok: true, skipped: true }; // 未绑定 → 不要求
  const secret = decryptTotpSecret(rec.secretEnc);
  if (secret && verifyTotp(secret, code)) return { ok: true, method: "totp" };
  const hash = backupCodeHash(code);
  const idx = Array.isArray(rec.backupHashes) ? rec.backupHashes.indexOf(hash) : -1;
  if (idx >= 0) {
    rec.backupHashes.splice(idx, 1); // 一次性:用过即废
    await setStaff2fa(id, rec);
    return { ok: true, method: "backup", remainingBackup: rec.backupHashes.length };
  }
  return { ok: false };
}

// ── 后台登录日志(成功/失败均记,含 IP/UA)──
const ADMIN_LOGIN_LOG_KEY = "lm:admin:login-log";
export async function pushAdminLoginLog({ username, staffId, ok, reason, ip, userAgent }) {
  const now = new Date();
  const entry = {
    id: makeId("LG"),
    username: clean(username, 60),
    staffId: Number(staffId || 0) || undefined,
    ok: Boolean(ok),
    reason: clean(reason || "", 60),
    ip: clean(ip, 80),
    userAgent: clean(userAgent, 300),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  try {
    const r = redisConfig();
    if (!r) return false;
    await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["LPUSH", ADMIN_LOGIN_LOG_KEY, JSON.stringify(entry)],
        ["LTRIM", ADMIN_LOGIN_LOG_KEY, "0", "299"],
      ]),
    });
    return true;
  } catch (e) { return false; }
}
export async function getAdminLoginLog(limit = 100) {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/lrange/" + encodeURIComponent(ADMIN_LOGIN_LOG_KEY) + "/0/" + (Math.min(300, limit) - 1), {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    return Array.isArray(data.result)
      ? data.result.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
      : [];
  } catch (e) { return []; }
}

export function adminActorLabel(actor) {
  const id = Number(actor?.staffId ?? 1);
  if (id === 0) return clean(actor?.staffUsername || "system", 60);
  return "工作人员 #" + id;
}

// Admin password check (constant-time)
export function checkAdminPassword(input) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || !input) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch (e) { return false; }
}

// User store helpers
function userKey(email) {
  return USERS_KEY + ":" + String(email).toLowerCase().trim();
}

const USER_EMAIL_SET_KEY = "liumeiti:users:emails";

// Add email to the registered-users SET so admin can list all users.
export async function registerUserEmail(email) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/sadd/" + encodeURIComponent(USER_EMAIL_SET_KEY) + "/" + encodeURIComponent(String(email).toLowerCase().trim()), {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token },
    });
    return res.ok;
  } catch (e) { return false; }
}

export async function listAllUserEmails() {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/smembers/" + encodeURIComponent(USER_EMAIL_SET_KEY), {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) { return []; }
}

export async function deleteUser(email) {
  const r = redisConfig();
  if (!r) return false;
  const lower = String(email).toLowerCase().trim();
  try {
    // 删除前读出上下级,清理返佣反向索引(从上级名下移除 + 删除自身下级集合)。
    const existing = await getUser(lower);
    if (existing) await deindexReferralRelation(existing);
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["DEL", USERS_KEY + ":" + lower],
        ["DEL", USERS_KEY + ":" + lower + ":tx"],
        ["SREM", USER_EMAIL_SET_KEY, lower],
      ]),
    });
    return res.ok;
  } catch (e) { return false; }
}

export function generateRandomUsername() {
  const adjectives = ["小", "微", "智", "灵", "云", "星", "晨", "夜", "闲", "静"];
  const nouns = ["猫", "狐", "雀", "鹿", "鲸", "狸", "兔", "熊", "鹭", "鸢"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const b = nouns[Math.floor(Math.random() * nouns.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${a}${b}${n}`;
}

export function generateRandomUserAvatarId() {
  return USER_AVATAR_IDS[randomInt(0, USER_AVATAR_IDS.length)] || normalizeUserAvatarId("");
}

export function validUserAvatarId(value) {
  return isUserAvatarId(value);
}

export function generatePaymentAdjustment() {
  const cents = randomInt(1, 50);
  const sign = randomInt(0, 2) === 0 ? -1 : 1;
  return roundMoney(sign * cents / 100);
}

const USDT_QUOTE_NONCE_PREFIX = "lm:usdt:quote-nonce:v4:";
const USDT_QUOTE_CLAIM_PREFIX = "lm:usdt:quote-claim:";

function safeQuoteId(value) {
  return clean(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

// Reserve a four-decimal USDT tail below 0.1 USDT. Redis NX prevents two live
// quotes from receiving the same payable amount during the quote window.
export async function reserveUsdtNonce(quoteId, ttlSec = 45 * 60) {
  const id = safeQuoteId(quoteId);
  if (!id || !redisConfig()) return 0;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const units = randomInt(1, 1000); // 0.0001 - 0.0999 USDT
    const result = await redisCmd([
      "SET", USDT_QUOTE_NONCE_PREFIX + units, id,
      "EX", String(Math.max(60, Number(ttlSec || 0))), "NX",
    ]);
    if (result === "OK") return units / 10000;
  }
  return 0;
}

export async function claimUsdtQuote(quoteId, orderId, ttlSec = 4 * 24 * 60 * 60) {
  const id = safeQuoteId(quoteId);
  const order = normalizeOrderIdForStorage(orderId);
  if (!id || !order || !redisConfig()) return false;
  const result = await redisCmd([
    "SET", USDT_QUOTE_CLAIM_PREFIX + id, order,
    "EX", String(Math.max(300, Number(ttlSec || 0))), "NX",
  ]);
  return result === "OK";
}

export async function releaseUsdtQuote(quoteId, orderId) {
  const id = safeQuoteId(quoteId);
  const order = normalizeOrderIdForStorage(orderId);
  if (!id || !order || !redisConfig()) return false;
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  return Number(await redisCmd(["EVAL", script, "1", USDT_QUOTE_CLAIM_PREFIX + id, order]) || 0) === 1;
}

function paymentQuoteSecret() {
  return process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti-payment-quote-local";
}

export function signPaymentQuote(payload) {
  const data = Buffer.from(JSON.stringify(payload || {})).toString("base64url");
  const sig = createHmac("sha256", paymentQuoteSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyPaymentQuote(token, expectedPaymentMethod = "") {
  if (!token || typeof token !== "string") return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", paymentQuoteSecret()).update(data).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf-8"));
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    const paymentMethod = payload.paymentMethod === "usdt" ? "usdt" : payload.paymentMethod === "alipay" ? "alipay" : "";
    if (!paymentMethod || (expectedPaymentMethod && paymentMethod !== expectedPaymentMethod)) return null;
    const adjustment = roundMoney(payload.paymentAdjustment);
    const rawUsdtPrecision = payload.usdtPrecision == null ? 6 : Number(payload.usdtPrecision);
    if (paymentMethod === "usdt" && rawUsdtPrecision !== 4 && rawUsdtPrecision !== 6) return null;
    const usdtPrecision = paymentMethod === "usdt" ? rawUsdtPrecision : 0;
    const usdtScale = 10 ** (usdtPrecision || 6);
    const usdtNonce = Math.round(Number(payload.usdtNonce || 0) * usdtScale) / usdtScale;
    if (paymentMethod === "usdt") {
      const minNonce = usdtPrecision === 4 ? 0.0001 : 0.000001;
      const maxNonce = usdtPrecision === 4 ? 0.0999 : 0.099999;
      if (adjustment !== 0 || usdtNonce < minNonce || usdtNonce > maxNonce || !safeQuoteId(payload.quoteId)) return null;
    } else if (usdtNonce !== 0 || Math.abs(adjustment) < 0.01 || Math.abs(adjustment) > 0.49) {
      return null;
    }
    const issuedAt = Number(payload.issuedAt || 0);
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(exp) || issuedAt <= 0 || exp <= issuedAt) return null;
    return { ...payload, paymentMethod, paymentAdjustment: adjustment, usdtNonce, usdtPrecision, quoteId: safeQuoteId(payload.quoteId) };
  } catch (e) { return null; }
}

export function validUsername(value) {
  // 2-20 chars, allow Chinese / English letters / digits / underscore
  return /^[一-龥A-Za-z0-9_]{2,20}$/.test(String(value || "").trim());
}

export async function getUser(email) {
  const r = redisConfig();
  if (!r) return null;
  try {
    const res = await fetch(r.url + "/get/" + encodeURIComponent(userKey(email)), {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    if (!data.result) return null;
    try { return JSON.parse(data.result); } catch (e) { return null; }
  } catch (e) { return null; }
}

export async function setUser(email, user) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/set/" + encodeURIComponent(userKey(email)), {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "text/plain" },
      body: JSON.stringify(user),
    });
    return res.ok;
  } catch (e) { return false; }
}

// ── Balance transactions ──
function txKey(email) { return USERS_KEY + ":" + String(email).toLowerCase().trim() + ":tx"; }

// Global admin-side ledger of every balance adjustment across all users.
// Last 500 entries kept (LTRIM cap). Newest first.
const ADMIN_BAL_LOG_KEY = "liumeiti:admin:balance-log";

export async function pushAdminBalanceLog(entry) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["LPUSH", ADMIN_BAL_LOG_KEY, JSON.stringify(entry)],
        ["LTRIM", ADMIN_BAL_LOG_KEY, "0", "499"],
      ]),
    });
    return res.ok;
  } catch (e) { return false; }
}

export async function getAdminBalanceLog() {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/lrange/" + encodeURIComponent(ADMIN_BAL_LOG_KEY) + "/0/499", {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    if (!res.ok || data.error) return [];
    return Array.isArray(data.result)
      ? data.result.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
      : [];
  } catch (e) { return []; }
}

export async function deleteAdminBalanceLogEntries(ids, actor = null) {
  const idSet = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => clean(id, 120))
    .filter(Boolean));
  if (idSet.size === 0) return { ok: false, error: "no_ids" };
  const entries = await getAdminBalanceLog();
  const removed = entries.filter((entry) => idSet.has(clean(entry.id, 120)));
  const remaining = entries.filter((entry) => !idSet.has(clean(entry.id, 120)));
  if (removed.length === 0) return { ok: false, error: "not_found" };
  const commands = [
    ["DEL", ADMIN_BAL_LOG_KEY],
    ...remaining.map((entry) => ["RPUSH", ADMIN_BAL_LOG_KEY, JSON.stringify(entry)]),
  ];
  const saved = await redisPipeline(commands);
  if (!saved) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "balance_log_delete",
    actor,
    target: "balance-log:" + removed.length,
    detail: { ids: Array.from(idSet), deletedCount: removed.length },
  });
  return {
    ok: true,
    deletedCount: removed.length,
    notFound: Array.from(idSet).filter((id) => !removed.some((entry) => clean(entry.id, 120) === id)),
  };
}

export async function addBalanceTx(email, tx) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["LPUSH", txKey(email), JSON.stringify(tx)],
        ["LTRIM", txKey(email), "0", "199"],
      ]),
    });
    return res.ok;
  } catch (e) { return false; }
}

export async function getBalanceTxs(email) {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/lrange/" + encodeURIComponent(txKey(email)) + "/0/199", {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    if (!res.ok || data.error) return [];
    return Array.isArray(data.result)
      ? data.result.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
      : [];
  } catch (e) { return []; }
}

// ── Reset code (forgot password) — 10 min TTL ──
function resetKey(email) { return "liumeiti:reset:" + String(email).toLowerCase().trim(); }

export async function setResetCode(email, code, ttlSec = 600) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/set/" + encodeURIComponent(resetKey(email)) + "/" + encodeURIComponent(code) + "?EX=" + ttlSec, {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token },
    });
    return res.ok;
  } catch (e) { return false; }
}

export async function getResetCode(email) {
  const r = redisConfig();
  if (!r) return null;
  try {
    const res = await fetch(r.url + "/get/" + encodeURIComponent(resetKey(email)), {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    return data.result ? String(data.result) : null;
  } catch (e) { return null; }
}

export async function deleteResetCode(email) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/del/" + encodeURIComponent(resetKey(email)), {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token },
    });
    return res.ok;
  } catch (e) { return false; }
}

// Shared email delivery helpers. Resend SMTP/API is the default path.
const EMAIL_SUPPORT_MARKER = "data-lm-support-contacts";
const EMAIL_SETTINGS_KEY = "lm:settings";
let emailSupportCache = null;
let emailSupportCacheUntil = 0;

function escapeEmailValue(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emailLocale(args) {
  if (args?.locale === "en" || args?.locale === "zh") return args.locale;
  const sample = `${args?.subject || ""}\n${args?.text || ""}`;
  return /[\u3400-\u9fff]/.test(sample) ? "zh" : "en";
}

function emailSupportContacts(support) {
  return [
    { label: "QQ", ...(support?.qq || {}) },
    { label: "WhatsApp", ...(support?.whatsapp || {}) },
    { label: "Telegram", ...(support?.telegram || {}) },
  ].filter((item) => item.value && item.href);
}

function emailSupportFooter(support, locale) {
  const links = emailSupportContacts(support).map((item) => (
    `<a href="${escapeEmailValue(item.href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:3px 8px 3px 0;color:#0f766e;font-size:12px;font-weight:800;text-decoration:underline;white-space:nowrap;">${escapeEmailValue(item.label)} ${escapeEmailValue(item.value)}</a>`
  )).join("");
  const label = locale === "en" ? "Customer support" : "在线客服";
  return `<!-- ${EMAIL_SUPPORT_MARKER} --><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr><td align="center" style="padding:0 12px 22px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;border-collapse:collapse;"><tr><td style="padding:15px 4px 0;border-top:1px solid #dbe4e8;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;"><div style="margin-bottom:4px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">${label}</div><div>${links}</div></td></tr></table></td></tr></table>`;
}

function emailSupportText(support, locale) {
  const heading = locale === "en" ? "Customer support" : "在线客服";
  return [heading, ...emailSupportContacts(support).map((item) => `${item.label} ${item.value}: ${item.href}`)].join("\n");
}

function appendHtmlFooter(html, footer) {
  const closingIndex = html.toLowerCase().lastIndexOf("</body>");
  return closingIndex >= 0
    ? `${html.slice(0, closingIndex)}${footer}${html.slice(closingIndex)}`
    : `${html}${footer}`;
}

export function applyEmailSupportContacts(args, support) {
  const locale = emailLocale(args);
  const contacts = emailSupportContacts(support);
  if (contacts.length !== 3) return { ...args };

  let html = String(args?.html || "");
  if (!html && args?.text) {
    html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f8;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;"><div style="max-width:580px;margin:0 auto;white-space:pre-wrap;font-size:14px;line-height:1.7;">${escapeEmailValue(args.text)}</div></body></html>`;
  }
  const hasHtmlContacts = html.includes(EMAIL_SUPPORT_MARKER)
    || contacts.every((item) => html.includes(escapeEmailValue(item.href)));
  if (html && !hasHtmlContacts) html = appendHtmlFooter(html, emailSupportFooter(support, locale));

  let text = String(args?.text || "");
  const hasTextContacts = contacts.every((item) => text.includes(item.href));
  if (!hasTextContacts) text = `${text}${text ? "\n\n" : ""}${emailSupportText(support, locale)}`;
  return { ...args, html, text };
}

async function currentEmailSupport() {
  if (emailSupportCache && Date.now() < emailSupportCacheUntil) return emailSupportCache;
  let overrides = {};
  try {
    const raw = await redisCmd(["GET", EMAIL_SETTINGS_KEY]);
    overrides = typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch (e) { overrides = {}; }
  emailSupportCache = mergeSettings(overrides).support;
  emailSupportCacheUntil = Date.now() + 15000;
  return emailSupportCache;
}

function mailFromAddress() {
  return clean(process.env.MAIL_FROM || process.env.SMTP_FROM || "info@liumeiti.vip", 200);
}

function mailFromName(value) {
  return clean(value || process.env.MAIL_FROM_NAME || process.env.BRAND_NAME || "冒央会社", 120)
    .replace(/[<>\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMailFrom(name, address) {
  const safeName = mailFromName(name);
  return safeName ? `${safeName} <${address}>` : address;
}

async function readEmailApiError(res) {
  try {
    const data = await res.json();
    return data?.message || data?.error || JSON.stringify(data);
  } catch (e) {
    try { return await res.text(); } catch (er) { return res.statusText || "request_failed"; }
  }
}

function resendTag(value, fallback = "") {
  return clean(value || fallback, 120).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

async function sendViaResend({
  to, subject, text, html, fromName, marketing = false, category = "", relatedType = "", relatedId = "",
  scheduledAt = "", idempotencyKey = "",
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = mailFromAddress();
  if (!apiKey || !from || !to) return { ok: false, reason: "resend_or_to_missing" };
  if (!validEmail(from)) return { ok: false, reason: "invalid_mail_from" };
  const recipients = Array.isArray(to) ? to : [to];
  const headers = marketing ? { "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>` } : undefined;
  const payload = {
    from: formatMailFrom(fromName, from),
    to: recipients,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    tags: [
      { name: "category", value: resendTag(category, marketing ? "marketing" : "transactional") },
      ...(relatedType ? [{ name: "related_type", value: resendTag(relatedType) }] : []),
      ...(relatedId ? [{ name: "related_id", value: resendTag(relatedId) }] : []),
    ],
  };

  async function attemptSend(attempt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": clean(idempotencyKey, 256) } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: await readEmailApiError(res), code: res.status, attempt };
      const data = await res.json();
      return {
        ok: true,
        messageId: data?.id || "",
        provider: "resend",
        attempt,
        scheduledAt: scheduledAt || "",
        scheduled: Boolean(scheduledAt),
        rateLimitRemaining: res.headers.get("ratelimit-remaining") || "",
      };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: e.message, code: e.name || "fetch_error", attempt };
    }
  }

  const r1 = await attemptSend(1);
  if (r1.ok) return r1;
  console.warn(`[email:resend] attempt 1 failed (${r1.code || "?"}): ${r1.error}; retrying...`);
  await new Promise((res) => setTimeout(res, 1200));
  const r2 = await attemptSend(2);
  if (r2.ok) return r2;
  console.error(`[email:resend] both attempts failed for ${recipients.join(",")}: ${r2.error}`);
  return { ok: false, provider: "resend", reason: "send_failed_after_retry", error: r2.error, code: r2.code };
}

function smtpTransportConfig(prefix = "SMTP") {
  const host = process.env[`${prefix}_HOST`];
  const user = process.env[`${prefix}_USER`];
  const pass = process.env[`${prefix}_PASS`];
  const port = Number(process.env[`${prefix}_PORT`]) || 587;
  const from = clean(process.env[`${prefix}_FROM`] || mailFromAddress() || user, 200);
  return {
    host,
    user,
    pass,
    port,
    from,
    provider: prefix === "FALLBACK_SMTP" ? "smtp2go" : "smtp",
  };
}

export function shouldFallbackToBackupSmtp(args, result) {
  if (result?.ok || args?.marketing || args?.scheduledAt) return false;
  if (clean(args?.category, 40).toLowerCase() === "marketing") return false;
  const code = Number(result?.code || 0);
  const detail = clean(`${result?.reason || ""} ${result?.error || ""}`, 500).toLowerCase();
  return code === 429
    || detail.includes("daily_quota_exceeded")
    || detail.includes("monthly_quota_exceeded");
}

async function sendViaSmtp({ to, subject, text, html, fromName, marketing = false }, config = smtpTransportConfig()) {
  const { host, user, pass, port, from, provider } = config;
  const brandName = fromName || process.env.BRAND_NAME || "冒央会社";
  if (!host || !user || !pass || !from || !to) {
    return { ok: false, provider, reason: "smtp_or_to_missing" };
  }
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch (e) { return { ok: false, provider, reason: "nodemailer_import_failed" }; }
  const secure = port === 465;
  const messageId = `<lm-${randomBytes(16).toString("hex")}@liumeiti.vip>`;
  // 群发/营销邮件:普通优先级(高优先级=垃圾信号)+ List-Unsubscribe 头(Gmail/Yahoo 对群发的进箱硬要求)。
  // 事务邮件(验证码/订单)保持 high 以求快达。
  const priority = marketing ? "normal" : "high";
  const extraHeaders = marketing ? { "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>` } : undefined;

  async function attemptSend(attempt) {
    const transporter = nodemailer.createTransport({
      host, port, secure, auth: { user, pass },
      requireTLS: !secure,
      tls: { minVersion: "TLSv1.2" },
      // Tighter timeouts so failures are detected quickly and we can retry
      connectionTimeout: 10000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
      // Skip identity verification on transports for faster connect
    });
    try {
      const info = await transporter.sendMail({
        from: formatMailFrom(mailFromName(brandName), from),
        to, subject, text, html,
        messageId,
        priority,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      try { transporter.close(); } catch (e) {}
      return { ok: true, messageId: info.messageId || messageId, provider, attempt };
    } catch (e) {
      try { transporter.close(); } catch (er) {}
      return { ok: false, provider, error: e.message, code: e.code, response: e.response, attempt };
    }
  }

  // First attempt
  const r1 = await attemptSend(1);
  if (r1.ok) return r1;
  console.warn(`[email] attempt 1 failed (${r1.code || "?"}): ${r1.error}; retrying...`);
  // Wait 1.5s then retry once
  await new Promise((res) => setTimeout(res, 1500));
  const r2 = await attemptSend(2);
  if (r2.ok) {
    console.log(`[email] succeeded on retry to ${to}`);
    return r2;
  }
  console.error(`[email] both attempts failed for ${to}: ${r2.error}`);
  return { ok: false, provider, reason: "send_failed_after_retry", error: r2.error, code: r2.code };
}

// ── Account extensions: coupons, transfers, redeem codes, withdrawals ──
// Send a generic email. Resend is the default provider; SMTP requires explicit
// EMAIL_PROVIDER=smtp and is kept only as an emergency fallback.
// 关键邮件发送失败 → Telegram 运维告警(10 分钟节流防告警风暴)。
// 订单确认/报价/密码修正/验证码等全部经 sendSimpleEmail,此处是唯一出口:
// 客户收不到关键邮件(如修正链接)= 订单死锁,必须即时知道而不是等着翻邮件日志。
async function alertMailFailure(prepared, result) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const throttled = (await redisCmd(["SET", "lm:mail-alert:throttle", "1", "NX", "EX", "600"])) !== "OK";
    if (throttled) return;
    const text = [
      "⚠️ 邮件发送失败",
      `收件人: ${clean(prepared?.to, 120)}`,
      `主题: ${clean(prepared?.subject, 120)}`,
      `原因: ${clean(result?.reason || result?.error || "unknown", 160)}`,
      "(10 分钟内的后续失败不再重复提醒;请检查邮件服务,并在后台「邮件」日志确认/补发)",
    ].join("\n");
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {}
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export async function sendSimpleEmail(args) {
  const prepared = applyEmailSupportContacts(args, args?.support || await currentEmailSupport());
  const provider = String(process.env.EMAIL_PROVIDER || "resend").toLowerCase();
  let result;
  if (provider === "smtp") result = await sendViaSmtp(prepared);
  else if (process.env.RESEND_API_KEY) result = await sendViaResend(prepared);
  else result = { ok: false, provider: "resend", reason: "resend_api_key_missing" };
  if (provider !== "smtp" && shouldFallbackToBackupSmtp(prepared, result)) {
    const primaryResult = result;
    const fallbackResult = await sendViaSmtp(prepared, smtpTransportConfig("FALLBACK_SMTP"));
    if (fallbackResult.ok) {
      result = {
        ...fallbackResult,
        fallback: true,
        primaryProvider: "resend",
        primaryError: primaryResult.error || primaryResult.reason || "resend_quota_exceeded",
      };
    } else {
      result = {
        ...primaryResult,
        fallbackAttempted: true,
        fallbackProvider: "smtp2go",
        fallbackError: fallbackResult.reason || fallbackResult.error || "smtp_fallback_failed",
      };
    }
  }
  const trackingTasks = [];
  try {
    const { registerEmailDelivery } = await import("./_mail-delivery.js");
    trackingTasks.push(registerEmailDelivery({ args: prepared, result }));
  } catch (e) {}
  try {
    const { recordHealthStatus } = await import("./_health.js");
    trackingTasks.push(recordHealthStatus("resend", {
      status: result?.fallback ? "warning" : (result?.ok ? "ok" : "error"),
      summary: result?.fallback
        ? "Resend 额度受限，事务邮件已由 SMTP2GO 提交"
        : (result?.ok ? "最近一封邮件已提交发送" : "最近一次发信失败"),
      error: result?.ok ? "" : (result?.reason || result?.error || "send_failed"),
      metrics: {
        provider: result?.provider || provider,
        fallback: Boolean(result?.fallback || result?.fallbackAttempted),
        attempt: Number(result?.attempt || 1),
      },
    }));
  } catch (e) {}
  if (trackingTasks.length) await settleWithin(Promise.allSettled(trackingTasks), 1500);
  if (!result?.ok) await alertMailFailure(prepared, result);
  return result;
}

export const REGISTER_COUPON_AMOUNT = 8.88;
export const WITHDRAWAL_STATUS_LABEL = {
  pending: "待审核",
  processing: "提现中",
  success: "提现成功",
  failed: "审核失败",
};

const REDEEM_LIST_KEY = "liumeiti:redeem-codes";
const REDEEM_BATCH_LIST_KEY = "liumeiti:redeem-code-batches";
const WITHDRAWAL_LIST_KEY = "liumeiti:withdrawals";
const ADMIN_STAFF_KEY = "liumeiti:admin:staff";
const ADMIN_ACTION_LOG_KEY = "liumeiti:admin:action-log";
const ADMIN_MAIL_LOG_KEY = "liumeiti:admin:mail-log";

export const REDEEM_SERVICE_PRODUCTS = {
  spotify: { label: "Spotify", amount: 128, hasPlan: true },
  netflix: { label: "Netflix", amount: 168, hasPlan: true },
  disney: { label: "Disney+", amount: 108, hasPlan: true },
  max: { label: "HBO Max", amount: 148, hasPlan: true },
  rocket: { label: "机场节点", amount: 128, hasPlan: true },
  ai: { label: "AI 会员", amount: 198, hasPlan: true },
};

export const ROCKET_PLANS = {
  basic: { id: "basic", label: "普通套餐", amount: 128, desc: "50 GB/月真实流量" },
  pro: { id: "pro", label: "高级套餐", amount: 198, desc: "100 GB/月真实流量" },
  luxury: { id: "luxury", label: "豪华套餐", amount: 398, desc: "200 GB/月真实流量" },
  unlimited: { id: "unlimited", label: "无限套餐", amount: 698, desc: "无限流量" },
  trial: { id: "trial", label: "5元10GB测试", amount: 5, desc: "10 GB测试流量", unit: "次", cycle: "次", requiresLogin: false, onePerUser: false },
};
export const PRODUCT_PLANS = {
  spotify: {
    member: { id: "member", label: "家庭成员", amount: 128, desc: "加入欧美日高价区家庭计划，成员席位" },
    individual: { id: "individual", label: "个人订阅", amount: 388, desc: "欧美日高价区个人订阅，独立使用" },
    duo: { id: "duo", label: "双人订阅", amount: 488, desc: "可邀请 1 个账号免费享用订阅" },
    family: { id: "family", label: "家庭套餐", amount: 588, desc: "可邀请 5 个账号免费享用订阅" },
  },
  netflix: {
    seat: { id: "seat", label: "单独车位", amount: 168, desc: "4K 杜比独立用户档案，可上锁" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  disney: {
    seat: { id: "seat", label: "单独车位", amount: 108, desc: "4K 杜比独立用户档案，互不干扰" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 7 个用户档案/车位" },
  },
  max: {
    seat: { id: "seat", label: "单独车位", amount: 148, desc: "4K 杜比独立用户档案，稳定售后" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  rocket: ROCKET_PLANS,
  ai: {
    "gpt-plus": { id: "gpt-plus", label: "GPT Plus", amount: 198, unit: "三个月", desc: "ChatGPT Plus 官方会员 · 三个月" },
    "gpt-pro": { id: "gpt-pro", label: "GPT 5x Pro", amount: 998, unit: "三个月", desc: "ChatGPT Pro 5x 高额度 · 三个月" },
    "gpt-20x-pro": { id: "gpt-20x-pro", label: "GPT 20x Pro", amount: 1888, unit: "三个月", desc: "ChatGPT Pro 20x 超大额度 · 三个月" },
    "claude-pro": { id: "claude-pro", label: "Claude Pro", amount: 198, unit: "三个月", desc: "Claude Pro 官方会员 · 三个月" },
    "claude-max": { id: "claude-max", label: "Claude 5x Max", amount: 998, unit: "三个月", desc: "Claude Max 5x 高额度 · 三个月" },
    "claude-20x-max": { id: "claude-20x-max", label: "Claude 20x Max", amount: 1888, unit: "三个月", desc: "Claude Max 20x 超大额度 · 三个月" },
  },
};
export const DEFAULT_PRODUCT_PLANS = {
  spotify: "member",
  netflix: "seat",
  disney: "seat",
  max: "seat",
  rocket: "basic",
  ai: "gpt-plus",
};
export const DEFAULT_ROCKET_PLAN = DEFAULT_PRODUCT_PLANS.rocket;

// ── AI 会员库存（每个规格独立整数计数键；键不存在 = 不限，存在 = 受限）──
export const AI_STOCK_PLAN_IDS = ["gpt-plus", "gpt-pro", "gpt-20x-pro", "claude-pro", "claude-max", "claude-20x-max"];

// ── 通用库存(任意 service+plan) ──
// Redis 键 liumeiti:stock:<service>:<planId>;null/无键 = 不限;整数≥0 = 受限剩余。
// 注:AI 的键 liumeiti:stock:ai:<plan> 正是该方案的特例 → 历史 AI 库存数据零迁移直接沿用。
function stockKey(service, planId) { return "liumeiti:stock:" + clean(service, 40) + ":" + clean(planId, 40); }

// value: ""/null → 删键(不限);整数≥0 → 设值
export async function setStock(service, planId, value) {
  const key = stockKey(service, planId);
  if (value === "" || value == null) { await redisCmd(["DEL", key]); return true; }
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return false;
  await redisCmd(["SET", key, String(n)]);
  return true;
}

// 原子占用一个库存:未配置/Redis 不可用 → 放行(fail-soft);售罄 → 回滚并拒绝
export async function reserveStock(service, planId) {
  const key = stockKey(service, planId);
  const cur = await redisCmd(["GET", key]);
  if (cur == null) return { ok: true, unlimited: true };
  const next = await redisCmd(["DECRBY", key, "1"]);
  if (next == null) return { ok: true, unlimited: true };
  if (Number(next) < 0) { await redisCmd(["INCRBY", key, "1"]); return { ok: false, soldOut: true, remaining: 0 }; }
  return { ok: true, remaining: Number(next) };
}

// 返还一个库存(仅对受限规格生效)
export async function restoreStock(service, planId) {
  const key = stockKey(service, planId);
  const cur = await redisCmd(["GET", key]);
  if (cur == null) return false;
  await redisCmd(["INCRBY", key, "1"]);
  return true;
}

// 给定目录,批量读每个规格的库存数。返回 { "<service>:<planId>": number|null }(null=不限)。
export async function getCatalogStockMap(catalog) {
  const out = {};
  const pairs = [];
  for (const p of (catalog || [])) for (const pl of (p.plans || [])) pairs.push([p.key, pl.id]);
  await Promise.all(pairs.map(async ([svc, pid]) => {
    const raw = await redisCmd(["GET", stockKey(svc, pid)]);
    out[svc + ":" + pid] = raw == null ? null : Math.max(0, Math.floor(Number(raw) || 0));
  }));
  return out;
}

// 售罄表 { "<service>:<planId>": true }(仅受限且<=0)
export async function getCatalogSoldOutMap(catalog) {
  const stock = await getCatalogStockMap(catalog);
  const out = {};
  for (const [k, v] of Object.entries(stock)) if (v != null && v <= 0) out[k] = true;
  return out;
}

// ── AI 库存:保留为通用库存(service="ai")的封装,旧调用方不变 ──
export async function getAiStockMap() {
  const map = {};
  await Promise.all(AI_STOCK_PLAN_IDS.map(async (id) => {
    const raw = await redisCmd(["GET", stockKey("ai", id)]);
    map[id] = raw == null ? null : Math.max(0, Math.floor(Number(raw) || 0));
  }));
  return map;
}
export async function getAiSoldOutMap() {
  const stock = await getAiStockMap();
  const out = {};
  AI_STOCK_PLAN_IDS.forEach((id) => { out[id] = stock[id] != null && stock[id] <= 0; });
  return out;
}
export async function setAiStock(planId, value) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return false;
  return setStock("ai", planId, value);
}
export async function reserveAiStock(planId) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return { ok: true, unlimited: true };
  return reserveStock("ai", planId);
}
export async function restoreAiStock(planId) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return false;
  return restoreStock("ai", planId);
}

// ── USDT 结算汇率：美元兑人民币，每日自动更新，保留两位小数；失败回退 6.85 ──
export const USDT_RATE_FALLBACK = 6.85;
const USDT_RATE_KEY = "liumeiti:fx:usd-cny";
let _usdtRateCache = { rate: 0, date: "" };

function fxDateKeyBeijing() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fetchUsdCnyRate() {
  const sources = [
    { url: "https://open.er-api.com/v6/latest/USD", pick: (d) => d && d.rates && d.rates.CNY },
    { url: "https://api.frankfurter.app/latest?from=USD&to=CNY", pick: (d) => d && d.rates && d.rates.CNY },
  ];
  for (const s of sources) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(s.url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const n = Math.round(Number(s.pick(data)) * 100) / 100;
      if (Number.isFinite(n) && n >= 3 && n <= 15) return n;
    } catch (e) {}
  }
  return 0;
}

export async function getUsdtRate() {
  const today = fxDateKeyBeijing();
  if (_usdtRateCache.rate > 0 && _usdtRateCache.date === today) return _usdtRateCache.rate;
  const cached = await getJsonKey(USDT_RATE_KEY);
  if (cached && cached.date === today && Number(cached.rate) > 0) {
    _usdtRateCache = { rate: Number(cached.rate), date: today };
    return _usdtRateCache.rate;
  }
  const fresh = await fetchUsdCnyRate();
  if (fresh > 0) {
    _usdtRateCache = { rate: fresh, date: today };
    await setJsonKey(USDT_RATE_KEY, { rate: fresh, date: today });
    return fresh;
  }
  if (cached && Number(cached.rate) > 0) {
    _usdtRateCache = { rate: Number(cached.rate), date: cached.date || today };
    return Number(cached.rate);
  }
  return USDT_RATE_FALLBACK;
}

function resolveRocketPlanInternal(value) {
  return resolveProductPlanInternal("rocket", value);
}

function resolveProductPlanInternal(productKey, value) {
  const plans = PRODUCT_PLANS[productKey];
  if (!plans) return null;
  const id = clean(value, 20);
  const aliases = productKey === "rocket" ? { single: "basic" } : {};
  const planId = aliases[id] || id;
  return plans[planId] ? plans[planId] : plans[DEFAULT_PRODUCT_PLANS[productKey]];
}

function redeemCodeKey(code) { return "liumeiti:redeem-code:" + normalizeRedeemCode(code); }
function redeemBatchKey(id) { return "liumeiti:redeem-code-batch:" + clean(id, 80); }
function withdrawalKey(id) { return "liumeiti:withdrawal:" + clean(id, 80); }

export function roundMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function makeId(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + randomBytes(4).toString("hex").toUpperCase();
}

export function normalizeRedeemCode(value) {
  return clean(value, 80).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const REDEEM_GUARD_LIMIT = 5;
const REDEEM_GUARD_WINDOW_SECONDS = 5 * 60;

export function clientIpFromRequest(request) {
  const forwarded = request?.headers?.get("x-forwarded-for") || "";
  return clean(forwarded.split(",")[0] || request?.headers?.get("x-real-ip") || "unknown", 80) || "unknown";
}

export function clientUserAgentFromRequest(request) {
  return clean(request?.headers?.get("user-agent") || "", 500);
}

function clientGuardFingerprint(request) {
  const ip = clientIpFromRequest(request);
  const ua = clean(request?.headers?.get("user-agent") || "unknown", 160);
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti-rate-limit-local";
  return createHmac("sha256", secret).update(`${ip}|${ua}`).digest("hex").slice(0, 32);
}

function rateLimitFingerprint(request, identity = "") {
  const ip = clientIpFromRequest(request);
  const ua = clean(request?.headers?.get("user-agent") || "unknown", 160);
  const subject = clean(identity, 200).toLowerCase();
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti-rate-limit-local";
  return createHmac("sha256", secret).update(`${ip}|${ua}|${subject}`).digest("hex").slice(0, 40);
}

function rateLimitIdentityFingerprint(identity = "") {
  const subject = clean(identity || "unknown", 500);
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti-rate-limit-local";
  return createHmac("sha256", secret).update(subject).digest("hex").slice(0, 40);
}

export async function checkRateLimit(request, { namespace, limit = 10, windowSec = 600, identity = "" } = {}) {
  const r = redisConfig();
  if (!r) return { ok: true, key: "", count: 0, limit, retryAfter: 0 };
  const safeNamespace = clean(namespace || "default", 80).replace(/[^a-z0-9:_-]/gi, "");
  const key = "liumeiti:rate:" + safeNamespace + ":" + rateLimitFingerprint(request, identity);
  const count = Number(await redisCmd(["INCR", key]) || 0);
  if (count === 1) await redisCmd(["EXPIRE", key, String(windowSec)]);
  if (count > limit) {
    const ttl = Number(await redisCmd(["TTL", key]) || windowSec);
    return {
      ok: false,
      key,
      count,
      limit,
      retryAfter: ttl > 0 ? ttl : windowSec,
    };
  }
  return { ok: true, key, count, limit, retryAfter: 0 };
}

export async function checkIdentityRateLimit({ namespace, identity, limit = 10, windowSec = 600 } = {}) {
  const r = redisConfig();
  if (!r) return { ok: true, key: "", count: 0, limit, retryAfter: 0 };
  const safeNamespace = clean(namespace || "default", 80).replace(/[^a-z0-9:_-]/gi, "");
  const key = "liumeiti:rate:" + safeNamespace + ":" + rateLimitIdentityFingerprint(identity);
  const count = Number(await redisCmd(["INCR", key]) || 0);
  if (count === 1) await redisCmd(["EXPIRE", key, String(windowSec)]);
  if (count > limit) {
    const ttl = Number(await redisCmd(["TTL", key]) || windowSec);
    return {
      ok: false,
      key,
      count,
      limit,
      retryAfter: ttl > 0 ? ttl : windowSec,
    };
  }
  return { ok: true, key, count, limit, retryAfter: 0 };
}

export function rateLimitResponse(guard, message = "请求过于频繁，请稍后再试") {
  const retryAfter = Number(guard?.retryAfter || 60);
  return Response.json({
    ok: false,
    error: "too_many_requests",
    message,
    retryAfter,
  }, {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

export function generateNumericCode(length = 6) {
  const digits = Math.max(4, Math.min(10, Number(length) || 6));
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(randomInt(min, max));
}

export async function checkRedeemRateLimit(request) {
  const r = redisConfig();
  if (!r) return { ok: true, key: "" };
  const key = "liumeiti:redeem-guard:" + clientGuardFingerprint(request);
  const current = Number(await redisCmd(["GET", key]) || 0);
  if (current >= REDEEM_GUARD_LIMIT) {
    const ttl = Number(await redisCmd(["TTL", key]) || REDEEM_GUARD_WINDOW_SECONDS);
    return {
      ok: false,
      key,
      retryAfter: ttl > 0 ? ttl : REDEEM_GUARD_WINDOW_SECONDS,
      limit: REDEEM_GUARD_LIMIT,
    };
  }
  return { ok: true, key };
}

export async function recordRedeemRateFailure(guard) {
  if (!guard?.key) return 0;
  const count = Number(await redisCmd(["INCR", guard.key]) || 0);
  if (count === 1) await redisCmd(["EXPIRE", guard.key, String(REDEEM_GUARD_WINDOW_SECONDS)]);
  return count;
}

export async function clearRedeemRateLimit(guard) {
  if (!guard?.key) return;
  await redisCmd(["DEL", guard.key]);
}

export function redeemRateLimitMessage(retryAfter = REDEEM_GUARD_WINDOW_SECONDS) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfter || REDEEM_GUARD_WINDOW_SECONDS) / 60));
  return `兑换码尝试过多，请 ${minutes} 分钟后再试`;
}

function redeemCodeType(item) {
  const hasServices = Array.isArray(item?.services) && item.services.length > 0;
  return item?.type === "service" || item?.kind === "service" || hasServices ? "service" : "balance";
}

function normalizeRedeemServices(services) {
  const list = Array.isArray(services) ? services : [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    let key;
    let plan = "";
    if (typeof raw === "string") {
      key = clean(raw, 40);
    } else if (raw && typeof raw === "object") {
      key = clean(raw.key, 40);
      plan = clean(raw.plan, 20);
    } else {
      continue;
    }
    const product = REDEEM_SERVICE_PRODUCTS[key];
    if (!product) continue;
    let entryPlan = "";
    let dedupKey = key;
    if (product.hasPlan) {
      entryPlan = resolveProductPlanInternal(key, plan)?.id || "";
      dedupKey = `${key}:${entryPlan}`;
    }
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    result.push({ key, plan: entryPlan });
  }
  return result;
}

function serviceSummaries(items) {
  return normalizeRedeemServices(items).map(({ key, plan }) => {
    const product = REDEEM_SERVICE_PRODUCTS[key];
    if (product.hasPlan) {
      const planInfo = resolveProductPlanInternal(key, plan);
      return {
        key,
        label: `${product.label} · ${planInfo.label}`,
        amount: planInfo.amount,
        plan: planInfo.id,
        planLabel: planInfo.label,
      };
    }
    return {
      key,
      label: product.label,
      amount: product.amount,
      plan: "",
      planLabel: "",
    };
  });
}

function servicesEqual(a, b) {
  const norm = (list) => list.map((s) => `${s.key}:${s.plan || ""}`).sort().join(",");
  return norm(a) === norm(b);
}

export function createRegisterCoupon(now = new Date()) {
  return {
    id: makeId("CP"),
    title: "新用户注册立减8.88元优惠券",
    amount: REGISTER_COUPON_AMOUNT,
    status: "active",
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
}

export function attachRegisterCoupon(user, now = new Date()) {
  const coupons = Array.isArray(user.coupons) ? user.coupons : [];
  const hasRegisterCoupon = coupons.some((c) => c && c.type === "register");
  if (hasRegisterCoupon) return { ...user, coupons };
  return {
    ...user,
    coupons: [{ ...createRegisterCoupon(now), type: "register" }, ...coupons],
  };
}

export function publicCoupons(user) {
  const coupons = Array.isArray(user?.coupons) ? user.coupons : [];
  return coupons.map((c) => ({
    id: c.id || "",
    title: c.title || "优惠券",
    amount: roundMoney(c.amount),
    status: c.status || "active",
    createdAtBeijing: c.createdAtBeijing || "",
    usedAtBeijing: c.usedAtBeijing || "",
    usedOrderId: c.usedOrderId || "",
  }));
}

const INVITE_CODE_PREFIX_KEY = "liumeiti:invite-code:";
export const REFERRAL_LEVEL_ONE_RATE = 0.10;
export const REFERRAL_LEVEL_TWO_RATE = 0.05;

function inviteCodeKey(code) {
  return INVITE_CODE_PREFIX_KEY + normalizeInviteCode(code);
}

export function normalizeInviteCode(value) {
  return clean(value, 40).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

export function inviteCodeFromRequest(request) {
  return normalizeInviteCode(getCookieFromRequest(request, "lm_invite") || "");
}

async function createUniqueInviteCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = "MY" + randomBytes(4).toString("hex").toUpperCase();
    const existing = await redisCmd(["GET", inviteCodeKey(code)]);
    if (!existing) return code;
  }
  return "MY" + Date.now().toString(36).toUpperCase() + randomBytes(2).toString("hex").toUpperCase();
}

async function bindInviteCode(email, code) {
  const normalized = normalizeInviteCode(code);
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower) || !normalized) return false;
  await redisCmd(["SET", inviteCodeKey(normalized), lower]);
  return true;
}

export async function getUserByInviteCode(code) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  let email = await redisCmd(["GET", inviteCodeKey(normalized)]);
  if (validEmail(email)) {
    const user = await getUser(email);
    if (user) return { email: String(email).toLowerCase(), user };
  }

  const emails = await listAllUserEmails();
  for (const item of emails) {
    const lower = String(item || "").trim().toLowerCase();
    const user = await getUser(lower);
    if (user && normalizeInviteCode(user.inviteCode) === normalized) {
      await bindInviteCode(lower, normalized);
      return { email: lower, user };
    }
  }
  return null;
}

export async function ensureUserReferralProfile(email, currentUser = null) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return null;
  const user = currentUser || await getUser(lower);
  if (!user) return null;
  let changed = false;
  if (!normalizeInviteCode(user.inviteCode)) {
    user.inviteCode = await createUniqueInviteCode();
    changed = true;
  }
  await bindInviteCode(lower, user.inviteCode);
  if (changed) await setUser(lower, user);
  return user;
}

// 返佣下级反向索引 — 避免每次查「我的下级」都全表扫描全站用户。
//   liumeiti:referral:l1:<上级邮箱> = 直属(一级)下级邮箱集合
//   liumeiti:referral:l2:<上级邮箱> = 二级下级邮箱集合
const REFERRAL_L1_PREFIX = "liumeiti:referral:l1:";
const REFERRAL_L2_PREFIX = "liumeiti:referral:l2:";
const REFERRAL_INDEX_BUILT_KEY = "liumeiti:referral:index:built";
function referralL1Key(email) { return REFERRAL_L1_PREFIX + String(email || "").trim().toLowerCase(); }
function referralL2Key(email) { return REFERRAL_L2_PREFIX + String(email || "").trim().toLowerCase(); }

// 关系形成时把下级登记到上级名下(幂等;SADD 重复无副作用)。
async function indexReferralRelation(downlineEmail, level1Upline, level2Upline) {
  const down = String(downlineEmail || "").trim().toLowerCase();
  if (!validEmail(down)) return;
  const l1 = validEmail(level1Upline) ? String(level1Upline).toLowerCase() : "";
  const l2 = validEmail(level2Upline) ? String(level2Upline).toLowerCase() : "";
  const cmds = [];
  if (l1 && l1 !== down) cmds.push(["SADD", referralL1Key(l1), down]);
  if (l2 && l2 !== down) cmds.push(["SADD", referralL2Key(l2), down]);
  if (cmds.length) await redisPipeline(cmds);
}

// 用户被删除时:从其上级名下移除,并清掉其自身的下级集合。
export async function deindexReferralRelation(user) {
  if (!user) return;
  const lower = String(user.email || "").trim().toLowerCase();
  if (!lower) return;
  const cmds = [];
  if (validEmail(user.invitedByEmail)) cmds.push(["SREM", referralL1Key(user.invitedByEmail), lower]);
  if (validEmail(user.invitedBy2Email)) cmds.push(["SREM", referralL2Key(user.invitedBy2Email), lower]);
  cmds.push(["DEL", referralL1Key(lower)]);
  cmds.push(["DEL", referralL2Key(lower)]);
  await redisPipeline(cmds);
}

// 一次性回填:把存量用户的上下级关系灌进索引(flag 保证只跑一次)。
async function ensureReferralIndexBuilt() {
  try {
    const built = await redisCmd(["GET", REFERRAL_INDEX_BUILT_KEY]);
    if (built) return;
    const emails = await listAllUserEmails();
    const cmds = [];
    for (const item of emails) {
      const lower = String(item || "").trim().toLowerCase();
      const u = await getUser(lower);
      if (!u) continue;
      const a = validEmail(u.invitedByEmail) ? String(u.invitedByEmail).toLowerCase() : "";
      const b = validEmail(u.invitedBy2Email) ? String(u.invitedBy2Email).toLowerCase() : "";
      if (a && a !== lower) cmds.push(["SADD", referralL1Key(a), lower]);
      if (b && b !== lower) cmds.push(["SADD", referralL2Key(b), lower]);
    }
    // 只有写入成功才置 flag,避免 Redis 抖动导致「半成品索引」被标记为已建。
    if (cmds.length) {
      const res = await redisPipeline(cmds);
      if (res == null) return;
    }
    await redisCmd(["SET", REFERRAL_INDEX_BUILT_KEY, "1"]);
  } catch (e) {}
}

// 读取某用户的下级(一级+二级):走索引,O(下级数) 次 getUser,不再全表扫描。
// 返回已按 getUser 解析、过滤掉失效(已删)项的记录,因此即便索引含陈旧项,计数仍准确。
export async function getReferralDownlineRecords(email) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return [];
  await ensureReferralIndexBuilt();
  const l1 = (await redisCmd(["SMEMBERS", referralL1Key(lower)])) || [];
  const l2 = (await redisCmd(["SMEMBERS", referralL2Key(lower)])) || [];
  const levelByEmail = new Map();
  for (const e of l1) { const k = String(e || "").trim().toLowerCase(); if (k && k !== lower) levelByEmail.set(k, 1); }
  for (const e of l2) { const k = String(e || "").trim().toLowerCase(); if (k && k !== lower && !levelByEmail.has(k)) levelByEmail.set(k, 2); }
  const records = [];
  for (const [targetEmail, level] of levelByEmail) {
    const u = await getUser(targetEmail);
    if (!u) continue;
    records.push({
      email: targetEmail,
      level,
      username: u.username || "",
      balance: Number(u.balance || 0),
      banned: !!u.banned,
      inviteCode: normalizeInviteCode(u.inviteCode),
      invitedAtBeijing: u.invitedAtBeijing || u.createdAtBeijing || "",
      createdAtBeijing: u.createdAtBeijing || "",
    });
  }
  records.sort((a, b) => a.level - b.level || String(b.createdAtBeijing || "").localeCompare(String(a.createdAtBeijing || "")));
  return records;
}

export async function prepareNewUserReferralProfile(email, user, inviteCode = "") {
  const lower = String(email || "").trim().toLowerCase();
  const next = {
    ...user,
    inviteCode: normalizeInviteCode(user?.inviteCode) || await createUniqueInviteCode(),
  };
  const normalizedInvite = normalizeInviteCode(inviteCode);
  if (normalizedInvite) {
    const inviter = await getUserByInviteCode(normalizedInvite);
    if (inviter && inviter.email !== lower) {
      const inviterUser = await ensureUserReferralProfile(inviter.email, inviter.user);
      next.invitedByEmail = inviter.email;
      next.invitedByCode = inviterUser?.inviteCode || normalizedInvite;
      next.invitedBy2Email = inviterUser?.invitedByEmail && inviterUser.invitedByEmail !== lower
        ? inviterUser.invitedByEmail
        : "";
      next.invitedAt = new Date().toISOString();
      next.invitedAtBeijing = formatBeijingTime(new Date());
      // 关系成立 → 写入反向索引(上级名下登记该新用户)。
      await indexReferralRelation(lower, next.invitedByEmail, next.invitedBy2Email);
    }
  }
  await bindInviteCode(lower, next.inviteCode);
  return next;
}

export function publicReferral(user) {
  return {
    inviteCode: normalizeInviteCode(user?.inviteCode),
    invitedByEmail: validEmail(user?.invitedByEmail) ? String(user.invitedByEmail).toLowerCase() : "",
    invitedBy2Email: validEmail(user?.invitedBy2Email) ? String(user.invitedBy2Email).toLowerCase() : "",
    levelOneRate: REFERRAL_LEVEL_ONE_RATE,
    levelTwoRate: REFERRAL_LEVEL_TWO_RATE,
    totalRate: REFERRAL_LEVEL_ONE_RATE + REFERRAL_LEVEL_TWO_RATE,
  };
}

export function maskReferralOrderId(orderId) {
  const value = clean(orderId, 80).toUpperCase();
  if (!value) return "";
  if (value.length <= 8) return value.replace(/^(.{2}).+(.{2})$/, "$1****$2");
  const start = Math.max(2, Math.floor((value.length - 6) / 2));
  return value.slice(0, start) + "******" + value.slice(start + 6);
}

export async function resolveReferralForOrder({ userEmail, inviteCode }) {
  const buyerEmail = String(userEmail || "").trim().toLowerCase();
  let firstEmail = "";
  let secondEmail = "";
  let source = "";
  let code = "";

  if (validEmail(buyerEmail)) {
    const buyer = await ensureUserReferralProfile(buyerEmail);
    if (buyer?.invitedByEmail && buyer.invitedByEmail !== buyerEmail) {
      firstEmail = String(buyer.invitedByEmail).toLowerCase();
      secondEmail = buyer.invitedBy2Email ? String(buyer.invitedBy2Email).toLowerCase() : "";
      code = normalizeInviteCode(buyer.invitedByCode);
      source = "registered_relation";
    }
  }

  if (!firstEmail) {
    const normalized = normalizeInviteCode(inviteCode);
    const inviter = normalized ? await getUserByInviteCode(normalized) : null;
    if (inviter && inviter.email !== buyerEmail) {
      const inviterUser = await ensureUserReferralProfile(inviter.email, inviter.user);
      firstEmail = inviter.email;
      secondEmail = inviterUser?.invitedByEmail ? String(inviterUser.invitedByEmail).toLowerCase() : "";
      code = inviterUser?.inviteCode || normalized;
      source = "invite_link";
    }
  }

  if (secondEmail === firstEmail || secondEmail === buyerEmail) secondEmail = "";
  if (!firstEmail) return null;
  return {
    source,
    inviteCode: normalizeInviteCode(code),
    levelOneEmail: firstEmail,
    levelOneRate: REFERRAL_LEVEL_ONE_RATE,
    levelTwoEmail: secondEmail,
    levelTwoRate: secondEmail ? REFERRAL_LEVEL_TWO_RATE : 0,
  };
}

export async function settleOrderReferralCommission(order, actor = null) {
  if (!order || order.referralCommissionSettledAt) return { ok: true, skipped: "already_settled", entries: order?.referralCommissionEntries || [] };
  const referral = order.referral || null;
  const baseAmount = roundMoney(order.finalAmount || 0);
  if (!referral || baseAmount <= 0) return { ok: true, skipped: "no_referral", entries: [] };

  const now = new Date();
  const candidates = [
    { level: 1, email: referral.levelOneEmail, rate: Number(referral.levelOneRate || REFERRAL_LEVEL_ONE_RATE) },
    { level: 2, email: referral.levelTwoEmail, rate: Number(referral.levelTwoRate || REFERRAL_LEVEL_TWO_RATE) },
  ].filter((item) => validEmail(item.email) && item.rate > 0);

  const entries = [];
  for (const item of candidates) {
    const email = String(item.email).toLowerCase();
    const existingTxs = await getBalanceTxs(email);
    // 净额去重:已发(referral)笔数 > 已冲正(referral_reversal)笔数 时视为当前已发放,跳过。
    // 这样「完成→作废(冲正)→再次完成」可以重新发放,而重复保存不会重复发。
    const matchLevel = (tx, src) => tx?.source === src && tx?.orderId === order.orderId && Number(tx?.referralLevel || 0) === item.level;
    const paidCount = existingTxs.filter((tx) => matchLevel(tx, "referral")).length;
    const reversedCount = existingTxs.filter((tx) => matchLevel(tx, "referral_reversal")).length;
    if (paidCount > reversedCount) continue;

    const user = await getUser(email);
    if (!user || user.banned) continue;
    const commission = roundMoney(baseAmount * item.rate);
    if (commission <= 0) continue;
    const prev = roundMoney(user.balance);
    const next = roundMoney(prev + commission);
    user.balance = next;
    user.referralStats = user.referralStats && typeof user.referralStats === "object" ? user.referralStats : {};
    user.referralStats.totalCommission = roundMoney(Number(user.referralStats.totalCommission || 0) + commission);
    user.referralStats.lastCommissionAt = now.toISOString();
    await setUser(email, user);
    const tx = {
      id: makeId("TX"),
      amount: commission,
      reason: `合伙人收益 ${maskReferralOrderId(order.orderId)} · ${item.level === 1 ? "一级10%" : "二级5%"}`,
      balanceAfter: next,
      source: "referral",
      orderId: order.orderId,
      referralLevel: item.level,
      commissionRate: item.rate,
      commissionBase: baseAmount,
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
      staffId: Number(actor?.staffId || 1),
      staffUsername: clean(actor?.staffUsername || "admin", 60),
    };
    await addBalanceTx(email, tx);
    await pushAdminBalanceLog({
      ...tx,
      email,
      balanceBefore: prev,
      action: "referral_commission",
      detail: { orderId: order.orderId, level: item.level, rate: item.rate, baseAmount },
    });
    entries.push({ email, level: item.level, rate: item.rate, amount: commission, balanceAfter: next });
  }

  order.referralCommissionSettledAt = now.toISOString();
  order.referralCommissionSettledAtBeijing = formatBeijingTime(now);
  order.referralCommissionEntries = entries;
  return { ok: true, entries };
}

// 订单从「已完成」改回其它状态(作废/未完成)时,把已发放的返佣按笔冲正回收。
// 冲正后清空结算标记,使订单若再次完成可重新结算;按 tx 净额幂等,重复调用安全。
export async function reverseOrderReferralCommission(order, actor = null) {
  if (!order || !order.referralCommissionSettledAt) {
    return { ok: true, skipped: "not_settled", reversed: [] };
  }
  const settledEntries = Array.isArray(order.referralCommissionEntries) ? order.referralCommissionEntries : [];
  const now = new Date();
  const reversed = [];
  for (const entry of settledEntries) {
    const email = String(entry?.email || "").toLowerCase();
    const level = Number(entry?.level || 0);
    const amount = roundMoney(entry?.amount || 0);
    if (!validEmail(email) || amount <= 0) continue;
    const existingTxs = await getBalanceTxs(email);
    const matchLevel = (tx, src) => tx?.source === src && tx?.orderId === order.orderId && Number(tx?.referralLevel || 0) === level;
    const paidCount = existingTxs.filter((tx) => matchLevel(tx, "referral")).length;
    const reversedCount = existingTxs.filter((tx) => matchLevel(tx, "referral_reversal")).length;
    if (paidCount <= reversedCount) continue; // 当前已无未冲正的发放,跳过

    const user = await getUser(email);
    if (!user) continue;
    const prev = roundMoney(user.balance);
    const next = roundMoney(prev - amount); // 允许为负:佣金可能已被提现/消费,负余额如实反映欠款
    user.balance = next;
    user.referralStats = user.referralStats && typeof user.referralStats === "object" ? user.referralStats : {};
    user.referralStats.totalCommission = roundMoney(Math.max(0, Number(user.referralStats.totalCommission || 0) - amount));
    await setUser(email, user);
    const tx = {
      id: makeId("TX"),
      amount: -amount,
      reason: `合伙人收益冲正 ${maskReferralOrderId(order.orderId)} · ${level === 1 ? "一级10%" : "二级5%"}(订单作废)`,
      balanceAfter: next,
      source: "referral_reversal",
      orderId: order.orderId,
      referralLevel: level,
      commissionBase: roundMoney(entry?.amount || 0),
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
      staffId: Number(actor?.staffId || 1),
      staffUsername: clean(actor?.staffUsername || "admin", 60),
    };
    await addBalanceTx(email, tx);
    await pushAdminBalanceLog({
      ...tx,
      email,
      balanceBefore: prev,
      action: "referral_commission_reversal",
      detail: { orderId: order.orderId, level, amount },
    });
    reversed.push({ email, level, amount, balanceAfter: next });
  }

  order.referralCommissionReversedAt = now.toISOString();
  order.referralCommissionReversedAtBeijing = formatBeijingTime(now);
  order.referralCommissionReversedEntries = reversed;
  // 清空结算标记,允许重新完成时再次结算。
  order.referralCommissionSettledAt = "";
  order.referralCommissionSettledAtBeijing = "";
  order.referralCommissionEntries = [];
  return { ok: true, reversed };
}

export async function consumeBestCoupon(email, orderId, maxAmount) {
  const user = await getUser(email);
  if (!user) return { discount: 0 };
  const coupons = Array.isArray(user.coupons) ? user.coupons : [];
  const idx = coupons.findIndex((c) => c && c.status === "active" && Number(c.amount) > 0);
  if (idx < 0) return { discount: 0 };
  const now = new Date();
  const discount = Math.min(roundMoney(coupons[idx].amount), roundMoney(maxAmount));
  if (discount <= 0) return { discount: 0 };
  coupons[idx] = {
    ...coupons[idx],
    status: "used",
    usedOrderId: orderId,
    discount,
    usedAt: now.toISOString(),
    usedAtBeijing: formatBeijingTime(now),
  };
  user.coupons = coupons;
  const saved = await setUser(email, user);
  if (!saved) return { discount: 0 };
  return { discount, couponId: coupons[idx].id, couponTitle: coupons[idx].title };
}

export async function restoreCoupon(email, couponId, orderId) {
  if (!email || !couponId) return false;
  const user = await getUser(email);
  if (!user || !Array.isArray(user.coupons)) return false;
  const idx = user.coupons.findIndex((c) => c.id === couponId && c.usedOrderId === orderId);
  if (idx < 0) return false;
  const restored = { ...user.coupons[idx], status: "active" };
  delete restored.usedOrderId;
  delete restored.discount;
  delete restored.usedAt;
  delete restored.usedAtBeijing;
  user.coupons[idx] = restored;
  return setUser(email, user);
}

// 订单作废退款 — 退余额(余额支付)+ 还优惠券 + 恢复兑换码。幂等(order.refundedAt 守卫 + 退款流水去重)。
// AI 库存的归还由 [orderId] 路由单独处理,这里不碰。
export async function refundVoidedOrder(order, actor = null) {
  if (!order || order.refundedAt) return { ok: true, skipped: "already_refunded", balance: 0, coupon: false };
  const now = new Date();
  const email = String(order.userEmail || "").trim().toLowerCase();
  const out = { balance: 0, coupon: false };

  // 1) 余额支付 → 退回余额
  if (order.paidByBalance && validEmail(email)) {
    const amount = roundMoney(order.finalAmount || 0);
    if (amount > 0) {
      const user = await getUser(email);
      const txs = await getBalanceTxs(email);
      // 净额去重:退款笔数 > 收回笔数 = 当前已有未收回的退款,跳过;
      // 收回后(reclaim)再作废可再次退款,与 reclaimRefundOnReactivate 对称幂等。
      const refundCount = txs.filter((tx) => tx?.source === "order_refund" && tx?.orderId === order.orderId).length;
      const reclaimCount = txs.filter((tx) => tx?.source === "order_refund_reclaim" && tx?.orderId === order.orderId).length;
      const outstanding = refundCount > reclaimCount;
      if (user && !outstanding) {
        const prev = roundMoney(user.balance);
        const next = roundMoney(prev + amount);
        user.balance = next;
        await setUser(email, user);
        const tx = {
          id: makeId("TX"),
          amount,
          reason: `订单作废退款 ${order.orderId}`,
          balanceAfter: next,
          source: "order_refund",
          orderId: order.orderId,
          createdAt: now.toISOString(),
          createdAtBeijing: formatBeijingTime(now),
          staffId: Number(actor?.staffId || 1),
          staffUsername: clean(actor?.staffUsername || "admin", 60),
        };
        await addBalanceTx(email, tx);
        await pushAdminBalanceLog({ ...tx, email, balanceBefore: prev, action: "order_refund", detail: { orderId: order.orderId, amount } });
        out.balance = amount;
      }
    }
  }

  // 2) 优惠券 → 还回(若该订单用过)
  if (order.couponId && validEmail(email)) {
    out.coupon = Boolean(await restoreCoupon(email, order.couponId, order.orderId));
  }

  // 注:兑换码「兑换过即失效」—— 订单作废不恢复兑换码(已消耗,永久失效)。
  // 仅下单创建失败的回滚(order/route.js)才返还,那是订单根本没成立的场景。

  order.refundedAt = now.toISOString();
  order.refundedAtBeijing = formatBeijingTime(now);
  order.refund = out;
  return { ok: true, ...out };
}

// 优惠券重新标记为已用(reactivate 时用,restoreCoupon 的逆操作)。
async function reconsumeCoupon(email, couponId, orderId) {
  if (!email || !couponId) return false;
  const user = await getUser(email);
  if (!user || !Array.isArray(user.coupons)) return false;
  const idx = user.coupons.findIndex((c) => c.id === couponId && c.status === "active");
  if (idx < 0) return false;
  const now = new Date();
  user.coupons[idx] = {
    ...user.coupons[idx],
    status: "used",
    usedOrderId: orderId,
    usedAt: now.toISOString(),
    usedAtBeijing: formatBeijingTime(now),
  };
  return setUser(email, user);
}

// 作废订单被改回「有效」时,回收此前的退款 —— 否则用户既拿退款、订单又生效(白嫖资金洞)。
// 余额扣回(净额幂等,允许负余额)、优惠券重新置为已用、清空退款标记以便再次作废可再退。
// 库存的重新占用由 [orderId] 路由处理。
export async function reclaimRefundOnReactivate(order, actor = null) {
  if (!order || !order.refundedAt) return { ok: true, skipped: "not_refunded", balance: 0, coupon: false };
  const now = new Date();
  const email = String(order.userEmail || "").trim().toLowerCase();
  const out = { balance: 0, coupon: false };

  // 1) 余额:把作废时退回的钱重新扣除(净额去重:退款笔数 > 收回笔数 时才收回)
  if (order.paidByBalance && validEmail(email)) {
    const amount = roundMoney(order.refund?.balance || order.finalAmount || 0);
    if (amount > 0) {
      const txs = await getBalanceTxs(email);
      const refundCount = txs.filter((tx) => tx?.source === "order_refund" && tx?.orderId === order.orderId).length;
      const reclaimCount = txs.filter((tx) => tx?.source === "order_refund_reclaim" && tx?.orderId === order.orderId).length;
      if (refundCount > reclaimCount) {
        const user = await getUser(email);
        if (user) {
          const prev = roundMoney(user.balance);
          const next = roundMoney(prev - amount); // 允许为负:退款可能已被花掉,负余额如实反映欠款
          user.balance = next;
          await setUser(email, user);
          const tx = {
            id: makeId("TX"),
            amount: -amount,
            reason: `作废撤销·退款收回 ${order.orderId}`,
            balanceAfter: next,
            source: "order_refund_reclaim",
            orderId: order.orderId,
            createdAt: now.toISOString(),
            createdAtBeijing: formatBeijingTime(now),
            staffId: Number(actor?.staffId || 1),
            staffUsername: clean(actor?.staffUsername || "admin", 60),
          };
          await addBalanceTx(email, tx);
          await pushAdminBalanceLog({ ...tx, email, balanceBefore: prev, action: "order_refund_reclaim", detail: { orderId: order.orderId, amount } });
          out.balance = amount;
        }
      }
    }
  }

  // 2) 优惠券:重新置为已用(仅当作废时还回过)
  if (order.couponId && validEmail(email) && order.refund?.coupon) {
    out.coupon = Boolean(await reconsumeCoupon(email, order.couponId, order.orderId));
  }

  // 清空退款标记,使订单若再次作废可再次退款(与净额去重配合幂等)
  order.refundedAt = "";
  order.refundedAtBeijing = "";
  order.refund = null;
  order.refundReclaimedAt = now.toISOString();
  order.refundReclaimedAtBeijing = formatBeijingTime(now);
  order.refundReclaim = out;
  return { ok: true, ...out };
}

export async function ensureOAuthUser({ email, provider, providerId, username, inviteCode }) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return { ok: false, error: "invalid_email" };
  const now = new Date();
  const existing = await getUser(lower);
  if (existing) {
    if (existing.banned) return { ok: false, error: "account_banned" };
    const social = { ...(existing.social || {}) };
    if (provider && providerId) social[provider] = providerId;
    const existingWithReferral = await ensureUserReferralProfile(lower, existing);
    const next = {
      ...existingWithReferral,
      username: existingWithReferral.username || clean(username, 40) || generateRandomUsername(),
      avatarId: validUserAvatarId(existingWithReferral.avatarId) ? existingWithReferral.avatarId : generateRandomUserAvatarId(),
      balance: typeof existingWithReferral.balance === "number" ? existingWithReferral.balance : 0,
      social,
      updatedAt: now.toISOString(),
    };
    await setUser(lower, next);
    await registerUserEmail(lower);
    return { ok: true, user: next, isNew: false };
  }
  const user = await prepareNewUserReferralProfile(lower, attachRegisterCoupon({
    email: lower,
    username: clean(username, 40) || generateRandomUsername(),
    avatarId: generateRandomUserAvatarId(),
    balance: 0,
    social: provider && providerId ? { [provider]: providerId } : {},
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  }, now), inviteCode);
  const saved = await setUser(lower, user);
  if (!saved) return { ok: false, error: "storage_failed" };
  await registerUserEmail(lower);
  return { ok: true, user, isNew: true };
}

export async function transferBalanceByEmail(fromEmail, toEmail, amount) {
  const from = String(fromEmail || "").trim().toLowerCase();
  const to = String(toEmail || "").trim().toLowerCase();
  const delta = roundMoney(amount);
  if (!validEmail(from) || !validEmail(to) || from === to) return { ok: false, error: "invalid_recipient" };
  if (delta <= 0 || delta > 100000) return { ok: false, error: "invalid_amount" };
  const fromUser = await getUser(from);
  const toUser = await getUser(to);
  if (!fromUser) return { ok: false, error: "user_not_found" };
  if (!toUser) return { ok: false, error: "recipient_not_found" };
  if (toUser.banned) return { ok: false, error: "recipient_unavailable" };
  const fromPrev = roundMoney(fromUser.balance);
  const toPrev = roundMoney(toUser.balance);
  if (fromPrev < delta) return { ok: false, error: "insufficient_balance", currentBalance: fromPrev };
  const now = new Date();
  const transferId = makeId("TR");
  fromUser.balance = roundMoney(fromPrev - delta);
  toUser.balance = roundMoney(toPrev + delta);
  const savedFrom = await setUser(from, fromUser);
  const savedTo = await setUser(to, toUser);
  if (!savedFrom || !savedTo) return { ok: false, error: "save_failed" };
  const fromTx = {
    id: makeId("TX"),
    amount: -delta,
    reason: "转账给 " + to,
    balanceAfter: fromUser.balance,
    source: "transfer",
    transferId,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  const toTx = {
    id: makeId("TX"),
    amount: delta,
    reason: "收到 " + from + " 转账",
    balanceAfter: toUser.balance,
    source: "transfer",
    transferId,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  await addBalanceTx(from, fromTx);
  await addBalanceTx(to, toTx);
  await pushAdminBalanceLog({ ...fromTx, email: from, balanceBefore: fromPrev });
  await pushAdminBalanceLog({ ...toTx, email: to, balanceBefore: toPrev });
  return { ok: true, balance: fromUser.balance };
}

async function getJsonKey(key) {
  const raw = await redisCmd(["GET", key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function setJsonKey(key, value) {
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/set/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "text/plain" },
      body: JSON.stringify(value),
    });
    return res.ok;
  } catch (e) { return false; }
}

async function adminStaffRecords() {
  const records = await getJsonKey(ADMIN_STAFF_KEY);
  return Array.isArray(records) ? records : [];
}

async function saveAdminStaffRecords(records) {
  return setJsonKey(ADMIN_STAFF_KEY, Array.isArray(records) ? records : []);
}

export function envAdminUsername() {
  return clean(process.env.ADMIN_USERNAME || process.env.ADMIN_USER || "admin", 60) || "admin";
}

export async function verifyAdminLogin(username, password) {
  const inputUsername = clean(username, 60);
  if (!inputUsername) return { ok: false, error: "invalid_credentials" };
  const envUsername = envAdminUsername();
  if (process.env.ADMIN_PASSWORD && inputUsername.toLowerCase() === envUsername.toLowerCase() && checkAdminPassword(password)) {
    return { ok: true, staff: { id: 1, username: envUsername, role: "owner", root: true } };
  }

  const records = await adminStaffRecords();
  const staff = records.find((item) =>
    item && item.active !== false && String(item.username || "").toLowerCase() === inputUsername.toLowerCase()
  );
  if (staff && verifyPassword(password, staff.passwordHash)) {
    return { ok: true, staff: { id: Number(staff.id), username: staff.username, role: staff.role || "operator", remark: staff.remark || "", root: false, perms: sanitizeStaffPerms(staff.perms) } };
  }

  return { ok: false, error: "invalid_credentials" };
}

export async function listAdminStaff() {
  const records = await adminStaffRecords();
  // 各账号 2FA 绑定状态(含 root),给列表显示徽章
  const ids = [1, ...records.map((item) => Number(item.id))];
  const twoFaFlags = await Promise.all(ids.map(async (id) => Boolean(await getStaff2fa(id))));
  const twoFaById = new Map(ids.map((id, i) => [id, twoFaFlags[i]]));
  return [
    {
      id: 1,
      username: envAdminUsername(),
      role: "owner",
      roleLabel: "主账号",
      permissions: adminPermissionProfile({ staffId: 1, staffRoot: true }),
      root: true,
      active: Boolean(process.env.ADMIN_PASSWORD),
      createdAtBeijing: "环境变量主账号",
      remark: "主账号",
      totpEnabled: Boolean(twoFaById.get(1)),
    },
    ...records.map((item) => ({
      totpEnabled: Boolean(twoFaById.get(Number(item.id))),
      id: Number(item.id),
      username: item.username || "",
      role: item.role || "operator",
      roleLabel: item.role === "support" ? "客服" : item.role === "finance" ? "财务" : "运营",
      perms: sanitizeStaffPerms(item.perms),
      permissions: adminPermissionProfile({ staffId: Number(item.id), staffRole: item.role || "operator", staffPerms: sanitizeStaffPerms(item.perms) }),
      active: item.active !== false,
      root: false,
      remark: item.remark || "",
      createdAt: item.createdAt || "",
      createdAtBeijing: item.createdAtBeijing || "",
      createdByStaffId: item.createdByStaffId || "",
      deletedAtBeijing: item.deletedAtBeijing || "",
      deletedByStaffId: item.deletedByStaffId || "",
    })),
  ];
}

export async function listAssignableAdminStaff() {
  const records = await adminStaffRecords();
  return [
    {
      id: 1,
      username: envAdminUsername(),
      role: "owner",
      active: Boolean(process.env.ADMIN_PASSWORD),
    },
    ...records.map((item) => ({
      id: Number(item.id),
      username: item.username || "",
      role: item.role || "operator",
      active: item.active !== false,
      perms: sanitizeStaffPerms(item.perms),
    })),
  ].filter((item) => item.active && adminPermissionProfile({
    staffId: item.id,
    staffRoot: item.id === 1,
    staffRole: item.role,
    staffPerms: item.perms,
  }).canEditOrders).map(({ perms, ...item }) => item);
}

export async function createAdminStaff(input, actor) {
  const username = clean(input?.username, 60);
  const password = String(input?.password || "");
  const rawRole = clean(input?.role || "operator", 40).toLowerCase();
  const role = ["operator", "support", "finance"].includes(rawRole) ? rawRole : "operator";
  const remark = clean(input?.remark, 160);
  if (!/^[A-Za-z0-9_@.-]{3,40}$/.test(username)) return { ok: false, error: "invalid_username" };
  if (password.length < 6 || password.length > 64) return { ok: false, error: "invalid_password" };

  const records = await adminStaffRecords();
  if (username.toLowerCase() === envAdminUsername().toLowerCase() ||
      records.some((item) => String(item.username || "").toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: "username_exists" };
  }
  const nextId = Math.max(1, ...records.map((item) => Number(item.id) || 1)) + 1;
  const now = new Date();
  const staff = {
    id: nextId,
    username,
    role,
    passwordHash: hashPassword(password),
    active: true,
    remark,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    createdByStaffId: Number(actor?.staffId || 1),
  };
  const saved = await saveAdminStaffRecords([staff, ...records]);
  if (!saved) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "staff_create",
    actor,
    target: "staff:" + nextId,
    detail: { username, role },
  });
  return { ok: true, staff: { ...staff, passwordHash: undefined } };
}

// 更新员工:细粒度权限覆盖(perms)/角色/备注/重置密码/启停用。改动后自动踢下线,
// 使其重新登录拿到嵌入新权限的会话(会话是无状态 JWT,权限在登录时写入)。
export async function updateAdminStaff(id, patch, actor) {
  const staffId = Number(id);
  if (!Number.isFinite(staffId) || staffId <= 1) return { ok: false, error: "cannot_edit_root" };
  const records = await adminStaffRecords();
  const index = records.findIndex((item) => Number(item.id) === staffId);
  if (index < 0) return { ok: false, error: "staff_not_found" };
  const staff = { ...records[index] };
  const changed = {};

  if (patch && typeof patch.perms === "object" && patch.perms !== null) {
    staff.perms = sanitizeStaffPerms(patch.perms);
    changed.perms = staff.perms;
  }
  if (typeof patch?.role === "string" && ["operator", "support", "finance"].includes(patch.role.toLowerCase())) {
    staff.role = patch.role.toLowerCase();
    changed.role = staff.role;
  }
  if (typeof patch?.remark === "string") {
    staff.remark = clean(patch.remark, 160);
    changed.remark = staff.remark;
  }
  if (typeof patch?.password === "string" && patch.password) {
    if (patch.password.length < 6 || patch.password.length > 64) return { ok: false, error: "invalid_password" };
    staff.passwordHash = hashPassword(patch.password);
    changed.passwordReset = true;
  }
  if (typeof patch?.active === "boolean") {
    staff.active = patch.active;
    changed.active = staff.active;
  }
  if (!Object.keys(changed).length) return { ok: false, error: "nothing_to_update" };

  records[index] = staff;
  const saved = await saveAdminStaffRecords(records);
  if (!saved) return { ok: false, error: "storage_failed" };
  // 权限/密码/启停变化 → 立即踢下线,强制重新登录生效。
  await kickAdminStaff(staffId);
  await pushAdminActionLog({
    action: "staff_update",
    actor,
    target: "staff:" + staffId,
    detail: { username: staff.username || "", ...changed, passwordReset: changed.passwordReset ? true : undefined },
  });
  return { ok: true, staff: { ...staff, passwordHash: undefined } };
}

export async function deleteAdminStaff(id, actor) {
  const staffId = Number(id);
  if (!Number.isFinite(staffId) || staffId <= 1) return { ok: false, error: "cannot_delete_root" };
  const records = await adminStaffRecords();
  const index = records.findIndex((item) => Number(item.id) === staffId);
  if (index < 0) return { ok: false, error: "staff_not_found" };
  const now = new Date();
  const [removed] = records.splice(index, 1);
  const saved = await saveAdminStaffRecords(records);
  if (!saved) return { ok: false, error: "storage_failed" };
  await kickAdminStaff(staffId); // 删除即踢下线,残留会话立即失效
  await pushAdminActionLog({
    action: "staff_delete",
    actor,
    target: "staff:" + staffId,
    detail: { username: removed?.username || "" },
  });
  return { ok: true, deleted: staffId, deletedAtBeijing: formatBeijingTime(now) };
}

export async function pushAdminActionLog({ action, actor, target, detail }) {
  const staff = adminActorFromSession(actor);
  const now = new Date();
  const entry = {
    id: makeId("AL"),
    action: clean(action, 80),
    target: clean(target, 180),
    detail: detail && typeof detail === "object" ? detail : {},
    staffId: Number(staff.staffId || 1),
    staffUsername: clean(staff.staffUsername || "admin", 60),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  const r = redisConfig();
  if (!r) return false;
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["LPUSH", ADMIN_ACTION_LOG_KEY, JSON.stringify(entry)],
        ["LTRIM", ADMIN_ACTION_LOG_KEY, "0", "499"],
      ]),
    });
    return res.ok;
  } catch (e) { return false; }
}

export async function getAdminActionLog() {
  const rows = await redisCmd(["LRANGE", ADMIN_ACTION_LOG_KEY, "0", "499"]);
  if (!Array.isArray(rows)) return [];
  return rows.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

export async function deleteAdminActionLogEntries(ids, actor = null) {
  const idSet = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => clean(id, 120))
    .filter(Boolean));
  if (idSet.size === 0) return { ok: false, error: "no_ids" };
  const entries = await getAdminActionLog();
  const removed = entries.filter((entry) => idSet.has(clean(entry.id, 120)));
  const remaining = entries.filter((entry) => !idSet.has(clean(entry.id, 120)));
  if (removed.length === 0) return { ok: false, error: "not_found" };
  const commands = [
    ["DEL", ADMIN_ACTION_LOG_KEY],
    ...remaining.map((entry) => ["RPUSH", ADMIN_ACTION_LOG_KEY, JSON.stringify(entry)]),
  ];
  const saved = await redisPipeline(commands);
  if (!saved) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "action_log_delete",
    actor,
    target: "action-log:" + removed.length,
    detail: { ids: Array.from(idSet), deletedCount: removed.length },
  });
  return {
    ok: true,
    deletedCount: removed.length,
    notFound: Array.from(idSet).filter((id) => !removed.some((entry) => clean(entry.id, 120) === id)),
  };
}

export async function pushAdminMailLog(entry) {
  const actor = {
    staffId: Number(entry?.staffId || 1),
    staffUsername: clean(entry?.staffUsername || "admin", 60),
  };
  const now = entry?.createdAt ? new Date(entry.createdAt) : new Date();
  const item = {
    id: clean(entry?.id, 80) || makeId("ML"),
    to: clean(entry?.to, 180).toLowerCase(),
    subject: clean(entry?.subject, 180),
    content: clean(entry?.content, 3000),
    preview: clean(entry?.preview || entry?.content, 240),
    ok: Boolean(entry?.ok),
    reason: clean(entry?.reason || entry?.error || "", 200),
    messageId: clean(entry?.messageId, 180),
    scheduledAt: clean(entry?.scheduledAt, 80),
    scheduledAtBeijing: entry?.scheduledAt ? formatBeijingTime(entry.scheduledAt) : "",
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
    createdAt: now.toISOString(),
    createdAtBeijing: entry?.createdAtBeijing || formatBeijingTime(now),
  };
  const saved = await redisPipeline([
    ["LPUSH", ADMIN_MAIL_LOG_KEY, JSON.stringify(item)],
    ["LTRIM", ADMIN_MAIL_LOG_KEY, "0", "499"],
  ]);
  return saved ? item : null;
}

const ADMIN_MAIL_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function adminMailRecoveryFingerprint(entry) {
  const to = clean(entry?.to, 180).toLowerCase();
  const subject = clean(entry?.subject || "客服服务通知", 180).toLowerCase();
  if (!to || !subject) return "";
  return `${to}\u001f${subject}`;
}

function adminMailLogTime(entry) {
  const value = new Date(entry?.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function reconcileAdminMailLogStatuses(entries, windowMs = ADMIN_MAIL_RECOVERY_WINDOW_MS) {
  const latestSuccess = new Map();
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const fingerprint = adminMailRecoveryFingerprint(entry);
    const timestamp = adminMailLogTime(entry);
    const isCompletedSend = entry?.ok !== false && !entry?.scheduledAt;
    if (fingerprint && isCompletedSend) {
      if (!latestSuccess.has(fingerprint)) latestSuccess.set(fingerprint, entry);
      return entry;
    }
    const success = fingerprint ? latestSuccess.get(fingerprint) : null;
    const successTime = adminMailLogTime(success);
    if (success && entry?.ok === false && successTime >= timestamp && successTime - timestamp <= windowMs) {
      return {
        ...entry,
        ok: true,
        recovered: true,
        originalReason: entry.reason || "",
        reason: "",
        recoveredBy: success.messageId || success.id || "",
        recoveredAt: success.createdAt || "",
        recoveredAtBeijing: success.createdAtBeijing || "",
      };
    }
    return entry;
  });
}

export async function getAdminMailLog() {
  const rows = await redisCmd(["LRANGE", ADMIN_MAIL_LOG_KEY, "0", "499"]);
  if (!Array.isArray(rows)) return [];
  const entries = rows.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  return reconcileAdminMailLogStatuses(entries);
}

export async function deleteAdminMailLogEntries(ids, actor = null) {
  const idSet = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => clean(id, 120))
    .filter(Boolean));
  if (idSet.size === 0) return { ok: false, error: "no_ids" };
  const entries = await getAdminMailLog();
  const removed = entries.filter((entry) => idSet.has(clean(entry.id, 120)));
  const remaining = entries.filter((entry) => !idSet.has(clean(entry.id, 120)));
  if (removed.length === 0) return { ok: false, error: "not_found" };
  const saved = await redisPipeline([
    ["DEL", ADMIN_MAIL_LOG_KEY],
    ...remaining.map((entry) => ["RPUSH", ADMIN_MAIL_LOG_KEY, JSON.stringify(entry)]),
  ]);
  if (!saved) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "mail_log_delete",
    actor,
    target: "mail-log:" + removed.length,
    detail: { ids: Array.from(idSet), deletedCount: removed.length },
  });
  return {
    ok: true,
    deletedCount: removed.length,
    notFound: Array.from(idSet).filter((id) => !removed.some((entry) => clean(entry.id, 120) === id)),
  };
}

async function generateUniqueRedeemCode() {
  for (let i = 0; i < 12; i += 1) {
    const code = "LM" + randomBytes(4).toString("hex").toUpperCase();
    const exists = await getJsonKey(redeemCodeKey(code));
    if (!exists) return code;
  }
  return "LM" + randomBytes(5).toString("hex").toUpperCase();
}

function normalizeRedeemInput(input) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : { type: "balance", amount: input };
  const type = clean(body.type || body.kind || "balance", 20) === "service" ? "service" : "balance";
  const customCodeRaw = clean(body.customCode || body.code || body.redeemCode, 80);
  const customCode = customCodeRaw ? normalizeRedeemCode(customCodeRaw) : "";
  if (customCodeRaw && (customCode.length < 4 || customCode.length > 40)) return { ok: false, error: "invalid_custom_code" };
  let value = roundMoney(body.amount);
  let services = [];
  if (type === "service") {
    services = serviceSummaries(body.services);
    if (services.length === 0) return { ok: false, error: "missing_services" };
    value = roundMoney(services.reduce((sum, item) => sum + item.amount, 0));
  } else if (value <= 0 || value > 100000) {
    return { ok: false, error: "invalid_amount" };
  }
  const quantity = customCode ? 1 : Math.max(1, Math.min(200, Math.floor(Number(body.quantity || body.count || 1) || 1)));
  return { ok: true, body, type, value, services, quantity, remark: clean(body.remark || body.note, 180), customCode };
}

export async function createRedeemCodes(input, actor = null) {
  const normalized = normalizeRedeemInput(input);
  if (!normalized.ok) return normalized;
  const { type, value, services, quantity, remark, customCode } = normalized;
  const now = new Date();
  const batchId = makeId("RB");
  const actorInfo = actor ? adminActorFromSession(actor) : null;
  if (customCode) {
    const exists = await getJsonKey(redeemCodeKey(customCode));
    if (exists) return { ok: false, error: "custom_code_exists" };
  }
  const items = [];
  for (let i = 0; i < quantity; i += 1) {
    const code = customCode && i === 0 ? customCode : await generateUniqueRedeemCode();
    const item = {
      code,
      batchId,
      batchIndex: i + 1,
      batchSize: quantity,
      remark,
      type,
      amount: value,
      status: "active",
      customCode: Boolean(customCode && code === customCode),
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
    };
    if (type === "service") item.services = services;
    if (actorInfo) {
      item.createdByStaffId = actorInfo.staffId;
      item.createdByStaffUsername = actorInfo.staffUsername;
    }
    items.push(item);
  }
  const batch = {
    id: batchId,
    type,
    amount: value,
    services,
    quantity,
    remark,
    status: "active",
    customCreated: Boolean(customCode),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    codes: items.map((item) => item.code),
    customCode: customCode || "",
  };
  if (actorInfo) {
    batch.createdByStaffId = actorInfo.staffId;
    batch.createdByStaffUsername = actorInfo.staffUsername;
  }
  const commands = [
    ...items.flatMap((item) => [
      ["SET", redeemCodeKey(item.code), JSON.stringify(item)],
      ["LPUSH", REDEEM_LIST_KEY, item.code],
    ]),
    ["SET", redeemBatchKey(batchId), JSON.stringify(batch)],
    ["LPUSH", REDEEM_BATCH_LIST_KEY, batchId],
    ["LTRIM", REDEEM_LIST_KEY, "0", "499"],
    ["LTRIM", REDEEM_BATCH_LIST_KEY, "0", "199"],
  ];
  const ok = await redisPipeline(commands);
  if (!ok) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "redeem_batch_create",
    actor: actorInfo,
    target: "redeem-batch:" + batchId,
    detail: { type, amount: value, quantity, remark, customCode: customCode || "" },
  });
  return { ok: true, code: items[0], codes: items, batch };
}

export async function createRedeemCode(input, actor = null) {
  const result = await createRedeemCodes({ ...(input && typeof input === "object" ? input : { amount: input }), quantity: 1 }, actor);
  if (!result.ok) return result;
  return { ok: true, code: result.code, batch: result.batch };
}

export async function listRedeemCodes() {
  const codes = await redisCmd(["LRANGE", REDEEM_LIST_KEY, "0", "499"]);
  if (!Array.isArray(codes)) return [];
  const unique = Array.from(new Set(codes));
  const items = await Promise.all(unique.map((code) => getJsonKey(redeemCodeKey(code))));
  return items.filter(Boolean).map((item) => ({
    ...item,
    type: redeemCodeType(item),
    services: redeemCodeType(item) === "service" ? serviceSummaries(item.services || []) : [],
  }));
}

export async function listRedeemCodeBatches() {
  const ids = await redisCmd(["LRANGE", REDEEM_BATCH_LIST_KEY, "0", "199"]);
  if (!Array.isArray(ids)) return [];
  const unique = Array.from(new Set(ids));
  const batches = await Promise.all(unique.map((id) => getJsonKey(redeemBatchKey(id))));
  const normalized = await Promise.all(batches.filter(Boolean).map(async (batch) => {
    const codeList = Array.isArray(batch.codes) ? batch.codes : [];
    const codeItems = (await Promise.all(codeList.map((code) => getJsonKey(redeemCodeKey(code)))))
      .filter(Boolean)
      .map((item) => ({
        ...item,
        type: redeemCodeType(item),
        services: redeemCodeType(item) === "service" ? serviceSummaries(item.services || []) : [],
      }));
    const counts = codeItems.reduce((acc, item) => {
      const status = item.status || "active";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, { active: 0, used: 0, void: 0 });
    const type = redeemCodeType(batch);
    return {
      ...batch,
      type,
      amount: roundMoney(batch.amount),
      services: type === "service" ? serviceSummaries(batch.services || []) : [],
      codes: codeItems,
      quantity: Number(batch.quantity || codeItems.length || 0),
      counts,
    };
  }));
  return normalized;
}

export async function listManageableRedeemCodesAndBatches() {
  const [codes, batches] = await Promise.all([listRedeemCodes(), listRedeemCodeBatches()]);
  const manageableCodes = codes.filter((item) => (item.status || "active") !== "used");
  const manageableBatches = batches
    .map((batch) => {
      const visibleCodes = (Array.isArray(batch.codes) ? batch.codes : [])
        .filter((item) => item && (item.status || "active") !== "used");
      const counts = visibleCodes.reduce((acc, item) => {
        const status = item.status || "active";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, { active: 0, void: 0, used: 0 });
      return {
        ...batch,
        codes: visibleCodes,
        quantity: visibleCodes.length,
        counts,
      };
    })
    .filter((batch) => (batch.codes || []).length > 0);
  return { codes: manageableCodes, batches: manageableBatches };
}

export async function getRedeemCodePublic(codeValue) {
  const code = normalizeRedeemCode(codeValue);
  if (!code) return { ok: false, error: "code_not_found" };
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item) return { ok: false, error: "code_not_found" };
  const type = redeemCodeType(item);
  return {
    ok: true,
    code,
    type,
    status: item.status || "active",
    amount: roundMoney(item.amount),
    services: type === "service" ? serviceSummaries(item.services || []) : [],
    requiresLogin: type === "balance",
    createdAtBeijing: item.createdAtBeijing || "",
  };
}

export async function updateRedeemCodeStatus(codeValue, status, actor = null) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item) return { ok: false, error: "code_not_found" };
  if (item.status === "used" && status !== "deleted") return { ok: false, error: "code_already_used" };
  const now = new Date();
  const next = { ...item, status, updatedAt: now.toISOString() };
  const actorInfo = actor ? adminActorFromSession(actor) : null;
  if (status === "void") {
    next.voidedAt = now.toISOString();
    next.voidedAtBeijing = formatBeijingTime(now);
    if (actorInfo) {
      next.voidedByStaffId = actorInfo.staffId;
      next.voidedByStaffUsername = actorInfo.staffUsername;
    }
  }
  const saved = await setJsonKey(redeemCodeKey(code), next);
  if (!saved) return { ok: false, error: "save_failed" };
  await pushAdminActionLog({
    action: "redeem_code_" + status,
    actor: actorInfo,
    target: "redeem-code:" + code,
    detail: { batchId: item.batchId || "", type: redeemCodeType(item), amount: item.amount || 0 },
  });
  return { ok: true, code: next };
}

export async function deleteRedeemCode(codeValue, actor = null) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (item?.status === "used") return { ok: false, error: "code_already_used" };
  const r = redisConfig();
  if (!r) return { ok: false, error: "storage_failed" };
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["DEL", redeemCodeKey(code)],
        ["LREM", REDEEM_LIST_KEY, "0", code],
      ]),
    });
    const actorInfo = actor ? adminActorFromSession(actor) : null;
    await pushAdminActionLog({
      action: "redeem_code_delete",
      actor: actorInfo,
      target: "redeem-code:" + code,
      detail: { batchId: item?.batchId || "", type: item ? redeemCodeType(item) : "", amount: item?.amount || 0 },
    });
    return { ok: res.ok };
  } catch (e) { return { ok: false, error: "delete_failed" }; }
}

export async function deleteRedeemHistoryEntries(codes, actor = null) {
  const codeSet = new Set((Array.isArray(codes) ? codes : [])
    .map((code) => normalizeRedeemCode(code))
    .filter(Boolean));
  if (codeSet.size === 0) return { ok: false, error: "no_codes" };
  const actorInfo = actor ? adminActorFromSession(actor) : null;
  const now = new Date();
  const removed = [];
  for (const code of codeSet) {
    const item = await getJsonKey(redeemCodeKey(code));
    if (!item || item.status !== "used" || item.historyDeleted) continue;
    const next = {
      ...item,
      historyDeleted: true,
      historyDeletedAt: now.toISOString(),
      historyDeletedAtBeijing: formatBeijingTime(now),
    };
    if (actorInfo) {
      next.historyDeletedByStaffId = actorInfo.staffId;
      next.historyDeletedByStaffUsername = actorInfo.staffUsername;
    }
    const saved = await setJsonKey(redeemCodeKey(code), next);
    if (saved) removed.push(code);
  }
  if (removed.length === 0) return { ok: false, error: "not_found" };
  await pushAdminActionLog({
    action: "redeem_history_delete",
    actor: actorInfo,
    target: "redeem-history:" + removed.length,
    detail: { codes: removed, deletedCount: removed.length },
  });
  return {
    ok: true,
    deletedCount: removed.length,
    notFound: Array.from(codeSet).filter((code) => !removed.includes(code)),
  };
}

export async function updateRedeemBatchStatus(batchId, status, actor = null) {
  const id = clean(batchId, 80);
  const batch = await getJsonKey(redeemBatchKey(id));
  if (!batch) return { ok: false, error: "batch_not_found" };
  const codes = Array.isArray(batch.codes) ? batch.codes : [];
  const actorInfo = actor ? adminActorFromSession(actor) : null;
  const results = [];
  for (const code of codes) {
    const item = await getJsonKey(redeemCodeKey(code));
    if (!item || item.status !== "active") {
      results.push({ code, ok: false, skipped: true });
      continue;
    }
    const updated = await updateRedeemCodeStatus(code, status, actorInfo);
    results.push({ code, ok: updated.ok });
  }
  const now = new Date();
  const next = {
    ...batch,
    status,
    updatedAt: now.toISOString(),
    updatedAtBeijing: formatBeijingTime(now),
  };
  if (status === "void") {
    next.voidedAtBeijing = formatBeijingTime(now);
    if (actorInfo) next.voidedByStaffId = actorInfo.staffId;
  }
  await setJsonKey(redeemBatchKey(id), next);
  await pushAdminActionLog({
    action: "redeem_batch_" + status,
    actor: actorInfo,
    target: "redeem-batch:" + id,
    detail: { total: codes.length, changed: results.filter((r) => r.ok).length },
  });
  return { ok: true, batch: next, results };
}

export async function deleteRedeemBatch(batchId, actor = null) {
  const id = clean(batchId, 80);
  const batch = await getJsonKey(redeemBatchKey(id));
  if (!batch) return { ok: false, error: "batch_not_found" };
  const codes = Array.isArray(batch.codes) ? batch.codes : [];
  const codeItems = await Promise.all(codes.map(async (code) => ({
    code,
    item: await getJsonKey(redeemCodeKey(code)),
  })));
  const deletableCodes = codeItems
    .filter(({ item }) => !item || (item.status || "active") !== "used")
    .map(({ code }) => code);
  const preservedCodes = codeItems
    .filter(({ item }) => item && (item.status || "active") === "used")
    .map(({ code }) => code);
  const r = redisConfig();
  if (!r) return { ok: false, error: "storage_failed" };
  const commands = [
    ...deletableCodes.flatMap((code) => [
      ["DEL", redeemCodeKey(code)],
      ["LREM", REDEEM_LIST_KEY, "0", code],
    ]),
    ["DEL", redeemBatchKey(id)],
    ["LREM", REDEEM_BATCH_LIST_KEY, "0", id],
  ];
  try {
    const res = await fetch(r.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + r.token, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    const actorInfo = actor ? adminActorFromSession(actor) : null;
    await pushAdminActionLog({
      action: "redeem_batch_delete",
      actor: actorInfo,
      target: "redeem-batch:" + id,
      detail: {
        total: codes.length,
        deleted: deletableCodes.length,
        preservedUsed: preservedCodes.length,
        type: redeemCodeType(batch),
        amount: batch.amount || 0,
      },
    });
    return { ok: res.ok };
  } catch (e) { return { ok: false, error: "delete_failed" }; }
}

export async function redeemCodeForUser(email, codeValue, meta = {}) {
  const lower = String(email || "").trim().toLowerCase();
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item) return { ok: false, error: "code_not_found" };
  if (item.status !== "active") return { ok: false, error: "code_unavailable" };
  if (redeemCodeType(item) !== "balance") return { ok: false, error: "service_code_checkout_required" };
  const amount = roundMoney(item.amount);
  if (amount <= 0) return { ok: false, error: "invalid_amount" };
  const user = await getUser(lower);
  if (!user) return { ok: false, error: "user_not_found" };
  const prev = roundMoney(user.balance);
  user.balance = roundMoney(prev + amount);
  const now = new Date();
  const updatedCode = {
    ...item,
    status: "used",
    usedBy: lower,
    usedIp: clean(meta.ip || "", 80),
    usedUserAgent: clean(meta.userAgent || "", 500),
    usedAt: now.toISOString(),
    usedAtBeijing: formatBeijingTime(now),
  };
  const savedUser = await setUser(lower, user);
  const savedCode = await setJsonKey(redeemCodeKey(code), updatedCode);
  if (!savedUser || !savedCode) return { ok: false, error: "save_failed" };
  const tx = {
    id: makeId("TX"),
    amount,
    reason: "兑换码充值 " + code,
    balanceAfter: user.balance,
    source: "redeem",
    redeemCode: code,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  await addBalanceTx(lower, tx);
  await pushAdminBalanceLog({ ...tx, email: lower, balanceBefore: prev });
  return { ok: true, balance: user.balance, amount };
}

export async function validateServiceRedeemCode(codeValue, orderServices) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item) return { ok: false, error: "code_not_found" };
  if (item.status !== "active") return { ok: false, error: "code_unavailable" };
  if (redeemCodeType(item) !== "service") return { ok: false, error: "not_service_code" };
  const codeServices = normalizeRedeemServices(item.services || []);
  const submitted = normalizeRedeemServices(orderServices);
  if (codeServices.length === 0 || !servicesEqual(codeServices, submitted)) {
    return { ok: false, error: "service_mismatch", services: serviceSummaries(codeServices) };
  }
  return { ok: true, code, item: { ...item, type: "service", services: serviceSummaries(codeServices) } };
}

export async function consumeServiceRedeemCode(codeValue, email, orderId, meta = {}) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item || item.status !== "active" || redeemCodeType(item) !== "service") return { ok: false, error: "code_unavailable" };
  const now = new Date();
  const next = {
    ...item,
    type: "service",
    status: "used",
    usedBy: clean(email, 200),
    usedOrderId: clean(orderId, 80),
    usedIp: clean(meta.ip || "", 80),
    usedUserAgent: clean(meta.userAgent || "", 500),
    usedAt: now.toISOString(),
    usedAtBeijing: formatBeijingTime(now),
  };
  const saved = await setJsonKey(redeemCodeKey(code), next);
  if (!saved) return { ok: false, error: "save_failed" };
  return { ok: true, code: next };
}

export async function restoreServiceRedeemCode(codeValue, orderId) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item || item.status !== "used" || item.usedOrderId !== orderId) return false;
  const next = { ...item, status: "active" };
  delete next.usedBy;
  delete next.usedOrderId;
  delete next.usedIp;
  delete next.usedUserAgent;
  delete next.usedAt;
  delete next.usedAtBeijing;
  return setJsonKey(redeemCodeKey(code), next);
}

export async function createWithdrawal(email, amount, alipayAccount, realName) {
  const lower = String(email || "").trim().toLowerCase();
  const value = roundMoney(amount);
  const alipay = clean(alipayAccount, 160);
  const name = clean(realName, 80);
  if (value <= 0 || value > 100000 || !alipay || !name) return { ok: false, error: "missing_required_fields" };
  const user = await getUser(lower);
  if (!user) return { ok: false, error: "user_not_found" };
  const prev = roundMoney(user.balance);
  if (prev < value) return { ok: false, error: "insufficient_balance", currentBalance: prev };
  const now = new Date();
  const withdrawalId = makeId("WD");
  const txId = makeId("TX");
  const withdrawal = {
    id: withdrawalId,
    userEmail: lower,
    username: user.username || "",
    amount: value,
    alipayAccount: alipay,
    realName: name,
    status: "pending",
    statusLabel: WITHDRAWAL_STATUS_LABEL.pending,
    txId,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    updatedAt: now.toISOString(),
    updatedAtBeijing: formatBeijingTime(now),
  };
  user.balance = roundMoney(prev - value);
  const savedUser = await setUser(lower, user);
  if (!savedUser) return { ok: false, error: "save_failed" };
  const tx = {
    id: txId,
    amount: -value,
    reason: "提现申请",
    balanceAfter: user.balance,
    source: "withdrawal",
    withdrawalId,
    status: "pending",
    statusLabel: WITHDRAWAL_STATUS_LABEL.pending,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  await addBalanceTx(lower, tx);
  await pushAdminBalanceLog({ ...tx, email: lower, balanceBefore: prev });
  const stored = await redisPipeline([
    ["SET", withdrawalKey(withdrawalId), JSON.stringify(withdrawal)],
    ["LPUSH", WITHDRAWAL_LIST_KEY, withdrawalId],
    ["LTRIM", WITHDRAWAL_LIST_KEY, "0", "499"],
  ]);
  if (!stored) return { ok: false, error: "withdrawal_storage_failed" };
  return { ok: true, withdrawal, balance: user.balance };
}

export async function listWithdrawals() {
  const ids = await redisCmd(["LRANGE", WITHDRAWAL_LIST_KEY, "0", "499"]);
  if (!Array.isArray(ids)) return [];
  const unique = Array.from(new Set(ids));
  const items = await Promise.all(unique.map((id) => getJsonKey(withdrawalKey(id))));
  return items.filter(Boolean);
}

export async function deleteWithdrawals(ids, actor = null) {
  const idSet = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => clean(id, 120))
    .filter(Boolean));
  if (idSet.size === 0) return { ok: false, error: "no_ids" };
  const rawIds = await redisCmd(["LRANGE", WITHDRAWAL_LIST_KEY, "0", "499"]);
  const currentIds = Array.isArray(rawIds) ? rawIds.map((id) => clean(id, 120)).filter(Boolean) : [];
  const removedIds = Array.from(new Set(currentIds.filter((id) => idSet.has(id))));
  if (removedIds.length === 0) return { ok: false, error: "not_found" };
  const remainingIds = currentIds.filter((id) => !idSet.has(id));
  const commands = [
    ["DEL", WITHDRAWAL_LIST_KEY],
    ...remainingIds.map((id) => ["RPUSH", WITHDRAWAL_LIST_KEY, id]),
    ...removedIds.map((id) => ["DEL", withdrawalKey(id)]),
  ];
  const saved = await redisPipeline(commands);
  if (!saved) return { ok: false, error: "storage_failed" };
  await pushAdminActionLog({
    action: "withdrawal_delete",
    actor,
    target: "withdrawals:" + removedIds.length,
    detail: { ids: Array.from(idSet), deletedCount: removedIds.length },
  });
  return {
    ok: true,
    deletedCount: removedIds.length,
    notFound: Array.from(idSet).filter((id) => !removedIds.includes(id)),
  };
}

export async function getWithdrawalDetail(id) {
  const withdrawal = await getJsonKey(withdrawalKey(id));
  if (!withdrawal) return null;
  const user = await getUser(withdrawal.userEmail);
  const transactions = await getBalanceTxs(withdrawal.userEmail);
  return {
    withdrawal,
    user: user ? {
      email: user.email,
      username: user.username || "",
      balance: roundMoney(user.balance),
      createdAtBeijing: user.createdAtBeijing || "",
    } : null,
    transactions: decorateWithdrawalTransactions(transactions, withdrawal),
  };
}

export function decorateWithdrawalTransactions(transactions, focusedWithdrawal = null) {
  return (Array.isArray(transactions) ? transactions : []).map((tx) => {
    if (tx.withdrawalId && focusedWithdrawal && tx.withdrawalId === focusedWithdrawal.id) {
      return {
        ...tx,
        status: focusedWithdrawal.status,
        statusLabel: WITHDRAWAL_STATUS_LABEL[focusedWithdrawal.status] || focusedWithdrawal.statusLabel || tx.statusLabel,
      };
    }
    return tx;
  });
}

export async function updateWithdrawalStatus(id, status, note = "", actor = null) {
  const nextStatus = clean(status, 30);
  if (!WITHDRAWAL_STATUS_LABEL[nextStatus]) return { ok: false, error: "invalid_status" };
  const withdrawal = await getJsonKey(withdrawalKey(id));
  if (!withdrawal) return { ok: false, error: "withdrawal_not_found" };
  const oldStatus = withdrawal.status || "pending";
  const user = await getUser(withdrawal.userEmail);
  if (!user) return { ok: false, error: "user_not_found" };
  const now = new Date();
  const prev = roundMoney(user.balance);
  const actorInfo = actor ? adminActorFromSession(actor) : null;
  let balanceChanged = false;
  if (oldStatus !== "failed" && nextStatus === "failed") {
    user.balance = roundMoney(prev + Number(withdrawal.amount || 0));
    balanceChanged = true;
    const tx = {
      id: makeId("TX"),
      amount: Number(withdrawal.amount || 0),
      reason: "提现审核失败退回",
      balanceAfter: user.balance,
      source: "withdrawal",
      withdrawalId: withdrawal.id,
      status: "failed",
      statusLabel: WITHDRAWAL_STATUS_LABEL.failed,
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
    };
    await addBalanceTx(withdrawal.userEmail, tx);
    await pushAdminBalanceLog({ ...tx, email: withdrawal.userEmail, balanceBefore: prev, staffId: actorInfo?.staffId || 1, staffUsername: actorInfo?.staffUsername || "admin" });
  } else if (oldStatus === "failed" && nextStatus !== "failed") {
    const amount = Number(withdrawal.amount || 0);
    if (prev < amount) return { ok: false, error: "insufficient_balance" };
    user.balance = roundMoney(prev - amount);
    balanceChanged = true;
    const tx = {
      id: makeId("TX"),
      amount: -amount,
      reason: "提现重新审核冻结",
      balanceAfter: user.balance,
      source: "withdrawal",
      withdrawalId: withdrawal.id,
      status: nextStatus,
      statusLabel: WITHDRAWAL_STATUS_LABEL[nextStatus],
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
    };
    await addBalanceTx(withdrawal.userEmail, tx);
    await pushAdminBalanceLog({ ...tx, email: withdrawal.userEmail, balanceBefore: prev, staffId: actorInfo?.staffId || 1, staffUsername: actorInfo?.staffUsername || "admin" });
  }
  if (balanceChanged) await setUser(withdrawal.userEmail, user);
  const next = {
    ...withdrawal,
    status: nextStatus,
    statusLabel: WITHDRAWAL_STATUS_LABEL[nextStatus],
    reviewNote: clean(note, 400),
    updatedAt: now.toISOString(),
    updatedAtBeijing: formatBeijingTime(now),
  };
  if (actorInfo) {
    next.updatedByStaffId = actorInfo.staffId;
    next.updatedByStaffUsername = actorInfo.staffUsername;
  }
  const saved = await setJsonKey(withdrawalKey(id), next);
  if (!saved) return { ok: false, error: "save_failed" };
  await pushAdminActionLog({
    action: "withdrawal_status",
    actor: actorInfo,
    target: "withdrawal:" + withdrawal.id,
    detail: { from: oldStatus, to: nextStatus, amount: withdrawal.amount || 0, email: withdrawal.userEmail },
  });
  return { ok: true, withdrawal: next, balance: roundMoney(user.balance) };
}
