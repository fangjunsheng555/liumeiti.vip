import { pushAdminActionLog } from "../_utils.js";
import { appendOrderTimelineOnce } from "../_order-timeline.js";
import { deliverOnce } from "../_delivery-once.js";
import { sendAfterSalesEmail } from "./_email.js";
import { markAfterSalesCompletionEffectsDone } from "./_store.js";

export async function settleAfterSalesCompletionEffects(ticket, actor = {}) {
  const operationId = String(ticket?.completionOperationId || "").trim();
  if (!ticket?.ticketId || !ticket?.orderId || !operationId) {
    return { ok: false, error: "completion_operation_missing", email: false };
  }

  const delivery = await deliverOnce(
    `after-sales-completed:${ticket.ticketId}:${operationId}:email`,
    (stableId) => sendAfterSalesEmail(ticket, "completed", { idempotencyKey: stableId }),
  );
  const providerResult = delivery.value && typeof delivery.value === "object" ? delivery.value : null;
  const email = Boolean(delivery.idempotent || providerResult?.ok);
  const timelineOk = await appendOrderTimelineOnce(ticket.orderId, `${operationId}:timeline`, {
    type: "after_sales_completed",
    visibility: "public",
    summaryZh: "售后工单已完成",
    summaryEn: "After-sales ticket completed",
    actor: actor.staffUsername || ticket.completedBy?.staffUsername || "system",
    meta: { ticketId: ticket.ticketId },
  });
  const logOk = !email || await pushAdminActionLog({
    action: "after_sales_complete",
    actor: actor.staffId ? actor : (ticket.completedBy || { staffId: 0, staffUsername: "keeper" }),
    target: `after-sales:${ticket.ticketId}`,
    detail: { orderId: ticket.orderId, email: ticket.email, emailed: true },
    operationId: `${operationId}:admin-log`,
  });
  const internalOk = Boolean(timelineOk && logOk);
  let settled = false;
  if (email && internalOk) {
    settled = await markAfterSalesCompletionEffectsDone(ticket.ticketId, operationId);
  }
  return {
    ok: internalOk,
    email,
    settled,
    retryable: !email && !delivery.uncertain && !delivery.pending,
    uncertain: Boolean(delivery.uncertain),
    pending: Boolean(delivery.pending),
    error: providerResult?.reason || providerResult?.error || delivery.error || "",
  };
}
