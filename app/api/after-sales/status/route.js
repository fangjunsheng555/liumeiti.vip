import { verifyAfterSalesToken } from "../../_auth-session.js";
import { clean, getOrderByIdStrict, redisConfig } from "../../_utils.js";
import { withApiTelemetry } from "../../_observability.js";
import { getActiveAfterSalesTickets, publicAfterSalesSummary } from "../_store.js";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function readAfterSalesStatusHandler(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const orderId = normalizeOrderId(body.orderId);
  const claim = verifyAfterSalesToken(clean(body.token, 4000));
  if (!claim || normalizeOrderId(claim.orderId) !== orderId) {
    return Response.json({ ok: false, error: "verification_required" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  if (!redisConfig()) {
    return Response.json({ ok: false, error: "after_sales_store_unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
  try {
    const order = await getOrderByIdStrict(orderId);
    if (!order || normalizeEmail(order.email) !== normalizeEmail(claim.email)) {
      return Response.json({ ok: false, error: "verification_required" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    const activeTickets = await getActiveAfterSalesTickets([orderId]);
    return Response.json({ ok: true, ticket: publicAfterSalesSummary(activeTickets[orderId] || null) }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[after-sales-status] store unavailable", { orderId, error });
    return Response.json({ ok: false, error: "after_sales_store_unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

async function rejectAfterSalesStatusMethod() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: NO_STORE_HEADERS });
}

export const POST = withApiTelemetry("after_sales", readAfterSalesStatusHandler);
export const GET = withApiTelemetry("after_sales", rejectAfterSalesStatusMethod);
