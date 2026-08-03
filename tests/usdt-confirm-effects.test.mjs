import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "http://usdt-effects.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
process.env.TELEGRAM_CHAT_ID = "telegram-chat";

const strings = new Map();
const hashes = new Map();
const zsets = new Map();
const lists = new Map();
let adminLogWrites = 0;
let telegramWrites = 0;
let telegramGate = null;

function hash(key) {
  const value = hashes.get(key) || new Map();
  hashes.set(key, value);
  return value;
}

function zset(key) {
  const value = zsets.get(key) || new Map();
  zsets.set(key, value);
  return value;
}

function executeEval(script, keys, args) {
  if (script.includes("return 'acquired'")) {
    const raw = strings.get(keys[0]);
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
    strings.set(keys[0], args[1]);
    return "acquired";
  }
  if (script.includes("redis.call('SET',KEYS[1],'done')")) {
    const raw = strings.get(keys[0]);
    if (raw === "done") return 1;
    let current = null;
    try { current = JSON.parse(raw || "null"); } catch {}
    if (!current || current.token !== args[0]) return 0;
    strings.set(keys[0], args[2]);
    for (const indexKey of keys.slice(1, 4)) zset(indexKey).delete(args[1]);
    return 1;
  }
  if (script.includes("confirmation_effect_finalize_failed") || script.includes("return 'removed'")) {
    const raw = hash(keys[0]).get(args[0]);
    if (raw == null) {
      zset(keys[1]).delete(args[0]);
      return "missing";
    }
    if (raw !== args[1]) return "changed";
    hash(keys[0]).delete(args[0]);
    zset(keys[1]).delete(args[0]);
    return "removed";
  }
  throw new Error("unexpected EVAL script");
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return strings.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((option) => String(option).toUpperCase()).includes("NX") && strings.has(key)) return null;
    strings.set(key, value);
    return "OK";
  }
  if (name === "HGET") return hash(args[0]).get(args[1]) ?? null;
  if (name === "HSET") {
    hash(args[0]).set(args[1], args[2]);
    return 1;
  }
  if (name === "HDEL") return Number(hash(args[0]).delete(args[1]));
  if (name === "ZADD") {
    zset(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") return Number(zset(args[0]).delete(args[1]));
  if (name === "ZRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    const rows = [...zset(args[0]).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .map(([member]) => member);
    return rows.slice(start, stop < 0 ? undefined : stop + 1);
  }
  if (name === "LPUSH") {
    const values = lists.get(args[0]) || [];
    values.unshift(args[1]);
    lists.set(args[0], values);
    adminLogWrites += 1;
    return values.length;
  }
  if (name === "LTRIM") {
    const values = lists.get(args[0]) || [];
    lists.set(args[0], values.slice(Number(args[1]), Number(args[2]) + 1));
    return "OK";
  }
  if (name === "EVAL") {
    const keyCount = Number(args[1]);
    return executeEval(String(args[0]), args.slice(2, 2 + keyCount), args.slice(2 + keyCount));
  }
  throw new Error(`unhandled Redis command ${name}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://usdt-effects.redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    return Response.json({
      result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)),
    });
  }
  if (url.hostname === "api.telegram.org") {
    telegramWrites += 1;
    if (telegramGate) {
      telegramGate.started();
      await telegramGate.promise;
    }
    return Response.json({ ok: true });
  }
  return originalFetch(input, init);
};

const money = await import("../app/api/_money.js");
const usdt = await import("../app/api/_usdt-confirm.js");
const { deliveryInternals } = await import("../app/api/_delivery-once.js");

function reset() {
  strings.clear();
  hashes.clear();
  zsets.clear();
  lists.clear();
  adminLogWrites = 0;
  telegramWrites = 0;
  telegramGate = null;
}

function seedEffect(orderId = "LM-USDT-EFFECT", txId = "a".repeat(64)) {
  const effectKey = money.usdtConfirmationEffectKey(orderId, txId);
  const effect = {
    version: 1,
    effectKey,
    orderId,
    txId,
    amount: 10.1234,
    amountMicros: "10123400",
    email: "buyer@example.com",
    actor: { staffId: 0, staffUsername: "keeper" },
    confirmedAt: "2026-08-02T01:30:00.000Z",
  };
  hash(money.USDT_CONFIRM_EFFECT_RECORDS_KEY).set(effectKey, JSON.stringify(effect));
  zset(money.USDT_CONFIRM_EFFECT_INDEX_KEY).set(effectKey, Date.parse(effect.confirmedAt));
  return effect;
}

test.after(() => { globalThis.fetch = originalFetch; });

test("a transactionally queued effect recovers after a post-confirmation process crash", async () => {
  reset();
  const effect = seedEffect();

  const first = await usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });
  const second = await usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });

  assert.deepEqual(first, { ok: true, scanned: 1, settled: 1, failed: 0 });
  assert.deepEqual(second, { ok: true, scanned: 0, settled: 0, failed: 0 });
  assert.equal(adminLogWrites, 1);
  assert.equal(telegramWrites, 1);
  assert.equal(hash(money.USDT_CONFIRM_EFFECT_RECORDS_KEY).has(effect.effectKey), false);
  assert.equal(zset(money.USDT_CONFIRM_EFFECT_INDEX_KEY).has(effect.effectKey), false);
  assert.equal(JSON.parse(strings.get(deliveryInternals.deliveryKey(`usdt-confirm:${effect.orderId}:${effect.txId}:admin-log`))).status, "done");
  assert.equal(JSON.parse(strings.get(deliveryInternals.deliveryKey(`usdt-confirm:${effect.orderId}:${effect.txId}:telegram`))).status, "done");
});

test("overlapping scans cannot duplicate an in-flight Telegram or audit effect", async () => {
  reset();
  seedEffect("LM-USDT-OVERLAP", "b".repeat(64));
  let releaseTelegram;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  telegramGate = {
    promise: new Promise((resolve) => { releaseTelegram = resolve; }),
    started: markStarted,
  };

  const firstPromise = usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });
  await started;
  const overlapping = await usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });
  assert.equal(overlapping.ok, false);
  assert.equal(overlapping.failed, 1);
  assert.equal(adminLogWrites, 1);
  assert.equal(telegramWrites, 1);

  releaseTelegram();
  const first = await firstPromise;
  telegramGate = null;
  const replay = await usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });
  assert.equal(first.ok, true);
  assert.equal(replay.scanned, 0);
  assert.equal(adminLogWrites, 1);
  assert.equal(telegramWrites, 1);
});

test("an idempotent confirmation is not counted fresh and resumes only its unfinished effect", async () => {
  reset();
  const effect = seedEffect("LM-USDT-IDEMPOTENT", "c".repeat(64));
  const prefix = `usdt-confirm:${effect.orderId}:${effect.txId}`;
  strings.set(deliveryInternals.deliveryKey(`${prefix}:admin-log`), "done");

  assert.equal(usdt.isFreshUsdtConfirmation({ ok: true, idempotent: true }), false);
  assert.equal(usdt.isFreshUsdtConfirmation({ ok: true }), true);
  const recovered = await usdt.drainUsdtConfirmationEffects({ settings: { notify: { telegramEnabled: true } } });

  assert.equal(recovered.ok, true);
  assert.equal(adminLogWrites, 0);
  assert.equal(telegramWrites, 1);
  assert.equal(hash(money.USDT_CONFIRM_EFFECT_RECORDS_KEY).has(effect.effectKey), false);
});
