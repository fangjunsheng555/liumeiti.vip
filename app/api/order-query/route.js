import { createHash, timingSafeEqual } from "node:crypto";
import {
  clean,
  validEmail,
  redisCmd,
  sendSimpleEmail,
  generateNumericCode,
  checkRateLimit,
  rateLimitResponse,
  getOrderById,
  getOrdersByEmail,
  redisConfig,
  getCookieFromRequest,
} from "../_utils.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { buildEmailBrandHeader } from "../email-brand.js";

const QUERY_CODE_TTL_SECONDS = 10 * 60;
const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return clean(value, 200).toLowerCase().trim();
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

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(clean(username, 80));
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function publicOrder(order, type, locale = "zh") {
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => {
      const account = it.staffAccount || it.account || "";
      const password = it.staffPassword || it.password || "";
      const out = {
        service: it.service || "",
        label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label || "", locale),
        cycle: localizeCycle(it.cycle || "", locale),
        amount: Number(it.amount || 0),
        account,
        password,
      };
      if (it.service === "rocket") {
        out.subscriptionLinks = subscriptionLinks(order.orderId) || it.subscriptionLinks;
      } else if (it.subscriptionLinks) {
        out.subscriptionLinks = it.subscriptionLinks;
      }
      return out;
    });
  } else {
    const it = {
      service: order.service || "",
      label: localizeOrderItemLabel(order.service, order.plan || order.rocketPlan, order.serviceLabel || "", locale),
      cycle: localizeCycle(order.cycle || "", locale),
      amount: Number(order.finalAmount || 0),
      account: order.account || "",
      password: order.password || "",
    };
    if (it.service === "rocket") it.subscriptionLinks = subscriptionLinks(order.orderId);
    items = [it];
  }

  const output = {
    matchType: type || "",
    orderId: order.orderId || "",
    status: order.status || "received",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
    staffNotes: order.staffNotes || "",
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
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    service: items[0]?.service || "",
    cycle: items[0]?.cycle || "",
    account: items[0]?.account || "",
    password: items[0]?.password || "",
  };
  if (output.service === "rocket" && output.account) {
    output.subscriptionLinks = subscriptionLinks(output.account);
  }
  // 无效/未付订单不释放开通凭据（账号/密码/订阅链接）——仅 received/completed 可见。
  if (order.status === "invalid") {
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

async function readBody(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function verificationKey(email, query) {
  const digest = createHash("sha256")
    .update(normalizeEmail(email) + "|" + normalizeOrderId(query || normalizeEmail(query)))
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

function safeEqualCode(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  try { return timingSafeEqual(left, right); } catch (error) { return false; }
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
    subject: L(`${brandName} · 订单查询验证码 ${code}`, `${brandName} · Order lookup code ${code}`),
    text,
    html,
  });
}

async function storeVerificationCode(email, query, code) {
  const payload = JSON.stringify({ email: normalizeEmail(email), query: clean(query, 160), code, createdAt: new Date().toISOString() });
  const result = await redisCmd(["SET", verificationKey(email, query), payload, "EX", String(QUERY_CODE_TTL_SECONDS)]);
  return result === "OK";
}

async function verifyCode(email, query, code) {
  const raw = await redisCmd(["GET", verificationKey(email, query)]);
  if (!raw) return false;
  let record = null;
  try { record = JSON.parse(raw); } catch (error) { record = null; }
  const ok = record && normalizeEmail(record.email) === normalizeEmail(email) && safeEqualCode(record.code, code);
  if (ok) await redisCmd(["DEL", verificationKey(email, query)]);
  return ok;
}

async function handle(request) {
  const body = await readBody(request);
  const query = clean(body.query || body.q || "", 160);
  const code = clean(body.code || body.verificationCode || "", 20).replace(/\s+/g, "");
  const locale = getCookieFromRequest(request, "locale") === "en" ? "en" : "zh";
  const headers = { "Cache-Control": "no-store, max-age=0" };

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
    const guard = await checkRateLimit(request, {
      namespace: "order-query:send",
      limit: 5,
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

  const verifyGuard = await checkRateLimit(request, {
    namespace: "order-query:verify",
    limit: 10,
    windowSec: 15 * 60,
    identity: recipient + "|" + query,
  });
  if (!verifyGuard.ok) return rateLimitResponse(verifyGuard, "验证码校验过于频繁，请稍后再试");
  if (!/^\d{6}$/.test(code) || !(await verifyCode(recipient, query, code))) {
    return Response.json({ ok: false, error: "code_invalid_or_expired" }, { status: 400, headers });
  }

  return Response.json({
    ok: true,
    configured: true,
    verified: true,
    orders: matched.map((order) => publicOrder(order, matchType(type), locale)),
  }, { headers });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export async function POST(request) {
  return handle(request);
}
