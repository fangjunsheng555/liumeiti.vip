// Shared backend utilities: redis, password hashing, session signing

import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_AVATAR_IDS, isUserAvatarId, normalizeUserAvatarId } from "../lib/avatars.js";
import { hasPendingSpotifyPasswordCorrection } from "../lib/order-attention.js";
import { mergeSettings } from "../lib/settings-defaults.js";
import {
  applyBalanceEffectAtomic,
  accountLifecycleKey,
  adjustStockEffectAtomic,
  balanceCentsKey,
  createWithdrawalAtomic,
  redeemBalanceCodeAtomic,
  restoreServiceCodeAtomic,
  saveUserPreservingBalanceAtomic,
  consumeServiceCodeAtomic,
  transferBalanceAtomic,
  transitionWithdrawalAtomic,
  transitionOrderCouponAtomic,
  idempotencyPayloadHash,
  redisEvalAtomic,
} from "./_money.js";
import {
  REDIS_ATOMIC_CLUSTER_MODE,
  redisAtomicKeyspaceMode,
} from "./_redis-atomic-keyspace.js";

export const ORDERS_KEY = "liumeiti:orders";
export const ORDER_INDEX_KEY = ORDERS_KEY + ":index";
export const ORDER_INDEX_MEMBERSHIP_KEY = ORDER_INDEX_KEY + ":members";
export const ORDER_DELETED_INDEX_KEY = ORDERS_KEY + ":deleted-index"; // SET of soft-deleted order ids(供快速分页精确排除)
export const ORDER_RECORD_PREFIX = ORDERS_KEY + ":record:";
export const ORDER_EMAIL_INDEX_PREFIX = ORDERS_KEY + ":email:";
export const ORDER_REFERENCE_INDEX_PREFIX = ORDERS_KEY + ":reference:";
export const USDT_PENDING_ORDER_INDEX_KEY = ORDERS_KEY + ":usdt-pending";
export const QUOTE_EXPIRY_ORDER_INDEX_KEY = ORDERS_KEY + ":quote-expiry";
export const ORDER_OVERVIEW_HASH_KEY = ORDERS_KEY + ":overview";
export const ORDER_SUMMARY_INDEX_KEY = ORDERS_KEY + ":summary-created";
export const ORDER_LIST_REVISION_KEY = ORDERS_KEY + ":list-revision";
// v8 invalidates the partial v7 shadow. Only derived indexes are replaced;
// authoritative order records remain byte-for-byte untouched.
const ORDER_OVERVIEW_READY_KEY = ORDER_OVERVIEW_HASH_KEY + ":ready:v8";
const ORDER_OVERVIEW_COUNT_KEY = ORDER_OVERVIEW_HASH_KEY + ":count:v8";
const ORDER_INDEX_MIGRATION_READY_KEY = ORDER_INDEX_KEY + ":legacy-ready";
const ORDER_INDEX_MIGRATION_LOCK_KEY = ORDER_INDEX_KEY + ":legacy-lock";
const ORDER_INDEX_MEMBERSHIP_READY_KEY = ORDER_INDEX_MEMBERSHIP_KEY + ":ready:v1";
const ORDER_INDEX_MEMBERSHIP_LOCK_KEY = ORDER_INDEX_MEMBERSHIP_KEY + ":migration-lock";
const ORDER_RECORD_INDEX_READY_KEY = ORDER_INDEX_KEY + ":record-ready:v1";
const ORDER_RECORD_INDEX_LOCK_KEY = ORDER_INDEX_KEY + ":record-lock";
export const USERS_KEY = "liumeiti:users";

export function clean(value, limit = 500) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);
}

function jsonStringEnd(source, start) {
  if (source[start] !== '"') return -1;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  return -1;
}

function jsonValueEnd(source, start) {
  if (source[start] === '"') return jsonStringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start]];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) return -1;
        if (stack.length === 0) return index + 1;
      }
    }
    return -1;
  }
  let end = start;
  while (end < source.length && source[end] !== "," && source[end] !== "}") end += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return end;
}

export function replaceTopLevelJsonFields(raw, replacements) {
  if (typeof raw !== "string" || !raw || !replacements || typeof replacements !== "object") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  const requested = replacements instanceof Map ? [...replacements.entries()] : Object.entries(replacements);
  const encoded = new Map();
  try {
    for (const [key, value] of requested) {
      if (typeof key !== "string" || !key || encoded.has(key)) return null;
      const valueJson = JSON.stringify(value);
      if (valueJson === undefined) return null;
      encoded.set(key, valueJson);
    }
  } catch {
    return null;
  }

  let index = 0;
  while (index < raw.length && /\s/.test(raw[index])) index += 1;
  if (raw[index] !== "{") return null;
  const openIndex = index;
  index += 1;
  const spans = new Map();
  let propertyCount = 0;
  let lastValueEnd = index;
  let closeIndex = -1;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (raw[index] === "}") { closeIndex = index; break; }
    const keyStart = index;
    const keyEnd = jsonStringEnd(raw, keyStart);
    if (keyEnd < 0) return null;
    let key;
    try { key = JSON.parse(raw.slice(keyStart, keyEnd)); } catch { return null; }
    if (typeof key !== "string" || spans.has(key)) return null;
    index = keyEnd;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (raw[index] !== ":") return null;
    index += 1;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    const valueStart = index;
    const valueEnd = jsonValueEnd(raw, valueStart);
    if (valueEnd <= valueStart) return null;
    try { JSON.parse(raw.slice(valueStart, valueEnd)); } catch { return null; }
    spans.set(key, { start: valueStart, end: valueEnd });
    propertyCount += 1;
    lastValueEnd = valueEnd;
    index = valueEnd;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (raw[index] === ",") { index += 1; continue; }
    if (raw[index] === "}") { closeIndex = index; break; }
    return null;
  }
  if (closeIndex < 0) return null;
  for (let tail = closeIndex + 1; tail < raw.length; tail += 1) if (!/\s/.test(raw[tail])) return null;

  const edits = [];
  const missing = [];
  for (const [key, valueJson] of encoded) {
    const span = spans.get(key);
    if (span) edits.push({ ...span, text: valueJson });
    else missing.push(`${JSON.stringify(key)}:${valueJson}`);
  }
  if (missing.length) {
    edits.push({
      start: propertyCount ? lastValueEnd : openIndex + 1,
      end: propertyCount ? lastValueEnd : openIndex + 1,
      text: `${propertyCount ? "," : ""}${missing.join(",")}`,
    });
  }
  edits.sort((left, right) => right.start - left.start);
  let next = raw;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  try { JSON.parse(next); } catch { return null; }
  return next;
}

export function validEmail(value) {
  const email = String(value || "").trim();
  return email.length > 3
    && email.length <= 254
    && !/[\x00-\x1f\x7f]/.test(email)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function readRedisStringState(key) {
  const rows = pipelineResults(await redisPipeline([["GET", key], ["PING"]]));
  if (rows.length !== 2 || rows.some((row) => row && typeof row === "object"
    && Object.hasOwn(row, "error") && row.error != null)) {
    return { ok: false, exists: false, raw: null, error: "storage_failed" };
  }
  const raw = pipelineResultValue(rows[0]);
  const pong = pipelineResultValue(rows[1]);
  if (pong !== "PONG") return { ok: false, exists: false, raw: null, error: "storage_failed" };
  if (raw == null) return { ok: true, exists: false, raw: null };
  return typeof raw === "string"
    ? { ok: true, exists: true, raw }
    : { ok: false, exists: true, raw: null, error: "storage_failed" };
}

function normalizeOrderIdForStorage(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmailForStorage(value) {
  const email = String(value || "").trim().toLowerCase(); return validEmail(email) ? email : "";
}

export function normalizeInternalReference(value) {
  return clean(value, 32)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function orderRecordKey(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  return id ? ORDER_RECORD_PREFIX + id : "";
}

function orderEmailIndexKey(email) {
  const lower = normalizeEmailForStorage(email);
  return lower ? ORDER_EMAIL_INDEX_PREFIX + lower : "";
}

function orderReferenceIndexKey(reference) {
  const normalized = normalizeInternalReference(reference);
  return normalized ? ORDER_REFERENCE_INDEX_PREFIX + normalized : "";
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
        passwordCorrectionRequestedAt: item?.passwordCorrectionRequestedAt || "",
        customerPasswordUpdatedAt: item?.customerPasswordUpdatedAt || "",
        customerPasswordUpdatedAtBeijing: item?.customerPasswordUpdatedAtBeijing || "",
        customerPasswordUpdateCount: Number(item?.customerPasswordUpdateCount || 0),
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
    usdtTxId: order.usdtTxId || "",
    passwordCorrectionPending: hasPendingSpotifyPasswordCorrection(order),
    referral: order.referral ? {
      levelOneEmail: order.referral.levelOneEmail || "",
    } : null,
    referralCommissionSettledAt: order.referralCommissionSettledAt || "",
    referralCommissionSettledAtBeijing: order.referralCommissionSettledAtBeijing || "",
    referralCommissionEntries: Array.isArray(order.referralCommissionEntries)
      ? order.referralCommissionEntries.map((entry) => ({
        email: entry?.email || "",
        level: Number(entry?.level || 0),
        amount: Number(entry?.amount || 0),
      }))
      : [],
    referralCommissionReversedAt: order.referralCommissionReversedAt || "",
    referralCommissionReversedAtBeijing: order.referralCommissionReversedAtBeijing || "",
    referralCommissionReversedEntries: Array.isArray(order.referralCommissionReversedEntries)
      ? order.referralCommissionReversedEntries.map((entry) => ({
        email: entry?.email || "",
        level: Number(entry?.level || 0),
        amount: Number(entry?.amount || 0),
      }))
      : [],
    lastStaffId: Array.isArray(order.staffAudit) && order.staffAudit[0]?.staffId
      ? Number(order.staffAudit[0].staffId)
      : null,
    renewalReminderForExpiresAt: order.renewalReminderForExpiresAt || "",
    assignedStaffId: Number(order.assignedStaffId || 0),
    assignedStaffUsername: order.assignedStaffUsername || "",
    assignedAt: order.assignedAt || "",
    assignedAtBeijing: order.assignedAtBeijing || "",
    internalReference: normalizeInternalReference(order.internalReference),
    netflixSelfServiceEnabled: order.netflixSelfServiceEnabled !== false,
    netflixDeliveryMode: ["self_service", "password"].includes(order.netflixDeliveryMode) ? order.netflixDeliveryMode : "",
    slaReminderKey: order.slaReminderKey || "",
    slaReminderSentAt: order.slaReminderSentAt || "",
  };
}

function parseOrderJson(value, expectedId = "") {
  if (!value) return null;
  let order = value;
  if (typeof value !== "object") {
    try { order = JSON.parse(value); } catch (e) { return null; }
  }
  if (!order || typeof order !== "object" || Array.isArray(order)) return null;
  const id = normalizeOrderIdForStorage(order.orderId);
  return id && (!expectedId || id === normalizeOrderIdForStorage(expectedId)) ? order : null;
}

function pipelineResults(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

function pipelineResultValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
    ? entry.result
    : entry;
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
  const entries = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batchIds = ids.slice(offset, offset + 100);
    const response = await redisPipeline(batchIds.map((id) => ["GET", orderRecordKey(id)]));
    const rows = pipelineResults(response);
    if (rows.length !== batchIds.length) {
      throw new Error("order_record_batch_unavailable");
    }
    rows.forEach((entry, index) => {
      const raw = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
        ? entry.result
        : entry;
      const order = parseOrderJson(raw, batchIds[index]);
      if (raw != null && !order) throw new Error("order_store_corrupt");
      if (order) entries.push({ orderId: batchIds[index], order });
    });
  }
  return entries;
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

async function scanOrderRecordIds() {
  const ids = [];
  const seen = new Set();
  let cursor = "0";
  let rounds = 0;
  do {
    const result = await redisCmd([
      "SCAN", cursor, "MATCH", ORDER_RECORD_PREFIX + "*", "COUNT", "500",
    ]);
    if (!Array.isArray(result) || !Array.isArray(result[1])) return null;
    cursor = String(result[0] || "0");
    for (const key of result[1]) {
      const value = String(key || "");
      if (!value.startsWith(ORDER_RECORD_PREFIX)) continue;
      const id = normalizeOrderIdForStorage(value.slice(ORDER_RECORD_PREFIX.length));
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    rounds += 1;
    if (rounds > 100000) return null;
  } while (cursor !== "0");
  return ids;
}

const ADD_ORDER_INDEX_MEMBER_SCRIPT = `
local function keytype(key) local result=redis.call('TYPE',key) if type(result)=='table' then return result.ok end return result end local function validtype(key,expected) local actual=keytype(key) return actual=='none' or actual==expected end if not validtype(KEYS[1],'set') then return redis.error_reply('storage_type_error:key1') end if not validtype(KEYS[2],'list') then return redis.error_reply('storage_type_error:key2') end local added=redis.call('SADD',KEYS[1],ARGV[1]) if added==1 then redis.call('RPUSH',KEYS[2],ARGV[1]) end return '{"ok":true,"added":'..tostring(added)..'}'
`;

function addOrderIndexMemberCommand(orderId) {
  return [
    "EVAL", ADD_ORDER_INDEX_MEMBER_SCRIPT, "2",
    ORDER_INDEX_MEMBERSHIP_KEY, ORDER_INDEX_KEY, orderId,
  ];
}

async function backfillOrderIndexMembership() {
  const rawIds = await redisCmd(["LRANGE", ORDER_INDEX_KEY, "0", "-1"]);
  if (!Array.isArray(rawIds)) return false;
  const ids = Array.from(new Set(rawIds.map(normalizeOrderIdForStorage).filter(Boolean)));
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const result = await redisPipeline([["SADD", ORDER_INDEX_MEMBERSHIP_KEY, ...batch]]);
    const rows = pipelineResults(result);
    if (rows.length !== 1 || rows[0]?.error) return false;
  }
  return await redisCmd(["SET", ORDER_INDEX_MEMBERSHIP_READY_KEY, "1"]) === "OK";
}

// Historical deployments only kept a LIST. Backfill its IDs once before any
// CAS write starts using the O(1) membership SET, otherwise the first update of
// an old order could append a duplicate list entry.
async function ensureOrderIndexMembership() {
  if (!redisConfig()) return false;
  if (await redisCmd(["GET", ORDER_INDEX_MEMBERSHIP_READY_KEY]) === "1") return true;
  const lockToken = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", ORDER_INDEX_MEMBERSHIP_LOCK_KEY, lockToken, "EX", "60", "NX"]);
  if (locked !== "OK") {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (await redisCmd(["GET", ORDER_INDEX_MEMBERSHIP_READY_KEY]) === "1") return true;
    }
    // The migration is additive and idempotent, so independently finishing it
    // is safe if the lock holder is slow or its response was lost.
    return backfillOrderIndexMembership();
  }
  try {
    return await backfillOrderIndexMembership();
  } finally {
    const release = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await redisCmd(["EVAL", release, "1", ORDER_INDEX_MEMBERSHIP_LOCK_KEY, lockToken]);
  }
}

async function ensureStandaloneOrderIndex() {
  if (!redisConfig()) return false;
  if (await redisCmd(["GET", ORDER_RECORD_INDEX_READY_KEY]) === "1") return true;
  const lockToken = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", ORDER_RECORD_INDEX_LOCK_KEY, lockToken, "EX", "60", "NX"]);
  if (locked !== "OK") return false;
  try {
    const [recordIds, indexedIds] = await Promise.all([
      scanOrderRecordIds(),
      getOrderIdsFromIndex(ORDER_INDEX_KEY, "0", "-1"),
    ]);
    if (!Array.isArray(recordIds)) return false;
    const indexed = new Set(indexedIds);
    const missingIds = recordIds.filter((id) => !indexed.has(id));
    if (missingIds.length) {
      const recovered = await getOrdersByIds(missingIds);
      const commands = [];
      for (const entry of recovered) {
        const order = entry.order;
        const orderId = normalizeOrderIdForStorage(entry.orderId || order?.orderId);
        if (!order || !orderId) continue;
        commands.push(addOrderIndexMemberCommand(orderId));
        if (order.deleted) {
          commands.push(["SADD", ORDER_DELETED_INDEX_KEY, orderId]);
          continue;
        }
        const buyerEmailKey = orderEmailIndexKey(order.email);
        const userEmailKey = orderEmailIndexKey(order.userEmail);
        if (buyerEmailKey) commands.push(["LPUSH", buyerEmailKey, orderId]);
        if (userEmailKey && userEmailKey !== buyerEmailKey) commands.push(["LPUSH", userEmailKey, orderId]);
      }
      for (let offset = 0; offset < commands.length; offset += 100) {
        const batch = commands.slice(offset, offset + 100);
        const result = await redisPipeline(batch);
        const rows = pipelineResults(result);
        if (rows.length !== batch.length || rows.some((item) => item?.error)) return false;
      }
    }
    return await redisCmd(["SET", ORDER_RECORD_INDEX_READY_KEY, "1"]) === "OK";
  } catch (e) {
    return false;
  } finally {
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await redisCmd(["EVAL", script, "1", ORDER_RECORD_INDEX_LOCK_KEY, lockToken]);
  }
}

export async function saveOrderRecord(order) {
  if (!redisConfig() || !order?.orderId) return false;
  const orderId = normalizeOrderIdForStorage(order.orderId);
  if (!orderId) return false;
  const entry = await getOrderEntryById(orderId);
  return setOrderAt(
    entry?.index || { orderId, legacyIndex: null },
    order,
    entry?.order ? { expectedRevision: Number(entry.order.revision ?? 0) } : {},
  );
}

export async function getOrderById(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const raw = await redisCmd(["GET", orderRecordKey(id)]);
  const stored = parseOrderJson(raw, id);
  if (raw != null && !stored) return null;
  if (stored) return stored.deleted ? null : stored;
  const legacy = await getLegacyOrderEntries();
  const found = legacy.find((entry) => normalizeOrderIdForStorage(entry.order?.orderId) === id);
  return found?.order && !found.order.deleted ? found.order : null;
}

// Strict variant for administrative/operational reads. A missing order is a
// valid result, but a Redis outage or malformed stored record must not be
// mistaken for that absence.
export async function getOrderByIdStrict(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const rows = pipelineResults(await redisPipeline([
    ["GET", orderRecordKey(id)],
    ["LRANGE", ORDERS_KEY, "0", "-1"],
    ["PING"],
  ]));
  const failed = rows.length !== 3 || rows.some((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "error")
  ));
  if (failed || pipelineResultValue(rows[2]) !== "PONG") {
    const error = new Error("order_store_unavailable");
    error.code = "order_store_unavailable";
    throw error;
  }
  const raw = pipelineResultValue(rows[0]);
  if (raw != null) {
    const stored = parseOrderJson(raw, id);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      const error = new Error("order_store_corrupt");
      error.code = "order_store_corrupt";
      throw error;
    }
    return stored.deleted ? null : stored;
  }
  const legacyRows = pipelineResultValue(rows[1]);
  if (!Array.isArray(legacyRows)) {
    const error = new Error("order_store_unavailable");
    error.code = "order_store_unavailable";
    throw error;
  }
  let found = null;
  for (const legacyRaw of legacyRows) {
    const order = parseOrderJson(legacyRaw);
    if (!order || typeof order !== "object" || Array.isArray(order)) {
      const error = new Error("order_store_corrupt");
      error.code = "order_store_corrupt";
      throw error;
    }
    if (normalizeOrderIdForStorage(order.orderId) === id) found = order;
  }
  return found && !found.deleted ? found : null;
}

// 单条订单 + 更新句柄:新记录 O(1) 直读(legacyIndex=null);仅旧列表订单才回退
// 扫有界 legacy 列表并带回 legacyIndex,保证 setOrderAt 时旧槽位同步(LSET)。
// 用于需要「按订单号找一单然后回写」的路由,避免 getAllOrdersWithIndex 全量扫描。
export async function getOrderEntryById(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const raw = await redisCmd(["GET", orderRecordKey(id)]);
  const stored = parseOrderJson(raw, id);
  if (raw != null && !stored) {
    const error = new Error("order_store_corrupt"); error.code = "order_store_corrupt"; throw error;
  }
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

// Administrative recovery paths sometimes need to prove that a soft-delete
// already committed after the HTTP response was lost. Normal readers must keep
// using getOrderEntryById/getOrderById, which deliberately hide tombstones.
export async function getOrderEntryByIdIncludingDeleted(orderId) {
  const id = normalizeOrderIdForStorage(orderId);
  if (!id) return null;
  const raw = await redisCmd(["GET", orderRecordKey(id)]);
  const stored = parseOrderJson(raw, id);
  if (raw != null && !stored) {
    const error = new Error("order_store_corrupt"); error.code = "order_store_corrupt"; throw error;
  }
  if (stored) return { index: { orderId: id, legacyIndex: null }, order: stored };
  const legacy = await getLegacyOrderEntries();
  const found = legacy.find((entry) => normalizeOrderIdForStorage(entry.order?.orderId) === id);
  return found?.order ? { index: { orderId: id, legacyIndex: found.index }, order: found.order } : null;
}

export async function getOrdersByInternalReference(reference, limit = 200) {
  const normalized = normalizeInternalReference(reference);
  if (!normalized) return [];
  const key = orderReferenceIndexKey(normalized);
  const ids = await redisCmd(["SMEMBERS", key]);
  const indexed = (await getOrdersByIds(Array.isArray(ids) ? ids : []))
    .map((entry) => entry.order)
    .filter((order) => !order?.deleted && normalizeInternalReference(order?.internalReference) === normalized);
  if (indexed.length) {
    return indexed
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.max(1, Math.min(500, Number(limit || 200))));
  }

  // Historical references are indexed lazily the first time staff search them.
  const matched = (await getAllOrders())
    .filter((order) => normalizeInternalReference(order?.internalReference) === normalized)
    .slice(0, Math.max(1, Math.min(500, Number(limit || 200))));
  if (matched.length) {
    await redisCmd(["SADD", key, ...matched.map((order) => normalizeOrderIdForStorage(order.orderId))]);
  }
  return matched;
}

// Read all stored orders, filtering tombstoned/deleted entries. New orders use
// permanent record keys; the legacy capped JSON list is still merged for old data.
export async function getAllOrders() {
  if (!redisConfig()) return [];
  await ensureLegacyOrderIndex();
  await ensureStandaloneOrderIndex();
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

// Fail-closed full-order reader for reporting and audience selection. The
// legacy getAllOrders() remains intentionally tolerant for customer-facing
// compatibility paths, but a marketing segment must never turn a Redis fault
// into a plausible empty audience or zero attributed revenue.
export async function getAllOrdersStrict() {
  if (!redisConfig()) throw new Error("order_store_unavailable");
  if (!await ensureLegacyOrderIndex() || !await ensureStandaloneOrderIndex()) {
    throw new Error("order_store_unavailable");
  }
  const probe = pipelineResults(await redisPipeline([
    ["LRANGE", ORDER_INDEX_KEY, "0", "-1"],
    ["LRANGE", ORDERS_KEY, "0", "-1"],
    ["PING"],
  ]));
  if (probe.length !== 3 || probe.some((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "error"))) {
    throw new Error("order_store_unavailable");
  }
  const indexedRaw = pipelineResultValue(probe[0]);
  const legacyRaw = pipelineResultValue(probe[1]);
  const pong = pipelineResultValue(probe[2]);
  if (!Array.isArray(indexedRaw) || !Array.isArray(legacyRaw) || pong !== "PONG") {
    throw new Error("order_store_unavailable");
  }
  // The historical record-ready marker is only a migration optimization and
  // cannot prove that every permanent record remains in the LIST forever.
  // A strict report re-scans record keys so an old/stale marker cannot hide an
  // order and understate revenue.
  const standaloneIds = await scanOrderRecordIds();
  if (!Array.isArray(standaloneIds)) throw new Error("order_store_unavailable");
  const legacy = legacyRaw.map((raw) => {
    const order = parseOrderJson(raw);
    if (!order || typeof order !== "object" || Array.isArray(order)) throw new Error("order_store_corrupt");
    return order;
  });
  const legacyById = new Map();
  for (const order of legacy) {
    const id = normalizeOrderIdForStorage(order.orderId);
    if (id) legacyById.set(id, order);
  }
  const ids = Array.from(new Set(
    [...indexedRaw, ...standaloneIds].map(normalizeOrderIdForStorage).filter(Boolean),
  ));
  const indexed = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batchIds = ids.slice(offset, offset + 100);
    const rows = pipelineResults(await redisPipeline(batchIds.map((id) => ["GET", orderRecordKey(id)])));
    if (rows.length !== batchIds.length || rows.some((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "error"))) {
      throw new Error("order_store_unavailable");
    }
    rows.forEach((entry, index) => {
      const raw = pipelineResultValue(entry);
      const legacyOrder = legacyById.get(batchIds[index]);
      if (raw == null) {
        // Historical indexes may predate standalone record keys. The legacy
        // list remains authoritative for that valid shape. With neither body,
        // the order store is corrupt; publishing a smaller "healthy" total
        // would hide actual data loss and return incorrect revenue.
        if (!legacyOrder) throw new Error("order_store_corrupt");
        indexed.push({ orderId: batchIds[index], order: legacyOrder });
        return;
      }
      const order = parseOrderJson(raw, batchIds[index]);
      if (!order || typeof order !== "object" || Array.isArray(order)) {
        throw new Error("order_store_corrupt");
      }
      indexed.push({ orderId: batchIds[index], order });
    });
  }
  const seen = new Set();
  const merged = [];
  for (const order of [...indexed.map((entry) => entry.order), ...legacy]) {
    const id = normalizeOrderIdForStorage(order?.orderId);
    if (!id || order.deleted || seen.has(id)) continue;
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

const ORDER_OVERVIEW_STAGE_MARKER = "__lm_overview_rebuild_sentinel__";
const PUBLISH_ORDER_OVERVIEW_SCRIPT = `
local function keytype(key) local value=redis.call('TYPE',key) if type(value)=='table' then return value.ok end return value end
local expectedRevision=ARGV[1]
local expectedCount=tonumber(ARGV[2])
local currentRevision=redis.call('GET',KEYS[6])
if not currentRevision then currentRevision='__lm_missing_revision__' end
if currentRevision~=expectedRevision then return '{"ok":false,"error":"stale_revision"}' end
if keytype(KEYS[3])~='hash' or keytype(KEYS[4])~='zset' then
  return '{"ok":false,"error":"invalid_stage"}'
end
local hashCount=redis.call('HLEN',KEYS[3])-1
local summaryCount=redis.call('ZCARD',KEYS[4])-1
if not expectedCount or expectedCount<0 or hashCount~=expectedCount or summaryCount~=expectedCount then
  return '{"ok":false,"error":"incomplete_stage"}'
end
redis.call('DEL',KEYS[1]); redis.call('RENAME',KEYS[3],KEYS[1]); redis.call('HDEL',KEYS[1],ARGV[3])
redis.call('DEL',KEYS[2]); redis.call('RENAME',KEYS[4],KEYS[2]); redis.call('ZREM',KEYS[2],ARGV[3])
redis.call('SET',KEYS[5],'1'); redis.call('SET',KEYS[7],tostring(expectedCount))
return '{"ok":true}'
`;

function storageRowsFailed(rows, expectedLength) {
  return rows.length !== expectedLength || rows.some((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "error") && entry.error != null
  ));
}

async function readyOrderOverviewRows() {
  const rows = pipelineResults(await redisPipeline([
    ["GET", ORDER_OVERVIEW_READY_KEY],
    ["GET", ORDER_OVERVIEW_COUNT_KEY],
    ["HVALS", ORDER_OVERVIEW_HASH_KEY],
    ["ZCARD", ORDER_SUMMARY_INDEX_KEY],
    ["PING"],
  ]));
  if (rows.length !== 5 || (rows[4] && typeof rows[4] === "object" && Object.hasOwn(rows[4], "error"))
    || pipelineResultValue(rows[4]) !== "PONG") {
    throw new Error("order_store_unavailable");
  }
  // These four keys are disposable derived state. WRONGTYPE or another
  // per-key cache error must trigger a strict rebuild, not lock staff out of
  // the overview while every authoritative order record is still readable.
  if (rows.slice(0, 4).some((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "error") && entry.error != null
  ))) return null;
  if (pipelineResultValue(rows[0]) !== "1") return null;
  const manifestCountRaw = pipelineResultValue(rows[1]);
  const manifestCount = Number(manifestCountRaw);
  const rawValues = pipelineResultValue(rows[2]);
  const summaryCount = Number(pipelineResultValue(rows[3]));
  if (!/^\d+$/.test(String(manifestCountRaw ?? "")) || !Number.isSafeInteger(manifestCount)
    || manifestCount < 0 || !Array.isArray(rawValues) || !Number.isSafeInteger(summaryCount)) return null;
  const parsed = rawValues.map((value) => parseOrderJson(value));
  const uniqueIds = new Set(parsed.map((row) => normalizeOrderIdForStorage(row?.orderId)).filter(Boolean));
  return parsed.every(Boolean) && parsed.length === rawValues.length && parsed.length === uniqueIds.size
    && parsed.length === manifestCount && summaryCount === manifestCount
    ? parsed
    : null;
}

async function orderListRevisionToken() {
  const rows = pipelineResults(await redisPipeline([["GET", ORDER_LIST_REVISION_KEY], ["PING"]]));
  if (storageRowsFailed(rows, 2) || pipelineResultValue(rows[1]) !== "PONG") {
    throw new Error("order_store_unavailable");
  }
  const revision = pipelineResultValue(rows[0]);
  return revision == null ? "__lm_missing_revision__" : String(revision);
}

async function stageOrderOverviewSnapshots(snapshots, token) {
  const hashKey = `${ORDER_OVERVIEW_HASH_KEY}:stage:${token}`;
  const summaryKey = `${ORDER_SUMMARY_INDEX_KEY}:stage:${token}`;
  const initialized = pipelineResults(await redisPipeline([
    ["HSET", hashKey, ORDER_OVERVIEW_STAGE_MARKER, "1"],
    ["ZADD", summaryKey, "0", ORDER_OVERVIEW_STAGE_MARKER],
  ]));
  if (storageRowsFailed(initialized, 2)) throw new Error("order_overview_rebuild_unavailable");
  try {
    for (let offset = 0; offset < snapshots.length; offset += 50) {
      const commands = snapshots.slice(offset, offset + 50).flatMap((row) => [
        ["HSET", hashKey, row.orderId, JSON.stringify(row)],
        ["ZADD", summaryKey, String(orderCreatedScore(row)), row.orderId],
      ]);
      const rows = pipelineResults(await redisPipeline(commands));
      if (storageRowsFailed(rows, commands.length)) throw new Error("order_overview_rebuild_unavailable");
    }
    return { hashKey, summaryKey };
  } catch (error) {
    await redisPipeline([["DEL", hashKey], ["DEL", summaryKey]]);
    throw error;
  }
}

async function rebuildOrderOverviewRows() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await orderListRevisionToken();
    const orders = await getAllOrdersStrict();
    const snapshots = orders.map(orderOverviewSnapshot).filter(Boolean);
    const token = randomBytes(12).toString("hex");
    const stage = await stageOrderOverviewSnapshots(snapshots, token);
    try {
      const published = await redisEvalAtomic(PUBLISH_ORDER_OVERVIEW_SCRIPT, [
        ORDER_OVERVIEW_HASH_KEY,
        ORDER_SUMMARY_INDEX_KEY,
        stage.hashKey,
        stage.summaryKey,
        ORDER_OVERVIEW_READY_KEY,
        ORDER_LIST_REVISION_KEY,
        ORDER_OVERVIEW_COUNT_KEY,
      ], [revision, String(snapshots.length), ORDER_OVERVIEW_STAGE_MARKER]);
      if (published.ok && published.value?.ok) return snapshots;
      if (published.ok && published.value?.error === "stale_revision") continue;
      throw new Error("order_overview_rebuild_unavailable");
    } finally {
      await redisPipeline([["DEL", stage.hashKey], ["DEL", stage.summaryKey]]);
    }
  }
  // Never return an unfenced snapshot after repeated concurrent writes. A
  // short retry is safer than briefly showing the wrong money or order count.
  throw new Error("order_overview_rebuild_busy");
}

// Compact shadow index for the 10-second admin overview poll. A count manifest
// detects truncated/malformed shadows; rebuilding never mutates order records.
export async function getOrderOverviewRows() {
  if (!redisConfig()) throw new Error("order_store_unavailable");
  const ready = await readyOrderOverviewRows();
  return ready || rebuildOrderOverviewRows();
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

const SET_ORDER_AT_SCRIPT = `
local function keytype(key) local result=redis.call('TYPE',key) if type(result)=='table' then return result.ok end return result end local function validtype(key,expected) local actual=keytype(key) return actual=='none' or actual==expected end local function decode(value) local ok,result=pcall(cjson.decode,value) if not ok or type(result)~='table' then return nil end return result end local function response(value) local ok,encoded=pcall(cjson.encode,value) if not ok then return redis.error_reply('json_encode_failed') end return encoded end local expectedTypes={'string','list','list','zset','zset','hash','zset','string','set','set','set','list','list','list','list','set'} for index,key in ipairs(KEYS) do local required=true if index==9 then required=ARGV[12]=='1' end if index==10 then required=ARGV[13]=='1' end if index>=12 and index<=15 then required=ARGV[index+3]=='1' end if required and not validtype(key,expectedTypes[index]) then return response({ok=false,error='storage_type_error',keyIndex=index}) end end local absent='__LM_ORDER_RECORD_ABSENT__' local current=redis.call('GET',KEYS[1]) if (ARGV[1]==absent and current) or (ARGV[1]~=absent and current~=ARGV[1]) then return response({ok=false,error='stale_order'}) end local baseRaw=current local legacyIndex=tonumber(ARGV[3]) or -1 if legacyIndex>=0 then if legacyIndex~=math.floor(legacyIndex) then return response({ok=false,error='invalid_legacy_index'}) end local legacy=redis.call('LINDEX',KEYS[3],tostring(legacyIndex)) if ARGV[2]==absent or legacy~=ARGV[2] then return response({ok=false,error='stale_order'}) end if not baseRaw then baseRaw=legacy end end local order=decode(ARGV[4]) if not order or tostring(order.orderId or '')~=ARGV[5] then return response({ok=false,error='invalid_order_record'}) end local expectedRevision=tonumber(ARGV[19]) if not expectedRevision or expectedRevision~=math.floor(expectedRevision) or expectedRevision<0 or expectedRevision>9007199254740990 then return response({ok=false,error='invalid_expected_revision'}) end local existing=ARGV[20]=='1' if existing then local baseOrder=decode(baseRaw) if not baseOrder then return response({ok=false,error='invalid_order_record'}) end local storedRevision=tonumber(baseOrder.revision or 0) if not storedRevision or storedRevision~=math.floor(storedRevision) or storedRevision<0 or storedRevision>9007199254740990 then return response({ok=false,error='invalid_order_revision'}) end if storedRevision~=expectedRevision then return response({ok=false,error='stale_order'}) end elseif baseRaw then return response({ok=false,error='stale_order'}) end local nextRevision=tonumber(order.revision) local requiredRevision=existing and (expectedRevision+1) or 1 if not nextRevision or nextRevision~=requiredRevision then return response({ok=false,error='invalid_order_revision'}) end local createdScore=tonumber(ARGV[7]) if not createdScore or createdScore~=createdScore or createdScore<-9007199254740991 or createdScore>9007199254740991 then return response({ok=false,error='invalid_order_score'}) end local quoteScore=tonumber(ARGV[9]) or 0 if ARGV[8]=='1' and (quoteScore<=0 or quoteScore~=quoteScore or quoteScore>9007199254740991) then return response({ok=false,error='invalid_quote_score'}) end local revisionRaw=redis.call('GET',KEYS[8]); local listRevision=0 if revisionRaw then if not string.match(revisionRaw,'^%d+$') then return response({ok=false,error='invalid_order_revision'}) end listRevision=tonumber(revisionRaw) if not listRevision or listRevision~=math.floor(listRevision) or listRevision<0 or listRevision>9007199254740990 then return response({ok=false,error='invalid_order_revision'}) end end local finalResponseOk,finalResponse=pcall(cjson.encode,{ok=true,listRevision=listRevision+1}) if not finalResponseOk then return redis.error_reply('json_encode_failed') end
-- No command below can fail after the complete read/validation phase.
redis.call('SET',KEYS[1],ARGV[4]) if redis.call('SADD',KEYS[16],ARGV[5])==1 then redis.call('RPUSH',KEYS[2],ARGV[5]) end if legacyIndex>=0 then redis.call('LSET',KEYS[3],tostring(legacyIndex),ARGV[4]) end if ARGV[6]=='1' then redis.call('ZADD',KEYS[4],ARGV[7],ARGV[5]) else redis.call('ZREM',KEYS[4],ARGV[5]) end if ARGV[8]=='1' then redis.call('ZADD',KEYS[5],ARGV[9],ARGV[5]) else redis.call('ZREM',KEYS[5],ARGV[5]) end if ARGV[10]=='1' then redis.call('HSET',KEYS[6],ARGV[5],ARGV[11]); redis.call('ZADD',KEYS[7],ARGV[7],ARGV[5]) else redis.call('HDEL',KEYS[6],ARGV[5]); redis.call('ZREM',KEYS[7],ARGV[5]) end redis.call('SET',KEYS[8],tostring(listRevision+1)) if ARGV[12]=='1' and (ARGV[13]~='1' or KEYS[9]~=KEYS[10]) then redis.call('SREM',KEYS[9],ARGV[5]) end if ARGV[13]=='1' then redis.call('SADD',KEYS[10],ARGV[5]) end if ARGV[14]=='1' then redis.call('SADD',KEYS[11],ARGV[5]) else redis.call('SREM',KEYS[11],ARGV[5]) end for slot=12,13 do local enabled=ARGV[slot+3]=='1'; local newSlot=slot+2; local newEnabled=ARGV[newSlot+3]=='1' if enabled and (not newEnabled or KEYS[slot]~=KEYS[newSlot]) then redis.call('LREM',KEYS[slot],'0',ARGV[5]) end end for slot=14,15 do if ARGV[slot+3]=='1' and not redis.call('LPOS',KEYS[slot],ARGV[5]) then redis.call('LPUSH',KEYS[slot],ARGV[5]) end end return finalResponse
`;

// Atomically compare-and-set the order record and every derived index. The
// exact raw record read here is compared inside Lua, so a concurrent writer can
// no longer leave the main record and indexes at different revisions.
export async function setOrderAt(index, order, options = {}) {
  if (!redisConfig() || !order || typeof order !== "object" || Array.isArray(order)) return false;
  const handle = typeof index === "object" && index !== null ? index : { legacyIndex: index, orderId: order?.orderId };
  const orderId = normalizeOrderIdForStorage(handle.orderId || order?.orderId);
  if (!orderId || normalizeOrderIdForStorage(order.orderId) !== orderId) return false;
  if (!await ensureOrderIndexMembership()) return false;

  const recordKey = orderRecordKey(orderId);
  const currentRaw = await redisCmd(["GET", recordKey]);
  let previous = parseOrderJson(currentRaw, orderId);
  const legacyIndex = Number.isInteger(handle.legacyIndex) && handle.legacyIndex >= 0 ? handle.legacyIndex : -1;
  const legacyRaw = legacyIndex >= 0 ? await redisCmd(["LINDEX", ORDERS_KEY, String(legacyIndex)]) : null;
  if (!previous && legacyRaw) previous = parseOrderJson(legacyRaw, orderId);
  if (!previous && currentRaw) return false;

  const pendingTransitionId = clean(previous?.pendingTransition?.id, 100);
  if (pendingTransitionId && clean(options.completeTransitionId, 100) !== pendingTransitionId) return false;

  const currentRevision = Number(previous?.revision ?? 0);
  if (previous && (!Number.isSafeInteger(currentRevision) || currentRevision < 0)) return false;
  const expectedRevision = options.expectedRevision == null ? null : Number(options.expectedRevision);
  if (previous) {
    // Existing records must always name the exact version the caller observed.
    // The revision embedded in `order` is deliberately ignored, so pre-bumping
    // a stale snapshot cannot disguise it as a fresh one.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== currentRevision) return false;
  } else if (expectedRevision != null && expectedRevision !== 0) {
    return false;
  }
  const casRevision = previous ? expectedRevision : 0;
  const targetRevision = previous ? expectedRevision + 1 : 1;
  const nextOrder = { ...order, orderId, revision: targetRevision };
  const orderJson = JSON.stringify(nextOrder);
  const overview = orderOverviewSnapshot(nextOrder);
  const createdScore = orderCreatedScore(nextOrder);
  const quoteScore = pendingQuoteExpiryScore(nextOrder);
  const previousReferenceKey = orderReferenceIndexKey(previous?.internalReference);
  const referenceKey = orderReferenceIndexKey(nextOrder.internalReference);
  const previousBuyerKey = orderEmailIndexKey(previous?.email);
  const previousUserKey = orderEmailIndexKey(previous?.userEmail);
  const buyerKey = orderEmailIndexKey(nextOrder.email);
  const userKey = orderEmailIndexKey(nextOrder.userEmail);
  const noopPrefix = recordKey + ":noop:";
  const absent = "__LM_ORDER_RECORD_ABSENT__";

  const executed = await redisEvalAtomic(SET_ORDER_AT_SCRIPT, [
    recordKey,
    ORDER_INDEX_KEY,
    ORDERS_KEY,
    USDT_PENDING_ORDER_INDEX_KEY,
    QUOTE_EXPIRY_ORDER_INDEX_KEY,
    ORDER_OVERVIEW_HASH_KEY,
    ORDER_SUMMARY_INDEX_KEY,
    ORDER_LIST_REVISION_KEY,
    previousReferenceKey || noopPrefix + "previous-reference",
    referenceKey || noopPrefix + "reference",
    ORDER_DELETED_INDEX_KEY,
    previousBuyerKey || noopPrefix + "previous-buyer",
    previousUserKey || noopPrefix + "previous-user",
    buyerKey || noopPrefix + "buyer",
    userKey || noopPrefix + "user",
    ORDER_INDEX_MEMBERSHIP_KEY,
  ], [
    currentRaw == null ? absent : currentRaw,
    legacyIndex >= 0 && legacyRaw != null ? String(legacyRaw) : absent,
    String(legacyIndex),
    orderJson,
    orderId,
    isPendingUsdtOrder(nextOrder) ? "1" : "0",
    String(createdScore),
    quoteScore ? "1" : "0",
    String(quoteScore || 0),
    overview ? "1" : "0",
    overview ? JSON.stringify(overview) : "",
    previousReferenceKey ? "1" : "0",
    referenceKey ? "1" : "0",
    nextOrder.deleted ? "1" : "0",
    previousBuyerKey ? "1" : "0",
    previousUserKey ? "1" : "0",
    buyerKey ? "1" : "0",
    userKey ? "1" : "0",
    String(casRevision),
    previous ? "1" : "0",
  ]);
  let saved = Boolean(executed.ok && executed.value?.ok);
  if (!saved && !executed.ok) {
    // A dropped REST response is ambiguous even though Redis may have committed
    // the Lua script. Exact record equality proves this write won.
    saved = await redisCmd(["GET", recordKey]) === orderJson;
  }
  if (saved) order.revision = targetRevision;
  return saved;
}

// Archive only financially closed invalid orders. The complete record remains
// available for audit while normal order queries exclude `deleted` entries.
export function orderArchiveEligibility(order) {
  if (!order || typeof order !== "object" || order.deleted) return { ok: false, error: "order_not_found" };
  if (order.pendingTransition) return { ok: false, error: "order_transition_pending" };
  if (order.status !== "invalid") return { ok: false, error: "order_must_be_invalid_before_delete" };
  if ((order.paidByBalance || order.couponId) && !order.refundedAt) {
    return { ok: false, error: "order_financial_effects_open" };
  }
  if (order.referralCommissionSettledAt) return { ok: false, error: "order_commission_effect_open" };
  if ((Array.isArray(order.items) ? order.items : []).some((item) => item?.stockReserved || item?.aiStockReserved)) {
    return { ok: false, error: "order_stock_effect_open" };
  }
  return { ok: true };
}

export async function archiveOrderAt(index, order, meta = {}) {
  const eligible = orderArchiveEligibility(order);
  if (!eligible.ok) return eligible;
  const now = new Date();
  const currentRevision = Math.max(0, Number(order.revision || 0));
  const archiveOperationId = clean(meta.archiveOperationId, 160)
    || `archive:${normalizeOrderIdForStorage(order.orderId)}:revision:${currentRevision}`;
  const archived = {
    ...order,
    deleted: true,
    archived: true,
    revision: currentRevision + 1,
    deletedAt: now.toISOString(),
    deletedAtBeijing: formatBeijingTime(now),
    archivedAt: now.toISOString(),
    archivedAtBeijing: formatBeijingTime(now),
    ...meta,
    archiveOperationId,
  };
  const saved = await setOrderAt(index, archived, { expectedRevision: currentRevision });
  if (saved) return { ok: true, order: archived };
  const latest = parseOrderJson(await redisCmd(["GET", orderRecordKey(order.orderId)]), order.orderId);
  return latest?.deleted && latest.archiveOperationId === archiveOperationId
    ? { ok: true, order: latest, idempotent: true }
    : { ok: false, error: "stale_revision" };
}

export async function softDeleteOrderAt(index, orderId, meta = {}) {
  const entry = await getOrderEntryById(orderId);
  if (!entry?.order) return false;
  const archived = await archiveOrderAt(index || entry.index, entry.order, meta);
  return Boolean(archived.ok);
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
      commands.push(addOrderIndexMemberCommand(orderId));
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

async function ensureOrderSummaryIndex() {
  if (!redisConfig()) return false;
  if (await redisCmd(["GET", ORDER_OVERVIEW_READY_KEY]) === "1") return true;
  if (!await ensureLegacyOrderIndex()) return false;
  if (!await ensureStandaloneOrderIndex()) return false;
  await getOrderOverviewRows();
  return await redisCmd(["GET", ORDER_OVERVIEW_READY_KEY]) === "1";
}

export async function getOrderListRevision() {
  if (!await ensureOrderSummaryIndex()) return null;
  const result = await redisPipeline([
    ["GET", ORDER_LIST_REVISION_KEY],
    ["ZCARD", ORDER_SUMMARY_INDEX_KEY],
    ["ZREVRANGE", ORDER_SUMMARY_INDEX_KEY, "0", "0"],
  ]);
  const rows = pipelineResults(result);
  if (rows.length !== 3 || rows.some((entry) => entry?.error)) return null;
  const latest = pipelineResultValue(rows[2]);
  return {
    revision: String(pipelineResultValue(rows[0]) || "0"),
    total: Number(pipelineResultValue(rows[1]) || 0),
    latestOrderId: Array.isArray(latest) ? String(latest[0] || "") : "",
  };
}

export async function getOrderSummariesPageFast(offset = 0, limit = 50) {
  if (!await ensureOrderSummaryIndex()) return null;
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.min(200, Math.max(1, Number(limit || 50)));
  const result = await redisPipeline([
    ["ZREVRANGE", ORDER_SUMMARY_INDEX_KEY, String(safeOffset), String(safeOffset + safeLimit - 1)],
    ["ZCARD", ORDER_SUMMARY_INDEX_KEY],
    ["GET", ORDER_LIST_REVISION_KEY],
  ]);
  const rows = pipelineResults(result);
  if (rows.length !== 3 || rows.some((entry) => entry?.error)) return null;
  const ids = (Array.isArray(pipelineResultValue(rows[0])) ? pipelineResultValue(rows[0]) : [])
    .map(normalizeOrderIdForStorage)
    .filter(Boolean);
  const total = Number(pipelineResultValue(rows[1]) || 0);
  const revision = String(pipelineResultValue(rows[2]) || "0");
  if (ids.length === 0) {
    return { orders: [], total, hasMore: false, listRevision: revision };
  }

  let rawValues = await redisCmd(["HMGET", ORDER_OVERVIEW_HASH_KEY, ...ids]);
  if (!Array.isArray(rawValues)) {
    const detailResult = await redisPipeline(ids.map((id) => ["HGET", ORDER_OVERVIEW_HASH_KEY, id]));
    rawValues = pipelineResults(detailResult).map(pipelineResultValue);
  }
  const byId = new Map();
  ids.forEach((id, index) => {
    const summary = parseOrderJson(rawValues?.[index], id);
    if (summary && !summary.deleted) byId.set(id, summary);
  });

  const missingIds = ids.filter((id) => !byId.has(id));
  if (missingIds.length) {
    const recovered = await getOrdersByIds(missingIds);
    const commands = [];
    for (const entry of recovered) {
      const summary = orderOverviewSnapshot(entry.order);
      if (!summary) continue;
      byId.set(summary.orderId, summary);
      commands.push(["HSET", ORDER_OVERVIEW_HASH_KEY, summary.orderId, JSON.stringify(summary)]);
      commands.push(["ZADD", ORDER_SUMMARY_INDEX_KEY, String(orderCreatedScore(summary)), summary.orderId]);
    }
    if (commands.length) await redisPipeline(commands);
    const staleIds = missingIds.filter((id) => !byId.has(id));
    if (staleIds.length) await redisCmd(["ZREM", ORDER_SUMMARY_INDEX_KEY, ...staleIds]);
  }

  const orders = ids.map((id) => byId.get(id)).filter(Boolean);
  return {
    orders,
    total,
    hasMore: safeOffset + orders.length < total,
    listRevision: revision,
  };
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
  "canViewOrders", "canEditOrders", "canViewUsers", "canBanUsers", "canAdjustBalance", "canViewBalanceLog",
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
// lm:staff:kick:<id> 是持久化的毫秒撤销边界。iat <= 边界的会话一律失效。
// lm:staff:issue-fence:<id> 是最终签发栅栏。登录在签 JWT 前原子保留 iat；
// 任何随后才抵达 Redis 的变更都必须把 kick 至少推进到该栅栏。因此变更
// 请求即使预先捕获了旧进程时间，也不能越过最终检查签出旧权限 JWT。
function staffKickKey(id) { return "lm:staff:kick:" + Number(id); }
function staffIssueFenceKey(id) { return "lm:staff:issue-fence:" + Number(id); }

const ADMIN_SESSION_INTEGER_HELPERS = `
local function readinteger(key)
  local raw=redis.call('GET',key)
  if not raw then return 0 end
  if not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<0 or value~=math.floor(value) or value>9007199254740991 then return nil end
  return value
end
`;

const KICK_ADMIN_STAFF_SCRIPT = ADMIN_SESSION_INTEGER_HELPERS + `
local current=readinteger(KEYS[1]); local fence=readinteger(KEYS[2])
if not current or not fence then return cjson.encode({ok=false,error='invalid_session_state'}) end
local proposed=tonumber(ARGV[1]) or 0
if proposed<fence then proposed=fence end
if proposed<=current then proposed=current+1 end
if proposed>9007199254740991 then return cjson.encode({ok=false,error='invalid_session_state'}) end
redis.call('SET',KEYS[1],tostring(proposed))
return '{"ok":true,"kickTs":'..tostring(proposed)..'}'
`;

const REVOKE_ADMIN_SESSION_SCRIPT = ADMIN_SESSION_INTEGER_HELPERS + `
local current=readinteger(KEYS[1]); local fence=readinteger(KEYS[2])
if not current or not fence then return cjson.encode({ok=false,error='invalid_session_state'}) end
local issuedAt=tonumber(ARGV[1]) or 0
if current>0 and issuedAt<=current then
  return '{"ok":false,"error":"session_revoked","kickTs":'..tostring(current)..'}'
end
local proposed=tonumber(ARGV[2]) or 0
if proposed<issuedAt then proposed=issuedAt end
if proposed<fence then proposed=fence end
if proposed<=current then proposed=current+1 end
if proposed>9007199254740991 then return cjson.encode({ok=false,error='invalid_session_state'}) end
redis.call('SET',KEYS[1],tostring(proposed))
return '{"ok":true,"kickTs":'..tostring(proposed)..'}'
`;

const RESERVE_ADMIN_SESSION_ISSUANCE_SCRIPT = ADMIN_SESSION_INTEGER_HELPERS + `
-- admin_session_issue_fence_v1
local current=readinteger(KEYS[1]); local fence=readinteger(KEYS[2])
if not current or not fence then return cjson.encode({ok=false,error='invalid_session_state'}) end
local expected=tonumber(ARGV[1]); local proposed=tonumber(ARGV[2])
if not expected or expected<0 or expected~=math.floor(expected) or current~=expected then
  return '{"ok":false,"error":"session_state_changed","kickTs":'..tostring(current)..'}'
end
if not proposed or proposed<0 or proposed~=math.floor(proposed) then
  return cjson.encode({ok=false,error='invalid_session_state'})
end
local issuedAt=proposed
if issuedAt<=current then issuedAt=current+1 end
if issuedAt<=fence then issuedAt=fence+1 end
if issuedAt>9007199254740991 then return cjson.encode({ok=false,error='invalid_session_state'}) end
redis.call('SET',KEYS[2],tostring(issuedAt))
return '{"ok":true,"issuedAt":'..tostring(issuedAt)..',"kickTs":'..tostring(current)..'}'
`;

export async function revokeAdminStaffSessions(id, proposedTs = Date.now()) {
  const staffId = Number(id);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return { ok: false, error: "invalid_staff_id" };
  const result = await redisEvalAtomic(
    KICK_ADMIN_STAFF_SCRIPT,
    [staffKickKey(staffId), staffIssueFenceKey(staffId)],
    [String(proposedTs)],
  );
  if (!result.ok || result.value?.ok !== true || !Number.isSafeInteger(Number(result.value?.kickTs))) {
    return { ok: false, error: result.error || "storage_failed" };
  }
  return { ok: true, kickTs: Number(result.value.kickTs) };
}

// A signed captcha proves the answer but, by itself, is replayable until exp.
// Consume its nonce before creating the account so one solved image cannot
// register an arbitrary number of addresses. Storage ambiguity fails closed.
export async function consumeRegisterCaptcha(token, answer, now = Date.now()) {
  const payload = verifySession(token);
  if (!payload || payload.type !== "register-captcha" || !payload.nonce || !payload.hash) {
    return { ok: false, error: "captcha_failed" };
  }
  const expected = captchaDigest(payload.nonce, answer);
  try {
    if (!timingSafeEqual(Buffer.from(payload.hash), Buffer.from(expected))) {
      return { ok: false, error: "captcha_failed" };
    }
  } catch {
    return { ok: false, error: "captcha_failed" };
  }
  const expiresAt = Number(payload.exp || 0);
  const ttl = Math.ceil((expiresAt - Number(now || Date.now())) / 1000);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 10 * 60) {
    return { ok: false, error: "captcha_failed" };
  }
  const nonceHash = createHash("sha256").update(String(payload.nonce)).digest("hex");
  const key = "liumeiti:captcha:used:" + nonceHash;
  const script = "if redis.call('EXISTS',KEYS[1])==1 then return 'used' end redis.call('SET',KEYS[1],'1','EX',ARGV[1]) return 'consumed'";
  const consumed = await redisCmd(["EVAL", script, "1", key, String(ttl)]);
  if (consumed === "consumed") return { ok: true };
  if (consumed === "used") return { ok: false, error: "captcha_reused" };
  return { ok: false, error: "captcha_store_unavailable" };
}

export async function revokeAdminSession(id, issuedAt, proposedTs = Date.now()) {
  const staffId = Number(id);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return { ok: false, error: "invalid_staff_id" };
  const tokenIat = Number(issuedAt || 0);
  const result = await redisEvalAtomic(
    REVOKE_ADMIN_SESSION_SCRIPT,
    [staffKickKey(staffId), staffIssueFenceKey(staffId)],
    [Number.isSafeInteger(tokenIat) && tokenIat >= 0 ? String(tokenIat) : "0", String(proposedTs)],
  );
  if (!result.ok) return { ok: false, error: result.error || "storage_failed" };
  if (result.value?.ok !== true) {
    return { ok: false, error: clean(result.value?.error, 80) || "storage_failed" };
  }
  return { ok: true, kickTs: Number(result.value.kickTs) };
}

export async function reserveAdminSessionIssuance(id, expectedKickTs, proposedIssuedAt = Date.now()) {
  const staffId = Number(id);
  const expected = Number(expectedKickTs);
  const proposed = Number(proposedIssuedAt);
  if (
    !Number.isSafeInteger(staffId) || staffId <= 0
    || !Number.isSafeInteger(expected) || expected < 0
    || !Number.isSafeInteger(proposed) || proposed < 0
  ) return { ok: false, error: "invalid_session_state" };
  const result = await redisEvalAtomic(
    RESERVE_ADMIN_SESSION_ISSUANCE_SCRIPT,
    [staffKickKey(staffId), staffIssueFenceKey(staffId)],
    [String(expected), String(proposed)],
  );
  if (!result.ok || result.value?.ok !== true) {
    return { ok: false, error: clean(result.value?.error || result.error, 80) || "storage_failed" };
  }
  const issuedAt = Number(result.value.issuedAt);
  return Number.isSafeInteger(issuedAt) && issuedAt > Number(result.value.kickTs || 0)
    ? { ok: true, issuedAt, kickTs: Number(result.value.kickTs || 0) }
    : { ok: false, error: "invalid_session_state" };
}

export async function kickAdminStaff(id) {
  return (await revokeAdminStaffSessions(id)).ok;
}

export async function getStaffKickState(id) {
  const staffId = Number(id);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return { ok: false, error: "invalid_staff_id", kickTs: 0 };
  const r = redisConfig();
  if (!r) return { ok: false, error: "storage_unavailable", configured: false, kickTs: 0 };
  try {
    const response = await fetch(r.url + "/get/" + encodeURIComponent(staffKickKey(staffId)), {
      headers: { Authorization: "Bearer " + r.token },
    });
    if (!response.ok) return { ok: false, error: "storage_unavailable", configured: true, kickTs: 0 };
    const payload = await response.json();
    if (payload?.error) return { ok: false, error: "storage_error", configured: true, kickTs: 0 };
    if (payload?.result == null) return { ok: true, configured: true, kickTs: 0 };
    const kickTs = Number(payload.result);
    if (!Number.isSafeInteger(kickTs) || kickTs < 0) {
      return { ok: false, error: "invalid_storage_response", configured: true, kickTs: 0 };
    }
    return { ok: true, configured: true, kickTs };
  } catch (e) {
    return { ok: false, error: "storage_unavailable", configured: true, kickTs: 0 };
  }
}

export async function getStaffKickTs(id) {
  const state = await getStaffKickState(id);
  return state.ok ? state.kickTs : 0;
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
function validStaff2faRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.secretEnc === "string" && value.secretEnc
    && Array.isArray(value.backupHashes)
    && value.backupHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)));
}

// Authentication callers must distinguish an unconfigured account from a
// Redis outage or corrupt data. Nullable getStaff2fa remains for UI summaries.
export async function getStaff2faState(id) {
  const staffId = Number(id);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) {
    return { ok: false, exists: false, record: null, error: "invalid_staff_id" };
  }
  const r = redisConfig();
  if (!r) return { ok: false, exists: false, record: null, error: "storage_unavailable" };
  try {
    const response = await fetch(r.url + "/get/" + encodeURIComponent(staff2faKey(staffId)), {
      headers: { Authorization: "Bearer " + r.token },
    });
    if (!response.ok) return { ok: false, exists: false, record: null, error: "storage_unavailable" };
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || payload.error || !("result" in payload)) {
      return { ok: false, exists: false, record: null, error: "storage_error" };
    }
    if (payload.result == null) return { ok: true, exists: false, record: null };
    if (typeof payload.result !== "string") {
      return { ok: false, exists: true, record: null, error: "invalid_storage_response" };
    }
    let record = null;
    try { record = JSON.parse(payload.result); } catch (e) {}
    if (!validStaff2faRecord(record)) {
      return { ok: false, exists: true, record: null, error: "invalid_storage_response" };
    }
    return { ok: true, exists: true, record };
  } catch (e) {
    return { ok: false, exists: false, record: null, error: "storage_unavailable" };
  }
}

export async function getStaff2fa(id) {
  const state = await getStaff2faState(id);
  return state.ok && state.exists ? state.record : null;
}
export async function setStaff2fa(id, data) {
  return (await redisCmd(["SET", staff2faKey(id), JSON.stringify(data)])) === "OK";
}
export async function clearStaff2fa(id) {
  const removed = await redisCmd(["DEL", staff2faKey(id)]);
  return removed != null && Number.isSafeInteger(Number(removed)) && Number(removed) >= 0;
}
export async function clearStaff2faAndKick(id) {
  const staffId = Number(id);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return { ok: false, error: "invalid_staff_id" };
  const script = ADMIN_SESSION_INTEGER_HELPERS + `
local current=readinteger(KEYS[2]); local fence=readinteger(KEYS[3])
if not current or not fence then return cjson.encode({ok=false,error='invalid_session_state'}) end
local proposed=tonumber(ARGV[1]) or 0
if proposed<fence then proposed=fence end
if proposed<=current then proposed=current+1 end
if proposed>9007199254740991 then return cjson.encode({ok=false,error='invalid_session_state'}) end
redis.call('DEL',KEYS[1])
redis.call('SET',KEYS[2],tostring(proposed))
return '{"ok":true,"kickTs":'..tostring(proposed)..'}'`;
  const result = await redisEvalAtomic(
    script,
    [staff2faKey(staffId), staffKickKey(staffId), staffIssueFenceKey(staffId)],
    [String(Date.now())],
  );
  return result.ok && result.value?.ok === true
    ? { ok: true, kickTs: Number(result.value.kickTs) || 0 }
    : { ok: false, error: result.error || "storage_failed" };
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

const CONSUME_STAFF_2FA_BACKUP_SCRIPT = `
-- admin_2fa_backup_consume_lossless_v2
local raw=redis.call('GET',KEYS[1]) if not raw then return {'error','not_enabled'} end if raw~=ARGV[2] then return {'stale'} end local decodedOk,record=pcall(cjson.decode,raw) if not decodedOk or type(record)~='table' or type(record.secretEnc)~='string' or record.secretEnc=='' then return {'error','invalid_storage_response'} end local hashes=record.backupHashes if type(hashes)~='table' then return {'error','invalid_storage_response'} end local found=false local remaining={} for _,stored in ipairs(hashes) do if type(stored)~='string' then return {'error','invalid_storage_response'} end if not found and stored==ARGV[1] then found=true else table.insert(remaining,stored) end end if not found then return {'error','invalid_code'} end local replacementOk,replacement=pcall(cjson.decode,ARGV[3]) if not replacementOk or type(replacement)~='table' or type(replacement.backupHashes)~='table' or replacement.secretEnc~=record.secretEnc or #replacement.backupHashes~=#remaining then return {'error','invalid_storage_response'} end for index,value in ipairs(remaining) do if replacement.backupHashes[index]~=value then return {'error','invalid_storage_response'} end end redis.call('SET',KEYS[1],ARGV[3]) return {'ok',tostring(#remaining)}
`;

async function consumeStaff2faBackupCode(id, hash) {
  const key = staff2faKey(id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await redisCmd(["GET", key]);
    if (typeof raw !== "string" || !raw) return { ok: false, error: "storage_failed", storageError: true };
    let record;
    try { record = JSON.parse(raw); } catch { record = null; }
    if (!validStaff2faRecord(record)) return { ok: false, error: "invalid_storage_response", storageError: true };
    const index = record.backupHashes.indexOf(hash);
    if (index < 0) return { ok: false, error: "invalid_code", storageError: false };
    const remaining = record.backupHashes.filter((_, itemIndex) => itemIndex !== index);
    const replacement = replaceTopLevelJsonFields(raw, { backupHashes: remaining });
    if (!replacement) return { ok: false, error: "invalid_storage_response", storageError: true };
    const result = await redisEvalAtomic(CONSUME_STAFF_2FA_BACKUP_SCRIPT, [key], [hash, raw, replacement]);
    const tuple = Array.isArray(result.value) ? result.value : [];
    if (result.ok && tuple[0] === "stale") continue;
    if (!result.ok || tuple[0] !== "ok") {
      const error = tuple[0] === "error" ? clean(tuple[1], 80) : result.error || "storage_failed";
      return {
        ok: false,
        error,
        storageError: ["invalid_storage_response", "storage_failed", "storage_unavailable", "storage_error"].includes(error),
      };
    }
    return { ok: true, method: "backup", remainingBackup: Number(tuple[1]) || 0 };
  }
  return { ok: false, error: "storage_failed", storageError: true };
}

// 校验登录提供的动态码:TOTP 或备用码(备用码命中即消耗)。
export async function verifyStaff2faCode(id, code) {
  const state = await getStaff2faState(id);
  if (!state.ok) return { ok: false, error: state.error || "storage_failed", storageError: true };
  if (!state.exists) return { ok: true, skipped: true }; // 未绑定 → 不要求
  const rec = state.record;
  const secret = decryptTotpSecret(rec.secretEnc);
  if (!secret) return { ok: false, error: "invalid_storage_response", storageError: true };
  const supplied = String(code || "").trim();
  // Backup codes can contain exactly six digits among their letters. Never
  // reinterpret such a backup code as a reusable TOTP by stripping letters.
  if (/^\d{6}$/.test(supplied) && verifyTotp(secret, supplied)) return { ok: true, method: "totp" };
  const hash = backupCodeHash(supplied);
  return consumeStaff2faBackupCode(id, hash);
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

export async function listAllUserEmailsStrict() {
  if (!redisConfig()) throw new Error("user_store_unavailable");
  const rows = pipelineResults(await redisPipeline([
    ["SMEMBERS", USER_EMAIL_SET_KEY],
    ["PING"],
  ]));
  if (rows.length !== 2 || rows.some((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "error"))) {
    throw new Error("user_store_unavailable");
  }
  const emails = pipelineResultValue(rows[0]);
  const pong = pipelineResultValue(rows[1]);
  if (!Array.isArray(emails) || pong !== "PONG") throw new Error("user_store_unavailable");
  return emails;
}

export async function deleteUser(email) {
  if (!redisConfig()) return { ok: false, error: "storage_unavailable" };
  const lower = String(email).toLowerCase().trim();
  if (!validEmail(lower)) return { ok: false, error: "invalid_email" };
  const keyspaceMode = redisAtomicKeyspaceMode();
  if (keyspaceMode !== "legacy") {
    return {
      ok: false,
      error: keyspaceMode === REDIS_ATOMIC_CLUSTER_MODE
        ? "redis_cluster_keyspace_not_supported"
        : "invalid_redis_keyspace_mode",
    };
  }
  try {
    const quotaKey = "lm:tool:quota";
    let quotaRaw = "";
    let nextQuotaRaw = "";
    let quotaCleanupRequested = false;
    let quotaPreparationSkipped = false;
    try {
      const typeResult = await redisCmd(["TYPE", quotaKey]);
      const quotaType = typeResult && typeof typeResult === "object" ? typeResult.ok : typeResult;
      if (quotaType === "string") {
        const stored = await redisCmd(["GET", quotaKey]);
        quotaRaw = typeof stored === "string" ? stored : "";
        let quota;
        try { quota = quotaRaw ? JSON.parse(quotaRaw) : null; } catch { quota = null; }
        const overrides = quota?.overrides == null ? [] : Array.isArray(quota.overrides) ? quota.overrides : null;
        const requests = quota?.requests == null ? [] : Array.isArray(quota.requests) ? quota.requests : null;
        if (quota && typeof quota === "object" && !Array.isArray(quota) && overrides && requests) {
          nextQuotaRaw = replaceTopLevelJsonFields(quotaRaw, {
            overrides: overrides.filter((entry) => entry && typeof entry === "object"
              && String(entry.email || "").toLowerCase() !== lower),
            requests: requests.filter((entry) => entry && typeof entry === "object"
              && String(entry.email || "").toLowerCase() !== lower),
          }) || "";
          quotaCleanupRequested = Boolean(nextQuotaRaw);
          quotaPreparationSkipped = !nextQuotaRaw;
        } else {
          quotaPreparationSkipped = true;
        }
      } else if (quotaType !== "none" && quotaType != null) {
        quotaPreparationSkipped = true;
      }
    } catch {
      quotaPreparationSkipped = true;
    }
    // 删除前读出上下级,清理返佣反向索引(从上级名下移除 + 删除自身下级集合)。
    const script = `
local function keytype(key)
  local value=redis.call('TYPE',key)
  if type(value)=='table' then return value.ok end
  return value
end
local userType=keytype(KEYS[1])
if userType=='none' then return cjson.encode({ok=false,error='user_not_found'}) end
local emailSetType=keytype(KEYS[4])
if emailSetType~='none' and emailSetType~='set' then return cjson.encode({ok=false,error='storage_unavailable'}) end
local profileCorrupt=false
local user={}
if userType=='string' then
  local raw=redis.call('GET',KEYS[1])
  local decoded,value=pcall(cjson.decode,raw)
  if decoded and type(value)=='table' then user=value else profileCorrupt=true end
else
  profileCorrupt=true
end
local inviteCode=string.upper(tostring(user.inviteCode or ''))
inviteCode=string.gsub(inviteCode,'[^A-Z0-9]','')
local inviteKey=''
if inviteCode~='' then
  inviteKey=ARGV[2]..inviteCode
  local inviteType=keytype(inviteKey)
  if inviteType~='string' then inviteKey='' end
end
local nextQuotaRaw=nil
local quotaCleanupSkipped=false
if ARGV[3]=='1' and keytype(KEYS[11])=='string' then
  local quotaRaw=redis.call('GET',KEYS[11])
  if quotaRaw==ARGV[4] then
    local quotaDecoded,quota=pcall(cjson.decode,ARGV[5])
    if quotaDecoded and type(quota)=='table' and type(quota.overrides)=='table' and type(quota.requests)=='table' then
      nextQuotaRaw=ARGV[5]
    else
      quotaCleanupSkipped=true
    end
  else
    quotaCleanupSkipped=true
  end
elseif ARGV[3]=='1' then
  quotaCleanupSkipped=true
end
local current=1
if keytype(KEYS[5])=='string' then
  local versionRaw=redis.call('GET',KEYS[5])
  if string.match(versionRaw or '','^%d+$') then current=tonumber(versionRaw) end
end
if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
  current=1
end
local nextVersion=current+1
local responseOk,response=pcall(cjson.encode,{
  ok=true,
  authVersion=nextVersion,
  profileCorrupt=profileCorrupt,
  quotaCleanupSkipped=quotaCleanupSkipped,
  user={
    email=ARGV[1],
    username=tostring(user.username or ''),
    invitedByEmail=tostring(user.invitedByEmail or ''),
    invitedBy2Email=tostring(user.invitedBy2Email or ''),
    inviteCode=tostring(user.inviteCode or '')
  }
})
if not responseOk then return redis.error_reply('json_encode_failed') end
redis.call('SET',KEYS[5],tostring(nextVersion))
redis.call('DEL',KEYS[1],KEYS[2],KEYS[3],KEYS[6],KEYS[7],KEYS[8],KEYS[9],KEYS[10],KEYS[12])
if emailSetType=='set' then redis.call('SREM',KEYS[4],ARGV[1]) end
if inviteKey~='' and redis.call('GET',inviteKey)==ARGV[1] then redis.call('DEL',inviteKey) end
if nextQuotaRaw then redis.call('SET',KEYS[11],nextQuotaRaw) end
return response`;
    const deleted = await redisEvalAtomic(
      script,
      [
      USERS_KEY + ":" + lower,
      balanceCentsKey(lower),
      USERS_KEY + ":" + lower + ":tx",
      USER_EMAIL_SET_KEY,
       "lm:user:authver:" + lower,
       "liumeiti:reset:" + lower,
       "liumeiti:tool:2fa:" + lower,
       "liumeiti:tool:data:" + lower + ":favs",
       "liumeiti:tool:data:" + lower + ":recent_tools",
       "liumeiti:tool:data:" + lower + ":ai_history",
       quotaKey,
       accountLifecycleKey(lower),
       ],
      [lower, INVITE_CODE_PREFIX_KEY, quotaCleanupRequested ? "1" : "0", quotaRaw, nextQuotaRaw],
    );
    if (!deleted.ok) return deleted;
    if (deleted.value?.ok !== true) return { ok: false, error: clean(deleted.value?.error, 80) || "delete_failed" };

    // Referral indexes are derived and readers verify every member against the
    // canonical user record. Clean them only after the delete/tombstone commit,
    // so an auxiliary-index outage can never leave an authenticated account.
    await deindexReferralRelation(deleted.value.user);
    const cleanupSkipped = Boolean(quotaPreparationSkipped || deleted.value.quotaCleanupSkipped);
    if (cleanupSkipped) console.warn(`[user-delete] retained unreadable or concurrently changed tool quota entries for ${lower}`);
    return { ...deleted.value, quotaCleanupSkipped: cleanupSkipped, email: lower };
  } catch (e) { return { ok: false, error: "delete_failed" }; }
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
  try {
    const normalized = String(email || "").trim().toLowerCase();
    if (!validEmail(normalized)) return null;
    const shadowKey = balanceCentsKey(normalized);
    const values = await redisCmd(["MGET", userKey(normalized), shadowKey]);
    if (!Array.isArray(values) || !values[0]) return null;
    const user = JSON.parse(values[0]);
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const storedEmail = String(user.email || "").trim().toLowerCase();
    if (storedEmail && storedEmail !== normalized) return null;
    if (!storedEmail) user.email = normalized;
    if (values[1] != null) {
      const raw = String(values[1]);
      const storedCents = Number(raw);
      if (/^-?\d+$/.test(raw) && Number.isSafeInteger(storedCents)) user.balance = storedCents / 100;
      else await redisCmd(["DEL", shadowKey]);
    }
    return user;
  } catch (e) { return null; }
}

export async function setUser(email, user, options = {}) {
  try {
    const result = await saveUserPreservingBalanceAtomic(email, user, options);
    return options.returnResult ? result : Boolean(result?.ok);
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

const GET_OR_CREATE_RESET_CODE_SCRIPT = `
local keyType=redis.call('TYPE',KEYS[1]) if type(keyType)=='table' then keyType=keyType.ok end if keyType~='none' and keyType~='string' then redis.call('DEL',KEYS[1]) end local existing=redis.call('GET',KEYS[1]) if existing and string.match(existing,'^%d%d%d%d%d%d$') then redis.call('EXPIRE',KEYS[1],ARGV[2]) return existing end redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) return ARGV[1]
`;

export async function getOrCreateResetCode(email, proposedCode, ttlSec = 600) {
  const code = String(proposedCode || "").trim();
  const ttl = Math.max(60, Math.min(3600, Number(ttlSec) || 600));
  if (!/^\d{6}$/.test(code)) return null;
  const result = await redisCmd([
    "EVAL", GET_OR_CREATE_RESET_CODE_SCRIPT, "1", resetKey(email), code, String(ttl),
  ]);
  return /^\d{6}$/.test(String(result || "")) ? String(result) : null;
}

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

export function mailFromAddress() {
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
    return {
      message: data?.message || data?.error || JSON.stringify(data),
      code: clean(data?.name || data?.error_code || data?.code || "", 80),
    };
  } catch (e) {
    try { return { message: await res.text(), code: "" }; } catch (er) { return { message: res.statusText || "request_failed", code: "" }; }
  }
}

function resendTag(value, fallback = "") {
  return clean(value || fallback, 120).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

async function sendViaResend({
  to, subject, text, html, fromName, marketing = false, category = "", relatedType = "", relatedId = "",
  scheduledAt = "", idempotencyKey = "", oneClickUnsubscribeUrl = "", fromAddress = "",
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = validEmail(fromAddress) ? String(fromAddress).trim().toLowerCase() : mailFromAddress();
  if (!apiKey || !from || !to) return { ok: false, reason: "resend_or_to_missing" };
  if (!validEmail(from)) return { ok: false, reason: "invalid_mail_from" };
  const recipients = Array.isArray(to) ? to : [to];
  const headers = marketing ? {
    "List-Unsubscribe": [
      oneClickUnsubscribeUrl ? `<${oneClickUnsubscribeUrl}>` : "",
      `<mailto:${from}?subject=unsubscribe>`,
    ].filter(Boolean).join(", "),
    ...(oneClickUnsubscribeUrl ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
  } : undefined;
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
      if (!res.ok) {
        const apiError = await readEmailApiError(res);
        const concurrentIdempotency = res.status === 409 && apiError.code === "concurrent_idempotent_requests";
        const invalidIdempotency = res.status === 409 && apiError.code === "invalid_idempotent_request";
        return {
          ok: false,
          error: apiError.message,
          errorCode: apiError.code,
          code: res.status,
          attempt,
          uncertain: res.status >= 500 || res.status === 408 || res.status === 425 || concurrentIdempotency,
          idempotencyConflict: invalidIdempotency,
        };
      }
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
      return { ok: false, error: e.message, code: e.name || "fetch_error", attempt, uncertain: true };
    }
  }

  const r1 = await attemptSend(1);
  if (r1.ok) return r1;
  if (r1.idempotencyConflict) return { ...r1, provider: "resend", reason: "idempotency_payload_conflict" };
  console.warn(`[email:resend] attempt 1 failed (${r1.code || "?"}): ${r1.error}; retrying...`);
  await new Promise((res) => setTimeout(res, 1200));
  const r2 = await attemptSend(2);
  if (r2.ok) return r2;
  console.error(`[email:resend] both attempts failed for ${recipients.join(",")}: ${r2.error}`);
  return {
    ok: false,
    provider: "resend",
    reason: "send_failed_after_retry",
    error: r2.error,
    errorCode: r2.errorCode || r1.errorCode || "",
    code: r2.code,
    uncertain: Boolean(r1.uncertain || r2.uncertain),
    idempotencyConflict: Boolean(r1.idempotencyConflict || r2.idempotencyConflict),
  };
}

function smtpTransportConfig(prefix = "SMTP") {
  const host = process.env[`${prefix}_HOST`];
  const user = process.env[`${prefix}_USER`];
  const pass = process.env[`${prefix}_PASS`];
  const port = Number(process.env[`${prefix}_PORT`]) || 587;
  const from = clean(process.env[`${prefix}_FROM`] || mailFromAddress() || user, 200);
  const configuredProvider = clean(process.env[`${prefix}_PROVIDER`] || "", 30).toLowerCase();
  return {
    host,
    user,
    pass,
    port,
    from,
    provider: configuredProvider || "smtp",
  };
}

export function shouldFallbackToBackupSmtp(args, result) {
  if (result?.ok || args?.marketing || args?.scheduledAt) return false;
  // A timeout, transport exception or upstream 5xx can arrive after the
  // primary provider accepted the message. Switching providers in that state
  // defeats every provider-side idempotency key and can send a duplicate.
  if (result?.uncertain) return false;
  if (clean(args?.category, 40).toLowerCase() === "marketing") return false;
  const recipients = (Array.isArray(args?.to) ? args.to : [args?.to]).filter(Boolean);
  if (!recipients.length || recipients.some((address) => !validEmail(address))) return false;
  const code = Number(result?.code || 0);
  const detail = clean(`${result?.reason || ""} ${result?.error || ""}`, 500).toLowerCase();
  if (
    detail.includes("domain_not_verified")
    || detail.includes("domain is not verified")
    || detail.includes("verify a domain")
    || detail.includes("not authorized to send")
  ) return true;
  if ([400, 404, 409, 413, 422].includes(code)) return false;
  if ([401, 403, 429].includes(code)) return true;
  return detail.includes("resend_api_key_missing")
    || detail.includes("daily_quota_exceeded")
    || detail.includes("monthly_quota_exceeded")
    || detail.includes("rate_limit");
}

async function sendViaSmtp({
  to, subject, text, html, fromName, marketing = false, idempotencyKey = "", oneClickUnsubscribeUrl = "",
}, config = smtpTransportConfig()) {
  const { host, user, pass, port, from, provider } = config;
  const brandName = fromName || process.env.BRAND_NAME || "冒央会社";
  if (!host || !user || !pass || !from || !to) {
    return { ok: false, provider, reason: "smtp_or_to_missing" };
  }
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch (e) { return { ok: false, provider, reason: "nodemailer_import_failed" }; }
  const secure = port === 465;
  const messageToken = idempotencyKey
    ? createHash("sha256").update(String(idempotencyKey)).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex");
  const messageId = `<lm-${messageToken}@liumeiti.vip>`;
  // 群发/营销邮件:普通优先级(高优先级=垃圾信号)+ List-Unsubscribe 头(Gmail/Yahoo 对群发的进箱硬要求)。
  // 事务邮件(验证码/订单)保持 high 以求快达。
  const priority = marketing ? "normal" : "high";
  const extraHeaders = marketing ? {
    "List-Unsubscribe": [
      oneClickUnsubscribeUrl ? `<${oneClickUnsubscribeUrl}>` : "",
      `<mailto:${from}?subject=unsubscribe>`,
    ].filter(Boolean).join(", "),
    ...(oneClickUnsubscribeUrl ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
  } : undefined;

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
        headers: {
          ...(extraHeaders || {}),
          ...(provider === "brevo"
            ? { "X-Mailin-custom": JSON.stringify({ site_message_id: messageId.replace(/^<|>$/g, "") }) }
            : {}),
        },
      });
      try { transporter.close(); } catch (e) {}
      return { ok: true, messageId: info.messageId || messageId, provider, attempt };
    } catch (e) {
      try { transporter.close(); } catch (er) {}
      // Nodemailer cannot prove whether a transport error happened before or
      // after the SMTP server accepted DATA. Mark it ambiguous and never send
      // it again automatically, even with the same Message-ID.
      return { ok: false, provider, error: e.message, code: e.code, response: e.response, attempt, uncertain: true };
    }
  }

  const result = await attemptSend(1);
  if (result.ok) return result;
  console.error(`[email] SMTP result is uncertain for ${to}: ${result.error}`);
  return { ...result, reason: "smtp_delivery_uncertain", uncertain: true };
}

// ── Account extensions: coupons, transfers, redeem codes, withdrawals ──
// Send a generic email. Resend is primary; transactional provider/transport
// failures can use the configured fallback SMTP channel.
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
  let prepared = {
    ...applyEmailSupportContacts(args, args?.support || await currentEmailSupport()),
    // One key is reused by both Resend attempts and the fallback transport.
    idempotencyKey: clean(args?.idempotencyKey, 256) || `lm-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`,
  };
  try {
    const {
      getMailSendDecision,
      mailPurpose,
      prepareMarketingEmail,
    } = await import("./_mail-preferences.js");
    const recipient = Array.isArray(prepared.to) ? prepared.to[0] : prepared.to;
    const purpose = mailPurpose(prepared);
    // Marketing may only proceed after a durable contact plus signed RFC 8058
    // links have been created. This also turns a missing policy secret/store
    // into a retryable failure instead of an untracked send.
    if (purpose === "marketing") {
      prepared = await prepareMarketingEmail({ ...prepared, marketing: true, category: "marketing" });
    }
    const decision = await getMailSendDecision({
      email: recipient,
      purpose,
      category: prepared.category,
      marketing: prepared.marketing,
    });
    if (!decision.allowed) {
      const retryable = Boolean(decision.retryable || decision.policyUnavailable);
      const result = {
        ok: false,
        suppressed: !retryable,
        retryable,
        policyUnavailable: Boolean(decision.policyUnavailable),
        status: retryable ? "failed" : "suppressed",
        provider: "policy",
        reason: decision.policyUnavailable ? "policy_unavailable" : (decision.reason || "recipient_suppressed"),
        messageId: prepared.idempotencyKey,
      };
      if (!args?.skipDeliveryTracking) {
        try {
          const { registerEmailDelivery } = await import("./_mail-delivery.js");
          await registerEmailDelivery({ args: prepared, result });
        } catch (e) {}
      }
      return result;
    }
  } catch (error) {
    // Preference storage is defense-in-depth around the provider call. Invalid
    // addresses still fail closed above; a transient policy-store exception is
    // surfaced instead of silently bypassing an explicit opt-out.
    const result = {
      ok: false,
      suppressed: false,
      retryable: true,
      policyUnavailable: true,
      status: "failed",
      provider: "policy",
      reason: "policy_unavailable",
      detail: clean(error?.message || "mail_policy_unavailable", 160),
      messageId: prepared.idempotencyKey,
    };
    if (!args?.skipDeliveryTracking) {
      try {
        const { registerEmailDelivery } = await import("./_mail-delivery.js");
        await registerEmailDelivery({ args: prepared, result });
      } catch {}
    }
    return result;
  }
  const configuredProvider = String(process.env.EMAIL_PROVIDER || "resend").toLowerCase();
  const forcedProvider = clean(prepared.forceProvider, 20).toLowerCase();
  const provider = ["resend", "smtp"].includes(forcedProvider) ? forcedProvider : configuredProvider;
  let result;
  let primaryResult = null;
  let fallbackResult = null;
  if (provider === "smtp") result = await sendViaSmtp(prepared);
  else if (process.env.RESEND_API_KEY) result = await sendViaResend(prepared);
  else result = { ok: false, provider: "resend", reason: "resend_api_key_missing" };
  primaryResult = result;
  if (provider !== "smtp" && shouldFallbackToBackupSmtp(prepared, result)) {
    fallbackResult = await sendViaSmtp(prepared, smtpTransportConfig("FALLBACK_SMTP"));
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
        fallbackProvider: fallbackResult.provider || "smtp",
        fallbackError: fallbackResult.reason || fallbackResult.error || "smtp_fallback_failed",
      };
    }
  }
  const trackingTasks = [];
  if (!args?.skipDeliveryTracking) {
    try {
      const { registerEmailDelivery } = await import("./_mail-delivery.js");
      trackingTasks.push(registerEmailDelivery({ args: prepared, result }));
    } catch (e) {}
  }
  try {
    const { recordHealthStatus } = await import("./_health.js");
    if (provider !== "smtp") {
      trackingTasks.push(recordHealthStatus("resend", {
        status: primaryResult?.ok ? "ok" : "error",
        summary: primaryResult?.ok
          ? "最近一封邮件已由 Resend 提交"
          : (fallbackResult?.ok ? "Resend 发送失败，邮件已切换至备用通道" : "最近一次 Resend 发信失败"),
        error: primaryResult?.ok ? "" : (primaryResult?.reason || primaryResult?.error || "send_failed"),
        metrics: {
          fallback: Boolean(fallbackResult),
          attempt: Number(primaryResult?.attempt || 1),
        },
      }));
    }
    const brevoResult = provider === "smtp" && result?.provider === "brevo" ? result : fallbackResult;
    if (brevoResult && brevoResult.provider === "brevo") {
      trackingTasks.push(recordHealthStatus("brevo", {
        status: brevoResult.ok ? "ok" : "error",
        summary: brevoResult.ok ? "最近一封邮件已由 Brevo 提交" : "最近一次 Brevo 发信失败",
        error: brevoResult.ok ? "" : (brevoResult.reason || brevoResult.error || "send_failed"),
        metrics: {
          fallback: provider !== "smtp",
          attempt: Number(brevoResult.attempt || 1),
        },
      }));
    }
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
const DURABLE_ADMIN_OPERATION_PREFIX = "liumeiti:admin:operation:";

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
  if (value === "" || value == null) {
    const deleted = await redisCmd(["DEL", key]);
    return Number.isInteger(Number(deleted)) && Number(deleted) >= 0;
  }
  const n = Number(value);
  // Keep stock values inside JavaScript/Lua's exact integer range and a sane
  // operational ceiling. This also guarantees Redis DECRBY cannot overflow
  // after an earlier stock key has already been changed in the same script.
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) return false;
  return await redisCmd(["SET", key, String(n)]) === "OK";
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

function durableAdminOperationKey(scope, operationId) {
  const digest = createHash("sha256")
    .update(String(scope || "") + "\0" + String(operationId || ""))
    .digest("hex");
  return DURABLE_ADMIN_OPERATION_PREFIX + clean(scope, 60) + ":" + digest;
}

function validAdminOperationId(value) {
  const raw = String(value || "").trim();
  return raw.length >= 8 && raw.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : "";
}

function parseDurableAdminOperation(raw, requestHash) {
  if (!raw || typeof raw !== "string") return null;
  let record = null;
  try { record = JSON.parse(raw); } catch (e) { return { ok: false, error: "storage_failed" }; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, error: "storage_failed" };
  if (clean(record.requestHash, 80) !== requestHash) return { ok: false, error: "idempotency_conflict" };
  let result = null;
  try {
    if (typeof record.retryResultJson === "string") result = JSON.parse(record.retryResultJson);
    else if (typeof record.resultJson === "string") result = JSON.parse(record.resultJson);
    else if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) result = record.result;
  } catch (e) { return { ok: false, error: "storage_failed" }; }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.ok !== true) return { ok: false, error: "storage_failed" };
  return { ...result, idempotent: true, recovered: true };
}

async function recoverDurableAdminOperation(operationKey, requestHash) {
  const raw = await redisCmd(["GET", operationKey]);
  return parseDurableAdminOperation(raw, requestHash);
}

function adminActionEntry(action, actor, target, detail, now = new Date()) {
  const staff = adminActorFromSession(actor);
  return {
    id: makeId("AL"),
    action: clean(action, 80),
    target: clean(target, 180),
    detail: detail && typeof detail === "object" ? detail : {},
    staffId: Number(staff.staffId || 1),
    staffUsername: clean(staff.staffUsername || "admin", 60),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
}

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

const STRICT_DUAL_RATE_LIMIT_SCRIPT = `
local function kind(key) local value=redis.call('TYPE',key) if type(value)=='table' then return value.ok end return value end local window=tonumber(ARGV[1]) local identityLimit=tonumber(ARGV[2]) local ipLimit=tonumber(ARGV[3]) if not window or window~=math.floor(window) or window<1 or window>2147483647 or not identityLimit or identityLimit~=math.floor(identityLimit) or identityLimit<1 or identityLimit>9007199254740991 or not ipLimit or ipLimit~=math.floor(ipLimit) or ipLimit<1 or ipLimit>9007199254740991 then return cjson.encode({ok=false,error='rate_limit_config_invalid'}) end local function repaircount(key) local value=kind(key) if value=='none' then return 0 end if value~='string' then redis.call('DEL',key); return 1 end local raw=redis.call('GET',key) if not string.match(raw,'^%d+$') then redis.call('DEL',key); return 1 end local count=tonumber(raw) if not count or count~=math.floor(count) or count<0 or count>=9007199254740991 then redis.call('DEL',key); return 1 end return 0 end local repaired=repaircount(KEYS[1])+repaircount(KEYS[2]) local identityCount=redis.call('INCR',KEYS[1]) local ipCount=redis.call('INCR',KEYS[2]) if identityCount==1 then redis.call('EXPIRE',KEYS[1],tostring(window)) end if ipCount==1 then redis.call('EXPIRE',KEYS[2],tostring(window)) end local identityTtl=redis.call('TTL',KEYS[1]) local ipTtl=redis.call('TTL',KEYS[2]) if identityTtl<0 then redis.call('EXPIRE',KEYS[1],tostring(window)); identityTtl=window end if ipTtl<0 then redis.call('EXPIRE',KEYS[2],tostring(window)); ipTtl=window end return '{"ok":true,"identityCount":'..tostring(identityCount)..',"ipCount":'..tostring(ipCount)..',"identityTtl":'..tostring(identityTtl)..',"ipTtl":'..tostring(ipTtl)..',"repaired":'..tostring(repaired)..'}'
`;

// Authentication and verification endpoints use independent identity-only and
// IP-only buckets. User-Agent is intentionally absent because clients can
// rotate it on every guess. Both counters update in one script and fail closed.
export async function checkCriticalRateLimit(request, {
  namespace,
  identity,
  identityLimit = 10,
  ipLimit = 60,
  windowSec = 600,
} = {}) {
  const safeNamespace = clean(namespace || "critical", 80).replace(/[^a-z0-9:_-]/gi, "");
  const normalizedIdentity = clean(identity || "unknown", 500).toLowerCase();
  const ip = clientIpFromRequest(request);
  const identityKey = "liumeiti:rate:" + safeNamespace + ":identity:"
    + rateLimitIdentityFingerprint("identity|" + normalizedIdentity);
  const ipKey = "liumeiti:rate:" + safeNamespace + ":ip:"
    + rateLimitIdentityFingerprint("ip|" + ip);
  const raw = await redisCmd([
    "EVAL",
    STRICT_DUAL_RATE_LIMIT_SCRIPT,
    "2",
    identityKey,
    ipKey,
    String(windowSec),
    String(identityLimit),
    String(ipLimit),
  ]);
  let result = null;
  try { result = typeof raw === "string" ? JSON.parse(raw) : null; } catch {}
  if (!result?.ok) {
    return {
      ok: false,
      unavailable: true,
      status: 503,
      error: result?.error || "rate_limit_unavailable",
      retryAfter: 5,
    };
  }
  if (Number(result.repaired) > 0) console.warn("[rate-limit] repaired invalid ephemeral counters", { namespace: safeNamespace, repaired: Number(result.repaired) });
  const identityExceeded = Number(result.identityCount) > Number(identityLimit);
  const ipExceeded = Number(result.ipCount) > Number(ipLimit);
  if (identityExceeded || ipExceeded) {
    const retryAfter = Math.max(
      identityExceeded ? Number(result.identityTtl || windowSec) : 0,
      ipExceeded ? Number(result.ipTtl || windowSec) : 0,
    );
    return {
      ok: false,
      count: identityExceeded ? Number(result.identityCount) : Number(result.ipCount),
      limit: identityExceeded ? Number(identityLimit) : Number(ipLimit),
      retryAfter: retryAfter > 0 ? retryAfter : Number(windowSec),
    };
  }
  return {
    ok: true,
    identityCount: Number(result.identityCount),
    ipCount: Number(result.ipCount),
    retryAfter: 0,
  };
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
  if (guard?.unavailable || Number(guard?.status) === 503) {
    const retryAfter = Number(guard?.retryAfter || 5);
    return Response.json({
      ok: false,
      error: guard?.error || "rate_limit_unavailable",
      message: "请求验证服务暂时不可用，请稍后重试",
      retryAfter,
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
    });
  }
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

function validAccountLifecycleId(value) {
  return /^[a-f0-9]{32}$/.test(String(value || "").trim().toLowerCase());
}

async function readReferralAccountState(email) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return null;
  try {
    const { readUserAuthState } = await import("./_auth-session.js");
    const state = await readUserAuthState(lower);
    return state.ok && validAccountLifecycleId(state.accountLifecycleId)
      ? state
      : null;
  } catch {
    return null;
  }
}

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

export async function ensureUserReferralProfile(email, currentUser = null, options = {}) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return null;
  const user = currentUser || await getUser(lower);
  if (!user) return null;
  let changed = false;
  if (!normalizeInviteCode(user.inviteCode)) {
    user.inviteCode = await createUniqueInviteCode();
    changed = true;
  }
  // Do not publish an invite-code mapping until the guarded profile write has
  // committed. In particular, a request holding a snapshot from a deleted
  // lifecycle must not bind that old code to a newly registered account.
  if (changed) {
    const saved = await setUser(lower, user, { ...options, returnResult: true });
    if (!saved?.ok) return null;
  }
  await bindInviteCode(lower, user.inviteCode);
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
      const inviterState = await readReferralAccountState(inviter.email);
      const inviterUser = inviterState?.user;
      // Re-check the canonical code after the lifecycle read. A delete and
      // re-registration between the lookup and this point must not transfer
      // an old referral relationship to the replacement account.
      if (inviterUser && normalizeInviteCode(inviterUser.inviteCode) === normalizedInvite) {
        await ensureUserReferralProfile(inviter.email, inviterUser, {
          expectedAuthVersion: inviterState.authVersion,
          updateOnly: true,
        });
        next.invitedByEmail = inviter.email;
        next.invitedByCode = normalizeInviteCode(inviterUser.inviteCode) || normalizedInvite;
        next.invitedByAccountLifecycleId = inviterState.accountLifecycleId;
        next.invitedBy2Email = inviterUser.invitedByEmail && inviterUser.invitedByEmail !== lower
          ? String(inviterUser.invitedByEmail).toLowerCase()
          : "";
        next.invitedBy2AccountLifecycleId = next.invitedBy2Email
          && validAccountLifecycleId(inviterUser.invitedByAccountLifecycleId)
          ? String(inviterUser.invitedByAccountLifecycleId).toLowerCase()
          : "";
        next.invitedAt = new Date().toISOString();
        next.invitedAtBeijing = formatBeijingTime(new Date());
        // 关系成立 → 写入反向索引(上级名下登记该新用户)。
        await indexReferralRelation(lower, next.invitedByEmail, next.invitedBy2Email);
      }
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
  let firstLifecycleId = "";
  let secondLifecycleId = "";
  let source = "";
  let code = "";

  if (validEmail(buyerEmail)) {
    const buyerState = await readReferralAccountState(buyerEmail);
    const buyer = buyerState?.user
      ? await ensureUserReferralProfile(buyerEmail, buyerState.user, {
          expectedAuthVersion: buyerState.authVersion,
          updateOnly: true,
        })
      : null;
    if (buyer?.invitedByEmail && buyer.invitedByEmail !== buyerEmail) {
      firstEmail = String(buyer.invitedByEmail).toLowerCase();
      secondEmail = buyer.invitedBy2Email ? String(buyer.invitedBy2Email).toLowerCase() : "";
      firstLifecycleId = validAccountLifecycleId(buyer.invitedByAccountLifecycleId)
        ? String(buyer.invitedByAccountLifecycleId).toLowerCase()
        : "";
      secondLifecycleId = validAccountLifecycleId(buyer.invitedBy2AccountLifecycleId)
        ? String(buyer.invitedBy2AccountLifecycleId).toLowerCase()
        : "";
      code = normalizeInviteCode(buyer.invitedByCode);
      source = "registered_relation";
    }
  }

  if (!firstEmail) {
    const normalized = normalizeInviteCode(inviteCode);
    const inviter = normalized ? await getUserByInviteCode(normalized) : null;
    if (inviter && inviter.email !== buyerEmail) {
      const inviterState = await readReferralAccountState(inviter.email);
      const inviterUser = inviterState?.user;
      if (inviterUser && normalizeInviteCode(inviterUser.inviteCode) === normalized) {
        await ensureUserReferralProfile(inviter.email, inviterUser, {
          expectedAuthVersion: inviterState.authVersion,
          updateOnly: true,
        });
        firstEmail = inviter.email;
        firstLifecycleId = inviterState.accountLifecycleId;
        secondEmail = inviterUser.invitedByEmail ? String(inviterUser.invitedByEmail).toLowerCase() : "";
        secondLifecycleId = validAccountLifecycleId(inviterUser.invitedByAccountLifecycleId)
          ? String(inviterUser.invitedByAccountLifecycleId).toLowerCase()
          : "";
        code = inviterUser.inviteCode || normalized;
        source = "invite_link";
      }
    }
  }

  if (secondEmail === firstEmail || secondEmail === buyerEmail) {
    secondEmail = "";
    secondLifecycleId = "";
  }
  if (!firstEmail) return null;
  return {
    source,
    inviteCode: normalizeInviteCode(code),
    levelOneEmail: firstEmail,
    levelOneAccountLifecycleId: firstLifecycleId,
    levelOneRate: REFERRAL_LEVEL_ONE_RATE,
    levelTwoEmail: secondEmail,
    levelTwoAccountLifecycleId: secondEmail ? secondLifecycleId : "",
    levelTwoRate: secondEmail ? REFERRAL_LEVEL_TWO_RATE : 0,
  };
}

export async function settleOrderReferralCommission(order, actor = null) {
  if (!order || order.referralCommissionSettledAt) return { ok: true, skipped: "already_settled", entries: order?.referralCommissionEntries || [] };
  const referral = order.referral || null;
  const baseAmount = roundMoney(order.finalAmount || 0);
  if (!referral || baseAmount <= 0) return { ok: true, skipped: "no_referral", entries: [] };
  const now = new Date();
  const cycle = Math.max(1, Number(order.referralCommissionCycle || 0) + 1);
  const candidates = [
    {
      level: 1,
      email: referral.levelOneEmail,
      accountLifecycleId: String(referral.levelOneAccountLifecycleId || "").toLowerCase(),
      rate: Number(referral.levelOneRate || REFERRAL_LEVEL_ONE_RATE),
    },
    {
      level: 2,
      email: referral.levelTwoEmail,
      accountLifecycleId: String(referral.levelTwoAccountLifecycleId || "").toLowerCase(),
      rate: Number(referral.levelTwoRate || REFERRAL_LEVEL_TWO_RATE),
    },
  ].filter((item) => validEmail(item.email) && item.rate > 0);
  const entries = [];
  const skippedEntries = [];
  for (const item of candidates) {
    const email = String(item.email).toLowerCase();
    const commission = roundMoney(baseAmount * item.rate);
    if (commission <= 0) continue;
    if (!validAccountLifecycleId(item.accountLifecycleId)) {
      skippedEntries.push({
        email,
        accountLifecycleId: "",
        level: item.level,
        rate: item.rate,
        amount: commission,
        reason: "referral_account_lifecycle_required",
        manualReview: true,
      });
      continue;
    }
    const effect = await applyBalanceEffectAtomic({
      email,
      delta: commission,
      effectId: `referral:${order.orderId}:cycle:${cycle}:level:${item.level}`,
      reason: `合伙人收益 ${maskReferralOrderId(order.orderId)} · ${item.level === 1 ? "一级10%" : "二级5%"}`,
      source: "referral",
      orderId: order.orderId,
      referralLevel: item.level,
      staffId: Number(actor?.staffId || 1),
      staffUsername: clean(actor?.staffUsername || "admin", 60),
      detail: { orderId: order.orderId, level: item.level, rate: item.rate, baseAmount },
      referralCommissionDelta: commission,
      skipUnavailable: true,
      expectedAccountLifecycleId: item.accountLifecycleId,
    });
    if (!effect.ok) {
      if (effect.error === "account_lifecycle_changed" || effect.error === "account_lifecycle_required") {
        skippedEntries.push({
          email,
          accountLifecycleId: item.accountLifecycleId,
          level: item.level,
          rate: item.rate,
          amount: commission,
          reason: effect.error,
          manualReview: true,
        });
        continue;
      }
      return { ok: false, error: effect.error, entries, skippedEntries };
    }
    if (effect.skipped) {
      skippedEntries.push({
        email,
        accountLifecycleId: item.accountLifecycleId,
        level: item.level,
        rate: item.rate,
        amount: commission,
        reason: clean(effect.reason || "referral_account_unavailable", 100),
        manualReview: false,
      });
      continue;
    }
    entries.push({
      email,
      accountLifecycleId: item.accountLifecycleId,
      level: item.level,
      rate: item.rate,
      amount: commission,
      balanceAfter: effect.balance,
    });
  }
  order.referralCommissionCycle = cycle;
  order.referralCommissionSettledAt = now.toISOString();
  order.referralCommissionSettledAtBeijing = formatBeijingTime(now);
  order.referralCommissionEntries = entries;
  order.referralCommissionSkippedEntries = skippedEntries;
  order.referralCommissionManualReview = skippedEntries.some((entry) => entry.manualReview)
    ? {
        required: true,
        reason: "referral_account_lifecycle_mismatch",
        levels: skippedEntries.filter((entry) => entry.manualReview).map((entry) => entry.level),
        recordedAt: now.toISOString(),
      }
    : null;
  return {
    ok: true,
    entries,
    skippedEntries,
    manualReview: Boolean(order.referralCommissionManualReview),
  };
}

// 订单从「已完成」改回其它状态(作废/未完成)时,把已发放的返佣按笔冲正回收。
// 冲正后清空结算标记,使订单若再次完成可重新结算;按 tx 净额幂等,重复调用安全。
export async function reverseOrderReferralCommission(order, actor = null) {
  if (!order || !order.referralCommissionSettledAt) {
    return { ok: true, skipped: "not_settled", reversed: [] };
  }
  const settledEntries = Array.isArray(order.referralCommissionEntries) ? order.referralCommissionEntries : [];
  const now = new Date();
  const cycle = Math.max(1, Number(order.referralCommissionCycle || 1));
  const unbound = settledEntries.find((entry) =>
    validEmail(entry?.email)
    && Number(entry?.amount || 0) > 0
    && !validAccountLifecycleId(entry?.accountLifecycleId)
  );
  if (unbound) {
    return {
      ok: false,
      error: "referral_account_lifecycle_required",
      manualReview: true,
      reversed: [],
    };
  }
  const reversed = [];
  for (const entry of settledEntries) {
    const email = String(entry?.email || "").toLowerCase();
    const accountLifecycleId = String(entry?.accountLifecycleId || "").toLowerCase();
    const level = Number(entry?.level || 0);
    const amount = roundMoney(entry?.amount || 0);
    if (!validEmail(email) || amount <= 0) continue;
    const effect = await applyBalanceEffectAtomic({
      email,
      delta: -amount,
      effectId: `referral-reversal:${order.orderId}:cycle:${cycle}:level:${level}`,
      reason: `合伙人收益冲正 ${maskReferralOrderId(order.orderId)} · ${level === 1 ? "一级10%" : "二级5%"}(订单作废)`,
      source: "referral_reversal",
      allowNegative: true,
      orderId: order.orderId,
      referralLevel: level,
      staffId: Number(actor?.staffId || 1),
      staffUsername: clean(actor?.staffUsername || "admin", 60),
      detail: { orderId: order.orderId, level, amount },
      referralCommissionDelta: -amount,
      expectedAccountLifecycleId: accountLifecycleId,
    });
    if (!effect.ok) return {
      ok: false,
      error: effect.error,
      manualReview: effect.error === "account_lifecycle_changed" || effect.error === "account_lifecycle_required",
      reversed,
    };
    reversed.push({ email, accountLifecycleId, level, amount, balanceAfter: effect.balance });
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

export async function previewBestCoupon(email, maxAmount) {
  const user = await getUser(email);
  if (!user) return { discount: 0 };
  const coupons = Array.isArray(user.coupons) ? user.coupons : [];
  const coupon = coupons.find((item) => item && item.status === "active" && Number(item.amount) > 0);
  if (!coupon) return { discount: 0 };
  const discount = Math.min(roundMoney(coupon.amount), roundMoney(maxAmount));
  return discount > 0
    ? { discount, couponId: clean(coupon.id, 100), couponTitle: clean(coupon.title, 160) }
    : { discount: 0 };
}

export async function restoreStockOnce(service, planId, effectId) {
  return adjustStockEffectAtomic(service, planId, 1, effectId);
}

export async function reserveStockOnce(service, planId, effectId) {
  return adjustStockEffectAtomic(service, planId, -1, effectId);
}

// 订单作废退款 — 退余额(余额支付)+ 还优惠券 + 恢复兑换码。幂等(order.refundedAt 守卫 + 退款流水去重)。
// AI 库存的归还由 [orderId] 路由单独处理,这里不碰。
export async function refundVoidedOrder(order, actor = null) {
  if (!order || order.refundedAt) return { ok: true, skipped: "already_refunded", balance: 0, coupon: false };
  const now = new Date();
  const email = String(order.userEmail || "").trim().toLowerCase();
  const out = { balance: 0, coupon: false };
  const cycle = Math.max(1, Number(order.refundCycle || 0) + 1);
  const accountLifecycleId = String(order.accountLifecycleId || "").trim().toLowerCase();
  const balanceAmount = order.paidByBalance ? roundMoney(order.finalAmount || 0) : 0;
  if ((balanceAmount > 0 || Boolean(order.couponId)) && !validEmail(email)) {
    return { ok: false, error: "user_not_found", manualReview: true, ...out };
  }
  if ((balanceAmount > 0 || Boolean(order.couponId)) && !validAccountLifecycleId(accountLifecycleId)) {
    return { ok: false, error: "account_lifecycle_required", manualReview: true, ...out };
  }

  // 1) 余额支付 → 退回余额
  if (order.paidByBalance && validEmail(email)) {
    const amount = balanceAmount;
    if (amount > 0) {
      const effect = await applyBalanceEffectAtomic({
        email, delta: amount, effectId: `order-refund:${order.orderId}:cycle:${cycle}`,
        reason: `订单作废退款 ${order.orderId}`, source: "order_refund", orderId: order.orderId,
        staffId: Number(actor?.staffId || 1), staffUsername: clean(actor?.staffUsername || "admin", 60),
        detail: { orderId: order.orderId, amount, cycle },
        expectedAccountLifecycleId: accountLifecycleId,
      });
      if (!effect.ok) return {
        ok: false,
        error: effect.error,
        manualReview: effect.error === "account_lifecycle_changed" || effect.error === "account_lifecycle_required",
        ...out,
      };
      out.balance = amount;
    }
  }

  // 2) 优惠券 → 还回(若该订单用过)
  if (order.couponId && validEmail(email)) {
    const restored = await transitionOrderCouponAtomic(
      email, order.couponId, order.orderId, "active", `coupon-refund:${order.orderId}:cycle:${cycle}`,
      accountLifecycleId,
    );
    if (!restored.ok) {
      return {
        ok: false,
        error: restored.error || "coupon_refund_failed",
        manualReview: restored.error === "account_lifecycle_changed" || restored.error === "account_lifecycle_required",
        partial: out.balance > 0,
        ...out,
      };
    }
    out.coupon = Boolean(restored.ok && (restored.changed || restored.idempotent));
  }

  // 注:兑换码「兑换过即失效」—— 订单作废不恢复兑换码(已消耗,永久失效)。
  // 仅下单创建失败的回滚(order/route.js)才返还,那是订单根本没成立的场景。

  order.refundCycle = cycle;
  order.refundedAt = now.toISOString();
  order.refundedAtBeijing = formatBeijingTime(now);
  order.refund = out;
  return { ok: true, ...out };
}

// 作废订单被改回「有效」时,回收此前的退款 —— 否则用户既拿退款、订单又生效(白嫖资金洞)。
// 余额扣回(净额幂等,允许负余额)、优惠券重新置为已用、清空退款标记以便再次作废可再退。
// 库存的重新占用由 [orderId] 路由处理。
export async function reclaimRefundOnReactivate(order, actor = null) {
  if (!order || !order.refundedAt) return { ok: true, skipped: "not_refunded", balance: 0, coupon: false };
  const now = new Date();
  const email = String(order.userEmail || "").trim().toLowerCase();
  const out = { balance: 0, coupon: false };
  const cycle = Math.max(1, Number(order.refundCycle || 1));
  const accountLifecycleId = String(order.accountLifecycleId || "").trim().toLowerCase();
  const balanceAmount = order.paidByBalance
    ? roundMoney(order.refund?.balance || order.finalAmount || 0)
    : 0;
  if ((balanceAmount > 0 || Boolean(order.couponId && order.refund?.coupon)) && !validEmail(email)) {
    return { ok: false, error: "user_not_found", manualReview: true, ...out };
  }
  if ((balanceAmount > 0 || Boolean(order.couponId && order.refund?.coupon)) && !validAccountLifecycleId(accountLifecycleId)) {
    return { ok: false, error: "account_lifecycle_required", manualReview: true, ...out };
  }

  // Resolve the only permanent ownership conflict before reclaiming money.
  // This keeps a failed reactivation from deducting balance.
  if (order.couponId && validEmail(email) && order.refund?.coupon) {
    const consumed = await transitionOrderCouponAtomic(
      email, order.couponId, order.orderId, "used", `coupon-reclaim:${order.orderId}:cycle:${cycle}`,
      accountLifecycleId,
    );
    if (!consumed.ok) {
      return {
        ok: false,
        error: consumed.error || "coupon_reclaim_failed",
        manualReview: consumed.error === "account_lifecycle_changed" || consumed.error === "account_lifecycle_required",
        partial: false,
        ...out,
      };
    }
    out.coupon = Boolean(consumed.changed || consumed.idempotent);
  }

  // 1) 余额:把作废时退回的钱重新扣除(净额去重:退款笔数 > 收回笔数 时才收回)
  if (order.paidByBalance && validEmail(email)) {
    const amount = balanceAmount;
    if (amount > 0) {
      const effect = await applyBalanceEffectAtomic({
        email, delta: -amount, effectId: `order-refund-reclaim:${order.orderId}:cycle:${cycle}`,
        reason: `作废撤销·退款收回 ${order.orderId}`, source: "order_refund_reclaim", allowNegative: true,
        orderId: order.orderId, staffId: Number(actor?.staffId || 1),
        staffUsername: clean(actor?.staffUsername || "admin", 60), detail: { orderId: order.orderId, amount, cycle },
        expectedAccountLifecycleId: accountLifecycleId,
      });
      if (!effect.ok) return {
        ok: false,
        error: effect.error,
        manualReview: effect.error === "account_lifecycle_changed" || effect.error === "account_lifecycle_required",
        partial: out.coupon,
        ...out,
      };
      out.balance = amount;
    }
  }

  // 2) 优惠券:重新置为已用(仅当作废时还回过)
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
  let initialState;
  try {
    const { readUserAuthState } = await import("./_auth-session.js");
    initialState = await readUserAuthState(lower);
  } catch (error) {
    return { ok: false, error: "storage_failed" };
  }
  if (!initialState.ok && initialState.status !== 401) {
    return { ok: false, error: initialState.error || "storage_failed" };
  }
  const existing = initialState.ok ? initialState.user : null;
  if (existing) {
    if (existing.banned) return { ok: false, error: "account_banned" };
    const social = { ...(existing.social || {}) };
    if (provider && providerId) social[provider] = providerId;
    const stableInviteCode = normalizeInviteCode(existing.inviteCode) || await createUniqueInviteCode();
    const next = {
      ...existing,
      inviteCode: stableInviteCode,
      username: existing.username || clean(username, 40) || generateRandomUsername(),
      avatarId: validUserAvatarId(existing.avatarId) ? existing.avatarId : generateRandomUserAvatarId(),
      balance: typeof existing.balance === "number" ? existing.balance : 0,
      social,
      updatedAt: now.toISOString(),
    };
    const saved = await setUser(lower, next, {
      expectedAuthVersion: initialState.authVersion,
      updateOnly: true,
      returnResult: true,
    });
    if (!saved?.ok) {
      const changed = saved?.error === "session_state_changed" || saved?.error === "user_not_found";
      return { ok: false, error: changed ? "account_state_changed" : (saved?.error || "storage_failed") };
    }
    await bindInviteCode(lower, stableInviteCode);
    return { ok: true, user: next, isNew: false, authVersion: saved.authVersion };
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
  const saved = await setUser(lower, user, { createOnly: true, returnResult: true });
  if (!saved?.ok && saved?.error === "user_exists") {
    // Another registration won after our initial read. Merge only the OAuth
    // identity into that authoritative lifecycle. Pinning its auth version
    // prevents a concurrent delete/re-registration from being overwritten.
    let racedState;
    try {
      const { readUserAuthState } = await import("./_auth-session.js");
      racedState = await readUserAuthState(lower);
    } catch (error) {
      return { ok: false, error: "storage_failed" };
    }
    if (!racedState.ok) {
      return { ok: false, error: racedState.status === 401 ? "account_state_changed" : (racedState.error || "storage_failed") };
    }
    const raced = racedState.user;
    if (raced.banned) return { ok: false, error: "account_banned" };
    const social = { ...(raced.social || {}) };
    if (provider && providerId) social[provider] = providerId;
    const merged = { ...raced, social, updatedAt: now.toISOString() };
    const mergedSaved = await setUser(lower, merged, {
      expectedAuthVersion: racedState.authVersion,
      updateOnly: true,
      returnResult: true,
    });
    if (!mergedSaved?.ok) {
      const changed = mergedSaved?.error === "session_state_changed" || mergedSaved?.error === "user_not_found";
      return { ok: false, error: changed ? "account_state_changed" : (mergedSaved?.error || "storage_failed") };
    }
    return { ok: true, user: merged, isNew: false, authVersion: mergedSaved.authVersion };
  }
  if (!saved?.ok) return { ok: false, error: saved?.error || "storage_failed" };
  return { ok: true, user, isNew: true, authVersion: saved.authVersion };
}

export async function transferBalanceByEmail(fromEmail, toEmail, amount, options = {}) {
  return transferBalanceAtomic(fromEmail, toEmail, amount, options);
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

async function adminStaffSnapshot() {
  try {
    const r = redisConfig();
    if (!r) return { ok: false, error: "storage_unavailable" };
    const response = await fetch(r.url + "/get/" + encodeURIComponent(ADMIN_STAFF_KEY), {
      headers: { Authorization: "Bearer " + r.token },
    });
    if (!response.ok) return { ok: false, error: "storage_unavailable" };
    const payload = await response.json();
    if (payload?.error) return { ok: false, error: "storage_error" };
    const raw = payload?.result;
    if (raw == null) return { ok: true, raw: null, records: [] };
    const records = JSON.parse(raw);
    return Array.isArray(records)
      ? { ok: true, raw: String(raw), records }
      : { ok: false, error: "storage_failed" };
  } catch (e) {
    return { ok: false, error: "storage_unavailable" };
  }
}

const MUTATE_ADMIN_STAFF_AND_KICK_SCRIPT = ADMIN_SESSION_INTEGER_HELPERS + `
local current=redis.call('GET',KEYS[1])
local absent='__LM_ADMIN_STAFF_ABSENT__'
if (ARGV[1]==absent and current) or (ARGV[1]~=absent and current~=ARGV[1]) then
  return cjson.encode({ok=false,error='staff_concurrent_update'})
end
local decodedOk,records=pcall(cjson.decode,ARGV[2])
if not decodedOk or type(records)~='table' then
  return cjson.encode({ok=false,error='storage_failed'})
end
local currentKick=readinteger(KEYS[2]); local fence=readinteger(KEYS[3])
if not currentKick or not fence then return cjson.encode({ok=false,error='invalid_session_state'}) end
local proposed=tonumber(ARGV[3]) or 0
if proposed<fence then proposed=fence end
if proposed<=currentKick then proposed=currentKick+1 end
if proposed>9007199254740991 then return cjson.encode({ok=false,error='invalid_session_state'}) end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('SET',KEYS[2],tostring(proposed))
return '{"ok":true,"kickTs":'..tostring(proposed)..'}'
`;

async function commitAdminStaffMutation(expectedRaw, records, staffId) {
  const result = await redisEvalAtomic(
    MUTATE_ADMIN_STAFF_AND_KICK_SCRIPT,
    [ADMIN_STAFF_KEY, staffKickKey(staffId), staffIssueFenceKey(staffId)],
    [expectedRaw == null ? "__LM_ADMIN_STAFF_ABSENT__" : expectedRaw, JSON.stringify(records), String(Date.now())],
  );
  if (!result.ok) return { ok: false, error: result.error || "storage_failed" };
  return result.value?.ok === true
    ? { ok: true, kickTs: Number(result.value.kickTs) || 0 }
    : { ok: false, error: clean(result.value?.error, 80) || "storage_failed" };
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

function assignableAdminStaff(records) {
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

export async function listAssignableAdminStaff() {
  return assignableAdminStaff(await adminStaffRecords());
}

export async function listAssignableAdminStaffStrict() {
  const snapshot = await adminStaffSnapshot();
  if (!snapshot.ok) {
    const error = new Error(snapshot.error || "admin_staff_store_unavailable");
    error.code = snapshot.error || "admin_staff_store_unavailable";
    throw error;
  }
  return assignableAdminStaff(snapshot.records);
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
  if (typeof patch?.password === "string" && patch.password
      && (patch.password.length < 6 || patch.password.length > 64)) {
    return { ok: false, error: "invalid_password" };
  }

  let staff = null;
  let changed = null;
  let committed = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await adminStaffSnapshot();
    if (!snapshot.ok) return { ok: false, error: snapshot.error || "storage_failed" };
    const records = snapshot.records;
    const index = records.findIndex((item) => Number(item.id) === staffId);
    if (index < 0) return { ok: false, error: "staff_not_found" };
    staff = { ...records[index] };
    changed = {};

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
      staff.passwordHash = hashPassword(patch.password);
      changed.passwordReset = true;
    }
    if (typeof patch?.active === "boolean") {
      staff.active = patch.active;
      changed.active = staff.active;
    }
    if (!Object.keys(changed).length) return { ok: false, error: "nothing_to_update" };

    records[index] = staff;
    committed = await commitAdminStaffMutation(snapshot.raw, records, staffId);
    if (committed.ok || committed.error !== "staff_concurrent_update") break;
  }
  if (!committed?.ok) return { ok: false, error: committed?.error || "staff_concurrent_update" };
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
  const now = new Date();
  let removed = null;
  let committed = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await adminStaffSnapshot();
    if (!snapshot.ok) return { ok: false, error: snapshot.error || "storage_failed" };
    const records = snapshot.records;
    const index = records.findIndex((item) => Number(item.id) === staffId);
    if (index < 0) return { ok: false, error: "staff_not_found" };
    [removed] = records.splice(index, 1);
    committed = await commitAdminStaffMutation(snapshot.raw, records, staffId);
    if (committed.ok || committed.error !== "staff_concurrent_update") break;
  }
  if (!committed?.ok) return { ok: false, error: committed?.error || "staff_concurrent_update" };
  await pushAdminActionLog({
    action: "staff_delete",
    actor,
    target: "staff:" + staffId,
    detail: { username: removed?.username || "" },
  });
  return { ok: true, deleted: staffId, deletedAtBeijing: formatBeijingTime(now) };
}

const PUSH_ADMIN_ACTION_ONCE_SCRIPT = `
local markerType=redis.call('TYPE',KEYS[1]) if type(markerType)=='table' then markerType=markerType.ok end local listType=redis.call('TYPE',KEYS[2]) if type(listType)=='table' then listType=listType.ok end if markerType~='none' and markerType~='string' then return -2 end if listType~='none' and listType~='list' then return -2 end local marked=redis.call('SET',KEYS[1],'1','NX') if marked then redis.call('LPUSH',KEYS[2],ARGV[1]) redis.call('LTRIM',KEYS[2],0,499) return 1 end return 0
`;

export async function pushAdminActionLog({ action, actor, target, detail, operationId = "" }) {
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
  const stableOperation = clean(operationId, 300);
  if (stableOperation) {
    const marker = "liumeiti:admin-action-once:v1:"
      + createHash("sha256").update(stableOperation).digest("hex");
    const appended = await redisCmd([
      "EVAL", PUSH_ADMIN_ACTION_ONCE_SCRIPT, "2",
      marker, ADMIN_ACTION_LOG_KEY, JSON.stringify(entry),
    ]);
    return appended === 1 || appended === 0;
  }
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
    category: clean(entry?.category, 40).toLowerCase(),
    relatedType: clean(entry?.relatedType, 40),
    relatedId: clean(entry?.relatedId, 120),
    campaignId: clean(entry?.campaignId || entry?.relatedId, 80),
    template: clean(entry?.template, 80),
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

export async function createRedeemCodes(input, actor = null, options = {}) {
  const normalized = normalizeRedeemInput(input);
  if (!normalized.ok) return normalized;
  const rawOperationId = String(options?.operationId || "").trim();
  if (!rawOperationId) return { ok: false, error: "idempotency_key_required" };
  const operationId = validAdminOperationId(rawOperationId);
  if (!operationId) return { ok: false, error: "invalid_idempotency_key" };
  const { type, value, services, quantity, remark, customCode } = normalized;
  const now = new Date();
  const batchId = makeId("RB");
  const actorInfo = adminActorFromSession(actor);
  const requestHash = idempotencyPayloadHash({ type, value, services, quantity, remark, customCode });
  // The client operation belongs to the redeem-management business domain,
  // not to whichever authorised staff session happens to deliver a retry.
  // Actor identity remains on the first committed batch/items/audit entry.
  const operationKey = durableAdminOperationKey("redeem-create", operationId);
  const items = [];
  const generatedCodes = new Set();
  for (let i = 0; i < quantity; i += 1) {
    let code = customCode && i === 0 ? customCode : await generateUniqueRedeemCode();
    while (generatedCodes.has(code)) code = await generateUniqueRedeemCode();
    generatedCodes.add(code);
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
    item.createdByStaffId = actorInfo.staffId;
    item.createdByStaffUsername = actorInfo.staffUsername;
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
  batch.createdByStaffId = actorInfo.staffId;
  batch.createdByStaffUsername = actorInfo.staffUsername;

  const resultValue = { ok: true, code: items[0], codes: items, batch };
  const operationRecord = {
    version: 1,
    requestHash,
    resultJson: JSON.stringify(resultValue),
    retryResultJson: JSON.stringify({ ...resultValue, idempotent: true, recovered: true }),
  };
  const audit = adminActionEntry(
    "redeem_batch_create",
    actorInfo,
    "redeem-batch:" + batchId,
    { type, amount: value, quantity, remark, customCode: customCode || "" },
    now,
  );
  // REDEEM_BATCH_CREATE_ATOMIC_V1: the operation record is written in the
  // same script as every code, both indexes, the batch, and its audit entry.
  // Every possible wrong-type/collision/JSON error is checked before writes.
  const createScript = `
local function keyType(key)
  local reply = redis.call('TYPE', key)
  return type(reply) == 'table' and reply.ok or reply
end
local function response(value)
  local ok,encoded=pcall(cjson.encode,value)
  if not ok then return redis.error_reply('json_encode_failed') end
  return encoded
end

local opType = keyType(KEYS[1])
if opType == 'string' then
  local raw = redis.call('GET', KEYS[1])
  local decodedOk, existing = pcall(cjson.decode, raw)
  if not decodedOk or type(existing) ~= 'table' or type(existing.retryResultJson) ~= 'string' then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  if tostring(existing.requestHash or '') ~= ARGV[1] then
    return cjson.encode({ok=false,error='idempotency_conflict'})
  end
  local resultOk, result = pcall(cjson.decode, existing.retryResultJson)
  if not resultOk or type(result) ~= 'table' or result.ok ~= true then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  return existing.retryResultJson
elseif opType ~= 'none' then
  return cjson.encode({ok=false,error='storage_failed'})
end

local redeemListType = keyType(KEYS[2])
local batchListType = keyType(KEYS[4])
local auditType = keyType(KEYS[5])
if (redeemListType ~= 'none' and redeemListType ~= 'list')
  or (batchListType ~= 'none' and batchListType ~= 'list')
  or (auditType ~= 'none' and auditType ~= 'list') then
  return cjson.encode({ok=false,error='storage_failed'})
end
if keyType(KEYS[3]) ~= 'none' then
  return cjson.encode({ok=false,error='batch_exists'})
end

local batchOk, batch = pcall(cjson.decode, ARGV[3])
local itemsOk, items = pcall(cjson.decode, ARGV[4])
local resultOk, result = pcall(cjson.decode, ARGV[5])
local operationOk, operation = pcall(cjson.decode, ARGV[6])
local auditOk, audit = pcall(cjson.decode, ARGV[7])
if not batchOk or type(batch) ~= 'table'
  or not itemsOk or type(items) ~= 'table'
  or not resultOk or type(result) ~= 'table' or result.ok ~= true
  or not operationOk or type(operation) ~= 'table' or tostring(operation.requestHash or '') ~= ARGV[1]
    or type(operation.resultJson) ~= 'string' or type(operation.retryResultJson) ~= 'string'
  or not auditOk or type(audit) ~= 'table'
  or tostring(batch.id or '') ~= ARGV[2]
  or #items ~= (#KEYS - 5)
  or type(batch.codes) ~= 'table' or #batch.codes ~= #items then
  return cjson.encode({ok=false,error='storage_failed'})
end

local rawItems = {}
local seenCodes = {}
for itemIndex = 1, #items do
  local item = items[itemIndex]
  local code = tostring(item.code or '')
  if code == '' or code ~= tostring(batch.codes[itemIndex] or '') or seenCodes[code] then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  seenCodes[code] = true
  if keyType(KEYS[itemIndex + 5]) ~= 'none' then
    local errorOk,errorJson=pcall(cjson.encode,{ok=false,error=ARGV[8]})
    if not errorOk then return redis.error_reply('json_encode_failed') end
    return errorJson
  end
  local itemRaw=ARGV[8+itemIndex]
  local rawOk,rawItem=pcall(cjson.decode,itemRaw)
  if not rawOk or type(rawItem)~='table' or tostring(rawItem.code or '')~=code then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  rawItems[itemIndex] = itemRaw
end

for itemIndex = 1, #items do
  redis.call('SET', KEYS[itemIndex + 5], rawItems[itemIndex])
  redis.call('LPUSH', KEYS[2], tostring(items[itemIndex].code))
end
redis.call('SET', KEYS[3], ARGV[3])
redis.call('LPUSH', KEYS[4], ARGV[2])
redis.call('LTRIM', KEYS[2], 0, 499)
redis.call('LTRIM', KEYS[4], 0, 199)
redis.call('LPUSH', KEYS[5], ARGV[7])
redis.call('LTRIM', KEYS[5], 0, 499)
redis.call('SET', KEYS[1], ARGV[6])
return ARGV[5]`;

  const execution = await redisEvalAtomic(
    createScript,
    [
      operationKey,
      REDEEM_LIST_KEY,
      redeemBatchKey(batchId),
      REDEEM_BATCH_LIST_KEY,
      ADMIN_ACTION_LOG_KEY,
      ...items.map((item) => redeemCodeKey(item.code)),
    ],
    [
      requestHash,
      batchId,
      JSON.stringify(batch),
      JSON.stringify(items),
      JSON.stringify(resultValue),
      JSON.stringify(operationRecord),
      JSON.stringify(audit),
      customCode ? "custom_code_exists" : "code_exists",
      ...items.map((item) => JSON.stringify(item)),
    ],
  );
  if (execution.ok && execution.value && typeof execution.value === "object" && !Array.isArray(execution.value) && typeof execution.value.ok === "boolean") return execution.value;
  return await recoverDurableAdminOperation(operationKey, requestHash)
    || { ok: false, error: "storage_failed" };
}

export async function createRedeemCode(input, actor = null, options = {}) {
  const result = await createRedeemCodes(
    { ...(input && typeof input === "object" ? input : { amount: input }), quantity: 1 },
    actor,
    options,
  );
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

async function mutateRedeemCodeAtomic(codeValue, action, actor = null) {
  const code = normalizeRedeemCode(codeValue);
  if (!code) return { ok: false, error: "code_not_found" };
  if (action !== "void" && action !== "delete") return { ok: false, error: "invalid_action" };
  const actorInfo = adminActorFromSession(actor);
  // REDEEM_CODE_MANAGEMENT_CAS_V1: the authoritative status is inspected and
  // changed inside one script, so a concurrent redemption to `used` wins and
  // can never be overwritten or removed by an earlier admin read.
  const script = `
-- redeem_code_management_lossless_v2
local function keyType(key)
  local reply = redis.call('TYPE', key)
  return type(reply) == 'table' and reply.ok or reply
end
local function response(value)
  local ok,encoded=pcall(cjson.encode,value)
  if not ok then return redis.error_reply('json_encode_failed') end
  return encoded
end

local codeType = keyType(KEYS[1])
if codeType == 'none' then
  if ARGV[1] == 'delete' then return ARGV[7] end
  return cjson.encode({ok=false,error='code_not_found'})
elseif codeType ~= 'string' then
  return cjson.encode({ok=false,error='storage_failed'})
end

local listType = keyType(KEYS[2])
local auditType = keyType(KEYS[3])
if (listType ~= 'none' and listType ~= 'list') or (auditType ~= 'none' and auditType ~= 'list') then
  return cjson.encode({ok=false,error='storage_failed'})
end
local raw = redis.call('GET', KEYS[1])
if raw ~= ARGV[3] then return cjson.encode({ok=false,error='code_conflict'}) end
local decodedOk, item = pcall(cjson.decode, raw)
local auditOk, audit = pcall(cjson.decode, ARGV[5])
local resultOk, result = pcall(cjson.decode, ARGV[6])
if not decodedOk or type(item) ~= 'table' or tostring(item.code or '') ~= ARGV[2]
  or not auditOk or type(audit) ~= 'table'
  or not resultOk or type(result) ~= 'table' or result.ok ~= true then
  return cjson.encode({ok=false,error='storage_failed'})
end
local status = tostring(item.status or 'active')
if status == 'used' then
  return cjson.encode({ok=false,error='code_already_used'})
end

if ARGV[1] == 'void' and status == 'void' then
  return ARGV[7]
end
if ARGV[1] == 'void' and status ~= 'active' then
  return cjson.encode({ok=false,error='code_unavailable'})
end
if ARGV[1] == 'void' then
  local replacementOk,replacement = pcall(cjson.decode,ARGV[4])
  if not replacementOk or type(replacement)~='table' or tostring(replacement.code or '')~=ARGV[2]
    or tostring(replacement.status or '')~='void' then return cjson.encode({ok=false,error='storage_failed'}) end
  redis.call('SET', KEYS[1], ARGV[4])
else
  redis.call('DEL', KEYS[1])
  redis.call('LREM', KEYS[2], 0, ARGV[2])
end
redis.call('LPUSH', KEYS[3], ARGV[5])
redis.call('LTRIM', KEYS[3], 0, 499)
return ARGV[6]`;
  const keys = [redeemCodeKey(code), REDEEM_LIST_KEY, ADMIN_ACTION_LOG_KEY];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readRedisStringState(keys[0]);
    if (!state.ok) return { ok: false, error: "storage_failed" };
    if (!state.exists) {
      return action === "delete"
        ? { ok: true, deleted: true, idempotent: true, code }
        : { ok: false, error: "code_not_found" };
    }
    const raw = state.raw;
    let item;
    try { item = JSON.parse(raw); } catch { item = null; }
    if (!item || typeof item !== "object" || Array.isArray(item) || normalizeRedeemCode(item.code) !== code) {
      return { ok: false, error: "storage_failed" };
    }
    const status = String(item.status || "active");
    if (status === "used") return { ok: false, error: "code_already_used" };
    if (action === "void" && status === "void") return { ok: true, code: item, idempotent: true };
    if (action === "void" && status !== "active") return { ok: false, error: "code_unavailable" };
    const now = new Date();
    const audit = adminActionEntry("redeem_code_" + action, actorInfo, "redeem-code:" + code, {
      batchId: clean(item.batchId, 80),
      type: clean(item.type || item.kind || "balance", 40),
      amount: Number(item.amount || 0) || 0,
    }, now);
    const replacement = action === "void" ? replaceTopLevelJsonFields(raw, {
      status: "void",
      updatedAt: now.toISOString(),
      updatedAtBeijing: formatBeijingTime(now),
      voidedAt: now.toISOString(),
      voidedAtBeijing: formatBeijingTime(now),
      voidedByStaffId: Number(actorInfo.staffId || 1) || 1,
      voidedByStaffUsername: clean(actorInfo.staffUsername || "admin", 60),
    }) : "";
    if (action === "void" && !replacement) return { ok: false, error: "storage_failed" };
    const resultValue = action === "void"
      ? { ok: true, code: JSON.parse(replacement) }
      : { ok: true, deleted: true, code };
    const idempotentValue = action === "void"
      ? { ok: true, code: item, idempotent: true }
      : { ok: true, deleted: true, idempotent: true, code };
    const execution = await redisEvalAtomic(script, keys, [
      action,
      code,
      raw,
      replacement,
      JSON.stringify(audit),
      JSON.stringify(resultValue),
      JSON.stringify(idempotentValue),
    ]);
    if (execution.ok && execution.value?.ok === false && execution.value?.error === "code_conflict") continue;
    if (execution.ok && execution.value && typeof execution.value === "object" && !Array.isArray(execution.value) && typeof execution.value.ok === "boolean") return execution.value;
  }
  return { ok: false, error: "storage_failed" };
}

export async function updateRedeemCodeStatus(codeValue, status, actor = null) {
  if (status !== "void") return { ok: false, error: "invalid_status" };
  return mutateRedeemCodeAtomic(codeValue, "void", actor);
}

export async function deleteRedeemCode(codeValue, actor = null) {
  return mutateRedeemCodeAtomic(codeValue, "delete", actor);
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
  if (status !== "void") return { ok: false, error: "invalid_status" };
  return mutateRedeemBatchAtomic(batchId, "void", actor);
}

async function mutateRedeemBatchAtomic(batchId, action, actor = null) {
  const id = clean(batchId, 80);
  if (!id) return { ok: false, error: "batch_not_found" };
  if (action !== "void" && action !== "delete") return { ok: false, error: "invalid_action" };
  const batchState = await readRedisStringState(redeemBatchKey(id));
  if (!batchState.ok) return { ok: false, error: "storage_failed" };
  if (!batchState.exists) return { ok: false, error: "batch_not_found" };
  const batchRaw = batchState.raw;
  let batch = null;
  try { batch = JSON.parse(batchRaw); } catch (e) { return { ok: false, error: "storage_failed" }; }
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return { ok: false, error: "storage_failed" };
  const codes = Array.isArray(batch.codes)
    ? batch.codes.map((code) => normalizeRedeemCode(code)).filter(Boolean)
    : [];
  if (codes.length !== (Array.isArray(batch.codes) ? batch.codes.length : 0) || new Set(codes).size !== codes.length) {
    return { ok: false, error: "storage_failed" };
  }
  const actorInfo = adminActorFromSession(actor);
  const now = new Date();
  const nowIso = now.toISOString();
  const nowBeijing = formatBeijingTime(now);
  const absentCode = "__LM_REDEEM_CODE_ABSENT__";
  const codeRaws = await Promise.all(codes.map((code) => redisCmd(["GET", redeemCodeKey(code)])));
  const parsedCodes = codeRaws.map((raw) => {
    if (typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  });
  if (codeRaws.some((raw, index) => typeof raw === "string" && !parsedCodes[index])) {
    return { ok: false, error: "storage_failed" };
  }
  const replacements = codeRaws.map((raw, index) => {
    const item = parsedCodes[index];
    if (action !== "void" || typeof raw !== "string" || String(item?.status || "active") !== "active") return "";
    return replaceTopLevelJsonFields(raw, {
      status: "void",
      updatedAt: nowIso,
      updatedAtBeijing: nowBeijing,
      voidedAt: nowIso,
      voidedAtBeijing: nowBeijing,
      voidedByStaffId: Number(actorInfo.staffId || 1) || 1,
      voidedByStaffUsername: clean(actorInfo.staffUsername || "admin", 60),
    }) || "";
  });
  if (action === "void" && replacements.some((replacement, index) => parsedCodes[index]
    && String(parsedCodes[index].status || "active") === "active" && !replacement)) {
    return { ok: false, error: "storage_failed" };
  }
  const batchReplacement = action === "void" ? replaceTopLevelJsonFields(batchRaw, {
    status: "void",
    updatedAt: nowIso,
    updatedAtBeijing: nowBeijing,
    voidedAt: nowIso,
    voidedAtBeijing: nowBeijing,
    voidedByStaffId: Number(actorInfo.staffId || 1) || 1,
    voidedByStaffUsername: clean(actorInfo.staffUsername || "admin", 60),
  }) : "";
  if (action === "void" && !batchReplacement) return { ok: false, error: "storage_failed" };
  const audit = adminActionEntry("redeem_batch_" + action, actorInfo, "redeem-batch:" + id, {
    total: codes.length,
    changed: parsedCodes.filter((item) => item && String(item.status || "active") !== "used").length,
    deleted: action === "delete" ? parsedCodes.filter((item) => item && String(item.status || "active") !== "used").length : 0,
    preservedUsed: parsedCodes.filter((item) => item?.status === "used").length,
    type: clean(batch.type || batch.kind || "balance", 40),
    amount: Number(batch.amount || 0) || 0,
  }, now);
  // REDEEM_BATCH_MANAGEMENT_CAS_V1: the batch record is compared with the
  // exact snapshot used to declare KEYS, then every current code status is
  // evaluated in the same script. `used` records are always preserved.
  const script = `
local function keyType(key)
  local reply = redis.call('TYPE', key)
  return type(reply) == 'table' and reply.ok or reply
end

if keyType(KEYS[1]) == 'none' then
  return cjson.encode({ok=false,error='batch_not_found'})
elseif keyType(KEYS[1]) ~= 'string' then
  return cjson.encode({ok=false,error='storage_failed'})
end
local currentRaw = redis.call('GET', KEYS[1])
if currentRaw ~= ARGV[3] then
  return cjson.encode({ok=false,error='batch_conflict'})
end

local batchListType = keyType(KEYS[2])
local redeemListType = keyType(KEYS[3])
local auditType = keyType(KEYS[4])
if (batchListType ~= 'none' and batchListType ~= 'list')
  or (redeemListType ~= 'none' and redeemListType ~= 'list')
  or (auditType ~= 'none' and auditType ~= 'list') then
  return cjson.encode({ok=false,error='storage_failed'})
end

local batchOk, currentBatch = pcall(cjson.decode, currentRaw)
local codesOk, codes = pcall(cjson.decode, ARGV[15])
local expectedOk, expectedRaws = pcall(cjson.decode, ARGV[16])
local replacementsOk, replacementRaws = pcall(cjson.decode, ARGV[17])
if not batchOk or type(currentBatch) ~= 'table'
  or not codesOk or type(codes) ~= 'table' or #codes ~= (#KEYS - 4)
  or not expectedOk or type(expectedRaws) ~= 'table' or #expectedRaws ~= #codes
  or not replacementsOk or type(replacementRaws) ~= 'table' or #replacementRaws ~= #codes then
  return cjson.encode({ok=false,error='storage_failed'})
end

local updates = {}
local deletions = {}
local results = {}
local preservedUsed = {}
local changed = 0
for codeIndex = 1, #codes do
  local code = tostring(codes[codeIndex] or '')
  local recordType = keyType(KEYS[codeIndex + 4])
  if recordType == 'none' then
    if tostring(expectedRaws[codeIndex] or '') ~= '__LM_REDEEM_CODE_ABSENT__' then
      return cjson.encode({ok=false,error='batch_conflict'})
    end
    results[#results + 1] = {code=code,ok=false,skipped=true,reason='missing'}
  elseif recordType ~= 'string' then
    local responseOk,response=pcall(cjson.encode,{ok=false,error='storage_failed',code=code})
    if not responseOk then return redis.error_reply('json_encode_failed') end
    return response
  else
    local raw = redis.call('GET', KEYS[codeIndex + 4])
    local itemOk, item = pcall(cjson.decode, raw)
    if not itemOk or type(item) ~= 'table' or tostring(item.code or '') ~= code then
      local responseOk,response=pcall(cjson.encode,{ok=false,error='storage_failed',code=code})
      if not responseOk then return redis.error_reply('json_encode_failed') end
      return response
    end
    local status = tostring(item.status or 'active')
    if status == 'used' then
      preservedUsed[#preservedUsed + 1] = code
      results[#results + 1] = {code=code,ok=false,skipped=true,reason='used'}
    elseif raw ~= tostring(expectedRaws[codeIndex] or '') then
      return cjson.encode({ok=false,error='batch_conflict'})
    elseif ARGV[1] == 'delete' then
      deletions[#deletions + 1] = {key=KEYS[codeIndex + 4],code=code}
      changed = changed + 1
      results[#results + 1] = {code=code,ok=true}
    elseif ARGV[1] == 'void' and status == 'active' then
      local replacementRaw=tostring(replacementRaws[codeIndex] or '')
      local replacementOk,replacement=pcall(cjson.decode,replacementRaw)
      if not replacementOk or type(replacement)~='table' or tostring(replacement.code or '')~=code
        or tostring(replacement.status or '')~='void' then
        local responseOk,response=pcall(cjson.encode,{ok=false,error='storage_failed',code=code})
        if not responseOk then return redis.error_reply('json_encode_failed') end
        return response
      end
      updates[#updates + 1] = {key=KEYS[codeIndex + 4],value=replacementRaw}
      changed = changed + 1
      results[#results + 1] = {code=code,ok=true}
    elseif ARGV[1] == 'void' and status == 'void' then
      results[#results + 1] = {code=code,ok=true,skipped=true,reason='already_void'}
    else
      results[#results + 1] = {code=code,ok=false,skipped=true,reason='unavailable'}
    end
  end
end
if ARGV[1] ~= 'void' and ARGV[1] ~= 'delete' then
  return cjson.encode({ok=false,error='invalid_action'})
end

local result = nil
local encodedBatch = nil
if ARGV[1] == 'void' then
  local wasVoid = tostring(currentBatch.status or '') == 'void'
  local nextBatchOk,nextBatch=pcall(cjson.decode,ARGV[18])
  if not nextBatchOk or type(nextBatch)~='table' or tostring(nextBatch.id or '')~=ARGV[2]
    or tostring(nextBatch.status or '')~='void' then return cjson.encode({ok=false,error='storage_failed'}) end
  encodedBatch = ARGV[18]
  result = {ok=true,batch=nextBatch,results=results,changedCount=changed,preservedUsed=preservedUsed}
  if wasVoid and changed == 0 then result.idempotent = true end
else
  result = {ok=true,deletedCount=changed,deletedCodes={},preservedUsed=preservedUsed,results=results}
  for deletionIndex = 1, #deletions do
    result.deletedCodes[#result.deletedCodes + 1] = deletions[deletionIndex].code
  end
end

local resultEncodedOk, encodedResult = pcall(cjson.encode, result)
if not resultEncodedOk then
  return cjson.encode({ok=false,error='storage_failed'})
end

if result.idempotent == true then return encodedResult end
local deletedForAudit=0
if ARGV[1]=='delete' then deletedForAudit=changed end
local auditRecord={
  id=ARGV[6],
  action=ARGV[7],
  target=ARGV[8],
  detail={
    total=#codes,
    changed=changed,
    deleted=deletedForAudit,
    preservedUsed=#preservedUsed,
    type=ARGV[9],
    amount=tonumber(ARGV[10]) or 0
  },
  staffId=tonumber(ARGV[11]) or 1,
  staffUsername=ARGV[12],
  createdAt=ARGV[13],
  createdAtBeijing=ARGV[14]
}
local auditEncodedOk,auditEncoded=pcall(cjson.encode,auditRecord)
if not auditEncodedOk then return redis.error_reply('json_encode_failed') end
if ARGV[1] == 'void' then
  for updateIndex = 1, #updates do
    redis.call('SET', updates[updateIndex].key, updates[updateIndex].value)
  end
  redis.call('SET', KEYS[1], encodedBatch)
else
  for deletionIndex = 1, #deletions do
    redis.call('DEL', deletions[deletionIndex].key)
    redis.call('LREM', KEYS[3], 0, deletions[deletionIndex].code)
  end
  redis.call('DEL', KEYS[1])
  redis.call('LREM', KEYS[2], 0, ARGV[2])
end
redis.call('LPUSH', KEYS[4], auditEncoded)
redis.call('LTRIM', KEYS[4], 0, 499)
return encodedResult`;
  const keys = [
    redeemBatchKey(id),
    REDEEM_BATCH_LIST_KEY,
    REDEEM_LIST_KEY,
    ADMIN_ACTION_LOG_KEY,
    ...codes.map((code) => redeemCodeKey(code)),
  ];
  const args = [
    action,
    id,
    batchRaw,
    nowIso,
    nowBeijing,
    audit.id,
    audit.action,
    audit.target,
    clean(audit.detail?.type, 40),
    String(Number(audit.detail?.amount || 0) || 0),
    String(Number(audit.staffId || 1) || 1),
    clean(audit.staffUsername || "admin", 60),
    audit.createdAt,
    audit.createdAtBeijing,
    JSON.stringify(codes),
    JSON.stringify(codeRaws.map((raw) => typeof raw === "string" ? raw : absentCode)),
    JSON.stringify(replacements),
    batchReplacement,
  ];
  let execution = await redisEvalAtomic(script, keys, args);
  if (!execution.ok) {
    execution = await redisEvalAtomic(script, keys, args);
    if (execution.ok && execution.value?.ok === false && action === "delete" && execution.value?.error === "batch_not_found") {
      return {
        ok: true,
        deletedCount: 0,
        deletedCodes: [],
        preservedUsed: [],
        results: [],
        idempotent: true,
        recovered: true,
      };
    }
    if (execution.ok && execution.value?.ok === false && action === "void" && execution.value?.error === "batch_conflict") {
      const recoveredRaw = await redisCmd(["GET", redeemBatchKey(id)]);
      try {
        const recoveredBatch = JSON.parse(recoveredRaw);
        if (recoveredBatch?.status === "void") {
          return { ok: true, batch: recoveredBatch, results: [], idempotent: true, recovered: true };
        }
      } catch (e) {}
    }
  }
  return execution.ok && execution.value && typeof execution.value === "object" && !Array.isArray(execution.value) && typeof execution.value.ok === "boolean" ? execution.value : { ok: false, error: "storage_failed" };
}

export async function deleteRedeemBatch(batchId, actor = null) {
  return mutateRedeemBatchAtomic(batchId, "delete", actor);
}

export async function redeemCodeForUser(email, codeValue, meta = {}, options = {}) {
  return redeemBalanceCodeAtomic(email, codeValue, meta, options);
}

export async function validateServiceRedeemCode(codeValue, orderServices) {
  const code = normalizeRedeemCode(codeValue);
  const item = await getJsonKey(redeemCodeKey(code));
  if (!item) return { ok: false, error: "code_not_found" };
  if (item.status !== "active") return { ok: false, error: "code_unavailable" };
  if (redeemCodeType(item) !== "service") return { ok: false, error: "not_service_code" };
  const codeServices = normalizeRedeemServices(item.services || []);
  const rawSubmitted = Array.isArray(orderServices) ? orderServices : [];
  const submitted = normalizeRedeemServices(rawSubmitted);
  // Service codes describe one entitlement per service/plan. The normalizer
  // deliberately de-duplicates catalog input, so compare lengths as well to
  // prevent a direct API caller from buying duplicate items with one code.
  if (submitted.length !== rawSubmitted.length || codeServices.length === 0 || !servicesEqual(codeServices, submitted)) {
    return { ok: false, error: "service_mismatch", services: serviceSummaries(codeServices) };
  }
  return { ok: true, code, item: { ...item, type: "service", services: serviceSummaries(codeServices) } };
}

export async function consumeServiceRedeemCode(codeValue, email, orderId, meta = {}, options = {}) {
  return consumeServiceCodeAtomic(codeValue, email, orderId, meta, options);
}

export async function restoreServiceRedeemCode(codeValue, orderId) {
  const restored = await restoreServiceCodeAtomic(codeValue, orderId);
  return Boolean(restored.ok);
}

export async function createWithdrawal(email, amount, alipayAccount, realName, options = {}) {
  return createWithdrawalAtomic(email, amount, alipayAccount, realName, options);
}

export async function listWithdrawals() {
  const ids = await redisCmd(["LRANGE", WITHDRAWAL_LIST_KEY, "0", "-1"]);
  if (!Array.isArray(ids)) return [];
  const unique = Array.from(new Set(ids));
  const items = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batchIds = unique.slice(offset, offset + 100);
    const response = await redisPipeline(batchIds.map((id) => ["GET", withdrawalKey(id)]));
    const rows = pipelineResults(response);
    if (rows.length !== batchIds.length || rows.some((row) => row?.error)) {
      throw new Error("withdrawal_record_batch_unavailable");
    }
    for (const row of rows) {
      const raw = pipelineResultValue(row);
      if (!raw) throw new Error("withdrawal_record_invalid");
      try {
        const item = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("withdrawal_record_invalid");
        items.push(item);
      } catch (error) {
        throw new Error("withdrawal_record_invalid");
      }
    }
  }
  return items;
}

export async function deleteWithdrawals(ids, actor = null, options = {}) {
  const idSet = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => clean(id, 120))
    .filter(Boolean)
    .slice(0, 200));
  if (idSet.size === 0) return { ok: false, error: "no_ids" };

  const archivedIds = Array.from(idSet).sort();
  const now = new Date();
  const archivedAt = now.toISOString();
  const archiveActor = adminActorFromSession(actor);
  const rawOperationId = String(options?.operationId || "").trim();
  if (rawOperationId && !validAdminOperationId(rawOperationId)) {
    return { ok: false, error: "invalid_idempotency_key" };
  }
  const requestHash = idempotencyPayloadHash({ ids: archivedIds });
  // A retry may be resumed by another authorised root session. Keep the
  // durable identity on the archive domain while the first actor is retained
  // in the archived records and audit entry written by the atomic script.
  const operationKey = rawOperationId
    ? durableAdminOperationKey("withdrawal-archive", rawOperationId)
    : durableAdminOperationKey("withdrawal-archive-target", requestHash);
  const priorOperation = await recoverDurableAdminOperation(operationKey, requestHash);
  if (priorOperation) {
    return priorOperation.ok === true ? priorOperation : {
      ok: false,
      error: clean(priorOperation.error, 80) || "storage_failed",
      id: clean(priorOperation.id, 120),
      status: clean(priorOperation.status, 40),
    };
  }
  const resultValue = {
    ok: true,
    archivedCount: archivedIds.length,
    // Keep the legacy response field while the admin UI still calls this a
    // delete action. The records themselves remain as archived evidence.
    deletedCount: archivedIds.length,
    archivedIds,
  };
  const operationRecord = {
    version: 1,
    requestHash,
    resultJson: JSON.stringify(resultValue),
    retryResultJson: JSON.stringify({ ...resultValue, idempotent: true, recovered: true }),
  };
  const audit = adminActionEntry(
    "withdrawal_archive",
    archiveActor,
    "withdrawals:" + archivedIds.length,
    { ids: archivedIds, archivedCount: archivedIds.length },
    now,
  );
  const withdrawalRaws = await Promise.all(archivedIds.map((id) => redisCmd(["GET", withdrawalKey(id)])));
  const withdrawalReplacements = withdrawalRaws.map((raw) => {
    if (typeof raw !== "string") return "";
    let withdrawal;
    try { withdrawal = JSON.parse(raw); } catch { return null; }
    if (!withdrawal || typeof withdrawal !== "object" || Array.isArray(withdrawal)) return null;
    if (withdrawal.archived === true) return "";
    const revision = Number(withdrawal.revision || 0);
    if (!Number.isSafeInteger(revision) || revision < 0 || !["success", "failed"].includes(String(withdrawal.status || ""))) {
      return "";
    }
    return replaceTopLevelJsonFields(raw, {
      archived: true,
      archivedAt,
      actor: archiveActor,
      revision: revision + 1,
    });
  });
  const invalidWithdrawalIndex = withdrawalReplacements.findIndex((replacement) => replacement === null);
  if (invalidWithdrawalIndex >= 0) {
    return { ok: false, error: "storage_failed", id: archivedIds[invalidWithdrawalIndex] };
  }
  // WITHDRAWAL_ARCHIVE_DURABLE_V2: validate and pre-encode every record before
  // the first write, then atomically commit records, index removals, audit, and
  // the permanent operation result. An existing operation result is returned
  // before touching business keys; an already-achieved complete target state
  // also recreates the operation record and succeeds idempotently.
  const archiveScript = `
local function keyType(key)
  local reply = redis.call('TYPE', key)
  return type(reply) == 'table' and reply.ok or reply
end
local function response(value)
  local ok,encoded=pcall(cjson.encode,value)
  if not ok then return redis.error_reply('withdrawal_archive_response_encode_failed') end
  return encoded
end

local opType = keyType(KEYS[1])
if opType == 'string' then
  local opRaw = redis.call('GET', KEYS[1])
  local opOk, existing = pcall(cjson.decode, opRaw)
  if not opOk or type(existing) ~= 'table' or type(existing.retryResultJson) ~= 'string' then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  if tostring(existing.requestHash or '') ~= ARGV[1] then
    return cjson.encode({ok=false,error='idempotency_conflict'})
  end
  local resultOk, storedResult = pcall(cjson.decode, existing.retryResultJson)
  if not resultOk or type(storedResult) ~= 'table' or storedResult.ok ~= true then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  return existing.retryResultJson
elseif opType ~= 'none' then
  return cjson.encode({ok=false,error='storage_failed'})
end

local actorOk, archiveActor = pcall(cjson.decode, ARGV[3])
local idsOk, ids = pcall(cjson.decode, ARGV[4])
local resultOk, result = pcall(cjson.decode, ARGV[5])
local operationOk, operation = pcall(cjson.decode, ARGV[6])
local auditOk, audit = pcall(cjson.decode, ARGV[7])
local expectedOk, expectedRaws = pcall(cjson.decode, ARGV[8])
local replacementsOk, replacementRaws = pcall(cjson.decode, ARGV[9])
if not actorOk or type(archiveActor) ~= 'table'
  or not idsOk or type(ids) ~= 'table' or #ids ~= (#KEYS - 3)
  or not resultOk or type(result) ~= 'table' or result.ok ~= true
  or not operationOk or type(operation) ~= 'table' or tostring(operation.requestHash or '') ~= ARGV[1]
    or type(operation.resultJson) ~= 'string' or type(operation.retryResultJson) ~= 'string'
  or not auditOk or type(audit) ~= 'table'
  or not expectedOk or type(expectedRaws) ~= 'table' or #expectedRaws ~= #ids
  or not replacementsOk or type(replacementRaws) ~= 'table' or #replacementRaws ~= #ids then
  return cjson.encode({ok=false,error='storage_failed'})
end

local replacements = {}
local resultIds = {}
local archivedCount = 0
local firstArchivedId = ''
for recordIndex = 1, #ids do
  local id = tostring(ids[recordIndex] or '')
  local recordKey = KEYS[recordIndex + 3]
  local recordType = keyType(recordKey)
  if recordType == 'none' then
    return response({ok=false,error='withdrawal_not_found',id=id})
  end
  if recordType ~= 'string' then
    return response({ok=false,error='storage_failed',id=id})
  end

  local raw = redis.call('GET', recordKey)
  local decodeOk, withdrawal = pcall(cjson.decode, raw)
  if not decodeOk or type(withdrawal) ~= 'table' then
    return response({ok=false,error='storage_failed',id=id})
  end
  if withdrawal.archived == true then
    archivedCount = archivedCount + 1
    if firstArchivedId == '' then firstArchivedId = id end
  else
    if raw ~= tostring(expectedRaws[recordIndex] or '') then
      return response({ok=false,error='withdrawal_conflict',id=id})
    end
    local status = tostring(withdrawal.status or '')
    if status ~= 'success' and status ~= 'failed' then
      return response({ok=false,error='withdrawal_active',id=id,status=status})
    end
    local revision = tonumber(withdrawal.revision or 0)
    if not revision or revision < 0 or revision ~= math.floor(revision) or revision > 9007199254740990 then
      return response({ok=false,error='storage_failed',id=id})
    end
    local replacementRaw=tostring(replacementRaws[recordIndex] or '')
    local replacementOk,replacement=pcall(cjson.decode,replacementRaw)
    if not replacementOk or type(replacement)~='table' or tostring(replacement.id or '')~=id
      or replacement.archived~=true
      or tonumber(replacement.revision)~=revision+1 then
      return response({ok=false,error='storage_failed',id=id})
    end
    replacements[#replacements + 1] = recordKey
    replacements[#replacements + 1] = replacementRaw
    resultIds[#resultIds + 1] = id
  end
end

if archivedCount == #ids then
  local retryOk, retryResult = pcall(cjson.decode, operation.retryResultJson)
  if not retryOk or type(retryResult) ~= 'table' or retryResult.ok ~= true then
    return cjson.encode({ok=false,error='storage_failed'})
  end
  redis.call('SET', KEYS[1], ARGV[6])
  return operation.retryResultJson
elseif archivedCount > 0 then
  return response({ok=false,error='withdrawal_already_archived',id=firstArchivedId})
end

local listType = keyType(KEYS[2])
local auditType = keyType(KEYS[3])
if listType ~= 'list' then
  if listType == 'none' then
    return response({ok=false,error='withdrawal_not_indexed',id=tostring(ids[1] or '')})
  end
  return cjson.encode({ok=false,error='storage_failed'})
end
if auditType ~= 'none' and auditType ~= 'list' then
  return cjson.encode({ok=false,error='storage_failed'})
end

local indexed = {}
local currentIds = redis.call('LRANGE', KEYS[2], 0, -1)
for _, currentId in ipairs(currentIds) do indexed[tostring(currentId)] = true end
for idIndex = 1, #ids do
  local id = tostring(ids[idIndex] or '')
  if not indexed[id] then
    return response({ok=false,error='withdrawal_not_indexed',id=id})
  end
end

redis.call('MSET', unpack(replacements))
for idIndex = 1, #resultIds do
  redis.call('LREM', KEYS[2], 0, resultIds[idIndex])
end
redis.call('LPUSH', KEYS[3], ARGV[7])
redis.call('LTRIM', KEYS[3], 0, 499)
redis.call('SET', KEYS[1], ARGV[6])
return ARGV[5]`;

  const execution = await redisEvalAtomic(
    archiveScript,
    [
      operationKey,
      WITHDRAWAL_LIST_KEY,
      ADMIN_ACTION_LOG_KEY,
      ...archivedIds.map((id) => withdrawalKey(id)),
    ],
    [
      requestHash,
      archivedAt,
      JSON.stringify(archiveActor),
      JSON.stringify(archivedIds),
      JSON.stringify(resultValue),
      JSON.stringify(operationRecord),
      JSON.stringify(audit),
      JSON.stringify(withdrawalRaws.map((raw) => typeof raw === "string" ? raw : "__LM_WITHDRAWAL_ABSENT__")),
      JSON.stringify(withdrawalReplacements),
    ],
  );
  let result = execution.ok && execution.value && typeof execution.value === "object" && !Array.isArray(execution.value) && typeof execution.value.ok === "boolean" ? execution.value : null;
  if (!result) result = await recoverDurableAdminOperation(operationKey, requestHash);
  if (!result) return { ok: false, error: "storage_failed" };
  if (result.ok !== true) {
    return {
      ok: false,
      error: clean(result.error, 80) || "storage_failed",
      id: clean(result.id, 120),
      status: clean(result.status, 40),
    };
  }
  return result;
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

export async function updateWithdrawalStatus(id, status, note = "", actor = null, options = {}) {
  return transitionWithdrawalAtomic(id, status, note, actor, options);
}
