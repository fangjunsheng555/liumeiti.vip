import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";
import { observabilityWritesEnabled, recordDependencyMetric } from "./_observability.js";
import { JOB_POLICIES, MAINTENANCE_SCHEDULER } from "./_job-runner.js";

const HEALTH_PREFIX = "lm:health:";
const HEALTH_HISTORY_PREFIX = "lm:health:history:v1:";
const HEALTH_HISTORY_LIMIT = 500;
const RECORD_HEALTH_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'list') then return '__storage_type_error__' end
local limit=tonumber(ARGV[2])
if not limit or limit~=math.floor(limit) or limit<1 or limit>10000 then return '__invalid_limit__' end
local current=redis.call('GET',KEYS[1])
if ARGV[3]=='0' then
  if current then return '__conflict__' end
elseif not current or current~=ARGV[4] then
  return '__conflict__'
end
local encoded=ARGV[1]
redis.call('SET', KEYS[1], encoded)
redis.call('LPUSH', KEYS[2], encoded)
redis.call('LTRIM', KEYS[2], 0, limit - 1)
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
  if (!observabilityWritesEnabled()) return record;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let read;
    try {
      read = strictPipelineRows(await redisPipeline([
        ["GET", HEALTH_PREFIX + name],
        ["PING"],
      ]), 2, "health_status_store_unavailable");
    } catch { return null; }
    if (read[1] !== "PONG") return null;
    const previousRaw = typeof read[0] === "string" ? read[0] : "";
    const previous = previousRaw ? parseJson(previousRaw) : null;
    const next = { ...record };
    if (previous && typeof previous === "object" && !Array.isArray(previous)) {
      if (state !== "ok") {
        if (typeof previous.lastSuccessAt === "string") next.lastSuccessAt = previous.lastSuccessAt;
        if (typeof previous.lastSuccessAtBeijing === "string") next.lastSuccessAtBeijing = previous.lastSuccessAtBeijing;
      }
      if (state !== "error") {
        if (typeof previous.lastFailureAt === "string") next.lastFailureAt = previous.lastFailureAt;
        if (typeof previous.lastFailureAtBeijing === "string") next.lastFailureAtBeijing = previous.lastFailureAtBeijing;
      }
    }
    const saved = await redisCmd([
      "EVAL", RECORD_HEALTH_SCRIPT, "2",
      HEALTH_PREFIX + name, HEALTH_HISTORY_PREFIX + name,
      JSON.stringify(next), String(HEALTH_HISTORY_LIMIT), previousRaw ? "1" : "0", previousRaw || "__lm_health_missing__",
    ]);
    if (saved === "__conflict__") continue;
    try { return parseStoredJson(saved, "health_status_write_failed"); } catch { return null; }
  }
  return null;
}

function corruptStoredHealthStatus(component) {
  return {
    component,
    status: "warning",
    summary: "状态记录格式异常，已忽略；等待下一次探测自动覆盖",
    error: "health_status_record_corrupt",
    metrics: {},
    checkedAt: "",
    checkedAtBeijing: "",
    lastSuccessAt: "",
    lastSuccessAtBeijing: "",
    lastFailureAt: "",
    lastFailureAtBeijing: "",
    stale: false,
    ageMs: null,
  };
}

export async function readHealthStatusesWithDiagnostics() {
  const result = strictPipelineRows(
    await redisPipeline(HEALTH_COMPONENTS.map((name) => ["GET", HEALTH_PREFIX + name])),
    HEALTH_COMPONENTS.length,
    "health_status_store_unavailable",
  );
  const statuses = {};
  const diagnostics = [];
  const now = Date.now();
  HEALTH_COMPONENTS.forEach((name, index) => {
    try {
      statuses[name] = healthStatusWithFreshness(name, parseHealthRecord(result[index], name, "health_status_store_corrupt"), now);
    } catch (error) {
      if (error?.code !== "health_status_store_corrupt") throw error;
      statuses[name] = corruptStoredHealthStatus(name);
      diagnostics.push({ component: name, code: "health_status_record_corrupt", corruptRecords: 1 });
    }
  });
  return { statuses, diagnostics };
}

export async function readHealthStatuses() {
  return (await readHealthStatusesWithDiagnostics()).statuses;
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
  const values = await redisCmd(["LRANGE", HEALTH_HISTORY_PREFIX + name, "0", "-1"]);
  if (!Array.isArray(values)) throw unavailable("health_history_store_unavailable");
  const records = [];
  let skipped = 0;
  values.forEach((value) => {
    try {
      const record = parseHealthRecord(value, name, "health_history_store_corrupt");
      if (record) records.push(healthStatusWithFreshness(name, record));
      else skipped += 1;
    } catch (error) {
      if (error?.code !== "health_history_store_corrupt") throw error;
      skipped += 1;
    }
  });
  if (skipped) console.warn("[health] skipped unreadable component history records", { component: name, skipped });
  return records.slice(0, safeLimit);
}

export async function readAllHealthHistory(limitPerComponent = 30) {
  const result = await readAllHealthHistoryWithDiagnostics(limitPerComponent);
  if (result.diagnostics.length > 0) {
    console.warn("[health] skipped unreadable records while reading all component history", {
      components: result.diagnostics.length,
      skipped: result.diagnostics.reduce((sum, item) => sum + Number(item.corruptRecords || 0), 0),
    });
  }
  return result.history;
}

export async function readAllHealthHistoryWithDiagnostics(limitPerComponent = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limitPerComponent || 30)));
  const result = strictPipelineRows(await redisPipeline(HEALTH_COMPONENTS.map((name) => [
    "LRANGE", HEALTH_HISTORY_PREFIX + name, "0", "-1",
  ])), HEALTH_COMPONENTS.length, "health_history_store_unavailable");
  const history = {};
  const diagnostics = [];
  HEALTH_COMPONENTS.forEach((name, index) => {
    if (!Array.isArray(result[index])) throw unavailable("health_history_store_unavailable");
    const records = [];
    let corruptRecords = 0;
    for (const value of result[index]) {
      try {
        const record = parseHealthRecord(value, name, "health_history_store_corrupt");
        if (record) records.push(record);
        else corruptRecords += 1;
      } catch (error) {
        if (error?.code !== "health_history_store_corrupt") throw error;
        corruptRecords += 1;
      }
    }
    history[name] = records.slice(0, safeLimit);
    if (corruptRecords > 0) {
      diagnostics.push({
        component: name,
        code: "health_history_record_corrupt",
        corruptRecords,
      });
    }
  });
  return { history, diagnostics };
}

export const healthKeys = { HEALTH_PREFIX, HEALTH_HISTORY_PREFIX, RECORD_HEALTH_SCRIPT };
