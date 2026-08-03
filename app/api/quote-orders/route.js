import { createHash } from "node:crypto";
import { after } from "next/server";
import {
  checkIdentityRateLimit,
  checkRateLimit,
  clientIpFromRequest,
  clientUserAgentFromRequest,
  clean,
  formatBeijingTime,
  getCookieFromRequest,
  inviteCodeFromRequest,
  normalizeInviteCode,
  pushAdminActionLog,
  rateLimitResponse,
  redisCmd,
  resolveReferralForOrder,
  sendSimpleEmail,
} from "../_utils.js";
import { authenticateUserRequest, userAuthErrorResponse } from "../_auth-session.js";
import {
  commitOrderCreationAtomic,
  findOrderCreationByIdempotencyKey,
  idempotencyPayloadHash,
  orderIdForIdempotencyKey,
  requiredIdempotencyKey,
} from "../_money.js";
import { getSettings } from "../_settings.js";
import { buildProxyOrderEmail } from "./_email.js";
import { deliverOnce } from "../_delivery-once.js";
import {
  isRetryableMoneyOperationFailure,
  retryableMoneyOperationFields,
} from "../../lib/money-operation-failure.js";
import { marketingAttributionFromRequest } from "../_mail-preferences.js";
import {
  appendBusinessTraceEvent,
  businessTraceIdForOrder,
  makeTraceId,
  withApiTelemetry,
} from "../_observability.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const LIMIT_MESSAGE = "代付申请提交较频繁，请稍后再试或联系在线客服";

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// 网站链接/平台:不做格式校验,接受任意内容(链接或纯文字描述均可),仅要求非空。
function normalizePlatformUrl(value) {
  const raw = clean(value, 800);
  if (!raw) return { ok: false, error: "missing_platform_url" };
  return { ok: true, value: raw };
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
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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
  });
  if (response.ok) return true;
  return response.status >= 500 || response.status === 408 || response.status === 425
    ? { ok: false, uncertain: true, error: `webhook_http_${response.status}` }
    : { ok: false, retryable: true, error: `webhook_http_${response.status}` };
}

async function deliverQuoteApplicationNotifications(order, knownSettings = null) {
  const settings = knownSettings || await getSettings();
  const locale = order.locale === "en" ? "en" : "zh";
  const brandName = settings.brand.name || BRAND_NAME;
  const emailContent = buildProxyOrderEmail({ kind: "application", order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale, support: settings.support });
  const prefix = `quote-application:${order.orderId}`;
  const attempts = await Promise.all([
    deliverOnce(`${prefix}:telegram`, () => settings.notify.telegramEnabled ? sendTelegram(requestNotice(order)) : null)
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
      locale,
    })).then((result) => ({ channel: "email", ...result })),
  ]);
  return attempts;
}

function queueOrderTrace(order, event = {}) {
  if (!order?.orderId) return;
  const task = () => appendBusinessTraceEvent(order.orderId, {
    businessTraceId: order.businessTraceId,
    traceId: order.requestTraceId,
    ...event,
  }).catch(() => null);
  try {
    after(task);
  } catch {
    queueMicrotask(task);
  }
}

function traceOrderDeliveries(order, deliveries = []) {
  for (const delivery of deliveries) {
    queueOrderTrace(order, {
      stage: `notification_${delivery.channel || "unknown"}`,
      component: delivery.channel || "notification",
      outcome: delivery.ok === false
        ? (delivery.uncertain ? "uncertain" : "error")
        : delivery.delivered === false || delivery.suppressed || delivery.skipped ? "skipped" : "ok",
      errorCode: delivery.reason || delivery.error || delivery.code || "",
      operationId: `quote-application:${order.orderId}:${delivery.channel || "unknown"}`,
    });
  }
}

async function handler(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });

  const email = clean(body.email, 200).toLowerCase();
  const platform = normalizePlatformUrl(body.platformUrl);
  const productPrice = clean(body.productPrice, 80);
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  const locale = getCookieFromRequest(request, "locale") === "en" || body.locale === "en" ? "en" : "zh";

  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });

  let userEmail = null;
  let userAuthVersion = 0;
  let userAccountLifecycleId = "";
  const expectedIdentityHeader = clean(request.headers.get("x-order-expected-account"), 200).toLowerCase();
  const expectedIdentityHeaderProvided = request.headers.has("x-order-expected-account");
  const expectedBodyProvided = Object.prototype.hasOwnProperty.call(body, "expectedAccountEmail");
  const expectedBodyAccount = clean(body.expectedAccountEmail, 200).toLowerCase();
  const expectedHeaderAccount = expectedIdentityHeader === "__guest__" ? "" : expectedIdentityHeader;
  const expectedLifecycleHeaderRaw = clean(request.headers.get("x-operation-expected-lifecycle"), 80).toLowerCase();
  const expectedLifecycleHeaderProvided = request.headers.has("x-operation-expected-lifecycle");
  const expectedLifecycleHeader = expectedLifecycleHeaderRaw === "__guest__" ? "" : expectedLifecycleHeaderRaw;
  const expectedBodyLifecycleProvided = Object.prototype.hasOwnProperty.call(body, "expectedAccountLifecycleId");
  const expectedBodyLifecycle = clean(body.expectedAccountLifecycleId, 80).toLowerCase();
  if (expectedIdentityHeaderProvided && expectedIdentityHeader !== "__guest__" && !validEmail(expectedHeaderAccount)) {
    return Response.json({ ok: false, error: "invalid_expected_account" }, { status: 400 });
  }
  if (expectedBodyProvided && expectedBodyAccount && !validEmail(expectedBodyAccount)) {
    return Response.json({ ok: false, error: "invalid_expected_account" }, { status: 400 });
  }
  if (expectedIdentityHeaderProvided && expectedBodyProvided && expectedHeaderAccount !== expectedBodyAccount) {
    return Response.json({ ok: false, error: "operation_identity_mismatch" }, { status: 409 });
  }
  if (!expectedLifecycleHeaderProvided && !expectedBodyLifecycleProvided) {
    return Response.json({ ok: false, error: "operation_lifecycle_required" }, { status: 400 });
  }
  if ((expectedLifecycleHeader && !/^[a-f0-9]{32}$/.test(expectedLifecycleHeader))
    || (expectedBodyLifecycle && !/^[a-f0-9]{32}$/.test(expectedBodyLifecycle))) {
    return Response.json({ ok: false, error: "invalid_expected_lifecycle" }, { status: 400 });
  }
  if (expectedLifecycleHeaderProvided && expectedBodyLifecycleProvided && expectedLifecycleHeader !== expectedBodyLifecycle) {
    return Response.json({ ok: false, error: "operation_lifecycle_mismatch" }, { status: 409 });
  }
  const expectedIdentityProvided = expectedIdentityHeaderProvided || expectedBodyProvided;
  const expectedAccountEmail = expectedIdentityHeaderProvided ? expectedHeaderAccount : expectedBodyAccount;
  const expectedAccountLifecycleId = expectedLifecycleHeaderProvided ? expectedLifecycleHeader : expectedBodyLifecycle;
  const hasUserCookie = Boolean(getCookieFromRequest(request, "lm_user"));
  if (expectedIdentityProvided && !expectedAccountEmail && hasUserCookie) {
    return Response.json({ ok: false, error: "guest_operation_has_session" }, { status: 409 });
  }
  if (expectedAccountEmail && !hasUserCookie) {
    return Response.json({ ok: false, error: "operation_identity_auth_required" }, { status: 401 });
  }
  if (expectedAccountLifecycleId && !hasUserCookie) {
    return Response.json({ ok: false, error: "operation_identity_auth_required" }, { status: 401 });
  }
  if (hasUserCookie) {
    const userSession = await authenticateUserRequest(request);
    if (!userSession.ok) return userAuthErrorResponse(userSession);
    if (expectedIdentityProvided && userSession.email !== expectedAccountEmail) {
      return Response.json({ ok: false, error: "operation_identity_changed" }, { status: 409 });
    }
    if (!expectedAccountLifecycleId) {
      return Response.json({ ok: false, error: "operation_lifecycle_required" }, { status: 400 });
    }
    if (userSession.accountLifecycleId !== expectedAccountLifecycleId) {
      return Response.json({ ok: false, error: "operation_lifecycle_changed" }, { status: 409 });
    }
    userEmail = userSession.email;
    userAuthVersion = userSession.authVersion;
    userAccountLifecycleId = userSession.accountLifecycleId;
  } else if (expectedAccountLifecycleId) {
    return Response.json({ ok: false, error: "guest_operation_lifecycle_invalid" }, { status: 409 });
  }
  const operationIdentity = userEmail || email;
  const operationLifecycle = userEmail ? userAccountLifecycleId : "__guest__";
  const serverOperationId = "quote-" + createHash("sha256")
    .update(`quote-order|${operationIdentity}|${operationLifecycle}|${idempotency.key}`)
    .digest("hex");
  const requestHash = idempotencyPayloadHash({
    route: "quote-order",
    principal: { accountEmail: userEmail || "", accountLifecycleId: userAccountLifecycleId },
    body,
  });
  const previousAttempt = await findOrderCreationByIdempotencyKey(serverOperationId, requestHash);
  if (!previousAttempt.ok) {
    return Response.json({ ok: false, error: previousAttempt.error }, {
      status: previousAttempt.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (previousAttempt.found) {
    const existing = previousAttempt.order;
    const deliveries = await deliverQuoteApplicationNotifications(existing);
    queueOrderTrace(existing, {
      stage: "order_commit_replay",
      component: "quote_order",
      outcome: "ok",
      operationId: serverOperationId,
    });
    traceOrderDeliveries(existing, deliveries);
    return Response.json({
      ok: true,
      orderId: existing.orderId,
      status: existing.status,
      deliveries,
      idempotent: true,
      traceId: existing.businessTraceId || businessTraceIdForOrder(existing.orderId),
    });
  }

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
  let marketingAttribution = null;
  try {
    marketingAttribution = marketingAttributionFromRequest(request);
  } catch {}

  const now = new Date();
  const orderId = orderIdForIdempotencyKey(serverOperationId);
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
    businessTraceId: businessTraceIdForOrder(orderId),
    requestTraceId: makeTraceId(),
    revision: 1,
    orderType: "proxy_payment",
    status: "awaiting_quote",
    locale,
    userEmail,
    accountLifecycleId: userAccountLifecycleId || null,
    referral,
    attribution,
    marketingAttribution,
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

  const committed = await commitOrderCreationAtomic({
    order,
    paymentMethod: "quote",
    operationId: serverOperationId,
    requestHash,
    userEmail,
    expectedAuthVersion: userAuthVersion,
    expectedAccountLifecycleId: userAccountLifecycleId,
  });
  if (!committed.ok) {
    const retryableFailure = isRetryableMoneyOperationFailure(committed);
    queueOrderTrace(order, {
      stage: "order_commit",
      component: "quote_order",
      outcome: retryableFailure ? "retry" : "error",
      operationId: serverOperationId,
      errorCode: committed.error || "storage_failed",
    });
    const conflict = ["idempotency_conflict", "order_exists", "out_of_stock", "account_lifecycle_changed"].includes(committed.error);
    return Response.json({
      ok: false,
      error: committed.error || "storage_failed",
      ...(retryableFailure ? retryableMoneyOperationFields(committed) : {}),
    }, {
      status: retryableFailure ? 503 : committed.error === "session_state_changed" ? 401 : committed.error === "account_banned" ? 403 : conflict ? 409 : 400,
    });
  }
  Object.assign(order, committed.order || {});
  queueOrderTrace(order, {
    stage: committed.idempotent ? "order_commit_replay" : "order_committed",
    component: "quote_order",
    outcome: "ok",
    operationId: serverOperationId,
  });
  if (committed.idempotent) {
    const deliveries = await deliverQuoteApplicationNotifications(order);
    traceOrderDeliveries(order, deliveries);
    return Response.json({ ok: true, orderId, status: order.status, deliveries, idempotent: true, traceId: order.businessTraceId });
  }

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

  const deliveries = await deliverQuoteApplicationNotifications(order);
  traceOrderDeliveries(order, deliveries);

  return Response.json({ ok: true, orderId, status: order.status, deliveries, traceId: order.businessTraceId });
}

export const POST = withApiTelemetry("quote_order_create", handler);
