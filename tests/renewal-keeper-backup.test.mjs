import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeOrderCasEval } from "./helpers/order-cas-redis-mock.mjs";

process.env.AUTH_SECRET = "renewal-test-secret-at-least-32-characters!!";
process.env.KV_REST_API_URL = "http://redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.RESEND_API_KEY = "re_test_key";
delete process.env.EMAIL_PROVIDER;
delete process.env.TELEGRAM_BOT_TOKEN;

const values = new Map();
const lists = new Map();
const sortedSets = new Map();
const sets = new Map();
const sentEmails = [];
const queuedEmailResponses = [];
const originalFetch = globalThis.fetch;
let nextEmailHook = null;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
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
  if (name === "EXPIRE" || name === "TTL") return 1;
  if (name === "EVAL") {
    const cas = executeOrderCasEval(command, { values, lists, sortedSets, sets });
    if (cas.handled) return cas.result;
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("local next = cjson.decode(ARGV[1])") && script.includes("LPUSH")) {
      values.set(keys[0], String(argv[0]));
      return String(argv[0]);
    }
    if (script.includes("PEXPIRE") && script.includes("redis.call('GET',KEYS[1])")) {
      return values.get(keys[0]) === argv[0] ? 1 : 0;
    }
    if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]") && script.includes("redis.call('DEL',KEYS[1])")) {
      if (values.get(keys[0]) !== argv[0]) return 0;
      values.delete(keys[0]);
      return 1;
    }
    if (script.includes("current=tonumber(doc.revision or 0)")) {
      const existing = values.get(keys[0]);
      const revision = existing ? Number(JSON.parse(existing).revision || 0) : 0;
      if (revision !== Number(argv[0])) return 0;
      values.set(keys[0], argv[1]);
      return 1;
    }
    if (script.includes("state='started'") && script.includes("isNew=true")) {
      const existing = values.get(keys[0]);
      if (existing) {
        const record = JSON.parse(existing);
        if (record.requestHash !== argv[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
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
    if (script.includes("record.state='done'") && script.includes("completedAt=ARGV[3]")) {
      const raw = values.get(keys[0]);
      if (!raw) return JSON.stringify({ ok: false, error: "operation_record_missing" });
      const record = JSON.parse(raw);
      if (record.requestHash !== argv[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
      if (record.state === "done") return JSON.stringify({ ok: true, state: "done", record, idempotent: true });
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
      lists.set(keys[1], list.slice(0, Number(argv[1] || 500)));
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
    if (script.includes("return 'acquired'") && script.includes("indexStatus")) {
      const raw = values.get(keys[0]);
      if (raw) {
        if (raw === "done") {
          clearDeliveryIndexes(keys, argv[3]);
          return "done";
        }
        try {
          const state = JSON.parse(raw);
          if (state?.status === "done") {
            clearDeliveryIndexes(keys, argv[3]);
            return "done";
          }
          if (["sending", "uncertain"].includes(state?.status)) {
            indexDelivery(keys, state.status, state.score || argv[2], argv[3]);
            return state.status;
          }
          if (state?.status !== "retryable") return "uncertain";
        } catch {
          indexDelivery(keys, "uncertain", argv[2], argv[3]);
          return "uncertain";
        }
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
    throw new Error("unexpected EVAL script");
  }
  if (name === "ZADD") { sortedSet(args[0]).set(args[2], Number(args[1])); return 1; }
  if (name === "ZREM") {
    const set = sortedSet(args[0]);
    let removed = 0;
    args.slice(1).forEach((member) => { if (set.delete(member)) removed += 1; });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZRANGE" || name === "ZREVRANGE" || name === "ZRANGEBYSCORE" || name === "ZREMRANGEBYSCORE") {
    if (name === "ZREMRANGEBYSCORE") return 0;
    const entries = [...sortedSet(args[0]).entries()];
    if (name === "ZRANGEBYSCORE") return entries.map(([member]) => member);
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return entries.sort((a, b) => name === "ZREVRANGE" ? b[1] - a[1] : a[1] - b[1]).slice(start, stop < 0 ? undefined : stop + 1).map(([member]) => member);
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
  if (name === "LSET") {
    const list = lists.get(args[0]) || [];
    const index = Number(args[1]);
    if (index < 0 || index >= list.length) return null;
    list[index] = args[2];
    return "OK";
  }
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
  if (name === "HSET" || name === "HDEL" || name === "HSETNX" || name === "HINCRBY") return 1;
  if (name === "HVALS") return [];
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return Response.json({ result: execute(command) });
  }
  if (url.origin === "https://api.resend.com") {
    sentEmails.push(JSON.parse(options.body || "{}"));
    const hook = nextEmailHook;
    nextEmailHook = null;
    if (hook) hook();
    const queued = queuedEmailResponses.shift();
    if (queued) return Response.json(queued.body || { message: "provider rejected" }, { status: queued.status });
    return Response.json({ id: "test-mail-" + sentEmails.length });
  }
  return originalFetch(input, options);
};

const expiryLib = await import("../app/lib/order-expiry.js");
const renewal = await import("../app/api/_renewal.js");
const keeper = await import("../app/api/_keeper.js");
const quoteExpiry = await import("../app/api/_quote-expiry.js");
const utils = await import("../app/api/_utils.js");
const resendRoute = await import("../app/api/order-password-update/resend/route.js");
const adminOrderRoute = await import("../app/api/admin/orders/[orderId]/route.js");

function seedOrder(order) {
  values.set(`liumeiti:orders:record:${order.orderId}`, JSON.stringify(order));
  lists.set("liumeiti:orders:index", [...(lists.get("liumeiti:orders:index") || []), order.orderId]);
  values.set("liumeiti:orders:index:legacy-ready", "1"); // 跳过迁移
}

test("parseCycleDuration handles catalog cycle labels", () => {
  assert.deepEqual(expiryLib.parseCycleDuration("1年"), { months: 12 });
  assert.deepEqual(expiryLib.parseCycleDuration("三个月"), { months: 3 });
  assert.deepEqual(expiryLib.parseCycleDuration("半年"), { months: 6 });
  assert.deepEqual(expiryLib.parseCycleDuration("月付"), { months: 1 });
  assert.deepEqual(expiryLib.parseCycleDuration("季付"), { months: 3 });
  assert.deepEqual(expiryLib.parseCycleDuration("2年"), { months: 24 });
  assert.deepEqual(expiryLib.parseCycleDuration("30天"), { days: 30 });
  assert.equal(expiryLib.parseCycleDuration("次"), null);
  assert.equal(expiryLib.parseCycleDuration("按单"), null);
  assert.equal(expiryLib.parseCycleDuration("人工报价"), null);
  assert.equal(expiryLib.parseCycleDuration(""), null);
});

test("orderExpirySummary computes earliest expiry for completed orders only", () => {
  const now = Date.UTC(2026, 6, 12);
  const completedAt = new Date(Date.UTC(2026, 6, 10)).toISOString(); // 2 天前完成
  const order = {
    orderId: "LMEXP1",
    status: "completed",
    completedAt,
    items: [
      { service: "spotify", label: "Spotify", cycle: "1年", plan: "member" },
      { service: "rocket", label: "机场节点", cycle: "30天", plan: "basic" },
    ],
  };
  const summary = expiryLib.orderExpirySummary(order, now);
  assert.ok(summary);
  assert.equal(summary.daysLeft, 28); // 30天周期,已过 2 天
  assert.equal(summary.expired, false);
  assert.equal(summary.items.length, 2);
  assert.equal(expiryLib.orderExpirySummary({ ...order, status: "received" }, now), null);
  assert.equal(expiryLib.orderExpirySummary({ ...order, items: [{ service: "proxy-pay", cycle: "按单" }] }, now), null);
});

test("renewalCheckoutPath prefills checkout and skips quote-only items", () => {
  const path = expiryLib.renewalCheckoutPath({
    status: "completed",
    items: [
      { service: "spotify", cycle: "1年", plan: "member" },
      { service: "proxy-pay", cycle: "按单" },
      { service: "spotify", cycle: "1年", plan: "member" },
    ],
  });
  assert.equal(path, "/checkout?items=spotify&spotifyPlan=member");
});

test("sendDueRenewalReminders emails once per expiry and is idempotent", async () => {
  const now = Date.now();
  const completedAt = new Date(now - 28 * 86400000).toISOString(); // 30天周期,剩 2 天
  seedOrder({
    orderId: "LMRENEW1",
    status: "completed",
    locale: "zh",
    email: "renew@example.com",
    createdAt: completedAt,
    completedAt,
    items: [{ service: "rocket", label: "机场节点 · 普通套餐", cycle: "30天", plan: "basic", amount: 128 }],
  });
  const first = await renewal.sendDueRenewalReminders({ now });
  assert.equal(first.ok, true);
  assert.equal(first.sent, 1);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /到期提醒/);
  assert.match(sentEmails[0].html, /items=rocket/);
  assert.match(sentEmails[0].html, /rocketPlan=basic/);

  const stored = await utils.getOrderById("LMRENEW1");
  assert.ok(stored.renewalReminderForExpiresAt);

  const second = await renewal.sendDueRenewalReminders({ now });
  assert.equal(second.sent, 0); // 同一到期点不重复发
});

test("renewal delivery is not repeated when the order marker CAS loses a race", async () => {
  const now = Date.now();
  const completedAt = new Date(now - 28 * 86400000).toISOString();
  seedOrder({
    orderId: "LMRENEWCAS",
    revision: 0,
    status: "completed",
    locale: "en",
    email: "renew-cas@example.com",
    createdAt: completedAt,
    completedAt,
    items: [{ service: "rocket", label: "VPN", cycle: "30天", plan: "basic", amount: 128 }],
  });
  const emailsBefore = sentEmails.length;
  nextEmailHook = () => {
    const key = "liumeiti:orders:record:LMRENEWCAS";
    const concurrent = JSON.parse(values.get(key));
    values.set(key, JSON.stringify({ ...concurrent, revision: 1, staffNotes: "concurrent update" }));
  };

  const first = await renewal.sendDueRenewalReminders({ now });
  assert.equal(first.sent, 0);
  assert.equal(sentEmails.length, emailsBefore + 1);
  assert.equal((await utils.getOrderById("LMRENEWCAS")).renewalReminderForExpiresAt, undefined);

  const replay = await renewal.sendDueRenewalReminders({ now });
  assert.equal(replay.sent, 1, "the journaled delivery should only repair the order marker");
  assert.equal(sentEmails.length, emailsBefore + 1, "the accepted email must not be sent twice");
  assert.ok((await utils.getOrderById("LMRENEWCAS")).renewalReminderForExpiresAt);
});

test("due proxy-payment quotes are persisted as expired and removed from the due index", async () => {
  const now = Date.now();
  seedOrder({
    orderId: "LMQUOTEEXPIRED1",
    orderType: "proxy_payment",
    status: "pending_payment",
    quoteAmount: 400,
    quoteExpiresAt: new Date(now - 1000).toISOString(),
    createdAt: new Date(now - 86400000).toISOString(),
    items: [{ service: "proxy-pay", label: "全球代付", cycle: "按单", amount: 400 }],
  });
  sortedSet(utils.QUOTE_EXPIRY_ORDER_INDEX_KEY).set("LMQUOTEEXPIRED1", now - 1000);

  const first = await quoteExpiry.expireDueQuoteOrders({ now, limit: 20 });
  assert.equal(first.expired, 1);
  const stored = await utils.getOrderById("LMQUOTEEXPIRED1");
  assert.equal(stored.status, "quote_expired");
  assert.ok(stored.quoteExpiredAtBeijing);
  assert.equal(sortedSet(utils.QUOTE_EXPIRY_ORDER_INDEX_KEY).has("LMQUOTEEXPIRED1"), false);

  const second = await quoteExpiry.expireDueQuoteOrders({ now: now + 1000, limit: 20 });
  assert.equal(second.expired, 0);
});

test("an expired proxy-payment quote can only resume through a fresh quote and email", async () => {
  const oldHash = createHash("sha256").update("old-quote-token").digest("hex");
  seedOrder({
    orderId: "LMQUOTERENEW1",
    orderType: "proxy_payment",
    status: "quote_expired",
    locale: "zh",
    email: "quote@example.com",
    platformUrl: "https://example.com/checkout",
    productPrice: "USD 99.00",
    quoteAmount: 400,
    quoteValidDays: 7,
    quoteExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    quotePaymentTokenHash: oldHash,
    createdAt: new Date().toISOString(),
    items: [{ service: "proxy-pay", label: "全球代付 · 人工报价", amount: 400 }],
  });
  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    staffRole: "owner",
    staffRoot: true,
    iat: Date.now(),
    exp: Date.now() + 60_000,
  });
  const mailsBefore = sentEmails.length;
  const response = await adminOrderRoute.PATCH(new Request("https://www.liumeiti.vip/api/admin/orders/LMQUOTERENEW1", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: `lm_admin=${adminToken}`,
      "Idempotency-Key": "admin-quote-renew-test-0001",
    },
    body: JSON.stringify({ quoteAmount: 450, quoteValidDays: 3, staffNotes: "" }),
  }), { params: Promise.resolve({ orderId: "LMQUOTERENEW1" }) });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(payload.order.status, "pending_payment");
  assert.equal(payload.quote.validDays, 3);
  assert.equal(sentEmails.length, mailsBefore + 1);

  const stored = await utils.getOrderById("LMQUOTERENEW1");
  assert.equal(stored.quoteAmount, 450);
  assert.equal(stored.quoteValidDays, 3);
  assert.equal(stored.quoteExpiredAt, null);
  assert.notEqual(stored.quotePaymentTokenHash, oldHash);
  const remainingHours = (new Date(stored.quoteExpiresAt).getTime() - new Date(stored.quotedAt).getTime()) / 3_600_000;
  assert.equal(remainingHours, 72);
});

test("maintenance tick sets throttle locks and runs at most once per window", async () => {
  await keeper.runMaintenanceTick();
  assert.ok(values.has("lm:keeper:usdt-tick"));
  assert.ok(values.has("lm:keeper:renewal-tick"));
  const mailsAfterFirst = sentEmails.length;
  await keeper.runMaintenanceTick(); // 窗口内第二次:节流,不重复扫描
  assert.equal(sentEmails.length, mailsAfterFirst);
});

test("password correction resend rotates token and requires verified session", async () => {
  const requestedAt = new Date().toISOString();
  const oldHash = createHash("sha256").update("old-token").digest("hex");
  seedOrder({
    orderId: "LMRESEND1",
    status: "received",
    locale: "zh",
    email: "buyer@example.com",
    items: [{
      service: "spotify",
      label: "Spotify · 家庭成员",
      account: "acc@example.com",
      password: "pwd",
      amount: 128,
      passwordCorrectionTokenHash: oldHash,
      passwordCorrectionRequestedAt: requestedAt,
      passwordCorrectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }],
  });

  const badResponse = await resendRoute.POST(new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: "LMRESEND1", token: "not-a-valid-token" }),
  }));
  assert.equal(badResponse.status, 401);

  const token = utils.signSession({
    type: "after-sales-order",
    orderId: "LMRESEND1",
    email: "buyer@example.com",
    exp: Date.now() + 60_000,
  });
  const mailsBefore = sentEmails.length;
  const okResponse = await resendRoute.POST(new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "spotify-resend-test-0001" },
    body: JSON.stringify({ orderId: "LMRESEND1", token }),
  }));
  assert.equal(okResponse.status, 200);
  assert.equal((await okResponse.json()).ok, true);
  assert.equal(sentEmails.length, mailsBefore + 1);

  const stored = await utils.getOrderById("LMRESEND1");
  assert.notEqual(stored.items[0].passwordCorrectionTokenHash, oldHash); // token 已轮换
  assert.equal(stored.items[0].passwordCorrectionResendCount, 1);
  assert.equal(stored.items[0].passwordCorrectionEmailOk, true);

  const replay = await resendRoute.POST(new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "spotify-resend-test-0001" },
    body: JSON.stringify({ orderId: "LMRESEND1", token }),
  }));
  assert.equal(replay.status, 200);
  assert.equal(sentEmails.length, mailsBefore + 1, "the same operation must not send a second email");
  const replayed = await utils.getOrderById("LMRESEND1");
  assert.equal(replayed.items[0].passwordCorrectionResendCount, 1);
});

test("password correction resend never hides a partial multi-item delivery failure and retries only the failed item", async () => {
  const requestedAt = new Date().toISOString();
  seedOrder({
    orderId: "LMRESENDMULTI1",
    status: "received",
    locale: "zh",
    email: "multi-buyer@example.com",
    items: [0, 1].map((index) => ({
      service: "spotify",
      label: `Spotify 成员 ${index + 1}`,
      account: `member-${index + 1}@example.com`,
      password: `password-${index + 1}`,
      passwordCorrectionRequestedAt: requestedAt,
      passwordCorrectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  });
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: "LMRESENDMULTI1",
    email: "multi-buyer@example.com",
    exp: Date.now() + 60_000,
  });
  const request = () => new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "spotify-resend-multi-test-0001" },
    body: JSON.stringify({ orderId: "LMRESENDMULTI1", token }),
  });

  const sendsBefore = sentEmails.length;
  queuedEmailResponses.push(
    { status: 200, body: { id: "multi-first-ok" } },
    { status: 422, body: { message: "provider rejected this attempt" } },
    { status: 422, body: { message: "provider rejected this attempt" } },
  );
  const partial = await resendRoute.POST(request());
  const partialBody = await partial.json();
  assert.equal(partial.status, 502);
  assert.equal(partialBody.ok, false);
  assert.equal(partialBody.retryable, true);
  assert.deepEqual(partialBody.failedItemIndexes, [1]);
  assert.equal(sentEmails.length, sendsBefore + 3, "the provider retry must also fail for the second item");

  queuedEmailResponses.push({ status: 200, body: { id: "multi-second-retry-ok" } });
  const retry = await resendRoute.POST(request());
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, JSON.stringify(retryBody));
  assert.equal(retryBody.ok, true);
  assert.equal(retryBody.deliveredCount, 2);
  assert.equal(sentEmails.length, sendsBefore + 4, "the completed first item must not be sent again");

  const stored = await utils.getOrderById("LMRESENDMULTI1");
  assert.equal(stored.items[0].passwordCorrectionEmailOk, true);
  assert.equal(stored.items[1].passwordCorrectionEmailOk, true);
  assert.equal(stored.items[0].passwordCorrectionResendCount, 1);
  assert.equal(stored.items[1].passwordCorrectionResendCount, 1);
});

test("password correction resend processes every one of three pending Spotify items", async () => {
  const requestedAt = new Date().toISOString();
  seedOrder({
    orderId: "LMRESENDTHREE1",
    status: "received",
    locale: "zh",
    email: "three-buyer@example.com",
    items: [0, 1, 2].map((index) => ({
      service: "spotify",
      label: `Spotify member ${index + 1}`,
      account: `three-${index + 1}@example.com`,
      password: `password-${index + 1}`,
      passwordCorrectionRequestedAt: requestedAt,
      passwordCorrectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  });
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: "LMRESENDTHREE1",
    email: "three-buyer@example.com",
    exp: Date.now() + 60_000,
  });
  const sendsBefore = sentEmails.length;
  queuedEmailResponses.push(
    { status: 200, body: { id: "three-1-ok" } },
    { status: 200, body: { id: "three-2-ok" } },
    { status: 200, body: { id: "three-3-ok" } },
  );

  const response = await resendRoute.POST(new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "spotify-resend-three-test-0001" },
    body: JSON.stringify({ orderId: "LMRESENDTHREE1", token }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.deliveredCount, 3);
  assert.equal(body.handledCount, 3);
  assert.equal(sentEmails.length, sendsBefore + 3);

  const stored = await utils.getOrderById("LMRESENDTHREE1");
  assert.deepEqual(stored.items.map((item) => item.passwordCorrectionEmailOk), [true, true, true]);
  assert.deepEqual(stored.items.map((item) => item.passwordCorrectionResendCount), [1, 1, 1]);
});

test("password correction resend quarantines an uncertain item instead of risking a duplicate", async () => {
  const requestedAt = new Date().toISOString();
  seedOrder({
    orderId: "LMRESENDUNCERTAIN1",
    status: "received",
    locale: "zh",
    email: "uncertain-buyer@example.com",
    items: [0, 1].map((index) => ({
      service: "spotify",
      label: `Spotify 不确定投递 ${index + 1}`,
      account: `uncertain-${index + 1}@example.com`,
      password: `password-${index + 1}`,
      passwordCorrectionRequestedAt: requestedAt,
      passwordCorrectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  });
  const token = utils.signSession({
    type: "after-sales-order",
    orderId: "LMRESENDUNCERTAIN1",
    email: "uncertain-buyer@example.com",
    exp: Date.now() + 60_000,
  });
  const request = () => new Request("https://www.liumeiti.vip/api/order-password-update/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "spotify-resend-uncertain-test-0001" },
    body: JSON.stringify({ orderId: "LMRESENDUNCERTAIN1", token }),
  });

  const sendsBefore = sentEmails.length;
  queuedEmailResponses.push(
    { status: 200, body: { id: "uncertain-first-ok" } },
    { status: 503, body: { message: "provider result unknown" } },
    { status: 503, body: { message: "provider result unknown" } },
  );
  const uncertain = await resendRoute.POST(request());
  const uncertainBody = await uncertain.json();
  assert.equal(uncertain.status, 409);
  assert.equal(uncertainBody.error, "email_delivery_uncertain");
  assert.equal(uncertainBody.retryable, false);
  assert.equal(uncertainBody.manualReview, true);
  assert.deepEqual(uncertainBody.failedItemIndexes, [1]);
  assert.equal(sentEmails.length, sendsBefore + 3);

  const repeated = await resendRoute.POST(request());
  const repeatedBody = await repeated.json();
  assert.equal(repeated.status, 409);
  assert.equal(repeatedBody.manualReview, true);
  assert.equal(sentEmails.length, sendsBefore + 3, "an uncertain provider result must not be sent again automatically");
});

test("getOrderEntryById prefers record and falls back to legacy with index handle", async () => {
  seedOrder({ orderId: "LMENTRY1", status: "completed", email: "a@b.co", items: [] });
  const record = await utils.getOrderEntryById("LMENTRY1");
  assert.equal(record.index.legacyIndex, null);
  assert.equal(record.order.orderId, "LMENTRY1");

  lists.set("liumeiti:orders", [JSON.stringify({ orderId: "LMLEGACY9", status: "received", items: [] })]);
  const legacy = await utils.getOrderEntryById("LMLEGACY9");
  assert.equal(legacy.index.legacyIndex, 0);
  assert.equal(legacy.order.orderId, "LMLEGACY9");
  assert.equal(await utils.getOrderEntryById("LMNOPE"), null);
});
