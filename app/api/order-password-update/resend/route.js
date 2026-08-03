// 客户自助重发「Spotify 密码修正」邮件:修正邮件可能进垃圾箱,客户在订单查询
// (邮箱验证码核验后)可点重发。鉴权复用售后签名 token(after-sales-order,
// 证明 24h 内完成过该订单的邮箱核验);每次重发轮换修正 token 并顺延有效期。
import { createHash } from "node:crypto";
import {
  checkRateLimit,
  clean,
  formatBeijingTime,
  getOrderEntryById,
  rateLimitResponse,
  sendSimpleEmail,
  signSession,
  setOrderAt,
  validEmail,
} from "../../_utils.js";
import { requiredIdempotencyKey } from "../../_money.js";
import { deliverOnce } from "../../_delivery-once.js";
import { verifyAfterSalesToken } from "../../_auth-session.js";
import { getSettings } from "../../_settings.js";
import { buildSpotifyPasswordErrorEmail } from "../email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_ITEMS = 10;

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
  const claim = verifyAfterSalesToken(clean(body.token, 4000));
  if (!claim || normalizeOrderId(claim.orderId) !== orderId) {
    return Response.json({ ok: false, error: "verification_required" }, { status: 401 });
  }
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const operationId = createHash("sha256")
    .update(`spotify-resend|${orderId}|${String(claim.email || "").toLowerCase()}|${idempotency.key}`)
    .digest("hex");

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
  const expectedRevision = Number(order.revision ?? 0);
  if (order.status === "invalid") return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
  if (!validEmail(order.email)) return Response.json({ ok: false, error: "order_email_missing" }, { status: 400 });

  const pendingItems = (order.items || []).filter(itemPendingCorrection);
  if (!pendingItems.length) {
    return Response.json({ ok: false, error: "no_pending_correction" }, { status: 409 });
  }
  if (pendingItems.length > MAX_PENDING_ITEMS) {
    return Response.json({
      ok: false,
      error: "too_many_pending_corrections",
      limit: MAX_PENDING_ITEMS,
      pendingCount: pendingItems.length,
      unprocessedItemIndexes: pendingItems
        .slice(MAX_PENDING_ITEMS)
        .map((item) => order.items.indexOf(item)),
    }, { status: 409 });
  }

  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const now = new Date();
  const selected = pendingItems.map((item) => ({ item, itemIndex: order.items.indexOf(item) }));
  let changed = false;
  for (const { item, itemIndex } of selected) {
    // 轮换 token(旧链接失效)并顺延 7 天,再发一封新邮件。
    const token = signSession({ typ: "spotify-correction-link", orderId, itemIndex, operationId });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (item.passwordCorrectionResendOperationId === operationId && item.passwordCorrectionTokenHash === tokenHash) continue;
    item.passwordCorrectionTokenHash = tokenHash;
    delete item.passwordCorrectionResolvedTokenHash;
    delete item.passwordCorrectionResolvedTokenExpiresAt;
    delete item.passwordCorrectionResolvedOperationId;
    item.passwordCorrectionExpiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
    item.passwordCorrectionResendCount = Number(item.passwordCorrectionResendCount || 0) + 1;
    item.passwordCorrectionResendOperationId = operationId;
    changed = true;
  }

  // Persist the new link before attempting the external delivery. A retry
  // derives the exact same token from its stable operation id.
  if (changed) {
    const saved = await setOrderAt(entry.index, order, { expectedRevision });
    if (!saved) return Response.json({ ok: false, error: "stale_revision" }, { status: 409 });
  }

  const emailResults = [];
  let markerChanged = false;
  for (const { item, itemIndex } of selected) {
    const token = signSession({ typ: "spotify-correction-link", orderId, itemIndex, operationId });

    const updateUrl = `${SITE_URL}/order-update/spotify/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
    const mail = buildSpotifyPasswordErrorEmail({
      order,
      item,
      updateUrl,
      brandName,
      siteDomain: SITE_DOMAIN,
      staffNote: item.passwordCorrectionStaffNote || "",
    });
    const result = await deliverOnce(
      `spotify-resend:${orderId}:${itemIndex}:${operationId}:email`,
      () => sendSimpleEmail({
        to: order.email,
        category: "password_update",
        relatedType: "order",
        relatedId: order.orderId,
        idempotencyKey: `spotify-resend:${orderId}:${itemIndex}:${operationId}`,
        ...mail,
        fromName: brandName,
        support: settings.support,
        locale: order.locale === "en" ? "en" : "zh",
      }),
    );
    const desiredOk = result?.delivered === true;
    const desiredHandled = Boolean(result?.ok && (result?.delivered || result?.terminal || result?.suppressed || result?.skipped));
    const desiredSuppressed = Boolean(result?.suppressed);
    const providerResult = result?.value && typeof result.value === "object" ? result.value : {};
    const desiredError = desiredOk ? "" : clean(providerResult.reason || providerResult.error || result?.error || (desiredSuppressed ? "suppressed" : "send_failed"), 120);
    if (item.passwordCorrectionEmailOperationId !== operationId
      || item.passwordCorrectionEmailOk !== desiredOk
      || item.passwordCorrectionEmailError !== desiredError) {
      item.passwordCorrectionEmailOperationId = operationId;
      item.passwordCorrectionEmailHandledAt = now.toISOString();
      item.passwordCorrectionEmailSuppressed = desiredSuppressed;
      if (desiredOk) {
        item.passwordCorrectionEmailSentAt = now.toISOString();
        item.passwordCorrectionEmailSentAtBeijing = formatBeijingTime(now);
      }
      item.passwordCorrectionEmailOk = desiredOk;
      item.passwordCorrectionEmailError = desiredError;
      markerChanged = true;
    }
    emailResults.push({
      itemIndex,
      delivered: desiredOk,
      handled: desiredHandled,
      suppressed: desiredSuppressed,
      uncertain: Boolean(result?.uncertain),
      error: desiredHandled ? "" : desiredError,
    });
  }

  if (markerChanged) {
    const markerSaved = await setOrderAt(entry.index, order, {
      expectedRevision: Number(order.revision ?? expectedRevision),
    });
    if (!markerSaved) {
      const latest = await getOrderEntryById(orderId);
      return Response.json(
        {
          ok: false,
          error: "stale_revision",
          revision: Number(latest?.order?.revision ?? order.revision ?? expectedRevision),
        },
        { status: 409 },
      );
    }
  }
  const unhandled = emailResults.filter((result) => !result.handled);
  if (unhandled.length) {
    const uncertain = unhandled.some((result) => result.uncertain);
    return Response.json({
      ok: false,
      error: uncertain ? "email_delivery_uncertain" : "email_send_failed",
      retryable: !uncertain,
      manualReview: uncertain,
      failedItemIndexes: unhandled.map((result) => result.itemIndex),
      revision: Number(order.revision ?? expectedRevision),
    }, {
      status: uncertain ? 409 : 502,
      headers: uncertain ? undefined : { "Retry-After": "5" },
    });
  }
  return Response.json({
    ok: true,
    email: emailResults.every((result) => result.delivered),
    suppressed: emailResults.some((result) => result.suppressed),
    deliveredCount: emailResults.filter((result) => result.delivered).length,
    handledCount: emailResults.length,
    revision: Number(order.revision ?? expectedRevision),
  });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
