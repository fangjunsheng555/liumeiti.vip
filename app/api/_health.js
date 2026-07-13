import { clean, formatBeijingTime, redisCmd, redisPipeline } from "./_utils.js";

const HEALTH_PREFIX = "lm:health:";
export const HEALTH_COMPONENTS = ["redis", "resend", "resend_webhook", "telegram_backup", "restore_drill", "usdt", "renewal", "catalog"];

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function rows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry));
}

function safeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 40), typeof item === "number" || typeof item === "boolean" ? item : clean(item, 160)]));
}

export async function recordHealthStatus(component, { status = "ok", summary = "", error = "", metrics = {} } = {}) {
  const name = clean(component, 40).toLowerCase();
  if (!HEALTH_COMPONENTS.includes(name)) return null;
  const previous = parseJson(await redisCmd(["GET", HEALTH_PREFIX + name])) || {};
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
    lastSuccessAt: state === "ok" ? now.toISOString() : (previous.lastSuccessAt || ""),
    lastSuccessAtBeijing: state === "ok" ? formatBeijingTime(now) : (previous.lastSuccessAtBeijing || ""),
  };
  return (await redisCmd(["SET", HEALTH_PREFIX + name, JSON.stringify(record)])) === "OK" ? record : null;
}

export async function readHealthStatuses() {
  const result = rows(await redisPipeline(HEALTH_COMPONENTS.map((name) => ["GET", HEALTH_PREFIX + name])));
  const statuses = {};
  HEALTH_COMPONENTS.forEach((name, index) => { statuses[name] = parseJson(result[index]); });
  return statuses;
}

export async function checkRedisHealth() {
  const started = Date.now();
  const pong = await redisCmd(["PING"]);
  const ok = pong === "PONG";
  const record = await recordHealthStatus("redis", {
    status: ok ? "ok" : "error",
    summary: ok ? "Redis 连接正常" : "Redis 连接失败",
    error: ok ? "" : "ping_failed",
    metrics: { latencyMs: Date.now() - started },
  });
  return record || { component: "redis", status: ok ? "ok" : "error", summary: ok ? "Redis 连接正常" : "Redis 连接失败", metrics: { latencyMs: Date.now() - started } };
}

export const healthKeys = { HEALTH_PREFIX };
