import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "http://delivery-once.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
const sortedSets = new Map();
const originalFetch = globalThis.fetch;
let failDoneRecordOnce = false;
let failClaimOnce = false;
let failBackfillReadOnce = false;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function clearDeliveryIndexes(keys, member) {
  keys.slice(1, 4).forEach((key) => sortedSet(key).delete(member));
}

function indexDelivery(keys, status, score, member) {
  clearDeliveryIndexes(keys, member);
  const index = status === "sending" ? 1 : status === "uncertain" ? 2 : status === "retryable" ? 3 : 0;
  if (index) sortedSet(keys[index]).set(member, Number(score));
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
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
        if (raw === "done") {
          clearDeliveryIndexes(keys, argv[3]);
          return "done";
        }
        try {
          const state = JSON.parse(raw);
          if (state?.status === "done") {
            clearDeliveryIndexes(keys, argv[3]);
            return raw;
          }
          if (["sending", "uncertain"].includes(state?.status)) {
            indexDelivery(keys, state.status, state.score || argv[2], argv[3]);
            return state.status;
          }
          if (state?.status !== "retryable") return "uncertain";
        } catch {
          indexDelivery(keys, "uncertain", argv[2], argv[3]);
          return "uncertain";
        }
      }
      values.set(keys[0], argv[1]);
      indexDelivery(keys, "sending", argv[2], argv[3]);
      return "acquired";
    }
    if (script.includes("ARGV[3]=='sending'") && script.includes("return 1")) {
      const current = JSON.parse(values.get(keys[0]) || "null");
      if (!current || current.token !== argv[0]) return 0;
      values.set(keys[0], argv[1]);
      indexDelivery(keys, argv[2], argv[3], argv[4]);
      return 1;
    }
    if (script.includes("redis.call('SET',KEYS[1],'done')")) {
      if (failDoneRecordOnce) {
        failDoneRecordOnce = false;
        return 0;
      }
      const raw = values.get(keys[0]);
      if (raw === "done") {
        clearDeliveryIndexes(keys, argv[1]);
        return 1;
      }
      const current = JSON.parse(raw || "null");
      if (!current || current.token !== argv[0]) return 0;
      values.set(keys[0], argv[2] || "done");
      clearDeliveryIndexes(keys, argv[1]);
      return 1;
    }
    throw new Error("unexpected EVAL script");
  }
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") return sortedSet(args[0]).delete(args[1]) ? 1 : 0;
  if (name === "SCAN") {
    const pattern = String(args[2] || "").replace(/\*$/, "");
    return ["0", [...values.keys()].filter((key) => key.startsWith(pattern))];
  }
  throw new Error(`unhandled Redis command ${name}`);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://delivery-once.redis.test") return originalFetch(input);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    if (failBackfillReadOnce && commands.length > 0 && commands.every((command) => command[0] === "GET")) {
      failBackfillReadOnce = false;
      return Response.json(commands.map((command, index) => (
        index === 0 ? { error: "ERR injected backfill read failure" } : { result: execute(command) }
      )));
    }
    return Response.json(commands.map((command) => ({ result: execute(command) })));
  }
  return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
};

const { backfillDeliveryStatusIndexes, deliverOnce, deliveryInternals } = await import("../app/api/_delivery-once.js");

test.after(() => { globalThis.fetch = originalFetch; });

test("successful delivery is not repeated", async () => {
  values.clear();
  sortedSets.clear();
  let sent = 0;
  const first = await deliverOnce("order:LM1:email", async () => { sent += 1; return { ok: true }; });
  const second = await deliverOnce("order:LM1:email", async () => { sent += 1; return { ok: true }; });
  assert.equal(first.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(sent, 1);
  assert.equal(JSON.parse(values.get(deliveryInternals.deliveryKey("order:LM1:email"))).status, "done");
});

test("a definitive provider rejection marks the journal retryable", async () => {
  values.clear();
  sortedSets.clear();
  let sent = 0;
  const first = await deliverOnce("withdrawal:WD1:telegram", async () => { sent += 1; return false; });
  const second = await deliverOnce("withdrawal:WD1:telegram", async () => { sent += 1; return true; });
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(sent, 2);
});

test("concurrent retries share one permanent dispatch claim", async () => {
  values.clear();
  sortedSets.clear();
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
  sortedSets.clear();
  failDoneRecordOnce = true;
  let sent = 0;
  const first = await deliverOnce("order:LM3:telegram", async () => { sent += 1; return true; });
  const second = await deliverOnce("order:LM3:telegram", async () => { sent += 1; return true; });
  assert.equal(first.ok, false);
  assert.equal(first.recorded, false);
  assert.equal(first.uncertain, true);
  assert.equal(second.uncertain, true);
  assert.equal(sent, 1);
});

test("a policy suppression is terminal, replayable, and never reported as delivered", async () => {
  values.clear();
  sortedSets.clear();
  let attempted = 0;
  const send = async () => {
    attempted += 1;
    return { ok: false, suppressed: true, retryable: false, reason: "recipient_suppressed" };
  };
  const first = await deliverOnce("order:SUPPRESSED:email", send);
  const replay = await deliverOnce("order:SUPPRESSED:email", send);
  assert.equal(first.ok, true);
  assert.equal(first.terminal, true);
  assert.equal(first.suppressed, true);
  assert.equal(first.delivered, false);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.suppressed, true);
  assert.equal(replay.delivered, false);
  assert.equal(attempted, 1);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_RETRYABLE_INDEX).size, 0);
});

test("ambiguous provider failures are journaled and are not retried automatically", async () => {
  values.clear();
  sortedSets.clear();
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
  sortedSets.clear();
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
  sortedSets.clear();
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
  sortedSets.clear();
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

test("legacy delivery journals are repeatably backfilled into real status indexes", async () => {
  values.clear();
  sortedSets.clear();
  const sendingKey = deliveryInternals.deliveryKey("legacy:sending");
  const uncertainKey = deliveryInternals.deliveryKey("legacy:uncertain");
  const retryableKey = deliveryInternals.deliveryKey("legacy:retryable");
  values.set(sendingKey, JSON.stringify({ status: "sending", at: "2026-01-01T00:00:00.000Z" }));
  values.set(uncertainKey, JSON.stringify({ status: "uncertain", at: "2026-01-02T00:00:00.000Z" }));
  values.set(retryableKey, JSON.stringify({ status: "retryable", at: "2026-01-03T00:00:00.000Z" }));
  values.delete(deliveryInternals.DELIVERY_BACKFILL_CURSOR);
  const result = await backfillDeliveryStatusIndexes();
  assert.equal(result.ok, true);
  assert.equal(result.indexed, 3);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_SENDING_INDEX).has(sendingKey), true);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_UNCERTAIN_INDEX).has(uncertainKey), true);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_RETRYABLE_INDEX).has(retryableKey), true);
  const replay = await backfillDeliveryStatusIndexes();
  assert.equal(replay.done, true);
  assert.equal(replay.processed, 0);
});

test("delivery backfill does not advance its cursor after a detail pipeline failure", async () => {
  values.clear();
  sortedSets.clear();
  const key = deliveryInternals.deliveryKey("legacy:read-fault");
  values.set(key, JSON.stringify({ status: "retryable", at: "2026-01-04T00:00:00.000Z" }));
  failBackfillReadOnce = true;

  const failed = await backfillDeliveryStatusIndexes();
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "delivery_backfill_read_failed");
  assert.equal(values.has(deliveryInternals.DELIVERY_BACKFILL_CURSOR), false);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_RETRYABLE_INDEX).has(key), false);

  const recovered = await backfillDeliveryStatusIndexes();
  assert.equal(recovered.ok, true);
  assert.equal(sortedSet(deliveryInternals.DELIVERY_RETRYABLE_INDEX).has(key), true);
});
