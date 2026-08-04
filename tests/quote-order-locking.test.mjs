import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeDurableOperationEval } from "./helpers/durable-operation-redis-mock.mjs";

process.env.AUTH_SECRET = "quote-lock-test-secret-at-least-32-chars";
process.env.KV_REST_API_URL = "http://quote-lock-redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_PROVIDER;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.ORDER_WEBHOOK_URL;

const values = new Map();
const lists = new Map();
const sortedSets = new Map();
const commands = [];
let recordReads = 0;
let recordWrites = 0;
let mutateRecordAtRead = 0;
let recordKey = "";
let injectQuoteDuringSnapshot = null;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function execute(command, source = "direct") {
  commands.push({ command: [...command], source });
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();

  if (name === "GET") {
    if (args[0] === recordKey) {
      recordReads += 1;
      if (mutateRecordAtRead === recordReads) {
        const current = JSON.parse(values.get(recordKey));
        values.set(recordKey, JSON.stringify({ ...current, status: "invalid", revision: Number(current.revision || 0) + 1 }));
      }
    }
    return values.get(args[0]) ?? null;
  }
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map(String).includes("NX") && values.has(key)) return null;
    if (key === recordKey) recordWrites += 1;
    values.set(key, value);
    return "OK";
  }
  if (name === "DEL") {
    let removed = 0;
    for (const key of args) {
      if (values.delete(key)) removed += 1;
      if (lists.delete(key)) removed += 1;
      if (sortedSets.delete(key)) removed += 1;
    }
    return removed;
  }
  if (name === "INCR") {
    const next = Number(values.get(args[0]) || 0) + 1;
    values.set(args[0], String(next));
    return next;
  }
  if (name === "EXPIRE" || name === "TTL") return 1;
  if (name === "EVAL") {
    const durable = executeDurableOperationEval(command, { values, sortedSet });
    if (durable.handled) return durable.result;
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (keyCount > 1) {
      const absent = "__LM_ORDER_RECORD_ABSENT__";
      const currentRaw = values.get(keys[0]) ?? null;
      const expectedRaw = argv[0] === absent ? null : argv[0];
      if (currentRaw !== expectedRaw) return JSON.stringify({ ok: false, error: "stale_order" });

      const nextOrder = JSON.parse(argv[3]);
      values.set(keys[0], argv[3]);
      recordWrites += 1;
      const index = lists.get(keys[1]) || [];
      if (!index.includes(argv[4])) index.push(argv[4]);
      lists.set(keys[1], index);
      if (argv[5] === "1") sortedSet(keys[3]).set(argv[4], Number(argv[6]));
      else sortedSet(keys[3]).delete(argv[4]);
      if (argv[7] === "1") sortedSet(keys[4]).set(argv[4], Number(argv[8]));
      else sortedSet(keys[4]).delete(argv[4]);
      values.set(keys[7], String(Number(values.get(keys[7]) || 0) + 1));
      assert.equal(nextOrder.orderId, argv[4]);
      return JSON.stringify({ ok: true, listRevision: Number(values.get(keys[7])) });
    }
    const key = keys[0];
    const token = argv[0];
    if (values.get(key) !== token) return 0;
    values.delete(key);
    return 1;
  }
  if (name === "LPOS") {
    const index = (lists.get(args[0]) || []).indexOf(args[1]);
    return index < 0 ? null : index;
  }
  if (name === "RPUSH") {
    const list = lists.get(args[0]) || [];
    list.push(...args.slice(1));
    lists.set(args[0], list);
    return list.length;
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
    return list.slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
  }
  if (name === "LSET") {
    const list = lists.get(args[0]) || [];
    const index = Number(args[1]);
    if (index < 0 || index >= list.length) return null;
    list[index] = args[2];
    return "OK";
  }
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZREM") {
    let removed = 0;
    const set = sortedSet(args[0]);
    for (const member of args.slice(1)) if (set.delete(member)) removed += 1;
    return removed;
  }
  if (["HSET", "HDEL", "SADD", "SREM"].includes(name)) return 1;
  return 1;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://quote-lock-redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const pipeline = JSON.parse(options.body || "[]");
    const rows = pipeline.map((command) => ({ result: execute(command, "pipeline") }));
    if (injectQuoteDuringSnapshot && pipeline.some((command) => command[0] === "GET" && String(command[1]).startsWith("liumeiti:orders:record:"))) {
      const injected = injectQuoteDuringSnapshot;
      injectQuoteDuringSnapshot = null;
      sortedSet("liumeiti:orders:quote-expiry").set(injected.orderId, injected.expiresAt);
      values.set(`liumeiti:orders:record:${injected.orderId}`, JSON.stringify(injected.order));
      const index = lists.get("liumeiti:orders:index") || [];
      if (!index.includes(injected.orderId)) index.push(injected.orderId);
      lists.set("liumeiti:orders:index", index);
    }
    return Response.json(rows);
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: execute(command) });
};

const quoteExpiry = await import("../app/api/_quote-expiry.js");
const quotePaymentRoute = await import("../app/api/quote-orders/[orderId]/route.js");

function seedOrder(order) {
  values.clear();
  lists.clear();
  sortedSets.clear();
  commands.length = 0;
  recordReads = 0;
  recordWrites = 0;
  mutateRecordAtRead = 0;
  injectQuoteDuringSnapshot = null;
  recordKey = `liumeiti:orders:record:${order.orderId}`;
  values.set(recordKey, JSON.stringify(order));
  lists.set("liumeiti:orders:index", [order.orderId]);
}

function commandIndex(predicate) {
  return commands.findIndex(({ command }) => predicate(command));
}

test("quote expiry uses the normalized shared order lock before reading the order", async () => {
  const now = Date.now();
  seedOrder({
    orderId: "LMEXPIRYCASE",
    orderType: "proxy_payment",
    status: "pending_payment",
    revision: 2,
    quoteExpiresAt: new Date(now - 1_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
  });

  const result = await quoteExpiry.expireQuoteOrderEntry({ orderId: "lmexpirycase" }, new Date(now));
  assert.equal(result.saved, true);
  const stored = JSON.parse(values.get(recordKey));
  assert.equal(stored.status, "quote_expired");
  assert.equal(stored.revision, 3);

  const lockIndex = commandIndex((command) => command[0] === "SET" && command[1] === "lm:order:update-lock:LMEXPIRYCASE");
  const firstOrderRead = commandIndex((command) => command[0] === "GET" && command[1] === recordKey);
  const unlockIndex = commandIndex((command) => command[0] === "EVAL" && command[3] === "lm:order:update-lock:LMEXPIRYCASE");
  assert.ok(lockIndex >= 0, "the expiry path must acquire the uppercase common lock");
  assert.ok(firstOrderRead > lockIndex, "the expiry path must reread only after acquiring the lock");
  assert.ok(unlockIndex > firstOrderRead, "the compare-delete unlock must run after the protected work");
});

test("quote index migration cannot erase a quote created after its snapshot", async () => {
  const now = Date.now();
  seedOrder({
    orderId: "LMOLDQUOTE",
    orderType: "proxy_payment",
    status: "pending_payment",
    revision: 1,
    quoteExpiresAt: new Date(now + 60_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
  });
  injectQuoteDuringSnapshot = {
    orderId: "LMNEWQUOTE",
    expiresAt: now + 120_000,
    order: {
      orderId: "LMNEWQUOTE",
      orderType: "proxy_payment",
      status: "pending_payment",
      revision: 1,
      quoteExpiresAt: new Date(now + 120_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    },
  };

  assert.equal(await quoteExpiry.ensureQuoteExpiryIndex(), true);
  const members = sortedSet("liumeiti:orders:quote-expiry");
  assert.equal(members.has("LMOLDQUOTE"), true);
  assert.equal(members.has("LMNEWQUOTE"), true, "live writers must survive the additive migration");
  assert.equal(commands.some(({ command }) => command[0] === "DEL" && command[1] === "liumeiti:orders:quote-expiry"), false);
});

test("quote payment rereads under lock and refuses a newer revision before setOrderAt", async () => {
  const token = "quote-payment-test-token";
  const now = Date.now();
  seedOrder({
    orderId: "LMPAYCASE",
    orderType: "proxy_payment",
    status: "pending_payment",
    revision: 7,
    quotePaymentTokenHash: createHash("sha256").update(token).digest("hex"),
    quoteExpiresAt: new Date(now + 60_000).toISOString(),
    quoteAmount: 200,
    finalAmount: 200,
    email: "buyer@example.com",
    locale: "zh",
    platformUrl: "https://example.com/pay",
    createdAt: new Date(now - 60_000).toISOString(),
    items: [{ service: "proxy-pay", amount: 200 }],
  });
  mutateRecordAtRead = 3;

  const response = await quotePaymentRoute.POST(new Request("https://www.liumeiti.vip/api/quote-orders/lmpaycase", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.20", "Idempotency-Key": "quote-payment-lock-0001" },
    body: JSON.stringify({ token, paymentMethod: "alipay", expectedRevision: 7 }),
  }), { params: Promise.resolve({ orderId: "lmpaycase" }) });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error, "stale_revision");
  assert.equal(recordWrites, 0, "a changed revision must not be overwritten");
  assert.equal(JSON.parse(values.get(recordKey)).revision, 8);

  const lockIndex = commandIndex((command) => command[0] === "SET" && command[1] === "lm:order:update-lock:LMPAYCASE");
  const firstOrderRead = commandIndex((command) => command[0] === "GET" && command[1] === recordKey);
  assert.ok(lockIndex >= 0, "the payment path must use the same uppercase common lock");
  assert.ok(firstOrderRead > lockIndex, "the first payment order read must happen after lock acquisition");
  assert.equal(recordReads, 3, "payment must reread immediately before the write attempt");
});
