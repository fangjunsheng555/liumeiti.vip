import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "after-sales-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_PROVIDER;

const values = new Map();
const lists = new Map();
const sortedSets = new Map();
const originalFetch = globalThis.fetch;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map(String).includes("NX") && values.has(key)) return null;
    values.set(key, value);
    return "OK";
  }
  if (name === "DEL") {
    let removed = 0;
    args.forEach((key) => { if (values.delete(key)) removed += 1; });
    return removed;
  }
  if (name === "INCR") {
    const next = Number(values.get(args[0]) || 0) + 1;
    values.set(args[0], String(next));
    return next;
  }
  if (name === "EXPIRE") return 1;
  if (name === "EVAL") {
    const key = args[2];
    const expected = args[3];
    if (values.get(key) !== expected) return 0;
    values.delete(key);
    return 1;
  }
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") {
    const set = sortedSet(args[0]);
    let removed = 0;
    args.slice(1).forEach((member) => { if (set.delete(member)) removed += 1; });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return [...sortedSet(args[0]).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member);
  }
  if (name === "LPUSH") {
    const list = lists.get(args[0]) || [];
    list.unshift(...args.slice(1));
    lists.set(args[0], list);
    return list.length;
  }
  if (name === "LTRIM") {
    const list = lists.get(args[0]) || [];
    lists.set(args[0], list.slice(Number(args[1]), Number(args[2]) + 1));
    return "OK";
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(options.body || "[]");
    return Response.json(commands.map((command) => ({ result: execute(command) })));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const utils = await import("../app/api/_utils.js");
const customerRoute = await import("../app/api/after-sales/route.js");
const adminListRoute = await import("../app/api/admin/after-sales/route.js");
const adminDetailRoute = await import("../app/api/admin/after-sales/[ticketId]/route.js");
const store = await import("../app/api/after-sales/_store.js");

function orderRecord(orderId, email = "buyer@example.com") {
  return {
    orderId,
    status: "completed",
    locale: "zh",
    email,
    contact: "buyer-contact",
    remark: "original note",
    serviceLabel: "Spotify · 家庭成员",
    items: [{
      service: "spotify",
      label: "Spotify · 家庭成员",
      plan: "member",
      account: "original-account@example.com",
      password: "original-password",
      amount: 128,
    }],
  };
}

function customerRequest(order, token, issue = "账号当前无法正常登录") {
  return new Request("https://www.liumeiti.vip/api/after-sales", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: order.orderId,
      token,
      issue,
      contact: "updated-contact",
      remark: "updated note",
      items: [{ index: 0, account: "edited-account@example.com", password: "edited-password" }],
    }),
  });
}

test("after-sales ticket lifecycle enforces one pending ticket per order", async () => {
  const order = orderRecord("LMTESTAFTERSALE1");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: order.orderId,
    email: order.email,
    exp: Date.now() + 60_000,
  });

  const createdResponse = await customerRoute.POST(customerRequest(order, token));
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.ticket.status, "pending");

  const stored = await store.getAfterSalesTicket(created.ticket.ticketId);
  assert.equal(stored.items[0].account, "edited-account@example.com");
  assert.equal(stored.items[0].password, "edited-password");
  assert.equal(stored.contact, "updated-contact");

  const duplicateResponse = await customerRoute.POST(customerRequest(order, token));
  assert.equal(duplicateResponse.status, 409);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.error, "pending_ticket_exists");
  assert.equal(duplicate.ticket.ticketId, created.ticket.ticketId);

  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const adminHeaders = { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "Content-Type": "application/json" };
  const listResponse = await adminListRoute.GET(new Request("https://www.liumeiti.vip/api/admin/after-sales?status=pending", { headers: adminHeaders }));
  const list = await listResponse.json();
  assert.equal(list.ok, true);
  assert.equal(list.counts.pending, 1);
  assert.equal(list.tickets[0].ticketId, created.ticket.ticketId);
  assert.equal(Object.hasOwn(list.tickets[0], "items"), false);

  const detailResponse = await adminDetailRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, { headers: adminHeaders }),
    { params: Promise.resolve({ ticketId: created.ticket.ticketId }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detail.ticket.items[0].account, "edited-account@example.com");

  const completedResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "completed", staffNote: "已重新配置，请重新登录。" }),
    }),
    { params: Promise.resolve({ ticketId: created.ticket.ticketId }) },
  );
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.ticket.status, "completed");
  assert.equal(completed.ticket.staffNote, "已重新配置，请重新登录。");
  assert.equal((await store.getAfterSalesCounts()).pending, 0);

  const repeatedCompletionResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "completed", staffNote: "不应重复覆盖" }),
    }),
    { params: Promise.resolve({ ticketId: created.ticket.ticketId }) },
  );
  const repeatedCompletion = await repeatedCompletionResponse.json();
  assert.equal(repeatedCompletion.changed, false);
  assert.equal(repeatedCompletion.notice, null);
  assert.equal(repeatedCompletion.ticket.staffNote, "已重新配置，请重新登录。");

  const nextResponse = await customerRoute.POST(customerRequest(order, token, "完成后出现了新的播放异常"));
  assert.equal(nextResponse.status, 200);
  const next = await nextResponse.json();
  assert.notEqual(next.ticket.ticketId, created.ticket.ticketId);
});

test("concurrent customer submissions create only one pending ticket", async () => {
  const order = orderRecord("LMTESTAFTERSALE2", "second@example.com");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: order.orderId,
    email: order.email,
    exp: Date.now() + 60_000,
  });
  const responses = await Promise.all([
    customerRoute.POST(customerRequest(order, token)),
    customerRoute.POST(customerRequest(order, token)),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const active = await store.getActiveAfterSalesTicket(order.orderId);
  assert.equal(active.status, "pending");
  assert.equal(active.orderId, order.orderId);
});
