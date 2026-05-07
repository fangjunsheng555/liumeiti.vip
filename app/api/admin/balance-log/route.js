import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  getAdminBalanceLog, deleteAdminBalanceLogEntries, clean,
} from "../../_utils.js";

// GET /api/admin/balance-log[?q=...&filter=add|deduct]
export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const filter = String(url.searchParams.get("filter") || "all").trim();
  // source: "all" | "admin" (staff adjustment) | "order" (user spending)
  const source = String(url.searchParams.get("source") || "all").trim();

  const all = await getAdminBalanceLog();
  let entries = all;
  if (filter === "add") entries = entries.filter((e) => Number(e.amount) > 0);
  else if (filter === "deduct") entries = entries.filter((e) => Number(e.amount) < 0);
  if (source === "admin") entries = entries.filter((e) => e.source === "admin");
  else if (source === "order") entries = entries.filter((e) => e.source === "order");
  if (q) {
    entries = entries.filter((e) =>
      (e.email || "").toLowerCase().includes(q) ||
      (e.reason || "").toLowerCase().includes(q) ||
      (e.id || "").toLowerCase().includes(q)
    );
  }
  // Aggregate stats over the whole (unfiltered) list — useful for header
  const totalAdded = all.filter((e) => Number(e.amount) > 0).reduce((s, e) => s + Number(e.amount), 0);
  const totalDeducted = all.filter((e) => Number(e.amount) < 0).reduce((s, e) => s + Math.abs(Number(e.amount)), 0);
  const adminCount = all.filter((e) => e.source === "admin").length;
  const orderCount = all.filter((e) => e.source === "order").length;
  return Response.json({
    ok: true,
    total: all.length,
    filteredCount: entries.length,
    totalAdded: Math.round(totalAdded * 100) / 100,
    totalDeducted: Math.round(totalDeducted * 100) / 100,
    adminCount,
    orderCount,
    entries,
    currentStaff: {
      id: Number(session.staffId || 1),
      username: session.staffUsername || "admin",
      root: isRootAdminSession(session),
    },
  });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteAdminBalanceLogEntries(ids, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
  return Response.json(result);
}
