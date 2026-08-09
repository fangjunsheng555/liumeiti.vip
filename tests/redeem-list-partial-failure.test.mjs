import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "redeem-list-partial-failure-secret-32-characters";
process.env.KV_REST_API_URL = "http://redeem-list.redis.test";
process.env.KV_REST_API_TOKEN = "redeem-list-token";

const originalFetch = globalThis.fetch;
const lists = new Map();
const values = new Map();
let pipelineFault = null;

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "LRANGE") return [...(lists.get(String(args[0])) || [])];
  if (name === "GET") return values.get(String(args[0])) ?? null;
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== "http://redeem-list.redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    if (pipelineFault === "http") return new Response("unavailable", { status: 503 });
    const commands = JSON.parse(options.body || "[]");
    if (pipelineFault === "truncated") return Response.json(commands.slice(0, -1).map((command) => ({ result: execute(command) })));
    return Response.json(commands.map((command) => (
      pipelineFault && pipelineFault.command === String(command[0]).toUpperCase()
        && (!pipelineFault.key || pipelineFault.key === String(command[1]))
        ? { error: pipelineFault.error }
        : { result: execute(command) }
    )));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const utils = await import("../app/api/_utils.js");
const redeemRoute = await import("../app/api/admin/redeem-codes/route.js");

test.after(() => { globalThis.fetch = originalFetch; });
test.afterEach(() => {
  lists.clear();
  values.clear();
  pipelineFault = null;
});

function balanceCode(code, overrides) {
  return { code, status: "active", type: "balance", amount: 5, ...overrides };
}

function adminRequest() {
  const token = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  return new Request("https://www.liumeiti.vip/api/admin/redeem-codes", {
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  });
}

test("redeem list skips malformed business rows but preserves valid string and object records", async () => {
  lists.set("liumeiti:redeem-codes", ["GOODCODE", "OBJECTCODE", "BADJSON", "MISMATCH", "BADSTATUS", {}, "GOODCODE"]);
  values.set("liumeiti:redeem-code:GOODCODE", JSON.stringify(balanceCode("GOODCODE", {})));
  values.set("liumeiti:redeem-code:OBJECTCODE", balanceCode("OBJECTCODE", { amount: "7.25" }));
  values.set("liumeiti:redeem-code:BADJSON", "{bad-json");
  values.set("liumeiti:redeem-code:MISMATCH", JSON.stringify(balanceCode("OTHER", {})));
  values.set("liumeiti:redeem-code:BADSTATUS", JSON.stringify(balanceCode("BADSTATUS", { status: "mystery" })));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const records = await utils.listRedeemCodes();
    assert.deepEqual(records.map((record) => record.code), ["GOODCODE", "OBJECTCODE"]);
    assert.equal(records[1].amount, 7.25);
    assert.ok(warnings.some((entry) => String(entry[0]).includes("redeem-code-list")));
  } finally {
    console.warn = originalWarn;
  }
});

test("one incomplete redeem batch is skipped without publishing incorrect counts for the healthy batch", async () => {
  lists.set("liumeiti:redeem-code-batches", ["BATCH-GOOD", "BATCH-INCOMPLETE", "BATCH-BAD"]);
  values.set("liumeiti:redeem-code-batch:BATCH-GOOD", JSON.stringify({
    id: "BATCH-GOOD", type: "balance", amount: 5, quantity: 2, codes: ["CODEONE", "CODETWO"],
  }));
  values.set("liumeiti:redeem-code-batch:BATCH-INCOMPLETE", JSON.stringify({
    id: "BATCH-INCOMPLETE", type: "balance", amount: 5, quantity: 1, codes: ["MISSINGCODE"],
  }));
  values.set("liumeiti:redeem-code-batch:BATCH-BAD", JSON.stringify({ id: "BATCH-BAD", codes: "not-an-array" }));
  values.set("liumeiti:redeem-code:CODEONE", JSON.stringify(balanceCode("CODEONE", {})));
  values.set("liumeiti:redeem-code:CODETWO", JSON.stringify(balanceCode("CODETWO", { status: "used" })));
  const batches = await utils.listRedeemCodeBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, "BATCH-GOOD");
  assert.deepEqual(batches[0].counts, { active: 1, used: 1, void: 0 });
  assert.equal(batches[0].quantity, 2);
});

test("corrupt retained windows cannot hide an older valid code or batch", async () => {
  const missingCodes = Array.from({ length: 500 }, (_, index) => `MISSING${String(index).padStart(4, "0")}`);
  const corruptBatches = Array.from({ length: 200 }, (_, index) => `BAD-BATCH-${String(index).padStart(3, "0")}`);
  lists.set("liumeiti:redeem-codes", [...missingCodes, "OLDERGOOD"]);
  lists.set("liumeiti:redeem-code-batches", [...corruptBatches, "OLDER-BATCH"]);
  corruptBatches.forEach((id) => values.set(`liumeiti:redeem-code-batch:${id}`, "{bad-json"));
  values.set("liumeiti:redeem-code:OLDERGOOD", JSON.stringify(balanceCode("OLDERGOOD", {})));
  values.set("liumeiti:redeem-code-batch:OLDER-BATCH", JSON.stringify({
    id: "OLDER-BATCH", type: "balance", amount: 5, quantity: 1, codes: ["OLDERGOOD"],
  }));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual((await utils.listRedeemCodes()).map((record) => record.code), ["OLDERGOOD"]);
    assert.deepEqual((await utils.listRedeemCodeBatches()).map((record) => record.id), ["OLDER-BATCH"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("a Redis command error is a 503 transport failure rather than an empty redeem list", async () => {
  lists.set("liumeiti:redeem-codes", ["GOODCODE"]);
  values.set("liumeiti:redeem-code:GOODCODE", JSON.stringify(balanceCode("GOODCODE", {})));
  pipelineFault = { command: "GET", key: "liumeiti:redeem-code:GOODCODE", error: "WRONGTYPE injected" };
  await assert.rejects(utils.listRedeemCodes(), /redeem_store_unavailable/);
  const response = await redeemRoute.GET(adminRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "redeem_store_unavailable" });
});

test("truncated and unavailable Redis pipelines never become successful empty redeem data", async () => {
  lists.set("liumeiti:redeem-codes", ["GOODCODE"]);
  values.set("liumeiti:redeem-code:GOODCODE", JSON.stringify(balanceCode("GOODCODE", {})));
  for (const fault of ["truncated", "http"]) {
    pipelineFault = fault;
    await assert.rejects(utils.listRedeemCodes(), /redeem_store_unavailable/);
  }
});

test("a malformed index response is a storage failure and cannot be mistaken for zero codes", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin === "http://redeem-list.redis.test" && url.pathname.toLowerCase().startsWith("/lrange/")) {
      return Response.json({ result: { malformed: true } });
    }
    return savedFetch(input, options);
  };
  try { await assert.rejects(utils.listRedeemCodes(), /redeem_store_unavailable/); }
  finally { globalThis.fetch = savedFetch; }
});
