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

    redis.run(["SET", "liumeiti:redeem-code:REALCODE1", JSON.stringify({ code: "REALCODE1", status: "active", type: "balance", amount: 10 })]);
    const redeemed = await money.redeemBalanceCodeAtomic("a@example.com", "REALCODE1", {}, {
      operationId: "real-redeem-01", authVersion: 2, accountLifecycleId: lifecycle,
    });
    assert.equal(redeemed.ok, true);
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
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
