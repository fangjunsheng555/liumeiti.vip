import { adminSessionFromRequest, getOrderByIdStrict, isRootAdminSession } from "../../../../_utils.js";
import { businessTraceIdForOrder, readBusinessTrace, resolveBusinessTraceOrderId, withApiTelemetry } from "../../../../_observability.js";

export const runtime = "nodejs";

async function handler(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { orderId: requestedId } = await params;
  let orderId;
  try {
    orderId = await resolveBusinessTraceOrderId(requestedId);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "trace_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!orderId) return Response.json({ ok: false, error: "trace_not_found" }, { status: 404 });
  let order;
  try {
    order = await getOrderByIdStrict(orderId);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "order_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  let trace;
  try {
    trace = await readBusinessTrace(order.orderId);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "trace_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({
    ok: true,
    ...trace,
    query: requestedId,
    businessTraceId: order.businessTraceId || trace.businessTraceId || businessTraceIdForOrder(order.orderId),
    requestTraceId: order.requestTraceId || order.initialTraceId || "",
    // Keep the legacy response field for older admin clients while new
    // orders persist requestTraceId.
    initialTraceId: order.initialTraceId || order.requestTraceId || "",
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", handler);
