import { adminPermissionProfile, adminSessionFromRequest, clean } from "../../_utils.js";
import { listAfterSalesTickets } from "../../after-sales/_store.js";
import { withApiTelemetry } from "../../_observability.js";

async function listAfterSalesHandler(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canViewOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  let result;
  try {
    result = await listAfterSalesTickets({
      status: clean(url.searchParams.get("status") || "all", 20),
      query: clean(url.searchParams.get("q") || "", 200),
      offset: Number(url.searchParams.get("offset") || 0),
      limit: Number(url.searchParams.get("limit") || 60),
    });
  } catch (error) {
    console.error("[admin-after-sales] list unavailable", error);
    return Response.json({ ok: false, error: "after_sales_store_unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true, ...result });
}

export const GET = withApiTelemetry("admin_after_sales", listAfterSalesHandler);
