import { createHash, timingSafeEqual } from "node:crypto";
import {
  checkIdentityRateLimit,
  clean,
  clientIpFromRequest,
  formatBeijingTime,
  getAllOrdersWithIndex,
  pushAdminActionLog,
  rateLimitResponse,
  redisCmd,
  sendSimpleEmail,
  setOrderAt,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { buildProxyOrderEmail } from "../_email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

function hashToken(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function tokenMatches(order, token) {
  const expected = String(order.quotePaymentTokenHash || "");
  const actual = hashToken(token);
  if (!expected || expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  } catch {
    return false;
  }
}

async function findOrder(orderId) {
  const all = await getAllOrdersWithIndex();
  return all.find((entry) => entry.order?.orderId === orderId && !entry.order.deleted) || null;
}

function publicQuoteOrder(order) {
  return {
    orderId: order.orderId,
    status: order.status,
    locale: order.locale === "en" ? "en" : "zh",
    email: String(order.email || "").replace(/^(.{1,2}).*(@.*)$/, "$1***$2"),
    platformUrl: order.platformUrl || order.items?.[0]?.platformUrl || "",
    productPrice: order.productPrice || order.items?.[0]?.productPrice || "",
    quoteAmount: Number(order.quoteAmount || order.finalAmount || 0),
    quotedAtBeijing: order.quotedAtBeijing || "",
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
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendWebhook(order) {
  if (!process.env.ORDER_WEBHOOK_URL) return null;
  try {
    const response = await fetch(process.env.ORDER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function GET(request, { params }) {
  const { orderId: rawOrderId } = await params;
  const orderId = clean(rawOrderId, 80);
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const entry = await findOrder(orderId);
  if (!entry || entry.order.orderType !== "proxy_payment") {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  if (!tokenMatches(entry.order, token)) {
    return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
  }
  if (entry.order.status === "invalid") {
    return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
  }
  if (!["pending_payment", "received", "completed"].includes(entry.order.status)) {
    return Response.json({ ok: false, error: "quote_not_ready" }, { status: 409 });
  }
  if (entry.order.status === "pending_payment" && new Date(entry.order.quoteExpiresAt || 0).getTime() < Date.now()) {
    return Response.json({ ok: false, error: "quote_expired" }, { status: 410 });
  }
  return Response.json({ ok: true, order: publicQuoteOrder(entry.order) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request, { params }) {
  const { orderId: rawOrderId } = await params;
  const orderId = clean(rawOrderId, 80);
  let body = {};
  try { body = await request.json(); } catch {}
  const token = clean(body.token, 200);
  const entry = await findOrder(orderId);
  if (!entry || entry.order.orderType !== "proxy_payment") {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  const order = entry.order;
  if (!tokenMatches(order, token)) return Response.json({ ok: false, error: "invalid_payment_link" }, { status: 403 });
  if (["received", "completed"].includes(order.status)) {
    return Response.json({ ok: true, status: order.status, order: publicQuoteOrder(order), alreadySubmitted: true });
  }
  if (order.status === "invalid") return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
  if (order.status !== "pending_payment") return Response.json({ ok: false, error: "quote_not_ready" }, { status: 409 });
  if (new Date(order.quoteExpiresAt || 0).getTime() < Date.now()) {
    return Response.json({ ok: false, error: "quote_expired" }, { status: 410 });
  }
  const guard = await checkIdentityRateLimit({
    namespace: "quote-order:payment-submit",
    identity: `${clientIpFromRequest(request)}:${orderId}`,
    limit: 5,
    windowSec: 10 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "提交次数较多，请稍后再试");
  const lockKey = `lm:quote-payment-lock:${orderId}`;
  const locked = await redisCmd(["SET", lockKey, String(Date.now()), "NX", "EX", "30"]);
  if (locked !== "OK") {
    return Response.json({ ok: false, error: "payment_processing" }, { status: 409 });
  }

  const now = new Date();
  order.status = "received";
  order.paymentMethod = "alipay";
  order.paidAmount = Number(order.quoteAmount || order.finalAmount || 0);
  order.paidCurrency = "CNY";
  order.paymentSubmittedAt = now.toISOString();
  order.paymentSubmittedAtBeijing = formatBeijingTime(now);
  order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
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

  const saved = await setOrderAt(entry.index, order);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  await pushAdminActionLog({
    action: "proxy_payment_submitted",
    actor: { staffId: 0, staffUsername: "system" },
    target: "order:" + orderId,
    detail: { amount: order.paidAmount, email: order.email },
  });

  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const emailContent = buildProxyOrderEmail({ kind: "payment_received", order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale: order.locale, support: settings.support });
  const deliveries = [];
  await Promise.allSettled([
    (settings.notify.telegramEnabled ? sendTelegram(paidNotice(order)) : Promise.resolve(null))
      .then((ok) => { if (ok !== null) deliveries.push({ channel: "telegram", ok }); }),
    sendWebhook(order).then((ok) => { if (ok !== null) deliveries.push({ channel: "webhook", ok }); }),
    sendSimpleEmail({ to: order.email, ...emailContent, fromName: brandName })
      .then((result) => deliveries.push({ channel: "email", ok: result.ok })),
  ]);

  return Response.json({ ok: true, status: order.status, order: publicQuoteOrder(order), deliveries });
}
