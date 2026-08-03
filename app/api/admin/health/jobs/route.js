import { adminSessionFromRequest, isRootAdminSession } from "../../../_utils.js";
import { MAINTENANCE_SCHEDULER, detectMissedJobs, listJobRuns, listRecentJobRuns } from "../../../_job-runner.js";
import { withApiTelemetry } from "../../../_observability.js";

export const runtime = "nodejs";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const job = url.searchParams.get("job") || "";
  let jobs;
  let runs;
  let recentRuns;
  try {
    [jobs, runs, recentRuns] = await Promise.all([
      detectMissedJobs({ notify: false }),
      job ? listJobRuns({ job, limit: url.searchParams.get("limit") || 30 }) : Promise.resolve([]),
      listRecentJobRuns(url.searchParams.get("recentLimit") || 20),
    ]);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "job_history_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({
    ok: true,
    jobs,
    runs,
    recentRuns,
    // highFrequencyMode remains for older admin bundles during rolling deploys.
    highFrequencyMode: MAINTENANCE_SCHEDULER.mode === "external_hourly",
    schedulerMode: MAINTENANCE_SCHEDULER.mode,
    schedulerCadenceMs: MAINTENANCE_SCHEDULER.cadenceMs,
    schedulerMissedAfterMs: MAINTENANCE_SCHEDULER.missedAfterMs,
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", handler);
