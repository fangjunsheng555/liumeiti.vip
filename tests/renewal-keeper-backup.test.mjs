import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.AUTH_SECRET = "renewal-test-secret-at-least-32-characters!!";
process.env.KV_REST_API_URL = "http://redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.RESEND_API_KEY = "re_test_key";
delete process.env.EMAIL_PROVIDER;
delete process.env.TELEGRAM_BOT_TOKEN;

const values = new Map();
const lists = new Map();
const sortedSets = new Map();
const sentEmails = [];
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
  if (name === "EXPIRE" || name === "TTL") return 1;
  if (name === "EVAL") {
    const key = args[2];
    if (values.get(key) !== args[3]) return 0;
    values.delete(key);
    return 1;
  }
  if (name === "ZADD") { sortedSet(args[0]).set(args[2], Number(args[1])); return 1; }
  if (name === "ZREM") {
    const set = sortedSet(args[0]);
    let removed = 0;
    args.slice(1).forEach((member) => { if (set.delete(member)) removed += 1; });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZREVRANGE" || name === "ZRANGEBYSCORE" || name === "ZREMRANGEBYSCORE") {
    if (name === "ZREMRANGEBYSCORE") return 0;
    const entries = [...sortedSet(args[0]).entries()];
    if (name === "ZRANGEBYSCORE") return entries.map(([member]) => member);
    const start = Number(args[1]);
    const stop = Number(args[2]);
    return entries.sort((a, b) => b[1] - a[1]).slice(start, stop < 0 ? undefined : stop + 1).map(([member]) => member);
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
  if (name === "HSET" || name === "HDEL" || name === "SADD" || name === "HSETNX" || name === "HINCRBY") return 1;
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
    return Response.json({ id: "test-mail-" + sentEmails.length });
  }
  return originalFetch(input, options);
};

const expiryLib = await import("../app/lib/order-expiry.js");
const renewal = await import("../app/api/_renewal.js");
const keeper = await import("../app/api/_keeper.js");
const utils = await import("../app/api/_utils.js");
const resendRoute = await import("../app/api/order-password-update/resend/route.js");

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: "LMRESEND1", token }),
  }));
  assert.equal(okResponse.status, 200);
  assert.equal((await okResponse.json()).ok, true);
  assert.equal(sentEmails.length, mailsBefore + 1);

  const stored = await utils.getOrderById("LMRESEND1");
  assert.notEqual(stored.items[0].passwordCorrectionTokenHash, oldHash); // token 已轮换
  assert.equal(stored.items[0].passwordCorrectionResendCount, 1);
  assert.equal(stored.items[0].passwordCorrectionEmailOk, true);
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
