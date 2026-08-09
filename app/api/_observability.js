import { createHash, randomBytes } from "node:crypto";
import { after as nextAfter } from "next/server.js";
import { clean, redisCmd, redisPipeline } from "./_utils.js";
import {
  CORE_API_AGGREGATE_GROUP,
  CORE_API_GROUP_NAMES,
  MONITORED_API_GROUP_NAMES,
} from "./_telemetry-groups.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const API_FIVE_MINUTE_PREFIX = "lm:obs:api:5m:v1:";
const API_HOUR_PREFIX = "lm:obs:api:1h:v1:";
const DEP_FIVE_MINUTE_PREFIX = "lm:obs:dep:5m:v1:";
const DEP_HOUR_PREFIX = "lm:obs:dep:1h:v1:";
const FIVE_MINUTE_TTL_SECONDS = 15 * 24 * 60 * 60;
const HOUR_TTL_SECONDS = 180 * 24 * 60 * 60;
const QUEUE_LATEST_KEY = "lm:ops:queue:last:v1";
const QUEUE_HISTORY_PREFIX = "lm:ops:queue:history:v1:";
const QUEUE_HISTORY_LIMIT = 500;
const TRACE_PREFIX = "lm:trace:order:v1:";
const TRACE_LOOKUP_PREFIX = "lm:trace:lookup:v1:";
const TRACE_DEDUPE_PREFIX = "lm:trace:dedupe:v1:";
const TRACE_TTL_SECONDS = 180 * 24 * 60 * 60;
const TRACE_LIMIT = 100;

const APPEND_TRACE_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key)
  local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'list') or not validtype(KEYS[2],'hash') or not validtype(KEYS[3],'string') then
  return redis.error_reply('trace_storage_type_error')
end
local limit=tonumber(ARGV[3]); local ttl=tonumber(ARGV[4])
if not limit or limit~=math.floor(limit) or limit<1 or limit>10000
  or not ttl or ttl~=math.floor(ttl) or ttl<1 or ttl>2147483647 then
  return redis.error_reply('trace_argument_error')
end
local existing=redis.call('HGET',KEYS[2],ARGV[1])
if existing then
  local encodedOk,encoded=pcall(cjson.encode,{ok=true,duplicate=true,event=existing})
  if not encodedOk then return redis.error_reply('trace_response_encode_failed') end
  redis.call('EXPIRE',KEYS[1],ARGV[4])
  redis.call('EXPIRE',KEYS[2],ARGV[4])
  redis.call('SET',KEYS[3],ARGV[5],'EX',ARGV[4])
  return encoded
end
local encodedOk,encoded=pcall(cjson.encode,{ok=true,duplicate=false,event=ARGV[2]})
if not encodedOk then return redis.error_reply('trace_response_encode_failed') end
redis.call('HSET',KEYS[2],ARGV[1],ARGV[2])
redis.call('LPUSH',KEYS[1],ARGV[2])
redis.call('LTRIM',KEYS[1],0,limit-1)
redis.call('EXPIRE',KEYS[1],ARGV[4])
redis.call('EXPIRE',KEYS[2],ARGV[4])
redis.call('SET',KEYS[3],ARGV[5],'EX',ARGV[4])
return encoded`;

const LATENCY_BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];

export const MONITORED_API_GROUPS = new Set(MONITORED_API_GROUP_NAMES);

export const OPERATIONAL_QUEUE_DEFINITIONS = [
  {
    name: "order_transitions",
    label: "订单恢复队列",
    key: "liumeiti:orders:pending-transitions:v1",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 20,
  },
  {
    name: "usdt_effects",
    label: "USDT 确认副作用",
    key: "lm:usdt:confirm-effects:pending",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 15 * 60 * 1000,
    criticalCount: 10,
  },
  {
    name: "after_sales_completion",
    label: "售后完成 Outbox",
    key: "liumeiti:after-sales:completion-outbox",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 20,
  },
  {
    name: "after_sales_creation",
    label: "售后创建 Outbox",
    key: "liumeiti:after-sales:creation-outbox",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 20,
  },
  {
    // Until the creation flow owns a dedicated outbox this is intentionally
    // labelled as pending tickets rather than pretending every member is an
    // unfinished side effect.
    name: "after_sales_pending",
    label: "待处理售后工单",
    key: "liumeiti:after-sales:status:pending",
    warningAgeMs: 24 * 60 * 60 * 1000,
    criticalAgeMs: 72 * 60 * 60 * 1000,
    criticalCount: 100,
  },
  {
    name: "marketing_queue",
    label: "营销邮件队列",
    key: "lm:mail:marketing:queue",
    warningAgeMs: 15 * 60 * 1000,
    criticalAgeMs: 60 * 60 * 1000,
    criticalCount: 50,
    countBasis: "due",
  },
  {
    name: "quote_expiry",
    label: "报价到期队列",
    key: "liumeiti:orders:quote-expiry",
    warningAgeMs: 10 * 60 * 1000,
    criticalAgeMs: 60 * 60 * 1000,
    criticalCount: 100,
  },
  {
    name: "usdt_pending_orders",
    label: "待确认 USDT 订单",
    key: "liumeiti:orders:usdt-pending",
    warningAgeMs: 45 * 60 * 1000,
    criticalAgeMs: 4 * 60 * 60 * 1000,
    criticalCount: 50,
  },
  {
    name: "durable_started",
    label: "未完成持久操作",
    key: "liumeiti:durable-operation:v1:started-index",
    warningAgeMs: 10 * 60 * 1000,
    criticalAgeMs: 60 * 60 * 1000,
    criticalCount: 20,
  },
  {
    name: "delivery_uncertain",
    label: "结果不确定的外部投递",
    key: "lm:delivery:v2:status:uncertain",
    warningAgeMs: 2 * 60 * 1000,
    criticalAgeMs: 10 * 60 * 1000,
    criticalCount: 3,
  },
  {
    name: "delivery_sending",
    label: "发送中的外部投递",
    key: "lm:delivery:v2:status:sending",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 20 * 60 * 1000,
    criticalCount: 10,
  },
  {
    name: "delivery_retryable",
    label: "等待重试的外部投递",
    key: "lm:delivery:v2:status:retryable",
    warningAgeMs: 10 * 60 * 1000,
    criticalAgeMs: 60 * 60 * 1000,
    criticalCount: 20,
  },
  {
    name: "telegram_alert_retry",
    label: "Telegram 告警重试",
    key: "lm:ops:telegram:retry:v1",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 10,
  },
  {
    name: "push_outbox",
    label: "浏览器 Push Outbox",
    key: "lm:push:outbox:v1",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 50,
  },
  {
    name: "push_enqueue_recovery",
    label: "Push 入队恢复",
    key: "lm:push:enqueue-recovery-index:v1",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 20,
  },
  {
    name: "push_provider_alerts",
    label: "Push 服务商异常",
    key: "lm:push:provider-alerts-index:v1",
    warningAgeMs: 5 * 60 * 1000,
    criticalAgeMs: 30 * 60 * 1000,
    criticalCount: 10,
  },
];

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry
  ));
}

function pipelineRowFailed(entry) {
  return entry == null || (entry && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "error"));
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function hashObject(value) {
  if (!value) return {};
  if (!Array.isArray(value) && typeof value === "object") return value;
  if (!Array.isArray(value)) return {};
  const out = {};
  for (let index = 0; index + 1 < value.length; index += 2) out[String(value[index])] = value[index + 1];
  return out;
}

function normalizedMetricGroup(value, fallback = "other") {
  const group = clean(value, 60).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return group || fallback;
}

function bucketStart(now, size) {
  return Math.floor(Number(now || Date.now()) / size) * size;
}

function latencyBucket(durationMs) {
  const value = Math.max(0, Math.round(Number(durationMs || 0)));
  const boundary = LATENCY_BUCKETS.find((item) => value <= item);
  return boundary === Infinity ? "inf" : String(boundary);
}

function statusClass(status) {
  const value = Math.max(0, Math.floor(Number(status || 0)));
  if (value >= 500) return "5xx";
  if (value >= 400) return "4xx";
  if (value >= 300) return "3xx";
  if (value >= 200) return "2xx";
  return "other";
}

function metricCommands(key, ttlSeconds, group, sample) {
  const duration = Math.max(0, Math.round(Number(sample.durationMs || 0)));
  const prefix = `${group}:`;
  const commands = [
    ["HINCRBY", key, `${prefix}requests`, "1"],
    ["HINCRBY", key, `${prefix}status_${statusClass(sample.status)}`, "1"],
  ];
  if (sample.timed !== false) {
    commands.push(
      ["HINCRBY", key, `${prefix}timed_requests`, "1"],
      ["HINCRBY", key, `${prefix}duration_sum_ms`, String(duration)],
      ["HINCRBY", key, `${prefix}latency_${latencyBucket(duration)}`, "1"],
    );
  }
  if (sample.thrown) commands.push(["HINCRBY", key, `${prefix}thrown`, "1"]);
  commands.push(["EXPIRE", key, String(ttlSeconds)]);
  return commands;
}

export function observabilityWritesEnabled() {
  const environment = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  return !environment || environment === "production";
}

async function recordTimedMetric(kind, groupValue, sample = {}) {
  if (!observabilityWritesEnabled()) return true;
  const group = normalizedMetricGroup(groupValue);
  const now = Number(sample.at || Date.now());
  const isDependency = kind === "dependency";
  const fiveKey = `${isDependency ? DEP_FIVE_MINUTE_PREFIX : API_FIVE_MINUTE_PREFIX}${bucketStart(now, FIVE_MINUTES_MS)}`;
  const hourKey = `${isDependency ? DEP_HOUR_PREFIX : API_HOUR_PREFIX}${bucketStart(now, HOUR_MS)}`;
  const groups = isDependency
    ? (group === "all" ? ["all"] : ["all", group])
    : group === "all"
      ? ["all"]
      : MONITORED_API_GROUPS.has(group) ? ["all", group] : [group];
  const commands = [];
  for (const metricGroup of groups) {
    commands.push(...metricCommands(fiveKey, FIVE_MINUTE_TTL_SECONDS, metricGroup, sample));
    commands.push(...metricCommands(hourKey, HOUR_TTL_SECONDS, metricGroup, sample));
  }
  try {
    const rows = pipelineRows(await redisPipeline(commands));
    return rows.length === commands.length && rows.every((entry) => !pipelineRowFailed(entry));
  } catch {
    return false;
  }
}

export async function recordApiMetric(group, sample = {}) {
  return recordTimedMetric("api", group, sample);
}

export async function recordDependencyMetric(group, sample = {}) {
  return recordTimedMetric("dependency", group, sample);
}

function scheduleBestEffort(task) {
  try {
    nextAfter(async () => {
      try { await task(); } catch {}
    });
    return "after";
  } catch {
    // Plain Node tests and non-request callers have no Next request context.
    // Run in a microtask there while still keeping response latency off the
    // critical path.
    queueMicrotask(() => { Promise.resolve().then(task).catch(() => {}); });
    return "microtask";
  }
}

export function withApiTelemetry(group, handler) {
  if (typeof handler !== "function") throw new TypeError("handler_required");
  return async function observedHandler(...args) {
    const started = Date.now();
    const response = await handler(...args);
    const durationMs = Date.now() - started;
    scheduleBestEffort(() => recordApiMetric(group, {
      status: Number(response?.status || 200),
      durationMs,
    }));
    // Unhandled exceptions are deliberately left to instrumentation.js. If
    // they were recorded here as well, Next's onRequestError hook would count
    // every thrown request twice.
    return response;
  };
}

export async function recordApiException({ route = "unknown", durationMs = 0 } = {}) {
  return recordApiMetric(route, { status: 500, durationMs, thrown: true, timed: false });
}

function histogramPercentile(counts, percentile) {
  const total = LATENCY_BUCKETS.reduce((sum, boundary) => sum + Number(counts[boundary === Infinity ? "inf" : String(boundary)] || 0), 0);
  if (!total) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  let seen = 0;
  for (const boundary of LATENCY_BUCKETS) {
    seen += Number(counts[boundary === Infinity ? "inf" : String(boundary)] || 0);
    if (seen >= target) return boundary === Infinity ? 10000 : boundary;
  }
  return 10000;
}

function metricPoint(raw, at, group) {
  const hash = hashObject(raw);
  const groups = [...new Set((Array.isArray(group) ? group : [group])
    .map((item) => normalizedMetricGroup(item))
    .filter(Boolean))];
  const sum = (field) => groups.reduce((total, item) => total + Number(hash[`${item}:${field}`] || 0), 0);
  const histogram = {};
  for (const boundary of LATENCY_BUCKETS) {
    const label = boundary === Infinity ? "inf" : String(boundary);
    histogram[label] = sum(`latency_${label}`);
  }
  const requests = sum("requests");
  const timedRequests = groups.reduce((total, item) => {
    const value = hash[`${item}:timed_requests`];
    return total + (value == null ? Number(hash[`${item}:requests`] || 0) : Number(value || 0));
  }, 0);
  const status5xx = sum("status_5xx");
  return {
    at: new Date(at).toISOString(),
    requests,
    timedRequests,
    status2xx: sum("status_2xx"),
    status3xx: sum("status_3xx"),
    status4xx: sum("status_4xx"),
    status5xx,
    thrown: sum("thrown"),
    averageMs: timedRequests ? Math.round(sum("duration_sum_ms") / timedRequests) : 0,
    p50Ms: histogramPercentile(histogram, 0.5),
    p95Ms: histogramPercentile(histogram, 0.95),
    p99Ms: histogramPercentile(histogram, 0.99),
    errorRate: requests ? status5xx / requests : 0,
    histogram,
  };
}

function rangeMilliseconds(value) {
  const safe = clean(value || "24h", 20).toLowerCase();
  const match = safe.match(/^(\d{1,3})(h|d)$/);
  if (!match) return 24 * HOUR_MS;
  const amount = Math.max(1, Number(match[1]));
  return Math.min(180 * 24 * HOUR_MS, amount * (match[2] === "d" ? 24 * HOUR_MS : HOUR_MS));
}

export async function readMetricSeries({ kind = "api", group = "all", range = "24h", now = Date.now() } = {}) {
  const windowMs = rangeMilliseconds(range);
  const resolutionMs = windowMs <= 48 * HOUR_MS ? FIVE_MINUTES_MS : HOUR_MS;
  const prefix = kind === "dependency"
    ? (resolutionMs === FIVE_MINUTES_MS ? DEP_FIVE_MINUTE_PREFIX : DEP_HOUR_PREFIX)
    : (resolutionMs === FIVE_MINUTES_MS ? API_FIVE_MINUTE_PREFIX : API_HOUR_PREFIX);
  const safeGroup = normalizedMetricGroup(group, "all");
  const end = bucketStart(now, resolutionMs);
  const start = bucketStart(Math.max(0, now - windowMs), resolutionMs);
  const buckets = [];
  for (let at = start; at <= end && buckets.length < 5000; at += resolutionMs) buckets.push(at);
  if (!buckets.length) return { points: [], resolutionMs, range };
  const commands = buckets.map((at) => ["HGETALL", `${prefix}${at}`]);
  const rows = pipelineRows(await redisPipeline(commands));
  if (rows.length !== commands.length || rows.some((entry) => (
    entry == null || (entry && typeof entry === "object" && !Array.isArray(entry) && entry.error)
  ))) {
    const error = new Error("metric_series_unavailable");
    error.code = "metric_series_unavailable";
    throw error;
  }
  const metricGroups = kind !== "dependency" && safeGroup === CORE_API_AGGREGATE_GROUP
    ? CORE_API_GROUP_NAMES
    : safeGroup;
  const points = buckets.map((at, index) => metricPoint(rows[index], at, metricGroups));
  return { points, resolutionMs, range, group: safeGroup };
}

export function summarizeMetricSeries(points) {
  const list = Array.isArray(points) ? points : [];
  const totals = list.reduce((out, point) => {
    out.requests += Number(point.requests || 0);
    out.status2xx += Number(point.status2xx || 0);
    out.status3xx += Number(point.status3xx || 0);
    out.status4xx += Number(point.status4xx || 0);
    out.status5xx += Number(point.status5xx || 0);
    out.thrown += Number(point.thrown || 0);
    for (const [key, value] of Object.entries(point.histogram || {})) out.histogram[key] = (out.histogram[key] || 0) + Number(value || 0);
    return out;
  }, { requests: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, thrown: 0, histogram: {} });
  totals.errorRate = totals.requests ? totals.status5xx / totals.requests : 0;
  totals.p50Ms = histogramPercentile(totals.histogram, 0.5);
  totals.p95Ms = histogramPercentile(totals.histogram, 0.95);
  totals.p99Ms = histogramPercentile(totals.histogram, 0.99);
  return totals;
}

function oldestScore(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const score = Number(value[1]);
  return Number.isFinite(score) && Number.isFinite(new Date(score).getTime()) ? score : Number.NaN;
}

function queueStatus(definition, count, dueCount, ageMs) {
  const backlogCount = definition.countBasis === "due" ? dueCount : count;
  if (backlogCount >= definition.criticalCount || (dueCount > 0 && ageMs >= definition.criticalAgeMs)) return "error";
  if (dueCount > 0 && ageMs >= definition.warningAgeMs) return "warning";
  return "ok";
}

export async function sampleOperationalQueues({ now = Date.now() } = {}) {
  const commands = OPERATIONAL_QUEUE_DEFINITIONS.flatMap((definition) => [
    ["ZCARD", definition.key],
    ["ZCOUNT", definition.key, "-inf", String(now)],
    ["ZRANGE", definition.key, "0", "0", "WITHSCORES"],
  ]);
  const rows = pipelineRows(await redisPipeline(commands));
  const unavailable = rows.length !== commands.length || rows.some(pipelineRowFailed);
  if (unavailable) {
    const error = new Error("operational_queue_sample_unavailable");
    error.code = "operational_queue_sample_unavailable";
    throw error;
  }
  const snapshots = [];
  const historyCommands = [];
  const invalidScoreQueues = [];
  OPERATIONAL_QUEUE_DEFINITIONS.forEach((definition, index) => {
    const count = Math.max(0, Number(rows[index * 3] || 0));
    const dueCount = Math.max(0, Number(rows[index * 3 + 1] || 0));
    const score = oldestScore(rows[index * 3 + 2]);
    const invalidScore = Number.isNaN(score);
    const hasScore = Number.isFinite(score);
    const ageMs = hasScore ? Math.max(0, now - score) : 0;
    const status = queueStatus(definition, count, dueCount, ageMs);
    if (invalidScore) invalidScoreQueues.push(definition.name);
    const snapshot = {
      name: definition.name,
      label: definition.label,
      count,
      dueCount,
      backlogCount: definition.countBasis === "due" ? dueCount : count,
      countBasis: definition.countBasis || "total",
      oldestAt: hasScore ? new Date(score).toISOString() : "",
      oldestAgeMs: ageMs,
      warningAgeMs: definition.warningAgeMs,
      criticalAgeMs: definition.criticalAgeMs,
      criticalCount: definition.criticalCount,
      status: invalidScore && status === "ok" ? "warning" : status,
      checkedAt: new Date(now).toISOString(),
      ...(invalidScore ? { error: "operational_queue_score_invalid" } : {}),
    };
    snapshots.push(snapshot);
    const raw = JSON.stringify(snapshot);
    historyCommands.push(
      ["HSET", QUEUE_LATEST_KEY, definition.name, raw],
      ["LPUSH", QUEUE_HISTORY_PREFIX + definition.name, raw],
      ["LTRIM", QUEUE_HISTORY_PREFIX + definition.name, "0", String(QUEUE_HISTORY_LIMIT - 1)],
    );
  });
  if (invalidScoreQueues.length) console.warn("[observability] queue snapshots ignored invalid oldest scores", { queues: invalidScoreQueues });
  if (historyCommands.length && observabilityWritesEnabled()) {
    const saved = pipelineRows(await redisPipeline(historyCommands));
    if (saved.length !== historyCommands.length || saved.some(pipelineRowFailed)) {
      const error = new Error("operational_queue_snapshot_write_failed");
      error.code = "operational_queue_snapshot_write_failed";
      throw error;
    }
  }
  return snapshots;
}

export async function readLatestQueueSnapshots() {
  const rows = pipelineRows(await redisPipeline([["HGETALL", QUEUE_LATEST_KEY], ["PING"]]));
  if (rows.length !== 2 || pipelineRowFailed(rows[0]) || rows[1] !== "PONG") {
    const error = new Error("operational_queue_snapshot_unavailable");
    error.code = "operational_queue_snapshot_unavailable";
    throw error;
  }
  const raw = hashObject(rows[0]);
  const corruptQueues = [];
  const storedCount = (value, fallback = null) => {
    if (value === undefined && fallback !== null) return fallback;
    if (!((typeof value === "number") || (typeof value === "string" && value.trim()))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const snapshots = OPERATIONAL_QUEUE_DEFINITIONS.map((definition) => {
    const stored = raw[definition.name];
    if (stored == null || stored === "") return {
      name: definition.name,
      label: definition.label,
      count: 0,
      dueCount: 0,
      oldestAt: "",
      oldestAgeMs: 0,
      status: "unknown",
      checkedAt: "",
    };
    const value = parseJson(stored);
    const count = storedCount(value?.count);
    const dueCount = storedCount(value?.dueCount, 0);
    const checkedAt = typeof value?.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt));
    const oldestAt = value?.oldestAt === undefined || value.oldestAt === ""
      || (typeof value.oldestAt === "string" && Number.isFinite(Date.parse(value.oldestAt)));
    const oldestAgeMs = value?.oldestAgeMs === undefined || storedCount(value.oldestAgeMs) !== null;
    const valid = value && typeof value === "object" && !Array.isArray(value)
      && value.name === definition.name
      && count !== null
      && dueCount !== null
      && dueCount <= count
      && ["ok", "warning", "error", "unknown"].includes(value.status)
      && checkedAt
      && oldestAt
      && oldestAgeMs;
    if (!valid) {
      corruptQueues.push(definition.name);
      return {
        name: definition.name,
        label: definition.label,
        count: 0,
        dueCount: 0,
        oldestAt: "",
        oldestAgeMs: 0,
        status: "error",
        checkedAt: "",
        error: "operational_queue_snapshot_corrupt",
      };
    }
    return { ...value, count, dueCount };
  });
  if (corruptQueues.length) {
    console.warn("[observability] replaced unreadable queue snapshots", {
      skipped: corruptQueues.length,
      queues: corruptQueues.slice(0, 10),
    });
  }
  return snapshots;
}

export function businessTraceIdForOrder(orderId) {
  const normalized = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  if (!normalized) return "";
  return `ord_${createHash("sha256").update(`order\0${normalized}`).digest("hex").slice(0, 32)}`;
}

export async function resolveBusinessTraceOrderId(value) {
  const input = clean(value, 80).replace(/\s+/g, "");
  if (!input) return "";
  if (/^ord_[a-f0-9]{32}$/i.test(input)) {
    const rows = pipelineRows(await redisPipeline([
      ["GET", TRACE_LOOKUP_PREFIX + input.toLowerCase()],
      ["PING"],
    ]));
    const mappingError = rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0]) && Object.hasOwn(rows[0], "error");
    if (rows.length !== 2 || mappingError || rows[1] !== "PONG") {
      const error = new Error("trace_store_unavailable");
      error.code = "trace_store_unavailable";
      throw error;
    }
    const mapped = clean(rows[0], 80)
      .replace(/\s+/g, "")
      .toUpperCase();
    return mapped || "";
  }
  return input.toUpperCase();
}

export function makeTraceId() {
  return randomBytes(16).toString("hex");
}

export function makeSpanId() {
  return randomBytes(8).toString("hex");
}

function safeTraceEvent(orderId, event = {}) {
  const businessTraceId = clean(event.businessTraceId, 40) || businessTraceIdForOrder(orderId);
  return {
    businessTraceId,
    traceId: /^[a-f0-9]{32}$/i.test(String(event.traceId || "")) ? String(event.traceId).toLowerCase() : makeTraceId(),
    spanId: /^[a-f0-9]{16}$/i.test(String(event.spanId || "")) ? String(event.spanId).toLowerCase() : makeSpanId(),
    parentSpanId: /^[a-f0-9]{16}$/i.test(String(event.parentSpanId || "")) ? String(event.parentSpanId).toLowerCase() : "",
    stage: normalizedMetricGroup(event.stage, "unknown"),
    component: normalizedMetricGroup(event.component, "app"),
    outcome: ["ok", "error", "uncertain", "retry", "skipped"].includes(event.outcome) ? event.outcome : "ok",
    durationMs: Math.max(0, Math.round(Number(event.durationMs || 0))),
    operationId: clean(event.operationId, 160),
    errorCode: clean(event.errorCode, 120),
    at: new Date(event.at || Date.now()).toISOString(),
  };
}

export async function appendBusinessTraceEvent(orderId, event = {}) {
  const id = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  if (!id) return null;
  const safe = safeTraceEvent(id, event);
  const key = TRACE_PREFIX + id;
  const fingerprint = createHash("sha256")
    .update(`${id}\0${safe.stage}\0${safe.operationId}\0${safe.outcome}`)
    .digest("hex");
  const result = parseJson(await redisCmd([
    "EVAL", APPEND_TRACE_SCRIPT, "3",
    key,
    TRACE_DEDUPE_PREFIX + id,
    TRACE_LOOKUP_PREFIX + safe.businessTraceId,
    fingerprint,
    JSON.stringify(safe),
    String(TRACE_LIMIT),
    String(TRACE_TTL_SECONDS),
    id,
  ]));
  if (!result?.ok) return null;
  const stored = parseJson(result.event) || safe;
  return { ...stored, duplicate: Boolean(result.duplicate) };
}

export async function readBusinessTrace(orderId, limit = TRACE_LIMIT) {
  const id = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  if (!id) return { orderId: "", businessTraceId: "", events: [] };
  const safeLimit = Math.max(1, Math.min(TRACE_LIMIT, Number(limit || TRACE_LIMIT)));
  const result = pipelineRows(await redisPipeline([
    ["LRANGE", TRACE_PREFIX + id, "0", "-1"],
    ["PING"],
  ]));
  if (result.length !== 2 || !Array.isArray(result[0]) || pipelineRowFailed(result[0]) || result[1] !== "PONG") {
    const error = new Error("trace_store_unavailable");
    error.code = "trace_store_unavailable";
    throw error;
  }
  const events = [];
  let corruptCount = 0;
  for (const value of result[0]) {
    const parsed = parseJson(value);
    const valid = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Boolean(clean(parsed.stage, 60))
      && ["ok", "error", "uncertain", "retry", "skipped"].includes(parsed.outcome);
    if (!valid) {
      corruptCount += 1;
      continue;
    }
    events.push(parsed);
  }
  if (corruptCount) console.warn(`[observability] ignored ${corruptCount} corrupt trace event(s) for ${id}`);
  return {
    orderId: id,
    businessTraceId: businessTraceIdForOrder(id),
    events: events.slice(0, safeLimit),
    corruptCount,
  };
}

export const observabilityInternals = {
  FIVE_MINUTES_MS,
  HOUR_MS,
  LATENCY_BUCKETS,
  bucketStart,
  hashObject,
  histogramPercentile,
  latencyBucket,
  metricPoint,
  normalizedMetricGroup,
  queueStatus,
  scheduleBestEffort,
  safeTraceEvent,
  statusClass,
};
