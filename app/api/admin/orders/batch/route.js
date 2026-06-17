import {
  getAllOrdersWithIndex, setOrderAt, softDeleteOrderAt,
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, formatBeijingTime, isRootAdminSession, adminPermissionProfile,
  clean, sendSimpleEmail,
} from "../../../_utils.js";
import { buildInvalidOrderEmailHtml, buildInvalidOrderEmailText } from "../../../order/invalid-email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +1 4315093334 / Telegram @MaoyangSupport 联系在线客服";

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

async function sendInvalidOrderEmail(order) {
  const emailLocale = order.locale === "en" ? "en" : "zh";
  const html = buildInvalidOrderEmailHtml({
    order,
    brandName: BRAND_NAME,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact: SUPPORT_CONTACT,
    locale: emailLocale,
  });
  const text = buildInvalidOrderEmailText({
    order,
    brandName: BRAND_NAME,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact: SUPPORT_CONTACT,
    locale: emailLocale,
  });
  return sendSimpleEmail({
    to: order.email,
    subject: emailLocale === "en"
      ? `Order ${order.orderId}: payment not received, marked invalid · ${BRAND_NAME}`
      : `订单 ${order.orderId} 未收到付款，已标记无效 · ${BRAND_NAME}`,
    text,
    html,
    fromName: BRAND_NAME,
  });
}

// POST /api/admin/orders/batch
// body: { orderIds: string[], action: "delete" | "invalid" }
export async function POST(request) {
  const session = adminSession(request);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const actor = adminActorFromRequest(request);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const orderIds = Array.isArray(body.orderIds)
    ? body.orderIds.filter((s) => typeof s === "string" && s.length > 0).slice(0, 200)
    : [];
  const action = body.action === "delete" ? "delete" : body.action === "invalid" ? "invalid" : null;

  if (orderIds.length === 0) {
    return Response.json({ ok: false, error: "no_order_ids" }, { status: 400 });
  }
  if (!action) {
    return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  if (!adminPermissionProfile(session).canEditOrders) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (action === "delete" && !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const all = await getAllOrdersWithIndex();
  const idSet = new Set(orderIds);
  const matched = all.filter((entry) =>
    entry.order && entry.order.orderId && idSet.has(entry.order.orderId) && !entry.order.deleted
  );

  const results = [];
  for (const entry of matched) {
    if (action === "delete") {
      const ok = await softDeleteOrderAt(entry.index, entry.order.orderId, {
        deletedByStaffId: actor.staffId,
        deletedByStaffUsername: actor.staffUsername,
      });
      results.push({ orderId: entry.order.orderId, ok });
    } else if (action === "invalid") {
      const order = entry.order;
      if (order.status !== "invalid") {
        const now = new Date();
        order.status = "invalid";
        order.invalidAt = now.toISOString();
        order.invalidAtBeijing = formatBeijingTime(now);
        order.completedAt = null;
        order.completedAtBeijing = null;
        order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
        order.staffAudit.unshift({
          id: "OA" + Date.now().toString(36).toUpperCase(),
          staffId: actor.staffId,
          staffUsername: actor.staffUsername,
          label: adminActorLabel(actor),
          action: "batch_invalid",
          status: "invalid",
          createdAt: now.toISOString(),
          createdAtBeijing: formatBeijingTime(now),
        });
        order.staffAudit = order.staffAudit.slice(0, 30);
        const ok = await setOrderAt(entry.index, order);
        let invalidEmailResult = null;
        if (ok) {
          invalidEmailResult = await sendInvalidOrderEmail(order);
          const noticeAt = new Date();
          order.invalidEmailNoticeAt = noticeAt.toISOString();
          order.invalidEmailNoticeAtBeijing = formatBeijingTime(noticeAt);
          order.invalidEmailNoticeOk = Boolean(invalidEmailResult?.ok);
          order.invalidEmailNoticeError = invalidEmailResult?.ok ? "" : clean(invalidEmailResult?.reason || invalidEmailResult?.error || "send_failed", 120);
          await setOrderAt(entry.index, order);
        }
        results.push({ orderId: entry.order.orderId, ok, invalidNotice: invalidEmailResult });
      } else {
        results.push({ orderId: entry.order.orderId, ok: true, alreadyInvalid: true });
      }
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const notFound = orderIds.filter((id) => !matched.some((e) => e.order.orderId === id));
  await pushAdminActionLog({
    action: "order_batch_" + action,
    actor,
    target: "orders:" + successCount,
    detail: { orderIds, successCount, notFound },
  });

  return Response.json({
    ok: true,
    action,
    matchedCount: matched.length,
    successCount,
    failedCount: results.length - successCount,
    notFound,
    results,
  });
}
