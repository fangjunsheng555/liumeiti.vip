import { adminPermissionProfile, adminSessionFromRequest, clean } from "../../_utils.js";
import { listAfterSalesTickets } from "../../after-sales/_store.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canViewOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const result = await listAfterSalesTickets({
    status: clean(url.searchParams.get("status") || "all", 20),
    query: clean(url.searchParams.get("q") || "", 200),
    offset: Number(url.searchParams.get("offset") || 0),
    limit: Number(url.searchParams.get("limit") || 60),
  });
  return Response.json({ ok: true, ...result });
}
