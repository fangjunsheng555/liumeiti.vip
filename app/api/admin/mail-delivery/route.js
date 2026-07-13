import { adminSessionFromRequest, isRootAdminSession, clean } from "../../_utils.js";
import { DELIVERY_STATUSES, getEmailDelivery, listEmailDeliveries } from "../../_mail-delivery.js";

export const runtime = "nodejs";

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const id = clean(url.searchParams.get("id"), 120);
  if (id) {
    const record = await getEmailDelivery(id);
    return record
      ? Response.json({ ok: true, record }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const status = DELIVERY_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "all";
  const category = clean(url.searchParams.get("category") || "all", 40).toLowerCase();
  const data = await listEmailDeliveries({
    query: url.searchParams.get("q") || "",
    status,
    category,
    limit: Number(url.searchParams.get("limit") || 120),
  });
  return Response.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
