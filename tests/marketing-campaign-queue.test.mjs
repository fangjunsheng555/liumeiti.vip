import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";
process.env.KV_REST_API_URL = "http://marketing-queue.redis.test";
process.env.KV_REST_API_TOKEN = "queue-token";
process.env.RESEND_API_KEY = "re_test_queue";
process.env.RESEND_FROM = "info@liumeiti.vip";

const store = new Map();
const resendRequests = [];
const originalFetch = globalThis.fetch;

function ensureZset(key) {
  if (!store.has(key)) store.set(key, { type: "zset", value: new Map() });
  return store.get(key).value;
}

function ensureList(key) {
  if (!store.has(key)) store.set(key, { type: "list", value: [] });
  return store.get(key).value;
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName).toUpperCase();
  if (name === "GET") return store.get(args[0])?.value ?? null;
  if (name === "SET") {
    const key = args[0];
    const value = String(args[1]);
    const options = args.slice(2).map((item) => String(item).toUpperCase());
    if (options.includes("NX") && store.has(key)) return null;
    store.set(key, { type: "string", value });
    return "OK";
  }
  if (name === "DEL") {
    let removed = 0;
    args.forEach((key) => { if (store.delete(key)) removed += 1; });
    return removed;
  }
  if (name === "ZADD") {
    const key = args[0];
    let index = 1;
    let onlyIfMissing = false;
    if (String(args[index]).toUpperCase() === "NX") { onlyIfMissing = true; index += 1; }
    const score = Number(args[index]);
    const member = String(args[index + 1]);
    const zset = ensureZset(key);
    if (onlyIfMissing && zset.has(member)) return 0;
    const created = zset.has(member) ? 0 : 1;
    zset.set(member, score);
    return created;
  }
  if (name === "ZRANGEBYSCORE") {
    const zset = ensureZset(args[0]);
    const min = String(args[1]).toLowerCase() === "-inf" ? -Infinity : Number(args[1]);
    const max = String(args[2]).toLowerCase() === "+inf" ? Infinity : Number(args[2]);
    let rows = Array.from(zset.entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
    const limitIndex = args.findIndex((item) => String(item).toUpperCase() === "LIMIT");
    if (limitIndex >= 0) {
      const offset = Number(args[limitIndex + 1]);
      rows = rows.slice(offset, offset + Number(args[limitIndex + 2]));
    }
    return rows;
  }
  if (name === "ZREM") {
    const zset = ensureZset(args[0]);
    let removed = 0;
    args.slice(1).forEach((member) => { if (zset.delete(String(member))) removed += 1; });
    return removed;
  }
  if (name === "ZREVRANGE") return [];
  if (name === "INCR") {
    const next = Number(store.get(args[0])?.value || 0) + 1;
    store.set(args[0], { type: "string", value: String(next) });
    return next;
  }
  if (name === "EXPIRE") return store.has(args[0]) ? 1 : 0;
  if (name === "LPUSH") {
    const list = ensureList(args[0]);
    list.unshift(...args.slice(1).map(String));
    return list.length;
  }
  if (name === "LTRIM") {
    const list = ensureList(args[0]);
    list.splice(Number(args[2]) + 1);
    return "OK";
  }
  if (name === "LRANGE") return [...ensureList(args[0])];
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://marketing-queue.redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
  }
  if (url.origin === "https://api.resend.com") {
    const body = JSON.parse(options.body || "{}");
    resendRequests.push(body);
    return Response.json({ id: `resend-${resendRequests.length}` }, { status: 200 });
  }
  return originalFetch(input, options);
};

const queue = await import("../app/api/_marketing-campaign-queue.js");

test("campaign recipients stay internal until their Beijing evening is due", async () => {
  const scheduledAt = "2026-07-15T10:30:00.000Z";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-test",
    recipients: ["first@example.com", "second@example.com"],
    scheduledAt,
    subject: "服务精选",
    html: "<p>hello</p>",
    text: "hello",
    preview: "preview",
    brandName: "冒央会社",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  assert.equal(enqueued.queuedCount, 2);
  assert.equal(resendRequests.length, 0);

  const early = await queue.dispatchDueMarketingCampaigns({ now: Date.parse("2026-07-15T10:29:59.000Z") });
  assert.equal(early.reason, "nothing_due");
  assert.equal(resendRequests.length, 0);

  const due = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) });
  assert.equal(due.ok, true);
  assert.equal(due.submitted, 2);
  assert.equal(resendRequests.length, 2);
  const deliveryLookup = store.get(`lm:mail:delivery:message:${enqueued.results[0].messageId}`)?.value;
  const deliveryRecord = JSON.parse(store.get(`lm:mail:delivery:record:${deliveryLookup}`)?.value || "null");
  assert.equal(deliveryRecord.status, "sent");
  assert.equal(deliveryRecord.provider, "resend");
  assert.equal(deliveryRecord.providerMessageId, "resend-1");

  const repeated = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) + 60_000 });
  assert.equal(repeated.submitted, 0);
  assert.equal(resendRequests.length, 2);
});

test("queue calculations use Beijing dates and move quota retries to the next evening", () => {
  const internals = queue.marketingCampaignQueueInternals;
  assert.equal(internals.beijingDayKey(Date.parse("2026-07-14T16:30:00.000Z")), "20260715");
  assert.equal(
    new Date(internals.nextBeijingEvening(Date.parse("2026-07-14T11:00:00.000Z"))).toISOString(),
    "2026-07-15T10:30:00.000Z",
  );
  assert.equal(
    new Date(internals.retryTimestamp({ code: 429, error: "daily_quota_exceeded" }, Date.parse("2026-07-14T10:31:00.000Z"))).toISOString(),
    "2026-07-15T10:30:00.000Z",
  );
  assert.equal(internals.isQuotaFailure({ code: 429, error: "rate_limit_exceeded" }), false);
});
