import { checkRedisHealth, recordHealthStatus } from "../../_health.js";
import { detectMissedJobs, runObservedJob } from "../../_job-runner.js";
import { runMaintenanceTick } from "../../_keeper.js";
import { readMetricSeries, summarizeMetricSeries, withApiTelemetry } from "../../_observability.js";
import { reportOperationalFailure, reportOperationalRecovery } from "../../_incidents.js";
import { CORE_API_AGGREGATE_GROUP } from "../../_telemetry-groups.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function requireIncidentSync(result) {
  if (result?.ok === true) return result;
  const error = new Error(result?.error || "incident_sync_failed");
  error.code = result?.error || "incident_sync_failed";
  throw error;
}

function requireMonitoringBudget(deadlineAt, minimumActionMs = 11_000) {
  if (deadlineAt && Date.now() + minimumActionMs >= deadlineAt) {
    const error = new Error("monitoring_deadline_exceeded");
    error.code = "monitoring_deadline_exceeded";
    throw error;
  }
}

async function evaluateApiSignals({ deadlineAt = 0 } = {}) {
  const series = await readMetricSeries({ kind: "api", group: CORE_API_AGGREGATE_GROUP, range: "1h" });
  const recent = series.points.slice(-3);
  const summary = summarizeMetricSeries(recent);
  const hasRecoverySample = summary.requests >= 10;
  const errorFingerprint = "api:server-error-rate";
  const latencyFingerprint = "api:p95-latency";
  if (summary.requests >= 10 && summary.status5xx >= 2 && summary.errorRate >= 0.02) {
    requireMonitoringBudget(deadlineAt);
    requireIncidentSync(await reportOperationalFailure({
      fingerprint: errorFingerprint,
      component: "api",
      severity: summary.status5xx >= 5 && summary.errorRate >= 0.05 ? "P1" : "P2",
      title: "核心 API 服务端错误率升高",
      errorCode: "api_5xx_rate_high",
      detail: { requests: summary.requests, status5xx: summary.status5xx, errorRate: summary.errorRate, p95Ms: summary.p95Ms },
    }));
  } else if (hasRecoverySample) {
    requireMonitoringBudget(deadlineAt);
    requireIncidentSync(await reportOperationalRecovery({ fingerprint: errorFingerprint, component: "api", title: "核心 API 错误率已恢复" }));
  }
  if (summary.requests >= 10 && summary.p95Ms > 1500) {
    requireMonitoringBudget(deadlineAt);
    requireIncidentSync(await reportOperationalFailure({
      fingerprint: latencyFingerprint,
      component: "api",
      severity: summary.p95Ms > 3000 ? "P1" : "P2",
      title: "核心 API P95 响应时间升高",
      errorCode: "api_p95_high",
      detail: { requests: summary.requests, p95Ms: summary.p95Ms },
    }));
  } else if (hasRecoverySample) {
    requireMonitoringBudget(deadlineAt);
    requireIncidentSync(await reportOperationalRecovery({ fingerprint: latencyFingerprint, component: "api", title: "核心 API 响应时间已恢复" }));
  }
  const health = await recordHealthStatus("api", {
    status: !hasRecoverySample ? "warning"
      : summary.errorRate >= 0.05 || summary.p95Ms > 3000 ? "error"
        : summary.errorRate >= 0.02 || summary.p95Ms > 1500 ? "warning" : "ok",
    summary: summary.requests ? "核心 API 最近十五分钟指标已汇总" : "最近十五分钟暂无核心 API 样本",
    metrics: { requests: summary.requests, status5xx: summary.status5xx, errorRate: Number(summary.errorRate.toFixed(4)), p95Ms: summary.p95Ms },
  });
  if (!health) {
    const error = new Error("api_health_write_failed");
    error.code = "api_health_write_failed";
    throw error;
  }
  return summary;
}

async function handler(request) {
  const requestStartedAt = Date.now();
  const monitoringDeadlineAt = requestStartedAt + 51_000;
  if (!authorized(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (process.env.MAINTENANCE_CRON_ENABLED === "0") {
    return Response.json({ ok: true, skipped: true, reason: "maintenance_cron_disabled" });
  }

  const redis = await runObservedJob("redis_probe", { trigger: "cron" }, async () => {
    const result = await checkRedisHealth();
    return { ok: result?.status === "ok", latencyMs: Number(result?.metrics?.latencyMs || 0), ...(result?.status === "ok" ? {} : { error: result?.error || "redis_ping_failed" }) };
  });
  if (redis.ok === false) {
    return Response.json({ ok: false, error: "redis_unavailable", redis }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  // Reserve platform time for incident evaluation and the final response.
  // Monitoring will not start a Telegram call in the final eleven seconds.
  const maintenance = await runMaintenanceTick({ trigger: "cron", deadlineMs: 34_000 });
  const monitoring = await Promise.allSettled([
    detectMissedJobs({ notify: process.env.OPS_MISSED_JOB_ALERTS === "1", deadlineAt: monitoringDeadlineAt }),
    evaluateApiSignals({ deadlineAt: monitoringDeadlineAt }),
  ]);
  const jobs = monitoring[0].status === "fulfilled" ? monitoring[0].value : [];
  const api = monitoring[1].status === "fulfilled" ? monitoring[1].value : null;
  const monitoringErrors = monitoring
    .filter((entry) => entry.status === "rejected")
    .map((entry) => String(entry.reason?.code || entry.reason?.message || "monitoring_failed").slice(0, 160));
  const ok = maintenance.ok && monitoringErrors.length === 0;
  return Response.json({ ok, maintenance, jobs, api, monitoringErrors }, {
    status: ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

// Hobby only supports the daily schedule retained in vercel.json. The trusted
// GitHub Actions scheduler calls this idempotent endpoint hourly; set the
// historical OPS_HIGH_FREQUENCY_CRON=1 flag only while that scheduler is active.
export const GET = withApiTelemetry("cron_maintenance", handler);
export const POST = GET;
