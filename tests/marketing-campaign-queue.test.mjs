import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";
process.env.KV_REST_API_URL = "http://marketing-queue.redis.test";
process.env.KV_REST_API_TOKEN = "queue-token";
process.env.RESEND_API_KEY = "re_test_queue";
process.env.RESEND_FROM = "info@liumeiti.vip";
process.env.CRON_SECRET = "marketing-cron-test-secret";

const store = new Map();
const resendRequests = [];
const resendAttempts = [];
const resendAttemptMeta = [];
const resendIdempotencyRecords = new Map();
const resendFailureRecipients = new Set();
let resendBehavior = "ok"; // "ok" | "fail" | "quota" | "concurrent" | "conflict"
let resendBehaviorSequence = [];
let resendDelayMs = 0;
let redisDelayMs = 0;
let failNextJobWrite = false;
let failNextTerminalTransition = false;
let failNextDispatchLockWrite = false;
let loseNextSaveJobResponse = false;
let loseNextCreateCampaignResponse = false;
const createCampaignProtocolFailures = [];
const saveJobProtocolFailures = [];
let loseNextTransitionResponse = false;
let loseNextQuotaReservationResponse = false;
let failNextPipelineCommand = "";
let activeRedisRequests = 0;
let maxActiveRedisRequests = 0;
const originalFetch = globalThis.fetch;

function currentEntry(key) {
  const entry = store.get(key);
  if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry || null;
}

function ensureZset(key) {
  if (!currentEntry(key)) store.set(key, { type: "zset", value: new Map() });
  return store.get(key).value;
}

function ensureList(key) {
  if (!currentEntry(key)) store.set(key, { type: "list", value: [] });
  return store.get(key).value;
}

function ensureSet(key) {
  if (!currentEntry(key)) store.set(key, { type: "set", value: new Set() });
  return store.get(key).value;
}

function ensureHash(key) {
  if (!currentEntry(key)) store.set(key, { type: "hash", value: new Map() });
  return store.get(key).value;
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName).toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return currentEntry(args[0])?.value ?? null;
  if (name === "SISMEMBER") return currentEntry(args[0])?.value?.has(String(args[1])) ? 1 : 0;
  if (name === "SMISMEMBER") return args.slice(1).map((member) => currentEntry(args[0])?.value?.has(String(member)) ? 1 : 0);
  if (name === "SET") {
    const key = args[0];
    const value = String(args[1]);
    const options = args.slice(2).map((item) => String(item).toUpperCase());
    if (failNextDispatchLockWrite && key === "lm:mail:marketing:dispatch-lock") {
      failNextDispatchLockWrite = false;
      return null;
    }
    if (failNextJobWrite && String(key).startsWith("lm:mail:marketing:job:")) {
      failNextJobWrite = false;
      return null;
    }
    if (options.includes("NX") && currentEntry(key)) return null;
    const exIndex = options.indexOf("EX");
    const expiresAt = exIndex >= 0 ? Date.now() + Number(args[2 + exIndex + 1]) * 1000 : 0;
    store.set(key, { type: "string", value, expiresAt });
    return "OK";
  }
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("CONTACT_CAS_V2")) {
      const existing = currentEntry(keys[0])?.value;
      const revision = existing ? Number(JSON.parse(existing).revision || 0) : 0;
      if (revision !== Number(argv[0])) return 0;
      ensureZset(keys[1]).set(String(argv[3]), Number(argv[2]));
      store.set(keys[0], { type: "string", value: String(argv[1]) });
      return 1;
    }
    if (script.includes("MARKETING_DAILY_ATTEMPT_RESERVE_V1")) {
      const existing = currentEntry(keys[1])?.value;
      if (existing) {
        if (!/^\d{8}$/.test(existing)) return "__reservation_conflict__";
        if (existing !== String(argv[0])) return `__reserved__:${existing}`;
        const count = Number(currentEntry(keys[0])?.value);
        if (!Number.isSafeInteger(count) || count < 1 || count > Number(argv[1])) return "__invalid_daily_count__";
        return `__reserved__:${existing}`;
      }
      const count = Number(currentEntry(keys[0])?.value || 0);
      if (!Number.isSafeInteger(count) || count < 0 || count > Number(argv[1])) return "__invalid_daily_count__";
      if (count >= Number(argv[1])) return "__daily_limit__";
      store.set(keys[1], { type: "string", value: String(argv[0]) });
      store.set(keys[0], { type: "string", value: String(count + 1) });
      if (loseNextQuotaReservationResponse) {
        loseNextQuotaReservationResponse = false;
        return null;
      }
      return String(count + 1);
    }
    if (script.includes("doc.requestHash") && script.includes("return -1")) {
      if (createCampaignProtocolFailures.length) return createCampaignProtocolFailures.shift();
      const existing = currentEntry(keys[0])?.value;
      if (existing) {
        const doc = JSON.parse(existing);
        if (String(doc.requestHash || "") !== String(argv[0] || "")) return -1;
        if (!ensureZset(keys[1]).has(String(argv[2]))) ensureZset(keys[1]).set(String(argv[2]), Number(argv[1]));
        return 0;
      }
      store.set(keys[0], { type: "string", value: String(argv[4]) });
      if (!ensureZset(keys[1]).has(String(argv[2]))) ensureZset(keys[1]).set(String(argv[2]), Number(argv[1]));
      if (loseNextCreateCampaignResponse) { loseNextCreateCampaignResponse = false; return null; }
      return 1;
    }
    if (script.includes("__in_flight__") && script.includes("SMEMBERS")) {
      const raw = currentEntry(keys[0])?.value;
      if (!raw) return "__missing__";
      if (raw !== String(argv[2] || "")) return "__conflict__";
      const doc = JSON.parse(raw);
      if (String(doc.status || "") === String(argv[0] || "")) return JSON.stringify(doc);
      if (!String(argv[1] || "").split("|").includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
      for (const jobId of ensureSet(keys[2])) {
        const jobRaw = currentEntry(String(argv[7]) + jobId)?.value;
        const job = jobRaw ? JSON.parse(jobRaw) : null;
        if (job?.status === "sending" && currentEntry(String(argv[8]) + jobId)) return "__in_flight__";
      }
      store.set(keys[0], { type: "string", value: String(argv[3]) });
      if (!ensureZset(keys[1]).has(String(argv[6]))) ensureZset(keys[1]).set(String(argv[6]), Number(argv[5]));
      return String(argv[3]);
    }
    if (script.includes("__active__:") && script.includes("__terminal__") && script.includes("ZREM")) {
      const raw = currentEntry(keys[0])?.value;
      if (raw) {
        let doc;
        try { doc = JSON.parse(raw); } catch (error) { return "__corrupt__"; }
        if (!["submitted", "suppressed", "failed", "cancelled"].includes(String(doc.status || ""))) {
          return `__active__:${doc.status || ""}`;
        }
      }
      ensureZset(keys[1]).delete(String(argv[0]));
      ensureSet(keys[2]).delete(String(argv[0]));
      store.delete(keys[3]);
      return raw ? "__terminal__" : "__missing__";
    }
    if (script.includes("__corrupt_patch__") && !script.includes("__in_flight__")) {
      const raw = currentEntry(keys[0])?.value;
      if (!raw) return "__missing__";
      if (raw !== String(argv[2] || "")) return "__conflict__";
      const doc = JSON.parse(raw);
      if (!String(argv[1] || "").split("|").includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
      store.set(keys[0], { type: "string", value: String(argv[3]) });
      if (!ensureZset(keys[1]).has(String(argv[6]))) ensureZset(keys[1]).set(String(argv[6]), Number(argv[5]));
      return String(argv[3]);
    }
    if (script.includes("local queueScore=tonumber(doc.queueScore or ARGV[1])")) {
      if (saveJobProtocolFailures.length) return saveJobProtocolFailures.shift();
      const existing = currentEntry(keys[0])?.value;
      ensureSet(keys[2]).add(String(argv[1]));
      if (existing) {
        const doc = JSON.parse(existing);
        if (["queued", "sending"].includes(doc.status)) {
          ensureZset(keys[1]).set(String(argv[1]), Number(doc.queueScore || argv[0]));
          ensureSet(keys[3]).add(String(argv[1]));
        } else {
          ensureZset(keys[1]).delete(String(argv[1]));
          ensureSet(keys[3]).delete(String(argv[1]));
        }
        return 0;
      }
      store.set(keys[0], { type: "string", value: String(argv[4]) });
      ensureZset(keys[1]).set(String(argv[1]), Number(argv[0]));
      ensureSet(keys[3]).add(String(argv[1]));
      if (loseNextSaveJobResponse) { loseNextSaveJobResponse = false; return null; }
      return 1;
    }
    if (script.includes("__campaign_conflict__") && script.includes("responseEncoded")) {
      if (failNextJobWrite || (failNextTerminalTransition && argv[4] === "terminal")) {
        failNextJobWrite = false;
        failNextTerminalTransition = false;
        return null;
      }
      const raw = currentEntry(keys[0])?.value;
      if (!raw) return "__missing__";
      const current = JSON.parse(raw);
      if (!String(argv[0] || "").split("|").includes(String(current.status || ""))) return `__invalid__:${current.status || ""}`;
      const campaignRaw = currentEntry(keys[5])?.value;
      const campaign = campaignRaw ? JSON.parse(campaignRaw) : null;
      if (campaignRaw ? String(campaignRaw) !== String(argv[13]) : argv[13] !== "__lm_marketing_missing__") return "__campaign_conflict__";
      if (argv[8] === "sending") {
        if (!campaign) return "__campaign_missing__";
        if (!["scheduled", "sending"].includes(campaign.status)) return `__campaign_blocked__:${campaign.status}`;
      }
      store.set(keys[0], { type: "string", value: String(argv[1]) });
      ensureSet(keys[4]).add(String(argv[7]));
      if (argv[4] === "terminal") {
        ensureZset(keys[1]).delete(String(argv[7]));
        ensureSet(keys[2]).delete(String(argv[7]));
        store.delete(keys[3]);
      } else if (argv[4] === "schedule") {
        ensureZset(keys[1]).set(String(argv[7]), Number(argv[5]));
        ensureSet(keys[2]).add(String(argv[7]));
        store.delete(keys[3]);
      } else {
        ensureZset(keys[1]).set(String(argv[7]), Number(argv[5]));
        ensureSet(keys[2]).add(String(argv[7]));
      }
      if (argv[10] === "1") {
        store.set(keys[7], { type: "string", value: String(Number(currentEntry(keys[7])?.value || 0) + 1) });
      }
      if (campaign) {
        const useFinal = argv[4] === "terminal" && ensureSet(keys[2]).size === 0;
        store.set(keys[5], { type: "string", value: String(useFinal ? argv[15] : argv[14]) });
        if (!ensureZset(keys[6]).has(String(argv[6]))) ensureZset(keys[6]).set(String(argv[6]), Number(argv[12]));
        if (loseNextTransitionResponse) { loseNextTransitionResponse = false; return null; }
        return String(useFinal ? argv[17] : argv[16]);
      }
      if (loseNextTransitionResponse) { loseNextTransitionResponse = false; return null; }
      return String(argv[16]);
    }
    if (script.includes("__duplicate__") && script.includes("HINCRBYFLOAT")) {
      if (argv[0] !== "0") {
        if (currentEntry(keys[0])) return "__duplicate__";
        store.set(keys[0], { type: "string", value: "1" });
      }
      const target = ensureHash(keys[1]);
      const field = String(argv[1]);
      const next = Number(target.get(field) || 0) + Number(argv[4] || 0);
      target.set(field, String(next));
      return String(next);
    }
    if (script.includes("jobOk,job") && script.includes("campaignOk,campaign")) {
      if (currentEntry(keys[0])?.value !== String(argv[0]) || currentEntry(keys[1])?.value !== String(argv[0])) return 0;
      const job = currentEntry(keys[2])?.value ? JSON.parse(currentEntry(keys[2]).value) : null;
      const campaign = currentEntry(keys[3])?.value ? JSON.parse(currentEntry(keys[3]).value) : null;
      return job?.status === "sending" && campaign?.status === "sending" ? 1 : 0;
    }
    if (script.includes("'done','EX'") && script.includes("ARGV[2]")) {
      const entry = currentEntry(keys[0]);
      if (!entry || entry.value !== String(argv[0])) return 0;
      store.set(keys[0], { type: "string", value: "done", expiresAt: Date.now() + Number(argv[1]) * 1000 });
      return 1;
    }
    if (script.includes("return redis.call('EXPIRE',KEYS[1],ARGV[2])")) {
      const entry = currentEntry(keys[0]);
      if (!entry || entry.value !== String(argv[0])) return 0;
      entry.expiresAt = Date.now() + Number(argv[1]) * 1000;
      return 1;
    }
    if (script.includes("return redis.call('DEL',KEYS[1])") && script.includes("ARGV[1]")) {
      const entry = currentEntry(keys[0]);
      if (!entry || entry.value !== String(argv[0])) return 0;
      store.delete(keys[0]);
      return 1;
    }
    if (script.includes("current=tonumber(doc.revision or 0)")) {
      const raw = store.get(keys[0])?.value;
      let current = 0;
      if (raw) current = Number(JSON.parse(raw).revision || 0);
      if (current !== Number(argv[0])) return 0;
      store.set(keys[0], { type: "string", value: String(argv[1]) });
      return 1;
    }
    return null;
  }
  if (name === "DEL") {
    let removed = 0;
    args.forEach((key) => { if (store.delete(key)) removed += 1; });
    return removed;
  }
  if (name === "SADD") {
    const target = ensureSet(args[0]);
    let added = 0;
    for (const value of args.slice(1).map(String)) { if (!target.has(value)) added += 1; target.add(value); }
    return added;
  }
  if (name === "SREM") {
    let removed = 0;
    for (const value of args.slice(1).map(String)) if (ensureSet(args[0]).delete(value)) removed += 1;
    return removed;
  }
  if (name === "SMEMBERS") return Array.from(ensureSet(args[0]));
  if (name === "SCARD") return ensureSet(args[0]).size;
  if (name === "HGET") return ensureHash(args[0]).get(String(args[1])) ?? null;
  if (name === "HGETALL") return Object.fromEntries(ensureHash(args[0]));
  if (name === "HINCRBY" || name === "HINCRBYFLOAT") {
    const target = ensureHash(args[0]);
    const field = String(args[1]);
    const next = Number(target.get(field) || 0) + Number(args[2] || 0);
    target.set(field, String(next));
    return String(next);
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
  if (name === "ZSCORE") return ensureZset(args[0]).has(String(args[1])) ? String(ensureZset(args[0]).get(String(args[1]))) : null;
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    const rows = Array.from(ensureZset(args[0]).entries())
      .sort((left, right) => right[1] - left[1])
      .map(([member]) => member);
    return rows.slice(start, stop < 0 ? undefined : stop + 1);
  }
  if (name === "INCR") {
    const next = Number(store.get(args[0])?.value || 0) + 1;
    store.set(args[0], { type: "string", value: String(next) });
    return next;
  }
  if (name === "EXPIRE") {
    const entry = currentEntry(args[0]);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + Number(args[1]) * 1000;
    return 1;
  }
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
    activeRedisRequests += 1;
    maxActiveRedisRequests = Math.max(maxActiveRedisRequests, activeRedisRequests);
    if (redisDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, redisDelayMs));
    activeRedisRequests -= 1;
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      return Response.json(commands.map((command) => {
        if (failNextPipelineCommand && String(command?.[0] || "").toUpperCase() === failNextPipelineCommand) {
          failNextPipelineCommand = "";
          return { error: "simulated_pipeline_failure" };
        }
        return { result: execute(command) };
      }));
    }
    return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
  }
  if (url.origin === "https://api.resend.com") {
    if (resendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, resendDelayMs));
    const payloadJson = String(options.body || "{}");
    const body = JSON.parse(payloadJson);
    const idempotencyKey = new Headers(options.headers || {}).get("idempotency-key") || "";
    resendAttempts.push(body);
    resendAttemptMeta.push({ body, payloadJson, idempotencyKey });
    if ((Array.isArray(body.to) ? body.to : [body.to]).some((email) => resendFailureRecipients.has(String(email)))) {
      return Response.json({ message: "invalid_recipient" }, { status: 400 });
    }
    const currentResendBehavior = resendBehaviorSequence.length
      ? resendBehaviorSequence.shift()
      : resendBehavior;
    if (currentResendBehavior === "fail") return Response.json({ message: "invalid_recipient" }, { status: 400 });
    if (currentResendBehavior === "quota") return Response.json({ message: "daily_quota_exceeded" }, { status: 429 });
    if (currentResendBehavior === "server") return Response.json({ message: "upstream_unavailable" }, { status: 503 });
    if (currentResendBehavior === "network") throw new Error("simulated_network_timeout");
    if (currentResendBehavior === "concurrent") {
      return Response.json({
        name: "concurrent_idempotent_requests",
        message: "an identical request is still processing",
      }, { status: 409 });
    }
    if (currentResendBehavior === "conflict") {
      return Response.json({
        name: "invalid_idempotent_request",
        message: "same idempotency key used with a different payload",
      }, { status: 409 });
    }
    const existing = idempotencyKey ? resendIdempotencyRecords.get(idempotencyKey) : null;
    if (existing) {
      if (existing.payloadJson !== payloadJson) {
        return Response.json({
          name: "invalid_idempotent_request",
          message: "same idempotency key used with a different payload",
        }, { status: 409 });
      }
      return Response.json({ id: existing.id }, { status: 200 });
    }
    resendRequests.push(body);
    const id = `resend-${resendRequests.length}`;
    if (idempotencyKey) resendIdempotencyRecords.set(idempotencyKey, { payloadJson, id });
    return Response.json({ id }, { status: 200 });
  }
  return originalFetch(input, options);
};

const queue = await import("../app/api/_marketing-campaign-queue.js");
const marketingCronRoute = await import("../app/api/cron/marketing-campaign/route.js");

test("campaign listing skips isolated corrupt index members and records", async () => {
  const campaignId = "campaign-partial-failure-probe";
  const created = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: ["partial-list@example.com"],
    scheduledAt: "2099-08-09T10:00:00.000Z",
    subject: "partial failure probe",
    html: "<p>probe</p>",
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  execute(["ZADD", "lm:mail:marketing:campaign:index", String(Date.now() + 2), " "]);
  execute(["ZADD", "lm:mail:marketing:campaign:index", String(Date.now() + 1), "campaign-corrupt-neighbor"]);
  execute(["SET", "lm:mail:marketing:campaign:campaign-corrupt-neighbor", "{not-json"]);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let campaigns;
  try {
    campaigns = await queue.listMarketingCampaigns({ limit: 300 });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(campaigns.some((campaign) => campaign.id === campaignId), true);
  assert.equal(campaigns.some((campaign) => campaign.id === "campaign-corrupt-neighbor"), false);
  assert.equal(warnings.length >= 2, true);

  for (let index = 0; index < 60; index += 1) {
    const id = `campaign-corrupt-window-${String(index).padStart(2, "0")}`;
    execute(["ZADD", "lm:mail:marketing:campaign:index", String(Date.now() + 10_000 + index), id]);
    execute(["SET", `lm:mail:marketing:campaign:${id}`, "{not-json"]);
  }
  const one = await queue.listMarketingCampaigns({ limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, campaignId);
});

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

test("permanent failures stop after MAX_SEND_ATTEMPTS while quota failures don't count", async () => {
  const internals = queue.marketingCampaignQueueInternals;
  const scheduledAt = "2026-08-01T10:30:00.000Z"; // 北京 18:30
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-dead-address",
    recipients: ["dead@example.com"],
    scheduledAt,
    subject: "服务精选",
    html: "<p>hi</p>",
    text: "hi",
    preview: "preview",
    brandName: "冒央会社",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = internals.makeJobId("campaign-dead-address", "dead@example.com", new Date(scheduledAt).toISOString());
  const readJob = () => JSON.parse(store.get(`lm:mail:marketing:job:${jobId}`)?.value || "null");

  // 1) 配额失败:重排到下个北京晚间,不计入永久失败次数
  resendBehavior = "quota";
  const quotaRun = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) });
  assert.equal(quotaRun.failed, 1);
  let job = readJob();
  assert.equal(job.status, "queued");
  assert.equal(Number(job.failedAttempts || 0), 0);

  // 2) 连续真实失败:第 MAX_SEND_ATTEMPTS 次后 job 永久置 failed 并移出队列
  resendBehavior = "fail";
  let lastRun = null;
  for (let attempt = 1; attempt <= internals.MAX_SEND_ATTEMPTS; attempt += 1) {
    // 每次推进一整天,越过配额毒化的当日计数与 15 分钟重试间隔
    const now = Date.parse(scheduledAt) + attempt * 24 * 60 * 60 * 1000;
    lastRun = await queue.dispatchDueMarketingCampaigns({ now });
    job = readJob();
    if (attempt < internals.MAX_SEND_ATTEMPTS) {
      assert.equal(job.status, "queued", `第 ${attempt} 次失败后应重排`);
      assert.equal(job.failedAttempts, attempt);
    }
  }
  assert.equal(job.status, "failed");
  assert.equal(job.failedAttempts, internals.MAX_SEND_ATTEMPTS);
  assert.equal(lastRun.results[0].permanent, true);
  assert.equal(store.get("lm:mail:marketing:queue").value.has(jobId), false, "永久失败后应移出队列");

  // 3) 之后不再有 due job
  resendBehavior = "ok";
  const after = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) + 30 * 24 * 60 * 60 * 1000 });
  assert.equal(after.reason, "nothing_due");
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

test("idempotent retries repair missing queue/index membership and conflicting payloads cannot overwrite a campaign", async () => {
  const scheduledAt = "2026-09-10T10:30:00.000Z";
  const args = {
    campaignId: "campaign-atomic-repair",
    recipients: ["repair@example.com"],
    scheduledAt,
    subject: "original subject",
    html: "<p>original</p>",
    text: "original",
    preview: "original",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  };
  const first = await queue.enqueueMarketingCampaign(args);
  assert.equal(first.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(args.campaignId, args.recipients[0], scheduledAt);
  const job = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).delete(jobId);
  ensureZset("lm:mail:marketing:campaign:index").delete(args.campaignId);
  ensureSet(`lm:mail:marketing:recipients:${args.campaignId}`).delete(job.contactId);

  const retry = await queue.enqueueMarketingCampaign(args);
  assert.equal(retry.ok, true);
  assert.equal(retry.results[0].duplicate, true);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), true, "retry must repair a missing queue member");
  assert.equal(ensureZset("lm:mail:marketing:campaign:index").has(args.campaignId), true, "retry must repair a missing campaign index member");
  assert.equal(ensureSet(`lm:mail:marketing:recipients:${args.campaignId}`).has(job.contactId), true, "retry must repair missing recipient index membership");

  const conflict = await queue.enqueueMarketingCampaign({ ...args, subject: "mutated subject", html: "<p>mutated</p>" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "campaign_conflict");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:campaign:${args.campaignId}`).value).subject, "original subject");
});

test("dispatch fails closed when the atomic sending transition cannot be persisted", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-11T10:30:00.000Z";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-sending-fail-closed",
    recipients: ["fail-closed@example.com"],
    scheduledAt,
    subject: "fail closed",
    html: "<p>fail closed</p>",
    text: "fail closed",
    preview: "fail closed",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const before = resendRequests.length;
  failNextJobWrite = true;
  const dispatched = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
  assert.equal(dispatched.ok, false);
  assert.equal(dispatched.results[0].reason, "storage_failed_before_send");
  assert.equal(resendRequests.length, before, "provider must not be called before sending is durable");
});

test("a committed enqueue job write with a lost response is reported as queued, not failed", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-11T11:30:00.000Z";
  loseNextSaveJobResponse = true;
  const result = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-save-response-loss",
    recipients: ["save-loss@example.com"],
    scheduledAt,
    subject: "save response loss",
    html: "<p>save response loss</p>",
    text: "save response loss",
    preview: "save response loss",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.failedCount, 0);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(
    "campaign-save-response-loss",
    "save-loss@example.com",
    scheduledAt,
  );
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`)?.value || "null").status, "queued");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), true);
  assert.equal(ensureSet("lm:mail:marketing:jobs:campaign-save-response-loss").has(jobId), true);
  assert.equal(ensureSet("lm:mail:marketing:pending:campaign-save-response-loss").has(jobId), true);
});

test("an unexecuted null SAVE_JOB response fails instead of claiming a duplicate", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const campaignId = "campaign-save-null-not-executed";
  const email = "save-null-not-executed@example.com";
  const scheduledAt = "2026-09-11T11:40:00.000Z";
  saveJobProtocolFailures.push(null);
  const result = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "save null",
    html: "<p>save null</p>",
    text: "save null",
    preview: "save null",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  assert.equal(result.ok, false);
  assert.equal(result.queuedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(currentEntry(`lm:mail:marketing:job:${jobId}`), null);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), false);
  assert.equal(ensureSet(`lm:mail:marketing:jobs:${campaignId}`).has(jobId), false);
  assert.equal(ensureSet(`lm:mail:marketing:pending:${campaignId}`).has(jobId), false);
});

test("SAVE_JOB rejects empty, error-object, and unknown string protocol responses", async () => {
  const malformed = ["", { error: "ERR simulated single-row error" }, "__unexpected_save_reply__"];
  for (let index = 0; index < malformed.length; index += 1) {
    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
    const campaignId = `campaign-save-malformed-${index}`;
    const email = `save-malformed-${index}@example.com`;
    const scheduledAt = `2026-09-11T11:4${index + 1}:00.000Z`;
    saveJobProtocolFailures.push(malformed[index]);
    const result = await queue.enqueueMarketingCampaign({
      campaignId,
      recipients: [email],
      scheduledAt,
      subject: "malformed save",
      html: "<p>malformed save</p>",
      text: "malformed save",
      preview: "malformed save",
      brandName: "test",
      support: {},
      actor: { staffId: 1, staffUsername: "admin" },
    });
    const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
    assert.equal(result.ok, false);
    assert.equal(result.failedCount, 1);
    assert.equal(currentEntry(`lm:mail:marketing:job:${jobId}`), null);
  }
});

test("retrying a partially enqueued campaign fills only the missing job and metric", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const campaignId = "campaign-partial-enqueue-retry";
  const scheduledAt = "2026-09-11T11:50:00.000Z";
  const input = {
    campaignId,
    recipients: ["partial-enqueue-a@example.com", "partial-enqueue-b@example.com"],
    scheduledAt,
    subject: "partial enqueue",
    html: "<p>partial enqueue</p>",
    text: "partial enqueue",
    preview: "partial enqueue",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  };
  saveJobProtocolFailures.push(null);
  const first = await queue.enqueueMarketingCampaign(input);
  assert.equal(first.ok, false);
  assert.equal(first.queuedCount, 1);
  assert.equal(first.failedCount, 1);
  assert.equal(ensureSet(`lm:mail:marketing:jobs:${campaignId}`).size, 1);

  const retry = await queue.enqueueMarketingCampaign(input);
  assert.equal(retry.ok, true);
  assert.equal(retry.queuedCount, 2);
  assert.equal(retry.failedCount, 0);
  assert.equal(ensureSet(`lm:mail:marketing:jobs:${campaignId}`).size, 2);
  assert.equal(ensureSet(`lm:mail:marketing:pending:${campaignId}`).size, 2);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).size, 2);
  assert.equal((await queue.getMarketingCampaignCounters(campaignId)).queued, 2);

  const repeated = await queue.enqueueMarketingCampaign(input);
  assert.equal(repeated.ok, true);
  assert.equal(ensureSet(`lm:mail:marketing:jobs:${campaignId}`).size, 2);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).size, 2);
  assert.equal((await queue.getMarketingCampaignCounters(campaignId)).queued, 2);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:campaign:${campaignId}`).value).enqueueFailedCount, 0);
});

test("CREATE_CAMPAIGN distinguishes an unexecuted null from a committed lost response", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const input = (campaignId, email) => ({
    campaignId,
    recipients: [email],
    scheduledAt: "2026-09-11T11:55:00.000Z",
    subject: "create response",
    html: "<p>create response</p>",
    text: "create response",
    preview: "create response",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });

  createCampaignProtocolFailures.push(null);
  const missingId = "campaign-create-null-not-executed";
  const missing = await queue.enqueueMarketingCampaign(input(missingId, "create-null@example.com"));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "storage_failed");
  assert.equal(currentEntry(`lm:mail:marketing:campaign:${missingId}`), null);
  assert.equal(ensureZset("lm:mail:marketing:campaign:index").has(missingId), false);

  loseNextCreateCampaignResponse = true;
  const committedId = "campaign-create-response-loss";
  const committed = await queue.enqueueMarketingCampaign(input(committedId, "create-loss@example.com"));
  assert.equal(committed.ok, true);
  assert.equal(committed.queuedCount, 1);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:campaign:${committedId}`).value).id, committedId);
  assert.equal(ensureZset("lm:mail:marketing:campaign:index").has(committedId), true);
  assert.equal(ensureSet(`lm:mail:marketing:jobs:${committedId}`).size, 1);
});

test("CREATE_CAMPAIGN rejects empty, error-object, and unknown string protocol responses", async () => {
  const malformed = ["", { error: "ERR simulated single-row error" }, "__unexpected_create_reply__"];
  for (let index = 0; index < malformed.length; index += 1) {
    const campaignId = `campaign-create-malformed-${index}`;
    createCampaignProtocolFailures.push(malformed[index]);
    const result = await queue.enqueueMarketingCampaign({
      campaignId,
      recipients: [`create-malformed-${index}@example.com`],
      scheduledAt: `2026-09-11T11:5${index + 6}:00.000Z`,
      subject: "malformed create",
      html: "<p>malformed create</p>",
      text: "malformed create",
      preview: "malformed create",
      brandName: "test",
      support: {},
      actor: { staffId: 1, staffUsername: "admin" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "storage_failed");
    assert.equal(currentEntry(`lm:mail:marketing:campaign:${campaignId}`), null);
  }
});

test("a committed sending transition with a lost response still sends exactly once", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-11T12:30:00.000Z";
  const result = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-transition-response-loss",
    recipients: ["transition-loss@example.com"],
    scheduledAt,
    subject: "transition response loss",
    html: "<p>transition response loss</p>",
    text: "transition response loss",
    preview: "transition response loss",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(result.ok, true);
  const before = resendRequests.length;
  loseNextTransitionResponse = true;
  const dispatched = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
  const replay = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) + 60_000, interJobDelayMs: 0 });
  assert.equal(dispatched.submitted, 1);
  assert.equal(replay.submitted, 0);
  assert.equal(resendRequests.length, before + 1);
});

test("lease heartbeat prevents a second worker after the original TTL and compare-release preserves a new owner", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-12T10:30:00.000Z";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-lease-heartbeat",
    recipients: ["lease@example.com"],
    scheduledAt,
    subject: "lease",
    html: "<p>lease</p>",
    text: "lease",
    preview: "lease",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  resendBehavior = "ok";
  resendDelayMs = 1_350;
  const first = queue.dispatchDueMarketingCampaigns({
    now: Date.parse(scheduledAt),
    lockTtlSeconds: 1,
    lockHeartbeatMs: 100,
    interJobDelayMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), lockTtlSeconds: 1, lockHeartbeatMs: 100, interJobDelayMs: 0 });
  assert.equal(second.reason, "locked");
  const firstResult = await first;
  assert.equal(firstResult.submitted, 1);
  resendDelayMs = 0;

  const lockKey = queue.marketingCampaignQueueInternals.DISPATCH_LOCK_KEY;
  store.set(lockKey, { type: "string", value: "replacement-owner", expiresAt: Date.now() + 60_000 });
  assert.equal(await queue.marketingCampaignQueueInternals.releaseDispatchLease("stale-owner"), false);
  assert.equal(currentEntry(lockKey).value, "replacement-owner");
  store.delete(lockKey);
});

test("dispatch lock storage failure is not reported as a healthy competing worker", async () => {
  const lockKey = queue.marketingCampaignQueueInternals.DISPATCH_LOCK_KEY;
  store.delete(lockKey);
  failNextDispatchLockWrite = true;
  const result = await queue.dispatchDueMarketingCampaigns({ now: Date.now(), interJobDelayMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lock_store_unavailable");
  assert.equal(result.skipped, true);
});

test("provider success followed by terminal commit failure is recovered without a second send", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-13T10:30:00.000Z";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-provider-commit-recovery",
    recipients: ["commit-recovery@example.com"],
    scheduledAt,
    subject: "commit recovery",
    html: "<p>commit recovery</p>",
    text: "commit recovery",
    preview: "commit recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId("campaign-provider-commit-recovery", "commit-recovery@example.com", scheduledAt);
  const sendsBefore = resendRequests.length;
  failNextTerminalTransition = true;
  const first = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
  assert.equal(first.ok, false);
  assert.equal(first.results[0].reason, "delivery_commit_pending");
  const dailyKey = `lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(Date.parse(scheduledAt))}`;
  assert.equal(currentEntry(dailyKey)?.value, "1", "the provider attempt is reserved before the terminal commit");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "sending");
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const recoveredAt = Date.parse(scheduledAt) + 24 * 60 * 60 * 1000;
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt, interJobDelayMs: 0 });
  assert.equal(recovered.submitted, 1);
  assert.equal(recovered.results[0].recovered, true);
  assert.equal(resendRequests.length, sendsBefore + 1, "recovery must only commit the durable delivery record");
  assert.equal(currentEntry(dailyKey)?.value, "1", "recovering a new reserved sending job must not reserve again");
  assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(recoveredAt)}`), null, "an old-day marker remains authoritative for its attempt");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
});

test("a corrupt mapped delivery blocks sending-job recovery instead of being treated as absent", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-13T11:30:00.000Z";
  const campaignId = "campaign-corrupt-delivery-recovery";
  const email = "corrupt-delivery-recovery@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "corrupt delivery recovery",
    html: "<p>corrupt delivery recovery</p>",
    text: "corrupt delivery recovery",
    preview: "corrupt delivery recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const sendsBefore = resendRequests.length;
  failNextTerminalTransition = true;
  const interrupted = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
  assert.equal(interrupted.results[0].reason, "delivery_commit_pending");
  const sendingJob = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
  assert.equal(sendingJob.status, "sending");
  const mapping = currentEntry(`lm:mail:delivery:message:${sendingJob.deliveryMessageId}`);
  assert.ok(mapping?.value);
  const deliveryKey = `lm:mail:delivery:record:${mapping.value}`;
  const validDelivery = currentEntry(deliveryKey);
  assert.ok(validDelivery?.value);
  store.set(deliveryKey, { type: "string", value: "{not-json" });
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const recoveredAt = Date.parse(scheduledAt) + 24 * 60 * 60 * 1000;
  const blocked = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt, interJobDelayMs: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.results[0].reason, "delivery_recovery_unavailable");
  assert.equal(resendRequests.length, sendsBefore + 1, "corrupt recovery storage must not trigger a second provider send");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "sending");

  store.set(deliveryKey, validDelivery);
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt + 60_000, interJobDelayMs: 0 });
  assert.equal(recovered.results[0].recovered, true);
  assert.equal(resendRequests.length, sendsBefore + 1);
});

test("a legacy sending job with a durable success recovers without consuming today's quota", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-13T12:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-legacy-sending-reservation";
  const email = "legacy-sending@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "legacy recovery",
    html: "<p>legacy recovery</p>",
    text: "legacy recovery",
    preview: "legacy recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const sendsBefore = resendRequests.length;
  failNextTerminalTransition = true;
  const first = await queue.dispatchDueMarketingCampaigns({ now, interJobDelayMs: 0 });
  assert.equal(first.results[0].reason, "delivery_commit_pending");

  const day = queue.marketingCampaignQueueInternals.beijingDayKey(now);
  store.delete(`lm:mail:marketing:claim:${jobId}`);
  store.delete(`lm:mail:marketing:daily-attempt:${jobId}:1`);
  store.delete(`lm:mail:marketing:daily:${day}`);
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, interJobDelayMs: 0 });
  assert.equal(recovered.submitted, 1);
  assert.equal(recovered.results[0].recovered, true);
  assert.equal(resendRequests.length, sendsBefore + 1);
  assert.equal(currentEntry(`lm:mail:marketing:daily:${day}`), null);
  assert.equal(currentEntry(`lm:mail:marketing:daily-attempt:${jobId}:1`), null);
});

test("cancelling a campaign immediately removes pending jobs and completed campaigns reject illegal transitions", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-14T10:30:00.000Z";
  const campaignId = "campaign-cancel-cleanup";
  const email = "cancel@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "cancel",
    html: "<p>cancel</p>",
    text: "cancel",
    preview: "cancel",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const cancelled = await queue.updateMarketingCampaignStatus(campaignId, "cancelled", { staffId: 1, staffUsername: "admin" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelledJobs, 1);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), false);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "cancelled");
  const illegal = await queue.updateMarketingCampaignStatus(campaignId, "scheduled", { staffId: 1, staffUsername: "admin" });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.error, "invalid_status_transition");
});

test("pause, resume, and cancel retries are idempotent", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-14T11:00:00.000Z";
  const campaignId = "campaign-idempotent-status";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: ["idempotent@example.com"],
    scheduledAt,
    subject: "idempotent",
    html: "<p>idempotent</p>",
    text: "idempotent",
    preview: "idempotent",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  assert.equal((await queue.updateMarketingCampaignStatus(campaignId, "paused")).ok, true);
  assert.equal((await queue.updateMarketingCampaignStatus(campaignId, "paused")).ok, true);
  assert.equal((await queue.updateMarketingCampaignStatus(campaignId, "scheduled")).ok, true);
  assert.equal((await queue.updateMarketingCampaignStatus(campaignId, "scheduled")).ok, true);
  const firstCancel = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  const repeatedCancel = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(firstCancel.ok, true);
  assert.equal(firstCancel.cancelledJobs, 1);
  assert.equal(repeatedCancel.ok, true);
  assert.equal(repeatedCancel.cancelledJobs, 0);
  assert.equal(repeatedCancel.campaign.cancelledAt, firstCancel.campaign.cancelledAt);
});

test("a failed strict job read never deletes queued work and a cancellation retry completes safely", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-14T11:30:00.000Z";
  const campaignId = "campaign-cancel-read-outage";
  const email = "cancel-read-outage@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "read outage",
    html: "<p>read outage</p>",
    text: "read outage",
    preview: "read outage",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);

  failNextPipelineCommand = "GET";
  const failed = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "storage_failed");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "queued");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), true);
  assert.equal(ensureSet(`lm:mail:marketing:pending:${campaignId}`).has(jobId), true);

  const retried = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(retried.ok, true);
  assert.equal(retried.cancelledJobs, 1);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "cancelled");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), false);
});

test("a failed cleanup pipeline is reported and an idempotent retry removes only still-missing jobs", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-14T12:00:00.000Z";
  const campaignId = "campaign-cancel-cleanup-outage";
  const email = "cancel-cleanup-outage@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "cleanup outage",
    html: "<p>cleanup outage</p>",
    text: "cleanup outage",
    preview: "cleanup outage",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  store.delete(`lm:mail:marketing:job:${jobId}`);

  failNextPipelineCommand = "EVAL";
  const failed = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "storage_failed");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), true);
  assert.equal(ensureSet(`lm:mail:marketing:pending:${campaignId}`).has(jobId), true);

  const retried = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(retried.ok, true);
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), false);
  assert.equal(ensureSet(`lm:mail:marketing:pending:${campaignId}`).has(jobId), false);
});

test("recipient persistence failures are surfaced and repaired by cancellation retry", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-14T12:30:00.000Z";
  const campaignId = "campaign-cancel-recipient-outage";
  const email = "cancel-recipient-outage@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "recipient outage",
    html: "<p>recipient outage</p>",
    text: "recipient outage",
    preview: "recipient outage",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);

  failNextPipelineCommand = "SET";
  const failed = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "storage_failed");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "cancelled");

  const retried = await queue.updateMarketingCampaignStatus(campaignId, "cancelled");
  assert.equal(retried.ok, true);
  const recipient = Array.from(store.entries())
    .find(([key]) => key.startsWith(`lm:mail:marketing:recipient:${campaignId}:`));
  assert.equal(JSON.parse(recipient?.[1]?.value || "null").status, "cancelled");
});

test("a cancellation that wins after claim but before sending prevents every provider call", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-15T10:30:00.000Z";
  const campaignId = "campaign-cancel-wins-before-send";
  const email = "cancel-wins@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "cancel wins",
    html: "<p>cancel wins</p>",
    text: "cancel wins",
    preview: "cancel wins",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  assert.doesNotMatch(JSON.stringify(enqueued), /@example\.com/, "queue responses must not expose recipient PII");

  const sendsBefore = resendRequests.length;
  let cancelResult = null;
  const dispatched = await queue.dispatchDueMarketingCampaigns({
    now: Date.parse(scheduledAt),
    interJobDelayMs: 0,
    _testHooks: {
      afterClaim: async () => {
        cancelResult = await queue.updateMarketingCampaignStatus(campaignId, "cancelled", { staffId: 1, staffUsername: "admin" });
      },
    },
  });
  assert.equal(cancelResult?.ok, true, "queued work may still be cancelled after a worker claim");
  assert.equal(resendRequests.length, sendsBefore, "a successful cancellation must make the provider preflight fail closed");
  assert.equal(dispatched.submitted, 0);
  assert.doesNotMatch(JSON.stringify(dispatched), /@example\.com/, "dispatch responses must not expose recipient PII");
});

test("an offer that expires at provider preflight is suppressed once without sending", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-15T12:00:00.000Z";
  const endsAt = "2026-09-15T12:01:00.000Z";
  const campaignId = "campaign-offer-expires-before-provider";
  const email = "offer-expired@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "expiring offer",
    html: "<p>expiring offer</p>",
    text: "expiring offer",
    preview: "expiring offer",
    brandName: "test",
    support: {},
    offerSnapshot: { endsAt },
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  const sendsBefore = resendRequests.length;
  const originalNow = Date.now;
  let dispatched;
  try {
    Date.now = () => Date.parse(scheduledAt);
    dispatched = await queue.dispatchDueMarketingCampaigns({
      now: Date.parse(scheduledAt),
      interJobDelayMs: 0,
      _testHooks: {
        beforeProvider: async () => {
          Date.now = () => Date.parse(endsAt) + 1;
        },
      },
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.submitted, 0);
  assert.equal(dispatched.failed, 0);
  assert.equal(dispatched.results[0]?.suppressed, true);
  assert.equal(dispatched.results[0]?.reason, "offer_expired");
  assert.equal(resendRequests.length, sendsBefore, "an expired offer must never reach the email provider");

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const job = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`)?.value || "null");
  assert.equal(job.status, "suppressed");
  assert.equal(job.lastError, "offer_expired");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), false);
  const counters = await queue.getMarketingCampaignCounters(campaignId);
  assert.equal(counters.suppressed, 1);

  const repeated = await queue.dispatchDueMarketingCampaigns({
    now: Date.parse(endsAt) + 60_000,
    interJobDelayMs: 0,
  });
  assert.equal(repeated.submitted, 0);
  assert.equal(resendRequests.length, sendsBefore);
  assert.equal((await queue.getMarketingCampaignCounters(campaignId)).suppressed, 1);
});

test("an interrupted offer suppression resumes from its marker without an unknown send or duplicate metric", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-15T13:00:00.000Z";
  const endsAt = "2026-09-15T13:01:00.000Z";
  const campaignId = "campaign-offer-suppression-recovery";
  const email = "offer-recovery@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "recover suppression",
    html: "<p>recover suppression</p>",
    text: "recover suppression",
    preview: "recover suppression",
    brandName: "test",
    support: {},
    offerSnapshot: { endsAt },
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  const sendsBefore = resendRequests.length;
  const originalNow = Date.now;
  let interrupted;
  try {
    Date.now = () => Date.parse(scheduledAt);
    failNextTerminalTransition = true;
    interrupted = await queue.dispatchDueMarketingCampaigns({
      now: Date.parse(scheduledAt),
      interJobDelayMs: 0,
      _testHooks: {
        beforeProvider: async () => {
          Date.now = () => Date.parse(endsAt) + 1;
        },
      },
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.failed, 1);
  assert.equal(resendRequests.length, sendsBefore);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  let job = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`)?.value || "null");
  assert.equal(job.status, "sending");
  assert.equal(job.sendBlockedReason, "offer_expired");

  const recovered = await queue.dispatchDueMarketingCampaigns({
    now: Date.parse(endsAt) + 60_000,
    interJobDelayMs: 0,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.failed, 0);
  assert.equal(recovered.results[0]?.suppressed, true);
  assert.equal(resendRequests.length, sendsBefore);
  job = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`)?.value || "null");
  assert.equal(job.status, "suppressed");
  assert.equal((await queue.getMarketingCampaignCounters(campaignId)).suppressed, 1);
});

test("cancelling an atomically sending job returns in-flight and never reports a false cancellation", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-16T10:30:00.000Z";
  const campaignId = "campaign-cancel-during-sending";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: ["already-sending@example.com"],
    scheduledAt,
    subject: "already sending",
    html: "<p>already sending</p>",
    text: "already sending",
    preview: "already sending",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  const sendsBefore = resendRequests.length;
  let cancelResult = null;
  const dispatched = await queue.dispatchDueMarketingCampaigns({
    now: Date.parse(scheduledAt),
    interJobDelayMs: 0,
    _testHooks: {
      beforeProvider: async () => {
        cancelResult = await queue.updateMarketingCampaignStatus(campaignId, "cancelled", { staffId: 1, staffUsername: "admin" });
      },
    },
  });
  assert.equal(cancelResult?.ok, false);
  assert.equal(cancelResult?.error, "campaign_in_flight");
  assert.equal(dispatched.submitted, 1);
  assert.equal(resendRequests.length, sendsBefore + 1);
});

test("cron returns 503 for a partially successful provider batch", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-17T10:30:00.000Z";
  const failedRecipient = "cron-failed@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-cron-partial-failure",
    recipients: ["cron-success@example.com", failedRecipient],
    scheduledAt,
    subject: "cron partial",
    html: "<p>cron partial</p>",
    text: "cron partial",
    preview: "cron partial",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  resendFailureRecipients.add(failedRecipient);
  const originalNow = Date.now;
  let response;
  try {
    Date.now = () => Date.parse(scheduledAt);
    response = await marketingCronRoute.GET(new Request("https://www.liumeiti.vip/api/cron/marketing-campaign", {
      headers: { authorization: "Bearer marketing-cron-test-secret" },
    }));
  } finally {
    Date.now = originalNow;
    resendFailureRecipients.delete(failedRecipient);
  }
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.submitted, 1);
  assert.equal(body.failed, 1);
  assert.doesNotMatch(JSON.stringify(body), /@example\.com/);
});

test("dispatch deadline cancellation before the provider requeues a claimed job without sending", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2026-09-19T10:30:00.000Z";
  const campaignId = "campaign-deadline-before-provider";
  const email = "deadline-before-provider@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "deadline",
    html: "<p>deadline</p>",
    text: "deadline",
    preview: "deadline",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const beforeProviderRequests = resendRequests.length;
  let keepRunning = true;
  const result = await queue.dispatchDueMarketingCampaigns({
    now: Date.parse(scheduledAt),
    interJobDelayMs: 0,
    shouldContinue: () => keepRunning,
    deadlineAt: Date.now() + 60_000,
    _testHooks: {
      beforeProvider() { keepRunning = false; },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.error, "maintenance_deadline_exceeded");
  assert.equal(resendRequests.length, beforeProviderRequests);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const storedJob = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
  assert.equal(storedJob.status, "queued");
  assert.equal(Object.hasOwn(storedJob, "resendIdempotencyDeadlineAt"), false, "a controlled stop before the provider must not create an uncertain outcome deadline");
  assert.equal(ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).has(jobId), true);
});

test("500-recipient enqueue uses bounded concurrency under Redis latency", async () => {
  const recipients = Array.from({ length: 500 }, (_, index) => `bulk-${index}@example.com`);
  redisDelayMs = 2;
  maxActiveRedisRequests = 0;
  const startedAt = Date.now();
  const result = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-bounded-500",
    recipients,
    scheduledAt: "2026-09-20T10:30:00.000Z",
    subject: "bulk",
    html: "<p>bulk</p>",
    text: "bulk",
    preview: "bulk",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  const elapsed = Date.now() - startedAt;
  redisDelayMs = 0;
  assert.equal(result.ok, true);
  assert.equal(result.queuedCount, 500);
  assert.ok(maxActiveRedisRequests > 1, `expected concurrent Redis requests, saw ${maxActiveRedisRequests}`);
  assert.ok(maxActiveRedisRequests <= queue.marketingCampaignQueueInternals.ENQUEUE_CONCURRENCY, `concurrency ${maxActiveRedisRequests} exceeded bound`);
  assert.ok(elapsed < 8_000, `bounded enqueue took ${elapsed}ms`);
});

test("campaign status CAS preserves untouched legacy JSON tokens byte for byte", async () => {
  const campaignId = "campaign-raw-bytes-01";
  const key = `lm:mail:marketing:campaign:${campaignId}`;
  const raw = `{"id":"${campaignId}","status":"scheduled","legacyEmpty":[],"legacyNull":null,"legacyLong":900719925474099312345,"createdAtMs":1}`;
  store.set(key, { type: "string", value: raw });
  const result = await queue.updateMarketingCampaignStatus(campaignId, "paused");
  assert.equal(result.ok, true);
  const saved = currentEntry(key)?.value || "";
  assert.match(saved, /"legacyEmpty":\[\]/);
  assert.match(saved, /"legacyNull":null/);
  assert.match(saved, /"legacyLong":900719925474099312345/);
  assert.equal(JSON.parse(saved).status, "paused");
});

test("an overlong recipient cannot be queued as a truncated address alias", async () => {
  const overlong = `${"a".repeat(242)}@example.comX`;
  const campaignId = "campaign-overlong-recipient";
  const result = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [overlong],
    scheduledAt: "2026-09-21T10:30:00.000Z",
    subject: "alias", html: "<p>alias</p>", text: "alias",
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_campaign");
  assert.equal(currentEntry(`lm:mail:marketing:campaign:${campaignId}`), null);
});

test("a campaign index or key cannot cancel or dispatch content whose body belongs to another campaign", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2027-01-10T10:30:00.000Z";
  const campaignA = "campaign-identity-key-a";
  const campaignB = "campaign-identity-key-b";
  const emailA = "campaign-key-a@example.com";
  const emailB = "campaign-key-b@example.com";
  const input = (campaignId, recipient, subject) => ({
    campaignId,
    recipients: [recipient],
    scheduledAt,
    subject,
    html: `<p>${subject}</p>`,
    text: subject,
    preview: subject,
    brandName: "identity-test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal((await queue.enqueueMarketingCampaign(input(campaignA, emailA, "campaign A"))).ok, true);
  assert.equal((await queue.enqueueMarketingCampaign(input(campaignB, emailB, "campaign B"))).ok, true);

  const jobAId = queue.marketingCampaignQueueInternals.makeJobId(campaignA, emailA, scheduledAt);
  const jobAKey = `lm:mail:marketing:job:${jobAId}`;
  const jobA = JSON.parse(currentEntry(jobAKey)?.value || "null");
  const campaignAKey = `lm:mail:marketing:campaign:${campaignA}`;
  const campaignBKey = `lm:mail:marketing:campaign:${campaignB}`;
  const campaignARaw = currentEntry(campaignAKey)?.value;
  const campaignBRaw = currentEntry(campaignBKey)?.value;
  const jobARaw = currentEntry(jobAKey)?.value;
  const recipientAKey = `lm:mail:marketing:recipient:${campaignA}:${jobA.contactId}`;
  const recipientARaw = currentEntry(recipientAKey)?.value;
  const sendsBefore = resendRequests.length;
  assert.equal(ensureZset("lm:mail:marketing:campaign:index").has(campaignA), true);

  store.set(campaignAKey, { type: "string", value: campaignBRaw });
  try {
    const cancelled = await queue.updateMarketingCampaignStatus(campaignA, "cancelled", { staffId: 1, staffUsername: "admin" });
    assert.equal(cancelled.ok, false);
    assert.equal(currentEntry(campaignAKey)?.value, campaignBRaw);
    assert.equal(currentEntry(campaignBKey)?.value, campaignBRaw, "the real campaign B must remain byte-identical");
    assert.equal(currentEntry(jobAKey)?.value, jobARaw, "cancellation must not mutate campaign A's job");
    assert.equal(currentEntry(recipientAKey)?.value, recipientARaw, "cancellation must not mutate the recipient");

    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).set(jobAId, Date.parse(scheduledAt));
    resendBehavior = "ok";
    const dispatched = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
    assert.equal(dispatched.failed, 1);
    assert.equal(dispatched.results[0]?.reason, "invalid_campaign_record");
    assert.equal(resendRequests.length, sendsBefore, "mismatched campaign content must never reach the provider");
    assert.equal(currentEntry(jobAKey)?.value, jobARaw);
    assert.equal(currentEntry(recipientAKey)?.value, recipientARaw);
    assert.equal(currentEntry(campaignBKey)?.value, campaignBRaw);
  } finally {
    store.set(campaignAKey, { type: "string", value: campaignARaw });
    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  }
});

test("a marketing job key cannot cancel, dispatch, or rewrite a recipient when its body belongs to another job", async () => {
  ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  const scheduledAt = "2027-01-11T10:30:00.000Z";
  const campaignA = "campaign-job-identity-a";
  const campaignB = "campaign-job-identity-b";
  const emailA = "job-key-a@example.com";
  const emailB = "job-key-b@example.com";
  const input = (campaignId, recipient) => ({
    campaignId,
    recipients: [recipient],
    scheduledAt,
    subject: campaignId,
    html: `<p>${campaignId}</p>`,
    text: campaignId,
    preview: campaignId,
    brandName: "identity-test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal((await queue.enqueueMarketingCampaign(input(campaignA, emailA))).ok, true);
  assert.equal((await queue.enqueueMarketingCampaign(input(campaignB, emailB))).ok, true);

  const jobAId = queue.marketingCampaignQueueInternals.makeJobId(campaignA, emailA, scheduledAt);
  const jobBId = queue.marketingCampaignQueueInternals.makeJobId(campaignB, emailB, scheduledAt);
  const jobAKey = `lm:mail:marketing:job:${jobAId}`;
  const jobBKey = `lm:mail:marketing:job:${jobBId}`;
  const jobARaw = currentEntry(jobAKey)?.value;
  const jobBRaw = currentEntry(jobBKey)?.value;
  const jobA = JSON.parse(jobARaw || "null");
  const jobB = JSON.parse(jobBRaw || "null");
  const campaignAKey = `lm:mail:marketing:campaign:${campaignA}`;
  const campaignARaw = currentEntry(campaignAKey)?.value;
  const recipientAKey = `lm:mail:marketing:recipient:${campaignA}:${jobA.contactId}`;
  const recipientBKey = `lm:mail:marketing:recipient:${campaignB}:${jobB.contactId}`;
  const recipientARaw = currentEntry(recipientAKey)?.value;
  const recipientBRaw = currentEntry(recipientBKey)?.value;
  const sendsBefore = resendRequests.length;

  store.set(jobAKey, { type: "string", value: jobBRaw });
  try {
    const cancelled = await queue.updateMarketingCampaignStatus(campaignA, "cancelled", { staffId: 1, staffUsername: "admin" });
    assert.equal(cancelled.ok, false);
    assert.equal(currentEntry(campaignAKey)?.value, campaignARaw, "campaign state must not change before every job validates");
    assert.equal(currentEntry(jobAKey)?.value, jobBRaw);
    assert.equal(currentEntry(jobBKey)?.value, jobBRaw, "the real job B must remain byte-identical");
    assert.equal(currentEntry(recipientAKey)?.value, recipientARaw);
    assert.equal(currentEntry(recipientBKey)?.value, recipientBRaw);

    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).set(jobAId, Date.parse(scheduledAt));
    resendBehavior = "ok";
    const dispatched = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt), interJobDelayMs: 0 });
    assert.equal(dispatched.failed, 1);
    assert.equal(dispatched.results[0]?.reason, "invalid_job_record");
    assert.equal(resendRequests.length, sendsBefore, "mismatched job content must never reach the provider");
    assert.equal(currentEntry(jobAKey)?.value, jobBRaw);
    assert.equal(currentEntry(jobBKey)?.value, jobBRaw);
    assert.equal(currentEntry(recipientAKey)?.value, recipientARaw);
    assert.equal(currentEntry(recipientBKey)?.value, recipientBRaw);
  } finally {
    store.set(jobAKey, { type: "string", value: jobARaw });
    ensureZset(queue.marketingCampaignQueueInternals.QUEUE_KEY).clear();
  }
});

test("scheduled marketing is forced through Resend, runs 40 then 10, and resumes the remainder next Beijing day", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-01T10:30:00.000Z";
  const firstDay = Date.parse(scheduledAt);
  const secondDay = firstDay + 24 * 60 * 60 * 1000;
  const campaignId = "campaign-resend-daily-fifty";
  const recipients = Array.from({ length: 51 }, (_, index) => `daily-limit-${String(index + 1).padStart(2, "0")}@example.com`);
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients,
    scheduledAt,
    subject: "daily limit",
    html: "<p>daily limit</p>",
    text: "daily limit",
    preview: "daily limit",
    brandName: "冒央会社",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  assert.equal(enqueued.queuedCount, 51);

  const configuredProvider = process.env.EMAIL_PROVIDER;
  const sendsBefore = resendRequests.length;
  resendBehavior = "ok";
  process.env.EMAIL_PROVIDER = "smtp";
  try {
    const first = await queue.dispatchDueMarketingCampaigns({ now: firstDay, limit: 40, interJobDelayMs: 0 });
    assert.equal(queue.MARKETING_DAILY_LIMIT, 50);
    assert.equal(first.ok, true);
    assert.equal(first.submitted, 40);
    assert.equal(first.failed, 0);
    assert.equal(resendRequests.length - sendsBefore, 40, "configured SMTP must not receive scheduled marketing");
    assert.equal(ensureZset(queueKey).size, 11);
    assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(firstDay)}`)?.value, "40");

    const sameDay = await queue.dispatchDueMarketingCampaigns({ now: firstDay + 60_000, limit: 40, interJobDelayMs: 0 });
    assert.equal(sameDay.ok, true);
    assert.equal(sameDay.submitted, 10);
    assert.equal(resendRequests.length - sendsBefore, 50);
    assert.equal(ensureZset(queueKey).size, 1);
    assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(firstDay)}`)?.value, "50");

    const exhausted = await queue.dispatchDueMarketingCampaigns({ now: firstDay + 120_000, limit: 40, interJobDelayMs: 0 });
    assert.equal(exhausted.reason, "daily_limit");
    assert.equal(exhausted.submitted, 0);
    assert.equal(resendRequests.length - sendsBefore, 50);

    const nextDay = await queue.dispatchDueMarketingCampaigns({ now: secondDay, limit: 40, interJobDelayMs: 0 });
    assert.equal(nextDay.ok, true);
    assert.equal(nextDay.submitted, 1);
    assert.equal(nextDay.failed, 0);
    assert.equal(resendRequests.length - sendsBefore, 51);
    assert.equal(ensureZset(queueKey).size, 0);
    assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(secondDay)}`)?.value, "1");
  } finally {
    if (configuredProvider == null) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = configuredProvider;
    ensureZset(queueKey).clear();
    store.delete("lm:mail:marketing:dispatch-lock");
    store.delete(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(firstDay)}`);
    store.delete(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(secondDay)}`);
  }
});

test("failed Resend jobs consume the same strict 50-attempt Beijing-day budget", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-03T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const dayKey = `lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(now)}`;
  const recipients = Array.from({ length: 3 }, (_, index) => `failed-attempt-${index}@example.com`);
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId: "campaign-failed-attempt-budget",
    recipients,
    scheduledAt,
    subject: "attempt budget",
    html: "<p>attempt budget</p>",
    text: "attempt budget",
    preview: "attempt budget",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  store.set(dayKey, { type: "string", value: "48" });
  const attemptsBefore = resendAttempts.length;
  resendBehavior = "fail";
  try {
    const first = await queue.dispatchDueMarketingCampaigns({ now, limit: 40, interJobDelayMs: 0 });
    assert.equal(first.failed, 2);
    assert.equal(new Set(resendAttempts.slice(attemptsBefore).flatMap((body) => body.to || [])).size, 2);
    assert.equal(resendAttempts.length - attemptsBefore, 4, "transport retries reuse the same job idempotency key");
    assert.equal(currentEntry(dayKey)?.value, "50");

    const exhausted = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
    assert.equal(exhausted.reason, "daily_limit");
    assert.equal(new Set(resendAttempts.slice(attemptsBefore).flatMap((body) => body.to || [])).size, 2, "no 51st logical provider job may start on the same Beijing day");
  } finally {
    resendBehavior = "ok";
    ensureZset(queueKey).clear();
    store.delete("lm:mail:marketing:dispatch-lock");
    store.delete(dayKey);
  }
});

test("a lost atomic reservation response is recovered without double counting or double sending", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-04T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-reservation-response-loss";
  const email = "reservation-loss@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "reservation loss",
    html: "<p>reservation loss</p>",
    text: "reservation loss",
    preview: "reservation loss",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const sendsBefore = resendRequests.length;
  loseNextQuotaReservationResponse = true;
  const dispatched = await queue.dispatchDueMarketingCampaigns({ now, limit: 40, interJobDelayMs: 0 });
  assert.equal(dispatched.submitted, 1);
  assert.equal(resendRequests.length - sendsBefore, 1);
  assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(now)}`)?.value, "1");
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  assert.equal(currentEntry(`lm:mail:marketing:daily-attempt:${jobId}:1`)?.value, queue.marketingCampaignQueueInternals.beijingDayKey(now));
  const replay = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
  assert.equal(replay.submitted, 0);
  assert.equal(resendRequests.length - sendsBefore, 1);
});

test("a crash after quota reservation but before Resend is retried safely without losing the recipient", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-05T15:59:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-crash-after-quota-reservation";
  const email = "crash-after-reservation@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "crash recovery",
    html: "<p>crash recovery</p>",
    text: "crash recovery",
    preview: "crash recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const sendsBefore = resendRequests.length;
  await assert.rejects(
    queue.dispatchDueMarketingCampaigns({
      now,
      limit: 40,
      interJobDelayMs: 0,
      _testHooks: { afterQuotaReservation() { throw new Error("simulated_process_exit"); } },
    }),
    /simulated_process_exit/,
  );
  assert.equal(resendRequests.length, sendsBefore, "the simulated crash happens before the provider call");
  const firstDayKey = `lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(now)}`;
  assert.equal(currentEntry(firstDayKey)?.value, "1");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "sending");

  store.delete(`lm:mail:marketing:claim:${jobId}`);
  const recoveredAt = now + 2 * 60_000;
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt, limit: 40, interJobDelayMs: 0 });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.results[0].reason, "idempotent_provider_retry_scheduled");
  assert.equal(resendRequests.length, sendsBefore);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "queued");

  const retriedAt = now + 3 * 60_000;
  const retried = await queue.dispatchDueMarketingCampaigns({ now: retriedAt, limit: 40, interJobDelayMs: 0 });
  assert.equal(retried.submitted, 1);
  assert.equal(resendRequests.length, sendsBefore + 1);
  const secondDayKey = `lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(retriedAt)}`;
  assert.notEqual(firstDayKey, secondDayKey);
  assert.equal(currentEntry(firstDayKey)?.value, "1", "the abandoned pre-midnight reservation remains charged to its day");
  assert.equal(currentEntry(secondDayKey)?.value, "1", "the recovered provider call is charged to its actual Beijing day");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
});

test("provider acceptance before local recording retries with byte-identical payload and sends only once", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-06T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-provider-accepted-before-record";
  const email = "provider-accepted-before-record@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "accepted before record",
    html: '<p><a href="https://www.liumeiti.vip/shop">open shop</a></p>',
    text: "open shop",
    preview: "accepted before record",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const deliveriesBefore = resendRequests.length;
  const attemptsBefore = resendAttemptMeta.length;
  await assert.rejects(queue.dispatchDueMarketingCampaigns({
    now,
    limit: 40,
    interJobDelayMs: 0,
    _testHooks: { afterProviderBeforeRecord() { throw new Error("simulated_crash_before_local_record"); } },
  }), /simulated_crash_before_local_record/);
  assert.equal(resendRequests.length, deliveriesBefore + 1, "Resend accepted exactly one physical email");
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const recovered = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
  assert.equal(recovered.results[0].reason, "idempotent_provider_retry_scheduled");
  const retried = await queue.dispatchDueMarketingCampaigns({ now: now + 120_000, limit: 40, interJobDelayMs: 0 });
  assert.equal(retried.submitted, 1);
  assert.equal(resendRequests.length, deliveriesBefore + 1, "the repeated POST must resolve to the original provider delivery");

  const attempts = resendAttemptMeta.slice(attemptsBefore).filter((item) => item.body.to?.includes(email));
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].idempotencyKey);
  assert.equal(attempts[1].idempotencyKey, attempts[0].idempotencyKey);
  assert.equal(attempts[1].payloadJson, attempts[0].payloadJson, "same key retries must be byte-identical, including click and unsubscribe tokens");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
});

test("Resend concurrent idempotency responses stay recoverable with the same payload", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-06T12:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-concurrent-idempotency";
  const email = "concurrent-idempotency@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "concurrent idempotency",
    html: '<p><a href="https://www.liumeiti.vip/shop">open shop</a></p>',
    text: "open shop",
    preview: "concurrent idempotency",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const attemptsBefore = resendAttemptMeta.length;
  const sendsBefore = resendRequests.length;
  resendBehavior = "concurrent";
  try {
    const first = await queue.dispatchDueMarketingCampaigns({ now, limit: 40, interJobDelayMs: 0 });
    assert.equal(first.failed, 1);
    assert.equal(resendRequests.length, sendsBefore);
    const queued = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
    assert.equal(queued.status, "queued");
    assert.ok(queued.resendIdempotencyDeadlineAt);
    assert.ok(queued.providerAttemptStartedAt);
    assert.ok(queued.queueScore < 0, "uncertain work must outrank every ordinary campaign globally");

    resendBehavior = "ok";
    const recovered = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
    assert.equal(recovered.submitted, 1);
    assert.equal(resendRequests.length, sendsBefore + 1);
    const attempts = resendAttemptMeta.slice(attemptsBefore).filter((item) => item.body.to?.includes(email));
    assert.equal(attempts.length, 3, "the first logical send retries once inside the transport, then the queue recovers once");
    assert.equal(new Set(attempts.map((item) => item.idempotencyKey)).size, 1);
    assert.equal(new Set(attempts.map((item) => item.payloadJson)).size, 1);
    assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
  } finally {
    resendBehavior = "ok";
  }
});

test("Resend invalid idempotency payload conflicts are quarantined without retries", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-06T13:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-invalid-idempotency";
  const email = "invalid-idempotency@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "invalid idempotency",
    html: "<p>invalid idempotency</p>",
    text: "invalid idempotency",
    preview: "invalid idempotency",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const attemptsBefore = resendAttemptMeta.length;
  resendBehavior = "conflict";
  try {
    const result = await queue.dispatchDueMarketingCampaigns({ now, limit: 40, interJobDelayMs: 0 });
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].reason, "idempotency_payload_conflict");
    assert.equal(result.results[0].permanent, true);
    assert.equal(resendAttemptMeta.length - attemptsBefore, 1, "a payload conflict must not be transport-retried");
    assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "failed");

    const deliveryLookup = currentEntry(`lm:mail:delivery:message:${enqueued.results[0].messageId}`)?.value;
    const delivery = JSON.parse(currentEntry(`lm:mail:delivery:record:${deliveryLookup}`)?.value || "null");
    assert.equal(delivery.providerOutcomeClass, "idempotency_conflict");
    assert.equal(delivery.providerErrorCode, "invalid_idempotent_request");
  } finally {
    resendBehavior = "ok";
  }
});

test("a durable quota outcome recovers correctly after the queue state write is interrupted", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-06T14:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-durable-quota-outcome";
  const email = "durable-quota-outcome@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "durable quota outcome",
    html: "<p>durable quota outcome</p>",
    text: "durable quota outcome",
    preview: "durable quota outcome",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const attemptsBefore = resendAttemptMeta.length;
  resendBehavior = "quota";
  try {
    await assert.rejects(queue.dispatchDueMarketingCampaigns({
      now,
      limit: 40,
      interJobDelayMs: 0,
      _testHooks: {
        afterRecordBeforeState({ deliveryRecord }) {
          assert.equal(deliveryRecord?.ok, true);
          throw new Error("simulated_crash_after_outcome_record");
        },
      },
    }), /simulated_crash_after_outcome_record/);
    const interrupted = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
    assert.equal(interrupted.status, "sending");
    store.delete(`lm:mail:marketing:claim:${jobId}`);

    const deliveryLookup = currentEntry(`lm:mail:delivery:message:${enqueued.results[0].messageId}`)?.value;
    const delivery = JSON.parse(currentEntry(`lm:mail:delivery:record:${deliveryLookup}`)?.value || "null");
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.providerOutcomeClass, "quota");

    resendBehavior = "ok";
    const recovered = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
    assert.equal(recovered.results[0].reason, "daily_quota_exceeded");
    assert.equal(resendAttemptMeta.length - attemptsBefore, 2, "recovery reads the durable outcome and does not call Resend again");
    const queued = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
    assert.equal(queued.status, "queued");
    assert.equal(queued.failedAttempts, 0);
    assert.equal(Object.hasOwn(queued, "providerAttemptStartedAt"), false);
    assert.equal(Object.hasOwn(queued, "resendIdempotencyDeadlineAt"), false);
    assert.ok(Date.parse(queued.nextAttemptAt) > now + 60_000);
  } finally {
    resendBehavior = "ok";
  }
});

test("an uncertain first provider response cannot be downgraded by a later quota response", async () => {
  const scenarios = [
    { label: "concurrent", first: "concurrent", scheduledAt: "2027-02-06T15:00:00.000Z" },
    { label: "server", first: "server", scheduledAt: "2027-02-07T15:00:00.000Z" },
  ];

  for (const scenario of scenarios) {
    const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
    ensureZset(queueKey).clear();
    const now = Date.parse(scenario.scheduledAt);
    const campaignId = `campaign-mixed-uncertain-${scenario.label}`;
    const email = `mixed-uncertain-${scenario.label}@example.com`;
    const enqueued = await queue.enqueueMarketingCampaign({
      campaignId,
      recipients: [email],
      scheduledAt: scenario.scheduledAt,
      subject: `mixed uncertain ${scenario.label}`,
      html: '<p><a href="https://www.liumeiti.vip/shop">open shop</a></p>',
      text: "open shop",
      preview: `mixed uncertain ${scenario.label}`,
      brandName: "test",
      support: {},
      actor: { staffId: 1, staffUsername: "admin" },
    });
    assert.equal(enqueued.ok, true);

    const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scenario.scheduledAt);
    const attemptsBefore = resendAttemptMeta.length;
    const sendsBefore = resendRequests.length;
    resendBehaviorSequence = [scenario.first, "quota"];
    try {
      await assert.rejects(queue.dispatchDueMarketingCampaigns({
        now,
        limit: 40,
        interJobDelayMs: 0,
        _testHooks: {
          afterRecordBeforeState({ result, deliveryRecord }) {
            assert.equal(result.uncertain, true);
            assert.equal(result.code, 429);
            assert.equal(deliveryRecord?.ok, true);
            throw new Error(`simulated_${scenario.label}_then_quota_crash`);
          },
        },
      }), new RegExp(`simulated_${scenario.label}_then_quota_crash`));

      const deliveryLookup = currentEntry(`lm:mail:delivery:message:${enqueued.results[0].messageId}`)?.value;
      const delivery = JSON.parse(currentEntry(`lm:mail:delivery:record:${deliveryLookup}`)?.value || "null");
      assert.equal(delivery.status, "failed");
      assert.equal(delivery.providerOutcomeClass, "uncertain");
      assert.equal(delivery.providerUncertain, true);

      const interrupted = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
      assert.equal(interrupted.status, "sending");
      assert.ok(interrupted.providerAttemptStartedAt);
      assert.ok(interrupted.resendIdempotencyDeadlineAt);
      store.delete(`lm:mail:marketing:claim:${jobId}`);
      resendBehaviorSequence = [];
      resendBehavior = "ok";

      const recovery = await queue.dispatchDueMarketingCampaigns({ now: now + 60_000, limit: 40, interJobDelayMs: 0 });
      assert.equal(recovery.results[0].reason, "idempotent_provider_retry_scheduled");
      assert.equal(resendRequests.length, sendsBefore);
      const submitted = await queue.dispatchDueMarketingCampaigns({ now: now + 120_000, limit: 40, interJobDelayMs: 0 });
      assert.equal(submitted.submitted, 1);
      assert.equal(resendRequests.length, sendsBefore + 1);

      const attempts = resendAttemptMeta.slice(attemptsBefore).filter((item) => item.body.to?.includes(email));
      assert.equal(attempts.length, 3);
      assert.equal(new Set(attempts.map((item) => item.idempotencyKey)).size, 1);
      assert.equal(new Set(attempts.map((item) => item.payloadJson)).size, 1);
    } finally {
      resendBehaviorSequence = [];
      resendBehavior = "ok";
    }
  }
});

test("an unresolved provider outcome older than Resend's safe retry window is never resent", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-07T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-expired-idempotency-recovery";
  const email = "expired-idempotency-recovery@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "expired recovery",
    html: "<p>expired recovery</p>",
    text: "expired recovery",
    preview: "expired recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const sendsBefore = resendRequests.length;
  await assert.rejects(queue.dispatchDueMarketingCampaigns({
    now,
    limit: 40,
    interJobDelayMs: 0,
    _testHooks: { afterQuotaReservation() { throw new Error("simulated_old_process_exit"); } },
  }), /simulated_old_process_exit/);
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const tooLate = await queue.dispatchDueMarketingCampaigns({
    now: now + 23 * 60 * 60 * 1000,
    limit: 40,
    interJobDelayMs: 0,
  });
  assert.equal(tooLate.failed, 1);
  assert.equal(tooLate.results[0].reason, "delivery_outcome_unknown");
  assert.equal(resendRequests.length, sendsBefore, "safety wins after provider idempotency can no longer be guaranteed");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "failed");
});

test("a crash before the durable provider-start marker stays safely recoverable after 22 hours", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-08T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-crash-before-provider-start";
  const email = "crash-before-provider-start@example.com";
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "known unsent recovery",
    html: "<p>known unsent recovery</p>",
    text: "known unsent recovery",
    preview: "known unsent recovery",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  const sendsBefore = resendRequests.length;
  await assert.rejects(queue.dispatchDueMarketingCampaigns({
    now,
    limit: 40,
    interJobDelayMs: 0,
    _testHooks: { beforeProvider() { throw new Error("simulated_crash_before_provider_marker"); } },
  }), /simulated_crash_before_provider_marker/);
  const interrupted = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
  assert.equal(interrupted.status, "sending");
  assert.equal(interrupted.providerProtocolVersion, 2);
  assert.equal(Object.hasOwn(interrupted, "providerAttemptStartedAt"), false);
  assert.equal(Object.hasOwn(interrupted, "resendIdempotencyDeadlineAt"), false);
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const recoveredAt = now + 23 * 60 * 60 * 1000;
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt, limit: 40, interJobDelayMs: 0 });
  assert.equal(recovered.results[0].reason, "provider_not_started_requeued");
  assert.equal(resendRequests.length, sendsBefore);
  const queued = JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value);
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempts, 0);

  const sent = await queue.dispatchDueMarketingCampaigns({ now: recoveredAt + 60_000, limit: 40, interJobDelayMs: 0 });
  assert.equal(sent.submitted, 1);
  assert.equal(resendRequests.length, sendsBefore + 1);
});

test("an ambiguous recovered recipient is prioritized ahead of a 100-address backlog", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2027-02-09T15:59:00.000Z";
  const now = Date.parse(scheduledAt);
  const campaignId = "campaign-recovery-priority-backlog";
  const recipients = Array.from({ length: 101 }, (_, index) => `recovery-backlog-${String(index).padStart(3, "0")}@example.com`);
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId,
    recipients,
    scheduledAt,
    subject: "recovery priority",
    html: "<p>recovery priority</p>",
    text: "recovery priority",
    preview: "recovery priority",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  let crashedJobId = "";
  await assert.rejects(queue.dispatchDueMarketingCampaigns({
    now,
    limit: 40,
    interJobDelayMs: 0,
    _testHooks: {
      afterQuotaReservation({ campaignJobId }) {
        crashedJobId = campaignJobId;
        throw new Error("simulated_backlog_process_exit");
      },
    },
  }), /simulated_backlog_process_exit/);
  const crashedJob = JSON.parse(currentEntry(`lm:mail:marketing:job:${crashedJobId}`).value);
  const crashedEmail = crashedJob.to;
  const originalScore = crashedJob.resumeQueueScore;
  const olderScheduledAt = new Date(now - 60 * 60 * 1000).toISOString();
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId: "campaign-older-cross-campaign-backlog",
    recipients: Array.from({ length: 50 }, (_, index) => `older-backlog-${String(index).padStart(2, "0")}@example.com`),
    scheduledAt: olderScheduledAt,
    subject: "older backlog",
    html: "<p>older backlog</p>",
    text: "older backlog",
    preview: "older backlog",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);
  store.delete(`lm:mail:marketing:claim:${crashedJobId}`);

  const nextDay = now + 2 * 60_000;
  const recovered = await queue.dispatchDueMarketingCampaigns({ now: nextDay, limit: 40, interJobDelayMs: 0 });
  assert.equal(recovered.results.some((item) => item.id === crashedJobId && item.reason === "idempotent_provider_retry_scheduled"), true);
  const prioritized = JSON.parse(currentEntry(`lm:mail:marketing:job:${crashedJobId}`).value);
  assert.equal(prioritized.status, "queued");
  assert.ok(prioritized.queueScore < Date.parse(olderScheduledAt), "the recovery must sort ahead of ordinary work from every campaign");
  assert.ok(originalScore > prioritized.queueScore);

  const attemptsBefore = resendRequests.length;
  const retried = await queue.dispatchDueMarketingCampaigns({ now: nextDay + 60_000, limit: 40, interJobDelayMs: 0 });
  assert.equal(retried.submitted, 10, "40 real provider attempts in the recovery sweep leave exactly 10 slots in the new Beijing day");
  assert.equal(resendRequests.slice(attemptsBefore).some((body) => (body.to || []).includes(crashedEmail)), true, "the ambiguous address must consume the first available retry slot");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${crashedJobId}`).value).status, "submitted");
  assert.equal(currentEntry(`lm:mail:marketing:daily:${queue.marketingCampaignQueueInternals.beijingDayKey(nextDay)}`)?.value, "50");
});

test("each provider attempt selects its Beijing day at the actual logical send time", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const beforeMidnight = Date.parse("2026-08-05T15:59:59.000Z");
  const afterMidnight = beforeMidnight + 2_000;
  const scheduledAt = new Date(beforeMidnight).toISOString();
  const firstDay = queue.marketingCampaignQueueInternals.beijingDayKey(beforeMidnight);
  const secondDay = queue.marketingCampaignQueueInternals.beijingDayKey(afterMidnight);
  store.delete(`lm:mail:marketing:daily:${firstDay}`);
  store.delete(`lm:mail:marketing:daily:${secondDay}`);
  assert.equal((await queue.enqueueMarketingCampaign({
    campaignId: "campaign-midnight-attempt-keys",
    recipients: ["midnight-a@example.com", "midnight-b@example.com"],
    scheduledAt,
    subject: "midnight",
    html: "<p>midnight</p>",
    text: "midnight",
    preview: "midnight",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  })).ok, true);

  const originalNow = Date.now;
  let wallNow = beforeMidnight;
  let providerOrdinal = 0;
  try {
    Date.now = () => wallNow;
    const result = await queue.dispatchDueMarketingCampaigns({
      now: beforeMidnight,
      limit: 2,
      interJobDelayMs: 0,
      _testHooks: {
        beforeProvider() {
          providerOrdinal += 1;
          if (providerOrdinal === 2) wallNow = afterMidnight;
        },
      },
    });
    assert.equal(result.submitted, 2);
  } finally {
    Date.now = originalNow;
  }
  assert.notEqual(firstDay, secondDay);
  assert.equal(currentEntry(`lm:mail:marketing:daily:${firstDay}`)?.value, "1");
  assert.equal(currentEntry(`lm:mail:marketing:daily:${secondDay}`)?.value, "1");
});

test("invalid due queue members cannot consume the provider-attempt window or starve a valid job", async () => {
  const queueKey = queue.marketingCampaignQueueInternals.QUEUE_KEY;
  ensureZset(queueKey).clear();
  const scheduledAt = "2026-10-01T10:30:00.000Z";
  const now = Date.parse(scheduledAt);
  const dayKey = queue.marketingCampaignQueueInternals.beijingDayKey(now);
  store.delete(`lm:mail:marketing:daily:${dayKey}`);
  const campaignId = "campaign-invalid-member-overscan";
  const email = "valid-after-invalid-members@example.com";
  const enqueued = await queue.enqueueMarketingCampaign({
    campaignId,
    recipients: [email],
    scheduledAt,
    subject: "queue overscan",
    html: "<p>queue overscan</p>",
    text: "queue overscan",
    preview: "queue overscan",
    brandName: "test",
    support: {},
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(enqueued.ok, true);
  const invalidMembers = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(81)}`);
  invalidMembers.forEach((member, index) => ensureZset(queueKey).set(member, now - 1_000 + index));
  const beforeRequests = resendRequests.length;
  const result = await queue.dispatchDueMarketingCampaigns({ now, limit: 1, interJobDelayMs: 0 });
  assert.equal(result.submitted, 1);
  assert.equal(resendRequests.length, beforeRequests + 1);
  assert.equal(invalidMembers.some((member) => ensureZset(queueKey).has(member)), false);
  const jobId = queue.marketingCampaignQueueInternals.makeJobId(campaignId, email, scheduledAt);
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
});
