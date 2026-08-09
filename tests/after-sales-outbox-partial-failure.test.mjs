import assert from "node:assert/strict";
import test from "node:test";

process.env.KV_REST_API_URL = "http://after-sales-outbox-redis.test";
process.env.KV_REST_API_TOKEN = "after-sales-outbox-token";
process.env.AUTH_SECRET = "after-sales-partial-failure-secret-at-least-32-characters";

const values = new Map();
const sortedSets = new Map();
let failNextPipeline = false;
let failNextCleanupCommand = false;
let truncateNextPipeline = false;
let objectGetKey = "";
let objectZrangeKey = "";
let nullZcardKey = "";

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function reset() {
  values.clear();
  sortedSets.clear();
  failNextPipeline = false;
  failNextCleanupCommand = false;
  truncateNextPipeline = false;
  objectGetKey = "";
  objectZrangeKey = "";
  nullZcardKey = "";
  values.set("liumeiti:after-sales:creation-outbox:backfill:v1", "done");
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") {
    if (args[0] === objectGetKey) return { malformed: true };
    return values.get(args[0]) ?? null;
  }
  if (name === "ZRANGE") {
    if (args[0] === objectZrangeKey) return { malformed: true };
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return [...sortedSet(args[0]).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member);
  }
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return [...sortedSet(args[0]).entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member);
  }
  if (name === "ZCARD") return args[0] === nullZcardKey ? null : sortedSet(args[0]).size;
  if (name === "ZREM") return sortedSet(args[0]).delete(args[1]) ? 1 : 0;
  if (name === "PING") return "PONG";
  return null;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://after-sales-outbox-redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    if (failNextPipeline) {
      failNextPipeline = false;
      throw new Error("simulated redis disconnect");
    }
    const commands = JSON.parse(options.body || "[]");
    const rows = commands.map((command) => {
      if (failNextCleanupCommand && String(command?.[0] || "").toUpperCase() === "ZREM") {
        failNextCleanupCommand = false;
        return { error: "simulated cleanup command failure" };
      }
      return { result: execute(command) };
    });
    if (truncateNextPipeline) {
      truncateNextPipeline = false;
      rows.pop();
    }
    return Response.json(rows);
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const store = await import("../app/api/after-sales/_store.js");
const utils = await import("../app/api/_utils.js");
const route = await import("../app/api/admin/after-sales/route.js");
const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "after-sales-test",
  exp: Date.now() + 60_000,
});

function adminRequest(path) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  });
}

function ticket(ticketId, pendingField) {
  return JSON.stringify({
    ticketId,
    orderId: `LM${ticketId}`,
    status: pendingField === "completionEffectsPending" ? "completed" : "pending",
    [pendingField]: true,
    createdAt: "2026-08-09T00:00:00.000Z",
    ...(pendingField === "completionEffectsPending"
      ? { completedAt: "2026-08-09T00:01:00.000Z", completionOperationId: `op-${ticketId}` }
      : {}),
  });
}

function seedStarvedWindow(indexKey, prefix, pendingField, corruptCount) {
  for (let index = 0; index < corruptCount; index += 1) {
    const id = `${prefix}BAD${String(index).padStart(2, "0")}`;
    sortedSet(indexKey).set(id, index);
    if (index % 3 !== 0) {
      values.set(`liumeiti:after-sales:record:${id}`, index % 2 ? "{bad-json" : JSON.stringify({ ticketId: id }));
    }
  }
  const validIds = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `${prefix}GOOD${index}`;
    validIds.push(id);
    sortedSet(indexKey).set(id, corruptCount + 100 + index);
    values.set(`liumeiti:after-sales:record:${id}`, ticket(id, pendingField));
  }
  return validIds;
}

test("completion and creation outboxes page past an all-corrupt first window", async () => {
  reset();
  const completionIndex = "liumeiti:after-sales:completion-outbox";
  const creationIndex = "liumeiti:after-sales:creation-outbox";
  const completionIds = seedStarvedWindow(completionIndex, "ASCOMP", "completionEffectsPending", 55);
  const creationIds = seedStarvedWindow(creationIndex, "ASCREATE", "creationEffectsPending", 505);

  const completion = await store.getAfterSalesCompletionOutbox(5);
  const creation = await store.getAfterSalesCreationOutbox(5);

  assert.deepEqual(completion.map((row) => row.ticketId), completionIds);
  assert.deepEqual(creation.map((row) => row.ticketId), creationIds);
  assert.deepEqual([...sortedSet(completionIndex).keys()], completionIds);
  assert.deepEqual([...sortedSet(creationIndex).keys()], creationIds);
});

test("outbox cleanup command errors fail the whole read", async () => {
  reset();
  const indexKey = "liumeiti:after-sales:completion-outbox";
  const badId = "ASCLEANUPBAD";
  const goodId = "ASCLEANUPGOOD";
  sortedSet(indexKey).set(badId, 1);
  sortedSet(indexKey).set(goodId, 2);
  values.set(`liumeiti:after-sales:record:${badId}`, "not-json");
  values.set(`liumeiti:after-sales:record:${goodId}`, ticket(goodId, "completionEffectsPending"));
  failNextCleanupCommand = true;

  await assert.rejects(store.getAfterSalesCompletionOutbox(1), /after_sales_store_unavailable/);
});

test("outbox record pipeline disconnects fail rather than returning a partial list", async () => {
  reset();
  const indexKey = "liumeiti:after-sales:completion-outbox";
  const id = "ASNETWORKFAIL";
  sortedSet(indexKey).set(id, 1);
  values.set(`liumeiti:after-sales:record:${id}`, ticket(id, "completionEffectsPending"));
  failNextPipeline = true;

  await assert.rejects(store.getAfterSalesCompletionOutbox(1), /after_sales_store_unavailable/);
});

test("outbox record pipeline length mismatches fail rather than dropping one row", async () => {
  reset();
  const indexKey = "liumeiti:after-sales:completion-outbox";
  for (const [index, id] of ["ASLENGTHFAIL1", "ASLENGTHFAIL2"].entries()) {
    sortedSet(indexKey).set(id, index);
    values.set(`liumeiti:after-sales:record:${id}`, ticket(id, "completionEffectsPending"));
  }
  truncateNextPipeline = true;

  await assert.rejects(store.getAfterSalesCompletionOutbox(2), /after_sales_store_unavailable/);
});

test("object-shaped GET results are transport failures, not skippable records", async () => {
  reset();
  const indexKey = "liumeiti:after-sales:completion-outbox";
  const id = "ASOBJECTGET";
  sortedSet(indexKey).set(id, 1);
  objectGetKey = `liumeiti:after-sales:record:${id}`;

  await assert.rejects(store.getAfterSalesCompletionOutbox(1), /after_sales_store_unavailable/);
});

test("object-shaped ZRANGE results fail both outbox readers", async () => {
  reset();
  objectZrangeKey = "liumeiti:after-sales:completion-outbox";
  await assert.rejects(store.getAfterSalesCompletionOutbox(1), /after_sales_store_unavailable/);
  objectZrangeKey = "liumeiti:after-sales:creation-outbox";
  await assert.rejects(store.getAfterSalesCreationOutbox(1), /creation_outbox_unavailable/);
});

test("admin after-sales route returns 503 when count storage is unavailable", async () => {
  reset();
  failNextPipeline = true;
  const response = await route.GET(adminRequest("/api/admin/after-sales"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "after_sales_store_unavailable" });
});

test("admin after-sales route rejects a null count result instead of reporting zero", async () => {
  reset();
  nullZcardKey = "liumeiti:after-sales:index";
  const response = await route.GET(adminRequest("/api/admin/after-sales"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "after_sales_store_unavailable" });
});

test("admin after-sales route fills a page beyond a corrupt newest window", async () => {
  reset();
  const allIndex = "liumeiti:after-sales:index";
  for (let index = 0; index < 205; index += 1) {
    const id = `ASLISTBAD${String(index).padStart(3, "0")}`;
    sortedSet(allIndex).set(id, 1000 - index);
    if (index % 2) values.set(`liumeiti:after-sales:record:${id}`, "{bad-json");
  }
  const goodIds = ["ASLISTGOOD1", "ASLISTGOOD2"];
  goodIds.forEach((id, index) => {
    sortedSet(allIndex).set(id, 10 - index);
    values.set(`liumeiti:after-sales:record:${id}`, ticket(id, "creationEffectsPending"));
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await route.GET(adminRequest("/api/admin/after-sales?limit=2"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.tickets.map((entry) => entry.ticketId), goodIds);
    assert.equal(payload.total, 2);
    assert.equal(payload.hasMore, false);
  } finally {
    console.warn = originalWarn;
  }
});

test("admin after-sales search finds a match older than the former 5000-record window", async () => {
  reset();
  const allIndex = "liumeiti:after-sales:index";
  for (let index = 0; index < 5000; index += 1) {
    const id = `ASSEARCH${String(index).padStart(4, "0")}`;
    sortedSet(allIndex).set(id, 6000 - index);
    values.set(`liumeiti:after-sales:record:${id}`, ticket(id, "creationEffectsPending"));
  }
  const targetId = "ASSEARCHOLDEST";
  sortedSet(allIndex).set(targetId, 1);
  values.set(`liumeiti:after-sales:record:${targetId}`, JSON.stringify({
    ...JSON.parse(ticket(targetId, "creationEffectsPending")),
    issue: "needle oldest ticket",
  }));

  const response = await route.GET(adminRequest("/api/admin/after-sales?q=needle%20oldest%20ticket&limit=5"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.tickets.map((entry) => entry.ticketId), [targetId]);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
