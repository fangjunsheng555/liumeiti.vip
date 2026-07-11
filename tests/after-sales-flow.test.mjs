import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
  if (name === "LRANGE") {
    const list = lists.get(args[0]) || [];
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return list.slice(start, stop < 0 ? undefined : stop + 1);
  }
  if (name === "LSET") {
    const list = lists.get(args[0]) || [];
    const index = Number(args[1]);
    if (index < 0 || index >= list.length) return null;
    list[index] = args[2];
    lists.set(args[0], list);
    return "OK";
  }
  if (name === "HSET" || name === "HDEL") return 1;
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
const adminOrderRoute = await import("../app/api/admin/orders/[orderId]/route.js");
const adminOrdersRoute = await import("../app/api/admin/orders/route.js");
const passwordUpdateRoute = await import("../app/api/order-password-update/[orderId]/route.js");
const passwordUpdateEmail = await import("../app/api/order-password-update/email.js");
const orderAttention = await import("../app/lib/order-attention.js");
const settingsDefaults = await import("../app/lib/settings-defaults.js");

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

test("orders without a ticket return an empty active-ticket map", async () => {
  const active = await store.getActiveAfterSalesTickets(["LMWITHOUTTICKET"]);
  assert.deepEqual(active, {});
});

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

  const incompleteCredentialsResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "completed", items: [{ index: 0, account: "", password: "resolved-password" }] }),
    }),
    { params: Promise.resolve({ ticketId: created.ticket.ticketId }) },
  );
  assert.equal(incompleteCredentialsResponse.status, 400);
  assert.equal((await incompleteCredentialsResponse.json()).error, "missing_credentials");
  assert.equal((await store.getAfterSalesTicket(created.ticket.ticketId)).status, "pending");

  const completedResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        status: "completed",
        staffNote: "已重新配置，请重新登录。",
        items: [{ index: 0, account: "resolved-account@example.com", password: "resolved-password" }],
      }),
    }),
    { params: Promise.resolve({ ticketId: created.ticket.ticketId }) },
  );
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.ticket.status, "completed");
  assert.equal(completed.ticket.staffNote, "已重新配置，请重新登录。");
  assert.equal(completed.ticket.items[0].account, "resolved-account@example.com");
  assert.equal(completed.ticket.items[0].password, "resolved-password");
  const syncedOrder = await utils.getOrderById(order.orderId);
  assert.equal(syncedOrder.items[0].staffAccount, "resolved-account@example.com");
  assert.equal(syncedOrder.items[0].staffPassword, "resolved-password");
  assert.equal(syncedOrder.status, "completed");
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

test("Spotify password correction updates the original order without exposing the old password", async () => {
  const order = {
    orderId: "LMSPOTIFYPASSWORD1",
    status: "received",
    createdAt: new Date().toISOString(),
    locale: "zh",
    email: "buyer@example.com",
    contact: "original-contact",
    remark: "original-note",
    items: [{
      service: "spotify",
      label: "Spotify · 家庭成员",
      account: "old-account@example.com",
      password: "old-password",
      amount: 128,
    }],
  };
  lists.set("liumeiti:orders", [JSON.stringify(order)]);
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const adminResponse = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "spotify_password_error", itemIndex: 0, staffNote: "请确认密码可正常登录" }),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(adminResponse.status, 200);
  const adminResult = await adminResponse.json();
  assert.equal(adminResult.ok, true);
  assert.equal(adminResult.order.items[0].passwordCorrectionStaffNote, "请确认密码可正常登录");
  assert.equal(Object.hasOwn(adminResult.order.items[0], "passwordCorrectionTokenHash"), false);
  const abnormalResponse = await adminOrdersRoute.GET(new Request(
    "https://www.liumeiti.vip/api/admin/orders?status=abnormal",
    { headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` } },
  ));
  const abnormalResult = await abnormalResponse.json();
  const abnormalOrder = abnormalResult.orders.find((item) => item.orderId === order.orderId);
  assert.ok(abnormalOrder);
  assert.match(abnormalOrder.abnormalReason, /Spotify/);
  const emailPreview = passwordUpdateEmail.buildSpotifyPasswordErrorEmail({
    order,
    item: order.items[0],
    updateUrl: "https://www.liumeiti.vip/order-update/spotify/test#token=token",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    staffNote: "请确认密码可正常登录",
  });
  assert.match(emailPreview.text, /Spotify 密码无法通过验证/);
  assert.match(emailPreview.html, /请确认密码可正常登录/);
  assert.match(emailPreview.html, /更新订单资料/);

  const token = "known-password-correction-token";
  const storedAfterMail = JSON.parse(lists.get("liumeiti:orders")[0]);
  storedAfterMail.items[0].passwordCorrectionTokenHash = createHash("sha256").update(token).digest("hex");
  storedAfterMail.items[0].passwordCorrectionExpiresAt = new Date(Date.now() + 60_000).toISOString();
  // 生产中 setOrderAt 会同时维护 record + legacy 两个副本,且迁移保证订单在主索引里;测试镜像这一一致性。
  lists.set("liumeiti:orders", [JSON.stringify(storedAfterMail)]);
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(storedAfterMail));
  lists.set("liumeiti:orders:index", [order.orderId]);

  const getResponse = await passwordUpdateRoute.GET(
    new Request(`https://www.liumeiti.vip/api/order-password-update/${order.orderId}`, { headers: { Authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  const inspected = await getResponse.json();
  assert.equal(inspected.ok, true);
  assert.equal(inspected.details.account, "old-account@example.com");
  assert.equal(inspected.details.email, "buyer@example.com");
  assert.equal(Object.hasOwn(inspected.details, "password"), false);

  const previousFetch = globalThis.fetch;
  const telegramMessages = [];
  process.env.TELEGRAM_BOT_TOKEN = "telegram-test-token";
  process.env.TELEGRAM_CHAT_ID = "telegram-test-chat";
  globalThis.fetch = async (input, options = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      telegramMessages.push(JSON.parse(options.body || "{}"));
      return Response.json({ ok: true });
    }
    return previousFetch(input, options);
  };
  let patchResponse;
  try {
    patchResponse = await passwordUpdateRoute.PATCH(
      new Request(`https://www.liumeiti.vip/api/order-password-update/${order.orderId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          account: "correct-account@example.com",
          password: "correct-password",
          email: "updated@example.com",
          contact: "updated-contact",
          remark: "updated-note",
        }),
      }),
      { params: Promise.resolve({ orderId: order.orderId }) },
    );
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  assert.equal(patched.ok, true);
  // 用规范读路径断言(record 优先),与全站读取行为一致。
  const finalOrder = await utils.getOrderById(order.orderId);
  assert.equal(finalOrder.items[0].account, "correct-account@example.com");
  assert.equal(finalOrder.items[0].password, "correct-password");
  assert.equal(finalOrder.email, "updated@example.com");
  assert.equal(finalOrder.contact, "updated-contact");
  assert.equal(finalOrder.remark, "updated-note");
  assert.equal(finalOrder.items[0].customerPasswordUpdateCount, 1);
  assert.equal(telegramMessages.length, 1);
  assert.match(telegramMessages[0].text, /Spotify 用户资料已更新/);
  assert.match(telegramMessages[0].text, new RegExp(order.orderId));
  assert.match(telegramMessages[0].text, /correct-account@example\.com/);
  assert.match(telegramMessages[0].text, /updated@example\.com/);
  assert.match(telegramMessages[0].text, /updated-contact/);
  assert.match(telegramMessages[0].text, /updated-note/);
  assert.match(telegramMessages[0].text, /密码: correct-password/);

  const resolvedResponse = await adminOrdersRoute.GET(new Request(
    "https://www.liumeiti.vip/api/admin/orders?status=abnormal",
    { headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` } },
  ));
  const resolvedResult = await resolvedResponse.json();
  assert.equal(resolvedResult.orders.some((item) => item.orderId === order.orderId), false);
});

test("shared email delivery adds the three configured clickable support contacts once", () => {
  const support = {
    qq: { value: "QQ-TEST", href: "https://support.example.com/qq" },
    whatsapp: { value: "WA-TEST", href: "https://support.example.com/wa" },
    telegram: { value: "TG-TEST", href: "https://support.example.com/tg" },
  };
  const prepared = utils.applyEmailSupportContacts({
    subject: "订单通知",
    text: "订单内容",
    html: "<!doctype html><html><body><p>订单内容</p></body></html>",
  }, support);
  for (const contact of Object.values(support)) {
    assert.match(prepared.html, new RegExp(contact.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prepared.text, new RegExp(contact.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((prepared.html.match(/data-lm-support-contacts/g) || []).length, 1);
  const preparedTwice = utils.applyEmailSupportContacts(prepared, support);
  assert.equal((preparedTwice.html.match(/data-lm-support-contacts/g) || []).length, 1);

  const embedded = settingsDefaults.supportHtml(support, "zh");
  for (const contact of Object.values(support)) assert.match(embedded, new RegExp(contact.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const preparedEmbedded = utils.applyEmailSupportContacts({ subject: "订单通知", text: "订单内容", html: `<html><body>${embedded}</body></html>` }, support);
  assert.equal((preparedEmbedded.html.match(/data-lm-support-contacts/g) || []).length, 1);
});

test("compact overview rows preserve pending Spotify password attention", () => {
  assert.equal(orderAttention.hasPendingSpotifyPasswordCorrection({
    items: [{ amount: 128 }],
    passwordCorrectionPending: true,
  }), true);
});

test("legacy staff-provided service tickets hydrate and sync latest credentials", async () => {
  const order = {
    orderId: "LMTESTAFTERSALE3",
    status: "completed",
    locale: "zh",
    email: "ai-buyer@example.com",
    serviceLabel: "AI 会员 · GPT Plus",
    items: [{
      service: "ai",
      label: "AI 会员 · GPT Plus",
      plan: "gpt-plus",
      amount: 229,
      account: "",
      password: "",
      staffAccount: "current-ai-account@example.com",
      staffPassword: "current-ai-password",
    }],
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const createdAt = new Date().toISOString();
  const created = await store.createAfterSalesTicket({
    ticketId: "ASLEGACYAI1",
    orderId: order.orderId,
    status: "pending",
    locale: "zh",
    email: order.email,
    contact: "",
    remark: "",
    issue: "AI 会员账号需要售后协助",
    serviceLabel: order.serviceLabel,
    items: [{ index: 0, service: "ai", label: order.serviceLabel, plan: "gpt-plus", account: "", password: "" }],
    createdAt,
    createdAtBeijing: createdAt,
  });
  assert.equal(created.ok, true);

  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const adminHeaders = { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "Content-Type": "application/json" };
  const detailResponse = await adminDetailRoute.GET(
    new Request("https://www.liumeiti.vip/api/admin/after-sales/ASLEGACYAI1", { headers: adminHeaders }),
    { params: Promise.resolve({ ticketId: "ASLEGACYAI1" }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detail.ticket.items[0].credentialManaged, true);
  assert.equal(detail.ticket.items[0].account, "current-ai-account@example.com");
  assert.equal(detail.ticket.items[0].password, "current-ai-password");

  const completedResponse = await adminDetailRoute.PATCH(
    new Request("https://www.liumeiti.vip/api/admin/after-sales/ASLEGACYAI1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        status: "completed",
        staffNote: "账号已更新",
        items: [{ index: 0, account: "new-ai-account@example.com", password: "new-ai-password" }],
      }),
    }),
    { params: Promise.resolve({ ticketId: "ASLEGACYAI1" }) },
  );
  assert.equal(completedResponse.status, 200);
  const syncedOrder = await utils.getOrderById(order.orderId);
  assert.equal(syncedOrder.items[0].staffAccount, "new-ai-account@example.com");
  assert.equal(syncedOrder.items[0].staffPassword, "new-ai-password");
});
