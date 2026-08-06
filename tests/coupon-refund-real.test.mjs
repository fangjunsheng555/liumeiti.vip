import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "https://redis.coupon-refund.test";
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

test("real Redis atomically restores production-shaped coupon and service-code tail metadata", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-coupon-refund-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    const email = "legacy-coupon@example.com";
    const orderId = "LMCOUPONTAILREFUND";
    const couponId = "CP-LEGACY-TAIL";
    const lifecycle = "f".repeat(32);
    const userKey = `liumeiti:users:${email}`;
    const before = "{\n"
      + `  \"email\": \"${email}\",\n`
      + "  \"balance\": 0,\n"
      + "  \"withdrawals\": [],\n"
      + "  \"nullable\": null,\n"
      + "  \"legacyCounter\": 900719925474099312345,\n"
      + `  \"coupons\": [{\"id\":\"${couponId}\",\"status\":\"used\",\"usedOrderId\":\"${orderId}\",\"discount\":9.89,\"usedAt\":\"2026-08-06T00:00:00.000Z\",\"usedAtBeijing\":\"2026-08-06 08:00:00\"}]\n`
      + "}";
    const expected = before.replace(
      `\"status\":\"used\",\"usedOrderId\":\"${orderId}\",\"discount\":9.89,\"usedAt\":\"2026-08-06T00:00:00.000Z\",\"usedAtBeijing\":\"2026-08-06 08:00:00\"`,
      "\"status\":\"active\"",
    );
    redis.run(["SET", userKey, before]);
    redis.run(["SET", money.balanceCentsKey(email), "0"]);
    redis.run(["SET", money.accountLifecycleKey(email), lifecycle]);

    const effectId = `coupon-refund:${orderId}:cycle:1`;
    const restored = await money.transitionOrderCouponAtomic(email, couponId, orderId, "active", effectId, lifecycle);
    assert.equal(restored.ok, true);
    assert.equal(restored.changed, true);
    assert.equal(redis.run(["GET", userKey]), expected);

    const replay = await money.transitionOrderCouponAtomic(email, couponId, orderId, "active", effectId, lifecycle);
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.equal(redis.run(["GET", userKey]), expected);

    redis.run(["SET", userKey, before]);
    const wrongOwner = await money.transitionOrderCouponAtomic(
      email, couponId, "LMSOMEOTHERORDER", "active", "coupon-refund:wrong-owner", lifecycle,
    );
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.error, "coupon_owner_mismatch");
    assert.equal(redis.run(["GET", userKey]), before);

    const codeRaw = "{\"code\":\"SERVICETAIL\",\"status\":\"used\",\"type\":\"service\",\"usedBy\":\"legacy-coupon@example.com\",\"usedOrderId\":\"LMSERVICECODEORDER\",\"usedIp\":\"127.0.0.1\",\"usedUserAgent\":\"old\",\"usedAt\":\"2026-08-06T00:00:00.000Z\",\"usedAtBeijing\":\"2026-08-06 08:00:00\",\"usedOperationId\":\"old-operation\"}";
    const codeExpected = "{\"code\":\"SERVICETAIL\",\"status\":\"active\",\"type\":\"service\"}";
    redis.run(["SET", "liumeiti:redeem-code:SERVICETAIL", codeRaw]);
    const codeRestored = await money.restoreServiceCodeAtomic("SERVICE-TAIL", "LMSERVICECODEORDER", {
      operationId: "restore-service-tail",
    });
    assert.equal(codeRestored.ok, true, JSON.stringify(codeRestored));
    assert.equal(redis.run(["GET", "liumeiti:redeem-code:SERVICETAIL"]), codeExpected);
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
