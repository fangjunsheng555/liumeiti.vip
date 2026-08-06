import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "http://transition.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
const lists = new Map();
const sets = new Map();
const sortedSets = new Map();
let failNextStockHttp = false;
let balanceEffectCalls = 0;

function list(key) {
  if (!lists.has(key)) lists.set(key, []);
  return lists.get(key);
}

function setValue(key) {
  if (!sets.has(key)) sets.set(key, new Set());
  return sets.get(key);
}

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function priorOperation(key, requestHash) {
  const raw = values.get(key);
  if (!raw) return null;
  const operation = JSON.parse(raw);
  if (operation.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
  return { ...operation.result, idempotent: true };
}

function saveOperation(key, requestHash, result) {
  values.set(key, JSON.stringify({ requestHash, result }));
  return result;
}

function evalOrderCas(keys, args) {
  const absent = "__LM_ORDER_RECORD_ABSENT__";
  const currentRaw = values.get(keys[0]) ?? null;
  const expectedRaw = args[0] === absent ? null : args[0];
  if (currentRaw !== expectedRaw) return { ok: false, error: "stale_order" };
  const order = JSON.parse(args[3]);
  const expectedRevision = Number(args[18]);
  const existing = args[19] === "1";
  const current = currentRaw ? JSON.parse(currentRaw) : null;
  if (existing && Number(current?.revision || 0) !== expectedRevision) return { ok: false, error: "stale_order" };
  if (Number(order.revision) !== (existing ? expectedRevision + 1 : 1)) return { ok: false, error: "invalid_order_revision" };
  values.set(keys[0], args[3]);
  if (!setValue(keys[15]).has(args[4])) {
    setValue(keys[15]).add(args[4]);
    list(keys[1]).push(args[4]);
  }
  return { ok: true };
}

function evalStock(keys, args) {
  const prior = priorOperation(keys[0], args[0]);
  if (prior) return prior;
  const specs = JSON.parse(args[1]);
  const changes = [];
  const limited = {};
  for (const spec of specs) {
    const key = keys[Number(spec.slot) - 1];
    if (!values.has(key)) continue;
    const before = Number(values.get(key));
    const after = before + Number(spec.delta);
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after)) {
      return { ok: false, error: "invalid_stock_record", name: spec.name };
    }
    if (after < 0) return { ok: false, error: "out_of_stock", name: spec.name, remaining: before };
    changes.push([key, after]);
    limited[spec.name] = true;
  }
  for (const [key, value] of changes) values.set(key, String(value));
  return saveOperation(keys[0], args[0], { ok: true, changedCount: changes.length, limited });
}

function evalCoupon(keys, args) {
  if (values.get(keys[3]) !== args[6]) return { ok: false, error: "account_lifecycle_changed" };
  const prior = priorOperation(keys[0], args[0]);
  if (prior) return prior;
  const raw = values.get(keys[1]);
  if (!raw) return { ok: false, error: "user_not_found" };
  if (raw !== args[7]) return { ok: false, error: "storage_conflict" };
  const user = JSON.parse(raw);
  const coupon = (user.coupons || []).find((item) => String(item.id || "") === args[1]);
  if (!coupon) return { ok: false, error: "coupon_not_found" };
  let changed = false;
  if (args[3] === "used") {
    if (coupon.status === "active") {
      changed = true;
    } else if (coupon.status !== "used" || coupon.usedOrderId !== args[2]) {
      return { ok: false, error: "coupon_unavailable" };
    }
  } else if (args[3] === "active") {
    if (coupon.status === "used" && coupon.usedOrderId === args[2]) {
      changed = true;
    } else if (coupon.status !== "active") {
      return { ok: false, error: "coupon_owner_mismatch" };
    }
  } else {
    return { ok: false, error: "invalid_coupon_transition" };
  }
  const nextUser = JSON.parse(args[8]);
  const nextCoupon = (nextUser.coupons || []).find((item) => String(item.id || "") === args[1]);
  const response = JSON.parse(args[9]);
  if (!nextCoupon || response.changed !== changed) return { ok: false, error: "invalid_user_record" };
  values.set(keys[1], args[8]);
  return saveOperation(keys[0], args[0], response);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((item) => String(item).toUpperCase()).includes("NX") && values.has(key)) return null;
    values.set(key, value);
    return "OK";
  }
  if (name === "LRANGE") {
    const rows = list(args[0]);
    return rows.slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
  }
  if (name === "SADD") {
    let added = 0;
    for (const member of args.slice(1)) if (!setValue(args[0]).has(member)) { setValue(args[0]).add(member); added += 1; }
    return added;
  }
  if (name === "ZADD") {
    const target = sortedSet(args[0]);
    const existed = target.has(args[2]);
    target.set(args[2], Number(args[1]));
    return existed ? 0 : 1;
  }
  if (name === "ZREM") {
    let removed = 0;
    for (const member of args.slice(1)) if (sortedSet(args[0]).delete(member)) removed += 1;
    return removed;
  }
  if (name === "ZRANGEBYSCORE") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    const offset = String(args[3] || "").toUpperCase() === "LIMIT" ? Number(args[4]) : 0;
    const count = String(args[3] || "").toUpperCase() === "LIMIT" ? Number(args[5]) : Infinity;
    return [...sortedSet(args[0]).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("No command below can fail after the complete read/validation phase")) return JSON.stringify(evalOrderCas(keys, argv));
    if (script.includes("changedCount=#changes")) return JSON.stringify(evalStock(keys, argv));
    if (script.includes("invalid_coupon_transition")) return JSON.stringify(evalCoupon(keys, argv));
    if (script.includes("local referralDelta")) { balanceEffectCalls += 1; throw new Error("balance effect must not run after coupon conflict"); }
  }
  throw new Error(`unhandled Redis command ${name}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://transition.redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    if (failNextStockHttp && commands[0]?.[0] === "EVAL" && String(commands[0][1]).includes("changedCount=#changes")) {
      failNextStockHttp = false;
      return new Response("temporary failure", { status: 503 });
    }
    return Response.json(commands.map((command) => {
      try { return { result: execute(command) }; } catch (error) { return { error: error.message }; }
    }));
  }
  return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
};

const transitions = await import("../app/api/_order-transition.js");
const money = await import("../app/api/_money.js");

test.after(() => { globalThis.fetch = originalFetch; });

function seed(order, stock = null) {
  values.clear(); lists.clear(); sets.clear(); sortedSets.clear();
  failNextStockHttp = false;
  balanceEffectCalls = 0;
  const orderId = order.orderId;
  values.set(`liumeiti:orders:record:${orderId}`, JSON.stringify(order));
  values.set("liumeiti:orders:index:members:ready:v1", "1");
  list("liumeiti:orders:index").push(orderId);
  setValue("liumeiti:orders:index:members").add(orderId);
  if (stock != null) values.set("liumeiti:stock:svc:plan", String(stock));
  return { index: { orderId, legacyIndex: null }, order: structuredClone(order) };
}

function storedOrder(orderId) {
  return JSON.parse(values.get(`liumeiti:orders:record:${orderId}`));
}

test("out of stock aborts a prepared transition and removes its recovery member", async () => {
  const entry = seed({
    orderId: "LMTRANSOUT", revision: 1, status: "invalid", createdAt: new Date().toISOString(),
    items: [{ service: "svc", plan: "plan", stockReservationReleased: true }],
  }, 0);
  const target = { ...entry.order, status: "received" };
  const result = await transitions.beginOrderTransition(entry, target, {
    reserveStock: [{ index: 0, service: "svc", plan: "plan" }],
  }, { mutationId: "reactivate-out", mutationHash: "hash" });
  assert.equal(result.aborted, true);
  const stored = storedOrder(entry.order.orderId);
  assert.equal(stored.status, "invalid");
  assert.equal(stored.pendingTransition, undefined);
  assert.equal(stored.transitionHistory[0].outcome, "aborted");
  assert.equal(sortedSet("liumeiti:orders:pending-transitions:v1").has(entry.order.orderId), false);
  assert.equal(values.get("liumeiti:stock:svc:plan"), "0");
});

test("a transient effect failure is indexed and the keeper resume completes it once", async () => {
  const entry = seed({
    orderId: "LMTRANSRETRY", revision: 3, status: "invalid", createdAt: new Date().toISOString(),
    items: [{ service: "svc", plan: "plan", stockReservationReleased: true }],
  }, 1);
  failNextStockHttp = true;
  const first = await transitions.beginOrderTransition(entry, { ...entry.order, status: "received" }, {
    reserveStock: [{ index: 0, service: "svc", plan: "plan" }],
  }, { mutationId: "reactivate-retry", mutationHash: "hash" });
  assert.equal(first.pending, true);
  assert.equal(storedOrder(entry.order.orderId).pendingTransition.attempts, 1);
  assert.equal(values.get("liumeiti:stock:svc:plan"), "1");

  const resumed = await transitions.resumeDueOrderTransitions({ now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal(resumed.completed, 1);
  const stored = storedOrder(entry.order.orderId);
  assert.equal(stored.status, "received");
  assert.equal(stored.pendingTransition, undefined);
  assert.equal(values.get("liumeiti:stock:svc:plan"), "0");
  assert.equal(sortedSet("liumeiti:orders:pending-transitions:v1").has(entry.order.orderId), false);
});

test("coupon refund removes adjacent tail metadata without rewriting a legacy user profile", async () => {
  const accountLifecycleId = "f".repeat(32);
  const orderId = "LMCOUPONTAILREFUND";
  const entry = seed({
    orderId,
    revision: 8,
    status: "received",
    createdAt: new Date().toISOString(),
    userEmail: "legacy-coupon@example.com",
    accountLifecycleId,
    paymentMethod: "alipay",
    paidByBalance: false,
    finalAmount: 159.11,
    couponId: "CP-LEGACY-TAIL",
    items: [{ service: "netflix", plan: "solo" }],
  });
  const userKey = "liumeiti:users:legacy-coupon@example.com";
  const before = "{\n"
    + "  \"email\": \"legacy-coupon@example.com\",\n"
    + "  \"balance\": 0,\n"
    + "  \"withdrawals\": [],\n"
    + "  \"nullable\": null,\n"
    + "  \"legacyCounter\": 900719925474099312345,\n"
    + "  \"coupons\": [{\"id\":\"CP-LEGACY-TAIL\",\"status\":\"used\",\"usedOrderId\":\"LMCOUPONTAILREFUND\",\"discount\":9.89,\"usedAt\":\"2026-08-06T00:00:00.000Z\",\"usedAtBeijing\":\"2026-08-06 08:00:00\"}]\n"
    + "}";
  const expected = before
    .replace("\"status\":\"used\",\"usedOrderId\":\"LMCOUPONTAILREFUND\",\"discount\":9.89,\"usedAt\":\"2026-08-06T00:00:00.000Z\",\"usedAtBeijing\":\"2026-08-06 08:00:00\"", "\"status\":\"active\"");
  values.set(userKey, before);
  values.set("lm:user:lifecycle:legacy-coupon@example.com", accountLifecycleId);

  const result = await transitions.beginOrderTransition(entry, { ...entry.order, status: "invalid" }, {
    refund: true,
  }, { mutationId: "invalidate-coupon-tail", mutationHash: "hash" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(values.get(userKey), expected, "only the coupon status and used metadata may change");
  assert.match(values.get(userKey), /900719925474099312345/);
  assert.match(values.get(userKey), /\"withdrawals\": \[\]/);
  assert.match(values.get(userKey), /\"nullable\": null/);
  const stored = storedOrder(orderId);
  assert.equal(stored.status, "invalid");
  assert.equal(stored.pendingTransition, undefined);
  assert.equal(stored.refund.coupon, true);
  assert.equal(stored.refund.balance, 0);

  const retry = await money.transitionOrderCouponAtomic(
    "legacy-coupon@example.com",
    "CP-LEGACY-TAIL",
    orderId,
    "active",
    `coupon-refund:${orderId}:cycle:1`,
    accountLifecycleId,
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal(values.get(userKey), expected);
});

test("coupon conflict compensates reserved stock and never reclaims balance", async () => {
  const accountLifecycleId = "a".repeat(32);
  const entry = seed({
    orderId: "LMTRANSCOUPON", revision: 2, status: "invalid", createdAt: new Date().toISOString(),
    userEmail: "buyer@example.com", accountLifecycleId, paidByBalance: true, finalAmount: 25,
    couponId: "CP1", refundedAt: new Date().toISOString(), refundCycle: 1,
    refund: { balance: 25, coupon: true },
    items: [{ service: "svc", plan: "plan", stockReservationReleased: true }],
  }, 1);
  values.set("liumeiti:users:buyer@example.com", JSON.stringify({
    email: "buyer@example.com",
    coupons: [{ id: "CP1", status: "used", usedOrderId: "SOMEONE-ELSE" }],
  }));
  values.set("lm:user:lifecycle:buyer@example.com", accountLifecycleId);
  values.set("liumeiti:users:buyer@example.com:balance-cents", "2500");

  const result = await transitions.beginOrderTransition(entry, { ...entry.order, status: "received" }, {
    reserveStock: [{ index: 0, service: "svc", plan: "plan" }],
    reclaim: true,
  }, { mutationId: "reactivate-coupon", mutationHash: "hash" });
  assert.equal(result.aborted, true);
  assert.equal(result.error, "coupon_unavailable");
  assert.equal(values.get("liumeiti:stock:svc:plan"), "1", "reserved stock must be restored");
  assert.equal(values.get("liumeiti:users:buyer@example.com:balance-cents"), "2500");
  assert.equal(balanceEffectCalls, 0);
  assert.equal(storedOrder(entry.order.orderId).status, "invalid");
});
