import { createHash } from "node:crypto";
import {
  clean,
  validEmail,
  redisCmd,
  sendSimpleEmail,
  generateNumericCode,
  checkCriticalRateLimit,
  rateLimitResponse,
  getOrderById,
  getOrdersByEmail,
  redisConfig,
  getCookieFromRequest,
} from "../_utils.js";
import {
  NETFLIX_ORDER_VERIFICATION_COOKIE,
  NETFLIX_ORDER_VERIFICATION_TTL_SECONDS,
  readUserAuthState,
  signAfterSalesToken,
  signNetflixOrderVerification,
} from "../_auth-session.js";
import { netflixOrderIdentity } from "../netflix-code/_ownership.js";
import { canonicalOrderQuery } from "../../lib/order-query-identity.js";
import { rocketSubscriptionUrl, readRocketSubscriptionUrl } from "../../lib/rocket-subscription.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { buildEmailBrandHeader } from "../email-brand.js";
import { getActiveAfterSalesTickets, publicAfterSalesSummary } from "../after-sales/_store.js";
import { orderExpirySummary, renewalCheckoutPath } from "../../lib/order-expiry.js";
import { getSpotifyPasswordAttention } from "../../lib/order-attention.js";
import { effectiveQuoteStatus } from "../_quote-expiry.js";
import {
  orderItemService,
  publicNetflixStaffNotes,
} from "../../lib/netflix-delivery.js";

const QUERY_CODE_TTL_SECONDS = 10 * 60;
const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function looksLikeOrderId(value) {
  return /^LM[A-Z0-9]{8,}$/.test(normalizeOrderId(value));
}

function queryType(rawQuery) {
  if (validEmail(rawQuery)) return "email";
  if (looksLikeOrderId(rawQuery)) return "orderId";
  return "";
}

function orderMatches(order, query, type) {
  if (type === "orderId") return normalizeOrderId(order.orderId) === normalizeOrderId(query);
  if (type === "email") return normalizeEmail(order.email) === normalizeEmail(query);
  return false;
}

function matchType(type) {
  return type === "orderId" ? "orderId" : type === "email" ? "email" : "";
}

function publicOrder(order, type, locale = "zh", netflixUserSelfServiceEnabled = true) {
  const hasStoredNetflixDeliveryMode = order.netflixDeliveryMode !== undefined
    && order.netflixDeliveryMode !== null
    && order.netflixDeliveryMode !== "";
  const netflixDeliveryMode = ["self_service", "password"].includes(order.netflixDeliveryMode)
    ? order.netflixDeliveryMode
    : hasStoredNetflixDeliveryMode ? "password" : "legacy";
  const netflixSelfServiceDelivery = netflixDeliveryMode === "self_service";
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it, index) => {
      const service = orderItemService(order, it, index);
      // Top-level credentials are a legacy mirror of items[0]. Never apply
      // them to a later Netflix item in a mixed-service order.
      const legacyAccount = index === 0 ? order.staffAccount || order.account || "" : "";
      const legacyPassword = index === 0 ? order.staffPassword || order.password || "" : "";
      const account = it.staffAccount || it.account || legacyAccount;
      const password = service === "netflix" && netflixSelfServiceDelivery
        ? ""
        : it.staffPassword || it.password || legacyPassword;
      const out = {
        service,
        label: localizeOrderItemLabel(service, it.plan || it.rocketPlan, it.label || "", locale),
        cycle: localizeCycle(it.cycle || "", locale),
        amount: Number(it.amount || 0),
        plan: it.plan || it.rocketPlan || "",
        platformUrl: it.platformUrl || "",
        productPrice: it.productPrice || "",
        account,
        password,
      };
      if (service === "rocket") {
        out.subscriptionLinks = rocketSubscriptionUrl(order.orderId);
      } else if (it.subscriptionLinks) {
        out.subscriptionLinks = readRocketSubscriptionUrl(it.subscriptionLinks);
      }
      return out;
    });
  } else {
    const account = order.staffAccount || order.account || "";
    const service = orderItemService(order, order, 0);
    const password = service === "netflix" && netflixSelfServiceDelivery
      ? ""
      : order.staffPassword || order.password || "";
    const it = {
      service,
      label: localizeOrderItemLabel(service, order.plan || order.rocketPlan, order.serviceLabel || "", locale),
      cycle: localizeCycle(order.cycle || "", locale),
      amount: Number(order.finalAmount || 0),
      account,
      password,
    };
    if (it.service === "rocket") it.subscriptionLinks = rocketSubscriptionUrl(order.orderId);
    items = [it];
  }

  const netflixAccounts = items
    .filter((item) => item.service === "netflix")
    .map((item) => String(item.account || "").trim().toLowerCase());
  const netflixSelfServiceEnabled = netflixDeliveryMode !== "password"
    && order.netflixSelfServiceEnabled !== false
    && netflixUserSelfServiceEnabled
    && netflixAccounts.length > 0
    && netflixAccounts.every(validEmail)
    && new Set(netflixAccounts).size === 1;
  const staffNotes = publicNetflixStaffNotes(order, {
    onlineCodeAvailable: netflixSelfServiceEnabled,
  });
  const output = {
    matchType: type || "",
    orderId: order.orderId || "",
    orderType: order.orderType || "standard",
    status: effectiveQuoteStatus(order),
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
    staffNotes,
    items,
    itemCount: items.length,
    serviceLabel: items.map((i) => i.label).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    redeemCode: order.redeemCode || "",
    subtotal: Number(order.subtotal || order.originalAmount || items.reduce((s, i) => s + i.amount, 0)),
    discountRate: Number(order.discountRate || 0),
    discountLabel: order.discountLabel || "",
    finalAmount: Number(order.finalAmount || 0),
    finalUsdt: Number(order.finalUsdt || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    platformUrl: order.platformUrl || items[0]?.platformUrl || "",
    productPrice: order.productPrice || items[0]?.productPrice || "",
    quoteAmount: Number(order.quoteAmount || 0),
    quotedAtBeijing: order.quotedAtBeijing || "",
    quoteExpiresAt: order.quoteExpiresAt || "",
    quoteExpiresAtBeijing: order.quoteExpiresAtBeijing || "",
    quoteValidDays: Number(order.quoteValidDays || 7),
    paymentSubmittedAtBeijing: order.paymentSubmittedAtBeijing || "",
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    service: items[0]?.service || "",
    cycle: items[0]?.cycle || "",
    account: items[0]?.account || "",
    password: items[0]?.password || "",
    netflixDeliveryMode,
    netflixSelfServiceEnabled,
  };
  if (output.service === "rocket") {
    output.subscriptionLinks = rocketSubscriptionUrl(order.orderId);
  }
  // 服务到期摘要(仅已完成且有周期的订单)+ 一键续费预填路径
  const expiry = orderExpirySummary(order);
  if (expiry) {
    output.expiry = { expiresAt: expiry.expiresAt, daysLeft: expiry.daysLeft, expired: expiry.expired };
    output.renewPath = renewalCheckoutPath(order);
  }
  // Spotify 密码修正待办:修正邮件可能进垃圾箱,查询结果里也要可见
  if (getSpotifyPasswordAttention(order).pending) output.passwordCorrectionPending = true;
  // 无效/未付订单不释放开通凭据（账号/密码/订阅链接）——仅 received/completed 可见。
  if (["invalid", "awaiting_quote", "pending_payment", "quote_expired"].includes(output.status)) {
    output.account = "";
    output.password = "";
    delete output.subscriptionLinks;
    output.items = (Array.isArray(output.items) ? output.items : []).map((it) => {
      const { account, password, subscriptionLinks: _s, ...rest } = it;
      return rest;
    });
  }
  return output;
}

function mayUseNetflixSelfService(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const hasNetflix = items.some((item, index) => orderItemService(order, item, index) === "netflix")
    || (!items.length && orderItemService(order, order, 0) === "netflix");
  if (!hasNetflix || order?.netflixSelfServiceEnabled === false) return false;
  const mode = order?.netflixDeliveryMode;
  const hasStoredMode = mode !== undefined && mode !== null && mode !== "";
  return !hasStoredMode || mode === "self_service";
}

export async function netflixUserStatesByOwner(orders, readState = readUserAuthState) {
  const pending = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!mayUseNetflixSelfService(order)) continue;
    const { ownerEmail } = netflixOrderIdentity(order);
    if (!ownerEmail || pending.has(ownerEmail)) continue;
    pending.set(ownerEmail, Promise.resolve()
      .then(() => readState(ownerEmail))
      .catch(() => null));
  }
  const resolved = new Map();
  await Promise.all(Array.from(pending, async ([ownerEmail, statePromise]) => {
    resolved.set(ownerEmail, await statePromise);
  }));
  return resolved;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function verificationKey(email, query) {
  const digest = createHash("sha256")
    .update(normalizeEmail(email) + "|" + canonicalOrderQuery(query))
    .digest("hex");
  return "liumeiti:order-query-code:" + digest;
}

function maskEmail(email) {
  const [name, domain] = normalizeEmail(email).split("@");
  if (!name || !domain) return "下单邮箱";
  const head = name.slice(0, 2);
  const tail = name.length > 4 ? name.slice(-2) : "";
  return `${head}${"*".repeat(Math.max(2, Math.min(6, name.length - head.length - tail.length)))}${tail}@${domain}`;
}

function netflixOrderVerificationCookie(request, token) {
  const production = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
  let https = false;
  try { https = new URL(request.url).protocol === "https:"; } catch {}
  const secure = production || https ? "; Secure" : "";
  return `${NETFLIX_ORDER_VERIFICATION_COOKIE}=${encodeURIComponent(token)}; Path=/api/netflix-code; HttpOnly; SameSite=Lax; Max-Age=${NETFLIX_ORDER_VERIFICATION_TTL_SECONDS}${secure}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendQueryCode(email, code, query, locale) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const safeCode = escapeHtml(code);
  const safeQuery = escapeHtml(query);
  // 品牌以站点设置为准
  const { getSettings } = await import("../_settings.js");
  const settings = await getSettings();
  const brandName = (en ? settings.brand.nameEn : settings.brand.name) || BRAND_NAME;
  const html = `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
        ${buildEmailBrandHeader({ brandName, siteDomain: SITE_DOMAIN, label: L("订单查询", "Order Lookup") })}
        <tr><td style="padding:30px 32px 14px;">
          <h2 style="margin:0 0 8px;font-size:20px;font-weight:900;color:#0f172a;letter-spacing:-0.02em;">${L("订单查询验证码", "Order lookup code")}</h2>
          <p style="margin:0 0 18px;font-size:13.5px;line-height:1.7;color:#475569;">${L(`你正在查询 ${brandName} 订单 ${safeQuery}。请在 10 分钟内输入下方验证码查看订单详情。`, `You're looking up your ${brandName} order ${safeQuery}. Enter the code below within 10 minutes to view the order details.`)}</p>
          <div style="margin:0 auto;padding:18px 24px;border-radius:14px;background:#f0fdfa;border:1px solid #a7f3d0;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">${L("验证码", "Code")}</div>
            <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:900;color:#134e4a;letter-spacing:.18em;">${safeCode}</div>
            <div style="margin-top:6px;font-size:11px;color:#0f766e;">${L("有效期 10 分钟", "Valid for 10 minutes")}</div>
          </div>
        </td></tr>
        <tr><td style="padding:14px 32px 28px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="color:#0f172a;font-size:13px;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(brandName)}</td>
              <td style="text-align:right;color:#94a3b8;font-size:11.5px;">${escapeHtml(SITE_DOMAIN)}</td>
            </tr>
          </table>
          <p style="margin:10px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.6;">${L("本邮件由系统自动发送，请勿直接回复。若非本人操作，请忽略本邮件。", "This email was sent automatically — please don't reply. If this wasn't you, please ignore it.")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = L(`${brandName} 订单查询验证码\n\n订单查询: ${query}\n验证码: ${code}\n有效期 10 分钟\n\n若非本人操作，请忽略本邮件。`, `${brandName} order lookup code\n\nOrder lookup: ${query}\nCode: ${code}\nValid for 10 minutes\n\nIf this wasn't you, please ignore this email.`);
  return sendSimpleEmail({
    to: email,
    category: "verification",
    relatedType: "order_lookup",
    relatedId: query,
    subject: L(`${brandName} · 订单查询验证码 ${code}`, `${brandName} · Order lookup code ${code}`),
    text,
    html,
    support: settings.support,
    locale,
  });
}

async function storeVerificationCode(email, query, code) {
  // Bind the code to the same canonical query its key is built from. Storing
  // the raw keystrokes makes the record stricter than its own key: the lookup
  // finds the code and the comparison in verifyCode then rejects it.
  const payload = JSON.stringify({ email: normalizeEmail(email), query: canonicalOrderQuery(query), code, createdAt: new Date().toISOString() });
  const result = await redisCmd(["SET", verificationKey(email, query), payload, "EX", String(QUERY_CODE_TTL_SECONDS)]);
  return result === "OK";
}

async function verifyCode(email, query, code) {
  const script = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 'missing' end
local decoded,record=pcall(cjson.decode,raw)
if not decoded or type(record)~='table' then return 'invalid' end
if tostring(record.email or '')~=ARGV[1] or tostring(record.code or '')~=ARGV[3] then
  return 'invalid'
end
local storedQuery=tostring(record.query or '')
if storedQuery~=ARGV[2] and storedQuery~=ARGV[4] then
  return 'invalid'
end
redis.call('DEL',KEYS[1])
return 'matched'`;
  const result = await redisCmd([
    "EVAL",
    script,
    "1",
    verificationKey(email, query),
    normalizeEmail(email),
    canonicalOrderQuery(query),
    String(code || ""),
    // ARGV[4] keeps codes issued before this deploy verifiable: those records
    // still hold the raw query. New records only ever store the canonical form.
    clean(query, 160),
  ]);
  return result === "matched";
}

async function handle(request) {
  const body = await readBody(request);
  const query = clean(body.query || body.q || "", 160);
  const code = clean(body.code || body.verificationCode || "", 20).replace(/\s+/g, "");
  const locale = getCookieFromRequest(request, "locale") === "en" ? "en" : "zh";
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });

  if (!query) {
    return Response.json({ ok: false, error: "query_required" }, { status: 400, headers });
  }
  const type = queryType(query);
  if (!type) {
    return Response.json({ ok: false, error: "invalid_query" }, { status: 400, headers });
  }

  if (!redisConfig()) {
    return Response.json({ ok: true, configured: false, orders: [] }, { headers });
  }
  const matched = type === "orderId"
    ? [await getOrderById(query)].filter((order) => order && orderMatches(order, query, type))
    : (await getOrdersByEmail(query, 50)).filter((order) => orderMatches(order, query, type)).slice(0, 10);
  if (matched.length === 0) {
    return Response.json({ ok: true, configured: true, orders: [] }, { headers });
  }

  const recipient = type === "email" ? normalizeEmail(query) : normalizeEmail(matched[0]?.email);
  if (!validEmail(recipient)) {
    return Response.json({ ok: false, error: "order_email_missing" }, { status: 400, headers });
  }

  if (!code) {
    const guard = await checkCriticalRateLimit(request, {
      namespace: "order-query:send",
      identityLimit: 5,
      ipLimit: 30,
      windowSec: 15 * 60,
      identity: recipient + "|" + query,
    });
    if (!guard.ok) return rateLimitResponse(guard, "订单查询验证码请求过多，请稍后再试");

    const nextCode = generateNumericCode(6);
    const stored = await storeVerificationCode(recipient, query, nextCode);
    if (!stored) return Response.json({ ok: false, error: "verification_store_failed" }, { status: 502, headers });
    const sent = await sendQueryCode(recipient, nextCode, query, locale);
    if (!sent.ok) {
      return Response.json({ ok: false, error: "verification_email_failed" }, { status: 502, headers });
    }
    return Response.json({
      ok: true,
      configured: true,
      verificationRequired: true,
      emailHint: maskEmail(recipient),
      expiresIn: QUERY_CODE_TTL_SECONDS,
      orders: [],
    }, { headers });
  }

  const verifyGuard = await checkCriticalRateLimit(request, {
    namespace: "order-query:verify",
    identityLimit: 10,
    ipLimit: 80,
    windowSec: 15 * 60,
    identity: recipient + "|" + query,
  });
  if (!verifyGuard.ok) return rateLimitResponse(verifyGuard, "验证码校验过于频繁，请稍后再试");
  if (!/^\d{6}$/.test(code) || !(await verifyCode(recipient, query, code))) {
    return Response.json({ ok: false, error: "code_invalid_or_expired" }, { status: 400, headers });
  }

  const activeTickets = await getActiveAfterSalesTickets(matched.map((order) => order.orderId));
  const netflixOwnerStates = await netflixUserStatesByOwner(matched);
  const verifiedOrders = matched.map((order) => {
    const eligible = order.status !== "invalid";
    const activeTicket = eligible ? activeTickets[normalizeOrderId(order.orderId)] : null;
    const { ownerEmail } = netflixOrderIdentity(order);
    const ownerState = ownerEmail ? netflixOwnerStates.get(ownerEmail) : null;
    const netflixUserSelfServiceEnabled = !(ownerState?.ok && ownerState.user?.netflixSelfServiceDisabled);
    return {
      ...publicOrder(order, matchType(type), locale, netflixUserSelfServiceEnabled),
      afterSalesEligible: eligible,
      afterSalesToken: eligible ? signAfterSalesToken({
        orderId: normalizeOrderId(order.orderId),
        email: normalizeEmail(order.email),
      }) : "",
      afterSalesTicket: publicAfterSalesSummary(activeTicket),
    };
  });

  const netflixVerification = signNetflixOrderVerification({
    email: recipient,
    orderIds: verifiedOrders.map((order) => normalizeOrderId(order.orderId)),
  });
  if (netflixVerification) {
    headers.set("Set-Cookie", netflixOrderVerificationCookie(request, netflixVerification));
  }

  return Response.json({
    ok: true,
    configured: true,
    verified: true,
    orders: verifiedOrders,
  }, { headers });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export async function POST(request) {
  return handle(request);
}
