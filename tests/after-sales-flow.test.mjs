import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeOrderCasEval } from "./helpers/order-cas-redis-mock.mjs";

process.env.AUTH_SECRET = "after-sales-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.RESEND_API_KEY = "after-sales-resend-test-key";
delete process.env.EMAIL_PROVIDER;

const values = new Map();
const lists = new Map();
const sortedSets = new Map();
const sets = new Map();
const originalFetch = globalThis.fetch;
const resendRequests = [];
const resendFailuresRemaining = new Map();
const resendUncertainFailuresRemaining = new Map();
let failNextCompletionCommit = false;

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
    args.forEach((key) => {
      if (values.delete(key)) removed += 1;
      if (lists.delete(key)) removed += 1;
      if (sets.delete(key)) removed += 1;
    });
    return removed;
  }
  if (name === "INCR") {
    const next = Number(values.get(args[0]) || 0) + 1;
    values.set(args[0], String(next));
    return next;
  }
  if (name === "EXPIRE") return 1;
  if (name === "EVAL") {
    const cas = executeOrderCasEval(command, { values, lists, sortedSets, sets });
    if (cas.handled) return cas.result;
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("ticket_id_conflict") && script.includes("storagePending=true")) {
      const activeId = values.get(keys[1]);
      if (activeId) {
        const activeRaw = values.get(argv[4] + activeId);
        if (!activeRaw) return JSON.stringify({ ok: false, error: "pending_ticket_exists", ticketId: activeId, storagePending: true });
        const active = JSON.parse(activeRaw);
        if (active.status === "pending") return JSON.stringify({ ok: false, error: "pending_ticket_exists", ticketId: activeId });
        values.delete(keys[1]);
      }
      if (values.has(keys[0])) return JSON.stringify({ ok: false, error: "ticket_id_conflict" });
      values.set(keys[0], argv[0]);
      sortedSet(keys[2]).set(argv[2], Number(argv[1]));
      sortedSet(keys[3]).set(argv[2], Number(argv[1]));
      sortedSet(keys[4]).delete(argv[2]);
      values.set(keys[1], argv[2]);
      return JSON.stringify({ ok: true });
    }
    if (script.includes("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end")) {
      if (failNextCompletionCommit) {
        failNextCompletionCommit = false;
        return 0;
      }
      if (values.get(keys[0]) !== argv[0]) return 0;
      values.set(keys[0], argv[1]);
      sortedSet(keys[1]).delete(argv[2]);
      sortedSet(keys[2]).set(argv[2], Number(argv[3]));
      if (argv[4]) sortedSet(keys[3]).set(argv[2], Number(argv[5]));
      if (values.get(keys[4]) === argv[2]) values.delete(keys[4]);
      return 1;
    }
    if (script.includes("ticket.creationEffectsPending=false")) {
      const ticket = JSON.parse(values.get(keys[0]) || "null");
      if (!ticket || ticket.ticketId !== argv[0]) return 0;
      ticket.creationEffectsPending = false;
      ticket.creationEffectsCompletedAt = argv[1];
      values.set(keys[0], JSON.stringify(ticket));
      return 1;
    }
    if (script.includes("ticket.completionEffectsPending=false")) {
      const ticket = JSON.parse(values.get(keys[0]) || "null");
      if (!ticket || ticket.completionOperationId !== argv[0]) return 0;
      ticket.completionEffectsPending = false;
      ticket.completionEffectsCompletedAt = argv[1];
      values.set(keys[0], JSON.stringify(ticket));
      sortedSet(keys[1]).delete(argv[2]);
      return 1;
    }
    if (script.includes("if ARGV[3]=='1' then redis.call('ZADD',KEYS[4]")) {
      sortedSet(keys[0]).set(argv[1], Number(argv[0]));
      sortedSet(keys[1]).delete(argv[1]);
      sortedSet(keys[2]).set(argv[1], Number(argv[0]));
      if (argv[2] === "1") sortedSet(keys[3]).set(argv[1], Number(argv[3]));
      else sortedSet(keys[3]).delete(argv[1]);
      if (values.get(keys[4]) === argv[1]) values.delete(keys[4]);
      return 1;
    }
    if (script.includes("state='started'") && script.includes("createdAt=ARGV[3]")) {
      const existingRaw = values.get(keys[0]);
      if (existingRaw) {
        const record = JSON.parse(existingRaw);
        if (record.requestHash !== argv[0]) {
          return JSON.stringify({ ok: false, error: "idempotency_conflict" });
        }
        return JSON.stringify({ ok: true, state: record.state || "started", record, isNew: false });
      }
      const record = {
        version: 1,
        state: "started",
        operationId: argv[1],
        requestHash: argv[0],
        createdAt: argv[2],
      };
      values.set(keys[0], JSON.stringify(record));
      return JSON.stringify({ ok: true, state: "started", record, isNew: true });
    }
    if (script.includes("if record.plan~=nil then") && script.includes("record.plan=plan")) {
      const record = JSON.parse(values.get(keys[0]) || "null");
      if (!record) return JSON.stringify({ ok: false, error: "operation_record_missing" });
      if (record.requestHash !== argv[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
      if (record.plan !== undefined) return JSON.stringify({ ok: true, record, created: false });
      record.plan = JSON.parse(argv[1]);
      record.planCreatedAt = argv[2];
      values.set(keys[0], JSON.stringify(record));
      return JSON.stringify({ ok: true, record, created: true });
    }
    if (script.includes("record.state='done'") && script.includes("completedAt=ARGV[3]")) {
      const existingRaw = values.get(keys[0]);
      if (!existingRaw) return JSON.stringify({ ok: false, error: "operation_record_missing" });
      const record = JSON.parse(existingRaw);
      if (record.requestHash !== argv[0]) {
        return JSON.stringify({ ok: false, error: "idempotency_conflict" });
      }
      if (record.state === "done") {
        return JSON.stringify({ ok: true, state: "done", record, idempotent: true });
      }
      record.state = "done";
      record.result = JSON.parse(argv[1]);
      record.completedAt = argv[2];
      values.set(keys[0], JSON.stringify(record));
      return JSON.stringify({ ok: true, state: "done", record, idempotent: false });
    }
    if (script.includes("local marked=redis.call('SET',KEYS[1],'1','NX')")) {
      if (values.has(keys[0])) return 0;
      values.set(keys[0], "1");
      const list = lists.get(keys[1]) || [];
      list.unshift(argv[0]);
      const max = Number(argv[1] || 500);
      lists.set(keys[1], list.slice(0, max));
      return 1;
    }
    if (script.includes("if raw=='done' then return 'done' end") && script.includes("return 'acquired'")) {
      const raw = values.get(keys[0]);
      if (raw === "done") return "done";
      if (raw) {
        let state = null;
        try { state = JSON.parse(raw); } catch {}
        const status = String(state?.status || "");
        if (["done", "sending", "uncertain"].includes(status)) return status;
        if (status !== "retryable") return "uncertain";
      }
      values.set(keys[0], argv[1]);
      return "acquired";
    }
    if (script.includes("local added=redis.call('SADD',KEYS[1],ARGV[1])")) {
      const membershipKey = args[2];
      const listKey = args[3];
      const orderId = args[4];
      if (!sets.has(membershipKey)) sets.set(membershipKey, new Set());
      const added = sets.get(membershipKey).has(orderId) ? 0 : 1;
      sets.get(membershipKey).add(orderId);
      if (added) {
        const list = lists.get(listKey) || [];
        list.push(orderId);
        lists.set(listKey, list);
      }
      return JSON.stringify({ ok: true, added });
    }
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
  if (name === "RPUSH") {
    const list = lists.get(args[0]) || [];
    list.push(...args.slice(1));
    lists.set(args[0], list);
    return list.length;
  }
  if (name === "LPOS") {
    const index = (lists.get(args[0]) || []).indexOf(args[1]);
    return index >= 0 ? index : null;
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
  if (name === "LINDEX") return (lists.get(args[0]) || [])[Number(args[1])] ?? null;
  if (name === "LSET") {
    const list = lists.get(args[0]) || [];
    const index = Number(args[1]);
    if (index < 0 || index >= list.length) return null;
    list[index] = args[2];
    lists.set(args[0], list);
    return "OK";
  }
  if (name === "HSET" || name === "HDEL") return 1;
  if (name === "SADD") {
    if (!sets.has(args[0])) sets.set(args[0], new Set());
    let added = 0;
    for (const member of args.slice(1)) {
      if (!sets.get(args[0]).has(member)) added += 1;
      sets.get(args[0]).add(member);
    }
    return added;
  }
  if (name === "SMEMBERS") return Array.from(sets.get(args[0]) || []);
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.resend.com") {
    const payload = JSON.parse(options.body || "{}");
    const email = String(Array.isArray(payload.to) ? payload.to[0] : payload.to || "").toLowerCase();
    resendRequests.push({ email, idempotencyKey: options.headers?.["Idempotency-Key"] || "", text: String(payload.text || "") });
    const remaining = Number(resendFailuresRemaining.get(email) || 0);
    if (remaining > 0) {
      resendFailuresRemaining.set(email, remaining - 1);
      return Response.json({ message: "test rejection" }, { status: 400 });
    }
    const uncertainRemaining = Number(resendUncertainFailuresRemaining.get(email) || 0);
    if (uncertainRemaining > 0) {
      resendUncertainFailuresRemaining.set(email, uncertainRemaining - 1);
      return Response.json({ message: "ambiguous upstream failure" }, { status: 500 });
    }
    return Response.json({ id: "after-sales-email-test-id" });
  }
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
const referenceNoticeRoute = await import("../app/api/admin/after-sales/notify-by-reference/route.js");
const store = await import("../app/api/after-sales/_store.js");
const adminOrderRoute = await import("../app/api/admin/orders/[orderId]/route.js");
const adminOrdersRoute = await import("../app/api/admin/orders/route.js");
const passwordUpdateRoute = await import("../app/api/order-password-update/[orderId]/route.js");
const passwordUpdateEmail = await import("../app/api/order-password-update/email.js");
const completionEffects = await import("../app/api/after-sales/_completion-effects.js");
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
      headers: { ...adminHeaders, "Idempotency-Key": "after-sales-incomplete-test-0001" },
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
      headers: { ...adminHeaders, "Idempotency-Key": "after-sales-complete-test-0001" },
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
  assert.equal(syncedOrder.items[0].account, "resolved-account@example.com");
  assert.equal(syncedOrder.items[0].password, "resolved-password");
  assert.equal(syncedOrder.items[0].staffAccount, "");
  assert.equal(syncedOrder.items[0].staffPassword, "");
  assert.equal(syncedOrder.account, "resolved-account@example.com");
  assert.equal(syncedOrder.password, "resolved-password");
  assert.equal(syncedOrder.status, "completed");
  assert.equal((await store.getAfterSalesCounts()).pending, 0);

  const repeatedCompletionResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${created.ticket.ticketId}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Idempotency-Key": "after-sales-repeat-test-0001" },
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

test("a dropped after-sales creation notification is drained from the existing active ticket", async () => {
  const order = orderRecord("LMAFTERSALESOUTBOX1", "creation-retry@example.com");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: order.orderId,
    email: order.email,
    exp: Date.now() + 60_000,
  });
  resendRequests.length = 0;
  resendFailuresRemaining.set(order.email, 2);

  const first = await customerRoute.POST(customerRequest(order, token, "首次通知投递失败后必须恢复"));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.notice.email, false);

  const retry = await customerRoute.POST(customerRequest(order, token, "首次通知投递失败后必须恢复"));
  assert.equal(retry.status, 409);
  const retryBody = await retry.json();
  assert.equal(retryBody.error, "pending_ticket_exists");
  assert.equal(retryBody.ticket.ticketId, firstBody.ticket.ticketId);
  assert.equal(retryBody.notice.recovered, true);
  assert.equal(retryBody.notice.email, true);
  const attempts = resendRequests.filter((entry) => entry.email === order.email);
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((entry) => entry.idempotencyKey)).size, 1);
  assert.ok(attempts[0].idempotencyKey);
  assert.equal((lists.get(`liumeiti:order-timeline:${order.orderId}`) || []).length, 1);
});

test("after-sales completion resumes the same operation without duplicating credential audit", async () => {
  const order = orderRecord("LMAFTERSALESCOMPLETE1", "completion-retry@example.com");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const ticket = {
    ticketId: "ASCOMPLETEOUTBOX1",
    orderId: order.orderId,
    status: "pending",
    locale: "zh",
    email: order.email,
    contact: "contact",
    issue: "账号需要重新配置并验证完成邮件恢复",
    items: [{ index: 0, service: "spotify", label: "Spotify", credentialManaged: true, account: "old@example.com", password: "old-password" }],
    createdAt: new Date().toISOString(),
  };
  assert.equal((await store.createAfterSalesTicket(ticket)).ok, true);
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const secondAdminToken = utils.signSession({ role: "admin", staffId: 2, staffUsername: "operator-two", staffRole: "operator", exp: Date.now() + 60_000 });
  const body = {
    status: "completed",
    staffNote: "已重新配置",
    items: [{ index: 0, account: "new@example.com", password: "new-password" }],
  };
  const request = (sessionToken = adminToken) => new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(sessionToken)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "after-sales-outbox-retry-0001",
    },
    body: JSON.stringify(body),
  });
  const missingKey = await adminDetailRoute.PATCH(new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, {
    method: "PATCH",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ ticketId: ticket.ticketId }) });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error, "idempotency_key_required");
  resendRequests.length = 0;
  resendFailuresRemaining.set(order.email, 2);

  const first = await adminDetailRoute.PATCH(request(), { params: Promise.resolve({ ticketId: ticket.ticketId }) });
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, "completion_email_retryable");
  const afterCommit = await store.getAfterSalesTicket(ticket.ticketId);
  assert.equal(afterCommit.status, "completed");
  assert.equal(afterCommit.completionEffectsPending, true);
  const orderAfterCommit = await utils.getOrderById(order.orderId);
  const committedRevision = orderAfterCommit.revision;
  assert.equal(orderAfterCommit.staffAudit.filter((entry) => entry.action === "after_sales_credentials_sync").length, 1);

  const drained = await completionEffects.settleAfterSalesCompletionEffects(
    afterCommit,
    afterCommit.completedBy,
  );
  assert.equal(drained.email, true);
  assert.equal(drained.settled, true);
  assert.equal((await store.getAfterSalesTicket(ticket.ticketId)).completionEffectsPending, false);

  const retry = await adminDetailRoute.PATCH(request(secondAdminToken), { params: Promise.resolve({ ticketId: ticket.ticketId }) });
  assert.equal(retry.status, 200);
  const retryBody = await retry.json();
  assert.equal(retryBody.ok, true);
  assert.equal(retryBody.changed, true);
  const orderAfterRetry = await utils.getOrderById(order.orderId);
  assert.equal(orderAfterRetry.revision, committedRevision);
  assert.equal(orderAfterRetry.staffAudit.filter((entry) => entry.action === "after_sales_credentials_sync").length, 1);
  const attempts = resendRequests.filter((entry) => entry.email === order.email);
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((entry) => entry.idempotencyKey)).size, 1);

  const replay = await adminDetailRoute.PATCH(request(), { params: Promise.resolve({ ticketId: ticket.ticketId }) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  assert.equal(resendRequests.filter((entry) => entry.email === order.email).length, 3);
  const conflict = await adminDetailRoute.PATCH(new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(secondAdminToken)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "after-sales-outbox-retry-0001",
    },
    body: JSON.stringify({ ...body, staffNote: "changed payload" }),
  }), { params: Promise.resolve({ ticketId: ticket.ticketId }) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");
});

test("a ticket commit failure cannot apply credential synchronization twice", async () => {
  const order = orderRecord("LMAFTERSALESSYNC1", "sync-once@example.com");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const ticket = {
    ticketId: "ASSYNCONCE1",
    orderId: order.orderId,
    status: "pending",
    locale: "zh",
    email: order.email,
    issue: "验证凭据同步只执行一次",
    items: [{ index: 0, service: "spotify", label: "Spotify", credentialManaged: true, account: "old@example.com", password: "old-password" }],
    createdAt: new Date().toISOString(),
  };
  assert.equal((await store.createAfterSalesTicket(ticket)).ok, true);
  const completion = {
    staffNote: "已修复",
    items: [{ index: 0, account: "fixed@example.com", password: "fixed-password" }],
    operationId: "a".repeat(64),
    requestHash: "b".repeat(64),
  };
  failNextCompletionCommit = true;
  const failed = await store.completeAfterSalesTicket(ticket.ticketId, completion, { staffId: 1, staffUsername: "admin" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "storage_failed");
  const afterFailedCommit = await utils.getOrderById(order.orderId);
  const revision = afterFailedCommit.revision;
  assert.equal(afterFailedCommit.staffAudit.filter((entry) => entry.action === "after_sales_credentials_sync").length, 1);

  const recovered = await store.completeAfterSalesTicket(ticket.ticketId, {
    ...completion,
    operationId: "c".repeat(64),
  }, { staffId: 1, staffUsername: "admin" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.changed, true);
  const afterRecovery = await utils.getOrderById(order.orderId);
  assert.equal(afterRecovery.revision, revision);
  assert.equal(afterRecovery.staffAudit.filter((entry) => entry.action === "after_sales_credentials_sync").length, 1);
  assert.equal(afterRecovery.items[0].password, "fixed-password");
});

test("reference notices resume only failed recipients from one immutable delivery plan", async () => {
  const reference = "REFNOTICEOUTBOX1";
  const firstOrder = {
    ...orderRecord("LMREFERENCEORDER1", "reference-one@example.com"),
    internalReference: reference,
    remark: "first immutable note",
  };
  const secondOrder = {
    ...orderRecord("LMREFERENCEORDER2", "reference-two@example.com"),
    internalReference: reference,
    remark: "second immutable note",
  };
  values.set(`liumeiti:orders:record:${firstOrder.orderId}`, JSON.stringify(firstOrder));
  values.set(`liumeiti:orders:record:${secondOrder.orderId}`, JSON.stringify(secondOrder));
  sets.set(`liumeiti:orders:reference:${reference}`, new Set([firstOrder.orderId, secondOrder.orderId]));
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const secondAdminToken = utils.signSession({ role: "admin", staffId: 2, staffUsername: "operator-two", staffRole: "operator", exp: Date.now() + 60_000 });
  const body = {
    reference,
    orderIds: [secondOrder.orderId, firstOrder.orderId],
    subject: "服务资料更新",
    message: "请使用邮件中的最新资料。",
  };
  const request = (sessionToken = adminToken) => new Request("https://www.liumeiti.vip/api/admin/after-sales/notify-by-reference", {
    method: "POST",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(sessionToken)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "reference-notice-retry-0001",
    },
    body: JSON.stringify(body),
  });
  resendRequests.length = 0;
  resendFailuresRemaining.set(secondOrder.email, 2);

  const first = await referenceNoticeRoute.POST(request());
  assert.equal(first.status, 503);
  const firstBody = await first.json();
  assert.equal(firstBody.partial, true);
  assert.equal(firstBody.delivered, 1);
  const plannedOperation = [...values.entries()]
    .filter(([key]) => key.startsWith("liumeiti:durable-operation:v1:") && !key.endsWith(":lock"))
    .map(([, raw]) => { try { return JSON.parse(raw); } catch { return null; } })
    .find((record) => record?.plan?.reference === reference);
  assert.equal(plannedOperation?.state, "started");

  const mutated = { ...secondOrder, remark: "MUTATED CONTENT MUST NOT LEAK INTO RETRY" };
  values.set(`liumeiti:orders:record:${secondOrder.orderId}`, JSON.stringify(mutated));
  const retry = await referenceNoticeRoute.POST(request(secondAdminToken));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).delivered, 2);
  assert.equal(JSON.parse(values.get(`liumeiti:durable-operation:v1:${plannedOperation.operationId}`)).state, "done");
  const firstRecipientAttempts = resendRequests.filter((entry) => entry.email === firstOrder.email);
  const secondRecipientAttempts = resendRequests.filter((entry) => entry.email === secondOrder.email);
  assert.equal(firstRecipientAttempts.length, 1);
  assert.equal(secondRecipientAttempts.length, 3);
  assert.equal(new Set(secondRecipientAttempts.map((entry) => entry.idempotencyKey)).size, 1);
  assert.match(secondRecipientAttempts.at(-1).text, /second immutable note/);
  assert.doesNotMatch(secondRecipientAttempts.at(-1).text, /MUTATED CONTENT/);

  const replay = await referenceNoticeRoute.POST(request());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  assert.equal(resendRequests.filter((entry) => entry.email === firstOrder.email).length, 1);
  assert.equal(resendRequests.filter((entry) => entry.email === secondOrder.email).length, 3);
});

test("an uncertain reference delivery enters manual review and is never automatically resent", async () => {
  const reference = "REFNOTICEUNCERTAIN1";
  const order = {
    ...orderRecord("LMREFERENCEUNCERTAIN1", "reference-uncertain@example.com"),
    internalReference: reference,
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  sets.set(`liumeiti:orders:reference:${reference}`, new Set([order.orderId]));
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const body = { reference, orderIds: [order.orderId], subject: "人工核对通知", message: "此通知结果需要人工核对。" };
  const request = () => new Request("https://www.liumeiti.vip/api/admin/after-sales/notify-by-reference", {
    method: "POST",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "reference-notice-uncertain-0001",
    },
    body: JSON.stringify(body),
  });
  resendRequests.length = 0;
  resendUncertainFailuresRemaining.set(order.email, 2);
  const first = await referenceNoticeRoute.POST(request());
  assert.equal(first.status, 409);
  const firstBody = await first.json();
  assert.equal(firstBody.manualReview, true);
  assert.equal(firstBody.error, "reference_notice_delivery_uncertain");
  assert.equal(resendRequests.filter((entry) => entry.email === order.email).length, 2);

  const retry = await referenceNoticeRoute.POST(request());
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).manualReview, true);
  assert.equal(resendRequests.filter((entry) => entry.email === order.email).length, 2);
});

test("concurrent completion outbox keepers dispatch one provider request", async () => {
  const order = orderRecord("LMAFTERSALESKEEPER1", "keeper-once@example.com");
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const ticket = {
    ticketId: "ASKEEPERONCE1",
    orderId: order.orderId,
    status: "pending",
    locale: "zh",
    email: order.email,
    issue: "并发 keeper 只能发送一次完成邮件",
    items: [{ index: 0, service: "spotify", label: "Spotify", credentialManaged: true, account: "old@example.com", password: "old-password" }],
    createdAt: new Date().toISOString(),
  };
  assert.equal((await store.createAfterSalesTicket(ticket)).ok, true);
  const completed = await store.completeAfterSalesTicket(ticket.ticketId, {
    staffNote: "已完成",
    items: [{ index: 0, account: "keeper@example.com", password: "keeper-password" }],
    operationId: "d".repeat(64),
    requestHash: "e".repeat(64),
  }, { staffId: 1, staffUsername: "admin" });
  assert.equal(completed.ok, true);
  resendRequests.length = 0;
  const results = await Promise.all([
    completionEffects.settleAfterSalesCompletionEffects(completed.ticket, completed.ticket.completedBy),
    completionEffects.settleAfterSalesCompletionEffects(completed.ticket, completed.ticket.completedBy),
  ]);
  assert.equal(resendRequests.filter((entry) => entry.email === order.email).length, 1);
  assert.equal(results.filter((result) => result.email).length, 1);
  assert.ok(results.some((result) => result.pending || result.uncertain));
  assert.equal((await store.getAfterSalesTicket(ticket.ticketId)).completionEffectsPending, false);
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
  const correctionBody = {
    action: "spotify_password_error",
    itemIndex: 0,
    staffNote: "请确认密码可正常登录",
    expectedRevision: 0,
  };
  const correctionHeaders = {
    cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "spotify-password-error-test-0001",
  };
  const adminResponse = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: correctionHeaders,
      body: JSON.stringify(correctionBody),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(adminResponse.status, 200);
  const adminResult = await adminResponse.json();
  assert.equal(adminResult.ok, true);
  const indexedOrderIds = lists.get("liumeiti:orders:index") || [];
  assert.equal(indexedOrderIds.filter((orderId) => orderId === order.orderId).length, 1);
  assert.equal(adminResult.order.items[0].passwordCorrectionStaffNote, "请确认密码可正常登录");
  assert.equal(Object.hasOwn(adminResult.order.items[0], "passwordCorrectionTokenHash"), false);
  const retryResponse = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: correctionHeaders,
      body: JSON.stringify(correctionBody),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(retryResponse.status, 200);
  const retryResult = await retryResponse.json();
  assert.equal(retryResult.idempotent, true);
  assert.equal(retryResult.order.items[0].passwordCorrectionRequestVersion, 1);
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
  assert.match(emailPreview.text, /Spotify 密码错误/);
  assert.doesNotMatch(emailPreview.text, /无法通过验证/);
  assert.match(emailPreview.text, /点击下方按钮前往安全表单/);
  assert.match(emailPreview.html, /请确认密码可正常登录/);
  assert.match(emailPreview.html, /提交新的 Spotify 密码/);
  assert.match(emailPreview.html, /忘记 Spotify 密码？点击去找回/);
  assert.match(emailPreview.html, /https:\/\/accounts\.spotify\.com\/en\/password-reset/);

  const englishEmailPreview = passwordUpdateEmail.buildSpotifyPasswordErrorEmail({
    order: { ...order, locale: "en" },
    item: order.items[0],
    updateUrl: "https://www.liumeiti.vip/order-update/spotify/test#token=token",
    brandName: "Maoyang Taiwan Inc.",
    siteDomain: "www.liumeiti.vip",
  });
  assert.match(englishEmailPreview.text, /password submitted with this order is incorrect/i);
  assert.doesNotMatch(englishEmailPreview.text, /couldn't verify/i);
  assert.match(englishEmailPreview.html, /Submit new Spotify password/);
  assert.match(englishEmailPreview.html, /Forgot your Spotify password\? Reset it on Spotify/);
  assert.match(englishEmailPreview.html, /https:\/\/accounts\.spotify\.com\/en\/password-reset/);

  const token = "known-password-correction-token";
  const storedAfterMail = JSON.parse(lists.get("liumeiti:orders")[0]);
  storedAfterMail.items[0].passwordCorrectionTokenHash = createHash("sha256").update(token).digest("hex");
  storedAfterMail.items[0].passwordCorrectionExpiresAt = new Date(Date.now() + 60_000).toISOString();
  // Keep a stale legacy copy to verify the indexed record remains authoritative.
  lists.set("liumeiti:orders", [JSON.stringify(storedAfterMail)]);
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(storedAfterMail));

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
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "spotify-customer-update-test-0001",
        },
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
  const mergedOrders = await utils.getAllOrders();
  assert.equal(mergedOrders.find((item) => item.orderId === order.orderId)?.items?.[0]?.password, "correct-password");
  assert.equal(JSON.parse(lists.get("liumeiti:orders")[0]).items[0].password, "old-password");
  assert.equal((lists.get("liumeiti:orders:index") || []).filter((orderId) => orderId === order.orderId).length, 1);
  const unauthenticatedDetail = await adminOrderRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(unauthenticatedDetail.status, 401);
  const adminDetailResponse = await adminOrderRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(adminDetailResponse.status, 200);
  const adminDetail = await adminDetailResponse.json();
  assert.equal(adminDetail.order.items[0].account, "correct-account@example.com");
  assert.equal(adminDetail.order.items[0].password, "correct-password");
  assert.equal(Object.hasOwn(adminDetail.order.items[0], "passwordCorrectionTokenHash"), false);
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
      headers: { ...adminHeaders, "Idempotency-Key": "after-sales-legacy-complete-test-0001" },
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
