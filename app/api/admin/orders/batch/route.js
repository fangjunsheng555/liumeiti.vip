import {
  getAllOrdersWithIndex, setOrderAt, softDeleteOrderAt,
  getCookieFromRequest, verifySession, formatBeijingTime,
} from "../../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

// POST /api/admin/orders/batch
// body: { orderIds: string[], action: "delete" | "invalid" }
export async function POST(request) {
  if (!adminOk(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const orderIds = Array.isArray(body.orderIds)
    ? body.orderIds.filter((s) => typeof s === "string" && s.length > 0).slice(0, 200)
    : [];
  const action = body.action === "delete" ? "delete" : body.action === "invalid" ? "invalid" : null;

  if (orderIds.length === 0) {
    return Response.json({ ok: false, error: "no_order_ids" }, { status: 400 });
  }
  if (!action) {
    return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }

  const all = await getAllOrdersWithIndex();
  const idSet = new Set(orderIds);
  const matched = all.filter((entry) =>
    entry.order && entry.order.orderId && idSet.has(entry.order.orderId) && !entry.order.deleted
  );

  const results = [];
  for (const entry of matched) {
    if (action === "delete") {
      const ok = await softDeleteOrderAt(entry.index, entry.order.orderId);
      results.push({ orderId: entry.order.orderId, ok });
    } else if (action === "invalid") {
      const order = entry.order;
      if (order.status !== "invalid") {
        const now = new Date();
        order.status = "invalid";
        order.invalidAt = now.toISOString();
        order.invalidAtBeijing = formatBeijingTime(now);
        order.completedAt = null;
        order.completedAtBeijing = null;
        const ok = await setOrderAt(entry.index, order);
        results.push({ orderId: entry.order.orderId, ok });
      } else {
        results.push({ orderId: entry.order.orderId, ok: true, alreadyInvalid: true });
      }
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const notFound = orderIds.filter((id) => !matched.some((e) => e.order.orderId === id));

  return Response.json({
    ok: true,
    action,
    matchedCount: matched.length,
    successCount,
    failedCount: results.length - successCount,
    notFound,
    results,
  });
}
