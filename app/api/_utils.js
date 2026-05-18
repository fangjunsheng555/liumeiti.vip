// Shared backend utilities: redis, password hashing, session signing

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ORDERS_KEY = "liumeiti:orders";
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

// Read all orders (max 200, filtering tombstoned/deleted entries)
export async function getAllOrders() {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/lrange/" + encodeURIComponent(ORDERS_KEY) + "/0/199", {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    if (!res.ok || data.error) return [];
    return Array.isArray(data.result)
      ? data.result
          .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
          .filter((o) => o && !o.deleted)
      : [];
  } catch (e) { return []; }
}

// Read raw entries with their original index (used for delete-by-index that
// still wants to skip already-deleted tombstones).
export async function getAllOrdersWithIndex() {
  const r = redisConfig();
  if (!r) return [];
  try {
    const res = await fetch(r.url + "/lrange/" + encodeURIComponent(ORDERS_KEY) + "/0/199", {
      headers: { Authorization: "Bearer " + r.token },
    });
    const data = await res.json();
    if (!res.ok || data.error) return [];
    if (!Array.isArray(data.result)) return [];
    return data.result.map((s, i) => {
      let parsed = null;
      try { parsed = JSON.parse(s); } catch (e) {}
      return { index: i, raw: s, order: parsed };
    });
  } catch (e) { return []; }
}

// Update an order at a specific index (LSET)
export async function setOrderAt(index, order) {
  const r = redisConfig();
  if (!r) return false;
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
// LTRIM keeps the list capped at 200 newest, so tombstones eventually fall off.
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
function authSecret() {
  return process.env.AUTH_SECRET || "dev-secret-change-me-in-production-please";
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

// Cookie helpers
export function getCookieFromRequest(request, name) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCookieValue(name, value, maxAgeSec = 60 * 60 * 24 * 14) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookieValue(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function adminSessionFromRequest(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

export function adminActorFromSession(session) {
  return {
    staffId: Number(session?.staffId || 1),
    staffUsername: clean(session?.staffUsername || session?.username || "admin", 60),
  };
}

export function adminActorFromRequest(request) {
  return adminActorFromSession(adminSessionFromRequest(request));
}

export function isRootAdminSession(session) {
  return Number(session?.staffId || 0) === 1;
}

export function adminActorLabel(actor) {
  const id = Number(actor?.staffId || 1);
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
  spotify: { label: "Spotify", amount: 128 },
  netflix: { label: "Netflix", amount: 168 },
  disney: { label: "Disney+", amount: 108 },
  max: { label: "HBO Max", amount: 148 },
  rocket: { label: "机场节点", amount: 98, hasPlan: true },
};

export const ROCKET_PLANS = {
  single: { id: "single", label: "单人畅享", amount: 98 },
  unlimited: { id: "unlimited", label: "无限使用", amount: 188 },
};
export const DEFAULT_ROCKET_PLAN = "single";

function resolveRocketPlanInternal(value) {
  const id = clean(value, 20);
  return ROCKET_PLANS[id] ? ROCKET_PLANS[id] : ROCKET_PLANS[DEFAULT_ROCKET_PLAN];
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
  return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

export function normalizeRedeemCode(value) {
  return clean(value, 80).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const REDEEM_GUARD_LIMIT = 5;
const REDEEM_GUARD_WINDOW_SECONDS = 5 * 60;

function clientGuardFingerprint(request) {
  const forwarded = request?.headers?.get("x-forwarded-for") || "";
  const ip = clean(forwarded.split(",")[0] || request?.headers?.get("x-real-ip") || "unknown", 80);
  const ua = clean(request?.headers?.get("user-agent") || "unknown", 160);
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "liumeiti";
  return createHmac("sha256", secret).update(`${ip}|${ua}`).digest("hex").slice(0, 32);
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
      entryPlan = resolveRocketPlanInternal(plan).id;
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
      const planInfo = resolveRocketPlanInternal(plan);
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

export async function ensureOAuthUser({ email, provider, providerId, username }) {
  const lower = String(email || "").trim().toLowerCase();
  if (!validEmail(lower)) return { ok: false, error: "invalid_email" };
  const now = new Date();
  const existing = await getUser(lower);
  if (existing) {
    if (existing.banned) return { ok: false, error: "account_banned" };
    const social = { ...(existing.social || {}) };
    if (provider && providerId) social[provider] = providerId;
    const next = {
      ...existing,
      username: existing.username || clean(username, 40) || generateRandomUsername(),
      balance: typeof existing.balance === "number" ? existing.balance : 0,
      social,
      updatedAt: now.toISOString(),
    };
    await setUser(lower, next);
    await registerUserEmail(lower);
    return { ok: true, user: next, isNew: false };
  }
  const user = attachRegisterCoupon({
    email: lower,
    username: clean(username, 40) || generateRandomUsername(),
    balance: 0,
    social: provider && providerId ? { [provider]: providerId } : {},
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  }, now);
  const saved = await setUser(lower, user);
  await registerUserEmail(lower);
  if (!saved) return { ok: false, error: "storage_failed" };
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
    return { ok: true, staff: { id: 1, username: envUsername, root: true } };
  }

  const records = await adminStaffRecords();
  const staff = records.find((item) =>
    item && item.active !== false && String(item.username || "").toLowerCase() === inputUsername.toLowerCase()
  );
  if (staff && verifyPassword(password, staff.passwordHash)) {
    return { ok: true, staff: { id: Number(staff.id), username: staff.username, remark: staff.remark || "", root: false } };
  }

  return { ok: false, error: "invalid_credentials" };
}

export async function listAdminStaff() {
  const records = await adminStaffRecords();
  return [
    {
      id: 1,
      username: envAdminUsername(),
      root: true,
      active: Boolean(process.env.ADMIN_PASSWORD),
      createdAtBeijing: "环境变量主账号",
      remark: "主账号",
    },
    ...records.map((item) => ({
      id: Number(item.id),
      username: item.username || "",
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
    detail: { username },
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
  const rows = await redisCmd(["LRANGE", ADMIN_ACTION_LOG_KEY, "0", "199"]);
  if (!Array.isArray(rows)) return [];
  return rows.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
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
  const r = redisConfig();
  if (!r) return { ok: false, error: "storage_failed" };
  const commands = [
    ...codes.flatMap((code) => [
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
      detail: { total: codes.length, type: redeemCodeType(batch), amount: batch.amount || 0 },
    });
    return { ok: res.ok };
  } catch (e) { return { ok: false, error: "delete_failed" }; }
}

export async function redeemCodeForUser(email, codeValue) {
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

export async function consumeServiceRedeemCode(codeValue, email, orderId) {
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
