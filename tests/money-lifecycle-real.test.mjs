import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "https://redis.money-lifecycle.test";
process.env.KV_REST_API_TOKEN = "test-token";

const money = await import("../app/api/_money.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function realRedis(container) {
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
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("real Redis money commits validate auth version and lifecycle before side effects", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-money-lifecycle-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;
    const lifecycle = "a".repeat(32);
    for (const [email, balance] of [["a@example.com", 200], ["b@example.com", 0]]) {
      redis.run(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, balance, banned: false })]);
      redis.run(["SET", `liumeiti:users:${email}:balance:cents`, String(balance * 100)]);
    }
    redis.run(["SET", "lm:user:authver:a@example.com", "1"]);
    redis.run(["SET", "lm:user:lifecycle:a@example.com", lifecycle]);

    const normalA = JSON.stringify({ email: "a@example.com", balance: 200, banned: false });
    const deepLegacy = `{"email":"a@example.com","balance":200,"banned":false,"legacy":${"{\"v\":".repeat(998)}null${"}".repeat(998)}}`;
    redis.run(["SET", "liumeiti:users:a@example.com", deepLegacy]);
    const deepOperationId = "real-transfer-deep-json";
    const deepRejected = await money.transferBalanceAtomic("a@example.com", "b@example.com", 1, {
      operationId: deepOperationId, authVersion: 1, accountLifecycleId: lifecycle,
    });
    assert.equal(deepRejected.error, "invalid_user_record");
    assert.equal(redis.run(["GET", money.balanceCentsKey("a@example.com")]), "20000");
    assert.equal(redis.run(["GET", money.balanceCentsKey("b@example.com")]), "0");
    assert.equal(redis.run(["EXISTS", money.moneyKeys.operationKey(`transfer:a@example.com:${lifecycle}`, deepOperationId)]), 0);
    redis.run(["SET", "liumeiti:users:a@example.com", normalA]);

    const first = await money.transferBalanceAtomic("a@example.com", "b@example.com", 25, {
      operationId: "real-transfer-01", authVersion: 1, accountLifecycleId: lifecycle,
    });
    assert.equal(first.ok, true);
    redis.run(["SET", "lm:user:authver:a@example.com", "2"]);
    const stale = await money.createWithdrawalAtomic("a@example.com", 10, "ali", "Buyer", {
      operationId: "real-withdraw-stale", authVersion: 1, accountLifecycleId: lifecycle,
    });
    assert.equal(stale.error, "session_state_changed");
    const replay = await money.transferBalanceAtomic("a@example.com", "b@example.com", 25, {
      operationId: "real-transfer-01", authVersion: 2, accountLifecycleId: lifecycle,
    });
    assert.equal(replay.idempotent, true);

    const legacyRedeemRaw = '{"code":"REALCODE1","status":"active","type":"balance","amount":10,"legacyEmpty":[],"legacyNull":null,"legacyHuge":123456789012345678901234567890}';
    redis.run(["SET", "liumeiti:redeem-code:REALCODE1", legacyRedeemRaw]);
    const redeemed = await money.redeemBalanceCodeAtomic("a@example.com", "REALCODE1", {}, {
      operationId: "real-redeem-01", authVersion: 2, accountLifecycleId: lifecycle,
    });
    assert.equal(redeemed.ok, true);
    const redeemedRaw = redis.run(["GET", "liumeiti:redeem-code:REALCODE1"]);
    assert.match(redeemedRaw, /"legacyEmpty":\[\]/);
    assert.match(redeemedRaw, /"legacyNull":null/);
    assert.match(redeemedRaw, /"legacyHuge":123456789012345678901234567890/);

    const concurrentRaw = '{"code":"REALCODE2","status":"active","type":"balance","amount":7,"legacyEmpty":[],"legacyHuge":123456789012345678901234567890}';
    redis.run(["SET", "liumeiti:redeem-code:REALCODE2", concurrentRaw]);
    const balanceBeforeRace = Number(redis.run(["GET", money.balanceCentsKey("a@example.com")]));
    const raced = await Promise.all([
      money.redeemBalanceCodeAtomic("a@example.com", "REALCODE2", {}, { operationId: "real-redeem-race-a", authVersion: 2, accountLifecycleId: lifecycle }),
      money.redeemBalanceCodeAtomic("a@example.com", "REALCODE2", {}, { operationId: "real-redeem-race-b", authVersion: 2, accountLifecycleId: lifecycle }),
    ]);
    assert.equal(raced.filter((item) => item.ok).length, 1);
    assert.equal(Number(redis.run(["GET", money.balanceCentsKey("a@example.com")])), balanceBeforeRace + 700);
    const racedRaw = redis.run(["GET", "liumeiti:redeem-code:REALCODE2"]);
    assert.match(racedRaw, /"status":"used"/);
    assert.match(racedRaw, /"legacyEmpty":\[\]/);
    assert.match(racedRaw, /"legacyHuge":123456789012345678901234567890/);
    const withdrawn = await money.createWithdrawalAtomic("a@example.com", 10, "ali", "Buyer", {
      operationId: "real-withdraw-01", authVersion: 2, accountLifecycleId: lifecycle,
    });
    assert.equal(withdrawn.ok, true);

    const effectInput = {
      email: "a@example.com",
      delta: 5,
      effectId: "real-refund-recreated-account-01",
    };
    const effect = await money.applyBalanceEffectAtomic({
      ...effectInput,
      expectedAccountLifecycleId: lifecycle,
    });
    assert.equal(effect.ok, true);
    const effectOperationKey = money.moneyKeys.operationKey("effect:a@example.com", effectInput.effectId);
    assert.equal(redis.run(["EXISTS", effectOperationKey]), 1);

    const recreatedLifecycle = "b".repeat(32);
    redis.run(["SET", "liumeiti:users:a@example.com", JSON.stringify({ email: "a@example.com", balance: 0, banned: false })]);
    redis.run(["SET", money.balanceCentsKey("a@example.com"), "0"]);
    redis.run(["SET", "lm:user:lifecycle:a@example.com", recreatedLifecycle]);
    const oldLifecycle = await money.transferBalanceAtomic("a@example.com", "b@example.com", 1, {
      operationId: "real-transfer-old-lifecycle", authVersion: 2, accountLifecycleId: lifecycle,
    });
    assert.equal(oldLifecycle.error, "account_lifecycle_changed");

    const staleEffect = await money.applyBalanceEffectAtomic({
      ...effectInput,
      expectedAccountLifecycleId: lifecycle,
    });
    assert.equal(staleEffect.error, "account_lifecycle_changed");
    assert.equal(redis.run(["GET", money.balanceCentsKey("a@example.com")]), "0");

    const reboundEffect = await money.applyBalanceEffectAtomic({
      ...effectInput,
      expectedAccountLifecycleId: recreatedLifecycle,
    });
    assert.equal(reboundEffect.error, "idempotency_conflict");
    assert.equal(redis.run(["GET", money.balanceCentsKey("a@example.com")]), "0");
    assert.equal(redis.run(["EXISTS", effectOperationKey]), 1);

    const arrayOrder = {
      orderId: "LM-LOSSLESS-EMPTY-ARRAYS",
      email: "buyer@example.com",
      status: "received",
      paymentMethod: "alipay",
      paidCurrency: "CNY",
      finalAmount: 0,
      createdAt: new Date().toISOString(),
      items: [],
      redeemServices: [],
      legacyRows: [],
      legacyNull: null,
    };
    const orderResult = await money.commitOrderCreationAtomic({
      order: arrayOrder,
      paymentMethod: "alipay",
      operationId: "real-order-lossless-empty-arrays",
      requestHash: "c".repeat(64),
    });
    assert.equal(orderResult.ok, true);
    assert.deepEqual(orderResult.order.items, []);
    assert.deepEqual(orderResult.order.redeemServices, []);
    assert.deepEqual(orderResult.order.legacyRows, []);
    const storedOrderRaw = redis.run(["GET", money.moneyKeys.orderRecordKey(arrayOrder.orderId)]);
    assert.match(storedOrderRaw, /"items":\[\]/);
    assert.match(storedOrderRaw, /"redeemServices":\[\]/);
    assert.match(storedOrderRaw, /"legacyRows":\[\]/);
    assert.match(storedOrderRaw, /"legacyNull":null/);

    redis.run(["SET", money.balanceCentsKey("a@example.com"), "100"]);
    redis.run(["SET", money.balanceCentsKey("b@example.com"), String(Number.MAX_SAFE_INTEGER)]);
    const overflow = await money.transferBalanceAtomic("a@example.com", "b@example.com", 0.01, {
      operationId: "real-transfer-safe-integer-overflow",
      authVersion: 2,
      accountLifecycleId: recreatedLifecycle,
    });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.error, "balance_out_of_range");
    assert.equal(redis.run(["GET", money.balanceCentsKey("a@example.com")]), "100");
    assert.equal(redis.run(["GET", money.balanceCentsKey("b@example.com")]), String(Number.MAX_SAFE_INTEGER));

    redis.run(["SET", money.balanceCentsKey("a@example.com"), "9007199254740992"]);
    const unsafeOverlay = await money.getBalanceCentsOverlay("a@example.com", 0);
    assert.equal(unsafeOverlay.ok, false);
    assert.equal(unsafeOverlay.error, "invalid_balance_record");
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
