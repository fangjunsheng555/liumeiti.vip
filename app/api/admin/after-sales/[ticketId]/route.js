import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  pushAdminActionLog,
} from "../../../_utils.js";
import {
  completeAfterSalesTicket,
  getAfterSalesTicket,
  hydrateAfterSalesTicketCredentials,
  markAfterSalesCompletionEffectsDone,
} from "../../../after-sales/_store.js";
import { sendAfterSalesEmail } from "../../../after-sales/_email.js";
import { appendOrderTimelineOnce } from "../../../_order-timeline.js";
import { deliverOnce } from "../../../_delivery-once.js";
import { claimDurableOperation, completeDurableOperation } from "../../../_durable-operation.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../../_money.js";

export async function GET(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canViewOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { ticketId } = await params;
  const ticket = await getAfterSalesTicket(ticketId);
  if (!ticket) return Response.json({ ok: false, error: "ticket_not_found" }, { status: 404 });
  return Response.json({ ok: true, ticket: await hydrateAfterSalesTicketCredentials(ticket) });
}

export async function PATCH(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canEditOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch {}
  if (body.status !== "completed") {
    return Response.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }
  const { ticketId: rawTicketId } = await params;
  const ticketId = clean(rawTicketId, 100).toUpperCase();
  const actor = adminActorFromSession(session);
  const completion = {
    staffNote: clean(body.staffNote, 2000),
    items: (Array.isArray(body.items) ? body.items : []).map((item) => ({
      index: Number(item?.index),
      account: clean(item?.account, 200),
      password: clean(item?.password, 300),
    })),
  };
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const requestHash = idempotencyPayloadHash({ ticketId, status: "completed", ...completion });
  const operation = await claimDurableOperation({
    scope: "admin-after-sales-complete",
    principal: ticketId,
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, {
      status: operation.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (operation.state === "done") {
    return Response.json({ ...(operation.record.result || { ok: true }), idempotent: true });
  }
  const result = await completeAfterSalesTicket(ticketId, {
    ...completion,
    operationId: operation.operationId,
    requestHash,
  }, actor);
  if (!result.ok) {
    const status = ["ticket_not_found", "order_not_found", "order_item_not_found"].includes(result.error)
      ? 404
      : result.error === "ticket_busy" || result.error === "idempotency_conflict"
        ? 409
        : result.error === "order_sync_failed" || result.error === "storage_failed"
          ? 500
          : 400;
    return Response.json({ ok: false, error: result.error }, { status });
  }
  let notice = null;
  const ownedCompletion = Boolean(result.changed || result.owned);
  if (ownedCompletion) {
    const delivery = await deliverOnce(
      `after-sales-completed:${result.ticket.ticketId}:${operation.operationId}:email`,
      (stableId) => sendAfterSalesEmail(result.ticket, "completed", { idempotencyKey: stableId }),
    );
    notice = delivery.value && typeof delivery.value === "object"
      ? delivery.value
      : { ok: Boolean(delivery.ok && (delivery.idempotent || !delivery.skipped)) };
    const timelineOk = await appendOrderTimelineOnce(result.ticket.orderId, `${operation.operationId}:timeline`, {
      type: "after_sales_completed",
      visibility: "public",
      summaryZh: "售后工单已完成",
      summaryEn: "After-sales ticket completed",
      actor: actor.staffUsername,
      meta: { ticketId: result.ticket.ticketId },
    });
    const logOk = !notice?.ok || await pushAdminActionLog({
      action: "after_sales_complete",
      actor,
      target: `after-sales:${result.ticket.ticketId}`,
      detail: { orderId: result.ticket.orderId, email: result.ticket.email, emailed: Boolean(notice?.ok) },
      operationId: `${operation.operationId}:admin-log`,
    });
    if (!timelineOk || !logOk) {
      return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
    }
    if (delivery.uncertain || delivery.pending) {
      return Response.json({
        ok: false,
        error: delivery.uncertain ? "completion_email_result_uncertain" : "completion_email_pending",
        manualReview: Boolean(delivery.uncertain),
      }, { status: delivery.uncertain ? 409 : 503 });
    }
    if (!notice?.ok) {
      return Response.json({ ok: false, error: "completion_email_retryable", retryable: true }, { status: 503 });
    }
    if (!await markAfterSalesCompletionEffectsDone(result.ticket.ticketId, operation.operationId)) {
      return Response.json({ ok: false, error: "completion_outbox_settle_failed" }, { status: 503 });
    }
  }
  const responsePayload = {
    ok: true,
    ticket: result.ticket,
    changed: ownedCompletion,
    notice: ownedCompletion ? { email: Boolean(notice?.ok) } : null,
  };
  const completed = await completeDurableOperation(operation, responsePayload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(responsePayload);
}
