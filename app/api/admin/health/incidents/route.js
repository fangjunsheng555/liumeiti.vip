import { adminSessionFromRequest, isRootAdminSession, listAssignableAdminStaffStrict } from "../../../_utils.js";
import { listIncidents } from "../../../_incidents.js";
import { withApiTelemetry } from "../../../_observability.js";

export const runtime = "nodejs";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  let data;
  let owners;
  try {
    [data, owners] = await Promise.all([
      listIncidents({
        status: url.searchParams.get("status") || "all",
        severity: url.searchParams.get("severity") || "all",
        offset: url.searchParams.get("offset") || 0,
        limit: url.searchParams.get("limit") || 50,
      }),
      listAssignableAdminStaffStrict(),
    ]);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "incident_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ ok: true, ...data, owners }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", handler);
