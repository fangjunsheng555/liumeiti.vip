// 客户自助重发「Spotify 密码修正」邮件:修正邮件可能进垃圾箱,客户在订单查询
// (邮箱验证码核验后)可点重发。鉴权复用售后签名 token(after-sales-order,
// 证明 24h 内完成过该订单的邮箱核验);每次重发轮换修正 token 并顺延有效期。
import { createHash, randomBytes } from "node:crypto";
import {
  checkRateLimit,
  clean,
  formatBeijingTime,
  getOrderEntryById,
  rateLimitResponse,
  sendSimpleEmail,
  setOrderAt,
  validEmail,
  verifySession,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { buildSpotifyPasswordErrorEmail } from "../email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function itemPendingCorrection(item) {
  if (item?.service !== "spotify") return false;
  const requestedAt = new Date(item.passwordCorrectionRequestedAt || 0).getTime();
  if (!Number.isFinite(requestedAt) || requestedAt <= 0) return false;
  const updatedAt = new Date(item.customerPasswordUpdatedAt || 0).getTime();
  return !(Number.isFinite(updatedAt) && updatedAt >= requestedAt);
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const orderId = normalizeOrderId(body.orderId);
  const claim = verifySession(clean(body.token, 4000));
  if (!claim || claim.type !== "after-sales-order" || normalizeOrderId(claim.orderId) !== orderId) {
    return Response.json({ ok: false, error: "verification_required" }, { status: 401 });
  }

  const guard = await checkRateLimit(request, {
    namespace: "order-pw-update:resend",
    limit: 3,
    windowSec: 60 * 60,
    identity: orderId,
  });
  if (!guard.ok) return rateLimitResponse(guard, "重发过于频繁，请稍后再试");

  const entry = await getOrderEntryById(orderId);
  if (!entry || String(entry.order.email || "").toLowerCase() !== String(claim.email || "").toLowerCase()) {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  const { order } = entry;
  if (order.status === "invalid") return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
  if (!validEmail(order.email)) return Response.json({ ok: false, error: "order_email_missing" }, { status: 400 });

  const pendingItems = (order.items || []).filter(itemPendingCorrection);
  if (!pendingItems.length) {
    return Response.json({ ok: false, error: "no_pending_correction" }, { status: 409 });
  }

  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const now = new Date();
  let emailOk = false;
  for (const item of pendingItems.slice(0, 2)) {
    // 轮换 token(旧链接失效)并顺延 7 天,再发一封新邮件。
    const token = randomBytes(32).toString("base64url");
    item.passwordCorrectionTokenHash = createHash("sha256").update(token).digest("hex");
    item.passwordCorrectionExpiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
    item.passwordCorrectionResendCount = Number(item.passwordCorrectionResendCount || 0) + 1;

    const updateUrl = `${SITE_URL}/order-update/spotify/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
    const mail = buildSpotifyPasswordErrorEmail({
      order,
      item,
      updateUrl,
      brandName,
      siteDomain: SITE_DOMAIN,
      staffNote: item.passwordCorrectionStaffNote || "",
    });
    const result = await sendSimpleEmail({
      to: order.email,
      ...mail,
      fromName: brandName,
      support: settings.support,
      locale: order.locale === "en" ? "en" : "zh",
    }).catch(() => ({ ok: false }));
    item.passwordCorrectionEmailSentAt = now.toISOString();
    item.passwordCorrectionEmailSentAtBeijing = formatBeijingTime(now);
    item.passwordCorrectionEmailOk = Boolean(result?.ok);
    item.passwordCorrectionEmailError = result?.ok ? "" : clean(result?.reason || result?.error || "send_failed", 120);
    emailOk = emailOk || Boolean(result?.ok);
  }

  const saved = await setOrderAt(entry.index, order);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  if (!emailOk) return Response.json({ ok: false, error: "email_send_failed" }, { status: 502 });
  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
