import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  getOrdersByInternalReference,
  normalizeInternalReference,
  pushAdminActionLog,
  sendSimpleEmail,
  validEmail,
} from "../../../_utils.js";
import { getSettings } from "../../../_settings.js";
import { appendOrderTimeline, getOrderTimeline } from "../../../_order-timeline.js";
import { buildReferenceNotificationEmail } from "../reference-notification-email.js";

export const runtime = "nodejs";

function publicOrderSummary(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return {
    orderId: order?.orderId || "",
    email: order?.email || "",
    status: order?.status || "received",
    serviceLabel: order?.serviceLabel || items.map((item) => item?.label).filter(Boolean).join(" + "),
    amount: Number(order?.paidAmount || order?.finalAmount || 0),
    currency: order?.paidCurrency || (order?.paymentMethod === "usdt" ? "USDT" : "CNY"),
    createdAtBeijing: order?.createdAtBeijing || "",
  };
}

async function matchingOrders(reference) {
  return (await getOrdersByInternalReference(reference, 500))
    .filter((order) => order && !order.deleted && order.status !== "invalid");
}

function requireStaff(request, permission) {
  const session = adminSessionFromRequest(request);
  if (!session) return { response: Response.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const permissions = adminPermissionProfile(session);
  if (!permissions[permission]) return { response: Response.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  return { session, permissions };
}

export async function GET(request) {
  const auth = requireStaff(request, "canViewOrders");
  if (auth.response) return auth.response;
  const reference = normalizeInternalReference(new URL(request.url).searchParams.get("reference"));
  if (!reference) return Response.json({ ok: false, error: "reference_required" }, { status: 400 });
  const orders = await matchingOrders(reference);
  const recipients = Array.from(new Set(orders.map((order) => String(order.email || "").toLowerCase()).filter(validEmail)));
  return Response.json({
    ok: true,
    reference,
    orders: orders.map(publicOrderSummary),
    recipients,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const auth = requireStaff(request, "canSendMail");
  if (auth.response) return auth.response;
  let body = {};
  try { body = await request.json(); } catch {}
  const reference = normalizeInternalReference(body.reference);
  const subject = clean(body.subject, 160);
  const message = clean(body.message, 2000);
  const selectedIds = new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map((value) => clean(value, 80).toUpperCase()));
  if (!reference) return Response.json({ ok: false, error: "reference_required" }, { status: 400 });
  if (subject.length < 2 || message.length < 2) return Response.json({ ok: false, error: "message_required" }, { status: 400 });

  let orders = await matchingOrders(reference);
  if (selectedIds.size) orders = orders.filter((order) => selectedIds.has(String(order.orderId || "").toUpperCase()));
  if (!orders.length) return Response.json({ ok: false, error: "orders_not_found" }, { status: 404 });

  const grouped = new Map();
  for (const order of orders) {
    const email = String(order.email || "").trim().toLowerCase();
    if (!validEmail(email)) continue;
    if (!grouped.has(email)) grouped.set(email, []);
    grouped.get(email).push(order);
  }
  if (!grouped.size) return Response.json({ ok: false, error: "recipient_missing" }, { status: 409 });

  const settings = await getSettings();
  const actor = adminActorFromSession(auth.session);
  const results = [];
  for (const [email, recipientOrders] of grouped) {
    const locale = recipientOrders.some((order) => order.locale === "en") ? "en" : "zh";
    const timelines = {};
    for (const order of recipientOrders) timelines[order.orderId] = await getOrderTimeline(order, { publicOnly: true });
    const content = buildReferenceNotificationEmail({
      orders: recipientOrders,
      timelines,
      subject,
      message,
      brandName: locale === "en" ? (settings.brand.nameEn || settings.brand.name) : settings.brand.name,
      siteDomain: process.env.SITE_DOMAIN || "www.liumeiti.vip",
      locale,
    });
    const sent = await sendSimpleEmail({
      to: email,
      ...content,
      category: "transactional",
      relatedType: "reference_notice",
      relatedId: reference,
      support: settings.support,
      locale,
    });
    results.push({ email, ok: Boolean(sent?.ok), error: sent?.ok ? "" : clean(sent?.reason || sent?.error || "send_failed", 120) });
    if (sent?.ok) {
      for (const order of recipientOrders) {
        await appendOrderTimeline(order.orderId, {
          type: "customer_notice_sent",
          visibility: "public",
          summaryZh: "客服通知已发送",
          summaryEn: "Customer service notice sent",
          actor: actor.staffUsername,
        });
      }
    }
  }

  const delivered = results.filter((result) => result.ok).length;
  await pushAdminActionLog({
    action: "reference_notice_send",
    actor,
    target: `reference:${reference}`,
    detail: { orders: orders.length, recipients: grouped.size, delivered },
  });
  return Response.json({
    ok: delivered === results.length,
    partial: delivered > 0 && delivered < results.length,
    reference,
    delivered,
    total: results.length,
    results,
  }, { status: delivered ? 200 : 502 });
}
