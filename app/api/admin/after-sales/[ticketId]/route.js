import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  pushAdminActionLog,
} from "../../../_utils.js";
import { completeAfterSalesTicket, getAfterSalesTicket } from "../../../after-sales/_store.js";
import { sendAfterSalesEmail } from "../../../after-sales/_email.js";

export async function GET(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canViewOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { ticketId } = await params;
  const ticket = await getAfterSalesTicket(ticketId);
  if (!ticket) return Response.json({ ok: false, error: "ticket_not_found" }, { status: 404 });
  return Response.json({ ok: true, ticket });
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
  const { ticketId } = await params;
  const actor = adminActorFromSession(session);
  const result = await completeAfterSalesTicket(ticketId, clean(body.staffNote, 2000), actor);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.error === "ticket_not_found" ? 404 : 400 });
  }
  let notice = null;
  if (result.changed) {
    notice = await sendAfterSalesEmail(result.ticket, "completed").catch(() => ({ ok: false }));
    await pushAdminActionLog({
      action: "after_sales_complete",
      actor,
      target: `after-sales:${result.ticket.ticketId}`,
      detail: { orderId: result.ticket.orderId, email: result.ticket.email, emailed: Boolean(notice?.ok) },
    });
  }
  return Response.json({ ok: true, ticket: result.ticket, changed: result.changed, notice: result.changed ? { email: Boolean(notice?.ok) } : null });
}
