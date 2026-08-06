import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  checkIdentityRateLimit,
  clean,
  clientIpFromRequest,
  formatBeijingTime,
  getOrderEntryById,
  getUsdtRate,
  pushAdminActionLog,
  rateLimitResponse,
  redisCmd,
  sendSimpleEmail,
  setOrderAt,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { expireQuoteOrderEntry, normalizeQuoteOrderId } from "../../_quote-expiry.js";
import { buildProxyOrderEmail } from "../_email.js";
import { deliverOnce } from "../../_delivery-once.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../_money.js";
import { claimDurableOperation, completeDurableOperation } from "../../_durable-operation.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const ORDER_UPDATE_LOCK_PREFIX = "lm:order:update-lock:";
const RELEASE_LOCK_SCRIPT = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

function normalizeOrderId(value) {
  return normalizeQuoteOrderId(value);
}

function orderUpdateLockKey(orderId) {
  return ORDER_UPDATE_LOCK_PREFIX + normalizeOrderId(orderId);
}

async function acquireOrderUpdateLock(orderId) {
  const token = randomBytes(18).toString("hex");
  const key = orderUpdateLockKey(orderId);
  const locked = await redisCmd(["SET", key, token, "NX", "EX", "120"]);
  return locked === "OK" ? { key, token } : null;
}

async function releaseOrderUpdateLock(lock) {
  await redisCmd(["EVAL", RELEASE_LOCK_SCRIPT, "1", lock.key, lock.token]);
}

function hashToken(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function tokenMatches(order, token) {
  const expected = String(order?.quotePaymentTokenHash || "");
  const actual = hashToken(token);
  if (!expected || expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  } catch {
    return false;
  }
}

async function findOrder(orderId) {
  const entry = await getOrderEntryById(orderId);
  return entry?.order && !entry.order.deleted ? entry : null;
}

function publicQuoteOrder(order) {
  return {
    orderId: order.orderId,
    revision: Number(order.revision || 0),
    status: order.status,
    locale: order.locale === "en" ? "en" : "zh",
    email: String(order.email || "").replace(/^(.{1,2}).*(@.*)$/, "$1***$2"),
    platformUrl: order.platformUrl || order.items?.[0]?.platformUrl || "",
    productPrice: order.productPrice || order.items?.[0]?.productPrice || "",
    quoteAmount: Number(order.quoteAmount || order.finalAmount || 0),
    paymentMethod: order.paymentMethod || "quote",
    paidCurrency: order.paidCurrency || "CNY",
    paidAmount: Number(order.paidAmount || 0),
    quotedAtBeijing: order.quotedAtBeijing || "",
    quoteExpiresAt: order.quoteExpiresAt || "",
    quoteExpiresAtBeijing: order.quoteExpiresAtBeijing || "",
    quoteValidDays: Number(order.quoteValidDays || 7),
    paymentSubmittedAtBeijing: order.paymentSubmittedAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
  };
}

function paidNotice(order) {
  return [
    `💳 代付订单已提交付款 ${order.orderId}`,
    "━━━━━━━━━━━━━━━━",
    `报价金额: ¥${Number(order.quoteAmount || 0).toFixed(2)}`,
    `平台: ${order.platformUrl}`,
    `邮箱: ${order.email}`,
    `时间: ${order.paymentSubmittedAtBeijing}`,
    "状态: 订单已收到，等待核对",
  ].join("\n");
}

async function sendTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
  });
  if (response.ok) return true;
  return response.status >= 500 || response.status === 408 || response.status === 425
    ? { ok: false, uncertain: true, error: `telegram_http_${response.status}` }
    : { ok: false, retryable: true, error: `telegram_http_${response.status}` };
}

async function sendWebhook(order, idempotencyKey = "") {
  if (!process.env.ORDER_WEBHOOK_URL) return null;
  const response = await fetch(process.env.ORDER_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(order),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
  });
  if (response.ok) return true;
  return response.status >= 500 || response.status === 408 || response.status === 425
    ? { ok: false, uncertain: true, error: `webhook_http_${response.status}` }
    : { ok: false, retryable: true, error: `webhook_http_${response.status}` };
}

async function deliverQuotePaymentNotifications(order, knownSettings = null) {
  const settings = knownSettings || await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const emailContent = buildProxyOrderEmail({
    kind: "payment_received",
    order,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    locale: order.locale,
    support: settings.support,
  });
  const prefix = `quote-payment-received:${order.orderId}:${order.paymentSubmittedAt || order.revision}`;
  const attempts = await Promise.all([
    deliverOnce(`${prefix}:telegram`, () => settings.notify.telegramEnabled ? sendTelegram(paidNotice(order)) : null)
      .then((result) => ({ channel: "telegram", ...result })),
    deliverOnce(`${prefix}:webhook`, (key) => sendWebhook(order, key))
      .then((result) => ({ channel: "webhook", ...result })),
    deliverOnce(`${prefix}:email`, () => sendSimpleEmail({
      to: order.email,
      ...emailContent,
      category: "quote",
      relatedType: "order",
      relatedId: order.orderId,
      idempotencyKey: prefix,
      fromName: brandName,
      support: settings.support,
      locale: order.locale === "en" ? "en" : "zh",
    })).then((result) => ({ channel: "email", ...result })),
  ]);
  return attempts;
}

function orderConflict(error = "stale_revision") {
  return Response.json({ ok: false, error }, { status: 409 });
}

async function finishPaymentSubmission(order, operation, settings, { alreadySubmitted = false } = {}) {
  const paymentEventId = `quote-payment-received:${order.orderId}:${order.paymentSubmittedAt || order.revision}`;
  const logOk = await pushAdminActionLog({
    action: "proxy_payment_submitted",
    actor: { staffId: 0, staffUsername: "system" },
    target: "order:" + order.orderId,
    detail: { amount: order.paidAmount, email: order.email, revision: order.revision },
    operationId: `${paymentEventId}:admin-log`,
  });
  if (!logOk) {
    return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
  }
  const deliveries = await deliverQuotePaymentNotifications(order, settings);
  const payload = {
    ok: true,
    status: order.status,
    order: publicQuoteOrder(order),
    ...(alreadySubmitted ? { alreadySubmitted: true } : {}),
    deliveries,
  };
  const completed = await completeDurableOperation(operation, payload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(payload);
}

export async function GET(request, { params }) {
  const { orderId: rawOrderId } = await params;
  const orderId = normalizeOrderId(rawOrderId);
  if (!orderId) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const entry = await findOrder(orderId);
  if (!entry || entry.order.orderType !== "proxy_payment") {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  if (!tokenMatches(entry.order, token)) {
    return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
  }

  const expiry = await expireQuoteOrderEntry({ orderId });
  const latestEntry = expiry.order ? null : await findOrder(orderId);
  const order = expiry.order || latestEntry?.order;
  if (!order || !tokenMatches(order, token)) {
    return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
  }
  if (order.status === "invalid") {
    return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
  }
  if (order.status === "quote_expired") {
    return Response.json({ ok: false, error: "quote_expired" }, { status: 410 });
  }
  if (!["pending_payment", "received", "completed"].includes(order.status)) {
    return Response.json({ ok: false, error: "quote_not_ready" }, { status: 409 });
  }
  return Response.json({ ok: true, order: publicQuoteOrder(order) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request, { params }) {
  const { orderId: rawOrderId } = await params;
  const orderId = normalizeOrderId(rawOrderId);
  if (!orderId) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  let body = {};
  try { body = await request.json(); } catch {}

  const token = clean(body.token, 200);
  const expectedRevision = body.expectedRevision == null || body.expectedRevision === ""
    ? null
    : Number(body.expectedRevision);
  if (expectedRevision != null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    return Response.json({ ok: false, error: "invalid_revision" }, { status: 400 });
  }
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });

  const guard = await checkIdentityRateLimit({
    namespace: "quote-order:payment-submit",
    identity: `${clientIpFromRequest(request)}:${orderId}`,
    limit: 5,
    windowSec: 10 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "提交次数较多，请稍后再试");

  const method = body.paymentMethod === "usdt" ? "usdt" : "alipay";
  const requestHash = idempotencyPayloadHash({
    orderId,
    tokenHash: hashToken(token),
    paymentMethod: method,
    expectedRevision,
  });
  const lock = await acquireOrderUpdateLock(orderId);
  if (!lock) return orderConflict("payment_processing");

  let order = null;
  let settings = null;
  let usdtRate = null;
  let operation = null;
  try {
    // The first order read is deliberately after the normalized per-order lock.
    const entry = await findOrder(orderId);
    if (!entry || entry.order.orderType !== "proxy_payment") {
      return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
    }
    if (!tokenMatches(entry.order, token)) {
      return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
    }

    operation = await claimDurableOperation({
      scope: "quote-payment-submit",
      principal: `${orderId}:${hashToken(token)}`,
      idempotencyKey: idempotency.key,
      requestHash,
    });
    if (!operation.ok) {
      return Response.json({ ok: false, error: operation.error }, {
        status: operation.error === "idempotency_conflict" ? 409 : 503,
      });
    }
    if (operation.state === "done") {
      return Response.json({ ...(operation.record.result || { ok: true }), idempotent: true });
    }

    const observedRevision = Number(entry.order.revision || 0);
    if (["received", "completed"].includes(entry.order.status)) {
      if (entry.order.paymentSubmissionRequestHash && entry.order.paymentSubmissionRequestHash !== requestHash) {
        return orderConflict("payment_method_conflict");
      }
      return finishPaymentSubmission(entry.order, operation, null, { alreadySubmitted: true });
    }
    if (expectedRevision != null && expectedRevision !== observedRevision) return orderConflict();

    const expiry = await expireQuoteOrderEntry(
      { orderId },
      new Date(),
      { lockHeld: true, expectedRevision: observedRevision },
    );
    const current = expiry.order;
    if (!current || expiry.reason === "stale_revision") return orderConflict();
    if (!tokenMatches(current, token)) {
      return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
    }
    if (["received", "completed"].includes(current.status)) {
      if (current.paymentSubmissionRequestHash && current.paymentSubmissionRequestHash !== requestHash) {
        return orderConflict("payment_method_conflict");
      }
      return finishPaymentSubmission(current, operation, null, { alreadySubmitted: true });
    }
    if (current.status === "invalid") return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
    if (current.status === "quote_expired") return Response.json({ ok: false, error: "quote_expired" }, { status: 410 });
    if (current.status !== "pending_payment") return Response.json({ ok: false, error: "quote_not_ready" }, { status: 409 });

    const currentRevision = Number(current.revision || 0);
    if (currentRevision !== observedRevision) return orderConflict();

    settings = await getSettings();
    usdtRate = method === "usdt"
      ? (settings.usdt.rateOverride ? Number(settings.usdt.rateOverride) : await getUsdtRate())
      : null;
    if (method === "usdt" && (!Number.isFinite(usdtRate) || usdtRate <= 0)) {
      return Response.json({ ok: false, error: "usdt_rate_unavailable" }, { status: 503 });
    }

    // Re-read immediately before the non-CAS setOrderAt call. This prevents a
    // stale object captured before lock acquisition from overwriting a newer order.
    const latestEntry = await findOrder(orderId);
    const latest = latestEntry?.order;
    if (
      !latestEntry
      || !latest
      || latest.orderType !== "proxy_payment"
      || latest.status !== "pending_payment"
      || Number(latest.revision || 0) !== currentRevision
      || !tokenMatches(latest, token)
    ) {
      return orderConflict();
    }

    const now = new Date();
    const quoteCny = Number(latest.quoteAmount || latest.finalAmount || 0);
    if (!Number.isFinite(quoteCny) || quoteCny <= 0) {
      return Response.json({ ok: false, error: "invalid_quote_amount" }, { status: 409 });
    }
    order = {
      ...latest,
      orderId,
      status: "received",
      paymentMethod: method,
      paymentSubmittedAt: now.toISOString(),
      paymentSubmittedAtBeijing: formatBeijingTime(now),
      paymentSubmissionOperationId: operation.operationId,
      paymentSubmissionRequestHash: requestHash,
      revision: currentRevision + 1,
    };
    if (method === "usdt") {
      const configuredDiscount = Number(settings.usdt.discount);
      const discount = Number.isFinite(configuredDiscount) && configuredDiscount > 0 && configuredDiscount <= 1
        ? configuredDiscount
        : 0.9;
      const usdt = Math.round((quoteCny * discount / usdtRate) * 100) / 100;
      order.paidAmount = usdt;
      order.paidCurrency = "USDT";
      order.usdtRate = usdtRate;
      order.finalUsdt = usdt;
    } else {
      order.paidAmount = quoteCny;
      order.paidCurrency = "CNY";
    }
    order.staffAudit = Array.isArray(latest.staffAudit) ? [...latest.staffAudit] : [];
    order.staffAudit.unshift({
      id: "OA" + Date.now().toString(36).toUpperCase(),
      staffId: 0,
      staffUsername: "system",
      label: "用户付款链接",
      action: "payment_submitted",
      status: "received",
      createdAt: now.toISOString(),
      createdAtBeijing: order.paymentSubmittedAtBeijing,
    });
    order.staffAudit = order.staffAudit.slice(0, 30);

    const saved = await setOrderAt(latestEntry.index, order, { expectedRevision: currentRevision });
    if (!saved) {
      const afterEntry = await findOrder(orderId);
      const after = afterEntry?.order;
      if (after && tokenMatches(after, token) && ["received", "completed"].includes(after.status)) {
        if (after.paymentSubmissionRequestHash && after.paymentSubmissionRequestHash !== requestHash) {
          return orderConflict("payment_method_conflict");
        }
        return finishPaymentSubmission(after, operation, null, { alreadySubmitted: true });
      }
      if (!after || Number(after.revision || 0) !== currentRevision || after.status !== "pending_payment") {
        return orderConflict();
      }
      return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
    }
  } finally {
    await releaseOrderUpdateLock(lock).catch(() => {});
  }

  return finishPaymentSubmission(order, operation, settings);
}
