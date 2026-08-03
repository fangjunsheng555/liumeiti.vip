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
const resendFailureRecipients = new Set();
let resendBehavior = "ok"; // "ok" | "fail"(400 硬失败) | "quota"(429 配额)
let resendDelayMs = 0;
let redisDelayMs = 0;
let failNextJobWrite = false;
let failNextTerminalTransition = false;
let failNextDispatchLockWrite = false;
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
    if (script.includes("doc.requestHash") && script.includes("return -1")) {
      const existing = currentEntry(keys[0])?.value;
      if (existing) {
        const doc = JSON.parse(existing);
        if (String(doc.requestHash || "") !== String(argv[0] || "")) return -1;
        if (!ensureZset(keys[1]).has(String(argv[2]))) ensureZset(keys[1]).set(String(argv[2]), Number(argv[1]));
        return 0;
      }
      store.set(keys[0], { type: "string", value: String(argv[4]) });
      if (!ensureZset(keys[1]).has(String(argv[2]))) ensureZset(keys[1]).set(String(argv[2]), Number(argv[1]));
      return 1;
    }
    if (script.includes("__in_flight__") && script.includes("SMEMBERS")) {
      const raw = currentEntry(keys[0])?.value;
      if (!raw) return "__missing__";
      const doc = JSON.parse(raw);
      if (String(doc.status || "") === String(argv[0] || "")) return JSON.stringify(doc);
      if (!String(argv[1] || "").split("|").includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
      for (const jobId of ensureSet(keys[2])) {
        const jobRaw = currentEntry(String(argv[6]) + jobId)?.value;
        const job = jobRaw ? JSON.parse(jobRaw) : null;
        if (job?.status === "sending" && currentEntry(String(argv[7]) + jobId)) return "__in_flight__";
      }
      Object.assign(doc, JSON.parse(String(argv[2] || "{}")), { status: String(argv[0]) });
      store.set(keys[0], { type: "string", value: JSON.stringify(doc) });
      if (!ensureZset(keys[1]).has(String(argv[5]))) ensureZset(keys[1]).set(String(argv[5]), Number(argv[4]));
      return JSON.stringify(doc);
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
    if (script.includes("__invalid__:") && script.includes("patchOk") && !script.includes("__in_flight__")) {
      const raw = currentEntry(keys[0])?.value;
      if (!raw) return "__missing__";
      const doc = JSON.parse(raw);
      if (!String(argv[1] || "").split("|").includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
      Object.assign(doc, JSON.parse(String(argv[2] || "{}")), { status: String(argv[0]) });
      store.set(keys[0], { type: "string", value: JSON.stringify(doc) });
      if (!ensureZset(keys[1]).has(String(argv[5]))) ensureZset(keys[1]).set(String(argv[5]), Number(argv[4]));
      return JSON.stringify(doc);
    }
    if (script.includes("local queueScore=tonumber(doc.queueScore or ARGV[1])")) {
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
      return 1;
    }
    if (script.includes("campaignStatus=campaign and campaign.status")) {
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
        ensureSet(keys[2]).add(String(argv[7]));
      }
      if (argv[10] === "1") {
        store.set(keys[7], { type: "string", value: String(Number(currentEntry(keys[7])?.value || 0) + 1) });
      }
      if (campaign) {
        if (argv[8] === "sending" && campaign.status === "scheduled") {
          campaign.status = "sending";
          campaign.startedAt ||= argv[9];
        }
        if (argv[4] === "terminal") {
          const field = `${argv[8]}Count`;
          campaign[field] = Number(campaign[field] || 0) + 1;
          campaign.terminalCount = Number(campaign.terminalCount || 0) + 1;
          if (ensureSet(keys[2]).size === 0 && campaign.enqueueCompletedAt && campaign.status !== "cancelled") {
            if (Number(campaign.failedCount || 0) > 0 || Number(campaign.enqueueFailedCount || 0) > 0) {
              campaign.status = "failed";
              campaign.failedAt = argv[9];
            } else {
              campaign.status = "completed";
              campaign.completedAt = argv[9];
            }
          }
        }
        campaign.updatedAt = argv[9];
        store.set(keys[5], { type: "string", value: JSON.stringify(campaign) });
        if (!ensureZset(keys[6]).has(String(argv[6]))) ensureZset(keys[6]).set(String(argv[6]), Number(argv[12]));
      }
      return JSON.stringify({ ok: true, status: argv[8], campaignStatus: campaign?.status || "" });
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
  if (name === "ZREVRANGE") return [];
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
    const body = JSON.parse(options.body || "{}");
    if ((Array.isArray(body.to) ? body.to : [body.to]).some((email) => resendFailureRecipients.has(String(email)))) {
      return Response.json({ message: "invalid_recipient" }, { status: 400 });
    }
    if (resendBehavior === "fail") return Response.json({ message: "invalid_recipient" }, { status: 400 });
    if (resendBehavior === "quota") return Response.json({ message: "daily_quota_exceeded" }, { status: 429 });
    resendRequests.push(body);
    return Response.json({ id: `resend-${resendRequests.length}` }, { status: 200 });
  }
  return originalFetch(input, options);
};

const queue = await import("../app/api/_marketing-campaign-queue.js");
const marketingCronRoute = await import("../app/api/cron/marketing-campaign/route.js");

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
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "sending");
  store.delete(`lm:mail:marketing:claim:${jobId}`);

  const recovered = await queue.dispatchDueMarketingCampaigns({ now: Date.parse(scheduledAt) + 60_000, interJobDelayMs: 0 });
  assert.equal(recovered.submitted, 1);
  assert.equal(recovered.results[0].recovered, true);
  assert.equal(resendRequests.length, sendsBefore + 1, "recovery must only commit the durable delivery record");
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "submitted");
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
  assert.equal(JSON.parse(currentEntry(`lm:mail:marketing:job:${jobId}`).value).status, "queued");
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
