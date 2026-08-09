import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "insights-partial-failure-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://insights-redis.test";
process.env.KV_REST_API_TOKEN = "insights-test-token";

const originalFetch = globalThis.fetch;
const visitorIds = Array.from({ length: 201 }, (_, index) => `visitor-${String(index).padStart(3, "0")}`);
const strings = new Map();
const sets = new Map();
let failSecondTimelinePage = false;
let failCompletionMarkerRead = false;
let replaceBackfillLockBeforeRelease = false;
let overrideBackfillWrite = false;
let backfillWriteCommand = "SADD";
let backfillWriteResult = null;
let backfillWriteMode = "result";
const writtenCommands = [];

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  writtenCommands.push(command.map(String));
  if (name === "PING") return "PONG";
  if (name === "GET") return strings.get(String(args[0])) ?? null;
  if (name === "SET") {
    const key = String(args[0]);
    if (args.map(String).includes("NX") && strings.has(key)) return null;
    strings.set(key, String(args[1]));
    return "OK";
  }
  if (name === "DEL") return strings.delete(String(args[0])) ? 1 : 0;
  if (name === "EVAL") {
    const key = String(args[2]);
    const expected = String(args[3]);
    if (strings.get(key) !== expected) return 0;
    strings.delete(key);
    return 1;
  }
  if (name === "ZRANGE") return String(args[0]) === "lm:visit:index" ? visitorIds : [];
  if (name === "LRANGE") {
    const key = String(args[0]);
    if (key === "lm:visit:v:visitor-000:pages") return [JSON.stringify({ ts: Date.now() - 60_000, path: "/shop" })];
    if (key === "lm:visit:v:visitor-000:events") return [JSON.stringify({ ts: Date.now() - 30_000, name: "service_view" })];
    return [];
  }
  if (name === "SADD") {
    const key = String(args[0]);
    if (!sets.has(key)) sets.set(key, new Set());
    let added = 0;
    for (const member of args.slice(1).map(String)) {
      if (!sets.get(key).has(member)) { sets.get(key).add(member); added += 1; }
    }
    return added;
  }
  if (name === "EXPIRE") return sets.has(String(args[0])) || strings.has(String(args[0])) ? 1 : 0;
  if (name === "HGETALL") return {};
  if (name === "ZCARD") return String(args[0]) === "lm:visit:index" ? visitorIds.length : 0;
  if (name === "SCARD") return sets.get(String(args[0]))?.size || 0;
  if (name === "SMEMBERS") return [...(sets.get(String(args[0])) || [])];
  if (name === "SUNION") return [...new Set(args.flatMap((key) => [...(sets.get(String(key)) || [])]))];
  if (name === "SCAN") return ["0", []];
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== "http://insights-redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    if (replaceBackfillLockBeforeRelease && commands.some((command) => (
      String(command?.[0] || "").toUpperCase() === "EVAL"
      && String(command?.[3] || "") === "lm:analytics:unique-backfill:v2:lock"
    ))) {
      strings.set("lm:analytics:unique-backfill:v2:lock", "new-worker-lock-token");
    }
    if (failCompletionMarkerRead && commands.some((command) => (
      String(command?.[0] || "").toUpperCase() === "GET"
      && String(command?.[1] || "") === "lm:analytics:unique-backfill:v2"
    ))) {
      return Response.json(commands.map((command) => (
        String(command?.[0] || "").toUpperCase() === "GET"
          ? { error: "ERR injected completion marker read" }
          : { result: execute(command) }
      )));
    }
    if (failSecondTimelinePage && commands.some((command) => String(command?.[1] || "").includes("visitor-200"))) {
      return Response.json(commands.map((command) => (
        String(command?.[1] || "").includes("visitor-200")
          ? { error: "ERR injected second page failure" }
          : { result: execute(command) }
      )));
    }
    let injectedBackfillWrite = false;
    const isBackfillWriteBatch = commands.some((command) => {
      const key = String(command?.[1] || "");
      return key.startsWith("lm:visit:day:") || key.startsWith("lm:ev:uniq:");
    });
    return Response.json(commands.map((command) => {
      const name = String(command?.[0] || "").toUpperCase();
      const key = String(command?.[1] || "");
      if (overrideBackfillWrite && backfillWriteMode === "ping" && isBackfillWriteBatch && name === "PING") {
        return { result: "NOT_PONG" };
      }
      if (overrideBackfillWrite && backfillWriteMode !== "ping" && !injectedBackfillWrite
          && name === backfillWriteCommand
          && (key.startsWith("lm:visit:day:") || key.startsWith("lm:ev:uniq:"))) {
        injectedBackfillWrite = true;
        return backfillWriteMode === "error"
          ? { error: "ERR injected backfill write failure" }
          : { result: backfillWriteResult };
      }
      return { result: execute(command) };
    }));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const utils = await import("../app/api/_utils.js");
const insightsRoute = await import("../app/api/admin/insights/route.js");

function adminInsightsRequest() {
  const token = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  return new Request("https://www.liumeiti.vip/api/admin/insights?days=30", {
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  });
}

test.after(() => { globalThis.fetch = originalFetch; });

test("analytics backfill does not mark completion when its second timeline page fails", async () => {
  strings.clear();
  sets.clear();
  writtenCommands.length = 0;
  failSecondTimelinePage = true;
  const failed = await insightsRoute.GET(adminInsightsRequest());
  assert.equal(failed.status, 503);
  assert.equal(strings.has("lm:analytics:unique-backfill:v2"), false);
  assert.equal(strings.has("lm:analytics:unique-backfill:v2:lock"), false);
  assert.equal(writtenCommands.some((command) => command[0] === "SET" && command[1] === "lm:analytics:unique-backfill:v2"), false);

  failSecondTimelinePage = false;
  writtenCommands.length = 0;
  const retried = await insightsRoute.GET(adminInsightsRequest());
  const body = await retried.json();
  assert.equal(retried.status, 200, JSON.stringify(body));
  assert.equal(body.funnel.visitors, 1);
  assert.equal(body.funnel.serviceViews, 1);
  assert.match(strings.get("lm:analytics:unique-backfill:v2") || "", /^\d{4}-\d{2}-\d{2}T/);
});

test("analytics backfill rejects failed or malformed write batches before completion and a healthy retry restores full statistics", async (t) => {
  for (const [label, command, mode, result] of [
    ["null SADD", "SADD", "result", null],
    ["object EXPIRE", "EXPIRE", "result", { unexpected: true }],
    ["float SADD", "SADD", "result", 0.5],
    ["SADD command error", "SADD", "error", null],
    ["write batch PING mismatch", "SADD", "ping", null],
  ]) {
    await t.test(label, async () => {
      strings.clear();
      sets.clear();
      writtenCommands.length = 0;
      overrideBackfillWrite = true;
      backfillWriteCommand = command;
      backfillWriteMode = mode;
      backfillWriteResult = result;
      let failed;
      try { failed = await insightsRoute.GET(adminInsightsRequest()); }
      finally { overrideBackfillWrite = false; }
      assert.equal(failed.status, 503);
      assert.equal(strings.has("lm:analytics:unique-backfill:v2"), false);
      assert.equal(strings.has("lm:analytics:unique-backfill:v2:lock"), false);
      assert.equal(writtenCommands.some((item) => item[0] === "SET" && item[1] === "lm:analytics:unique-backfill:v2"), false);

      const retried = await insightsRoute.GET(adminInsightsRequest());
      const body = await retried.json();
      assert.equal(retried.status, 200, JSON.stringify(body));
      assert.equal(body.funnel.visitors, 1);
      assert.equal(body.funnel.serviceViews, 1);
      assert.match(strings.get("lm:analytics:unique-backfill:v2") || "", /^\d{4}-\d{2}-\d{2}T/);
    });
  }
});

test("insights route returns 503 instead of fake zero statistics when Redis command execution fails", async () => {
  strings.clear();
  failCompletionMarkerRead = true;
  try {
    const response = await insightsRoute.GET(adminInsightsRequest());
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.deepEqual(body, { ok: false, error: "insights_store_unavailable" });
  } finally {
    failCompletionMarkerRead = false;
  }
});

test("an expired analytics backfill worker cannot delete a newer worker's lock", async () => {
  strings.clear();
  writtenCommands.length = 0;
  replaceBackfillLockBeforeRelease = true;
  try {
    await insightsRoute.insightsInternals.ensureUniqueAnalyticsBackfill(Date.parse("2026-08-09T00:00:00.000Z"));
    assert.equal(strings.get("lm:analytics:unique-backfill:v2:lock"), "new-worker-lock-token");
    const lockSet = writtenCommands.find((command) => (
      command[0] === "SET" && command[1] === "lm:analytics:unique-backfill:v2:lock"
    ));
    assert.match(lockSet?.[2] || "", /^[a-f0-9]{48}$/);
    assert.notEqual(lockSet?.[2], "new-worker-lock-token");
  } finally {
    replaceBackfillLockBeforeRelease = false;
    strings.delete("lm:analytics:unique-backfill:v2:lock");
  }
});
