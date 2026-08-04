import { randomBytes } from "node:crypto";
import { clean, redisCmd, redisPipeline } from "./_utils.js";

const JOB_LAST_KEY = "lm:ops:job:last:v1";
const JOB_RUN_PREFIX = "lm:ops:job:run:v1:";
const JOB_RUN_INDEX_PREFIX = "lm:ops:job:runs:v1:";
const JOB_ALL_RUN_INDEX_KEY = "lm:ops:job:runs:all:v1";
const MONITORING_BOOTSTRAP_KEY = "lm:ops:monitor:bootstrap:v1";
const JOB_RUN_TTL_SECONDS = 90 * 24 * 60 * 60;
const JOB_HISTORY_LIMIT = 500;

export function normalizeJobResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.ok !== "boolean"
    || (Object.hasOwn(value, "disabled") && typeof value.disabled !== "boolean")) {
    return { ok: false, error: "invalid_job_result" };
  }
  return value;
}

// OPS_HIGH_FREQUENCY_CRON is retained for deployment compatibility. On the
// Hobby plan it means the trusted external *hourly* scheduler is active. The
// 150-minute alarm window tolerates normal GitHub Actions scheduling jitter and
// one missed invocation without masking a sustained scheduler outage.
const highFrequency = process.env.OPS_HIGH_FREQUENCY_CRON === "1";
const HOURLY_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
const HOURLY_SCHEDULER_MISSED_AFTER_MS = 150 * 60 * 1000;
const DAILY_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAILY_SCHEDULER_MISSED_AFTER_MS = 30 * 60 * 60 * 1000;
const BASELINE_FAST_INTERVAL_MS = highFrequency ? HOURLY_SCHEDULER_INTERVAL_MS : DAILY_SCHEDULER_INTERVAL_MS;
const BASELINE_FAST_MISSED_AFTER_MS = highFrequency ? HOURLY_SCHEDULER_MISSED_AFTER_MS : DAILY_SCHEDULER_MISSED_AFTER_MS;

export const MAINTENANCE_SCHEDULER = Object.freeze({
  mode: highFrequency ? "external_hourly" : "vercel_daily",
  cadenceMs: BASELINE_FAST_INTERVAL_MS,
  missedAfterMs: BASELINE_FAST_MISSED_AFTER_MS,
});

function policy(label, cadenceMs, missedAfterMs, severity) {
  return { label, cadenceMs, expectedIntervalMs: cadenceMs, missedAfterMs, severity };
}

export const JOB_POLICIES = {
  after_sales_outbox: policy("售后 Outbox", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
  order_transition: policy("订单恢复", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
  quote_expiry: policy("报价到期", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P2"),
  usdt_confirm: policy("USDT 自动确认", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
  renewal: highFrequency
    ? policy("续费提醒", 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, "P2")
    : policy("续费提醒", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P2"),
  order_sla: policy("订单 SLA", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P2"),
  marketing_dispatch: policy("营销邮件派发", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P2"),
  telegram_alert_retry: policy("Telegram 告警重试", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
  push_maintenance: policy("浏览器 Push 维护", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
  queue_sampler: policy("队列采样", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P2"),
  redis_probe: policy("Redis 主动探测", BASELINE_FAST_INTERVAL_MS, BASELINE_FAST_MISSED_AFTER_MS, "P1"),
};

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry
  ));
}

function storageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function strictPipelineRows(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected) throw storageError(code);
  return value.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) throw storageError(code);
    const result = entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
    if (result == null) throw storageError(code);
    return result;
  });
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function parseJobRun(value, expectedJob = "") {
  const record = parseJson(value);
  const valid = record && typeof record === "object" && !Array.isArray(record)
    && Boolean(clean(record.runId, 120))
    && Boolean(safeJobName(record.job))
    && (!expectedJob || record.job === expectedJob)
    && ["running", "success", "failed", "disabled"].includes(record.status);
  if (!valid) throw storageError("job_history_corrupt");
  return record;
}

function hashObject(value) {
  if (!value) return {};
  if (!Array.isArray(value) && typeof value === "object") return value;
  if (!Array.isArray(value)) return {};
  const out = {};
  for (let index = 0; index + 1 < value.length; index += 2) out[String(value[index])] = value[index + 1];
  return out;
}

function safeJobName(value) {
  return clean(value, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function makeRunId(job) {
  return `${job}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function safeError(error) {
  return clean(error?.code || error?.message || error || "job_failed", 160);
}

function numericResult(result, names) {
  for (const name of names) {
    const value = Number(result?.[name]);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

async function persistRun(record, { index = false } = {}) {
  const raw = JSON.stringify(record);
  const commands = [
    ["SET", JOB_RUN_PREFIX + record.runId, raw, "EX", String(JOB_RUN_TTL_SECONDS)],
    ["HSET", JOB_LAST_KEY, record.job, raw],
  ];
  if (index) {
    commands.push(
      ["ZADD", JOB_RUN_INDEX_PREFIX + record.job, String(Date.parse(record.startedAt) || Date.now()), record.runId],
      ["ZREMRANGEBYRANK", JOB_RUN_INDEX_PREFIX + record.job, "0", String(-(JOB_HISTORY_LIMIT + 1))],
      ["EXPIRE", JOB_RUN_INDEX_PREFIX + record.job, String(JOB_RUN_TTL_SECONDS)],
      ["ZADD", JOB_ALL_RUN_INDEX_KEY, String(Date.parse(record.startedAt) || Date.now()), record.runId],
      ["ZREMRANGEBYRANK", JOB_ALL_RUN_INDEX_KEY, "0", String(-(JOB_HISTORY_LIMIT + 1))],
      ["EXPIRE", JOB_ALL_RUN_INDEX_KEY, String(JOB_RUN_TTL_SECONDS)],
    );
  }
  try {
    strictPipelineRows(await redisPipeline(commands), commands.length, "job_run_persistence_failed");
    return true;
  } catch {
    return false;
  }
}

export async function runObservedJob(jobName, options = {}, handler) {
  const job = safeJobName(jobName);
  if (!job || typeof handler !== "function") return { ok: false, error: "invalid_job" };
  const now = new Date();
  const runId = makeRunId(job);
  const policy = JOB_POLICIES[job] || {};
  let record = {
    runId,
    job,
    label: clean(options.label || policy.label || job, 80),
    trigger: clean(options.trigger || "system", 40),
    status: "running",
    scheduledAt: clean(options.scheduledAt, 80),
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    finishedAt: "",
    durationMs: 0,
    scanned: 0,
    processed: 0,
    failed: 0,
    errorCode: "",
    traceId: clean(options.traceId, 40),
  };
  const persistenceErrors = [];
  const persist = async (stage, persistOptions = {}) => {
    const ok = await persistRun(record, persistOptions);
    if (!ok) persistenceErrors.push(stage);
    return ok;
  };
  await persist("initial", { index: true });

  const heartbeat = async (patch = {}) => {
    record = {
      ...record,
      heartbeatAt: new Date().toISOString(),
      scanned: numericResult(patch, ["scanned", "checked"]) || record.scanned,
      processed: numericResult(patch, ["processed", "completed", "settled", "sent", "expired"]) || record.processed,
      failed: numericResult(patch, ["failed", "errors"]) || record.failed,
    };
    await persist("heartbeat");
    return record;
  };

  let result = null;
  try {
    result = normalizeJobResult(await handler({ runId, heartbeat, startedAt: record.startedAt }));
    const finished = new Date();
    const explicitFailure = result.ok !== true;
    record = {
      ...record,
      status: explicitFailure ? "failed" : (result.disabled === true ? "disabled" : "success"),
      heartbeatAt: finished.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - now.getTime()),
      scanned: numericResult(result, ["scanned", "checked", "total"]),
      processed: numericResult(result, ["processed", "completed", "settled", "sent", "expired", "matched"]),
      failed: numericResult(result, ["failed", "errors"]),
      errorCode: explicitFailure ? safeError(result?.error || "job_failed") : "",
    };
  } catch (error) {
    const finished = new Date();
    record = {
      ...record,
      status: "failed",
      heartbeatAt: finished.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - now.getTime()),
      failed: Math.max(1, record.failed),
      errorCode: safeError(error),
    };
    result = { ok: false, error: record.errorCode };
  }
  await persist("final");

  if (persistenceErrors.length && record.status !== "failed") {
    record = {
      ...record,
      status: "failed",
      failed: Math.max(1, record.failed),
      errorCode: "job_run_persistence_failed",
    };
    result = {
      ...(result && typeof result === "object" ? result : {}),
      ok: false,
      error: "job_run_persistence_failed",
    };
    await persist("monitoring_failure");
  }

  let incidentSyncError = "";
  try {
    const incidents = await import("./_incidents.js");
    const fingerprint = `job:${job}`;
    let incidentResult = null;
    if (record.status === "failed") {
      incidentResult = await incidents.reportOperationalFailure({
        fingerprint,
        component: "cron",
        severity: policy.severity || "P2",
        title: `${record.label}运行失败`,
        errorCode: record.errorCode,
        detail: { runId, durationMs: record.durationMs },
      });
    } else if (record.status === "success") {
      incidentResult = await incidents.reportOperationalRecovery({ fingerprint, component: "cron", title: `${record.label}已恢复` });
    }
    if (incidentResult && incidentResult.ok !== true) {
      incidentSyncError = safeError(incidentResult.error || "incident_sync_failed");
    }
  } catch (error) {
    incidentSyncError = safeError(error || "incident_sync_failed");
  }

  if (incidentSyncError) {
    const businessAlreadyFailed = record.status === "failed";
    if (!businessAlreadyFailed) {
      record = {
        ...record,
        status: "failed",
        failed: Math.max(1, record.failed),
        errorCode: "incident_sync_failed",
      };
      await persist("incident_sync_failure");
      result = {
        ...(result && typeof result === "object" ? result : {}),
        ok: false,
        error: "incident_sync_failed",
      };
    }
    result = {
      ...(result && typeof result === "object" ? result : { ok: false, error: record.errorCode || "job_failed" }),
      incidentSyncError,
    };
  }

  if (persistenceErrors.length) {
    const existingFailure = result?.ok === false && result?.error && result.error !== "job_run_persistence_failed";
    result = {
      ...(result && typeof result === "object" ? result : { ok: false }),
      ok: false,
      error: existingFailure ? result.error : "job_run_persistence_failed",
      monitoringError: "job_run_persistence_failed",
      jobPersistenceErrors: [...new Set(persistenceErrors)],
    };
  }

  return { ...(result && typeof result === "object" ? result : { ok: true }), run: record };
}

export async function readLatestJobStatuses() {
  const stored = strictPipelineRows(await redisPipeline([
    ["HGETALL", JOB_LAST_KEY],
    ["PING"],
  ]), 2, "job_status_store_unavailable");
  if (stored[1] !== "PONG") throw storageError("job_status_store_unavailable");
  const raw = hashObject(stored[0]);
  return Object.keys(JOB_POLICIES).map((job) => {
    const policy = JOB_POLICIES[job];
    const record = parseJson(raw[job]);
    const valid = record && typeof record === "object" && !Array.isArray(record)
      && record.job === job
      && ["running", "success", "failed", "disabled"].includes(record.status);
    if (raw[job] != null && !valid) {
      throw storageError("job_status_store_corrupt");
    }
    return record || {
      job,
      label: policy.label,
      status: "never",
      startedAt: "",
      heartbeatAt: "",
      finishedAt: "",
      durationMs: 0,
      scanned: 0,
      processed: 0,
      failed: 0,
      errorCode: "",
    };
  });
}

async function monitoringBootstrapStartedAt(now = Date.now()) {
  const safeNow = Math.max(0, Math.floor(Number(now) || Date.now()));
  const created = await redisCmd(["SET", MONITORING_BOOTSTRAP_KEY, String(safeNow), "NX"]);
  if (created === "OK") return safeNow;
  const stored = Number(await redisCmd(["GET", MONITORING_BOOTSTRAP_KEY]));
  if (Number.isFinite(stored) && stored > 0) return stored;
  const error = new Error("monitoring_bootstrap_store_unavailable");
  error.code = "monitoring_bootstrap_store_unavailable";
  throw error;
}

export function jobFreshness(record, policy, now = Date.now()) {
  const heartbeat = Date.parse(record?.heartbeatAt || record?.finishedAt || record?.startedAt || "");
  if (!Number.isFinite(heartbeat)) return { missed: true, ageMs: null };
  const ageMs = Math.max(0, now - heartbeat);
  const missedAfterMs = Number(policy?.missedAfterMs || policy?.expectedIntervalMs || 24 * 60 * 60 * 1000);
  return { missed: ageMs >= missedAfterMs, ageMs, missedAfterMs };
}

export async function detectMissedJobs({ now = Date.now(), notify = false, deadlineAt = 0, minimumActionMs = 11_000 } = {}) {
  const records = await readLatestJobStatuses();
  const bootstrapStartedAt = await monitoringBootstrapStartedAt(now);
  const jobs = records.map((record) => {
    const policy = JOB_POLICIES[record.job] || {};
    const freshness = jobFreshness(record, policy, now);
    const neverStarted = record.status === "never" && freshness.ageMs == null;
    const bootstrapAgeMs = Math.max(0, now - bootstrapStartedAt);
    const missedAfterMs = policy.missedAfterMs || policy.expectedIntervalMs || 0;
    return {
      ...record,
      ...freshness,
      ...(neverStarted ? {
        missed: bootstrapAgeMs >= missedAfterMs,
        ageMs: bootstrapAgeMs,
        bootstrapGrace: bootstrapAgeMs < missedAfterMs,
      } : {}),
      cadenceMs: policy.cadenceMs || policy.expectedIntervalMs || 0,
      expectedIntervalMs: policy.expectedIntervalMs || 0,
      missedAfterMs: policy.missedAfterMs || policy.expectedIntervalMs || 0,
    };
  });
  if (notify) {
    const incidents = await import("./_incidents.js");
    const failures = [];
    for (const job of jobs) {
      if (deadlineAt && Date.now() + Math.max(0, Number(minimumActionMs || 0)) >= deadlineAt) {
        const error = new Error("monitoring_deadline_exceeded");
        error.code = "monitoring_deadline_exceeded";
        throw error;
      }
      const fingerprint = `job-missed:${job.job}`;
      const result = job.missed
        ? await incidents.reportOperationalFailure({
          fingerprint,
          component: "cron",
          severity: JOB_POLICIES[job.job]?.severity || "P2",
          title: `${job.label || job.job}可能漏跑`,
          errorCode: job.status === "never" ? "job_never_started" : "job_heartbeat_stale",
          detail: { ageMs: job.ageMs, expectedIntervalMs: job.expectedIntervalMs, missedAfterMs: job.missedAfterMs },
        })
        : await incidents.reportOperationalRecovery({ fingerprint, component: "cron", title: `${job.label || job.job}心跳恢复` });
      if (result?.ok !== true) failures.push(`${job.job}:${safeError(result?.error || "incident_sync_failed")}`);
    }
    if (failures.length) {
      const error = new Error("missed_job_incident_sync_failed");
      error.code = "missed_job_incident_sync_failed";
      error.failures = failures;
      throw error;
    }
  }
  return jobs;
}

export async function listJobRuns({ job: requestedJob = "", limit = 30 } = {}) {
  const job = safeJobName(requestedJob);
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  if (!job) return [];
  const ids = await redisCmd(["ZREVRANGE", JOB_RUN_INDEX_PREFIX + job, "0", String(safeLimit - 1)]);
  if (!Array.isArray(ids)) throw storageError("job_history_unavailable");
  if (!ids.length) return [];
  const result = strictPipelineRows(
    await redisPipeline(ids.map((id) => ["GET", JOB_RUN_PREFIX + clean(id, 120)])),
    ids.length,
    "job_history_unavailable",
  );
  return result.map((value) => parseJobRun(value, job));
}

export async function listRecentJobRuns(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  const ids = await redisCmd(["ZREVRANGE", JOB_ALL_RUN_INDEX_KEY, "0", String(safeLimit - 1)]);
  if (!Array.isArray(ids)) throw storageError("job_history_unavailable");
  if (!ids.length) return [];
  const result = strictPipelineRows(
    await redisPipeline(ids.map((id) => ["GET", JOB_RUN_PREFIX + clean(id, 120)])),
    ids.length,
    "job_history_unavailable",
  );
  return result.map((value) => parseJobRun(value));
}

export const jobRunnerInternals = {
  BASELINE_FAST_INTERVAL_MS,
  BASELINE_FAST_MISSED_AFTER_MS,
  DAILY_SCHEDULER_INTERVAL_MS,
  DAILY_SCHEDULER_MISSED_AFTER_MS,
  HOURLY_SCHEDULER_INTERVAL_MS,
  HOURLY_SCHEDULER_MISSED_AFTER_MS,
  JOB_ALL_RUN_INDEX_KEY,
  JOB_LAST_KEY,
  JOB_RUN_INDEX_PREFIX,
  JOB_RUN_PREFIX,
  MONITORING_BOOTSTRAP_KEY,
  hashObject,
  numericResult,
  monitoringBootstrapStartedAt,
  persistRun,
  safeJobName,
};
