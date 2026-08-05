import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  getOrderByIdStrict,
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
import { withApiTelemetry } from "../../../_observability.js";
import { buildReferenceNotificationEmail } from "../reference-notification-email.js";
import { netflixCredentialSecrets } from "../../../../lib/netflix-delivery.js";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

function cleanMultiline(value, limit = 2000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, limit);
}

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

function validReferenceNoticePlan(plan, reference) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.reference !== reference
      || !Array.isArray(plan.orderIds) || !plan.orderIds.length || !Array.isArray(plan.recipients) || !plan.recipients.length
      || !plan.emailContext || typeof plan.emailContext !== "object" || Array.isArray(plan.emailContext)) return false;
  const plannedIds = plan.orderIds.map((id) => clean(id, 80).toUpperCase());
  if (plannedIds.some((id) => !id) || new Set(plannedIds).size !== plannedIds.length) return false;
  const emails = new Set(), recipientIds = [];
  for (const recipient of plan.recipients) {
    const email = String(recipient?.email || "").trim().toLowerCase();
    if (!recipient || typeof recipient !== "object" || Array.isArray(recipient) || !validEmail(email) || emails.has(email)
        || !Array.isArray(recipient.orderIds) || !recipient.orderIds.length || !Array.isArray(recipient.orders)
        || recipient.orders.length !== recipient.orderIds.length) return false;
    emails.add(email);
    const ids = recipient.orderIds.map((id) => clean(id, 80).toUpperCase());
    if (new Set(ids).size !== ids.length || recipient.orders.some((order, index) => !order || typeof order !== "object"
        || Array.isArray(order) || clean(order.orderId, 80).toUpperCase() !== ids[index])) return false;
    recipientIds.push(...ids);
  }
  return recipientIds.length === plannedIds.length && recipientIds.slice().sort().every((id, index) => id === plannedIds.slice().sort()[index]);
}

function referenceNoticeOrderSnapshot(order) {
  return {
    orderId: clean(order?.orderId, 80).toUpperCase(),
    serviceLabel: clean(order?.serviceLabel, 300),
    service: clean(order?.service, 80),
    cycle: clean(order?.cycle, 80),
    locale: order?.locale === "en" ? "en" : "zh",
    remark: cleanMultiline(order?.remark, 1500),
    staffNotes: cleanMultiline(order?.staffNotes, 3000),
    deliveryMessageMode: order?.deliveryMessageMode === "auto" ? "auto" : "custom",
    account: clean(order?.account, 200),
    password: clean(order?.password, 300),
    staffAccount: clean(order?.staffAccount, 200),
    staffPassword: clean(order?.staffPassword, 300),
    netflixDeliveryMode: ["self_service", "password"].includes(order?.netflixDeliveryMode)
      ? order.netflixDeliveryMode
      : "",
    netflixSelfServiceEnabled: order?.netflixSelfServiceEnabled !== false,
    subscriptionLinks: order?.subscriptionLinks && typeof order.subscriptionLinks === "object" ? {
      shadowrocket: clean(order.subscriptionLinks.shadowrocket, 1000),
      clash: clean(order.subscriptionLinks.clash, 1000),
    } : null,
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

function normalizedReferenceItemService(order, item, index) {
  const itemService = clean(item?.service, 80).trim().toLowerCase();
  if (itemService) return itemService;
  return index === 0 ? clean(order?.service, 80).trim().toLowerCase() : "";
}

function stripReferenceRetrySecrets(value, plannedOrders, currentOrders) {
  return plannedOrders.reduce((text, plannedOrder, index) => {
    const currentOrder = currentOrders[index];
    // A durable plan may have been captured before the order switched from
    // one delivery mode to another. Remove both planned and current Netflix
    // secrets from immutable prose in every mode; the credential section is
    // populated separately and continues to show only the current credentials.
    const plannedSecrets = netflixCredentialSecrets({
      ...plannedOrder,
      netflixDeliveryMode: "self_service",
    });
    const currentSecrets = netflixCredentialSecrets(currentOrder);
    return [...plannedSecrets, ...currentSecrets].reduce(
      (safeText, secret) => safeText.split(secret).join(""),
      text,
    ).replace(/[ \t]{2,}/g, " ").trim();
  }, String(value || ""));
}

function overlayCurrentOrderCredentials(plannedOrder, currentOrder) {
  const currentItems = Array.isArray(currentOrder?.items) && currentOrder.items.length
    ? currentOrder.items
    : [];
  const plannedItems = Array.isArray(plannedOrder?.items) ? plannedOrder.items : [];
  if (plannedItems.length && currentItems.length !== plannedItems.length) return null;
  if (!plannedItems.length) {
    // A legacy top-level order still has a service identity. Allow the normal
    // one-item materialization of that same service, but never overlay a new
    // service (or a newly-created bundle) under the old snapshot label.
    if (currentItems.length > 1) return null;
    const plannedService = normalizedReferenceItemService(plannedOrder, plannedOrder, 0);
    const currentService = currentItems.length
      ? normalizedReferenceItemService(currentOrder, currentItems[0], 0)
      : normalizedReferenceItemService(currentOrder, currentOrder, 0);
    if (!plannedService || plannedService !== currentService) return null;
  }
  if (plannedItems.some((plannedItem, index) => (
    normalizedReferenceItemService(plannedOrder, plannedItem, index)
      !== normalizedReferenceItemService(currentOrder, currentItems[index], index)
  ))) return null;
  const materializedPrimary = !plannedItems.length && currentItems.length === 1;
  const currentPrimary = materializedPrimary
    ? currentItems[0]
    : currentOrder;
  const primaryHasAccount = materializedPrimary
    && Boolean(clean(currentPrimary?.staffAccount || currentPrimary?.account, 200));
  const primaryHasPassword = materializedPrimary
    && Boolean(clean(currentPrimary?.staffPassword || currentPrimary?.password, 300));
  return {
    ...plannedOrder,
    remark: stripReferenceRetrySecrets(
      plannedOrder?.remark,
      [plannedOrder],
      [currentOrder],
    ),
    staffNotes: stripReferenceRetrySecrets(
      plannedOrder?.staffNotes,
      [plannedOrder],
      [currentOrder],
    ),
    account: clean(currentPrimary?.account || (!primaryHasAccount ? currentOrder?.account : ""), 200),
    password: clean(currentPrimary?.password || (!primaryHasPassword ? currentOrder?.password : ""), 300),
    staffAccount: clean(currentPrimary?.staffAccount || (!primaryHasAccount ? currentOrder?.staffAccount : ""), 200),
    staffPassword: clean(currentPrimary?.staffPassword || (!primaryHasPassword ? currentOrder?.staffPassword : ""), 300),
    deliveryMessageMode: currentOrder?.deliveryMessageMode === "auto" ? "auto" : "custom",
    netflixDeliveryMode: ["self_service", "password"].includes(currentOrder?.netflixDeliveryMode)
      ? currentOrder.netflixDeliveryMode
      : "",
    netflixSelfServiceEnabled: currentOrder?.netflixSelfServiceEnabled !== false,
    items: plannedItems.map((item, index) => {
      const current = currentItems[index];
      if (!current) return null;
      return {
        ...item,
        account: clean(current.account, 200),
        password: clean(current.password, 300),
        staffAccount: clean(current.staffAccount, 200),
        staffPassword: clean(current.staffPassword, 300),
        subscriptionLinks: current.subscriptionLinks && typeof current.subscriptionLinks === "object" ? {
          shadowrocket: clean(current.subscriptionLinks.shadowrocket, 1000),
          clash: clean(current.subscriptionLinks.clash, 1000),
        } : null,
      };
    }),
  };
}

async function currentCredentialSnapshots(recipient, plannedOrders) {
  const email = String(recipient?.email || "").trim().toLowerCase();
  const orderIds = Array.isArray(recipient?.orderIds) ? recipient.orderIds : [];
  if (!validEmail(email) || plannedOrders.length !== orderIds.length) {
    return { ok: false, terminal: true, error: "reference_notice_plan_invalid" };
  }
  try {
    const currentOrders = await Promise.all(orderIds.map((orderId) => getOrderByIdStrict(orderId)));
    const currentById = new Map(currentOrders.map((current) => [
      String(current?.orderId || "").toUpperCase(),
      current,
    ]));
    const plannedIds = new Set(plannedOrders.map((order) => String(order?.orderId || "").toUpperCase()));
    if (plannedIds.size !== plannedOrders.length
      || orderIds.some((orderId) => !plannedIds.has(String(orderId || "").toUpperCase()))) {
      return { ok: false, terminal: true, error: "reference_notice_plan_invalid" };
    }
    const refreshed = plannedOrders.map((planned) => {
      const plannedOrderId = String(planned?.orderId || "").toUpperCase();
      const current = currentById.get(plannedOrderId);
      if (!current || current.deleted || current.status === "invalid") return null;
      if (String(current.email || "").trim().toLowerCase() !== email) return null;
      return overlayCurrentOrderCredentials(planned, current);
    });
    if (refreshed.some((order) => !order || order.items?.some((item) => !item))) {
      return { ok: false, terminal: true, error: "reference_notice_order_identity_changed" };
    }
    return { ok: true, orders: refreshed };
  } catch {
    // A strict read distinguishes a temporary store failure from a missing or
    // reassigned order. No provider call has happened yet, so deliverOnce can
    // safely retry later without ever falling back to stale account details.
    return { ok: false, retryable: true, error: "order_credentials_unavailable" };
  }
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

async function getReferenceNoticeHandler(request) {
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

async function sendReferenceNoticeHandler(request) {
  const auth = requireStaff(request, "canSendMail");
  if (auth.response) return auth.response;
  let body = {};
  try { body = await request.json(); } catch {}
  const reference = normalizeInternalReference(body.reference);
  const subject = clean(body.subject, 160);
  const message = cleanMultiline(body.message, 2000);
  // Preserve the historical single-line hash shape so an operation started
  // before this deployment can still be retried with the same idempotency key.
  const messageForHash = clean(body.message, 2000);
  const requestedOrderIds = Array.from(new Set((Array.isArray(body.orderIds) ? body.orderIds : [])
    .map((value) => clean(value, 80).toUpperCase())
    .filter(Boolean))).sort();
  const selectedIds = new Set(requestedOrderIds);
  if (!reference) return Response.json({ ok: false, error: "reference_required" }, { status: 400 });
  if (subject.length < 2 || message.length < 2) return Response.json({ ok: false, error: "message_required" }, { status: 400 });

  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const actor = adminActorFromSession(auth.session);
  const requestHash = idempotencyPayloadHash({
    reference,
    orderIds: requestedOrderIds,
    subject,
    message: messageForHash,
  });
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
    const replay = operation.record.result;
    if (!replay || typeof replay !== "object" || Array.isArray(replay) || typeof replay.ok !== "boolean" || replay.reference !== reference) {
      return Response.json({ ok: false, error: "durable_operation_record_invalid" }, { status: 409 });
    }
    return Response.json({ ...replay, idempotent: true });
  }

  let orders = await matchingOrders(reference);
  if (selectedIds.size) orders = orders.filter((order) => selectedIds.has(String(order.orderId || "").toUpperCase()));
  let plan = operation.record.plan;
  if (!plan) {
    if (!orders.length) return Response.json({ ok: false, error: "orders_not_found" }, { status: 404 });

    const deliverableOrders = orders.filter((order) => validEmail(String(order?.email || "").trim().toLowerCase()));
    const grouped = new Map();
    for (const order of deliverableOrders) {
      const email = String(order.email || "").trim().toLowerCase();
      if (!grouped.has(email)) grouped.set(email, []);
      grouped.get(email).push(order);
    }
    if (!grouped.size) return Response.json({ ok: false, error: "recipient_missing" }, { status: 409 });
    const settings = await getSettings();
    const proposedPlan = {
      reference,
      orderIds: deliverableOrders.map((order) => String(order.orderId || "").toUpperCase()).filter(Boolean).sort(),
      recipients: [...grouped.entries()].map(([email, recipientOrders]) => {
        const sortedOrders = [...recipientOrders].sort((left, right) => (
          String(left?.orderId || "").toUpperCase().localeCompare(String(right?.orderId || "").toUpperCase())
        ));
        return {
          email,
          orderIds: sortedOrders.map((order) => String(order.orderId || "").toUpperCase()).filter(Boolean),
          orders: sortedOrders.map(referenceNoticeOrderSnapshot),
          locale: recipientOrders.some((order) => order.locale === "en") ? "en" : "zh",
        };
      }).sort((left, right) => left.email.localeCompare(right.email)),
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
  if (!validReferenceNoticePlan(plan, reference)) {
    return Response.json({ ok: false, error: "reference_notice_plan_invalid" }, { status: 409 });
  }

  // Recipients, selected orders, notes and mail settings stay bound to the
  // first durable plan. Credentials are the one exception: before a provider
  // call that has not yet succeeded we re-read them strictly, so a retry after
  // an account correction cannot send an older password. An uncertain provider
  // result is never retried by deliverOnce, preserving at-most-once delivery.
  const results = [];
  let internalEffectsOk = true;
  for (const recipient of Array.isArray(plan?.recipients) ? plan.recipients : []) {
    const email = String(recipient?.email || "").toLowerCase();
    const recipientOrderIds = Array.isArray(recipient?.orderIds) ? recipient.orderIds : [];
    const recipientOrders = Array.isArray(recipient?.orders) ? recipient.orders : [];
    const locale = recipient?.locale === "en" ? "en" : "zh";
    const recipientHash = createHash("sha256").update(email).digest("hex");
    const delivery = await deliverOnce(`reference-notice:${operation.operationId}:${recipientHash}:email`, async (stableId) => {
      const refreshed = await currentCredentialSnapshots(recipient, recipientOrders);
      if (!refreshed.ok) return refreshed;
      const content = buildReferenceNotificationEmail({
        orders: refreshed.orders,
        subject: stripReferenceRetrySecrets(subject, recipientOrders, refreshed.orders),
        message: stripReferenceRetrySecrets(message, recipientOrders, refreshed.orders),
        brandName: locale === "en"
          ? (plan.emailContext?.brandNameEn || plan.emailContext?.brandName)
          : plan.emailContext?.brandName,
        siteDomain: plan.emailContext?.siteDomain || "www.liumeiti.vip",
        locale,
      });
      return sendSimpleEmail({
        to: email,
        ...content,
        category: "order_update",
        relatedType: "reference_notice",
        relatedId: reference,
        support: plan.emailContext?.support,
        locale,
        idempotencyKey: stableId,
      });
    });
    const sent = delivery.value && typeof delivery.value === "object" ? delivery.value : {};
    const handled = Boolean(delivery.ok && (delivery.delivered || delivery.terminal || delivery.suppressed || delivery.skipped));
    const delivered = delivery.delivered === true;
    results.push({
      email,
      ok: delivered,
      handled,
      suppressed: Boolean(delivery.suppressed || sent.suppressed),
      uncertain: Boolean(delivery.uncertain || delivery.pending),
      error: delivered ? "" : clean(sent?.reason || sent?.error || delivery.error || (delivery.suppressed ? "suppressed" : "send_failed"), 120),
    });
    if (delivered) {
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
  const handled = results.filter((result) => result.handled).length;
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
  if (handled < results.length) {
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

export const GET = withApiTelemetry("admin_after_sales", getReferenceNoticeHandler);
export const POST = withApiTelemetry("admin_after_sales", sendReferenceNoticeHandler);
