import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "keeper-lease-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://keeper-lease.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.WEB_PUSH_ENABLED = "0";

const strings = new Map();
const originalFetch = globalThis.fetch;
let failPushRecovery = false;
let failHealthWrite = false;
let loseSetResponseKey = "";

function current(key) {
  const entry = strings.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    strings.delete(key);
    return null;
  }
  return entry;
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return current(args[0])?.value ?? null;
  if (name === "MGET") return args.map((key) => current(key)?.value ?? null);
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((item) => String(item).toUpperCase()).includes("NX") && current(key)) return null;
    const exIndex = options.findIndex((item) => String(item).toUpperCase() === "EX");
    const expiresAt = exIndex >= 0 ? Date.now() + Number(options[exIndex + 1]) * 1000 : 0;
    strings.set(key, { value, expiresAt });
    return key === loseSetResponseKey ? null : "OK";
  }
  if (name === "DEL") return strings.delete(args[0]) ? 1 : 0;
  if (name === "EXPIRE") return 1;
  if (["HSET", "ZADD", "ZREMRANGEBYRANK", "LPUSH", "LTRIM"].includes(name)) return 1;
  if (name === "ZRANGEBYSCORE") {
    if (failPushRecovery && args[0] === "lm:push:enqueue-recovery-index:v1") return null;
    return [];
  }
  if (name === "HSCAN") return ["0", []];
  if (name === "HLEN" || name === "ZCARD" || name === "ZCOUNT") return 0;
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    const entry = current(keys[0]);
    if (script.includes("local encoded=ARGV[1]") && script.includes("LPUSH")) {
      if (failHealthWrite) return null;
      strings.set(keys[0], { value: String(argv[0]), expiresAt: 0 });
      return String(argv[0]);
    }
    if (script.includes("return #ids") && script.includes("ZRANGEBYSCORE")) return 0;
    if (script.includes("PEXPIRE")) {
      if (!entry || entry.value !== argv[0]) return 0;
      entry.expiresAt = Date.now() + Number(argv[1]);
      return 1;
    }
    if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]") && script.includes("redis.call('DEL',KEYS[1])")) {
      if (!entry || entry.value !== argv[0]) return 0;
      strings.delete(keys[0]);
      return 1;
    }
    return null;
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://keeper-lease.redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    return Response.json(commands.map((command) => ({ result: execute(command) })));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const keeper = await import("../app/api/_keeper.js");

test.after(() => { globalThis.fetch = originalFetch; });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a running tick renews its token lease across the original TTL", async () => {
  strings.clear();
  let release;
  let executions = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    job: "order_transition",
    lockKey: "lm:test:long-running-tick",
    intervalSec: 1,
    trigger: "test",
  };
  const first = keeper.keeperInternals.runTick({
    ...options,
    handler: async () => {
      executions += 1;
      await gate;
      return { ok: true, processed: 1 };
    },
  });
  await wait(1_150);
  const overlapping = await keeper.keeperInternals.runTick({
    ...options,
    handler: async () => { executions += 1; return { ok: true }; },
  });
  assert.equal(overlapping.skipped, true);
  assert.equal(overlapping.reason, "throttled");
  assert.equal(executions, 1);

  release();
  const completed = await first;
  assert.equal(completed.ok, true);
  const throttledAfterSuccess = await keeper.keeperInternals.runTick({
    ...options,
    handler: async () => { executions += 1; return { ok: true }; },
  });
  assert.equal(throttledAfterSuccess.skipped, true, "success keeps a fresh throttle TTL");
});

test("a failed tick compare-deletes its lease for immediate recovery", async () => {
  strings.clear();
  const options = {
    job: "order_transition",
    lockKey: "lm:test:failed-tick",
    intervalSec: 60,
    trigger: "test",
  };
  const failed = await keeper.keeperInternals.runTick({ ...options, handler: async () => ({ ok: false, error: "test_failure" }) });
  assert.equal(failed.ok, false);
  const recovered = await keeper.keeperInternals.runTick({ ...options, handler: async () => ({ ok: true, processed: 1 }) });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.skipped, undefined);
});

test("a committed tick lease with a lost SET response is recovered by its token", async () => {
  strings.clear();
  const lockKey = "lm:test:ambiguous-tick-lock";
  loseSetResponseKey = lockKey;
  let executions = 0;
  const result = await keeper.keeperInternals.runTick({
    job: "order_transition", lockKey, intervalSec: 60, trigger: "test",
    handler: async () => { executions += 1; return { ok: true }; },
  });
  loseSetResponseKey = "";
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
});

test("an invalid keeper result fails and releases its lease for immediate retry", async () => {
  strings.clear();
  const options = { job: "order_transition", lockKey: "lm:test:invalid-result", intervalSec: 60, trigger: "test" };
  const invalid = await keeper.keeperInternals.runTick({ ...options, handler: async () => ({}) });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "invalid_job_result");
  const retry = await keeper.keeperInternals.runTick({ ...options, handler: async () => ({ ok: true }) });
  assert.equal(retry.ok, true);
  assert.equal(retry.skipped, undefined);
});

test("a monitoring write failure never repeats an already successful business tick", async () => {
  strings.clear();
  let executions = 0;
  const options = {
    job: "order_transition",
    lockKey: "lm:test:monitoring-failed-tick",
    intervalSec: 60,
    trigger: "test",
  };
  failHealthWrite = true;
  const first = await keeper.keeperInternals.runTick({
    ...options,
    handler: async () => {
      executions += 1;
      return { ok: true, processed: 1 };
    },
  });
  failHealthWrite = false;
  assert.equal(first.ok, false);
  assert.equal(first.businessOk, true);
  assert.equal(first.monitoringError, "task_health_write_failed");

  const retry = await keeper.keeperInternals.runTick({
    ...options,
    handler: async () => {
      executions += 1;
      return { ok: true, processed: 1 };
    },
  });
  assert.equal(retry.skipped, true);
  assert.equal(retry.reason, "throttled");
  assert.equal(executions, 1);
});

test("push maintenance isolates a failed recovery step and still runs cleanup/stats", async () => {
  strings.clear();
  failPushRecovery = true;
  const result = await keeper.keeperInternals.pushMaintenanceTick("test", { remainingMs: 20_000 });
  failPushRecovery = false;
  assert.equal(result.ok, false);
  assert.equal(result.recovery.ok, false);
  assert.equal(result.dispatch.disabled, true);
  assert.equal(result.cleanup.ok, true);
  assert.equal(result.stats.ok, true);
  assert.deepEqual(
    {
      subscriptions: result.stats.subscriptions,
      queued: result.stats.queued,
      events: result.stats.events,
      enqueueRecovery: result.stats.enqueueRecovery,
      providerAlerts: result.stats.providerAlerts,
    },
    { subscriptions: 0, queued: 0, events: 0, enqueueRecovery: 0, providerAlerts: 0 },
  );
});

test("push maintenance respects the global remaining deadline before starting work", async () => {
  strings.clear();
  const result = await keeper.keeperInternals.pushMaintenanceTick("test", { remainingMs: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.error, "maintenance_deadline_exceeded");
});
