import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "http://order-overview.redis.test";
process.env.KV_REST_API_TOKEN = "order-overview-real-token";

const utils = await import("../app/api/_utils.js");

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
        return Response.json(commands.map((command) => {
          try {
            return { result: run(command) };
          } catch (error) {
            // Upstash pipelines report one command error without discarding
            // successful sibling results (including the PING health probe).
            return { error: String(error?.message || error) };
          }
        }));
      }
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("overview shadow rebuild publishes complete snapshots atomically on Redis 7", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-order-overview-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    const orders = Array.from({ length: 3 }, (_, index) => ({
      orderId: `LMREALOVERVIEW00${index + 1}`,
      status: "completed",
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      createdAtBeijing: `2026-08-0${index + 1} 08:00:00 Beijing Time (UTC+8)`,
      finalAmount: (index + 1) * 10,
      paidCurrency: "CNY",
      paymentMethod: "alipay",
      items: [],
    }));
    for (const order of orders) {
      redis.run(["SET", `liumeiti:orders:record:${order.orderId}`, JSON.stringify(order)]);
      redis.run(["RPUSH", "liumeiti:orders:index", order.orderId]);
    }
    redis.run(["SET", "liumeiti:orders:list-revision:v1", "3"]);

    // Reproduce production: the old ready marker and both derived indexes
    // contain only one order even though all authoritative records remain.
    redis.run(["HSET", "liumeiti:orders:overview", orders[0].orderId, JSON.stringify(orders[0])]);
    redis.run(["ZADD", "liumeiti:orders:summary-created", "1", orders[0].orderId]);
    redis.run(["SET", "liumeiti:orders:overview:ready:v7", "1"]);

    const rebuilt = await utils.getOrderOverviewRows();
    assert.deepEqual(rebuilt.map((order) => order.orderId).sort(), orders.map((order) => order.orderId).sort());
    assert.equal(redis.run(["HLEN", "liumeiti:orders:overview"]), 3);
    assert.equal(redis.run(["ZCARD", "liumeiti:orders:summary-created"]), 3);
    assert.equal(redis.run(["GET", "liumeiti:orders:overview:ready:v8"]), "1");
    assert.equal(redis.run(["GET", "liumeiti:orders:overview:count:v8"]), "3");
    assert.deepEqual(redis.run(["KEYS", "liumeiti:orders:*:stage:*"]), []);

    // A later partial derived write must be detected by the manifest and
    // repaired without changing any permanent order record.
    const originalRaw = redis.run(["GET", `liumeiti:orders:record:${orders[1].orderId}`]);
    redis.run(["HDEL", "liumeiti:orders:overview", orders[1].orderId]);
    const repaired = await utils.getOrderOverviewRows();
    assert.equal(repaired.length, 3);
    assert.equal(redis.run(["HLEN", "liumeiti:orders:overview"]), 3);
    assert.equal(redis.run(["GET", `liumeiti:orders:record:${orders[1].orderId}`]), originalRaw);

    // A legacy/corrupt type on disposable cache keys must self-heal. It is
    // not a Redis outage and must never permanently lock the admin overview.
    redis.run(["DEL", "liumeiti:orders:overview", "liumeiti:orders:summary-created"]);
    redis.run(["SET", "liumeiti:orders:overview", "legacy-wrong-type"]);
    redis.run(["RPUSH", "liumeiti:orders:summary-created", "legacy-wrong-type"]);
    const repairedWrongTypes = await utils.getOrderOverviewRows();
    assert.equal(repairedWrongTypes.length, 3);
    assert.equal(redis.run(["TYPE", "liumeiti:orders:overview"]), "hash");
    assert.equal(redis.run(["TYPE", "liumeiti:orders:summary-created"]), "zset");
    assert.equal(redis.run(["HLEN", "liumeiti:orders:overview"]), 3);
    assert.equal(redis.run(["ZCARD", "liumeiti:orders:summary-created"]), 3);

    // A stale one-time record migration marker cannot hide a permanent record
    // that is absent from the derived order index.
    const unindexedOrder = {
      ...orders[2],
      orderId: "LMREALOVERVIEW004",
      createdAt: "2026-08-04T00:00:00.000Z",
      createdAtBeijing: "2026-08-04 08:00:00 Beijing Time (UTC+8)",
      finalAmount: 40,
    };
    redis.run(["SET", "liumeiti:orders:index:record-ready:v1", "1"]);
    redis.run(["SET", `liumeiti:orders:record:${unindexedOrder.orderId}`, JSON.stringify(unindexedOrder)]);
    redis.run(["SET", "liumeiti:orders:list-revision:v1", "4"]);
    redis.run(["SET", "liumeiti:orders:overview:count:v8", "2"]);
    const repairedStaleRecordMarker = await utils.getOrderOverviewRows();
    assert.equal(repairedStaleRecordMarker.length, 4);
    assert.ok(repairedStaleRecordMarker.some((order) => order.orderId === unindexedOrder.orderId));

    // An index ID without either a permanent or legacy body is actual store
    // corruption. Never publish a plausible but understated total.
    redis.run(["RPUSH", "liumeiti:orders:index", "LMDANGLINGOVERVIEW"]);
    redis.run(["SET", "liumeiti:orders:overview:count:v8", "3"]);
    await assert.rejects(utils.getOrderOverviewRows(), /order_store_corrupt/);
    assert.equal(redis.run(["GET", "liumeiti:orders:overview:ready:v8"]), "1");
    assert.equal(redis.run(["HLEN", "liumeiti:orders:overview"]), 4);

    // Empty stores still publish valid empty live structures via staging
    // sentinels instead of failing RENAME on a missing key.
    redis.run(["FLUSHDB"]);
    const empty = await utils.getOrderOverviewRows();
    assert.deepEqual(empty, []);
    assert.equal(redis.run(["GET", "liumeiti:orders:overview:ready:v8"]), "1");
    assert.equal(redis.run(["GET", "liumeiti:orders:overview:count:v8"]), "0");
    assert.equal(redis.run(["HLEN", "liumeiti:orders:overview"]), 0);
    assert.equal(redis.run(["ZCARD", "liumeiti:orders:summary-created"]), 0);
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
