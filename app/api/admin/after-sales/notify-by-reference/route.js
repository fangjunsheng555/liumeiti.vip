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
import { appendOrderTimelineOnce } from "../../../_order-timeline.js";
import { deliverOnce } from "../../../_delivery-once.js";
import {
  claimDurableOperation,
  completeDurableOperation,
  ensureDurableOperationPlan,
} from "../../../_durable-operation.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../../_money.js";
import { buildReferenceNotificationEmail } from "../reference-notification-email.js";
import { createHash } from "node:crypto";

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

function referenceNoticeOrderSnapshot(order) {
  return {
    orderId: clean(order?.orderId, 80).toUpperCase(),
    serviceLabel: clean(order?.serviceLabel, 300),
    locale: order?.locale === "en" ? "en" : "zh",
    remark: clean(order?.remark, 1500),
    staffNotes: clean(order?.staffNotes, 3000),
    account: clean(order?.account, 200),
    password: clean(order?.password, 300),
    staffAccount: clean(order?.staffAccount, 200),
    staffPassword: clean(order?.staffPassword, 300),
    items: (Array.isArray(order?.items) ? order.items : []).map((item) => ({
      label: clean(item?.label, 240),
      cycle: clean(item?.cycle, 80),
      service: clean(item?.service, 80),
      account: clean(item?.account, 200),
      password: clean(item?.password, 300),
      staffAccount: clean(item?.staffAccount, 200),
      staffPassword: clean(item?.staffPassword, 300),
      subscriptionLinks: item?.subscriptionLinks && typeof item.subscriptionLinks === "object" ? {
        shadowrocket: clean(item.subscriptionLinks.shadowrocket, 1000),
        clash: clean(item.subscriptionLinks.clash, 1000),
      } : null,
    })),
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
  const requestedOrderIds = Array.from(new Set((Array.isArray(body.orderIds) ? body.orderIds : [])
    .map((value) => clean(value, 80).toUpperCase())
    .filter(Boolean))).sort();
  const selectedIds = new Set(requestedOrderIds);
  if (!reference) return Response.json({ ok: false, error: "reference_required" }, { status: 400 });
  if (subject.length < 2 || message.length < 2) return Response.json({ ok: false, error: "message_required" }, { status: 400 });

  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const actor = adminActorFromSession(auth.session);
  const requestHash = idempotencyPayloadHash({ reference, orderIds: requestedOrderIds, subject, message });
  const operation = await claimDurableOperation({
    scope: "admin-reference-notice",
    principal: reference,
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, {
      status: operation.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (operation.state === "done") {
    const replay = operation.record.result || { ok: true, reference };
    return Response.json({ ...replay, idempotent: true });
  }

  let orders = await matchingOrders(reference);
  if (selectedIds.size) orders = orders.filter((order) => selectedIds.has(String(order.orderId || "").toUpperCase()));
  let plan = operation.record.plan;
  if (!plan) {
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
    const proposedPlan = {
      reference,
      orderIds: orders.map((order) => String(order.orderId || "").toUpperCase()).filter(Boolean).sort(),
      recipients: [...grouped.entries()].map(([email, recipientOrders]) => ({
        email,
        orderIds: recipientOrders.map((order) => String(order.orderId || "").toUpperCase()).filter(Boolean).sort(),
        orders: recipientOrders.map(referenceNoticeOrderSnapshot),
        locale: recipientOrders.some((order) => order.locale === "en") ? "en" : "zh",
      })).sort((left, right) => left.email.localeCompare(right.email)),
      emailContext: {
        brandName: settings.brand.name,
        brandNameEn: settings.brand.nameEn,
        siteDomain: process.env.SITE_DOMAIN || "www.liumeiti.vip",
        support: settings.support,
      },
    };
    const planned = await ensureDurableOperationPlan(operation, proposedPlan);
    if (!planned.ok) return Response.json({ ok: false, error: planned.error }, { status: 503 });
    plan = planned.plan;
  }

  // Always resume the first exact snapshot. Later order/reference/settings
  // changes cannot alter recipients or content after a response is lost.
  const results = [];
  let internalEffectsOk = true;
  for (const recipient of Array.isArray(plan?.recipients) ? plan.recipients : []) {
    const email = String(recipient?.email || "").toLowerCase();
    const recipientOrderIds = Array.isArray(recipient?.orderIds) ? recipient.orderIds : [];
    const recipientOrders = Array.isArray(recipient?.orders) ? recipient.orders : [];
    const locale = recipient?.locale === "en" ? "en" : "zh";
    const recipientHash = createHash("sha256").update(email).digest("hex");
    const delivery = await deliverOnce(`reference-notice:${operation.operationId}:${recipientHash}:email`, (stableId) => {
      if (!validEmail(email) || recipientOrders.length !== recipientOrderIds.length) return null;
      const content = buildReferenceNotificationEmail({
        orders: recipientOrders,
        subject,
        message,
        brandName: locale === "en"
          ? (plan.emailContext?.brandNameEn || plan.emailContext?.brandName)
          : plan.emailContext?.brandName,
        siteDomain: plan.emailContext?.siteDomain || "www.liumeiti.vip",
        locale,
      });
      return sendSimpleEmail({
        to: email,
        ...content,
        category: "transactional",
        relatedType: "reference_notice",
        relatedId: reference,
        support: plan.emailContext?.support,
        locale,
        idempotencyKey: stableId,
      });
    });
    const sent = delivery.value && typeof delivery.value === "object"
      ? delivery.value
      : { ok: Boolean(delivery.ok && delivery.idempotent) };
    results.push({
      email,
      ok: Boolean(sent?.ok),
      uncertain: Boolean(delivery.uncertain || delivery.pending),
      error: sent?.ok ? "" : clean(sent?.reason || sent?.error || delivery.error || "send_failed", 120),
    });
    if (sent?.ok) {
      for (const plannedOrderId of recipientOrderIds) {
        internalEffectsOk = await appendOrderTimelineOnce(plannedOrderId, `${operation.operationId}:timeline:${plannedOrderId}`, {
          type: "customer_notice_sent",
          visibility: "public",
          summaryZh: "订单通知已发送",
          summaryEn: "Order update sent",
          actor: actor.staffUsername,
        }) && internalEffectsOk;
      }
    }
  }

  const delivered = results.filter((result) => result.ok).length;
  const uncertain = results.some((result) => result.uncertain);
  if (uncertain) {
    return Response.json({
      ok: false,
      partial: delivered > 0,
      manualReview: true,
      error: "reference_notice_delivery_uncertain",
      reference,
      delivered,
      total: results.length,
      results,
    }, { status: 409 });
  }
  if (delivered < results.length) {
    return Response.json({
      ok: false,
      partial: delivered > 0,
      retryable: true,
      error: "reference_notice_retryable",
      reference,
      delivered,
      total: results.length,
      results,
    }, { status: 503 });
  }
  const logOk = await pushAdminActionLog({
    action: "reference_notice_send",
    actor,
    target: `reference:${reference}`,
    detail: { orders: plan.orderIds?.length || 0, recipients: plan.recipients?.length || 0, delivered },
    operationId: `${operation.operationId}:admin-log`,
  });
  if (!internalEffectsOk || !logOk) {
    return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
  }
  const responsePayload = {
    ok: delivered === results.length,
    partial: delivered > 0 && delivered < results.length,
    reference,
    delivered,
    total: results.length,
    results,
  };
  const completed = await completeDurableOperation(operation, responsePayload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(responsePayload);
}
