import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

process.env.AUTH_SECRET = "health-observability-test-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "root-admin";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.KV_REST_API_URL = "http://health-observability.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const strings = new Map();
const hashes = new Map();
const lists = new Map();
const sortedSets = new Map();
const originalFetch = globalThis.fetch;
let partialQueueSample = false;
let partialPushStats = false;
let queueSnapshotWrites = 0;
let durableClaimCalls = 0;
let failDurableClaimAt = 0;
let telemetryPipelineErrorAt = -1;
let redisFaultMode = "";
let telegramFetches = 0;

function hash(key) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  return hashes.get(key);
}

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function sortedEntries(key, reverse = false) {
  return [...sortedSet(key).entries()].sort((a, b) => reverse ? b[1] - a[1] : a[1] - b[1]);
}

function executeEval(args) {
  const script = String(args[0] || "");
  const keyCount = Number(args[1] || 0);
  const keys = args.slice(2, 2 + keyCount);
  const argv = args.slice(2 + keyCount);

  if (script.includes("local current=redis.call('GET',KEYS[1])")
    && script.includes("redis.call('LPUSH', KEYS[2], encoded)")) {
    const current = strings.get(keys[0]);
    if (argv[2] === "0" ? current != null : current == null || current !== argv[3]) return "__conflict__";
    const encoded = String(argv[0]);
    strings.set(keys[0], encoded);
    const history = lists.get(keys[1]) || [];
    history.unshift(encoded);
    lists.set(keys[1], history.slice(0, Number(argv[1])));
    return encoded;
  }

  if (script.includes("local existing=redis.call('HGET',KEYS[2],ARGV[1])") && script.includes("LPUSH")) {
    const existing = hash(keys[1]).get(argv[0]);
    strings.set(keys[2], argv[4]);
    if (existing) return JSON.stringify({ ok: true, duplicate: true, event: existing });
    hash(keys[1]).set(argv[0], argv[1]);
    const events = lists.get(keys[0]) || [];
    events.unshift(argv[1]);
    lists.set(keys[0], events.slice(0, Number(argv[2])));
    return JSON.stringify({ ok: true, duplicate: false, event: argv[1] });
  }

  if (script.includes("incident_id_conflict") && script.includes("fingerprint_conflict") && script.includes("LTRIM")) {
    const mapped = strings.get(keys[0]);
    if (mapped) return JSON.stringify({ ok: false, error: "fingerprint_conflict", incidentId: mapped });
    if (strings.has(keys[1])) return JSON.stringify({ ok: false, error: "incident_id_conflict" });
    strings.set(keys[0], argv[0]);
    strings.set(keys[1], argv[1]);
    sortedSet(keys[2]).set(argv[0], Number(argv[2]));
    const events = lists.get(keys[3]) || [];
    events.unshift(argv[3]);
    lists.set(keys[3], events.slice(0, Number(argv[4])));
    return JSON.stringify({ ok: true });
  }

  if (script.includes("mappingAction") && script.includes("stale_version")) {
    const current = parseJson(strings.get(keys[0]));
    if (!current) return JSON.stringify({ ok: false, error: "incident_not_found" });
    if (Number(current.version || 0) !== Number(argv[0])) {
      return JSON.stringify({ ok: false, error: "stale_version", current });
    }
    const next = parseJson(argv[1]);
    if (argv[2] === "claim") {
      const mapped = strings.get(keys[1]);
      if (mapped && mapped !== argv[3]) return JSON.stringify({ ok: false, error: "fingerprint_conflict", incidentId: mapped });
      strings.set(keys[1], argv[3]);
    } else if (argv[2] === "release" && strings.get(keys[1]) === argv[3]) {
      strings.delete(keys[1]);
    }
    strings.set(keys[0], argv[1]);
    const events = lists.get(keys[2]) || [];
    events.unshift(argv[4]);
    lists.set(keys[2], events.slice(0, Number(argv[5])));
    return JSON.stringify({ ok: true, record: next });
  }

  if (script.includes("durable_claim_v2_lossless")) {
    if (keys[0] !== `liumeiti:durable-operation:v1:${argv[1]}`) return ["error", "invalid_operation_record"];
    durableClaimCalls += 1;
    if (failDurableClaimAt && durableClaimCalls === failDurableClaimAt) return null;
    const existingRaw = strings.get(keys[0]);
    if (existingRaw != null) {
      const existing = parseJson(existingRaw);
      if (!existing || typeof existing.requestHash !== "string") return ["error", "operation_record_corrupt"];
      if (existing.operationId !== argv[1]) return ["error", "operation_record_corrupt"];
      if (existing.requestHash !== argv[0]) return ["error", "idempotency_conflict"];
      const state = String(existing.state || "started");
      if (state === "done") sortedSet(keys[1]).delete(argv[1]);
      else sortedSet(keys[1]).set(argv[1], Number(existing.startedAtMs || argv[3]));
      return ["ok", state, existingRaw, "0"];
    }
    const record = parseJson(argv[4]);
    if (!record || record.requestHash !== argv[0] || record.operationId !== argv[1] || record.state !== "started") {
      return ["error", "invalid_operation_record"];
    }
    strings.set(keys[0], argv[4]);
    sortedSet(keys[1]).set(argv[1], Number(argv[3]));
    return ["ok", "started", argv[4], "1"];
  }

  if (script.includes("durable_complete_v2_lossless")) {
    if (keys[0] !== `liumeiti:durable-operation:v1:${argv[2]}`) return ["error", "invalid_operation_record"];
    const raw = strings.get(keys[0]);
    const record = parseJson(raw);
    if (!record) return ["error", "operation_record_missing"];
    if (record.operationId !== argv[2]) return ["error", "operation_record_corrupt"];
    if (record.requestHash !== argv[0]) return ["error", "idempotency_conflict"];
    if (record.state === "done") {
      sortedSet(keys[1]).delete(record.operationId || argv[2]);
      return ["done", raw, "1"];
    }
    if (raw !== argv[1]) return ["stale", raw];
    const replacement = parseJson(argv[3]);
    if (!replacement || replacement.requestHash !== argv[0] || replacement.operationId !== argv[2]
      || replacement.state !== "done" || !replacement.result) {
      return ["error", "invalid_operation_result"];
    }
    strings.set(keys[0], argv[3]);
    sortedSet(keys[1]).delete(record.operationId || argv[2]);
    return ["done", argv[3], "0"];
  }

  if (script.includes("local marked=redis.call('SET',KEYS[1],'1','NX')")) {
    if (strings.has(keys[0])) return 0;
    strings.set(keys[0], "1");
    const log = lists.get(keys[1]) || [];
    log.unshift(argv[0]);
    lists.set(keys[1], log.slice(0, 500));
    return 1;
  }

  if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]") && script.includes("redis.call('DEL',KEYS[1])")) {
    if (strings.get(keys[0]) !== argv[0]) return 0;
    strings.delete(keys[0]);
    return 1;
  }

  throw new Error(`unexpected EVAL: ${script.slice(0, 80)}`);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return strings.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((item) => String(item).toUpperCase()).includes("NX") && strings.has(key)) return null;
    strings.set(key, value);
    return "OK";
  }
  if (name === "DEL") {
    let removed = 0;
    for (const key of args) {
      if (strings.delete(key)) removed += 1;
      if (hashes.delete(key)) removed += 1;
      if (lists.delete(key)) removed += 1;
      if (sortedSets.delete(key)) removed += 1;
    }
    return removed;
  }
  if (name === "EXISTS") return strings.has(args[0]) || hashes.has(args[0]) || lists.has(args[0]) || sortedSets.has(args[0]) ? 1 : 0;
  if (name === "EXPIRE" || name === "PEXPIRE") return 1;
  if (name === "INCR") {
    const next = Number(strings.get(args[0]) || 0) + 1;
    strings.set(args[0], String(next));
    return next;
  }
  if (name === "HSET") {
    const target = hash(args[0]);
    for (let index = 1; index + 1 < args.length; index += 2) target.set(args[index], args[index + 1]);
    if (args[0] === "lm:ops:queue:last:v1") queueSnapshotWrites += 1;
    return 1;
  }
  if (name === "HINCRBY") {
    const target = hash(args[0]);
    const next = Number(target.get(args[1]) || 0) + Number(args[2] || 0);
    target.set(args[1], String(next));
    return next;
  }
  if (name === "HGETALL") return [...hash(args[0]).entries()].flat();
  if (name === "HLEN") return hash(args[0]).size;
  if (name === "LPUSH") {
    const target = lists.get(args[0]) || [];
    target.unshift(...args.slice(1));
    lists.set(args[0], target);
    return target.length;
  }
  if (name === "LTRIM") {
    const target = lists.get(args[0]) || [];
    lists.set(args[0], target.slice(Number(args[1]), Number(args[2]) + 1));
    return "OK";
  }
  if (name === "LRANGE") {
    const target = lists.get(args[0]) || [];
    return target.slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
  }
  if (name === "LINDEX") {
    const target = lists.get(args[0]) || [];
    const index = Number(args[1]);
    return target[index < 0 ? target.length + index : index] ?? null;
  }
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") return sortedSet(args[0]).delete(args[1]) ? 1 : 0;
  if (name === "ZREMRANGEBYRANK") {
    const target = sortedSet(args[0]);
    const entries = sortedEntries(args[0]);
    const start = Number(args[1]);
    const rawStop = Number(args[2]);
    const stop = rawStop < 0 ? entries.length + rawStop : rawStop;
    let removed = 0;
    entries.slice(Math.max(0, start), Math.max(0, stop + 1)).forEach(([member]) => {
      if (target.delete(member)) removed += 1;
    });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZSCORE") {
    const score = sortedSet(args[0]).get(args[1]);
    return score == null ? null : String(score);
  }
  if (name === "ZCOUNT") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    return sortedEntries(args[0]).filter(([, score]) => score >= min && score <= max).length;
  }
  if (name === "ZRANGE" || name === "ZREVRANGE") {
    const entries = sortedEntries(args[0], name === "ZREVRANGE").slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
    return args.map(String).includes("WITHSCORES") ? entries.flatMap(([member, score]) => [member, String(score)]) : entries.map(([member]) => member);
  }
  if (name === "ZRANGEBYSCORE") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    let entries = sortedEntries(args[0]).filter(([, score]) => score >= min && score <= max);
    const limitIndex = args.findIndex((value) => String(value).toUpperCase() === "LIMIT");
    if (limitIndex >= 0) entries = entries.slice(Number(args[limitIndex + 1]), Number(args[limitIndex + 1]) + Number(args[limitIndex + 2]));
    return entries.map(([member]) => member);
  }
  if (name === "SCAN") {
    const prefix = String(args[2] || "").replace(/\*$/, "");
    return ["0", [...strings.keys()].filter((key) => key.startsWith(prefix))];
  }
  if (name === "EVAL") return executeEval(args);
  throw new Error(`unhandled Redis command ${name}`);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "api.telegram.org") {
    telegramFetches += 1;
    return Response.json({ ok: false }, { status: 503 });
  }
  if (url.origin !== "http://health-observability.redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    if (redisFaultMode === "queue_read_outage" && commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === "lm:ops:queue:last:v1") {
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (redisFaultMode === "trace_order_outage" && commands[0]?.[0] === "GET" && String(commands[0]?.[1] || "").startsWith("liumeiti:orders:record:")) {
      return Response.json(commands.map((command) => ({ result: command[0] === "PING" ? null : execute(command) })));
    }
    if (redisFaultMode === "trace_store_outage" && commands[0]?.[0] === "LRANGE" && String(commands[0]?.[1] || "").startsWith("lm:trace:order:v1:")) {
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (redisFaultMode === "incident_record_outage" && commands[0]?.[0] === "GET" && String(commands[0]?.[1] || "").startsWith("lm:incident:record:v1:")) {
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (redisFaultMode === "incident_list_outage" && commands[0]?.[0] === "ZREVRANGE" && commands[0]?.[1] === "lm:incident:index:v1") {
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (redisFaultMode === "incident_lock_outage" && commands[0]?.[0] === "GET" && String(commands[0]?.[1] || "").startsWith("liumeiti:durable-operation:v1:") && String(commands[0]?.[1] || "").endsWith(":lock")) {
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (redisFaultMode === "durable_backfill_read_outage"
      && commands.length > 0
      && commands.every((command) => command[0] === "GET")
      && String(commands[0]?.[1] || "").startsWith("liumeiti:durable-operation:v1:")) {
      return Response.json(commands.map((command, index) => (
        index === 0 ? { error: "ERR injected durable backfill read failure" } : { result: execute(command) }
      )));
    }
    if (partialPushStats && commands[0]?.[0] === "HLEN" && commands[0]?.[1] === "lm:push:subscriptions:v1") {
      return Response.json(commands.map((command, index) => ({ result: index === 0 ? null : execute(command) })));
    }
    if (partialQueueSample && commands[0]?.[0] === "ZCARD") {
      return Response.json([{ result: 0 }]);
    }
    if (telemetryPipelineErrorAt >= 0 && String(commands[0]?.[1] || "").startsWith("lm:obs:api:")) {
      return Response.json(commands.map((command, index) => (
        index === telemetryPipelineErrorAt
          ? { error: "ERR injected telemetry pipeline failure" }
          : { result: execute(command) }
      )));
    }
    if (redisFaultMode === "health_history_outage"
      && commands[0]?.[0] === "LRANGE"
      && String(commands[0]?.[1] || "").startsWith("lm:health:history:v1:")) {
      return Response.json(commands.map((command, index) => (
        index === 0 ? { result: null } : { result: execute(command) }
      )));
    }
    if (redisFaultMode === "job_history_outage"
      && commands[0]?.[0] === "GET"
      && String(commands[0]?.[1] || "").startsWith("lm:ops:job:run:v1:")) {
      return Response.json(commands.map((command) => ({
        result: command[0] === "PING" ? null : execute(command),
      })));
    }
    return Response.json(commands.map((command) => ({ result: execute(command) })));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (redisFaultMode === "incident_lock_outage" && command[0] === "SET" && String(command[1] || "").startsWith("liumeiti:durable-operation:v1:") && String(command[1] || "").endsWith(":lock")) {
    return Response.json({ result: null });
  }
  if (redisFaultMode === "incident_lock_acquire_response_lost" && command[0] === "SET" && String(command[1] || "").startsWith("liumeiti:durable-operation:v1:") && String(command[1] || "").endsWith(":lock")) {
    execute(command);
    return Response.json({ result: null });
  }
  if (redisFaultMode === "incident_lock_release_response_lost" && command[0] === "EVAL" && String(command[3] || "").startsWith("liumeiti:durable-operation:v1:") && String(command[3] || "").endsWith(":lock")) {
    execute(command);
    return Response.json({ result: null });
  }
  if (["incident_create_response_lost", "incident_create_response_lost_bad_event"].includes(redisFaultMode)
      && command[0] === "EVAL" && String(command[1] || "").includes("incident_id_conflict")
      && String(command[1] || "").includes("fingerprint_conflict")) {
    const fault = redisFaultMode;
    execute(command);
    redisFaultMode = "";
    if (fault === "incident_create_response_lost_bad_event") {
      const events = lists.get(command[6]) || [];
      if (events.length) events[0] = JSON.stringify({ ...parseJson(events[0]), id: "IE-WRONG-EVENT" });
    }
    return Response.json({ result: null });
  }
  if (partialPushStats && command[0] === "HLEN" && command[1] === "lm:push:subscriptions:v1") {
    return Response.json({ result: null });
  }
  return Response.json({ result: execute(command) });
};

const utils = await import("../app/api/_utils.js");
const incidents = await import("../app/api/_incidents.js");
const observability = await import("../app/api/_observability.js");
const jobsModule = await import("../app/api/_job-runner.js");
const healthModule = await import("../app/api/_health.js");
const durable = await import("../app/api/_durable-operation.js");
const metricsRoute = await import("../app/api/admin/health/metrics/route.js");
const jobsRoute = await import("../app/api/admin/health/jobs/route.js");
const queuesRoute = await import("../app/api/admin/health/queues/route.js");
const incidentsRoute = await import("../app/api/admin/health/incidents/route.js");
const incidentRoute = await import("../app/api/admin/health/incidents/[id]/route.js");
const traceRoute = await import("../app/api/admin/health/traces/[orderId]/route.js");
const healthRoute = await import("../app/api/admin/health/route.js");
const instrumentation = await import("../instrumentation.js");
const telemetryGroups = await import("../app/api/_telemetry-groups.js");

test.after(() => { globalThis.fetch = originalFetch; });

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffRoot: true,
  staffUsername: "root-admin",
  exp: Date.now() + 60 * 60 * 1000,
});

function adminRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("cookie", `lm_admin=${encodeURIComponent(adminToken)}`);
  return new Request(url, { ...options, headers });
}

function incidentPatch(id, key, body) {
  return incidentRoute.PATCH(adminRequest(`https://www.liumeiti.vip/api/admin/health/incidents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

test("metrics, jobs and incidents admin routes return real root-only data", async () => {
  const now = Date.now();
  const bucket = Math.floor(now / 300_000) * 300_000;
  const metricHash = hash(`lm:obs:api:5m:v1:${bucket}`);
  metricHash.set("auth_login:requests", "20");
  metricHash.set("auth_login:timed_requests", "20");
  metricHash.set("auth_login:status_2xx", "18");
  metricHash.set("auth_login:status_4xx", "1");
  metricHash.set("auth_login:status_5xx", "1");
  metricHash.set("auth_login:duration_sum_ms", "4000");
  metricHash.set("auth_login:latency_250", "18");
  metricHash.set("auth_login:latency_2500", "2");
  // A retried maintenance request is deliberately slow and failed. It stays
  // queryable under its own group but cannot manufacture a core API incident.
  metricHash.set("cron_maintenance:requests", "3");
  metricHash.set("cron_maintenance:timed_requests", "3");
  metricHash.set("cron_maintenance:status_5xx", "3");
  metricHash.set("cron_maintenance:duration_sum_ms", "102000");
  metricHash.set("cron_maintenance:latency_inf", "3");

  const metricResponse = await metricsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/metrics?range=1h"));
  assert.equal(metricResponse.status, 200);
  const metricPayload = await metricResponse.json();
  assert.equal(metricPayload.summary.requests, 20);
  assert.equal(metricPayload.summary.status5xx, 1);
  assert.equal(metricPayload.summary.p95Ms, 2500);
  assert.equal(metricPayload.group, "core");
  assert.equal(metricPayload.coverage.scope, "core_api");
  assert.equal(metricPayload.coverage.scopeLabel, "核心 API");
  assert.equal(metricPayload.coverage.aggregationPolicy, "interactive_allowlist");
  assert.equal(metricPayload.coverage.groupCount, telemetryGroups.CORE_API_GROUP_NAMES.length);
  assert.equal(metricPayload.coverage.routeCount, new Set(
    telemetryGroups.CORE_API_GROUP_DEFINITIONS.flatMap((group) => group.routes),
  ).size);
  assert.ok(metricPayload.coverage.groups.some((group) => group.name === "netflix_code"));
  assert.equal(metricPayload.coverage.groups.some((group) => group.name === "netflix_mail_ingest"), false);
  assert.equal(metricPayload.coverage.groups.some((group) => group.name === "cron_push"), false);
  assert.ok(metricPayload.coverage.groups.some((group) => group.name === "mail_preferences"));
  assert.ok(metricPayload.coverage.groups.some((group) => group.name === "admin_marketing_campaign"));
  assert.equal(metricPayload.coverage.groups.some((group) => group.name === "cron_marketing_campaign"), false);
  assert.ok(metricPayload.coverage.explicitExclusions.some((item) => item.routes.includes("/api/cron/maintenance")));
  assert.ok(metricPayload.coverage.explicitExclusions.some((item) => item.routes.includes("/api/auth/push/*")));
  assert.ok(metricPayload.coverage.explicitExclusions.some((item) => item.routes.includes("/api/email/unsubscribe")));

  const cronMetricResponse = await metricsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/metrics?range=1h&group=cron_maintenance"));
  assert.equal(cronMetricResponse.status, 200);
  const cronMetricPayload = await cronMetricResponse.json();
  assert.equal(cronMetricPayload.summary.requests, 3);
  assert.equal(cronMetricPayload.summary.status5xx, 3);
  assert.equal(cronMetricPayload.summary.p95Ms, 10000);

  const dependencyHash = hash(`lm:obs:dep:5m:v1:${bucket}`);
  dependencyHash.set("core:requests", "2");
  dependencyHash.set("core:timed_requests", "2");
  dependencyHash.set("core:status_2xx", "2");
  dependencyHash.set("core:latency_25", "2");
  dependencyHash.set("auth_login:requests", "99");
  const dependencyResponse = await metricsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/metrics?kind=dependency&range=1h&group=core"));
  assert.equal(dependencyResponse.status, 200);
  const dependencyPayload = await dependencyResponse.json();
  assert.equal(dependencyPayload.summary.requests, 2, "dependency groups must not expand through the API core allowlist");

  const heartbeat = new Date(now - 60_000).toISOString();
  execute(["HSET", jobsModule.jobRunnerInternals.JOB_LAST_KEY, "order_transition", JSON.stringify({
    job: "order_transition",
    label: "订单恢复",
    status: "success",
    heartbeatAt: heartbeat,
    finishedAt: heartbeat,
    processed: 4,
    failed: 0,
  })]);
  const jobsResponse = await jobsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/jobs"));
  assert.equal(jobsResponse.status, 200);
  const jobsPayload = await jobsResponse.json();
  assert.equal(jobsPayload.schedulerMode, "vercel_daily");
  assert.equal(jobsPayload.schedulerCadenceMs, 24 * 60 * 60_000);
  assert.equal(jobsPayload.schedulerMissedAfterMs, 30 * 60 * 60_000);
  const transition = jobsPayload.jobs.find((job) => job.job === "order_transition");
  assert.equal(transition.status, "success");
  assert.equal(transition.missed, false);
  assert.ok(transition.missedAfterMs > transition.cadenceMs);

  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:incident",
    component: "api",
    severity: "P2",
    title: "路由测试事故",
    errorCode: "route_test_failure",
  });
  assert.equal(created.ok, true);
  const listResponse = await incidentsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/incidents"));
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.incidents.some((item) => item.id === created.record.id), true);
  assert.equal(listPayload.owners.some((owner) => owner.id === 1), true);

  const unauthorized = await metricsRoute.GET(new Request("https://www.liumeiti.vip/api/admin/health/metrics"));
  assert.equal(unauthorized.status, 401);
});

test("incident lifecycle remains durable while health Telegram is disabled", async () => {
  const previous = process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
  const fingerprint = "route:test:health-telegram-disabled";
  const telegramBefore = telegramFetches;
  try {
    delete process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
    const opened = await incidents.reportOperationalFailure({
      fingerprint,
      component: "cron",
      severity: "P1",
      title: "maintenance health incident stays recorded",
      errorCode: "maintenance_probe_failed",
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.created, true);
    assert.equal(opened.alertOk, true);
    assert.deepEqual(opened.alert, {
      ok: true,
      skipped: true,
      reason: "incident_telegram_disabled",
    });
    assert.equal((await incidents.getIncident(opened.record.id)).status, "open");

    const first = await incidents.reportOperationalRecovery({ fingerprint });
    const second = await incidents.reportOperationalRecovery({ fingerprint });
    const third = await incidents.reportOperationalRecovery({ fingerprint });
    assert.deepEqual(
      [first.pending, second.pending, third.record?.status],
      [true, true, "recovered"],
    );
    assert.equal(third.ok, true);
    assert.equal(third.alertOk, true);
    assert.equal(third.alert?.reason, "incident_telegram_disabled");
    assert.equal((await incidents.getIncident(opened.record.id)).status, "recovered");

    const response = await incidentsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/incidents?status=recovered"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.incidents.some((incident) => incident.id === opened.record.id), true);
    assert.equal(telegramFetches, telegramBefore);
  } finally {
    if (previous == null) delete process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
    else process.env.OPS_INCIDENT_TELEGRAM_ENABLED = previous;
  }
});

test("health overview derives Push state from PUSH_ENABLED and complete server configuration", async () => {
  const names = [
    "PUSH_ENABLED",
    "WEB_PUSH_VAPID_PUBLIC_KEY",
    "WEB_PUSH_VAPID_PRIVATE_KEY",
    "PUSH_SUBSCRIPTION_ENCRYPTION_KEY",
    "PUSH_ACCOUNT_HMAC_SECRET",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const request = () => healthRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health"));
  const readPush = async () => {
    const response = await request();
    assert.equal(response.status, 200);
    return (await response.json()).components.find((component) => component.component === "push");
  };
  try {
    strings.delete("lm:health:push");
    process.env.PUSH_ENABLED = "false";
    let component = await readPush();
    assert.equal(component.status, "disabled");
    assert.equal(component.metrics.ok, undefined, "transport status is not exposed as a health metric");

    process.env.PUSH_ENABLED = "true";
    names.slice(1).forEach((name) => { delete process.env[name]; });
    component = await readPush();
    assert.equal(component.status, "error");
    assert.equal(component.error, "push_not_configured");

    const vapidKeys = webpush.generateVAPIDKeys();
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = vapidKeys.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = vapidKeys.privateKey;
    process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = "health-push-encryption-secret-at-least-32-characters";
    process.env.PUSH_ACCOUNT_HMAC_SECRET = "health-push-account-secret-at-least-32-characters";
    partialPushStats = true;
    component = await readPush();
    assert.equal(component.status, "error");
    assert.equal(component.error, "push_queue_stats_unavailable");

    partialPushStats = false;
    component = await readPush();
    assert.equal(component.status, "warning");
    assert.deepEqual(component.metrics, {
      subscriptions: 0,
      queued: 0,
      events: 0,
      enqueueRecovery: 0,
      providerAlerts: 0,
    });
  } finally {
    partialPushStats = false;
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("health overview degrades corrupt component and job records without hiding healthy rows", async () => {
  const settingsKey = "lm:settings";
  const hadSettings = strings.has(settingsKey);
  const previousSettings = strings.get(settingsKey);
  const apiHealthKey = "lm:health:api";
  const hadApiHealth = strings.has(apiHealthKey);
  const previousApiHealth = strings.get(apiHealthKey);
  const jobs = hash(jobsModule.jobRunnerInternals.JOB_LAST_KEY);
  const previousJob = jobs.get("order_transition");
  try {
    strings.set(settingsKey, "{not-json");
    let response = await healthRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "settings_store_corrupt");

    if (hadSettings) strings.set(settingsKey, previousSettings);
    else strings.delete(settingsKey);
    strings.set(apiHealthKey, JSON.stringify({}));
    response = await healthRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health"));
    assert.equal(response.status, 200);
    const healthPayload = await response.json();
    const apiComponent = healthPayload.components.find((component) => component.component === "api");
    assert.equal(apiComponent.status, "warning");
    assert.equal(apiComponent.error, "health_status_record_corrupt");
    assert.deepEqual(healthPayload.statusDiagnostics, [{
      component: "api",
      code: "health_status_record_corrupt",
      corruptRecords: 1,
    }]);

    if (hadApiHealth) strings.set(apiHealthKey, previousApiHealth);
    else strings.delete(apiHealthKey);
    jobs.set("order_transition", JSON.stringify({}));
    response = await jobsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/jobs"));
    assert.equal(response.status, 200);
    const jobsPayload = await response.json();
    const corruptJob = jobsPayload.jobs.find((job) => job.job === "order_transition");
    const healthyJob = jobsPayload.jobs.find((job) => job.job === "quote_expiry");
    assert.equal(corruptJob.status, "failed");
    assert.equal(corruptJob.errorCode, "job_status_record_corrupt");
    assert.equal(healthyJob.status, "never");
  } finally {
    if (hadSettings) strings.set(settingsKey, previousSettings);
    else strings.delete(settingsKey);
    if (hadApiHealth) strings.set(apiHealthKey, previousApiHealth);
    else strings.delete(apiHealthKey);
    if (previousJob == null) jobs.delete("order_transition");
    else jobs.set("order_transition", previousJob);
  }
});

test("health overview skips isolated corrupt history records and reports the degradation", async () => {
  const key = "lm:health:history:v1:api";
  const previous = lists.has(key) ? [...lists.get(key)] : null;
  const valid = {
    component: "api",
    status: "ok",
    summary: "valid historical sample",
    metrics: { requests: 12 },
    checkedAt: "2026-08-04T01:00:00.000Z",
  };
  try {
    lists.set(key, [
      "",
      "{not-json",
      JSON.stringify(valid),
      JSON.stringify({ ...valid, component: "redis" }),
    ]);
    const response = await healthRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.history.api, [valid]);
    assert.deepEqual(payload.historyDiagnostics, [{
      component: "api",
      code: "health_history_record_corrupt",
      corruptRecords: 3,
    }]);
    const direct = await healthModule.readHealthHistory("api", 12);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].summary.endsWith(valid.summary), true);
    const one = await healthModule.readHealthHistory("api", 1);
    assert.equal(one.length, 1);
    assert.equal(one[0].summary.endsWith(valid.summary), true);
    const allHistory = await healthModule.readAllHealthHistory(12);
    assert.deepEqual(allHistory.api, [valid]);
  } finally {
    if (previous) lists.set(key, previous);
    else lists.delete(key);
  }
});

test("health history storage outages still fail closed", async () => {
  redisFaultMode = "health_history_outage";
  try {
    const response = await healthRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "health_history_store_unavailable");
  } finally {
    redisFaultMode = "";
  }
});

test("incident PATCH is permanently idempotent and exposes investigating events", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:idempotency",
    component: "cron",
    severity: "P1",
    title: "幂等事故",
  });
  const id = created.record.id;
  const acknowledgeBody = { action: "acknowledge", expectedVersion: created.record.version };
  const first = await incidentPatch(id, "incident-ack-0001", acknowledgeBody);
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.equal(firstPayload.incident.status, "acknowledged");

  const replay = await incidentPatch(id, "incident-ack-0001", acknowledgeBody);
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json();
  assert.equal(replayPayload.idempotent, true);
  assert.equal(replayPayload.incident.version, firstPayload.incident.version);

  const conflict = await incidentPatch(id, "incident-ack-0001", {
    action: "investigate",
    expectedVersion: firstPayload.incident.version,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");

  const investigating = await incidentPatch(id, "incident-investigate-0001", {
    action: "investigate",
    expectedVersion: firstPayload.incident.version,
  });
  assert.equal(investigating.status, 200);
  const investigatingPayload = await investigating.json();
  assert.equal(investigatingPayload.incident.status, "investigating");

  const detail = await incidentRoute.GET(adminRequest(`https://www.liumeiti.vip/api/admin/health/incidents/${id}`), { params: Promise.resolve({ id }) });
  const detailPayload = await detail.json();
  assert.equal(detailPayload.events.some((event) => event.type === "investigate"), true);
  assert.equal(detailPayload.events.some((event) => event.detail?.operationId), true);
});

test("incident creation recovers only after a lost response proves every committed artifact", async () => {
  redisFaultMode = "incident_create_response_lost";
  try {
    const created = await incidents.openOrUpdateIncident({
      fingerprint: "route:test:create-response-lost",
      component: "redis",
      title: "create response lost",
    });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.recovered, true);
    assert.equal((await incidents.getIncident(created.record.id)).id, created.record.id);
    const events = await incidents.incidentEvents(created.record.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "opened");
  } finally {
    redisFaultMode = "";
  }
});

test("incident creation does not recover a partial or mismatched response-loss commit", async () => {
  redisFaultMode = "incident_create_response_lost_bad_event";
  try {
    const result = await incidents.openOrUpdateIncident({
      fingerprint: "route:test:create-response-lost-bad-event",
      component: "redis",
      title: "create response lost bad event",
    });
    assert.deepEqual(result, { ok: false, error: "storage_unavailable" });
  } finally {
    redisFaultMode = "";
  }
});

test("a failed second durable claim releases the original operation lock", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:second-claim",
    component: "queue",
    title: "二次 claim 失败",
  });
  const id = created.record.id;
  const key = "incident-second-claim-0001";
  const coordinates = durable.durableOperationInternals.operationCoordinates("admin-health-incident-transition", id, key);
  failDurableClaimAt = durableClaimCalls + 2;
  const failed = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
  assert.equal(failed.status, 503);
  assert.equal(strings.has(coordinates.lockKey), false);
  failDurableClaimAt = 0;

  const recovered = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).incident.status, "acknowledged");
});

test("incident storage outages stay 503 while corrupt derived records degrade without locking the panel", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:strict-incident-reads",
    component: "redis",
    title: "严格事故读取",
  });
  const id = created.record.id;
  const key = `lm:incident:record:v1:${id}`;
  const raw = strings.get(key);
  try {
    redisFaultMode = "incident_record_outage";
    let response = await incidentRoute.GET(
      adminRequest(`https://www.liumeiti.vip/api/admin/health/incidents/${id}`),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 503);
    assert.notEqual((await response.json()).error, "incident_not_found");

    redisFaultMode = "incident_list_outage";
    response = await incidentsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/incidents"));
    assert.equal(response.status, 503);
    assert.notDeepEqual((await response.json()).incidents, []);

    redisFaultMode = "";
    strings.set(key, JSON.stringify({}));
    response = await incidentRoute.GET(
      adminRequest(`https://www.liumeiti.vip/api/admin/health/incidents/${id}`),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "incident_not_found");

    response = await incidentsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/incidents"));
    assert.equal(response.status, 200);
    const list = await response.json();
    assert.equal(list.ok, true);
    assert.equal(list.diagnostics.corruptCount >= 1, true);

    strings.set(key, "");
    response = await incidentsRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/incidents"));
    assert.equal(response.status, 200);
    const emptyList = await response.json();
    assert.equal(emptyList.ok, true);
    assert.equal(emptyList.diagnostics.corruptCount >= 1, true);
    assert.equal(emptyList.incidents.some((incident) => incident == null), false);
  } finally {
    redisFaultMode = "";
    strings.set(key, raw);
  }
});

test("incident event history skips corrupt rows but keeps healthy events", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:corrupt-event-degrade",
    component: "scheduler",
    title: "corrupt event degradation",
  });
  const id = created.record.id;
  const key = `lm:incident:events:v1:${id}`;
  const healthy = [...(lists.get(key) || [])];
  lists.set(key, ["{broken", ...healthy]);
  try {
    const response = await incidentRoute.GET(
      adminRequest(`https://www.liumeiti.vip/api/admin/health/incidents/${id}`),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.events.length, healthy.length);
    assert.equal(body.events.every((event) => event.id && event.type), true);
    const one = await incidents.incidentEvents(id, 1);
    assert.equal(one.length, 1);
    assert.equal(Boolean(one[0].id && one[0].type), true);
  } finally {
    lists.set(key, healthy);
  }
});

test("a corrupt fingerprint target is released so monitoring can create a healthy replacement", async () => {
  const fingerprint = "route:test:corrupt-fingerprint-target";
  const created = await incidents.openOrUpdateIncident({ fingerprint, component: "redis", title: "first lifecycle" });
  const oldKey = `lm:incident:record:v1:${created.record.id}`;
  const oldRaw = strings.get(oldKey);
  strings.set(oldKey, "{broken");
  try {
    const replacement = await incidents.openOrUpdateIncident({ fingerprint, component: "redis", title: "replacement lifecycle" });
    assert.equal(replacement.ok, true);
    assert.equal(replacement.created, true);
    assert.notEqual(replacement.record.id, created.record.id);
    assert.equal((await incidents.getIncident(replacement.record.id)).id, replacement.record.id);
  } finally {
    strings.set(oldKey, oldRaw);
  }
});

test("incident lock storage outage is 503 and the same durable request can recover", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:lock-store-outage",
    component: "redis",
    title: "事故锁故障",
  });
  const id = created.record.id;
  const key = "incident-lock-outage-0001";
  try {
    redisFaultMode = "incident_lock_outage";
    const failed = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, "incident_lock_store_unavailable");
  } finally {
    redisFaultMode = "";
  }
  const recovered = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).incident.status, "acknowledged");
});

test("incident transition continues only when a lost lock response can prove this request owns it", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:lock-acquire-response-lost",
    component: "redis",
    title: "事故锁响应丢失",
  });
  try {
    redisFaultMode = "incident_lock_acquire_response_lost";
    const response = await incidentPatch(created.record.id, "incident-lock-acquire-lost-0001", {
      action: "acknowledge",
      expectedVersion: created.record.version,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).incident.status, "acknowledged");
  } finally {
    redisFaultMode = "";
  }
});

test("incident lock release failure is surfaced while a durable replay returns the committed result", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:lock-release-outage",
    component: "redis",
    title: "事故锁释放故障",
  });
  const id = created.record.id;
  const key = "incident-lock-release-0001";
  try {
    redisFaultMode = "incident_lock_release_response_lost";
    const uncertain = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
    assert.equal(uncertain.status, 503);
    assert.equal((await uncertain.json()).error, "incident_lock_release_failed");
  } finally {
    redisFaultMode = "";
  }
  const replay = await incidentPatch(id, key, { action: "acknowledge", expectedVersion: created.record.version });
  assert.equal(replay.status, 200);
  const payload = await replay.json();
  assert.equal(payload.idempotent, true);
  assert.equal(payload.incident.status, "acknowledged");
});

test("incident assignment fails closed when the staff store is corrupt and remains retryable", async () => {
  const created = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:staff-store-corrupt",
    component: "admin",
    title: "负责人存储损坏",
  });
  const staffKey = "liumeiti:admin:staff";
  const hadStaff = strings.has(staffKey);
  const previousStaff = strings.get(staffKey);
  const idempotencyKey = "incident-staff-corrupt-0001";
  try {
    strings.set(staffKey, "{not-json");
    const failed = await incidentPatch(created.record.id, idempotencyKey, {
      action: "assign",
      expectedVersion: created.record.version,
      ownerStaffId: 1,
    });
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error, /storage/);
  } finally {
    if (hadStaff) strings.set(staffKey, previousStaff);
    else strings.delete(staffKey);
  }
  const recovered = await incidentPatch(created.record.id, idempotencyKey, {
    action: "assign",
    expectedVersion: created.record.version,
    ownerStaffId: 1,
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).incident.ownerStaffId, 1);
});

test("resolved fingerprints create a new incident and old reopen cannot steal its mapping", async () => {
  const fingerprint = "route:test:fingerprint-reuse";
  const created = await incidents.openOrUpdateIncident({ fingerprint, component: "api", title: "旧事故" });
  const resolved = await incidentPatch(created.record.id, "incident-resolve-0001", {
    action: "resolve",
    expectedVersion: created.record.version,
    resolution: "已修复并验证",
  });
  assert.equal(resolved.status, 200);

  const replacement = await incidents.openOrUpdateIncident({ fingerprint, component: "api", title: "新事故" });
  assert.equal(replacement.ok, true);
  assert.notEqual(replacement.record.id, created.record.id);

  const reopen = await incidents.transitionIncident(created.record.id, {
    action: "reopen",
    expectedVersion: (await incidents.getIncident(created.record.id)).version,
  }, { staffId: 1, staffUsername: "root-admin" });
  assert.equal(reopen.ok, false);
  assert.equal(reopen.error, "fingerprint_conflict");
  assert.equal((await incidents.getIncident(created.record.id)).status, "resolved");
});

test("runObservedJob persists every malformed handler result as failed and only an explicit disabled result as disabled", async () => {
  const malformed = [undefined, {}, [], null, { ok: "false" }];
  for (let index = 0; index < malformed.length; index += 1) {
    const job = `adversarial_result_${index}`;
    const result = await jobsModule.runObservedJob(job, { trigger: "adversarial-test" }, async () => malformed[index]);
    assert.equal(result.ok, false, `shape ${index} must fail`);
    assert.equal(result.error, "invalid_job_result", `shape ${index} must use the stable error code`);
    assert.equal(result.run.status, "failed", `shape ${index} must return a failed run`);
    const persisted = JSON.parse(hash(jobsModule.jobRunnerInternals.JOB_LAST_KEY).get(job) || "null");
    assert.equal(persisted?.status, "failed", `shape ${index} must persist failed`);
    assert.equal(persisted?.errorCode, "invalid_job_result");
  }

  const disabled = await jobsModule.runObservedJob(
    "adversarial_disabled",
    { trigger: "adversarial-test" },
    async () => ({ ok: true, disabled: true }),
  );
  assert.equal(disabled.ok, true);
  assert.equal(disabled.run.status, "disabled");
  assert.equal(
    JSON.parse(hash(jobsModule.jobRunnerInternals.JOB_LAST_KEY).get("adversarial_disabled") || "null")?.status,
    "disabled",
  );
});

test("an incident key or index entry cannot transition a record whose body belongs to another incident", async () => {
  const first = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:identity-first",
    component: "redis",
    title: "identity first",
  });
  const second = await incidents.openOrUpdateIncident({
    fingerprint: "route:test:identity-second",
    component: "redis",
    title: "identity second",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const firstKey = `lm:incident:record:v1:${first.record.id}`;
  const secondKey = `lm:incident:record:v1:${second.record.id}`;
  const firstRaw = strings.get(firstKey);
  const secondRaw = strings.get(secondKey);
  strings.set(firstKey, secondRaw);
  try {
    const result = await incidents.transitionIncident(first.record.id, {
      action: "acknowledge",
      expectedVersion: second.record.version,
    }, { staffId: 1, staffUsername: "root-admin" });
    assert.equal(result.ok, false);
    assert.equal(strings.get(firstKey), secondRaw, "the corrupt keyed value must not be rewritten");
    assert.equal(strings.get(secondKey), secondRaw, "the real second incident must remain byte-identical");

    const listed = await incidents.listIncidents({ limit: 100 });
    assert.equal(listed.incidents.some((record) => record.id === first.record.id), false);
    assert.equal(listed.incidents.filter((record) => record.id === second.record.id).length, 1);
    assert.equal(strings.get(secondKey), secondRaw);
  } finally {
    strings.set(firstKey, firstRaw);
  }
});

test("partial queue sampling fails closed without overwriting the last snapshot", async () => {
  execute(["HSET", "lm:ops:queue:last:v1", "order_transitions", JSON.stringify({
    name: "order_transitions",
    count: 7,
    status: "warning",
    checkedAt: "2026-01-01T00:00:00.000Z",
  })]);
  const writesBefore = queueSnapshotWrites;
  partialQueueSample = true;
  await assert.rejects(
    observability.sampleOperationalQueues(),
    (error) => error?.code === "operational_queue_sample_unavailable",
  );
  partialQueueSample = false;
  assert.equal(queueSnapshotWrites, writesBefore);
  const latest = await observability.readLatestQueueSnapshots();
  assert.equal(latest.find((item) => item.name === "order_transitions").count, 7);
});

test("queue refresh isolates a historical finite score outside the JavaScript Date range", async () => {
  const key = "liumeiti:orders:quote-expiry";
  const latestKey = "lm:ops:queue:last:v1";
  const historyKey = "lm:ops:queue:history:v1:quote_expiry";
  const previousQueue = sortedSets.has(key) ? new Map(sortedSets.get(key)) : null;
  const previousLatest = hashes.has(latestKey) ? new Map(hashes.get(latestKey)) : null;
  const previousHistory = lists.has(historyKey) ? [...lists.get(historyKey)] : null;
  const previousEnvironment = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "production";
    sortedSets.set(key, new Map([["legacy-nanosecond-score", Number.MAX_SAFE_INTEGER]]));
    const response = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues?refresh=1"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.queues.length, observability.OPERATIONAL_QUEUE_DEFINITIONS.length);
    const queue = body.queues.find((item) => item.name === "quote_expiry");
    assert.equal(queue.count, 1);
    assert.equal(queue.dueCount, 0);
    assert.equal(queue.oldestAt, "");
    assert.equal(queue.status, "warning");
    assert.equal(queue.error, "operational_queue_score_invalid");
    assert.equal(parseJson(lists.get(historyKey)?.[0])?.error, "operational_queue_score_invalid");

    const storedResponse = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues"));
    assert.equal(storedResponse.status, 200);
    const stored = (await storedResponse.json()).queues.find((item) => item.name === "quote_expiry");
    assert.equal(stored.count, 1);
    assert.equal(stored.error, "operational_queue_score_invalid");
  } finally {
    if (previousQueue) sortedSets.set(key, previousQueue); else sortedSets.delete(key);
    if (previousLatest) hashes.set(latestKey, previousLatest); else hashes.delete(latestKey);
    if (previousHistory) lists.set(historyKey, previousHistory); else lists.delete(historyKey);
    if (previousEnvironment == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});

test("queue route keeps Redis outages strict but isolates corrupt snapshots", async () => {
  const queueState = hash("lm:ops:queue:last:v1");
  const previousOrderTransitions = queueState.get("order_transitions");
  const previousQuoteExpiry = queueState.get("quote_expiry");
  try {
    redisFaultMode = "queue_read_outage";
    let response = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "operational_queue_snapshot_unavailable");

    redisFaultMode = "";
    queueState.set("quote_expiry", JSON.stringify({
      name: "quote_expiry",
      count: 4,
      dueCount: 2,
      status: "warning",
      checkedAt: "2026-08-09T03:00:00.000Z",
    }));
    queueState.set("order_transitions", "{not-json");
    response = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues"));
    assert.equal(response.status, 200);
    let payload = await response.json();
    let corrupt = payload.queues.find((queue) => queue.name === "order_transitions");
    let healthy = payload.queues.find((queue) => queue.name === "quote_expiry");
    assert.equal(corrupt.status, "error");
    assert.equal(corrupt.error, "operational_queue_snapshot_corrupt");
    assert.equal(healthy.count, 4);
    assert.equal(healthy.status, "warning");

    queueState.set("order_transitions", JSON.stringify({}));
    response = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues"));
    assert.equal(response.status, 200);
    payload = await response.json();
    corrupt = payload.queues.find((queue) => queue.name === "order_transitions");
    healthy = payload.queues.find((queue) => queue.name === "quote_expiry");
    assert.equal(corrupt.error, "operational_queue_snapshot_corrupt");
    assert.equal(healthy.count, 4);

    for (const malformed of [
      { name: "order_transitions", count: null, dueCount: 0, status: "ok", checkedAt: "2026-08-09T03:00:00.000Z" },
      { name: "order_transitions", count: "", dueCount: 0, status: "ok", checkedAt: "2026-08-09T03:00:00.000Z" },
      { name: "order_transitions", count: [], dueCount: 0, status: "ok", checkedAt: "2026-08-09T03:00:00.000Z" },
      { name: "order_transitions", count: 2, dueCount: 3, status: "warning", checkedAt: "2026-08-09T03:00:00.000Z" },
      { name: "order_transitions", count: 2, dueCount: 1, status: "ok", checkedAt: "without-timezone" },
    ]) {
      queueState.set("order_transitions", JSON.stringify(malformed));
      response = await queuesRoute.GET(adminRequest("https://www.liumeiti.vip/api/admin/health/queues"));
      assert.equal(response.status, 200);
      payload = await response.json();
      corrupt = payload.queues.find((queue) => queue.name === "order_transitions");
      assert.equal(corrupt.error, "operational_queue_snapshot_corrupt");
    }
  } finally {
    redisFaultMode = "";
    if (previousOrderTransitions == null) queueState.delete("order_transitions");
    else queueState.set("order_transitions", previousOrderTransitions);
    if (previousQuoteExpiry == null) queueState.delete("quote_expiry");
    else queueState.set("quote_expiry", previousQuoteExpiry);
  }
});

test("job history skips malformed and missing runs while preserving healthy runs", async () => {
  const job = "order_transition";
  const validRunId = "order_transition-valid-run";
  const malformedRunId = "order_transition-malformed-run";
  const missingRunId = "order_transition-missing-run";
  const invalidRunId = " ";
  const jobIndexKey = jobsModule.jobRunnerInternals.JOB_RUN_INDEX_PREFIX + job;
  const allIndexKey = jobsModule.jobRunnerInternals.JOB_ALL_RUN_INDEX_KEY;
  const runPrefix = jobsModule.jobRunnerInternals.JOB_RUN_PREFIX;
  const previousJobIndex = sortedSets.has(jobIndexKey) ? new Map(sortedSets.get(jobIndexKey)) : null;
  const previousAllIndex = sortedSets.has(allIndexKey) ? new Map(sortedSets.get(allIndexKey)) : null;
  const previousValid = strings.get(runPrefix + validRunId);
  const previousMalformed = strings.get(runPrefix + malformedRunId);
  const previousPrefixRecord = strings.get(runPrefix);
  const validRun = {
    runId: validRunId,
    job,
    status: "success",
    startedAt: "2026-08-09T04:00:00.000Z",
    finishedAt: "2026-08-09T04:00:01.000Z",
  };
  try {
    sortedSets.set(jobIndexKey, new Map([
      [invalidRunId, 400],
      [validRunId, 300],
      [malformedRunId, 200],
      [missingRunId, 100],
    ]));
    sortedSets.set(allIndexKey, new Map([
      [invalidRunId, 400],
      [validRunId, 300],
      [malformedRunId, 200],
      [missingRunId, 100],
    ]));
    strings.set(runPrefix + validRunId, JSON.stringify(validRun));
    strings.set(runPrefix + malformedRunId, JSON.stringify({
      runId: malformedRunId,
      job,
      status: 7,
    }));
    strings.delete(runPrefix + missingRunId);
    strings.set(runPrefix, JSON.stringify({
      runId: "order_transition-wrongly-associated", job, status: "success",
    }));

    const response = await jobsRoute.GET(adminRequest(
      `https://www.liumeiti.vip/api/admin/health/jobs?job=${job}&limit=10&recentLimit=10`,
    ));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.runs.map((run) => run.runId), [validRunId]);
    assert.deepEqual(payload.recentRuns.map((run) => run.runId), [validRunId]);

    redisFaultMode = "job_history_outage";
    const unavailable = await jobsRoute.GET(adminRequest(
      `https://www.liumeiti.vip/api/admin/health/jobs?job=${job}&limit=10&recentLimit=10`,
    ));
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, "job_history_unavailable");
  } finally {
    redisFaultMode = "";
    if (previousJobIndex) sortedSets.set(jobIndexKey, previousJobIndex);
    else sortedSets.delete(jobIndexKey);
    if (previousAllIndex) sortedSets.set(allIndexKey, previousAllIndex);
    else sortedSets.delete(allIndexKey);
    if (previousValid == null) strings.delete(runPrefix + validRunId);
    else strings.set(runPrefix + validRunId, previousValid);
    if (previousMalformed == null) strings.delete(runPrefix + malformedRunId);
    else strings.set(runPrefix + malformedRunId, previousMalformed);
    if (previousPrefixRecord == null) strings.delete(runPrefix);
    else strings.set(runPrefix, previousPrefixRecord);
    strings.delete(runPrefix + missingRunId);
  }
});

test("job freshness applies the supplied cadence and missed threshold", () => {
  const now = Date.now();
  const policy = { cadenceMs: 60 * 60_000, expectedIntervalMs: 60 * 60_000, missedAfterMs: 150 * 60_000 };
  assert.equal(jobsModule.jobFreshness({ heartbeatAt: new Date(now - 90 * 60_000).toISOString() }, policy, now).missed, false);
  assert.equal(jobsModule.jobFreshness({ heartbeatAt: new Date(now - 151 * 60_000).toISOString() }, policy, now).missed, true);
});

test("missed-job notification deadline aborts before creating an incident or calling Telegram", async () => {
  const incidentsBefore = sortedSet("lm:incident:index:v1").size;
  const telegramBefore = telegramFetches;
  await assert.rejects(
    jobsModule.detectMissedJobs({
      notify: true,
      deadlineAt: Date.now() + 1_000,
      minimumActionMs: 11_000,
    }),
    (error) => error?.code === "monitoring_deadline_exceeded",
  );
  assert.equal(sortedSet("lm:incident:index:v1").size, incidentsBefore);
  assert.equal(telegramFetches, telegramBefore);
});

test("maintenance cron and keeper retain explicit response/monitoring tail budgets", () => {
  const maintenance = readFileSync(fileURLToPath(new URL("../app/api/cron/maintenance/route.js", import.meta.url)), "utf8");
  const keeper = readFileSync(fileURLToPath(new URL("../app/api/_keeper.js", import.meta.url)), "utf8");
  assert.match(maintenance, /monitoringDeadlineAt\s*=\s*requestStartedAt\s*\+\s*51_000/);
  assert.match(maintenance, /runMaintenanceTick\(\{\s*trigger:\s*["']cron["'],\s*deadlineMs:\s*34_000\s*\}\)/);
  assert.match(maintenance, /detectMissedJobs\([^)]*deadlineAt:\s*monitoringDeadlineAt/);
  assert.match(maintenance, /requireMonitoringBudget\(deadlineAt\)/);
  assert.match(maintenance, /readMetricSeries\(\{\s*kind:\s*["']api["'],\s*group:\s*CORE_API_AGGREGATE_GROUP/);
  assert.match(keeper, /deadlineAt\s*=\s*started\s*\+\s*Math\.max\(1_000,\s*safeDeadlineMs\s*-\s*2_000\)/);
});

test("trace route resolves either an order id or its strict business Trace mapping", async () => {
  const orderId = "LMTRACELOOKUP2026";
  const businessTraceId = observability.businessTraceIdForOrder(orderId);
  strings.set(`liumeiti:orders:record:${orderId}`, JSON.stringify({
    orderId,
    status: "processing",
    businessTraceId,
    requestTraceId: "a".repeat(32),
  }));
  await observability.appendBusinessTraceEvent(orderId, {
    businessTraceId,
    traceId: "b".repeat(32),
    spanId: "c".repeat(16),
    stage: "payment_confirmed",
    component: "order",
    outcome: "ok",
  });

  const byTrace = await traceRoute.GET(
    adminRequest(`https://www.liumeiti.vip/api/admin/health/traces/${businessTraceId}`),
    { params: Promise.resolve({ orderId: businessTraceId }) },
  );
  assert.equal(byTrace.status, 200);
  const payload = await byTrace.json();
  assert.equal(payload.orderId, orderId);
  assert.equal(payload.businessTraceId, businessTraceId);
  assert.equal(payload.requestTraceId, "a".repeat(32));
  assert.equal(payload.events[0].stage, "payment_confirmed");

  const missing = await traceRoute.GET(
    adminRequest(`https://www.liumeiti.vip/api/admin/health/traces/ord_${"f".repeat(32)}`),
    { params: Promise.resolve({ orderId: `ord_${"f".repeat(32)}` }) },
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "trace_not_found");
});

test("trace route keeps canonical order corruption fail-closed but skips corrupt derived trace events", async () => {
  const orderId = "LMTRACEFAILCLOSED2026";
  const orderKey = `liumeiti:orders:record:${orderId}`;
  const traceKey = `lm:trace:order:v1:${orderId}`;
  const orderRaw = JSON.stringify({ orderId, status: "processing" });
  strings.set(orderKey, orderRaw);
  lists.set(traceKey, [JSON.stringify({ stage: "created", outcome: "ok" })]);
  const request = () => traceRoute.GET(
    adminRequest(`https://www.liumeiti.vip/api/admin/health/traces/${orderId}`),
    { params: Promise.resolve({ orderId }) },
  );
  try {
    redisFaultMode = "trace_order_outage";
    let response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "order_store_unavailable");

    redisFaultMode = "trace_store_outage";
    response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "trace_store_unavailable");

    redisFaultMode = "";
    strings.set(orderKey, "{not-json");
    response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "order_store_corrupt");

    strings.set(orderKey, orderRaw);
    lists.set(traceKey, [JSON.stringify({})]);
    response = await request();
    assert.equal(response.status, 200);
    const degraded = await response.json();
    assert.deepEqual(degraded.events, []);
    assert.equal(degraded.corruptCount, 1);

    lists.set(traceKey, ["{not-json", JSON.stringify({}), JSON.stringify({ stage: "paid", outcome: "ok" })]);
    const paged = await observability.readBusinessTrace(orderId, 1);
    assert.deepEqual(paged.events.map((event) => event.stage), ["paid"]);
    assert.equal(paged.corruptCount, 2);
  } finally {
    redisFaultMode = "";
    strings.set(orderKey, orderRaw);
    lists.set(traceKey, []);
  }
});

test("durable started index is atomic on claim/complete and repeatably backfillable", async () => {
  const operation = await durable.claimDurableOperation({
    scope: "health-test",
    principal: "order-1",
    idempotencyKey: "durable-index-0001",
    requestHash: "d".repeat(64),
  });
  assert.equal(operation.ok, true);
  assert.equal(sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).has(operation.operationId), true);
  assert.equal((await durable.completeDurableOperation(operation, { ok: true })).ok, true);
  assert.equal(sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).has(operation.operationId), false);

  const legacyId = "e".repeat(64);
  strings.set(`liumeiti:durable-operation:v1:${legacyId}`, JSON.stringify({
    state: "started",
    operationId: legacyId,
    requestHash: "f".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  strings.delete(durable.durableOperationInternals.OPERATION_BACKFILL_CURSOR);
  const backfill = await durable.backfillDurableOperationStartedIndex();
  assert.equal(backfill.ok, true);
  assert.equal(sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).has(legacyId), true);
  assert.equal((await durable.backfillDurableOperationStartedIndex()).done, true);
});

test("durable backfill keeps its cursor retryable when record reads fail", async () => {
  const legacyId = "9".repeat(64);
  const recordKey = `liumeiti:durable-operation:v1:${legacyId}`;
  strings.set(recordKey, JSON.stringify({
    state: "started",
    operationId: legacyId,
    requestHash: "8".repeat(64),
    createdAt: "2026-01-05T00:00:00.000Z",
  }));
  strings.delete(durable.durableOperationInternals.OPERATION_BACKFILL_CURSOR);
  sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).delete(legacyId);
  redisFaultMode = "durable_backfill_read_outage";
  try {
    const failed = await durable.backfillDurableOperationStartedIndex();
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "durable_backfill_read_failed");
    assert.equal(strings.has(durable.durableOperationInternals.OPERATION_BACKFILL_CURSOR), false);
    assert.equal(sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).has(legacyId), false);
  } finally {
    redisFaultMode = "";
  }

  const recovered = await durable.backfillDurableOperationStartedIndex();
  assert.equal(recovered.ok, true);
  assert.equal(sortedSet(durable.durableOperationInternals.OPERATION_STARTED_INDEX).has(legacyId), true);
});

test("unhandled instrumentation counts failures without inventing zero-latency samples", async () => {
  const now = Date.now();
  const key = `lm:obs:api:5m:v1:${Math.floor(now / 300_000) * 300_000}`;
  const group = "auth_logout";
  const beforeRequests = Number(hash(key).get(`${group}:requests`) || 0);
  const beforeStatus5xx = Number(hash(key).get(`${group}:status_5xx`) || 0);
  const beforeAll = Number(hash(key).get("all:requests") || 0);
  await instrumentation.instrumentationInternals.recordUnhandledApiException(group);
  const metrics = hash(key);
  assert.equal(Number(metrics.get(`${group}:requests`) || 0), beforeRequests + 1);
  assert.equal(Number(metrics.get(`${group}:status_5xx`) || 0), beforeStatus5xx + 1);
  assert.equal(Number(metrics.get("all:requests") || 0), beforeAll + 1);
  assert.equal(metrics.has(`${group}:latency_25`), false);
  assert.equal(metrics.has(`${group}:duration_sum_ms`), false);
});

test("unmonitored route errors never pollute the core all-series denominator", async () => {
  const now = Date.now();
  const key = `lm:obs:api:5m:v1:${Math.floor(now / 300_000) * 300_000}`;
  const beforeAll = Number(hash(key).get("all:requests") || 0);
  const beforeUnmonitored = Number(hash(key).get("unmonitored:requests") || 0);
  assert.equal(instrumentation.instrumentationInternals.apiRouteGroup("/api/after-sales"), "after_sales");
  assert.equal(instrumentation.instrumentationInternals.apiRouteGroup("/api/quote-orders"), "quote_order_create");
  await instrumentation.instrumentationInternals.recordUnhandledApiException("not_wrapped");
  assert.equal(Number(hash(key).get("all:requests") || 0), beforeAll);
  assert.equal(Number(hash(key).get("unmonitored:requests") || 0), beforeUnmonitored + 1);
});

test("normal and thrown telemetry share one monitored group contract", () => {
  assert.deepEqual(
    [...observability.MONITORED_API_GROUPS].sort(),
    [...instrumentation.instrumentationInternals.MONITORED_API_ROUTE_GROUPS].sort(),
  );
});

test("every normal response in a monitored route group is telemetry wrapped", () => {
  const apiRoot = fileURLToPath(new URL("../app/api/", import.meta.url));
  const routeFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "route.js") routeFiles.push(target);
    }
  };
  visit(apiRoot);

  const methods = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"];
  const isWrapped = (source, method, group, seen = new Set()) => {
    if (seen.has(method)) return false;
    seen.add(method);
    const direct = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*withApiTelemetry\\(\\s*["']${group}["']`);
    if (direct.test(source)) return true;
    const alias = source.match(new RegExp(`export\\s+const\\s+${method}\\s*=\\s*(${methods.join("|")})\\s*;`));
    return Boolean(alias && isWrapped(source, alias[1], group, seen));
  };

  const coveredGroups = new Set();
  const coveredRoutes = new Set();
  for (const file of routeFiles) {
    const relative = path.relative(apiRoot, file).split(path.sep).join("/");
    const pathname = `/api/${relative.replace(/\/route\.js$/, "")}`;
    const source = readFileSync(file, "utf8");
    const exportedMethods = methods.filter((method) => (
      new RegExp(`export\\s+(?:async\\s+function\\s+${method}\\b|const\\s+${method}\\s*=)`).test(source)
    ));
    let monitoredMethods = 0;
    for (const method of exportedMethods) {
      const group = instrumentation.instrumentationInternals.apiRouteGroup(pathname, method);
      if (!observability.MONITORED_API_GROUPS.has(group)) continue;
      monitoredMethods += 1;
      coveredGroups.add(group);
      assert.equal(
        isWrapped(source, method, group),
        true,
        `${relative} ${method} must use withApiTelemetry(\"${group}\", ...)`,
      );
    }
    if (exportedMethods.some((method) => observability.MONITORED_API_GROUPS.has(
      instrumentation.instrumentationInternals.apiRouteGroup(pathname, method),
    ))) {
      assert.ok(monitoredMethods > 0, `${relative} has no detected monitored HTTP method export`);
      coveredRoutes.add(pathname);
    }
  }
  assert.deepEqual([...coveredGroups].sort(), [...observability.MONITORED_API_GROUPS].sort());
  const declaredRoutes = new Set(telemetryGroups.MONITORED_API_GROUP_DEFINITIONS.flatMap((group) => group.routes));
  assert.deepEqual([...coveredRoutes].sort(), [...declaredRoutes].sort());
});

test("telemetry writers reject a successful HTTP pipeline with a failed Redis row", async () => {
  try {
    telemetryPipelineErrorAt = 2;
    assert.equal(
      await instrumentation.instrumentationInternals.recordUnhandledApiException("auth_login"),
      false,
    );
    telemetryPipelineErrorAt = 2;
    assert.equal(
      await observability.recordApiMetric("auth_login", { status: 200, durationMs: 12 }),
      false,
    );
  } finally {
    telemetryPipelineErrorAt = -1;
  }
});

test("preview QA cannot write production telemetry while production keeps the established keys", async () => {
  const previousEnvironment = process.env.VERCEL_ENV;
  const at = Date.parse("2031-04-05T06:07:08.000Z");
  const apiFiveKey = `lm:obs:api:5m:v1:${Math.floor(at / 300_000) * 300_000}`;
  const depFiveKey = `lm:obs:dep:5m:v1:${Math.floor(at / 300_000) * 300_000}`;
  hashes.delete(apiFiveKey);
  hashes.delete(depFiveKey);
  strings.delete("lm:health:catalog");
  lists.delete("lm:health:history:v1:catalog");
  const queueWritesBefore = queueSnapshotWrites;
  try {
    process.env.VERCEL_ENV = "preview";
    assert.equal(await observability.recordApiMetric("auth_login", { status: 503, durationMs: 25, at }), true);
    assert.equal(await observability.recordDependencyMetric("redis_ping", { status: 503, durationMs: 10, at }), true);
    const previewHealth = await healthModule.recordHealthStatus("catalog", {
      status: "error",
      summary: "preview-only failure",
      error: "preview_qa",
    });
    const previewQueues = await observability.sampleOperationalQueues({ now: at });
    assert.equal(previewHealth?.error, "preview_qa");
    assert.equal(Array.isArray(previewQueues), true);
    assert.equal(hashes.has(apiFiveKey), false);
    assert.equal(hashes.has(depFiveKey), false);
    assert.equal(strings.has("lm:health:catalog"), false);
    assert.equal(lists.has("lm:health:history:v1:catalog"), false);
    assert.equal(queueSnapshotWrites, queueWritesBefore);

    process.env.VERCEL_ENV = "production";
    assert.equal(await observability.recordApiMetric("auth_login", { status: 200, durationMs: 12, at }), true);
    assert.equal(await observability.recordDependencyMetric("redis_ping", { status: 200, durationMs: 8, at }), true);
    assert.equal(hash(apiFiveKey).get("all:requests"), "1");
    assert.equal(hash(apiFiveKey).get("all:status_2xx"), "1");
    assert.equal(hash(depFiveKey).get("all:requests"), "1");
    assert.equal(hash(depFiveKey).get("all:status_2xx"), "1");
    const productionHealth = await healthModule.recordHealthStatus("catalog", {
      status: "ok",
      summary: "production health sample",
    });
    assert.equal(productionHealth?.status, "ok");
    assert.equal(parseJson(strings.get("lm:health:catalog"))?.summary, "production health sample");
    assert.equal(lists.get("lm:health:history:v1:catalog")?.length, 1);
    await observability.sampleOperationalQueues({ now: at + 1 });
    assert.ok(queueSnapshotWrites > queueWritesBefore);
  } finally {
    if (previousEnvironment == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});

test("health CAS preserves top-level history when metrics reuse the same field names", async () => {
  const previousEnv = process.env.VERCEL_ENV;
  const key = "lm:health:catalog";
  const historyKey = "lm:health:history:v1:catalog";
  const previousValue = strings.get(key);
  const previousHistory = lists.get(historyKey);
  process.env.VERCEL_ENV = "production";
  strings.set(key, JSON.stringify({
    component: "catalog",
    status: "ok",
    checkedAt: "2026-08-03T00:00:00.000Z",
    lastSuccessAt: "2026-08-03T00:00:00.000Z",
    lastSuccessAtBeijing: "2026-08-03 08:00:00",
    lastFailureAt: "2026-08-02T00:00:00.000Z",
    lastFailureAtBeijing: "2026-08-02 08:00:00",
    metrics: { lastSuccessAt: "legacy-metric" },
  }));
  try {
    const saved = await healthModule.recordHealthStatus("catalog", {
      status: "warning",
      summary: "adversarial metric names",
      metrics: {
        lastSuccessAt: "",
        lastSuccessAtBeijing: "",
        lastFailureAt: "",
        lastFailureAtBeijing: "",
      },
    });
    assert.equal(saved.lastSuccessAt, "2026-08-03T00:00:00.000Z");
    assert.equal(saved.lastSuccessAtBeijing, "2026-08-03 08:00:00");
    assert.equal(saved.lastFailureAt, "2026-08-02T00:00:00.000Z");
    assert.equal(saved.metrics.lastSuccessAt, "");
    assert.equal(saved.metrics.lastFailureAt, "");
  } finally {
    if (previousValue == null) strings.delete(key); else strings.set(key, previousValue);
    if (previousHistory == null) lists.delete(historyKey); else lists.set(historyKey, previousHistory);
    if (previousEnv == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousEnv;
  }
});
