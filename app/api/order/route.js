import { buildOrderEmailHtml, buildOrderEmailText } from "./email-template.js";
import {
  consumeBestCoupon, restoreCoupon, verifySession, getUser,
  setUser, addBalanceTx, pushAdminBalanceLog, makeId, roundMoney,
  validateServiceRedeemCode, consumeServiceRedeemCode, restoreServiceRedeemCode,
  checkRedeemRateLimit, recordRedeemRateFailure, clearRedeemRateLimit, redeemRateLimitMessage,
  clientIpFromRequest, clientUserAgentFromRequest,
  inviteCodeFromRequest, normalizeInviteCode, resolveReferralForOrder,
} from "../_utils.js";

const ORDERS_KEY = "liumeiti:orders";

const PRODUCTS = {
  spotify: { label: "Spotify", amount: 128, cycle: "1年", needsAccountPassword: true, needsContact: true, hasPlan: true },
  netflix: { label: "Netflix", amount: 168, cycle: "1年", hasPlan: true },
  disney: { label: "Disney+", amount: 108, cycle: "1年", hasPlan: true },
  max: { label: "HBO Max", amount: 148, cycle: "1年", hasPlan: true },
  rocket: { label: "机场节点", amount: 128, cycle: "1年", hasPlan: true },
};

const ROCKET_PLANS = {
  basic: { id: "basic", label: "普通套餐", amount: 128 },
  pro: { id: "pro", label: "高级套餐", amount: 198 },
  luxury: { id: "luxury", label: "豪华套餐", amount: 398 },
  unlimited: { id: "unlimited", label: "无限套餐", amount: 698 },
  trial: { id: "trial", label: "5元10GB测试", amount: 5, cycle: "次", requiresLogin: false, onePerUser: false },
};
const PRODUCT_PLANS = {
  spotify: {
    member: { id: "member", label: "家庭成员", amount: 128 },
    individual: { id: "individual", label: "个人订阅", amount: 388 },
    duo: { id: "duo", label: "双人订阅", amount: 488 },
    family: { id: "family", label: "家庭套餐", amount: 588 },
  },
  netflix: {
    seat: { id: "seat", label: "单独车位", amount: 168 },
    full: { id: "full", label: "整号购买", amount: 588 },
  },
  disney: {
    seat: { id: "seat", label: "单独车位", amount: 108 },
    full: { id: "full", label: "整号购买", amount: 588 },
  },
  max: {
    seat: { id: "seat", label: "单独车位", amount: 148 },
    full: { id: "full", label: "整号购买", amount: 588 },
  },
  rocket: ROCKET_PLANS,
};
const DEFAULT_PRODUCT_PLANS = {
  spotify: "member",
  netflix: "seat",
  disney: "seat",
  max: "seat",
  rocket: "basic",
};
const DEFAULT_ROCKET_PLAN = DEFAULT_PRODUCT_PLANS.rocket;

function resolveProductPlan(service, value) {
  const plans = PRODUCT_PLANS[service];
  if (!plans) return null;
  const id = clean(value, 20);
  const aliases = service === "rocket" ? { single: "basic" } : {};
  const planId = aliases[id] || id || DEFAULT_PRODUCT_PLANS[service];
  return plans[planId] ? plans[planId] : plans[DEFAULT_PRODUCT_PLANS[service]];
}

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +1 4315093334 / Telegram @MaoyangSupport 联系在线客服";
const USDT_DISCOUNT = 0.9;
const USDT_RATE = 6.85;

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

function bundleDiscountLabel(itemCount) {
  if (itemCount >= 3) return "3 件起 9 折";
  if (itemCount === 2) return "2 件 9.5 折";
  return "";
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function saveOrder(order) {
  const redis = redisConfig();
  if (!redis) return null;
  try {
    const response = await fetch(redis.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + redis.token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["LPUSH", ORDERS_KEY, JSON.stringify(order)],
        ["LTRIM", ORDERS_KEY, "0", "199"],
      ]),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return Array.isArray(result) && result.every((item) => !item.error);
  } catch (error) {
    return false;
  }
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
    lines.push(`💰 实付: ${order.paidAmount} USDT (¥${order.finalAmount} × 0.9 ÷ ${USDT_RATE})`);
  } else if (isBalance) {
    lines.push(`💰 余额扣款: ¥${order.finalAmount}(已自动从用户余额扣除)`);
  } else {
    lines.push(`💰 实付: ¥${order.finalAmount}`);
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
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    console.error("[email] SMTP env missing:", { host: !!host, user: !!user, pass: !!pass, from: !!from });
    return { ok: false, reason: "smtp_env_missing" };
  }
  if (!order.email) return { ok: false, reason: "order_email_missing" };

  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch (error) {
    console.error("[email] nodemailer import failed:", error.message);
    return { ok: false, reason: "nodemailer_import_failed", error: error.message };
  }

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = port === 465;
  const html = buildOrderEmailHtml({
    order, brandName: BRAND_NAME, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL,
    supportContact: SUPPORT_CONTACT, usdtRate: USDT_RATE,
  });
  const text = buildOrderEmailText({
    order, brandName: BRAND_NAME, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, usdtRate: USDT_RATE,
  });
  const subject = order.items.length > 1
    ? `订单确认 ${order.orderId} · ${order.items.length} 件 · ${BRAND_NAME}`
    : `订单确认 ${order.orderId} · ${order.items[0].label} · ${BRAND_NAME}`;

  // Try twice — iCloud SMTP sometimes drops the first connection.
  async function attempt(n) {
    const transporter = nodemailer.createTransport({
      host, port, secure, auth: { user, pass },
      requireTLS: !secure,
      tls: { minVersion: "TLSv1.2" },
      connectionTimeout: 10000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
    try {
      const info = await transporter.sendMail({
        from: `"${BRAND_NAME}" <${from}>`,
        to: order.email,
        subject, text, html,
        priority: "high",
      });
      try { transporter.close(); } catch (e) {}
      return { ok: true, messageId: info.messageId, attempt: n };
    } catch (error) {
      try { transporter.close(); } catch (e) {}
      return { ok: false, error: error.message, code: error.code, response: error.response, attempt: n };
    }
  }

  const r1 = await attempt(1);
  if (r1.ok) {
    console.log(`[email] sent to ${order.email} (msgId=${r1.messageId})`);
    return { ok: true, messageId: r1.messageId };
  }
  console.warn(`[email] order email attempt 1 failed: ${r1.code || "?"} ${r1.error}; retrying...`);
  await new Promise((res) => setTimeout(res, 1500));
  const r2 = await attempt(2);
  if (r2.ok) {
    console.log(`[email] sent to ${order.email} on retry (msgId=${r2.messageId})`);
    return { ok: true, messageId: r2.messageId, retried: true };
  }
  console.error(`[email] both attempts failed for ${order.email}: ${r2.error}`);
  return { ok: false, reason: "send_failed_after_retry", error: r2.error, code: r2.code };
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

  // Validate items first to determine if contact is required (Spotify only)
  const items = [];
  let needsContact = false;
  for (const raw of rawItems) {
    const service = clean(raw.service, 40);
    const product = PRODUCTS[service];
    if (!product) {
      return Response.json({ ok: false, error: "invalid_service:" + service }, { status: 400 });
    }
    const account = clean(raw.account, 80);
    const password = clean(raw.password, 120);
    if (product.needsAccountPassword && (!account || !password)) {
      return Response.json({ ok: false, error: "missing_credentials:" + product.label }, { status: 400 });
    }
    if (product.needsContact) needsContact = true;
    let amount = product.amount;
    let label = product.label;
    let cycle = product.cycle;
    let plan = "";
    let planLabel = "";
    let rocketPlan = "";
    let rocketPlanLabel = "";
    if (product.hasPlan) {
      const planInfo = resolveProductPlan(service, raw.plan || raw.productPlan || raw.rocketPlan);
      plan = planInfo.id;
      planLabel = planInfo.label;
      amount = planInfo.amount;
      cycle = planInfo.cycle || product.cycle;
      label = `${product.label} · ${planInfo.label}`;
      if (service === "rocket") {
        rocketPlan = planInfo.id;
        rocketPlanLabel = planInfo.label;
      }
    }
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
  const orderId = "LM" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Compute totals
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const discountRate = bundleDiscountRate(items.length);
  const discountLabel = bundleDiscountLabel(items.length);
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
  const finalUsdt = Math.round((finalAmount * USDT_DISCOUNT / USDT_RATE) * 100) / 100;
  const paidAmount = paymentMethod === "usdt" ? finalUsdt : finalAmount;
  const paidCurrency = paymentMethod === "usdt" ? "USDT" : paymentMethod === "redeem" ? "CODE" : "CNY";

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
    userEmail, // links order to logged-in user (for /account regardless of buyer email)
    referral,
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

  const deliveries = [];
  const stored = await saveOrder(order);
  deliveries.push({ channel: "storage", ok: Boolean(stored) });
  if (!stored) {
    await restoreCoupon(userEmail, coupon.couponId, orderId);
    if (paymentMethod === "redeem") await restoreServiceRedeemCode(redeemCode, orderId);
    await refundFailedBalanceOrder(order, userEmail, finalAmount, now);
    return Response.json({ ok: false, error: "storage_failed", orderId: order.orderId, deliveries }, { status: 500 });
  }

  const text = orderText(order);
  const tasks = [
    sendTelegram(text)
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

  return Response.json({
    ok: true,
    orderId: order.orderId,
    items: order.items,
    paidAmount,
    paidCurrency,
    paymentMethod,
    couponDiscount,
    deliveries,
  });
}
