import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "https://redis.convergence-round1.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.VERCEL_ENV = "production";
process.env.PUSH_ENABLED = "true";
process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = "round1-push-encryption-secret-32-characters";
process.env.PUSH_ACCOUNT_HMAC_SECRET = "round1-push-account-secret-32-characters";
const vapid = createECDH("prime256v1");
vapid.setPrivateKey(Buffer.alloc(32, 29));
process.env.WEB_PUSH_VAPID_PUBLIC_KEY = vapid.getPublicKey().toString("base64url");
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = vapid.getPrivateKey().toString("base64url");
process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:round1@example.com";

const health = await import("../app/api/_health.js");
const marketing = await import("../app/api/_marketing-campaign-queue.js");
const push = await import("../app/api/_push.js");
const afterSales = await import("../app/api/after-sales/_store.js");
const durable = await import("../app/api/_durable-operation.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function redisAdapter(container) {
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
      // Upstash-style URL command adapters discard empty path segments. These
      // probes intentionally exercise the same behavior that exposed shifted
      // Lua ARGV values in production instead of a friendlier test transport.
      const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

function pushFixture(suffix) {
  const browserKey = createECDH("prime256v1");
  browserKey.generateKeys();
  return {
    auth: {
      email: `round1-${suffix}@example.com`,
      authVersion: 1,
      accountLifecycleId: "0123456789abcdef0123456789abcdef",
    },
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/round1-${suffix}`,
      expirationTime: null,
      keys: {
        p256dh: browserKey.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 31).toString("base64url"),
      },
    },
  };
}

test("convergence round one: five public chains survive production URL argument filtering", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async (t) => {
  const container = `lm-convergence-r1-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = redisAdapter(container);
    globalThis.fetch = redis.fetch;

    await t.test("Push refuses to overwrite an existing literal missing-value sentinel", async () => {
      redis.run(["FLUSHDB"]);
      const fixture = pushFixture("literal-sentinel");
      const target = push.pushAccountTarget(fixture.auth.email, fixture.auth.accountLifecycleId);
      redis.run(["HSET", push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH, target, "__lm_push_missing__"]);

      const result = await push.bindPushSubscription(fixture.auth, fixture.subscription, { locale: "zh" });

      assert.deepEqual(result, { ok: false, error: "storage_unavailable" });
      assert.equal(
        redis.run(["HGET", push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH, target]),
        "__lm_push_missing__",
      );
      assert.equal(redis.run(["HLEN", push.pushInternals.SUBSCRIPTIONS_HASH]), 0);
      assert.equal(redis.run(["HLEN", push.pushInternals.PREFERENCES_HASH]), 0);
    });

    await t.test("Health heals a legacy sentinel record while preserving explicit empty fields", async () => {
      redis.run(["FLUSHDB"]);
      const statusKey = `${health.healthKeys.HEALTH_PREFIX}catalog`;
      const historyKey = `${health.healthKeys.HEALTH_HISTORY_PREFIX}catalog`;
      redis.run(["SET", statusKey, "__lm_health_missing__"]);

      const saved = await health.recordHealthStatus("catalog", {
        status: "warning",
        summary: "",
        error: null,
        metrics: {},
      });

      assert.equal(saved?.component, "catalog");
      assert.equal(saved?.status, "warning");
      assert.equal(saved?.summary, "");
      assert.equal(saved?.error, "");
      const raw = redis.run(["GET", statusKey]);
      assert.notEqual(raw, "__lm_health_missing__");
      assert.equal(JSON.parse(raw).summary, "");
      assert.equal(JSON.parse(raw).error, "");
      assert.deepEqual(redis.run(["LRANGE", historyKey, "0", "-1"]), [raw]);
    });

    await t.test("After-sales completion with a truly absent operationId does not shift Lua arguments", async () => {
      redis.run(["FLUSHDB"]);
      const ticketId = "AS-R1-NO-OPERATION";
      const orderId = "ORDER-R1-NO-OPERATION";
      const created = await afterSales.createAfterSalesTicket({
        ticketId,
        orderId,
        status: "pending",
        createdAt: "2026-08-04T01:02:03.000Z",
        items: [],
      });
      assert.equal(created.ok, true);

      const completed = await afterSales.completeAfterSalesTicket(
        ticketId,
        { items: [], staffNote: "no operation id" },
        { staffId: 1, staffUsername: "admin" },
      );

      assert.equal(completed.ok, true);
      assert.equal(completed.changed, true);
      assert.equal(completed.owned, false);
      const stored = JSON.parse(redis.run(["GET", `liumeiti:after-sales:record:${ticketId}`]));
      assert.equal(stored.status, "completed");
      assert.equal(Object.hasOwn(stored, "completionOperationId"), false);
      assert.equal(Object.hasOwn(stored, "completionEffectsPending"), false);
      assert.equal(redis.run(["ZSCORE", "liumeiti:after-sales:completion-outbox", ticketId]), null);
      assert.equal(redis.run(["GET", `liumeiti:after-sales:active:${orderId}`]), null);
    });

    await t.test("Marketing terminal transition uses its default daily key and preserves legacy campaign tokens", async () => {
      redis.run(["FLUSHDB"]);
      const now = Date.parse("2026-08-04T04:00:00.000Z");
      const scheduledAt = new Date(now - 60_000).toISOString();
      const campaignId = "ROUND1-LEGACY-CANCELLED";
      const recipient = "round1-marketing@example.com";
      const jobId = marketing.marketingCampaignQueueInternals.makeJobId(campaignId, recipient, scheduledAt);
      const campaignKey = `lm:mail:marketing:campaign:${campaignId}`;
      const jobKey = `lm:mail:marketing:job:${jobId}`;
      const campaignRaw = `{"id":"${campaignId}","status":"cancelled","createdAtMs":1,"legacyEmpty":[],"legacyNull":null,"legacyObject":{},"legacyZero":0,"legacyHuge":900719925474099312345}`;
      const jobRaw = JSON.stringify({
        id: jobId,
        campaignId,
        to: recipient,
        scheduledAt,
        status: "queued",
        attempts: 0,
        queueScore: now - 60_000,
        deliveryMessageId: `marketing-queue-${jobId}`,
      });
      redis.run(["SET", campaignKey, campaignRaw]);
      redis.run(["SET", jobKey, jobRaw]);
      redis.run(["ZADD", marketing.marketingCampaignQueueInternals.QUEUE_KEY, String(now - 60_000), jobId]);
      redis.run(["SADD", `lm:mail:marketing:pending:${campaignId}`, jobId]);

      const dispatched = await marketing.dispatchDueMarketingCampaigns({
        now,
        limit: 1,
        interJobDelayMs: 0,
      });

      assert.equal(dispatched.ok, true);
      assert.equal(dispatched.results.length, 1);
      assert.equal(dispatched.results[0].reason, "campaign_cancelled");
      const storedCampaignRaw = redis.run(["GET", campaignKey]);
      assert.match(storedCampaignRaw, /"legacyEmpty":\[\]/);
      assert.match(storedCampaignRaw, /"legacyNull":null/);
      assert.match(storedCampaignRaw, /"legacyObject":\{\}/);
      assert.match(storedCampaignRaw, /"legacyZero":0/);
      assert.match(storedCampaignRaw, /"legacyHuge":900719925474099312345/);
      assert.equal(JSON.parse(redis.run(["GET", jobKey])).status, "cancelled");
      assert.equal(redis.run(["EXISTS", "lm:mail:marketing:daily:noop"]), 0);
      assert.equal(
        redis.run(["EXISTS", `lm:mail:marketing:daily:${marketing.marketingCampaignQueueInternals.beijingDayKey(now)}`]),
        0,
      );
    });

    await t.test("repair convergence round one: five legacy campaign shapes stop before send-only validation", async (lifecycle) => {
      const now = Date.parse("2026-08-04T05:00:00.000Z");
      const scheduledAt = new Date(now - 60_000).toISOString();
      const cases = [
        { name: "paused with null and empty legacy fields", status: "paused", reason: "campaign_paused", jobStatus: "queued", rawTail: ',"legacyNull":null,"legacyEmpty":[]' },
        { name: "completed without subject or html", status: "completed", reason: "campaign_completed", jobStatus: "failed", rawTail: ',"legacyHuge":900719925474099312345' },
        { name: "draft with zero and object legacy fields", status: "draft", reason: "campaign_draft", jobStatus: "failed", rawTail: ',"legacyZero":0,"legacyObject":{}' },
        { name: "scheduled with a null subject", status: "scheduled", reason: "invalid_campaign_record", jobStatus: "queued", rawTail: ',"subject":null,"html":"<p>body</p>"' },
        { name: "cancelled body stored under another campaign key", status: "cancelled", reason: "invalid_campaign_record", jobStatus: "queued", mismatchedBody: true, rawTail: ',"legacyEmptyString":""' },
      ];
      for (const [index, shape] of cases.entries()) {
        await lifecycle.test(shape.name, async () => {
          redis.run(["FLUSHDB"]);
          const campaignId = `ROUND1-REPAIR-${index}`;
          const bodyId = shape.mismatchedBody ? `${campaignId}-OTHER` : campaignId;
          const recipient = `round1-repair-${index}@example.com`;
          const jobId = marketing.marketingCampaignQueueInternals.makeJobId(campaignId, recipient, scheduledAt);
          const campaignKey = `lm:mail:marketing:campaign:${campaignId}`;
          const jobKey = `lm:mail:marketing:job:${jobId}`;
          const campaignRaw = `{"id":"${bodyId}","status":"${shape.status}","createdAtMs":1${shape.rawTail}}`;
          const jobRaw = JSON.stringify({
            id: jobId,
            campaignId,
            to: recipient,
            scheduledAt,
            status: "queued",
            attempts: 0,
            queueScore: now - 60_000,
            deliveryMessageId: `marketing-queue-${jobId}`,
          });
          redis.run(["SET", campaignKey, campaignRaw]);
          redis.run(["SET", jobKey, jobRaw]);
          redis.run(["ZADD", marketing.marketingCampaignQueueInternals.QUEUE_KEY, String(now - 60_000), jobId]);

          const dispatched = await marketing.dispatchDueMarketingCampaigns({ now, limit: 1, interJobDelayMs: 0 });

          assert.equal(dispatched.results[0]?.reason, shape.reason);
          assert.equal(JSON.parse(redis.run(["GET", jobKey])).status, shape.jobStatus);
          const storedCampaignRaw = redis.run(["GET", campaignKey]);
          if (shape.reason === "invalid_campaign_record") {
            assert.equal(storedCampaignRaw, campaignRaw);
          } else {
            assert.ok(storedCampaignRaw.startsWith(campaignRaw.slice(0, -1)), "legacy tokens must remain byte-identical before lifecycle fields");
            assert.equal(JSON.parse(storedCampaignRaw).status, shape.status);
          }
          if (shape.status === "paused") {
            assert.equal(Number(redis.run(["ZSCORE", marketing.marketingCampaignQueueInternals.QUEUE_KEY, jobId])), now + 15 * 60 * 1000);
          }
        });
      }
    });

    await t.test("Legacy after-sales record keeps empty, null and huge-number tokens through its public effects API", async () => {
      redis.run(["FLUSHDB"]);
      const ticketId = "AS-R1-LEGACY-TOKENS";
      const key = `liumeiti:after-sales:record:${ticketId}`;
      const raw = `{"ticketId":"${ticketId}","orderId":"ORDER-R1-LEGACY","status":"pending","creationEffectsPending":true,"legacyEmptyString":"","legacyEmpty":[],"legacyNull":null,"legacyZero":0,"legacyObject":{},"legacyHuge":900719925474099312345}`;
      redis.run(["SET", key, raw]);
      redis.run(["ZADD", "liumeiti:after-sales:creation-outbox", "1", ticketId]);

      assert.equal(await afterSales.markAfterSalesCreationEffectsDone(ticketId), true);

      const storedRaw = redis.run(["GET", key]);
      assert.match(storedRaw, /"legacyEmptyString":""/);
      assert.match(storedRaw, /"legacyEmpty":\[\]/);
      assert.match(storedRaw, /"legacyNull":null/);
      assert.match(storedRaw, /"legacyZero":0/);
      assert.match(storedRaw, /"legacyObject":\{\}/);
      assert.match(storedRaw, /"legacyHuge":900719925474099312345/);
      assert.equal(JSON.parse(storedRaw).creationEffectsPending, false);
      assert.equal(redis.run(["ZSCORE", "liumeiti:after-sales:creation-outbox", ticketId]), null);
    });

    await t.test("A1 Push performs a first bind through the production-filtered URL transport", async () => {
      redis.run(["FLUSHDB"]);
      const fixture = pushFixture("first-bind");

      const bound = await push.bindPushSubscription(fixture.auth, fixture.subscription, { locale: "zh" });

      assert.equal(bound.ok, true);
      assert.equal(bound.created, true);
      const state = await push.getPushAccountState(fixture.auth);
      assert.equal(state.ok, true);
      assert.deepEqual(state.subscriptionIds, [bound.subscriptionId]);
      assert.deepEqual(state.validSubscriptionIds, [bound.subscriptionId]);
    });

    await t.test("A2 Push adds and removes the first stock watch from missing hash fields", async () => {
      redis.run(["FLUSHDB"]);
      const fixture = pushFixture("first-stock-watch");
      const bound = await push.bindPushSubscription(fixture.auth, fixture.subscription, { locale: "zh" });
      assert.equal(bound.ok, true);
      redis.run(["SET", "liumeiti:stock:spotify:hobby", "0"]);

      const added = await push.addStockWatch(fixture.auth, "spotify", "hobby");
      assert.deepEqual(added, {
        ok: true,
        available: false,
        watching: true,
        productKey: "spotify:hobby",
      });
      const removed = await push.removeStockWatch(fixture.auth, "spotify", "hobby");
      assert.deepEqual(removed, { ok: true, watching: false, productKey: "spotify:hobby" });
      const target = push.pushAccountTarget(fixture.auth.email, fixture.auth.accountLifecycleId);
      assert.equal(redis.run(["HGET", push.pushInternals.STOCK_WATCHES_HASH, "spotify:hobby"]), null);
      assert.equal(redis.run(["HGET", push.pushInternals.ACCOUNT_WATCHES_HASH, target]), null);
    });

    await t.test("A3 Health writes explicit empty fields when both status and history keys are absent", async () => {
      redis.run(["FLUSHDB"]);
      const statusKey = `${health.healthKeys.HEALTH_PREFIX}api`;
      const historyKey = `${health.healthKeys.HEALTH_HISTORY_PREFIX}api`;
      assert.equal(redis.run(["EXISTS", statusKey]), 0);
      assert.equal(redis.run(["EXISTS", historyKey]), 0);

      const saved = await health.recordHealthStatus("api", {
        status: "ok",
        summary: null,
        error: "",
        metrics: {},
      });

      assert.equal(saved?.component, "api");
      assert.equal(saved?.summary, "");
      assert.equal(saved?.error, "");
      const storedRaw = redis.run(["GET", statusKey]);
      assert.equal(JSON.parse(storedRaw).summary, "");
      assert.equal(JSON.parse(storedRaw).error, "");
      assert.deepEqual(redis.run(["LRANGE", historyKey, "0", "-1"]), [storedRaw]);
    });

    await t.test("A4 Marketing pauses and resumes a scheduled campaign through public state transitions", async () => {
      redis.run(["FLUSHDB"]);
      const campaignId = "ROUND1-A-PAUSE-RESUME";
      const campaignKey = `lm:mail:marketing:campaign:${campaignId}`;
      redis.run(["SET", campaignKey, JSON.stringify({
        id: campaignId,
        status: "scheduled",
        createdAtMs: 1,
        updatedAt: "2026-08-04T00:00:00.000Z",
      })]);

      const paused = await marketing.updateMarketingCampaignStatus(campaignId, "paused", {
        staffId: 7,
        staffUsername: "round-a",
      });
      assert.equal(paused.ok, true);
      assert.equal(paused.campaign.status, "paused");
      assert.equal(paused.campaign.updatedBy.staffId, 7);
      const resumed = await marketing.updateMarketingCampaignStatus(campaignId, "scheduled", {
        staffId: 7,
        staffUsername: "round-a",
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.campaign.status, "scheduled");
      assert.equal(JSON.parse(redis.run(["GET", campaignKey])).status, "scheduled");
      assert.notEqual(redis.run(["ZSCORE", "lm:mail:marketing:campaign:index", campaignId]), null);
    });

    await t.test("A5 Durable plan and result retain empty, null, fractional and long values", async () => {
      redis.run(["FLUSHDB"]);
      const claimed = await durable.claimDurableOperation({
        scope: "convergence-round-a",
        principal: "legacy@example.com",
        idempotencyKey: "round-a-plan-result-001",
        requestHash: "a".repeat(64),
      });
      assert.equal(claimed.ok, true);
      const hugeDigits = "1234567890123456789012345678901234567890";
      const plan = { recipients: [], optional: null, ratio: 12.5, zero: 0, hugeDigits };
      const planned = await durable.ensureDurableOperationPlan(claimed, plan);
      assert.equal(planned.ok, true);
      assert.deepEqual(planned.plan, plan);
      const result = { ok: true, rows: [], optional: null, ratio: -0.5, zero: 0, hugeDigits };
      const completed = await durable.completeDurableOperation(claimed, result);
      assert.equal(completed.ok, true);
      assert.deepEqual(completed.result, result);
      const storedRaw = redis.run(["GET", claimed.storageKey]);
      assert.match(storedRaw, /"recipients":\[\]/);
      assert.match(storedRaw, /"optional":null/);
      assert.match(storedRaw, /"ratio":12\.5/);
      assert.match(storedRaw, new RegExp(`"hugeDigits":"${hugeDigits}"`));
      assert.equal(JSON.parse(storedRaw).state, "done");
    });
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
