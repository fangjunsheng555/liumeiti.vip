import { appendOrderTimelineOnce } from "../_order-timeline.js";
import { deliverOnce } from "../_delivery-once.js";
import { sendAfterSalesEmail } from "./_email.js";
import { markAfterSalesCreationEffectsDone } from "./_store.js";

export async function settleAfterSalesCreationEffects(ticket) {
  if (!ticket?.ticketId || !ticket?.orderId) return { ok: false, error: "ticket_missing", email: false };
  const delivery = await deliverOnce(
    `after-sales-created:${ticket.ticketId}:email`,
    (stableId) => sendAfterSalesEmail(ticket, "received", { idempotencyKey: stableId }),
  );
  const providerResult = delivery.value && typeof delivery.value === "object" ? delivery.value : null;
  const email = Boolean(delivery.idempotent || providerResult?.ok);
  const timeline = await appendOrderTimelineOnce(ticket.orderId, `after-sales-created:${ticket.ticketId}:timeline`, {
    type: "after_sales_created",
    visibility: "public",
    summaryZh: "售后工单已提交",
    summaryEn: "After-sales ticket submitted",
    actor: "customer",
    meta: { ticketId: ticket.ticketId },
  });
  let settled = false;
  if (email && timeline) settled = await markAfterSalesCreationEffectsDone(ticket.ticketId);
  return {
    ok: Boolean(timeline),
    email,
    settled,
    retryable: !email && !delivery.uncertain && !delivery.pending,
    uncertain: Boolean(delivery.uncertain),
    pending: Boolean(delivery.pending),
    error: providerResult?.reason || providerResult?.error || delivery.error || "",
  };
}
