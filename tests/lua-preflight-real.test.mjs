import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "https://redis.lua-preflight.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.VERCEL_ENV = "production";
process.env.PUSH_ENABLED = "true";
process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = "lua-preflight-push-encryption-secret-32-chars";
process.env.PUSH_ACCOUNT_HMAC_SECRET = "lua-preflight-push-account-secret-32-chars";
const testVapid = createECDH("prime256v1");
testVapid.setPrivateKey(Buffer.alloc(32, 17));
process.env.WEB_PUSH_VAPID_PUBLIC_KEY = testVapid.getPublicKey().toString("base64url");
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = testVapid.getPrivateKey().toString("base64url");
process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:lua-preflight@example.com";

const health = await import("../app/api/_health.js");
const marketing = await import("../app/api/_marketing-campaign-queue.js");
const incidents = await import("../app/api/_incidents.js");
const durable = await import("../app/api/_durable-operation.js");
const observability = await import("../app/api/_observability.js");
const afterSales = await import("../app/api/after-sales/_store.js");
const push = await import("../app/api/_push.js");
const utils = await import("../app/api/_utils.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function realRedis(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("Lua TYPE preflights leave every earlier key untouched on WRONGTYPE", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-lua-preflight-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    for (const [suffix, seed] of [["float", ["SET", "", "12.5"]], ["empty", ["SET", "", ""]], ["negative", ["SET", "", "-1"]], ["wrongtype", ["RPUSH", "", "1"]]]) {
      redis.run(["FLUSHDB"]);
      const request = new Request("https://www.liumeiti.vip/api/auth/login", { headers: { "x-forwarded-for": `203.0.113.${suffix.length}` } });
      const options = { namespace: `repair:${suffix}`, identity: `${suffix}@example.com`, identityLimit: 5, ipLimit: 5, windowSec: 600 };
      assert.equal((await utils.checkCriticalRateLimit(request, options)).ok, true);
      const keys = redis.run(["KEYS", `liumeiti:rate:repair:${suffix}:*`]);
      redis.run(["DEL", ...keys]);
      redis.run([seed[0], keys[0], ...seed.slice(2)]);
      const repaired = await utils.checkCriticalRateLimit(request, options);
      assert.equal(repaired.ok, true, suffix);
      assert.equal(redis.run(["GET", keys[0]]), "1", suffix);
      assert.ok(Number(redis.run(["TTL", keys[0]])) > 0, suffix);
    }
    redis.run(["FLUSHDB"]);
    const noTtlRequest = new Request("https://www.liumeiti.vip/api/auth/login", { headers: { "x-forwarded-for": "203.0.113.99" } });
    const noTtlOptions = { namespace: "repair:nottl", identity: "nottl@example.com", identityLimit: 2, ipLimit: 10, windowSec: 600 };
    assert.equal((await utils.checkCriticalRateLimit(noTtlRequest, noTtlOptions)).ok, true);
    const noTtlKeys = redis.run(["KEYS", "liumeiti:rate:repair:nottl:*"]);
    redis.run(["SET", noTtlKeys[0], "99"]);
    const preservedLimit = await utils.checkCriticalRateLimit(noTtlRequest, noTtlOptions);
    assert.equal(preservedLimit.ok, false);
    assert.equal(preservedLimit.unavailable, undefined);
    assert.equal(redis.run(["GET", noTtlKeys[0]]), "100");
    assert.ok(Number(redis.run(["TTL", noTtlKeys[0]])) > 0);

    const healthStatus = "lm:health:redis";
    const healthHistory = "lm:health:history:v1:redis";
    redis.run(["SET", healthHistory, "wrong-type"]);
    assert.equal(await health.recordHealthStatus("redis", { status: "ok", summary: "probe" }), null);
    assert.equal(redis.run(["EXISTS", healthStatus]), 0);
    assert.equal(redis.run(["GET", healthHistory]), "wrong-type");

    const campaignId = "WRONGTYPE-CAMPAIGN";
    redis.run(["SET", "lm:mail:marketing:campaign:index", "wrong-type"]);
    const campaign = await marketing.enqueueMarketingCampaign({
      campaignId,
      recipients: ["buyer@example.com"],
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      subject: "preflight",
      html: "<p>test</p>",
    });
    assert.equal(campaign.ok, false);
    assert.equal(redis.run(["EXISTS", `lm:mail:marketing:campaign:${campaignId}`]), 0);
    assert.equal(redis.run(["GET", "lm:mail:marketing:campaign:index"]), "wrong-type");

    const fingerprint = "wrongtype-incident";
    const fingerprintHash = incidents.incidentInternals.fingerprintHash(fingerprint);
    redis.run(["SET", incidents.incidentInternals.INCIDENT_INDEX_KEY, "wrong-type"]);
    const incident = await incidents.openOrUpdateIncident({ fingerprint, summary: "preflight", severity: "warning" });
    assert.equal(incident.ok, false);
    const mappedKey = incidents.incidentInternals.INCIDENT_FINGERPRINT_PREFIX + fingerprintHash;
    assert.equal(redis.run(["EXISTS", mappedKey]), 0);
    assert.equal(redis.run(["GET", incidents.incidentInternals.INCIDENT_INDEX_KEY]), "wrong-type");
    assert.equal(redis.run(["KEYS", `${incidents.incidentInternals.INCIDENT_RECORD_PREFIX}*`]).length, 0);

    redis.run(["FLUSHDB"]);
    redis.run(["SET", durable.durableOperationInternals.OPERATION_STARTED_INDEX, "wrong-type"]);
    const rejectedClaim = await durable.claimDurableOperation({
      scope: "lua-preflight",
      principal: "legacy@example.com",
      idempotencyKey: "wrongtype-claim-001",
      requestHash: "a".repeat(64),
    });
    assert.equal(rejectedClaim.ok, false);
    assert.equal(rejectedClaim.error, "storage_type_error");
    assert.equal(redis.run(["EXISTS", rejectedClaim.storageKey]), 0);
    assert.equal(redis.run(["GET", durable.durableOperationInternals.OPERATION_STARTED_INDEX]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const startedClaim = await durable.claimDurableOperation({
      scope: "lua-preflight",
      principal: "legacy@example.com",
      idempotencyKey: "wrongtype-complete-001",
      requestHash: "b".repeat(64),
    });
    assert.equal(startedClaim.ok, true);
    const rawStarted = redis.run(["GET", startedClaim.storageKey]);
    redis.run(["DEL", durable.durableOperationInternals.OPERATION_STARTED_INDEX]);
    redis.run(["SET", durable.durableOperationInternals.OPERATION_STARTED_INDEX, "wrong-type"]);
    const rejectedComplete = await durable.completeDurableOperation(startedClaim, { ok: true });
    assert.equal(rejectedComplete.ok, false);
    assert.equal(rejectedComplete.error, "storage_type_error");
    assert.equal(redis.run(["GET", startedClaim.storageKey]), rawStarted);
    assert.equal(redis.run(["GET", durable.durableOperationInternals.OPERATION_STARTED_INDEX]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const traceOrderId = "TRACE-WRONGTYPE-1";
    const traceListKey = `lm:trace:order:v1:${traceOrderId}`;
    const traceDedupeKey = `lm:trace:dedupe:v1:${traceOrderId}`;
    redis.run(["SET", traceListKey, "wrong-type"]);
    const trace = await observability.appendBusinessTraceEvent(traceOrderId, {
      stage: "preflight",
      operationId: "trace-wrongtype-001",
      outcome: "ok",
    });
    assert.equal(trace, null);
    assert.equal(redis.run(["HLEN", traceDedupeKey]), 0);
    assert.equal(redis.run(["GET", traceListKey]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const ticketId = "AS-WRONGTYPE-1";
    redis.run(["SET", "liumeiti:after-sales:index", "wrong-type"]);
    const ticket = await afterSales.createAfterSalesTicket({
      ticketId,
      orderId: "ORDER-WRONGTYPE-1",
      status: "pending",
      createdAt: new Date().toISOString(),
      items: [],
    });
    assert.equal(ticket.ok, false);
    assert.equal(redis.run(["EXISTS", `liumeiti:after-sales:record:${ticketId}`]), 0);
    assert.equal(redis.run(["GET", "liumeiti:after-sales:index"]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const effectTicketId = "AS-WRONGTYPE-EFFECT-1";
    const effectTicketKey = `liumeiti:after-sales:record:${effectTicketId}`;
    const effectRaw = JSON.stringify({
      ticketId: effectTicketId,
      orderId: "ORDER-WRONGTYPE-2",
      status: "pending",
      creationEffectsPending: true,
      legacyRows: [],
    });
    redis.run(["SET", effectTicketKey, effectRaw]);
    redis.run(["SET", "liumeiti:after-sales:creation-outbox", "wrong-type"]);
    assert.equal(await afterSales.markAfterSalesCreationEffectsDone(effectTicketId), false);
    assert.equal(redis.run(["GET", effectTicketKey]), effectRaw);
    assert.equal(redis.run(["GET", "liumeiti:after-sales:creation-outbox"]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const rateRequest = new Request("https://www.liumeiti.vip/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.44" },
    });
    const firstRate = await utils.checkCriticalRateLimit(rateRequest, {
      namespace: "lua-preflight",
      identity: "legacy@example.com",
      identityLimit: 5,
      ipLimit: 10,
      windowSec: 600,
    });
    assert.equal(firstRate.ok, true);
    const rateKeys = redis.run(["KEYS", "liumeiti:rate:lua-preflight:*"]).sort();
    assert.equal(rateKeys.length, 2);
    const preservedRate = redis.run(["GET", rateKeys[0]]);
    redis.run(["SET", rateKeys[1], "abc"]);
    const repairedRate = await utils.checkCriticalRateLimit(rateRequest, {
      namespace: "lua-preflight",
      identity: "legacy@example.com",
      identityLimit: 5,
      ipLimit: 10,
      windowSec: 600,
    });
    assert.equal(repairedRate.ok, true);
    assert.equal(repairedRate.unavailable, undefined);
    assert.equal(redis.run(["GET", rateKeys[0]]), String(Number(preservedRate) + 1));
    assert.equal(redis.run(["GET", rateKeys[1]]), "1");
    assert.ok(Number(redis.run(["TTL", rateKeys[1]])) > 0);

    redis.run(["FLUSHDB"]);
    const stockKey = "liumeiti:stock:spotify:member";
    redis.run(["SET", stockKey, "0"]);
    redis.run(["SET", push.pushInternals.OUTBOX_KEY, "wrong-type"]);
    const restock = await push.setStockAndMaybeEnqueueRestock(
      "spotify",
      "member",
      5,
      "lua-preflight-restock-001",
      { serviceLabelZh: "Spotify", planLabelZh: "家庭成员" },
    );
    assert.equal(restock.ok, false);
    assert.equal(redis.run(["GET", stockKey]), "0");
    assert.equal(redis.run(["HLEN", push.pushInternals.EVENTS_HASH]), 0);
    assert.equal(redis.run(["GET", push.pushInternals.OUTBOX_KEY]), "wrong-type");

    redis.run(["FLUSHDB"]);
    const metricCampaignId = "METRIC-OVERFLOW-PREFLIGHT";
    const metricStatsKey = `lm:mail:marketing:campaign:stats:${metricCampaignId}`;
    const metricEventId = "metric-overflow-event";
    const metricFingerprint = createHash("sha256")
      .update(`${metricCampaignId}\u0000queued\u0000${metricEventId}`)
      .digest("hex");
    const metricMarkerKey = `lm:mail:marketing:campaign:metric-event:${metricFingerprint}`;
    redis.run(["HSET", metricStatsKey, "queued", String(Number.MAX_SAFE_INTEGER)]);
    const rejectedMetric = await marketing.recordMarketingCampaignMetric(
      metricCampaignId,
      "queued",
      metricEventId,
      1,
    );
    assert.deepEqual(rejectedMetric, { ok: false, error: "invalid_metric" });
    assert.equal(redis.run(["HGET", metricStatsKey, "queued"]), String(Number.MAX_SAFE_INTEGER));
    assert.equal(redis.run(["EXISTS", metricMarkerKey]), 0);

    redis.run(["FLUSHDB"]);
    const browserKey = createECDH("prime256v1");
    browserKey.generateKeys();
    const pushAuth = {
      email: "real-push-cas@example.com",
      authVersion: 7,
      accountLifecycleId: "0123456789abcdef0123456789abcdef",
    };
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/real-push-cas",
      expirationTime: null,
      keys: {
        p256dh: browserKey.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 23).toString("base64url"),
      },
    };
    const concurrentBinds = await Promise.all(Array.from({ length: 20 }, () => (
      push.bindPushSubscription(pushAuth, subscription, { locale: "zh" })
    )));
    assert.equal(concurrentBinds.every((result) => result.ok), true);
    const pushState = await push.getPushAccountState(pushAuth);
    assert.equal(pushState.ok, true);
    assert.equal(pushState.subscriptionIds.length, 1);
    redis.run(["SET", "liumeiti:stock:spotify:family", "0"]);
    assert.equal((await push.addStockWatch(pushAuth, "spotify", "family")).watching, true);
    assert.equal((await push.removeStockWatch(pushAuth, "spotify", "family")).ok, true);
    const disabled = await push.removePushSubscription(pushAuth, { allDevices: true });
    assert.deepEqual(disabled, { ok: true, removed: 1 });
    assert.equal((await push.getPushAccountState(pushAuth)).subscriptionIds.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
