import { adminSessionFromRequest, isRootAdminSession } from "../../../_utils.js";
import { readMetricSeries, summarizeMetricSeries, withApiTelemetry } from "../../../_observability.js";
import { CORE_API_AGGREGATE_GROUP, CORE_API_TELEMETRY_COVERAGE } from "../../../_telemetry-groups.js";

export const runtime = "nodejs";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "dependency" ? "dependency" : "api";
  const range = url.searchParams.get("range") || "24h";
  const group = url.searchParams.get("group") || (kind === "api" ? CORE_API_AGGREGATE_GROUP : "all");
  let series;
  try {
    series = await readMetricSeries({ kind, range, group });
  } catch (error) {
    if (error?.code === "metric_series_unavailable") {
      return Response.json({ ok: false, error: "metric_series_unavailable" }, { status: 503 });
    }
    throw error;
  }
  return Response.json({
    ok: true,
    kind,
    ...series,
    summary: summarizeMetricSeries(series.points),
    ...(kind === "api" ? { coverage: CORE_API_TELEMETRY_COVERAGE } : {}),
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", handler);
