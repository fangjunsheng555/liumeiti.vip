import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "http://order-overview.redis.test";
process.env.KV_REST_API_TOKEN = "order-overview-real-token";
process.env.AUTH_SECRET = "order-overview-real-auth-secret-32-chars";

const utils = await import("../app/api/_utils.js");
const ordersRoute = await import("../app/api/admin/orders/route.js");

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

    // A corrupt derived-index prefix must not occupy the fixed first window
    // and hide an older valid order from either the function or HTTP route.
    const visibleOrder = {
      orderId: "LMREALSUMMARY001",
      status: "received",
      createdAt: "2026-08-01T00:00:00.000Z",
      createdAtBeijing: "2026-08-01 08:00:00 Beijing Time (UTC+8)",
      finalAmount: 88,
      paidCurrency: "CNY",
      paymentMethod: "alipay",
      items: [],
    };
    redis.run(["SET", `liumeiti:orders:record:${visibleOrder.orderId}`, JSON.stringify(visibleOrder)]);
    redis.run(["HSET", "liumeiti:orders:overview", visibleOrder.orderId, JSON.stringify(visibleOrder)]);
    redis.run(["ZADD", "liumeiti:orders:summary-created", "1", visibleOrder.orderId]);
    redis.run(["SET", "liumeiti:orders:overview:ready:v8", "1"]);
    redis.run(["SET", "liumeiti:orders:overview:count:v8", "1"]);
    redis.run(["SET", "liumeiti:orders:list-revision:v1", "1"]);
    for (let index = 1; index <= 100; index += 1) {
      redis.run(["ZADD", "liumeiti:orders:summary-created", String(2_000_000_000_000 + index), " ".repeat(index)]);
    }
    const similarRawMember = `${visibleOrder.orderId} `;
    redis.run(["ZADD", "liumeiti:orders:summary-created", "2000000000200", similarRawMember]);

    const page = await utils.getOrderSummariesPageFast(0, 1);
    assert.deepEqual(page?.orders.map((order) => order.orderId), [visibleOrder.orderId]);
    assert.equal(page?.total, 1);
    assert.equal(redis.run(["ZSCORE", "liumeiti:orders:summary-created", similarRawMember]), null);
    assert.notEqual(redis.run(["ZSCORE", "liumeiti:orders:summary-created", visibleOrder.orderId]), null,
      "raw-member cleanup must not delete a canonical member with a similar prefix");

    const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin",
      exp: Date.now() + 60_000 });
    const response = await ordersRoute.GET(new Request("https://www.liumeiti.vip/api/admin/orders?offset=0&limit=1", {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).orders.map((order) => order.orderId), [visibleOrder.orderId]);

    const healthyFetch = redis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const commands = url.pathname === "/pipeline" ? JSON.parse(String(init.body || "[]")) : [];
      if (commands.some((command) => String(command[0]).toUpperCase() === "ZREVRANGE")) {
        return Response.json(commands.map((command) => (
          String(command[0]).toUpperCase() === "ZREVRANGE"
            ? { error: "injected_summary_index_failure" }
            : { result: redis.run(command) }
        )));
      }
      return healthyFetch(input, init);
    };
    assert.equal(await utils.getOrderSummariesPageFast(0, 1), null,
      "a Redis command error must not become a plausible empty page");
    globalThis.fetch = healthyFetch;
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
