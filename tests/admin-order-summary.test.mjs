import test from "node:test";
import assert from "node:assert/strict";
import { executeOrderCasEval } from "./helpers/order-cas-redis-mock.mjs";
import { executeDurableOperationEval } from "./helpers/durable-operation-redis-mock.mjs";

process.env.AUTH_SECRET = "admin-order-summary-test-secret-32-characters";
process.env.KV_REST_API_URL = "http://redis.order-summary.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
const lists = new Map();
const hashes = new Map();
const sortedSets = new Map();
const sets = new Map();
const commandNames = [];
const pipelineSizes = [];
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
  if (name === "PING") return "PONG";
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
    const cas = executeOrderCasEval(command, { values, lists, hashes, sortedSets, sets });
    if (cas.handled) return cas.result;
    const durable = executeDurableOperationEval(command, { values, sortedSet });
    if (durable.handled) return durable.result;
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("local marked=redis.call('SET',KEYS[1],'1','NX')")) {
      if (values.has(keys[0])) return 0;
      values.set(keys[0], "1");
      const row = lists.get(keys[1]) || [];
      row.unshift(argv[0]);
      lists.set(keys[1], row.slice(0, Number(argv[1] || 500)));
      return 1;
    }
    if (script.includes("local added=redis.call('SADD',KEYS[1],ARGV[1])")) {
      const membershipKey = args[2];
      const listKey = args[3];
      const orderId = args[4];
      if (!sets.has(membershipKey)) sets.set(membershipKey, new Set());
      const added = sets.get(membershipKey).has(orderId) ? 0 : 1;
      sets.get(membershipKey).add(orderId);
      if (added) {
        const row = lists.get(listKey) || [];
        row.push(orderId);
        lists.set(listKey, row);
      }
      return JSON.stringify({ ok: true, added });
    }
    const key = args[2];
    const expected = args[3];
    if (values.get(key) !== expected) return 0;
    values.delete(key);
    return 1;
  }
  if (name === "SCAN") {
    const matchIndex = args.findIndex((value) => String(value).toUpperCase() === "MATCH");
    const pattern = matchIndex >= 0 ? String(args[matchIndex + 1] || "*") : "*";
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return ["0", Array.from(values.keys()).filter((key) => key.startsWith(prefix))];
  }
  if (name === "DEL") {
    let removed = 0;
    args.forEach((key) => {
      if (values.delete(key)) removed += 1;
      if (lists.delete(key)) removed += 1;
      if (hashes.delete(key)) removed += 1;
      if (sortedSets.delete(key)) removed += 1;
      if (sets.delete(key)) removed += 1;
    });
    return removed;
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
    let added = 0;
    args.slice(1).forEach((member) => {
      if (!sets.get(args[0]).has(member)) added += 1;
      sets.get(args[0]).add(member);
    });
    return added;
  }
  if (name === "SMEMBERS") return Array.from(sets.get(args[0]) || []);
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://redis.order-summary.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    pipelineSizes.push(commands.length);
    if (commands.length > 100) return Response.json({ error: "pipeline_too_large" }, { status: 413 });
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

test("admin order list keeps every order when the store limits pipeline batches", async () => {
  const seededIds = [];
  for (let index = 0; index < 155; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString();
    const orderId = `LMSUMMARY${String(index).padStart(3, "0")}`;
    const order = {
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
        cycle: "1年",
        plan: "member",
        amount: 128,
        account: `spotify${index}@example.com`,
        password: `secret-${index}`,
        staffAccount: `staff-${index}`,
        staffPassword: `staff-secret-${index}`,
      }],
    };
    values.set(`liumeiti:orders:record:${orderId}`, JSON.stringify(order));
    seededIds.unshift(orderId);
  }
  lists.set("liumeiti:orders:index", seededIds.slice(12));
  values.set("liumeiti:orders:record:LMDELETED001", JSON.stringify({
    orderId: "LMDELETED001",
    deleted: true,
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, 2, 0)).toISOString(),
  }));

  const firstResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?offset=0&limit=50"));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.ok, true);
  assert.equal(first.orders.length, 50);
  assert.equal(first.total, 155);
  assert.equal(first.hasMore, true);
  assert.equal(first.orders[0].orderId, "LMSUMMARY154");
  assert.equal(new Set(lists.get("liumeiti:orders:index")).size, 156);
  assert.equal(sortedSet("liumeiti:orders:summary-created").has("LMDELETED001"), false);
  assert.equal(first.orders[0]._summaryOnly, true);
  assert.equal("contact" in first.orders[0], false);
  assert.equal("staffNotes" in first.orders[0], false);
  assert.equal("remark" in first.orders[0], false);
  assert.equal("account" in first.orders[0].items[0], false);
  assert.equal("password" in first.orders[0].items[0], false);
  assert.equal("staffAccount" in first.orders[0].items[0], false);
  assert.equal("staffPassword" in first.orders[0].items[0], false);

  assert.equal(Math.max(...pipelineSizes), 100);

  const searchResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?q=secret-154&limit=50"));
  const search = await searchResponse.json();
  assert.equal(search.orders.length, 1);
  assert.equal(search.orders[0].orderId, "LMSUMMARY154");
  assert.equal("password" in search.orders[0].items[0], false);

  const detailResponse = await orderDetailRoute.GET(
    adminRequest("/api/admin/orders/LMSUMMARY154"),
    { params: Promise.resolve({ orderId: "LMSUMMARY154" }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detail.order.items[0].account, "spotify154@example.com");
  assert.equal(detail.order.items[0].password, "secret-154");

  const secondResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?offset=50&limit=50"));
  const second = await secondResponse.json();
  assert.equal(second.orders.length, 50);
  assert.equal(second.hasMore, true);

  const lastResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?offset=150&limit=50"));
  const last = await lastResponse.json();
  assert.equal(last.orders.length, 5);
  assert.equal(last.hasMore, false);

  const revisionBeforeResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"));
  const revisionBefore = await revisionBeforeResponse.json();
  assert.equal(revisionBefore.latestOrderId, "LMSUMMARY154");
  assert.equal(revisionBefore.total, 155);
  commandNames.length = 0;
  const unchangedRevision = await (await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"))).json();
  assert.equal(unchangedRevision.revision, revisionBefore.revision);
  assert.equal(commandNames.includes("HVALS"), false);
  assert.equal(commandNames.includes("HMGET"), false);
  assert.equal(commandNames.includes("LRANGE"), false);

  const entry = await utils.getOrderEntryById("LMSUMMARY154");
  assert.ok(entry?.order);
  assert.equal(await utils.setOrderAt(entry.index, {
    ...entry.order,
    status: "completed",
    completedAt: "2026-07-27T10:00:00.000Z",
  }, { expectedRevision: Number(entry.order.revision ?? 0) }), true);

  const revisionAfterResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=revision"));
  const revisionAfter = await revisionAfterResponse.json();
  assert.ok(Number(revisionAfter.revision) > Number(revisionBefore.revision));

  const deliveryResponse = await orderDetailRoute.PATCH(
    new Request("https://www.liumeiti.vip/api/admin/orders/LMSUMMARY154", {
      method: "PATCH",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
        "content-type": "application/json",
        "idempotency-key": "admin-order-summary-complete-0001",
      },
      body: JSON.stringify({
        status: "completed",
        staffNotes: "",
        internalNotes: "渠道 A / 家庭组 17",
        thirdPartyPlatformNotice: true,
        deliveryMessageMode: "auto",
        items: [{
          index: 0,
          fulfillment: {
            username: "User154",
            region: "europe",
            outcome: "family_joined",
            emailConfirmation: false,
            unexpectedField: "discard",
          },
        }],
      }),
    }),
    { params: Promise.resolve({ orderId: "LMSUMMARY154" }) },
  );
  const delivery = await deliveryResponse.json();
  assert.equal(deliveryResponse.status, 200, JSON.stringify(delivery));
  assert.equal(delivery.order.internalNotes, "渠道 A / 家庭组 17");
  assert.equal(delivery.order.items[0].fulfillment.username, "User154");
  assert.equal(delivery.order.items[0].fulfillment.unexpectedField, undefined);
  assert.match(delivery.order.staffNotes, /^Spotify 用户名：User154，所属地区为欧洲区。/);
  assert.doesNotMatch(delivery.order.staffNotes, /。，/);
  assert.match(delivery.order.staffNotes, /有效期至 2027-07-27/);
  assert.equal(
    delivery.order.staffNotes.match(/核查您的订单来自于第三方平台/g)?.length,
    1,
  );

  const recipientResponse = await ordersRoute.GET(adminRequest("/api/admin/orders?mode=recipient-emails"));
  const recipients = await recipientResponse.json();
  assert.ok(recipients.emails.includes("buyer154@example.com"));
  assert.ok(recipients.emails.includes("backup154@example.com"));
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
