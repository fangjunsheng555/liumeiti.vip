import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "admin-order-summary-test-secret-32-characters";
process.env.KV_REST_API_URL = "http://redis.order-summary.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
const lists = new Map();
const hashes = new Map();
const sortedSets = new Map();
const sets = new Map();
const commandNames = [];
const originalFetch = globalThis.fetch;

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
  commandNames.push(name);
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map(String).includes("NX") && values.has(key)) return null;
    values.set(key, String(value));
    return "OK";
  }
  if (name === "INCR") {
    const next = Number(values.get(args[0]) || 0) + 1;
    values.set(args[0], String(next));
    return next;
  }
  if (name === "EVAL") {
    const key = args[2];
    const expected = args[3];
    if (values.get(key) !== expected) return 0;
    values.delete(key);
    return 1;
  }
  if (name === "LPUSH") {
    const row = lists.get(args[0]) || [];
    row.unshift(...args.slice(1));
    lists.set(args[0], row);
    return row.length;
  }
  if (name === "RPUSH") {
    const row = lists.get(args[0]) || [];
    row.push(...args.slice(1));
    lists.set(args[0], row);
    return row.length;
  }
  if (name === "LRANGE") {
    const row = lists.get(args[0]) || [];
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return row.slice(start, stop < 0 ? undefined : stop + 1);
  }
  if (name === "LPOS") {
    const index = (lists.get(args[0]) || []).indexOf(args[1]);
    return index < 0 ? null : index;
  }
  if (name === "HSET") {
    hash(args[0]).set(args[1], args[2]);
    return 1;
  }
  if (name === "HGET") return hash(args[0]).get(args[1]) ?? null;
  if (name === "HMGET") return args.slice(1).map((field) => hash(args[0]).get(field) ?? null);
  if (name === "HVALS") return Array.from(hash(args[0]).values());
  if (name === "HDEL") return hash(args[0]).delete(args[1]) ? 1 : 0;
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") {
    let removed = 0;
    args.slice(1).forEach((member) => { if (sortedSet(args[0]).delete(member)) removed += 1; });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return Array.from(sortedSet(args[0]).entries())
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member);
  }
  if (name === "SADD") {
    if (!sets.has(args[0])) sets.set(args[0], new Set());
    args.slice(1).forEach((member) => sets.get(args[0]).add(member));
    return args.length - 1;
  }
  if (name === "SMEMBERS") return Array.from(sets.get(args[0]) || []);
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://redis.order-summary.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    return Response.json(commands.map((command) => ({ result: execute(command) })));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const utils = await import("../app/api/_utils.js");
const ordersRoute = await import("../app/api/admin/orders/route.js");
const orderDetailRoute = await import("../app/api/admin/orders/[orderId]/route.js");

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "admin",
  exp: Date.now() + 60_000,
});

function adminRequest(path) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  });
}

test("admin order list is paginated summaries while revision tracks changes", async () => {
  for (let index = 0; index < 55; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString();
    const orderId = `LMSUMMARY${String(index).padStart(3, "0")}`;
    const saved = await utils.saveOrderRecord({
      orderId,
      status: "received",
      createdAt,
      createdAtBeijing: `2026-07-01 08:00:${String(index).padStart(2, "0")} Beijing Time (UTC+8)`,
      email: `buyer${index}@example.com`,
      contact: `backup${index}@example.com`,
      serviceLabel: "Spotify - Family member",
      paymentMethod: "balance",
      paidCurrency: "CNY",
      paidAmount: 128,
      finalAmount: 128,
      staffNotes: "private staff note",
      remark: "private buyer note",
      items: [{
        service: "spotify",
        label: "Spotify - Family member",
        amount: 128,
        account: `spotify${index}@example.com`,
        password: `secret-${index}`,
        staffAccount: `staff-${index}`,
        staffPassword: `staff-secret-${index}`,
      }],
    });
    assert.equal(saved, true);
  }

  const firstResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?offset=0&limit=50"));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.ok, true);
  assert.equal(first.orders.length, 50);
  assert.equal(first.total, 55);
  assert.equal(first.hasMore, true);
  assert.equal(first.orders[0].orderId, "LMSUMMARY054");
  assert.equal(first.orders[0]._summaryOnly, true);
  assert.equal("contact" in first.orders[0], false);
  assert.equal("staffNotes" in first.orders[0], false);
  assert.equal("remark" in first.orders[0], false);
  assert.equal("account" in first.orders[0].items[0], false);
  assert.equal("password" in first.orders[0].items[0], false);
  assert.equal("staffAccount" in first.orders[0].items[0], false);
  assert.equal("staffPassword" in first.orders[0].items[0], false);

  const searchResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?q=secret-54&limit=50"));
  const search = await searchResponse.json();
  assert.equal(search.orders.length, 1);
  assert.equal(search.orders[0].orderId, "LMSUMMARY054");
  assert.equal("password" in search.orders[0].items[0], false);

  const detailResponse = await orderDetailRoute.GET(
    adminRequest("/api/admin/orders/LMSUMMARY054"),
    { params: Promise.resolve({ orderId: "LMSUMMARY054" }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detail.order.items[0].account, "spotify54@example.com");
  assert.equal(detail.order.items[0].password, "secret-54");

  const secondResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?offset=50&limit=50"));
  const second = await secondResponse.json();
  assert.equal(second.orders.length, 5);
  assert.equal(second.hasMore, false);

  const revisionBeforeResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"));
  const revisionBefore = await revisionBeforeResponse.json();
  assert.equal(revisionBefore.latestOrderId, "LMSUMMARY054");
  assert.equal(revisionBefore.total, 55);
  commandNames.length = 0;
  const unchangedRevision = await (await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"))).json();
  assert.equal(unchangedRevision.revision, revisionBefore.revision);
  assert.equal(commandNames.includes("HVALS"), false);
  assert.equal(commandNames.includes("HMGET"), false);
  assert.equal(commandNames.includes("LRANGE"), false);

  const entry = await utils.getOrderEntryById("LMSUMMARY054");
  assert.ok(entry?.order);
  assert.equal(await utils.setOrderAt(entry.index, { ...entry.order, status: "completed" }), true);

  const revisionAfterResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"));
  const revisionAfter = await revisionAfterResponse.json();
  assert.ok(Number(revisionAfter.revision) > Number(revisionBefore.revision));

  const recipientResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=recipient-emails"));
  const recipients = await recipientResponse.json();
  assert.ok(recipients.emails.includes("buyer54@example.com"));
  assert.ok(recipients.emails.includes("backup54@example.com"));
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
