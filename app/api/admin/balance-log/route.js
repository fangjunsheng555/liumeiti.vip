import {
  getCookieFromRequest, verifySession, getAdminBalanceLog,
} from "../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

// GET /api/admin/balance-log[?q=...&filter=add|deduct]
export async function GET(request) {
  if (!adminOk(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const filter = String(url.searchParams.get("filter") || "all").trim();

  const all = await getAdminBalanceLog();
  let entries = all;
  if (filter === "add") entries = entries.filter((e) => Number(e.amount) > 0);
  else if (filter === "deduct") entries = entries.filter((e) => Number(e.amount) < 0);
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
  return Response.json({
    ok: true,
    total: all.length,
    filteredCount: entries.length,
    totalAdded: Math.round(totalAdded * 100) / 100,
    totalDeducted: Math.round(totalDeducted * 100) / 100,
    entries,
  });
}
