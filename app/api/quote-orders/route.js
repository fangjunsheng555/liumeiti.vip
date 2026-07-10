import { createHash } from "node:crypto";
import {
  checkIdentityRateLimit,
  checkRateLimit,
  clientIpFromRequest,
  clientUserAgentFromRequest,
  clean,
  formatBeijingTime,
  getCookieFromRequest,
  inviteCodeFromRequest,
  makeId,
  normalizeInviteCode,
  pushAdminActionLog,
  rateLimitResponse,
  redisCmd,
  resolveReferralForOrder,
  saveOrderRecord,
  sendSimpleEmail,
  verifySession,
} from "../_utils.js";
import { getSettings } from "../_settings.js";
import { buildProxyOrderEmail } from "./_email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const LIMIT_MESSAGE = "代付申请提交较频繁，请稍后再试或联系在线客服";

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizePlatformUrl(value) {
  const raw = clean(value, 800);
  if (!raw) return { ok: false, error: "missing_platform_url" };
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return { ok: false, error: "invalid_platform_url" };
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || !host.includes(".")) return { ok: false, error: "invalid_platform_url" };
    if (host.endsWith(".cn")) return { ok: false, error: "mainland_site_not_supported" };
    url.hash = "";
    return { ok: true, value: url.toString().slice(0, 800) };
  } catch {
    return { ok: false, error: "invalid_platform_url" };
  }
}

function requestNotice(order) {
  return [
    `🧾 新代付申请 ${order.orderId}`,
    "━━━━━━━━━━━━━━━━",
    `时间: ${order.createdAtBeijing}`,
    `平台: ${order.platformUrl}`,
    `商品标价: ${order.productPrice}`,
    `邮箱: ${order.email}`,
    `联系: ${order.contact}`,
    order.remark ? `备注: ${order.remark}` : "",
    "状态: 等待人工报价",
  ].filter(Boolean).join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}

  const email = clean(body.email, 200).toLowerCase();
  const platform = normalizePlatformUrl(body.platformUrl);
  const productPrice = clean(body.productPrice, 80);
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  const locale = getCookieFromRequest(request, "locale") === "en" || body.locale === "en" ? "en" : "zh";

  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  if (!platform.ok) return Response.json({ ok: false, error: platform.error }, { status: 400 });
  if (!productPrice || productPrice.length < 2 || !/\d/.test(productPrice)) {
    return Response.json({ ok: false, error: "invalid_product_price" }, { status: 400 });
  }
  if (!contact) return Response.json({ ok: false, error: "missing_contact" }, { status: 400 });

  const ip = clientIpFromRequest(request);
  const userAgent = clientUserAgentFromRequest(request);
  const ipGuard = await checkIdentityRateLimit({ namespace: "quote-order:create:ip", identity: ip, limit: 3, windowSec: 10 * 60 });
  if (!ipGuard.ok) return rateLimitResponse(ipGuard, LIMIT_MESSAGE);
  const orderGuard = await checkRateLimit(request, { namespace: "quote-order:create", identity: email, limit: 5, windowSec: 30 * 60 });
  if (!orderGuard.ok) return rateLimitResponse(orderGuard, LIMIT_MESSAGE);

  const userSession = verifySession(getCookieFromRequest(request, "lm_user"));
  const userEmail = userSession?.email || null;
  const referral = await resolveReferralForOrder({
    userEmail,
    inviteCode: normalizeInviteCode(body.inviteCode || inviteCodeFromRequest(request)),
  });

  let attribution = null;
  try {
    const raw = getCookieFromRequest(request, "lm_attr");
    if (raw) {
      const parsed = JSON.parse(raw);
      attribution = {};
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "referrer", "landing"]) {
        if (typeof parsed[key] === "string" && parsed[key]) attribution[key] = parsed[key].slice(0, 200);
      }
      if (parsed.fromTool) attribution.fromTool = 1;
      if (parsed.firstTs) attribution.firstTs = Number(parsed.firstTs) || 0;
      if (!Object.keys(attribution).length) attribution = null;
    }
  } catch {}

  const now = new Date();
  const orderId = makeId("LM");
  const item = {
    service: "proxy-pay",
    label: "全球代付 · 人工报价",
    cycle: "按单",
    amount: 0,
    plan: "quote",
    planLabel: "人工报价",
    platformUrl: platform.value,
    productPrice,
  };
  const order = {
    orderId,
    orderType: "proxy_payment",
    status: "awaiting_quote",
    locale,
    userEmail,
    referral,
    attribution,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    clientIp: ip,
    userAgent,
    items: [item],
    itemCount: 1,
    subtotal: 0,
    discountRate: 0,
    discountLabel: "",
    bundleFinalAmount: 0,
    couponDiscount: 0,
    finalAmount: 0,
    payableAmount: 0,
    quoteAmount: 0,
    paymentMethod: "quote",
    paidAmount: 0,
    paidCurrency: "CNY",
    email,
    contact,
    platformUrl: platform.value,
    productPrice,
    remark,
    staffNotes: "",
    completedAt: null,
    completedAtBeijing: null,
    service: "proxy-pay",
    serviceLabel: "全球代付 · 人工报价",
    cycle: "按单",
    account: "",
    password: "",
    originalAmount: 0,
    currency: "CNY",
  };

  const stored = await saveOrderRecord(order);
  if (!stored) return Response.json({ ok: false, error: "storage_failed" }, { status: 500 });

  try {
    const visitorId = createHash("sha256").update(ip + "|" + userAgent).digest("hex").slice(0, 24);
    await redisCmd(["ZREM", "lm:cart:index", visitorId]);
    await redisCmd(["DEL", "lm:cart:v:" + visitorId]);
  } catch {}

  await pushAdminActionLog({
    action: "proxy_order_create",
    actor: { staffId: 0, staffUsername: "system" },
    target: "order:" + orderId,
    detail: { email, platformUrl: platform.value, productPrice },
  });

  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const emailContent = buildProxyOrderEmail({ kind: "application", order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale, support: settings.support });
  const deliveries = [];
  const tasks = [
    (settings.notify.telegramEnabled ? sendTelegram(requestNotice(order)) : Promise.resolve(null))
      .then((ok) => { if (ok !== null) deliveries.push({ channel: "telegram", ok }); }),
    sendWebhook(order).then((ok) => { if (ok !== null) deliveries.push({ channel: "webhook", ok }); }),
    sendSimpleEmail({ to: email, ...emailContent, fromName: brandName })
      .then((result) => deliveries.push({ channel: "email", ok: result.ok })),
  ];
  await Promise.allSettled(tasks);

  return Response.json({ ok: true, orderId, status: order.status, deliveries });
}
