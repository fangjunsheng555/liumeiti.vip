// Shared backend utilities: redis, password hashing, session signing

import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_AVATAR_IDS, isUserAvatarId, normalizeUserAvatarId } from "../lib/avatars.js";

export const ORDERS_KEY = "liumeiti:orders";
export const ORDER_INDEX_KEY = ORDERS_KEY + ":index";
export const ORDER_RECORD_PREFIX = ORDERS_KEY + ":record:";
export const ORDER_EMAIL_INDEX_PREFIX = ORDERS_KEY + ":email:";
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
  const legacy = (await getAllOrders())
    .filter((order) => (order.email || "").toLowerCase() === lower || (order.userEmail || "").toLowerCase() === lower)
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

// Update an order at a specific handle. New records update by orderId; legacy
// records also keep their old list slot in sync while being promoted to a record.
export async function setOrderAt(index, order) {
  const r = redisConfig();
  if (!r) return false;
  const handle = typeof index === "object" && index !== null ? index : { legacyIndex: index, orderId: order?.orderId };
  const orderId = normalizeOrderIdForStorage(handle.orderId || order?.orderId);
  if (orderId) {
    const commands = [["SET", orderRecordKey(orderId), JSON.stringify(order)]];
    if (Number.isInteger(handle.legacyIndex) && handle.legacyIndex >= 0) {
      commands.push(["LSET", ORDERS_KEY, String(handle.legacyIndex), JSON.stringify(order)]);
    }
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
  return setOrderAt(index, {
    deleted: true,
    orderId,
    deletedAt: now.toISOString(),
    deletedAtBeijing: formatBeijingTime(now),
    ...meta,
  });
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

export function adminPermissionProfile(session) {
  const role = adminRoleFromSession(session);
  const root = role === "owner";
  const operator = role === "operator";
  const support = role === "support";
  const finance = role === "finance";
  return {
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

function paymentQuoteSecret() {
  return process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti-payment-quote-local";
}

export function signPaymentQuote(payload) {
  const data = Buffer.from(JSON.stringify(payload || {})).toString("base64url");
  const sig = createHmac("sha256", paymentQuoteSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyPaymentQuote(token) {
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
    const adjustment = roundMoney(payload.paymentAdjustment);
    if (Math.abs(adjustment) < 0.01 || Math.abs(adjustment) > 0.49) return null;
    return { ...payload, paymentAdjustment: adjustment };
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

// Send a generic email via configured SMTP. Returns {ok, ...}
// Retries once on transient failures (iCloud sometimes throttles connections).
export async function sendSimpleEmail({ to, subject, text, html, fromName }) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  const brandName = fromName || process.env.BRAND_NAME || "冒央会社";
  if (!host || !user || !pass || !from || !to) {
    return { ok: false, reason: "smtp_or_to_missing" };
  }
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch (e) { return { ok: false, reason: "nodemailer_import_failed" }; }
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = port === 465;

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
        from: `"${brandName}" <${from}>`,
        to, subject, text, html,
        priority: "high",
      });
      try { transporter.close(); } catch (e) {}
      return { ok: true, messageId: info.messageId, attempt };
    } catch (e) {
      try { transporter.close(); } catch (er) {}
      return { ok: false, error: e.message, code: e.code, response: e.response, attempt };
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
  return { ok: false, reason: "send_failed_after_retry", error: r2.error, code: r2.code };
}

// ── Account extensions: coupons, transfers, redeem codes, withdrawals ──
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
const AI_STOCK_KEY_PREFIX = "liumeiti:stock:ai:";
function aiStockKey(planId) { return AI_STOCK_KEY_PREFIX + clean(planId, 40); }

// 返回 { planId: number|null }，null = 未配置/不限
export async function getAiStockMap() {
  const map = {};
  await Promise.all(AI_STOCK_PLAN_IDS.map(async (id) => {
    const raw = await redisCmd(["GET", aiStockKey(id)]);
    map[id] = raw == null ? null : Math.max(0, Math.floor(Number(raw) || 0));
  }));
  return map;
}

// 返回 { planId: boolean } —— 仅当受限且剩余<=0 时为售罄
export async function getAiSoldOutMap() {
  const stock = await getAiStockMap();
  const out = {};
  AI_STOCK_PLAN_IDS.forEach((id) => { out[id] = stock[id] != null && stock[id] <= 0; });
  return out;
}

// value: 空字符串/null → 删除键（不限）；整数 ≥0 → 设为该值
export async function setAiStock(planId, value) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return false;
  if (value === "" || value == null) {
    await redisCmd(["DEL", aiStockKey(planId)]);
    return true;
  }
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return false;
  await redisCmd(["SET", aiStockKey(planId), String(n)]);
  return true;
}

// 原子占用一个库存：未配置/Redis 不可用 → 放行（与全站 fail-soft 一致）；售罄 → 回滚并拒绝
export async function reserveAiStock(planId) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return { ok: true, unlimited: true };
  const key = aiStockKey(planId);
  const cur = await redisCmd(["GET", key]);
  if (cur == null) return { ok: true, unlimited: true };
  const next = await redisCmd(["DECRBY", key, "1"]);
  if (next == null) return { ok: true, unlimited: true };
  if (Number(next) < 0) {
    await redisCmd(["INCRBY", key, "1"]);
    return { ok: false, soldOut: true, remaining: 0 };
  }
  return { ok: true, remaining: Number(next) };
}

// 返还一个库存（仅对受限规格生效）
export async function restoreAiStock(planId) {
  if (!AI_STOCK_PLAN_IDS.includes(planId)) return false;
  const key = aiStockKey(planId);
  const cur = await redisCmd(["GET", key]);
  if (cur == null) return false;
  await redisCmd(["INCRBY", key, "1"]);
  return true;
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
  if (!order || order.refundedAt) return { ok: true, skipped: "already_refunded", balance: 0, coupon: false, redeem: false };
  const now = new Date();
  const email = String(order.userEmail || "").trim().toLowerCase();
  const out = { balance: 0, coupon: false, redeem: false };

  // 1) 余额支付 → 退回余额
  if (order.paidByBalance && validEmail(email)) {
    const amount = roundMoney(order.finalAmount || 0);
    if (amount > 0) {
      const user = await getUser(email);
      const txs = await getBalanceTxs(email);
      const already = txs.some((tx) => tx?.source === "order_refund" && tx?.orderId === order.orderId);
      if (user && !already) {
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

  // 3) 兑换码支付 → 恢复为可用
  if (order.paymentMethod === "redeem" && order.redeemCode) {
    out.redeem = Boolean(await restoreServiceRedeemCode(order.redeemCode, order.orderId));
  }

  order.refundedAt = now.toISOString();
  order.refundedAtBeijing = formatBeijingTime(now);
  order.refund = out;
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
    return { ok: true, staff: { id: Number(staff.id), username: staff.username, role: staff.role || "operator", remark: staff.remark || "", root: false } };
  }

  return { ok: false, error: "invalid_credentials" };
}

export async function listAdminStaff() {
  const records = await adminStaffRecords();
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
    },
    ...records.map((item) => ({
      id: Number(item.id),
      username: item.username || "",
      role: item.role || "operator",
      roleLabel: item.role === "support" ? "客服" : item.role === "finance" ? "财务" : "运营",
      permissions: adminPermissionProfile({ staffId: Number(item.id), staffRole: item.role || "operator" }),
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

export async function getAdminMailLog() {
  const rows = await redisCmd(["LRANGE", ADMIN_MAIL_LOG_KEY, "0", "499"]);
  if (!Array.isArray(rows)) return [];
  return rows.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
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
