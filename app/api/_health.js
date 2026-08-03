import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";
import { recordDependencyMetric } from "./_observability.js";
import { JOB_POLICIES, MAINTENANCE_SCHEDULER } from "./_job-runner.js";

const HEALTH_PREFIX = "lm:health:";
const HEALTH_HISTORY_PREFIX = "lm:health:history:v1:";
const HEALTH_HISTORY_LIMIT = 500;
const RECORD_HEALTH_SCRIPT = `
local next = cjson.decode(ARGV[1])
local previousRaw = redis.call('GET', KEYS[1])
if previousRaw then
  local decoded, previous = pcall(cjson.decode, previousRaw)
  if decoded and type(previous) == 'table' then
    if next.status ~= 'ok' then
      next.lastSuccessAt = previous.lastSuccessAt or ''
      next.lastSuccessAtBeijing = previous.lastSuccessAtBeijing or ''
    end
    if next.status ~= 'error' then
      next.lastFailureAt = previous.lastFailureAt or ''
      next.lastFailureAtBeijing = previous.lastFailureAtBeijing or ''
    end
  end
end
local encoded = cjson.encode(next)
redis.call('SET', KEYS[1], encoded)
redis.call('LPUSH', KEYS[2], encoded)
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[2]) - 1)
return encoded`;
export const HEALTH_COMPONENTS = [
  "redis",
  "resend",
  "resend_webhook",
  "brevo",
  "brevo_webhook",
  "telegram_backup",
  "restore_drill",
  "usdt",
  "renewal",
  "catalog",
  "api",
  "telegram",
  "job_runner",
  "order_transition",
  "quote_expiry",
  "order_sla",
  "after_sales_outbox",
  "marketing_queue",
  "push",
];

const DAY_MS = 24 * 60 * 60 * 1000;
export const HEALTH_STALE_AFTER_MS = {
  redis: JOB_POLICIES.redis_probe.missedAfterMs,
  resend: 7 * DAY_MS,
  resend_webhook: 7 * DAY_MS,
  // Brevo is a fallback channel, so it can legitimately be idle for longer.
  brevo: 30 * DAY_MS,
  brevo_webhook: 30 * DAY_MS,
  telegram_backup: 8 * DAY_MS,
  restore_drill: 8 * DAY_MS,
  usdt: JOB_POLICIES.usdt_confirm.missedAfterMs,
  renewal: JOB_POLICIES.renewal.missedAfterMs,
  api: MAINTENANCE_SCHEDULER.missedAfterMs,
  telegram: JOB_POLICIES.telegram_alert_retry.missedAfterMs,
  job_runner: MAINTENANCE_SCHEDULER.missedAfterMs,
  order_transition: JOB_POLICIES.order_transition.missedAfterMs,
  quote_expiry: JOB_POLICIES.quote_expiry.missedAfterMs,
  order_sla: JOB_POLICIES.order_sla.missedAfterMs,
  after_sales_outbox: JOB_POLICIES.after_sales_outbox.missedAfterMs,
  marketing_queue: JOB_POLICIES.marketing_dispatch.missedAfterMs,
  push: JOB_POLICIES.push_maintenance.missedAfterMs,
};

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function rows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry));
}

function unavailable(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function strictPipelineRows(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected) throw unavailable(code);
  return value.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) throw unavailable(code);
    const result = entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
    if (result === undefined) throw unavailable(code);
    return result;
  });
}

function parseStoredJson(value, code) {
  if (value == null || value === "") return null;
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable(code);
  return parsed;
}

function parseHealthRecord(value, component, code) {
  const record = parseStoredJson(value, code);
  if (!record) return null;
  const valid = record.component === component
    && ["ok", "warning", "error", "disabled"].includes(record.status)
    && Number.isFinite(Date.parse(record.checkedAt || ""))
    && (!Object.hasOwn(record, "metrics") || (
      record.metrics && typeof record.metrics === "object" && !Array.isArray(record.metrics)
    ));
  if (!valid) throw unavailable(code);
  return record;
}

function safeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 40), typeof item === "number" || typeof item === "boolean" ? item : clean(item, 160)]));
}

export function healthStatusWithFreshness(component, value, now = Date.now()) {
  if (!value || typeof value !== "object") return value || null;
  const threshold = HEALTH_STALE_AFTER_MS[component];
  const checkedAt = Date.parse(value.checkedAt || "");
  if (!threshold || !Number.isFinite(checkedAt) || ["error", "disabled"].includes(value.status)) {
    return { ...value, stale: false, ageMs: Number.isFinite(checkedAt) ? Math.max(0, now - checkedAt) : null };
  }
  const ageMs = Math.max(0, now - checkedAt);
  if (ageMs <= threshold) return { ...value, stale: false, ageMs };
  return {
    ...value,
    sourceStatus: value.status,
    status: "warning",
    stale: true,
    ageMs,
    summary: value.summary ? `长时间未更新 · ${value.summary}` : "长时间未收到新状态",
  };
}

export async function recordHealthStatus(component, { status = "ok", summary = "", error = "", metrics = {} } = {}) {
  const name = clean(component, 40).toLowerCase();
  if (!HEALTH_COMPONENTS.includes(name)) return null;
  const now = new Date();
  const state = ["ok", "warning", "error", "disabled"].includes(status) ? status : "warning";
  const record = {
    component: name,
    status: state,
    summary: clean(summary, 200),
    error: clean(error, 300),
    metrics: safeMetrics(metrics),
    checkedAt: now.toISOString(),
    checkedAtBeijing: formatBeijingTime(now),
    lastSuccessAt: state === "ok" ? now.toISOString() : "",
    lastSuccessAtBeijing: state === "ok" ? formatBeijingTime(now) : "",
    lastFailureAt: state === "error" ? now.toISOString() : "",
    lastFailureAtBeijing: state === "error" ? formatBeijingTime(now) : "",
  };
  const saved = await redisCmd([
    "EVAL", RECORD_HEALTH_SCRIPT, "2",
    HEALTH_PREFIX + name, HEALTH_HISTORY_PREFIX + name,
    JSON.stringify(record), String(HEALTH_HISTORY_LIMIT),
  ]);
  try { return parseStoredJson(saved, "health_status_write_failed"); } catch { return null; }
}

export async function readHealthStatuses() {
  const result = strictPipelineRows(
    await redisPipeline(HEALTH_COMPONENTS.map((name) => ["GET", HEALTH_PREFIX + name])),
    HEALTH_COMPONENTS.length,
    "health_status_store_unavailable",
  );
  const statuses = {};
  const now = Date.now();
  HEALTH_COMPONENTS.forEach((name, index) => {
    statuses[name] = healthStatusWithFreshness(name, parseHealthRecord(result[index], name, "health_status_store_corrupt"), now);
  });
  return statuses;
}

export async function checkRedisHealth() {
  const started = Date.now();
  const pong = await redisCmd(["PING"]);
  const ok = pong === "PONG";
  const latencyMs = Date.now() - started;
  const record = await recordHealthStatus("redis", {
    status: ok ? "ok" : "error",
    summary: ok ? "Redis 连接正常" : "Redis 连接失败",
    error: ok ? "" : "ping_failed",
    metrics: { latencyMs },
  });
  let metricSaved = false;
  try { metricSaved = await recordDependencyMetric("redis_ping", { status: ok ? 200 : 503, durationMs: latencyMs }); } catch {}
  if (!record || !metricSaved) {
    return {
      component: "redis",
      status: "error",
      summary: "Redis 健康探测记录失败",
      error: !record ? "redis_health_record_failed" : "redis_metric_record_failed",
      metrics: { latencyMs, probeOk: ok },
    };
  }
  return record;
}

export async function readHealthHistory(component, limit = 100) {
  const name = clean(component, 40).toLowerCase();
  if (!HEALTH_COMPONENTS.includes(name)) return [];
  const safeLimit = Math.max(1, Math.min(HEALTH_HISTORY_LIMIT, Number(limit || 100)));
  const values = await redisCmd(["LRANGE", HEALTH_HISTORY_PREFIX + name, "0", String(safeLimit - 1)]);
  if (!Array.isArray(values)) throw unavailable("health_history_store_unavailable");
  return values.map((value) => parseHealthRecord(value, name, "health_history_store_corrupt"))
    .map((value) => healthStatusWithFreshness(name, value));
}

export async function readAllHealthHistory(limitPerComponent = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limitPerComponent || 30)));
  const result = strictPipelineRows(await redisPipeline(HEALTH_COMPONENTS.map((name) => [
    "LRANGE", HEALTH_HISTORY_PREFIX + name, "0", String(safeLimit - 1),
  ])), HEALTH_COMPONENTS.length, "health_history_store_unavailable");
  const history = {};
  HEALTH_COMPONENTS.forEach((name, index) => {
    if (!Array.isArray(result[index])) throw unavailable("health_history_store_unavailable");
    history[name] = result[index].map((value) => parseHealthRecord(value, name, "health_history_store_corrupt"));
  });
  return history;
}

export const healthKeys = { HEALTH_PREFIX, HEALTH_HISTORY_PREFIX, RECORD_HEALTH_SCRIPT };
