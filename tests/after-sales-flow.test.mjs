import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeOrderCasEval } from "./helpers/order-cas-redis-mock.mjs";
import { executeDurableOperationEval } from "./helpers/durable-operation-redis-mock.mjs";

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
let failNextTimelineWrite = false;
let failNextAdminActionWrite = false;
let dropNextDurableCompletionResponse = false;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function mockKeyType(key) {
  if (values.has(key)) return typeof values.get(key) === "string" ? "string" : "other";
  if (lists.has(key)) return "list";
  if (sortedSets.has(key)) return "zset";
  if (sets.has(key)) return "set";
  return "none";
}

function deleteMockKey(key) {
  values.delete(key);
  lists.delete(key);
  sortedSets.delete(key);
  sets.delete(key);
}

function setMockString(key, value) {
  deleteMockKey(key);
  values.set(key, String(value));
}

function validAuthVersionRaw(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 9007199254740990;
}

function validBalanceRaw(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function clearDeliveryIndexes(keys, member) {
  keys.slice(1, 4).forEach((key) => sortedSet(key).delete(member));
}

function indexDelivery(keys, status, score, member) {
  clearDeliveryIndexes(keys, member);
  const index = status === "sending" ? 1 : status === "uncertain" ? 2 : status === "retryable" ? 3 : 0;
  if (index) sortedSet(keys[index]).set(member, Number(score));
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SISMEMBER") return sets.get(args[0])?.has(String(args[1])) ? 1 : 0;
  if (name === "SMISMEMBER") return args.slice(1).map((member) => sets.get(args[0])?.has(String(member)) ? 1 : 0);
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
    const durable = executeDurableOperationEval(command, { values, sortedSet });
    if (durable.handled) return durable.result;
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("identityCount=redis.call('INCR'") && script.includes("ipCount=redis.call('INCR'")) {
      const identityCount = Number(values.get(keys[0]) || 0) + 1;
      const ipCount = Number(values.get(keys[1]) || 0) + 1;
      values.set(keys[0], String(identityCount));
      values.set(keys[1], String(ipCount));
      return JSON.stringify({ ok: true, identityCount, ipCount, identityTtl: Number(argv[0]), ipTtl: Number(argv[0]) });
    }
    if (script.includes("return 'matched'") && script.includes("tostring(record.code or '')")) {
      const raw = values.get(keys[0]);
      if (!raw) return "missing";
      let record = null;
      try { record = JSON.parse(raw); } catch {}
      if (!record || String(record.email || "") !== argv[0]
        || String(record.query || "") !== argv[1]
        || String(record.code || "") !== argv[2]) return "invalid";
      values.delete(keys[0]);
      return "matched";
    }
    if (script.includes("READ_USER_AUTH_STATE_V3") || script.includes("FORCE_REPAIR_USER_AUTH_STATE_V1")) {
      const userRaw = mockKeyType(keys[0]) === "string" ? values.get(keys[0]) : null;
      if (!userRaw) return JSON.stringify({ ok: false, error: "session_revoked" });

      const versionRaw = mockKeyType(keys[1]) === "string" ? values.get(keys[1]) : null;
      const repairedAuthVersion = !validAuthVersionRaw(versionRaw);
      const authVersion = repairedAuthVersion ? 1 : Number(versionRaw);
      if (repairedAuthVersion) setMockString(keys[1], "1");

      const balanceRaw = mockKeyType(keys[2]) === "string" ? values.get(keys[2]) : null;
      const repairedBalance = mockKeyType(keys[2]) !== "none" && !validBalanceRaw(balanceRaw);
      const balanceCents = validBalanceRaw(balanceRaw) ? balanceRaw : null;
      if (repairedBalance) deleteMockKey(keys[2]);

      const lifecycleRaw = mockKeyType(keys[3]) === "string" ? values.get(keys[3]) : null;
      const repairedLifecycle = !/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""));
      const lifecycle = repairedLifecycle ? argv[0] : lifecycleRaw;
      if (!/^[a-f0-9]{32}$/.test(String(lifecycle || ""))) {
        return JSON.stringify({ ok: false, error: "invalid_lifecycle_candidate" });
      }
      if (repairedLifecycle) setMockString(keys[3], lifecycle);
      return JSON.stringify({
        ok: true,
        userRaw,
        authVersion,
        accountLifecycleId: lifecycle,
        balanceCents,
        repairedAuthVersion,
        repairedBalance,
        repairedLifecycle,
      });
    }
    if (script.includes("CONTACT_CAS_V2")) {
      const existing = values.get(keys[0]);
      const revision = existing ? Number(JSON.parse(existing).revision || 0) : 0;
      if (revision !== Number(argv[0])) return 0;
      sortedSet(keys[1]).set(String(argv[3]), Number(argv[2]));
      values.set(keys[0], argv[1]);
      return 1;
    }
    if (script.includes("current=tonumber(doc.revision or 0)")) {
      const existing = values.get(keys[0]);
      const revision = existing ? Number(JSON.parse(existing).revision || 0) : 0;
      if (revision !== Number(argv[0])) return 0;
      values.set(keys[0], argv[1]);
      return 1;
    }
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
      sortedSet(keys[5]).set(argv[2], Number(argv[1]));
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
      if (argv[6] === "1") sortedSet(keys[3]).set(argv[2], Number(argv[5]));
      if (values.get(keys[4]) === argv[2]) values.delete(keys[4]);
      return 1;
    }
    if (script.includes("if ARGV[3]=='completion'") && script.includes("raw~=ARGV[1]")) {
      const raw = values.get(keys[0]);
      if (!raw) return 0;
      if (raw !== argv[0]) return -1;
      const ticket = JSON.parse(raw);
      if (argv[2] === "completion" && ticket.completionOperationId !== argv[3]) return 0;
      if (argv[2] === "creation" && ticket.ticketId !== argv[4]) return 0;
      values.set(keys[0], argv[1]);
      sortedSet(keys[1]).delete(argv[4]);
      return 1;
    }
    if (script.includes("if ARGV[3]=='1' then redis.call('ZADD',KEYS[4]")) {
      sortedSet(keys[0]).set(argv[1], Number(argv[0]));
      sortedSet(keys[1]).delete(argv[1]);
      sortedSet(keys[2]).set(argv[1], Number(argv[0]));
      if (argv[2] === "1") sortedSet(keys[3]).set(argv[1], Number(argv[3]));
      else sortedSet(keys[3]).delete(argv[1]);
      if (values.get(keys[4]) === argv[1]) values.delete(keys[4]);
      if (argv[4] === "1") sortedSet(keys[5]).set(argv[1], Number(argv[0]));
      else sortedSet(keys[5]).delete(argv[1]);
      return 1;
    }
    if (script.includes("local marked=redis.call('SET',KEYS[1],'1','NX')")) {
      if (failNextTimelineWrite && String(keys[1]).startsWith("liumeiti:order-timeline:")) {
        failNextTimelineWrite = false;
        return null;
      }
      if (failNextAdminActionWrite && String(keys[1]) === "liumeiti:admin:action-log") {
        failNextAdminActionWrite = false;
        return null;
      }
      if (values.has(keys[0])) return 0;
      values.set(keys[0], "1");
      const list = lists.get(keys[1]) || [];
      list.unshift(argv[0]);
      const max = Number(argv[1] || 500);
      lists.set(keys[1], list.slice(0, max));
      return 1;
    }
    if (script.includes("return 'acquired'") && script.includes("indexStatus")) {
      const raw = values.get(keys[0]);
      if (raw === "done") {
        clearDeliveryIndexes(keys, argv[3]);
        return "done";
      }
      if (raw) {
        let state = null;
        try { state = JSON.parse(raw); } catch {}
        const status = String(state?.status || "");
        if (status === "done") {
          clearDeliveryIndexes(keys, argv[3]);
          return "done";
        }
        if (["sending", "uncertain"].includes(status)) {
          indexDelivery(keys, status, state?.score || argv[2], argv[3]);
          return status;
        }
        if (status !== "retryable") return "uncertain";
      }
      values.set(keys[0], argv[1]);
      indexDelivery(keys, "sending", argv[2], argv[3]);
      return "acquired";
    }
    if (script.includes("ARGV[3]=='sending'") && script.includes("return 1")) {
      const current = JSON.parse(values.get(keys[0]) || "null");
      if (!current || current.token !== argv[0]) return 0;
      values.set(keys[0], argv[1]);
      indexDelivery(keys, argv[2], argv[3], argv[4]);
      return 1;
    }
    if (script.includes("redis.call('SET',KEYS[1],'done')")) {
      const raw = values.get(keys[0]);
      if (raw === "done") {
        clearDeliveryIndexes(keys, argv[1]);
        return 1;
      }
      const current = JSON.parse(raw || "null");
      if (!current || current.token !== argv[0]) return 0;
      values.set(keys[0], "done");
      clearDeliveryIndexes(keys, argv[1]);
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
  if (name === "ZRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return [...sortedSet(args[0]).entries()]
      .sort((a, b) => a[1] - b[1])
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
    const rows = commands.map((command) => ({ result: execute(command) }));
    if (dropNextDurableCompletionResponse
      && commands.some((command) => String(command?.[1] || "").includes("durable_complete_v2_lossless"))) {
      dropNextDurableCompletionResponse = false;
      // The completion Lua script committed, but the Upstash HTTP response was
      // lost. The route must read back the journal and still report success.
      return Response.json({ error: "simulated lost completion response" }, { status: 503 });
    }
    return Response.json(rows);
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
const orderQueryRoute = await import("../app/api/order-query/route.js");
const authMeRoute = await import("../app/api/auth/me/route.js");
const authSession = await import("../app/api/_auth-session.js");
const completionEmail = await import("../app/api/order/completion-email.js");
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

test("after-sales Redis double mirrors V3 auth repair under least-favorable key shapes", () => {
  const keys = [
    "liumeiti:users:after-sales-auth-double@example.com",
    "lm:user:authver:after-sales-auth-double@example.com",
    "liumeiti:users:after-sales-auth-double@example.com:balance:cents",
    "lm:user:lifecycle:after-sales-auth-double@example.com",
  ];
  const lifecycle = "0123456789abcdef0123456789abcdef";
  values.set(keys[0], JSON.stringify({ email: "after-sales-auth-double@example.com", balance: 12.5 }));
  lists.set(keys[1], [""]);
  sets.set(keys[2], new Set(["12.5"]));
  sortedSet(keys[3]).set("invalid", 1);

  const repairedTypes = JSON.parse(execute(["EVAL", "-- READ_USER_AUTH_STATE_V3", "4", ...keys, lifecycle]));
  assert.equal(repairedTypes.ok, true);
  assert.equal(repairedTypes.authVersion, 1);
  assert.equal(repairedTypes.balanceCents, null);
  assert.equal(repairedTypes.accountLifecycleId, lifecycle);
  assert.equal(values.get(keys[1]), "1");
  assert.equal(mockKeyType(keys[2]), "none");
  assert.equal(values.get(keys[3]), lifecycle);

  values.set(keys[1], "not-a-version");
  values.set(keys[2], "12.5");
  values.set(keys[3], "INVALID-LIFECYCLE");
  const forced = JSON.parse(execute(["EVAL", "-- FORCE_REPAIR_USER_AUTH_STATE_V1", "4", ...keys, lifecycle]));
  assert.equal(forced.ok, true);
  assert.equal(forced.authVersion, 1);
  assert.equal(forced.balanceCents, null);
  assert.equal(forced.accountLifecycleId, lifecycle);
  keys.forEach(deleteMockKey);
});

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
      body: JSON.stringify({ status: "completed", credentialOrderHash: detail.ticket.credentialOrderHash, items: [{ index: 0, account: "", password: "resolved-password" }] }),
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
        credentialOrderHash: detail.ticket.credentialOrderHash,
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
  const credentialOrderHash = (await store.hydrateAfterSalesTicketCredentials(ticket)).credentialOrderHash;
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const secondAdminToken = utils.signSession({ role: "admin", staffId: 2, staffUsername: "operator-two", staffRole: "operator", exp: Date.now() + 60_000 });
  const body = {
    status: "completed",
    staffNote: "已重新配置",
    credentialOrderHash,
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

  // A later legitimate order edit must win over the stale ticket snapshot
  // when the same completion is recovered.
  afterFailedCommit.items[0].account = "newer-order-account@example.com";
  afterFailedCommit.items[0].password = "newer-order-password";
  afterFailedCommit.account = "newer-order-account@example.com";
  afterFailedCommit.password = "newer-order-password";
  assert.equal(await utils.setOrderAt(
    { orderId: order.orderId, legacyIndex: null },
    afterFailedCommit,
    { expectedRevision: revision },
  ), true);
  const revisionAfterLaterEdit = afterFailedCommit.revision;

  const recovered = await store.completeAfterSalesTicket(ticket.ticketId, {
    ...completion,
    operationId: "c".repeat(64),
  }, { staffId: 1, staffUsername: "admin" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.changed, true);
  const afterRecovery = await utils.getOrderById(order.orderId);
  assert.equal(afterRecovery.revision, revisionAfterLaterEdit);
  assert.equal(afterRecovery.staffAudit.filter((entry) => entry.action === "after_sales_credentials_sync").length, 1);
  assert.equal(afterRecovery.items[0].account, "newer-order-account@example.com");
  assert.equal(afterRecovery.items[0].password, "newer-order-password");
  const sendsBeforeRecovery = resendRequests.length;
  const effects = await completionEffects.settleAfterSalesCompletionEffects(recovered.ticket, recovered.ticket.completedBy);
  assert.equal(effects.email, true);
  const recoveryMail = resendRequests.slice(sendsBeforeRecovery).find((entry) => entry.email === order.email);
  assert.match(recoveryMail?.text || "", /newer-order-account@example\.com/);
  assert.match(recoveryMail?.text || "", /newer-order-password/);
  assert.doesNotMatch(recoveryMail?.text || "", /fixed-password/);
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

  const mutated = {
    ...secondOrder,
    remark: "MUTATED CONTENT MUST NOT LEAK INTO RETRY",
    account: "latest-reference-account@example.com",
    password: "latest-reference-password",
    items: [{
      ...secondOrder.items[0],
      account: "latest-reference-account@example.com",
      password: "latest-reference-password",
    }],
  };
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
  assert.match(secondRecipientAttempts.at(-1).text, /latest-reference-account@example\.com/);
  assert.match(secondRecipientAttempts.at(-1).text, /latest-reference-password/);
  assert.doesNotMatch(secondRecipientAttempts.at(-1).text, /original-password/);

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
    account: "old-account@example.com",
    password: "old-password",
    staffAccount: "stale-staff-account@example.com",
    staffPassword: "stale-staff-password",
    items: [{
      service: "spotify",
      label: "Spotify · 家庭成员",
      account: "old-account@example.com",
      password: "old-password",
      amount: 128,
    }, {
      service: "netflix",
      label: "Netflix",
      account: "second-item@example.com",
      password: "second-item-password",
      amount: 68,
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
  failNextTimelineWrite = true;
  failNextAdminActionWrite = true;
  dropNextDurableCompletionResponse = true;
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
  assert.deepEqual(patched.audit, { timelineRecorded: false, adminLogRecorded: false });
  // 用规范读路径断言(record 优先),与全站读取行为一致。
  const finalOrder = await utils.getOrderById(order.orderId);
  assert.equal(finalOrder.items[0].account, "correct-account@example.com");
  assert.equal(finalOrder.items[0].password, "correct-password");
  assert.equal(finalOrder.account, "correct-account@example.com");
  assert.equal(finalOrder.password, "correct-password");
  assert.equal(finalOrder.staffAccount, "");
  assert.equal(finalOrder.staffPassword, "");
  assert.equal(finalOrder.items[1].account, "second-item@example.com");
  assert.equal(finalOrder.items[1].password, "second-item-password");
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

  const replayResponse = await passwordUpdateRoute.PATCH(
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
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).idempotent, true);

  const reusedLinkResponse = await passwordUpdateRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/order-password-update/${order.orderId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "spotify-customer-update-test-0002",
      },
      body: JSON.stringify({
        account: "silently-dropped@example.com",
        password: "must-not-be-reported-as-saved",
        email: "updated@example.com",
        contact: "updated-contact",
        remark: "second submission",
      }),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(reusedLinkResponse.status, 410);
  assert.equal((await reusedLinkResponse.json()).error, "update_link_used");
  const rejectedPrincipal = `${order.orderId}:${createHash("sha256").update(token).digest("hex")}`;
  const rejectedOperationId = createHash("sha256")
    .update(`spotify-password-update\0${rejectedPrincipal}\0spotify-customer-update-test-0002`)
    .digest("hex");
  assert.equal(
    values.has(`liumeiti:durable-operation:v1:${rejectedOperationId}`),
    false,
    "a terminal update_link_used response must not create a permanent started operation",
  );
  const afterRejectedReuse = await utils.getOrderById(order.orderId);
  assert.equal(afterRejectedReuse.items[0].account, "correct-account@example.com");
  assert.equal(afterRejectedReuse.items[0].password, "correct-password");

  const resolvedResponse = await adminOrdersRoute.GET(new Request(
    "https://www.liumeiti.vip/api/admin/orders?status=abnormal",
    { headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` } },
  ));
  const resolvedResult = await resolvedResponse.json();
  assert.equal(resolvedResult.orders.some((item) => item.orderId === order.orderId), false);
});

test("admin credential edits keep bundled order primary credential fields synchronized", async () => {
  const order = {
    orderId: "LMADMINCREDENTIALSYNC1",
    status: "received",
    revision: 0,
    createdAt: new Date().toISOString(),
    locale: "zh",
    email: "admin-edit-buyer@example.com",
    account: "legacy-old@example.com",
    password: "legacy-old-password",
    staffAccount: "legacy-staff-old@example.com",
    staffPassword: "legacy-staff-old-password",
    items: [{
      service: "spotify",
      label: "Spotify · 家庭成员",
      account: "item-old@example.com",
      password: "item-old-password",
      staffAccount: "item-staff-old@example.com",
      staffPassword: "item-staff-old-password",
      amount: 128,
    }, {
      service: "netflix",
      label: "Netflix",
      account: "untouched-second@example.com",
      password: "untouched-second-password",
      amount: 68,
    }],
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const response = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "admin-credential-sync-test-0001",
      },
      body: JSON.stringify({
        expectedRevision: 0,
        items: [{
          index: 0,
          account: "admin-new@example.com",
          password: "admin-new-password",
          staffAccount: "",
          staffPassword: "",
        }],
      }),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  assert.equal(response.status, 200);
  const persisted = await utils.getOrderById(order.orderId);
  assert.equal(persisted.items[0].account, "admin-new@example.com");
  assert.equal(persisted.items[0].password, "admin-new-password");
  assert.equal(persisted.account, "admin-new@example.com");
  assert.equal(persisted.password, "admin-new-password");
  assert.equal(persisted.staffAccount, "");
  assert.equal(persisted.staffPassword, "");
  assert.equal(persisted.items[1].account, "untouched-second@example.com");
  assert.equal(persisted.items[1].password, "untouched-second-password");
});

test("admin cannot complete a staff-credential service with blank delivery credentials", async () => {
  const order = {
    orderId: "LMADMINMISSINGCREDENTIAL1",
    status: "received",
    revision: 0,
    createdAt: new Date().toISOString(),
    locale: "zh",
    email: "missing-credential-buyer@example.com",
    items: [{
      service: "netflix",
      label: "Netflix",
      account: "",
      password: "",
      staffAccount: "",
      staffPassword: "",
      amount: 168,
    }],
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const operationCountBefore = [...values.keys()]
    .filter((key) => key.startsWith("liumeiti:durable-operation:v1:") && !key.endsWith(":lock")).length;
  const response = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "admin-missing-credential-test-0001",
      },
      body: JSON.stringify({
        expectedRevision: 0,
        status: "completed",
        items: [{ index: 0, staffAccount: "", staffPassword: "" }],
      }),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  const result = await response.json();
  assert.equal(response.status, 400, JSON.stringify(result));
  assert.equal(result.error, "completion_credentials_required");
  assert.equal(result.itemIndex, 0);
  assert.equal((await utils.getOrderById(order.orderId)).status, "received");
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith("liumeiti:durable-operation:v1:") && !key.endsWith(":lock")).length,
    operationCountBefore,
    "invalid completion input is rejected before creating a durable operation",
  );
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
    account: "",
    password: "",
    staffAccount: "current-ai-account@example.com",
    staffPassword: "current-ai-password",
    items: [{
      service: "ai",
      label: "AI 会员 · GPT Plus",
      plan: "gpt-plus",
      amount: 229,
      account: "",
      password: "",
      staffAccount: "current-ai-account@example.com",
      staffPassword: "current-ai-password",
    }, {
      service: "netflix",
      label: "Netflix",
      amount: 68,
      account: "second-after-sales@example.com",
      password: "second-after-sales-password",
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
        credentialOrderHash: detail.ticket.credentialOrderHash,
        items: [{ index: 0, account: "new-ai-account@example.com", password: "new-ai-password" }],
      }),
    }),
    { params: Promise.resolve({ ticketId: "ASLEGACYAI1" }) },
  );
  assert.equal(completedResponse.status, 200);
  const syncedOrder = await utils.getOrderById(order.orderId);
  assert.equal(syncedOrder.items[0].staffAccount, "new-ai-account@example.com");
  assert.equal(syncedOrder.items[0].staffPassword, "new-ai-password");
  assert.equal(syncedOrder.staffAccount, "new-ai-account@example.com");
  assert.equal(syncedOrder.staffPassword, "new-ai-password");
  assert.equal(syncedOrder.account, "");
  assert.equal(syncedOrder.password, "");
  assert.equal(syncedOrder.items[1].account, "second-after-sales@example.com");
  assert.equal(syncedOrder.items[1].password, "second-after-sales-password");
});

test("legacy no-items credentials stay consistent across customer, admin, after-sales, and email flows", async () => {
  const order = {
    orderId: "LMLEGACYNITEMS1",
    status: "completed",
    locale: "en",
    email: "legacy-no-items@example.com",
    service: "ai",
    serviceLabel: "AI membership · GPT Plus",
    plan: "gpt-plus",
    cycle: "1year",
    finalAmount: 229,
    account: "buyer-legacy@example.com",
    password: "buyer-legacy-password",
    staffAccount: "staff-legacy@example.com",
    staffPassword: "staff-legacy-password",
    createdAt: new Date().toISOString(),
    revision: 0,
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  lists.set("liumeiti:orders:index", [
    order.orderId,
    ...(lists.get("liumeiti:orders:index") || []).filter((id) => id !== order.orderId),
  ]);
  lists.set(`liumeiti:orders:email:${order.email}`, [order.orderId]);

  const emailStart = resendRequests.length;
  const sendCodeResponse = await orderQueryRoute.POST(new Request("https://www.liumeiti.vip/api/order-query", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "locale=en" },
    body: JSON.stringify({ query: order.orderId }),
  }));
  assert.equal(sendCodeResponse.status, 200);
  const verificationMail = resendRequests.slice(emailStart).find((entry) => entry.email === order.email);
  assert.ok(verificationMail);
  const verificationCode = verificationMail.text.match(/\b(\d{6})\b/)?.[1];
  assert.match(verificationCode || "", /^\d{6}$/);
  const queryResponse = await orderQueryRoute.POST(new Request("https://www.liumeiti.vip/api/order-query", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "locale=en" },
    body: JSON.stringify({ query: order.orderId, code: verificationCode }),
  }));
  const queried = await queryResponse.json();
  assert.equal(queryResponse.status, 200, JSON.stringify(queried));
  assert.equal(queried.orders[0].items[0].account, order.staffAccount);
  assert.equal(queried.orders[0].items[0].password, order.staffPassword);
  assert.equal(queried.orders[0].account, order.staffAccount);
  assert.equal(queried.orders[0].password, order.staffPassword);

  const lifecycleId = "1234567890abcdef1234567890abcdef";
  values.set(`liumeiti:users:${order.email}`, JSON.stringify({
    email: order.email,
    username: "legacy-user",
    avatarId: "avatar-01",
    inviteCode: "MYLEGACY01",
    coupons: [],
    balance: 0,
  }));
  values.set(`lm:user:authver:${order.email}`, "1");
  values.set(`lm:user:lifecycle:${order.email}`, lifecycleId);
  values.set(`liumeiti:users:${order.email}:balance:cents`, "0");
  const userToken = authSession.signUserSessionForVersion(order.email, 1);
  const meResponse = await authMeRoute.GET(new Request("https://www.liumeiti.vip/api/auth/me", {
    headers: { cookie: `lm_user=${encodeURIComponent(userToken)}; locale=en` },
  }));
  const me = await meResponse.json();
  assert.equal(meResponse.status, 200, JSON.stringify(me));
  assert.equal(me.orders[0].items[0].account, order.staffAccount);
  assert.equal(me.orders[0].items[0].password, order.staffPassword);

  const html = completionEmail.buildCompletionEmailHtml({
    order,
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  const text = completionEmail.buildCompletionEmailText({
    order,
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  assert.match(html, /staff-legacy@example\.com/);
  assert.match(html, /staff-legacy-password/);
  assert.doesNotMatch(html, /buyer-legacy-password/);
  assert.match(text, /staff-legacy@example\.com/);
  assert.match(text, /staff-legacy-password/);
  assert.doesNotMatch(text, /buyer-legacy-password/);

  const afterSalesToken = utils.signSession({
    type: "after-sales-order",
    orderId: order.orderId,
    email: order.email,
    exp: Date.now() + 60_000,
  });
  const ticketResponse = await customerRoute.POST(new Request("https://www.liumeiti.vip/api/after-sales", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: order.orderId,
      token: afterSalesToken,
      issue: "The legacy AI account cannot sign in and needs support.",
      items: [{ index: 0 }],
    }),
  }));
  const ticket = await ticketResponse.json();
  assert.equal(ticketResponse.status, 200, JSON.stringify(ticket));
  const storedTicket = await store.getAfterSalesTicket(ticket.ticket.ticketId);
  assert.equal(storedTicket.items[0].account, order.staffAccount);
  assert.equal(storedTicket.items[0].password, order.staffPassword);

  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const adminCookie = `lm_admin=${encodeURIComponent(adminToken)}`;
  const listResponse = await adminOrdersRoute.GET(new Request(
    `https://www.liumeiti.vip/api/admin/orders?q=${encodeURIComponent(order.staffPassword)}&limit=50`,
    { headers: { cookie: adminCookie } },
  ));
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200, JSON.stringify(listed));
  const listedOrder = listed.orders.find((entry) => entry.orderId === order.orderId);
  assert.ok(listedOrder);
  assert.equal(listedOrder.items.length, 1);
  assert.equal(listedOrder.items[0].service, order.service);
  assert.equal(listedOrder.items[0].plan, order.plan);

  const detailResponse = await adminOrderRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, { headers: { cookie: adminCookie } }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200, JSON.stringify(detail));
  assert.equal(detail.order.items.length, 1);
  assert.equal(detail.order.items[0].account, order.account);
  assert.equal(detail.order.items[0].password, order.password);
  assert.equal(detail.order.items[0].staffAccount, order.staffAccount);
  assert.equal(detail.order.items[0].staffPassword, order.staffPassword);

  const editResponse = await adminOrderRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/orders/${order.orderId}`, {
      method: "PATCH",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
        "idempotency-key": "legacy-no-items-edit-0001",
      },
      body: JSON.stringify({
        expectedRevision: 0,
        items: [{
          index: 0,
          account: "buyer-materialized@example.com",
          password: "buyer-materialized-password",
          staffAccount: "staff-materialized@example.com",
          staffPassword: "staff-materialized-password",
        }],
      }),
    }),
    { params: Promise.resolve({ orderId: order.orderId }) },
  );
  const edited = await editResponse.json();
  assert.equal(editResponse.status, 200, JSON.stringify(edited));
  assert.equal(edited.order.items.length, 1);
  const persisted = await utils.getOrderById(order.orderId);
  assert.equal(persisted.items.length, 1);
  assert.equal(persisted.items[0].account, "buyer-materialized@example.com");
  assert.equal(persisted.items[0].password, "buyer-materialized-password");
  assert.equal(persisted.items[0].staffAccount, "staff-materialized@example.com");
  assert.equal(persisted.items[0].staffPassword, "staff-materialized-password");
  assert.equal(persisted.account, "buyer-materialized@example.com");
  assert.equal(persisted.password, "buyer-materialized-password");
  assert.equal(persisted.staffAccount, "staff-materialized@example.com");
  assert.equal(persisted.staffPassword, "staff-materialized-password");
});

test("non-Spotify ticket snapshots cannot roll back newer order credentials", async () => {
  const order = {
    orderId: "LMAFTERSALESSTALEAI1",
    status: "completed",
    revision: 0,
    locale: "zh",
    email: "stale-ai-buyer@example.com",
    serviceLabel: "AI 会员",
    account: "",
    password: "",
    staffAccount: "ai-old@example.com",
    staffPassword: "ai-old-password",
    items: [{
      service: "ai",
      label: "AI 会员",
      account: "",
      password: "",
      staffAccount: "ai-old@example.com",
      staffPassword: "ai-old-password",
    }],
  };
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  const ticket = {
    ticketId: "ASSTALEAI1",
    orderId: order.orderId,
    status: "pending",
    locale: "zh",
    email: order.email,
    issue: "创建工单后订单凭据被其他管理员更新",
    items: [{ index: 0, service: "ai", label: "AI 会员", credentialManaged: true, account: "ai-old@example.com", password: "ai-old-password" }],
    createdAt: new Date().toISOString(),
  };
  assert.equal((await store.createAfterSalesTicket(ticket)).ok, true);
  const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
  const headers = { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "Content-Type": "application/json" };
  const detailResponse = await adminDetailRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, { headers }),
    { params: Promise.resolve({ ticketId: ticket.ticketId }) },
  );
  const detail = await detailResponse.json();
  assert.equal(detail.ticket.items[0].account, "ai-old@example.com");
  assert.equal(detail.ticket.items[0].applyCredentialsByDefault, false);

  const current = await utils.getOrderEntryById(order.orderId);
  current.order.items[0].staffAccount = "ai-newer@example.com";
  current.order.items[0].staffPassword = "ai-newer-password";
  current.order.staffAccount = "ai-newer@example.com";
  current.order.staffPassword = "ai-newer-password";
  assert.equal(await utils.setOrderAt(current.index, current.order, { expectedRevision: 0 }), true);

  const staleResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, {
      method: "PATCH",
      headers: { ...headers, "Idempotency-Key": "after-sales-stale-ai-0001" },
      body: JSON.stringify({
        status: "completed",
        staffNote: "should refresh",
        credentialOrderHash: detail.ticket.credentialOrderHash,
        items: [{ index: 0, account: "ai-old@example.com", password: "ai-old-password" }],
      }),
    }),
    { params: Promise.resolve({ ticketId: ticket.ticketId }) },
  );
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error, "stale_order_credentials");
  assert.equal((await utils.getOrderById(order.orderId)).items[0].staffPassword, "ai-newer-password");

  const refreshedResponse = await adminDetailRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, { headers }),
    { params: Promise.resolve({ ticketId: ticket.ticketId }) },
  );
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshed.ticket.items[0].account, "ai-newer@example.com");
  assert.equal(refreshed.ticket.items[0].password, "ai-newer-password");
  assert.equal(refreshed.ticket.items[0].applyCredentialsByDefault, false);

  const sendsBefore = resendRequests.length;
  const completedResponse = await adminDetailRoute.PATCH(
    new Request(`https://www.liumeiti.vip/api/admin/after-sales/${ticket.ticketId}`, {
      method: "PATCH",
      headers: { ...headers, "Idempotency-Key": "after-sales-stale-ai-0002" },
      body: JSON.stringify({
        status: "completed",
        staffNote: "verified current credentials",
        credentialOrderHash: refreshed.ticket.credentialOrderHash,
        items: [],
      }),
    }),
    { params: Promise.resolve({ ticketId: ticket.ticketId }) },
  );
  assert.equal(completedResponse.status, 200);
  const persisted = await utils.getOrderById(order.orderId);
  assert.equal(persisted.items[0].staffAccount, "ai-newer@example.com");
  assert.equal(persisted.items[0].staffPassword, "ai-newer-password");
  assert.equal((persisted.staffAudit || []).filter((entry) => entry.action === "after_sales_credentials_sync").length, 0);
  const email = resendRequests.slice(sendsBefore).find((entry) => entry.email === order.email);
  assert.match(email?.text || "", /ai-newer@example\.com/);
  assert.match(email?.text || "", /ai-newer-password/);
  assert.doesNotMatch(email?.text || "", /ai-old-password/);
});

test("creation outbox drains oldest failures beyond the former latest-30 window", async () => {
  values.clear();
  lists.clear();
  sortedSets.clear();
  sets.clear();
  const tickets = [];
  for (let index = 0; index < 45; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const ticket = {
      ticketId: `ASCREATIONOUTBOX${suffix}`,
      orderId: `LMCREATIONOUTBOX${suffix}`,
      status: "pending",
      email: `creation-${suffix}@example.com`,
      issue: "验证创建副作用不会因新工单持续进入而饿死",
      items: [],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    };
    tickets.push(ticket);
    assert.equal((await store.createAfterSalesTicket(ticket)).ok, true);
  }

  const first = await store.getAfterSalesCreationOutbox(30);
  assert.deepEqual(first.map((ticket) => ticket.ticketId), tickets.slice(0, 30).map((ticket) => ticket.ticketId));
  for (const ticket of first) assert.equal(await store.markAfterSalesCreationEffectsDone(ticket.ticketId), true);

  const remaining = await store.getAfterSalesCreationOutbox(30);
  assert.deepEqual(remaining.map((ticket) => ticket.ticketId), tickets.slice(30).map((ticket) => ticket.ticketId));
  assert.equal(sortedSet("liumeiti:after-sales:creation-outbox").size, 15);
});

test("effect completion CAS preserves legacy ticket JSON bytes outside patched fields", async () => {
  const ticketId = "ASRAWBYTES01";
  const operationId = "completion-raw-bytes-01";
  const key = `liumeiti:after-sales:record:${ticketId}`;
  const raw = `{"ticketId":"${ticketId}","status":"completed","legacyEmpty":[],"legacyNull":null,"legacyLong":900719925474099312345,"creationEffectsPending":true,"completionEffectsPending":true,"completionOperationId":"${operationId}"}`;
  values.set(key, raw);
  sortedSet("liumeiti:after-sales:creation-outbox").set(ticketId, 1);
  sortedSet("liumeiti:after-sales:completion-outbox").set(ticketId, 1);

  assert.equal(await store.markAfterSalesCreationEffectsDone(ticketId), true);
  assert.equal(await store.markAfterSalesCompletionEffectsDone(ticketId, operationId), true);
  const saved = values.get(key);
  assert.match(saved, /"legacyEmpty":\[\]/);
  assert.match(saved, /"legacyNull":null/);
  assert.match(saved, /"legacyLong":900719925474099312345/);
  const parsed = JSON.parse(saved);
  assert.equal(parsed.creationEffectsPending, false);
  assert.equal(parsed.completionEffectsPending, false);
  assert.equal(typeof parsed.creationEffectsCompletedAt, "string");
  assert.equal(typeof parsed.completionEffectsCompletedAt, "string");
});
