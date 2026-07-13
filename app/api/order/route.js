import { createHash } from "node:crypto";
import { after } from "next/server";
import { buildOrderEmailHtml, buildOrderEmailText } from "./email-template.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { getMergedCatalog } from "../_catalog.js";
import { getSettings } from "../_settings.js";
import { confirmPendingUsdtPayments } from "../_usdt-confirm.js";
import { supportText, discountLabel as fmtDiscount } from "../../lib/settings-defaults.js";
import {
  consumeBestCoupon, restoreCoupon, verifySession, getUser,
  setUser, addBalanceTx, pushAdminBalanceLog, makeId, roundMoney,
  validateServiceRedeemCode, consumeServiceRedeemCode, restoreServiceRedeemCode,
  checkRedeemRateLimit, recordRedeemRateFailure, clearRedeemRateLimit, redeemRateLimitMessage,
  checkIdentityRateLimit, checkRateLimit, rateLimitResponse,
  clientIpFromRequest, clientUserAgentFromRequest,
  inviteCodeFromRequest, normalizeInviteCode, resolveReferralForOrder,
  pushAdminActionLog,
  saveOrderRecord, verifyPaymentQuote, claimUsdtQuote, releaseUsdtQuote, getCookieFromRequest,
  reserveStock, restoreStock, getUsdtRate, redisCmd, sendSimpleEmail,
} from "../_utils.js";

// 从合并后的目录商品里解析规格(沿用 rocket single→basic 别名 + 默认规格回退)。
function resolveCatalogPlan(product, value) {
  const plans = (product.plans || []).filter((p) => p.active !== false);
  if (!plans.length) return null;
  const id = clean(value, 30);
  const aliases = product.key === "rocket" ? { single: "basic" } : {};
  const wantId = aliases[id] || id;
  return plans.find((p) => p.id === wantId)
    || plans.find((p) => p.id === product.defaultPlan)
    || plans[0];
}

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +34 671143339 / Telegram @MaoyangSupport 联系在线客服";
const SUPPORT_CONTACT_EN = process.env.SUPPORT_CONTACT_EN
  || ("Reach our online support via " + SUPPORT_CONTACT.replace(/^请通过\s*/, "").replace(/\s*联系在线客服\s*$/, "").trim());
const USDT_DISCOUNT = 0.9;
const USDT_RATE = 6.85;
const ORDER_LIMIT_MESSAGE = "订单提交次数较多，请 5 分钟后再试，或联系在线客服协助下单";

export const maxDuration = 30;

function clean(value, limit = 500) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);
}

function pad2(value) { return String(value).padStart(2, "0"); }

function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const ts = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  const b = new Date(ts + 8 * 60 * 60 * 1000);
  return [b.getUTCFullYear(), pad2(b.getUTCMonth() + 1), pad2(b.getUTCDate())].join("-")
    + " " + [pad2(b.getUTCHours()), pad2(b.getUTCMinutes()), pad2(b.getUTCSeconds())].join(":")
    + " 北京时间 (UTC+8)";
}

function validUsername(value) { return /^[A-Za-z0-9]{4,10}$/.test(String(value || "").trim()); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }

function bundleDiscountRate(itemCount) {
  if (itemCount >= 3) return 0.10;
  if (itemCount >= 2) return 0.05;
  return 0;
}


function normalizePaymentAdjustment(value) {
  const amount = Math.round(Number(value || 0) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (Math.abs(amount) < 0.01 || Math.abs(amount) > 0.49) return 0;
  return amount;
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function orderText(order) {
  const isUsdt = order.paymentMethod === "usdt";
  const isBalance = order.paymentMethod === "balance";
  const isRedeem = order.paymentMethod === "redeem";
  const payLabel = isRedeem ? "服务兑换码(免支付)" : isBalance ? "账户余额(已扣)" : isUsdt ? "USDT-TRC20" : "支付宝";
  const lines = [
    "🛒 新订单 " + order.orderId,
    "━━━━━━━━━━━━━━━━",
    "时间: " + order.createdAtBeijing,
    "件数: " + order.items.length + " 件",
    "支付: " + payLabel,
    "━━ 商品明细 ━━",
  ];
  order.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.label}（${it.cycle}）¥${it.amount}`);
    if (it.account) lines.push(`   ${it.service === "rocket" ? "用户名" : "账号"}: ${it.account}`);
    if (it.password) lines.push(`   密码: ${it.password}`);
    if (it.subscriptionLinks) {
      lines.push(`   Shadowrocket: ${it.subscriptionLinks.shadowrocket}`);
      lines.push(`   Clash: ${it.subscriptionLinks.clash}`);
    }
  });
  lines.push("━━ 价格 ━━");
  lines.push(`商品总价: ¥${order.subtotal}`);
  if (order.discountRate > 0) {
    lines.push(`组合优惠 ${order.discountLabel}: −¥${order.subtotal - order.bundleFinalAmount}`);
  }
  if (order.couponDiscount > 0) {
    lines.push(`新用户优惠券: −¥${order.couponDiscount}`);
  }
  if (isRedeem) {
    lines.push(`服务兑换码: ${order.redeemCode}`);
    lines.push("💰 实付: ¥0(服务兑换码抵扣)");
  } else if (isUsdt) {
    lines.push(`折后人民币: ¥${order.finalAmount}`);
    lines.push(`💰 实付: ${order.paidAmount} USDT (¥${order.finalAmount} × 0.9 ÷ ${order.usdtRate || USDT_RATE})`);
  } else if (isBalance) {
    lines.push(`💰 余额扣款: ¥${order.finalAmount}(已自动从用户余额扣除)`);
  } else {
    if (order.paymentAdjustment) {
      lines.push(`核对尾差: ${order.paymentAdjustment > 0 ? "+" : ""}¥${order.paymentAdjustment}`);
    }
    lines.push(`💰 实付: ¥${order.paidAmount || order.finalAmount}`);
  }
  lines.push("━━ 联系方式 ━━");
  lines.push(`邮箱: ${order.email}`);
  lines.push(`联系: ${order.contact}`);
  if (order.remark) lines.push(`备注: ${order.remark}`);
  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function sendWebhook(order) {
  const webhookUrl = process.env.ORDER_WEBHOOK_URL;
  if (!webhookUrl) return null;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order),
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function refundFailedBalanceOrder(order, userEmail, finalAmount, now) {
  if (order.paymentMethod !== "balance" || !order.paidByBalance || !userEmail) return;
  const user = await getUser(userEmail);
  if (!user) return;
  const prev = Number(user.balance || 0);
  const next = Math.round((prev + finalAmount) * 100) / 100;
  user.balance = next;
  await setUser(userEmail, user);
  const tx = {
    id: makeId("TX"),
    amount: finalAmount,
    reason: `订单提交失败退款 ${order.orderId}`,
    balanceAfter: next,
    source: "order",
    orderId: order.orderId,
    createdAt: new Date().toISOString(),
    createdAtBeijing: formatBeijingTime(new Date()),
  };
  await addBalanceTx(userEmail, tx);
  await pushAdminBalanceLog({ ...tx, email: userEmail, balanceBefore: prev });
}

async function sendOrderEmail(order) {
  if (!order.email) return { ok: false, reason: "order_email_missing" };

  const emailLocale = order.locale === "en" ? "en" : "zh";
  // 客服联系方式 / 品牌以站点设置为准(与站点显示一致)
  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const supportContact = supportText(settings.support, emailLocale);
  const html = buildOrderEmailHtml({
    order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL,
    supportContact, support: settings.support, usdtRate: order.usdtRate || USDT_RATE, locale: emailLocale,
    usdtDiscountLabel: fmtDiscount(1 - settings.usdt.discount, emailLocale),
  });
  const text = buildOrderEmailText({
    order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, usdtRate: order.usdtRate || USDT_RATE, locale: emailLocale,
  });
  const confirmWord = emailLocale === "en" ? "Order confirmation" : "订单确认";
  const subjItem = order.items[0]
    ? localizeOrderItemLabel(order.items[0].service, order.items[0].plan || order.items[0].rocketPlan, order.items[0].label, emailLocale)
    : "";
  const subject = order.items.length > 1
    ? `${confirmWord} ${order.orderId} · ${order.items.length}${emailLocale === "en" ? "" : " 件"} · ${BRAND_NAME}`
    : `${confirmWord} ${order.orderId} · ${subjItem} · ${BRAND_NAME}`;

  const result = await sendSimpleEmail({
    to: order.email,
    category: "order",
    relatedType: "order",
    relatedId: order.orderId,
    subject,
    text,
    html,
    fromName: brandName,
    support: settings.support,
    locale: emailLocale,
  });
  if (result.ok) {
    console.log(`[email] sent to ${order.email} via ${result.provider || "smtp"} (msgId=${result.messageId})`);
  } else {
    console.error(`[email] failed for ${order.email}: ${result.reason || result.error || result.code || "send_failed"}`);
  }
  return result;

}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (error) { body = {}; }

  // ── New schema: items array ──
  // ── Backward-compat: single-product { service, account, password } ──
  let rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems && body.service) {
    rawItems = [{ service: body.service, account: body.account, password: body.password }];
  }
  if (!rawItems || rawItems.length === 0) {
    return Response.json({ ok: false, error: "missing_items" }, { status: 400 });
  }

  const email = clean(body.email, 200);
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  const allowedMethods = ["alipay", "usdt", "balance", "redeem"];
  const paymentMethod = allowedMethods.includes(body.paymentMethod) ? body.paymentMethod : "alipay";
  const redeemCode = clean(body.redeemCode, 80).toUpperCase();

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const ipOrderGuard = await checkIdentityRateLimit({
    namespace: "order:create:ip",
    identity: clientIpFromRequest(request),
    limit: 3,
    windowSec: 5 * 60,
  });
  if (!ipOrderGuard.ok) return rateLimitResponse(ipOrderGuard, ORDER_LIMIT_MESSAGE);

  const uaOrderGuard = await checkIdentityRateLimit({
    namespace: "order:create:ua",
    identity: clientUserAgentFromRequest(request) || "unknown",
    limit: 3,
    windowSec: 5 * 60,
  });
  if (!uaOrderGuard.ok) return rateLimitResponse(uaOrderGuard, ORDER_LIMIT_MESSAGE);

  const orderGuard = await checkRateLimit(request, {
    namespace: "order:create",
    limit: 12,
    windowSec: 10 * 60,
    identity: email,
  });
  if (!orderGuard.ok) return rateLimitResponse(orderGuard, ORDER_LIMIT_MESSAGE);

  // 价格权威:读「默认 + 后台覆盖」合并后的目录,结账实收价以此为准(站主后台改价即时生效)。
  const catalog = await getMergedCatalog();
  const catalogByKey = {};
  catalog.forEach((p) => { catalogByKey[p.key] = p; });
  // 站点设置(组合优惠档位 / USDT 折扣·汇率 / Telegram 通知开关)——后台可改,这里是权威。
  const settings = await getSettings();

  // Validate items first to determine if contact is required (Spotify only)
  const items = [];
  let needsContact = false;
  for (const raw of rawItems) {
    const service = clean(raw.service, 40);
    const product = catalogByKey[service];
    if (!product) {
      return Response.json({ ok: false, error: "invalid_service:" + service }, { status: 400 });
    }
    if (product.quoteOnly || service === "proxy-pay") {
      return Response.json({ ok: false, error: "quote_service_requires_application" }, { status: 400 });
    }
    if (product.active === false) {
      return Response.json({ ok: false, error: "service_unavailable:" + service }, { status: 400 });
    }
    const account = clean(raw.account, 80);
    const password = clean(raw.password, 120);
    if (product.needsAccountPassword && (!account || !password)) {
      return Response.json({ ok: false, error: "missing_credentials:" + product.title }, { status: 400 });
    }
    if (product.needsContact) needsContact = true;
    const planInfo = resolveCatalogPlan(product, raw.plan || raw.productPlan || raw.rocketPlan);
    if (!planInfo) {
      return Response.json({ ok: false, error: "invalid_plan:" + service }, { status: 400 });
    }
    const amount = Number(planInfo.amount);
    const cycle = planInfo.cycle || product.cycle;
    const plan = planInfo.id;
    const planLabel = planInfo.label;
    const label = `${product.title} · ${planInfo.label}`;
    const rocketPlan = service === "rocket" ? planInfo.id : "";
    const rocketPlanLabel = service === "rocket" ? planInfo.label : "";
    const item = {
      service,
      label,
      cycle,
      amount,
      account: product.needsAccountPassword ? account : "",
      password: product.needsAccountPassword ? password : "",
      plan,
      planLabel,
      rocketPlan,
      rocketPlanLabel,
    };
    items.push(item);
  }
  if (needsContact && !contact) {
    return Response.json({ ok: false, error: "missing_contact" }, { status: 400 });
  }

  let serviceRedeem = null;
  let redeemGuard = null;
  if (paymentMethod === "redeem") {
    redeemGuard = await checkRedeemRateLimit(request);
    if (!redeemGuard.ok) {
      return Response.json({
        ok: false,
        error: "too_many_attempts",
        message: redeemRateLimitMessage(redeemGuard.retryAfter),
        retryAfter: redeemGuard.retryAfter,
      }, { status: 429, headers: { "Retry-After": String(redeemGuard.retryAfter || 300) } });
    }
    const checked = await validateServiceRedeemCode(
      redeemCode,
      items.map((item) => ({ key: item.service, plan: item.plan || item.rocketPlan || "" })),
    );
    if (!checked.ok) {
      await recordRedeemRateFailure(redeemGuard);
      return Response.json({ ok: false, error: checked.error || "invalid_redeem_code" }, { status: 400 });
    }
    serviceRedeem = checked.item;
  }

  // Read user session from cookie if logged in. This links orders to the
  // account even when the buyer types another delivery email.
  const cookie = request.headers.get("cookie") || "";
  const userMatch = cookie.match(/(?:^|;\s*)lm_user=([^;]+)/);
  let userEmail = null;
  if (userMatch) {
    try {
      const session = verifySession(decodeURIComponent(userMatch[1]));
      if (session && session.email) userEmail = session.email;
    } catch (e) {}
  }
  const referral = await resolveReferralForOrder({
    userEmail,
    inviteCode: normalizeInviteCode(body.inviteCode || inviteCodeFromRequest(request)),
  });

  const hasRocketTrial = items.some((item) => item.service === "rocket" && (item.plan === "trial" || item.rocketPlan === "trial"));
  const orderId = makeId("LM");

  // Compute totals(组合优惠档位以站点设置为准)
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const discountRate = items.length >= 3 ? Number(settings.bundle.tier3Rate)
    : items.length >= 2 ? Number(settings.bundle.tier2Rate) : 0;
  const discountLabel = discountRate > 0
    ? `${items.length >= 3 ? "3 件起" : "2 件"} ${fmtDiscount(discountRate, "zh")}`
    : "";
  const bundleFinalAmount = Math.round(subtotal * (1 - discountRate));
  const rocketTrialAmount = items
    .filter((item) => item.service === "rocket" && (item.plan === "trial" || item.rocketPlan === "trial"))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const couponMaxAmount = hasRocketTrial
    ? Math.max(0, Math.round((bundleFinalAmount - rocketTrialAmount) * 100) / 100)
    : bundleFinalAmount;
  const coupon = userEmail && paymentMethod !== "redeem" ? await consumeBestCoupon(userEmail, orderId, couponMaxAmount) : { discount: 0 };
  const couponDiscount = roundMoney(coupon.discount || 0);
  const finalAmount = paymentMethod === "redeem" ? 0 : Math.max(0, Math.round((bundleFinalAmount - couponDiscount) * 100) / 100);
  // USDT:汇率取后台固定值(若设)否则每日自动;折扣取站点设置。
  const usdtRate = settings.usdt.rateOverride ? Number(settings.usdt.rateOverride) : await getUsdtRate();
  const usdtDiscount = Number(settings.usdt.discount) || USDT_DISCOUNT;
  const finalUsdt = Math.round((finalAmount * usdtDiscount / usdtRate) * 100) / 100;
  const quotedPayment = (paymentMethod === "alipay" || paymentMethod === "usdt") && finalAmount > 0;
  const quote = quotedPayment ? verifyPaymentQuote(body.paymentQuoteToken, paymentMethod) : null;
  if (quotedPayment && !quote) {
    await restoreCoupon(userEmail, coupon.couponId, orderId);
    return Response.json({ ok: false, error: "payment_quote_required", message: "付款金额已刷新，请返回支付页重新确认金额" }, { status: 400 });
  }
  const paymentAdjustment = quote ? normalizePaymentAdjustment(quote.paymentAdjustment) : 0;
  const payableAmount = paymentMethod === "alipay" ? roundMoney(Math.max(0.01, finalAmount + paymentAdjustment)) : finalAmount;
  const usdtPrecision = paymentMethod === "usdt" && quote?.usdtPrecision === 4 ? 4 : 6;
  const usdtScale = 10 ** usdtPrecision;
  const usdtNonce = paymentMethod === "usdt" && quote
    ? Math.round(Number(quote.usdtNonce || 0) * usdtScale) / usdtScale
    : 0;
  const usdtPayAmount = Math.round((finalUsdt + usdtNonce) * usdtScale) / usdtScale;
  const paidAmount = paymentMethod === "usdt" ? usdtPayAmount : paymentMethod === "alipay" ? payableAmount : finalAmount;
  const paidCurrency = paymentMethod === "usdt" ? "USDT" : paymentMethod === "redeem" ? "CODE" : "CNY";

  let usdtQuoteClaimed = false;
  if (paymentMethod === "usdt" && finalAmount > 0) {
    usdtQuoteClaimed = await claimUsdtQuote(quote.quoteId, orderId);
    if (!usdtQuoteClaimed) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({
        ok: false,
        error: "payment_quote_used",
        message: "该 USDT 付款金额已提交，请重新生成付款金额",
      }, { status: 409 });
    }
  }

  // Balance payment requires logged-in user with sufficient balance
  if (paymentMethod === "balance") {
    if (!userEmail) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({ ok: false, error: "balance_requires_login" }, { status: 401 });
    }
    const user = await getUser(userEmail);
    const bal = Number(user?.balance || 0);
    if (bal < finalAmount) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({
        ok: false,
        error: "insufficient_balance",
        currentBalance: bal,
        required: finalAmount,
      }, { status: 400 });
    }
  }

  const now = new Date();
  const clientIp = clientIpFromRequest(request);
  const userAgent = clientUserAgentFromRequest(request);

  // 营销渠道归因（首次来源）：读 lm_attr Cookie（Domain=.liumeiti.vip，工具站/主站首访写入），与 referral 并列存进订单。
  let attribution = null;
  try {
    const rawAttr = getCookieFromRequest(request, "lm_attr");
    if (rawAttr) {
      const a = JSON.parse(rawAttr);
      const out = {};
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "referrer", "landing"]) {
        if (typeof a[k] === "string" && a[k]) out[k] = a[k].slice(0, 200);
      }
      if (a.fromTool) out.fromTool = 1;
      if (a.firstTs) out.firstTs = Number(a.firstTs) || 0;
      if (Object.keys(out).length) attribution = out;
    }
  } catch (e) {}

  // Generate subscription links per item using the orderId (one shared link
  // for all rocket items in the cart — a future change can suffix `-{i}` if
  // multiple rocket items per order need separate identifiers).
  items.forEach((it) => {
    if (it.service === "rocket") {
      it.subscriptionLinks = subscriptionLinks(orderId);
    }
  });

  const order = {
    orderId,
    status: "received",
    locale: getCookieFromRequest(request, "locale") === "en" ? "en" : "zh",
    userEmail, // links order to logged-in user (for /account regardless of buyer email)
    referral,
    attribution, // 营销渠道首次来源（utm/referrer/landing/fromTool），用于后台漏斗按来源拆分
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    clientIp,
    userAgent,
    items,
    itemCount: items.length,
    subtotal,
    discountRate,
    discountLabel,
    bundleFinalAmount,
    couponId: coupon.couponId || "",
    couponTitle: coupon.couponTitle || "",
    couponDiscount,
    finalAmount,
    finalUsdt,
    usdtRate,
    usdtPayAmount: paymentMethod === "usdt" ? usdtPayAmount : 0,
    usdtQuoteId: paymentMethod === "usdt" ? (quote?.quoteId || "") : "",
    paymentQuoteIssuedAt: paymentMethod === "usdt" && quote ? new Date(Number(quote.issuedAt)).toISOString() : "",
    paymentQuoteExpiresAt: paymentMethod === "usdt" && quote ? new Date(Number(quote.exp)).toISOString() : "",
    usdtConfirmedAt: "",
    usdtConfirmedAtBeijing: "",
    usdtTxId: "",
    usdtConfirmedAmount: 0,
    paymentAdjustment,
    payableAmount,
    paymentMethod,
    paidAmount,
    paidCurrency,
    redeemCode: paymentMethod === "redeem" ? redeemCode : "",
    redeemCodeType: paymentMethod === "redeem" ? "service" : "",
    redeemServices: serviceRedeem?.services || [],
    email,
    contact,
    remark,
    staffNotes: "",
    completedAt: null,
    completedAtBeijing: null,
    // Legacy fields for backward compat with old query UI
    service: items[0].service,
    serviceLabel: items.length === 1 ? items[0].label : items.map(i => i.label).join(" + "),
    cycle: items[0].cycle,
    account: items[0].account,
    password: items[0].password,
    originalAmount: subtotal,
    currency: "CNY",
  };

  // Deduct balance if paying by balance
  if (paymentMethod === "balance" && userEmail) {
    const user = await getUser(userEmail);
    if (!user) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
    }
    const prev = Number(user.balance || 0);
    const next = Math.round((prev - finalAmount) * 100) / 100;
    if (next < 0) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({ ok: false, error: "insufficient_balance", currentBalance: prev, required: finalAmount }, { status: 400 });
    }
    user.balance = next;
    const savedBalance = await setUser(userEmail, user);
    if (!savedBalance) {
      await restoreCoupon(userEmail, coupon.couponId, orderId);
      return Response.json({ ok: false, error: "balance_deduct_failed" }, { status: 500 });
    }
    const tx = {
      id: makeId("TX"),
      amount: -finalAmount,
      reason: `订单支付 ${order.orderId}`,
      balanceAfter: next,
      source: "order",
      orderId: order.orderId,
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
    };
    await addBalanceTx(userEmail, tx);
    // Also push to global admin ledger so the dashboard sees user spending.
    await pushAdminBalanceLog({ ...tx, email: userEmail, balanceBefore: prev });
    order.paidByBalance = true;
  }

  let consumedServiceCode = null;
  if (paymentMethod === "redeem") {
    consumedServiceCode = await consumeServiceRedeemCode(redeemCode, email, order.orderId, { ip: clientIp, userAgent });
    if (!consumedServiceCode.ok) {
      await recordRedeemRateFailure(redeemGuard);
      return Response.json({ ok: false, error: consumedServiceCode.error || "redeem_code_failed" }, { status: 400 });
    }
    await clearRedeemRateLimit(redeemGuard);
  }

  // 库存占用（任意商品规格;原子扣减;售罄则回滚本次订单所有副作用并拒绝。未配库存的规格=不限,放行）
  const stockReserved = [];
  for (const it of order.items) {
    const res = await reserveStock(it.service, it.plan);
    if (res.ok) {
      if (!res.unlimited) { it.stockReserved = true; stockReserved.push({ service: it.service, plan: it.plan }); }
      continue;
    }
    for (const r of stockReserved) await restoreStock(r.service, r.plan);
    await restoreCoupon(userEmail, coupon.couponId, orderId);
    if (usdtQuoteClaimed) await releaseUsdtQuote(quote.quoteId, orderId);
    if (paymentMethod === "redeem") await restoreServiceRedeemCode(redeemCode, orderId);
    await refundFailedBalanceOrder(order, userEmail, finalAmount, now);
    return Response.json({
      ok: false,
      error: "out_of_stock",
      message: order.locale === "en"
        ? "This plan is sold out. Please pick another plan or contact support."
        : "该规格库存不足，请选择其他规格或联系在线客服",
      soldOutService: it.service,
      soldOutPlan: it.plan,
    }, { status: 409 });
  }

  const deliveries = [];
  const stored = await saveOrderRecord(order);
  deliveries.push({ channel: "storage", ok: Boolean(stored) });
  // 下单成功 → 清除该访客的弃单记录（同 vid = sha256(ip+ua)，与 /api/track 一致）
  if (stored) {
    try {
      const vidKey = createHash("sha256").update(clientIp + "|" + userAgent).digest("hex").slice(0, 24);
      await redisCmd(["ZREM", "lm:cart:index", vidKey]);
      await redisCmd(["DEL", "lm:cart:v:" + vidKey]);
    } catch (e) {}
  }
  if (!stored) {
    for (const r of stockReserved) await restoreStock(r.service, r.plan);
    await restoreCoupon(userEmail, coupon.couponId, orderId);
    if (usdtQuoteClaimed) await releaseUsdtQuote(quote.quoteId, orderId);
    if (paymentMethod === "redeem") await restoreServiceRedeemCode(redeemCode, orderId);
    await refundFailedBalanceOrder(order, userEmail, finalAmount, now);
    return Response.json({ ok: false, error: "storage_failed", orderId: order.orderId, deliveries }, { status: 500 });
  }
  await pushAdminActionLog({
    action: "order_create",
    actor: { staffId: 0, staffUsername: "system" },
    target: "order:" + order.orderId,
    detail: { email: order.email, paymentMethod: order.paymentMethod, paidAmount: order.paidAmount, itemCount: order.itemCount },
  });

  const text = orderText(order);
  const tasks = [
    (settings.notify.telegramEnabled ? sendTelegram(text) : Promise.resolve(null))
      .then((sent) => sent !== null && deliveries.push({ channel: "telegram", ok: sent }))
      .catch(() => deliveries.push({ channel: "telegram", ok: false })),
    sendWebhook(order)
      .then((sent) => sent !== null && deliveries.push({ channel: "webhook", ok: sent }))
      .catch(() => deliveries.push({ channel: "webhook", ok: false })),
    sendOrderEmail(order)
      .then((result) => deliveries.push({ channel: "email", ok: result.ok, info: result }))
      .catch((error) => {
        console.error("[email] outer catch:", error.message);
        deliveries.push({ channel: "email", ok: false, error: error.message });
      }),
  ];
  await Promise.all(tasks);

  // Confirm after the response so USDT submission stays fast. A short retry
  // catches the normal gap between broadcasting and TRON confirmation.
  if (paymentMethod === "usdt" && settings.usdt.autoConfirm) {
    after(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const chain = await confirmPendingUsdtPayments({
            settings,
            actor: { staffId: 0, staffUsername: "order-submit" },
          });
          if (Number(chain.matched || 0) > 0) break;
        } catch (e) {}
        if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 3500));
      }
    });
  }

  // Localize item labels in the response so the checkout "done" screen matches the user's language.
  const respItems = order.items.map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label, order.locale),
    cycle: localizeCycle(it.cycle, order.locale),
  }));
  return Response.json({
    ok: true,
    orderId: order.orderId,
    items: respItems,
    paidAmount,
    paidCurrency,
    paymentMethod,
    couponDiscount,
    deliveries,
  });
}
