import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "http://delivery-once.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
const originalFetch = globalThis.fetch;
let failDoneRecordOnce = false;
let failClaimOnce = false;

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((item) => String(item).toUpperCase()).includes("NX") && values.has(key)) return null;
    if (value === "done" && failDoneRecordOnce) {
      failDoneRecordOnce = false;
      return null;
    }
    values.set(key, value);
    return "OK";
  }
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("return 'acquired'")) {
      if (failClaimOnce) {
        failClaimOnce = false;
        return null;
      }
      const raw = values.get(keys[0]);
      if (raw) {
        if (raw === "done") return "done";
        try {
          const state = JSON.parse(raw);
          if (["done", "sending", "uncertain"].includes(state?.status)) return state.status;
          if (state?.status !== "retryable") return "uncertain";
        } catch {
          return "uncertain";
        }
      }
      values.set(keys[0], argv[1]);
      return "acquired";
    }
    throw new Error("unexpected EVAL script");
  }
  throw new Error(`unhandled Redis command ${name}`);
}

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.origin !== "http://delivery-once.redis.test") return originalFetch(input);
  return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
};

const { deliverOnce, deliveryInternals } = await import("../app/api/_delivery-once.js");

test.after(() => { globalThis.fetch = originalFetch; });

test("successful delivery is not repeated", async () => {
  values.clear();
  let sent = 0;
  const first = await deliverOnce("order:LM1:email", async () => { sent += 1; return { ok: true }; });
  const second = await deliverOnce("order:LM1:email", async () => { sent += 1; return { ok: true }; });
  assert.equal(first.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(sent, 1);
  assert.equal(values.get(deliveryInternals.deliveryKey("order:LM1:email")), "done");
});

test("a definitive provider rejection marks the journal retryable", async () => {
  values.clear();
  let sent = 0;
  const first = await deliverOnce("withdrawal:WD1:telegram", async () => { sent += 1; return false; });
  const second = await deliverOnce("withdrawal:WD1:telegram", async () => { sent += 1; return true; });
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(sent, 2);
});

test("concurrent retries share one permanent dispatch claim", async () => {
  values.clear();
  let sent = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = deliverOnce("quote:LM2:webhook", async () => { sent += 1; await gate; return true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await deliverOnce("quote:LM2:webhook", async () => { sent += 1; return true; });
  assert.equal(second.pending, true);
  release();
  assert.equal((await first).ok, true);
  assert.equal(sent, 1);
});

test("an unrecorded provider acknowledgement never causes an automatic duplicate", async () => {
  values.clear();
  failDoneRecordOnce = true;
  let sent = 0;
  const first = await deliverOnce("order:LM3:telegram", async () => { sent += 1; return true; });
  const second = await deliverOnce("order:LM3:telegram", async () => { sent += 1; return true; });
  assert.equal(first.ok, true);
  assert.equal(first.recorded, false);
  assert.equal(first.uncertain, true);
  assert.equal(second.uncertain, true);
  assert.equal(sent, 1);
});

test("ambiguous provider failures are journaled and are not retried automatically", async () => {
  values.clear();
  let sent = 0;
  const first = await deliverOnce("withdrawal:WD2:smtp", async () => {
    sent += 1;
    throw new Error("connection_lost_after_send");
  });
  const second = await deliverOnce("withdrawal:WD2:smtp", async () => { sent += 1; return true; });
  assert.equal(first.ok, false);
  assert.equal(first.uncertain, true);
  assert.equal(second.error, "delivery_result_uncertain");
  assert.equal(sent, 1);
});

test("a malformed or legacy journal marker fails closed", async () => {
  values.clear();
  const key = deliveryInternals.deliveryKey("order:LM4:email");
  values.set(key, "legacy-in-flight-token");
  let sent = 0;
  const result = await deliverOnce("order:LM4:email", async () => { sent += 1; return true; });
  assert.equal(result.uncertain, true);
  assert.equal(result.error, "delivery_result_uncertain");
  assert.equal(sent, 0);
});

test("a transport-declared ambiguous result is journaled and never retried", async () => {
  values.clear();
  let sent = 0;
  const first = await deliverOnce("order:LM5:webhook", async () => {
    sent += 1;
    return { ok: false, uncertain: true, error: "upstream_timeout" };
  });
  const second = await deliverOnce("order:LM5:webhook", async () => { sent += 1; return true; });
  assert.equal(first.uncertain, true);
  assert.equal(first.error, "upstream_timeout");
  assert.equal(second.error, "delivery_result_uncertain");
  assert.equal(sent, 1);
});

test("an unavailable atomic journal claim never falls through to the provider", async () => {
  values.clear();
  const key = deliveryInternals.deliveryKey("order:LM6:email");
  values.set(key, "done");
  failClaimOnce = true;
  let sent = 0;
  const unavailable = await deliverOnce("order:LM6:email", async () => { sent += 1; return true; });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "delivery_journal_unavailable");
  assert.equal(sent, 0);
  assert.equal(values.get(key), "done");

  const replay = await deliverOnce("order:LM6:email", async () => { sent += 1; return true; });
  assert.equal(replay.idempotent, true);
  assert.equal(sent, 0);
});
