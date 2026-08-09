import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const values = new Map();
const hashes = new Map();
const sortedSets = new Map();
let rangeCommandError = false;
let cleanupCommandError = false;

function hash(key) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  return hashes.get(key);
}

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") { values.set(args[0], String(args[1])); return "OK"; }
  if (name === "LRANGE") return [];
  if (name === "HSET") { hash(args[0]).set(args[1], args[2]); return 1; }
  if (name === "HMGET") return args.slice(1).map((field) => hash(args[0]).get(field) ?? null);
  if (name === "ZADD") { sortedSet(args[0]).set(args[2], Number(args[1])); return 1; }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZSCORE") return sortedSet(args[0]).get(args[1]) ?? null;
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return Array.from(sortedSet(args[0]).entries())
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member);
  }
  if (name === "ZREM") {
    let removed = 0;
    args.slice(1).forEach((member) => { if (sortedSet(args[0]).delete(member)) removed += 1; });
    return removed;
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const url = new URL(request.url, "http://127.0.0.1");
  let payload;
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
    payload = commands.map((command) => {
      const name = String(command[0] || "").toUpperCase();
      if (rangeCommandError && name === "ZREVRANGE") return { error: "injected_range_failure" };
      if (cleanupCommandError && name === "ZREM") return { error: "injected_cleanup_failure" };
      return { result: execute(command) };
    });
  } else {
    payload = { result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.KV_REST_API_URL = `http://127.0.0.1:${address.port}`;
process.env.KV_REST_API_TOKEN = "order-summary-http-token";
process.env.AUTH_SECRET = "order-summary-http-auth-secret-32-chars";

const utils = await import("../app/api/_utils.js");
const ordersRoute = await import("../app/api/admin/orders/route.js");

const summaryKey = "liumeiti:orders:summary-created";
const overviewKey = "liumeiti:orders:overview";
const order = {
  orderId: "LMHTTPSUMMARY001",
  status: "received",
  createdAt: "2026-08-01T00:00:00.000Z",
  createdAtBeijing: "2026-08-01 08:00:00 Beijing Time (UTC+8)",
  finalAmount: 66,
  paidCurrency: "CNY",
  paymentMethod: "alipay",
  items: [],
};

function seed() {
  values.clear(); hashes.clear(); sortedSets.clear();
  values.set("liumeiti:orders:overview:ready:v8", "1");
  values.set("liumeiti:orders:list-revision:v1", "7");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  hash(overviewKey).set(order.orderId, JSON.stringify(order));
  sortedSet(summaryKey).set(order.orderId, 1);
  for (let index = 1; index <= 100; index += 1) {
    sortedSet(summaryKey).set(`LMBROKEN${String(index).padStart(3, "0")}`, 2_000_000_000_000 + index);
  }
  sortedSet(summaryKey).set(" ", 2_000_000_000_150);
  sortedSet(summaryKey).set(`${order.orderId} `, 2_000_000_000_200);
  rangeCommandError = false;
  cleanupCommandError = false;
}

test("summary index overscans corrupt members through Redis HTTP and preserves exact neighbors", async () => {
  seed();
  const page = await utils.getOrderSummariesPageFast(0, 1);
  assert.deepEqual(page?.orders.map((entry) => entry.orderId), [order.orderId]);
  assert.equal(page?.total, 1);
  assert.equal(sortedSet(summaryKey).has(`${order.orderId} `), false);
  assert.equal(sortedSet(summaryKey).has(order.orderId), true,
    "raw ZREM cleanup must not remove a similar canonical member");

  const token = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin",
    exp: Date.now() + 60_000 });
  const response = await ordersRoute.GET(new Request("https://www.liumeiti.vip/api/admin/orders?offset=0&limit=1", {
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.orders.map((entry) => entry.orderId), [order.orderId]);
  assert.equal(body.hasMore, false);
});

test("summary index command and cleanup errors fail hard instead of returning partial data", async () => {
  seed();
  rangeCommandError = true;
  assert.equal(await utils.getOrderSummariesPageFast(0, 1), null);
  rangeCommandError = false;
  cleanupCommandError = true;
  assert.equal(await utils.getOrderSummariesPageFast(0, 1), null);
  assert.equal(sortedSet(summaryKey).size, 103, "failed cleanup must not be reported as a complete page");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
