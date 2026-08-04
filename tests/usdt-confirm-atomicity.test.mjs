import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://usdt.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const money = await import("../app/api/_money.js");
const usdtConfirm = await import("../app/api/_usdt-confirm.js");

const RECORD_PREFIX = "liumeiti:orders:record:";
const CLAIM_PREFIX = "lm:usdt:confirmed-tx:";
const OP_PREFIX = "liumeiti:money:op:";
const PENDING_KEY = "liumeiti:orders:usdt-pending";
const QUOTE_EXPIRY_KEY = "liumeiti:orders:quote-expiry";
const OVERVIEW_KEY = "liumeiti:orders:overview";
const SUMMARY_KEY = "liumeiti:orders:summary-created";
const LIST_REVISION_KEY = "liumeiti:orders:list-revision";
const EFFECT_RECORDS_KEY = money.USDT_CONFIRM_EFFECT_RECORDS_KEY;
const EFFECT_INDEX_KEY = money.USDT_CONFIRM_EFFECT_INDEX_KEY;

function sampleOrder(orderId, overrides = {}) {
  return {
    orderId,
    revision: 0,
    status: "received",
    paymentMethod: "usdt",
    paidCurrency: "USDT",
    usdtPayAmount: 10.1234,
    usdtQuoteId: `QUOTE-${orderId}`,
    paymentQuoteIssuedAt: "2026-08-02T01:00:00.000Z",
    paymentQuoteExpiresAt: "2026-08-02T02:00:00.000Z",
    createdAt: "2026-08-02T00:30:00.000Z",
    email: `${orderId.toLowerCase()}@example.com`,
    items: [],
    ...overrides,
  };
}

function sampleTransaction(txId, overrides = {}) {
  return {
    txId,
    micros: 10_123_400n,
    amount: 10.1234,
    ts: Date.parse("2026-08-02T01:30:00.000Z"),
    ...overrides,
  };
}

class UsdtRedisMock {
  constructor() {
    this.strings = new Map();
    this.hashes = new Map();
    this.zsets = new Map();
    this.expirations = new Map();
    this.evalCalls = [];
    this.dropNextEvalResponse = false;
  }

  seedOrder(order) {
    const id = order.orderId.toUpperCase();
    this.strings.set(RECORD_PREFIX + id, JSON.stringify(order));
    this.strings.set(LIST_REVISION_KEY, "7");
    this.zadd(PENDING_KEY, Date.parse(order.createdAt), id);
    this.zadd(QUOTE_EXPIRY_KEY, Date.parse(order.paymentQuoteExpiresAt), id);
    this.zadd(SUMMARY_KEY, Date.parse(order.createdAt), id);
    this.hset(OVERVIEW_KEY, id, JSON.stringify({
      orderId: id,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paidCurrency: order.paidCurrency,
      usdtConfirmedAt: "",
      usdtTxId: "",
      items: [],
    }));
  }

  zadd(key, score, member) {
    const zset = this.zsets.get(key) || new Map();
    zset.set(member, Number(score));
    this.zsets.set(key, zset);
  }

  zrem(key, member) {
    return Number(this.zsets.get(key)?.delete(member) || false);
  }

  hset(key, field, value) {
    const hash = this.hashes.get(key) || new Map();
    hash.set(field, value);
    this.hashes.set(key, hash);
  }

  existingOperation(opKey, requestHash) {
    const raw = this.strings.get(opKey);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
    const result = typeof record.resultJson === "string" ? JSON.parse(record.resultJson) : record.result;
    return { ...result, idempotent: true };
  }

  eval(command) {
    const script = command[1];
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    this.evalCalls.push({ script, keys, args });
    assert.match(script, /USDT confirmation commit/);

    const prior = this.existingOperation(keys[0], args[0]);
    if (prior) return prior;

    const currentRaw = this.strings.get(keys[2]);
    if (!currentRaw) return { ok: false, error: "order_not_found" };
    if (currentRaw !== args[3]) return { ok: false, error: "stale_order" };
    const current = JSON.parse(currentRaw);
    const next = JSON.parse(args[5]);
    if (current.orderId !== args[1] || next.orderId !== args[1]) return { ok: false, error: "invalid_order_record" };
    if (Number(current.revision || 0) !== Number(args[4])) return { ok: false, error: "stale_revision" };
    if (Number(next.revision) !== Number(current.revision || 0) + 1) return { ok: false, error: "invalid_order_revision" };
    if (current.status !== "received" || current.paidCurrency !== "USDT") return { ok: false, error: "order_not_confirmable" };
    if (current.usdtConfirmedAt || current.usdtTxId) return { ok: false, error: "order_already_confirmed" };
    if (Number(args[12]) !== Number(args[13])) return { ok: false, error: "transaction_amount_mismatch" };
    if (Number(args[14]) < Number(args[15]) || Number(args[14]) > Number(args[16])) {
      return { ok: false, error: "transaction_outside_quote_window" };
    }
    const claimed = this.strings.get(keys[1]);
    if (claimed && claimed !== args[1]) return { ok: false, error: "tx_already_claimed", claimedOrderId: claimed };

    const overviewRaw = this.hashes.get(keys[5])?.get(args[1]) || args[6];
    const overview = JSON.parse(overviewRaw);
    Object.assign(overview, {
      status: next.status,
      paymentMethod: next.paymentMethod,
      paidCurrency: next.paidCurrency,
      usdtConfirmedAt: args[9],
      usdtTxId: args[2],
    });

    // This mirrors the mutation boundary of the production Lua script.
    this.strings.set(keys[1], args[1]);
    this.expirations.delete(keys[1]);
    this.strings.set(keys[2], args[5]);
    this.zrem(keys[3], args[1]);
    this.zrem(keys[4], args[1]);
    this.hset(keys[5], args[1], JSON.stringify(overview));
    this.zadd(keys[6], Number(args[7]), args[1]);
    this.strings.set(keys[7], String(Number(this.strings.get(keys[7]) || 0) + 1));
    this.hset(keys[8], args[17], args[18]);
    this.zadd(keys[9], Number(args[19]), args[17]);
    this.strings.set(keys[0], JSON.stringify({ requestHash: args[0], resultJson: args[8] }));
    this.expirations.delete(keys[0]);
    return JSON.parse(args[8]);
  }

  command(command) {
    const [name, ...args] = command;
    if (name === "GET") return this.strings.get(args[0]) ?? null;
    if (name === "HGET") return this.hashes.get(args[0])?.get(args[1]) ?? null;
    throw new Error(`unhandled mock command ${name}`);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      const rows = commands.map((command) => ({ result: JSON.stringify(this.eval(command)) }));
      if (this.dropNextEvalResponse) {
        this.dropNextEvalResponse = false;
        return new Response("upstream timeout", { status: 504 });
      }
      return Response.json(rows);
    }
    const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
    return Response.json({ result: this.command(command) });
  };
}

async function withFetch(fetchImpl, callback) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  try { return await callback(); } finally { global.fetch = original; }
}

test("chain normalization requires an identified USDT contract and its fixed decimals", () => {
  const receivingAddress = "TReceiver";
  const row = {
    transaction_id: "a".repeat(64),
    to: receivingAddress,
    value: "1000000",
    block_timestamp: Date.parse("2026-08-02T01:30:00.000Z"),
  };
  const normalize = (tokenInfo) => usdtConfirm.normalizeConfirmedUsdtTransfers({
    data: [{ ...row, ...(tokenInfo === undefined ? {} : { token_info: tokenInfo }) }],
  }, receivingAddress);

  assert.equal(normalize(undefined).length, 0);
  assert.equal(normalize({ decimals: 6 }).length, 0);
  assert.equal(normalize({ address: "", decimals: 6 }).length, 0);
  assert.equal(normalize({ address: "TWrongToken", decimals: 6 }).length, 0);
  assert.equal(normalize({ address: usdtConfirm.USDT_TRC20_CONTRACT }).length, 0);
  assert.equal(normalize({ address: usdtConfirm.USDT_TRC20_CONTRACT, decimals: 5 }).length, 0);
  assert.equal(normalize({ address: usdtConfirm.USDT_TRC20_CONTRACT, decimals: 6 }).length, 1);
  assert.equal(normalize({ contract_address: usdtConfirm.USDT_TRC20_CONTRACT, decimals: "6" })[0].amount, 1);
});

test("one chain transaction cannot confirm two different orders", async () => {
  const redis = new UsdtRedisMock();
  const orderA = sampleOrder("LM-USDT-A");
  const orderB = sampleOrder("LM-USDT-B", { usdtQuoteId: "QUOTE-B" });
  const tx = sampleTransaction("a".repeat(64));
  redis.seedOrder(orderA);
  redis.seedOrder(orderB);

  const results = await withFetch(redis.fetch, () => Promise.all([
    money.confirmUsdtOrderAtomic({ order: orderA, transaction: tx }),
    money.confirmUsdtOrderAtomic({ order: orderB, transaction: tx }),
  ]));

  assert.equal(results.filter((result) => result.ok).length, 1);
  const owner = redis.strings.get(CLAIM_PREFIX + tx.txId);
  assert.ok([orderA.orderId, orderB.orderId].includes(owner));
  const stored = [orderA, orderB].map((order) => JSON.parse(redis.strings.get(RECORD_PREFIX + order.orderId)));
  assert.equal(stored.filter((order) => order.usdtTxId === tx.txId).length, 1);
  assert.equal(stored.find((order) => order.usdtTxId === tx.txId).orderId, owner);
  assert.equal(redis.expirations.has(CLAIM_PREFIX + tx.txId), false);
});

test("two chain transactions cannot both confirm the same order", async () => {
  const redis = new UsdtRedisMock();
  const order = sampleOrder("LM-USDT-ONE-ORDER");
  const txA = sampleTransaction("b".repeat(64));
  const txB = sampleTransaction("c".repeat(64));
  redis.seedOrder(order);

  const results = await withFetch(redis.fetch, () => Promise.all([
    money.confirmUsdtOrderAtomic({ order, transaction: txA }),
    money.confirmUsdtOrderAtomic({ order, transaction: txB }),
  ]));

  assert.equal(results.filter((result) => result.ok).length, 1);
  const stored = JSON.parse(redis.strings.get(RECORD_PREFIX + order.orderId));
  assert.ok([txA.txId, txB.txId].includes(stored.usdtTxId));
  const claims = [txA, txB].filter((tx) => redis.strings.has(CLAIM_PREFIX + tx.txId));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].txId, stored.usdtTxId);
});

test("a dropped commit response is recovered from the permanent operation record", async () => {
  const redis = new UsdtRedisMock();
  const order = sampleOrder("LM-USDT-RECOVER");
  const tx = sampleTransaction("d".repeat(64));
  redis.seedOrder(order);
  redis.dropNextEvalResponse = true;

  const result = await withFetch(redis.fetch, () => money.confirmUsdtOrderAtomic({ order, transaction: tx }));
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.idempotent, true);

  const stored = JSON.parse(redis.strings.get(RECORD_PREFIX + order.orderId));
  assert.equal(stored.revision, 1);
  assert.equal(stored.usdtTxId, tx.txId);
  assert.equal(redis.strings.get(CLAIM_PREFIX + tx.txId), order.orderId);
  assert.equal(redis.zsets.get(EFFECT_INDEX_KEY).has(result.effect.effectKey), true);
  assert.deepEqual(JSON.parse(redis.hashes.get(EFFECT_RECORDS_KEY).get(result.effect.effectKey)), result.effect);
  assert.equal(redis.zsets.get(PENDING_KEY).has(order.orderId), false);
  assert.equal(redis.zsets.get(QUOTE_EXPIRY_KEY).has(order.orderId), false);
  assert.equal(redis.zsets.get(SUMMARY_KEY).has(order.orderId), true);
  assert.equal(redis.strings.get(LIST_REVISION_KEY), "8");
  const overview = JSON.parse(redis.hashes.get(OVERVIEW_KEY).get(order.orderId));
  assert.equal(overview.usdtTxId, tx.txId);
  assert.equal(overview.usdtConfirmedAt, stored.usdtConfirmedAt);
  const operationKeys = [...redis.strings.keys()].filter((key) => key.startsWith(OP_PREFIX));
  assert.equal(operationKeys.length, 1);
  assert.equal(redis.expirations.has(operationKeys[0]), false);

  const retry = await withFetch(redis.fetch, () => money.confirmUsdtOrderAtomic({ order, transaction: tx }));
  assert.equal(retry.ok, true);
  assert.equal(retry.recovered, true);
  assert.equal(retry.idempotent, true);
  assert.equal(JSON.parse(redis.strings.get(RECORD_PREFIX + order.orderId)).revision, 1);
});

test("amount and quote-window mismatches cannot mutate a pending order", async () => {
  const redis = new UsdtRedisMock();
  const order = sampleOrder("LM-USDT-MISMATCH");
  redis.seedOrder(order);
  const before = redis.strings.get(RECORD_PREFIX + order.orderId);

  const amountResult = await withFetch(redis.fetch, () => money.confirmUsdtOrderAtomic({
    order,
    transaction: sampleTransaction("e".repeat(64), { micros: 10_123_401n }),
  }));
  const timeResult = await withFetch(redis.fetch, () => money.confirmUsdtOrderAtomic({
    order,
    transaction: sampleTransaction("f".repeat(64), { ts: Date.parse("2026-08-03T01:30:00.000Z") }),
  }));

  assert.equal(amountResult.error, "transaction_amount_mismatch");
  assert.equal(timeResult.error, "transaction_outside_quote_window");
  assert.equal(redis.strings.get(RECORD_PREFIX + order.orderId), before);
  assert.equal([...redis.strings.keys()].some((key) => key.startsWith(CLAIM_PREFIX)), false);
});

test("the scan lock is only an optimization and the route performs no separate transaction claim write", async () => {
  const source = await readFile(new URL("../app/api/_usdt-confirm.js", import.meta.url), "utf8");
  assert.match(source, /short lock only avoids duplicate scans/);
  assert.match(source, /confirmUsdtOrderAtomic/);
  assert.doesNotMatch(source, /TX_CLAIM_TTL_SECONDS/);
  assert.doesNotMatch(source, /redisCmd\(\[\s*["']SET["']\s*,\s*claimKey/);
});

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...options });
}

function realRedisFetch(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

test("real Redis executes the Lua boundary atomically and keeps claim/op records permanent", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 to run the Docker-backed integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-usdt-atomic-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedisFetch(container);
    const order = sampleOrder("LM-USDT-REAL");
    const txA = sampleTransaction("1".repeat(64));
    const txB = sampleTransaction("2".repeat(64));
    redis.run(["SET", RECORD_PREFIX + order.orderId, JSON.stringify(order)]);
    redis.run(["SET", LIST_REVISION_KEY, "12"]);
    redis.run(["ZADD", PENDING_KEY, String(Date.parse(order.createdAt)), order.orderId]);
    redis.run(["HSET", OVERVIEW_KEY, order.orderId, JSON.stringify({ orderId: order.orderId, status: "received", items: [] })]);

    const results = await withFetch(redis.fetch, () => Promise.all([
      money.confirmUsdtOrderAtomic({ order, transaction: txA }),
      money.confirmUsdtOrderAtomic({ order, transaction: txB }),
    ]));
    assert.equal(results.filter((result) => result.ok).length, 1);
    const stored = JSON.parse(redis.run(["GET", RECORD_PREFIX + order.orderId]));
    assert.ok([txA.txId, txB.txId].includes(stored.usdtTxId));
    assert.equal(redis.run(["GET", CLAIM_PREFIX + stored.usdtTxId]), order.orderId);
    assert.equal(redis.run(["TTL", CLAIM_PREFIX + stored.usdtTxId]), -1);
    const committedEffect = results.find((result) => result.ok).effect;
    assert.deepEqual(JSON.parse(redis.run(["HGET", EFFECT_RECORDS_KEY, committedEffect.effectKey])), committedEffect);
    assert.equal(redis.run(["ZSCORE", EFFECT_INDEX_KEY, committedEffect.effectKey]) !== null, true);
    assert.equal(redis.run(["ZSCORE", PENDING_KEY, order.orderId]), null);
    assert.equal(redis.run(["HGET", OVERVIEW_KEY, order.orderId]) !== null, true);

    const orderA = sampleOrder("LM-USDT-REAL-A");
    const orderB = sampleOrder("LM-USDT-REAL-B");
    const sharedTx = sampleTransaction("3".repeat(64));
    for (const candidate of [orderA, orderB]) {
      redis.run(["SET", RECORD_PREFIX + candidate.orderId, JSON.stringify(candidate)]);
      redis.run(["ZADD", PENDING_KEY, String(Date.parse(candidate.createdAt)), candidate.orderId]);
      redis.run(["HSET", OVERVIEW_KEY, candidate.orderId, JSON.stringify({ orderId: candidate.orderId, status: "received", items: [] })]);
    }
    const sharedResults = await withFetch(redis.fetch, () => Promise.all([
      money.confirmUsdtOrderAtomic({ order: orderA, transaction: sharedTx }),
      money.confirmUsdtOrderAtomic({ order: orderB, transaction: sharedTx }),
    ]));
    assert.equal(sharedResults.filter((result) => result.ok).length, 1);
    const sharedOwner = redis.run(["GET", CLAIM_PREFIX + sharedTx.txId]);
    assert.ok([orderA.orderId, orderB.orderId].includes(sharedOwner));
    assert.equal([orderA, orderB].map((candidate) => JSON.parse(
      redis.run(["GET", RECORD_PREFIX + candidate.orderId]),
    )).filter((candidate) => candidate.usdtTxId === sharedTx.txId).length, 1);
    assert.equal(redis.run(["TTL", CLAIM_PREFIX + sharedTx.txId]), -1);

    const recoveryOrder = sampleOrder("LM-USDT-REAL-RECOVERY");
    const recoveryTx = sampleTransaction("4".repeat(64));
    redis.run(["SET", RECORD_PREFIX + recoveryOrder.orderId, JSON.stringify(recoveryOrder)]);
    redis.run(["ZADD", PENDING_KEY, String(Date.parse(recoveryOrder.createdAt)), recoveryOrder.orderId]);
    redis.run(["HSET", OVERVIEW_KEY, recoveryOrder.orderId, JSON.stringify({ orderId: recoveryOrder.orderId, status: "received", items: [] })]);
    let dropCommitResponse = true;
    const lossyFetch = async (input, init) => {
      const response = await redis.fetch(input, init);
      if (dropCommitResponse && new URL(String(input)).pathname === "/pipeline") {
        dropCommitResponse = false;
        return new Response("upstream timeout", { status: 504 });
      }
      return response;
    };
    const recovered = await withFetch(lossyFetch, () => money.confirmUsdtOrderAtomic({
      order: recoveryOrder,
      transaction: recoveryTx,
    }));
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    assert.equal(JSON.parse(redis.run(["GET", RECORD_PREFIX + recoveryOrder.orderId])).usdtTxId, recoveryTx.txId);

    const operationKeys = redis.run(["KEYS", OP_PREFIX + "*"]);
    assert.equal(operationKeys.length, 3);
    for (const operationKey of operationKeys) assert.equal(redis.run(["TTL", operationKey]), -1);
  } finally {
    docker(["rm", "-f", container]);
  }
});
