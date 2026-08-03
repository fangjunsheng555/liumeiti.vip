import assert from "node:assert/strict";
import test from "node:test";
import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "marketing-campaign-routes-secret-32-characters";
process.env.MAIL_PREFERENCES_SECRET = process.env.AUTH_SECRET;
process.env.KV_REST_API_URL = "http://marketing-routes.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.SITE_URL = "https://www.liumeiti.vip";
process.env.OPS_HIGH_FREQUENCY_CRON = "1";

const redis = installMarketingRedisMock("http://marketing-routes.redis.test");
const utils = await import("../app/api/_utils.js");
const preferences = await import("../app/api/_mail-preferences.js");
const audienceRoute = await import("../app/api/admin/mail/audience/route.js");
const previewRoute = await import("../app/api/admin/mail/preview/route.js");
const adminMailRoute = await import("../app/api/admin/mail/route.js");
const campaignRoute = await import("../app/api/admin/mail/campaign/route.js");
const campaignsRoute = await import("../app/api/admin/mail/campaigns/route.js");
const campaignDetailRoute = await import("../app/api/admin/mail/campaigns/[campaignId]/route.js");
const campaignStatsRoute = await import("../app/api/admin/mail/campaigns/[campaignId]/stats/route.js");

const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });
const restrictedMailToken = utils.signSession({
  role: "admin",
  staffId: 2,
  staffUsername: "support",
  staffRole: "support",
  staffPerms: { canSendMail: true, canViewOrders: false },
  exp: Date.now() + 60_000,
});

function adminRequest(path, method = "GET", body = null, token = adminToken) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    method,
    headers: {
      cookie: `lm_admin=${encodeURIComponent(token)}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("audience route builds a server-side snapshot and excludes suppressed contacts", async () => {
  redis.execute(["SADD", "liumeiti:users:emails", "eligible@example.com", "blocked@example.com"]);
  await preferences.suppressMailAddress({ email: "blocked@example.com", scope: "marketing", reason: "marketing_unsubscribed", source: "test" });
  const response = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["registered"], locales: [], requireMarketingAllowed: true },
    limit: 100,
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.audience.snapshot.matchedCount, 2);
  assert.equal(data.audience.snapshot.eligibleCount, 1);
  assert.equal(data.audience.snapshot.suppressedCount, 1);
  assert.equal(Object.hasOwn(data.audience, "emails"), false, "preview route must not expose raw audience emails");
});

test("legacy customer orders use top-level service or plan and explicit contact language", async () => {
  const completedAt = new Date().toISOString();
  const serviceOrderId = "ORDER-LEGACY-AUDIENCE-SERVICE";
  const planOrderId = "ORDER-LEGACY-AUDIENCE-PLAN";
  redis.execute(["SET", "liumeiti:orders:index:legacy-ready", "1"]);
  redis.execute(["SET", "liumeiti:orders:index:record-ready:v1", "1"]);
  redis.execute(["RPUSH", "liumeiti:orders:index", serviceOrderId, planOrderId]);
  redis.execute(["SET", `liumeiti:orders:record:${serviceOrderId}`, JSON.stringify({
    orderId: serviceOrderId,
    email: "legacy-service@example.com",
    status: "completed",
    finalAmount: 88,
    service: "spotify",
    plan: "family",
    createdAt: completedAt,
    completedAt,
  })]);
  redis.execute(["SET", `liumeiti:orders:record:${planOrderId}`, JSON.stringify({
    orderId: planOrderId,
    email: "legacy-plan@example.com",
    status: "completed",
    finalAmount: 99,
    plan: "netflix-legacy-plan",
    createdAt: completedAt,
    completedAt,
  })]);
  await preferences.ensureMailContact("legacy-service@example.com", { source: "account", locale: "en" });
  await preferences.ensureMailContact("legacy-plan@example.com", { source: "account", locale: "zh" });

  const serviceResponse = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["customer"], locales: ["en"], serviceKeys: ["spotify"], requireMarketingAllowed: true },
    limit: 100,
  }));
  const serviceAudience = (await serviceResponse.json()).audience;
  assert.equal(serviceResponse.status, 200);
  assert.equal(serviceAudience.snapshot.matchedCount, 1);
  assert.equal(serviceAudience.sample[0].locale, "en");
  assert.deepEqual(serviceAudience.sample[0].services, ["spotify"]);

  const planResponse = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["customer"], locales: ["zh"], serviceKeys: ["netflix-legacy-plan"], requireMarketingAllowed: true },
    limit: 100,
  }));
  const planAudience = (await planResponse.json()).audience;
  assert.equal(planResponse.status, 200);
  assert.equal(planAudience.snapshot.matchedCount, 1);
  assert.equal(planAudience.sample[0].locale, "zh");
  assert.deepEqual(planAudience.sample[0].services, ["netflix-legacy-plan"]);
});

test("audience validation never widens invalid segments and source outages return 503", async () => {
  const invalidSource = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["registered", "not-a-source"], locales: ["zh"] },
    limit: 100,
  }));
  assert.equal(invalidSource.status, 400);
  assert.equal((await invalidSource.json()).error, "invalid_segment_sources");

  const invalidRange = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["registered"], minOrders: 5, maxOrders: 1 },
    limit: 100,
  }));
  assert.equal(invalidRange.status, 400);
  assert.equal((await invalidRange.json()).error, "invalid_segment_order_range");

  redis.failNextCommand("SMEMBERS", "liumeiti:users:emails");
  const unavailable = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["registered"] },
    limit: 100,
  }));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "user_store_unavailable");
});

test("v7 preview route validates offers and sanitizes custom HTML", async () => {
  const generated = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    subject: "限时优惠",
    offer: { headline: "八月精选", originalPrice: "¥199", currentPrice: "¥129", savingText: "立省 ¥70", couponCode: "AUG70", ctaPath: "/shop" },
  }));
  const generatedData = await generated.json();
  assert.equal(generated.status, 200);
  assert.match(generatedData.html, /AUG70/);
  assert.match(generatedData.html, /¥129/);
  assert.match(generatedData.html, /八月精选/);

  const unsafe = "<div onclick=\"steal()\"><script>alert(1)</script><a href=\"javascript:alert(2)\">open</a></div>";
  const sanitized = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    html: unsafe,
    offer: {},
  }));
  const sanitizedData = await sanitized.json();
  assert.equal(sanitizedData.sanitized, true);
  assert.doesNotMatch(sanitizedData.html, /<script|onclick|javascript:/i);
  assert.match(sanitizedData.text, /open/);
  assert.doesNotMatch(sanitizedData.text, /常用数字服务|优惠与规格一次看清/);
});

test("direct v7 delivery rejects the same expired offer that preview rejects", async () => {
  const offer = { endsAt: new Date(Date.now() - 60_000).toISOString() };
  const preview = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    offer,
  }));
  const delivery = await adminMailRoute.POST(adminRequest("/api/admin/mail", "POST", {
    template: "service_selection_edm_v7",
    to: "expired-offer@example.com",
    offer,
  }));
  assert.equal(preview.status, 400);
  assert.equal(delivery.status, 400);
  assert.equal((await preview.json()).error, "offer_expired");
  assert.equal((await delivery.json()).error, "offer_expired");
});

test("campaign routes schedule v7, list activity, pause it, and expose attribution counters", async () => {
  const campaignId = "CMP-ROUTE-V7";
  const schedule = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId,
    name: "route campaign",
    recipients: ["campaign@example.com"],
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    subject: "限时优惠",
    locale: "zh",
    offer: { headline: "活动优惠", currentPrice: "查看活动价", couponCode: "ROUTE10", ctaPath: "/shop" },
  }));
  const scheduled = await schedule.json();
  assert.equal(schedule.status, 200);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.scheduledCount, 1);
  assert.deepEqual(scheduled.scheduler, {
    mode: "external_hourly",
    cadenceMs: 60 * 60_000,
    dispatchRule: "next_scheduler_sweep",
    maxExpectedDelayMs: 60 * 60_000,
  });

  const list = await campaignsRoute.GET(adminRequest("/api/admin/mail/campaigns?includeAttribution=1"));
  const listed = await list.json();
  assert.equal(list.status, 200);
  assert.ok(listed.campaigns.some((campaign) => campaign.id === campaignId && campaign.templateVersion === 7 && campaign.attribution?.revenue === 0));

  const pause = await campaignDetailRoute.PATCH(adminRequest(`/api/admin/mail/campaigns/${campaignId}`, "PATCH", { action: "pause" }), { params: Promise.resolve({ campaignId }) });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).campaign.status, "paused");

  const stats = await campaignStatsRoute.GET(adminRequest(`/api/admin/mail/campaigns/${campaignId}/stats`), { params: Promise.resolve({ campaignId }) });
  const statsData = await stats.json();
  assert.equal(stats.status, 200);
  assert.equal(statsData.campaign.id, campaignId);
  assert.equal(statsData.counters.queued, 1);
  assert.equal(statsData.attribution.model, "last_email_click_30d");
});

test("campaign scheduling reports explicit opt-outs as suppressed, not provider failures", async () => {
  await preferences.suppressMailAddress({ email: "opted-out@example.com", scope: "marketing", reason: "marketing_unsubscribed", source: "test" });
  const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-SUPPRESSED",
    recipients: ["opted-out@example.com"],
    scheduledAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    offer: {},
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.scheduledCount, 0);
  assert.equal(data.suppressedCount, 1);
  assert.equal(data.failedCount, 0);
});

test("campaign scheduling rejects offer deadlines before delivery and conflicting idempotency payloads", async () => {
  const scheduledAt = new Date(Date.now() + 12 * 60 * 1000).toISOString();
  const invalidDeadline = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-DEADLINE-BEFORE-SEND",
    recipients: ["deadline@example.com"],
    scheduledAt,
    template: "service_selection_edm_v7",
    offer: { endsAt: new Date(Date.now() + 8 * 60 * 1000).toISOString() },
  }));
  assert.equal(invalidDeadline.status, 400);
  assert.equal((await invalidDeadline.json()).error, "offer_ends_before_schedule");

  const first = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-CONFLICTING-PAYLOAD",
    recipients: ["conflict@example.com"],
    scheduledAt,
    template: "service_selection_edm_v7",
    subject: "first payload",
    offer: {},
  }));
  assert.equal(first.status, 200);
  const conflict = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-CONFLICTING-PAYLOAD",
    recipients: ["conflict@example.com"],
    scheduledAt,
    template: "service_selection_edm_v7",
    subject: "different payload",
    offer: {},
  }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "campaign_conflict");
});

test("campaign list counter reads stay constant as the page grows", async () => {
  const indexKey = "lm:mail:marketing:campaign:index";
  for (let index = 0; index < 50; index += 1) {
    const id = `CMP-BATCH-${String(index).padStart(2, "0")}`;
    redis.execute(["SET", `lm:mail:marketing:campaign:${id}`, JSON.stringify({
      id,
      name: id,
      status: "scheduled",
      subject: "batch counter test",
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAtMs: Date.now() + index,
    })]);
    redis.execute(["ZADD", indexKey, String(Date.now() + index), id]);
  }

  const beforeOne = redis.requestCount;
  const one = await campaignsRoute.GET(adminRequest("/api/admin/mail/campaigns?limit=1"));
  const oneRequests = redis.requestCount - beforeOne;
  assert.equal(one.status, 200);
  assert.equal((await one.json()).campaigns.length, 1);

  const beforeFifty = redis.requestCount;
  const fifty = await campaignsRoute.GET(adminRequest("/api/admin/mail/campaigns?limit=50"));
  const fiftyRequests = redis.requestCount - beforeFifty;
  assert.equal(fifty.status, 200);
  assert.equal((await fifty.json()).campaigns.length, 50);
  assert.equal(fiftyRequests, oneRequests, `expected a batched constant request count, saw ${oneRequests} vs ${fiftyRequests}`);
});

test("mail-only staff receive aggregate attribution but no order IDs or audience samples", async () => {
  const orderId = "ORDER-MAIL-PERMISSION-1";
  redis.execute(["SET", "liumeiti:orders:index:legacy-ready", "1"]);
  redis.execute(["SET", "liumeiti:orders:index:record-ready:v1", "1"]);
  redis.execute(["RPUSH", "liumeiti:orders:index", orderId]);
  redis.execute(["SET", `liumeiti:orders:record:${orderId}`, JSON.stringify({
    orderId,
    status: "completed",
    finalAmount: 129,
    createdAt: new Date().toISOString(),
    marketingAttribution: { campaignId: "CMP-ROUTE-V7" },
  })]);

  const stats = await campaignStatsRoute.GET(
    adminRequest("/api/admin/mail/campaigns/CMP-ROUTE-V7/stats", "GET", null, restrictedMailToken),
    { params: Promise.resolve({ campaignId: "CMP-ROUTE-V7" }) },
  );
  const statsData = await stats.json();
  assert.equal(stats.status, 200);
  assert.equal(statsData.attribution.saleCount, 1);
  assert.equal(Object.hasOwn(statsData.attribution, "orderIds"), false);

  const audience = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment: { sources: ["registered"], locales: [], requireMarketingAllowed: true },
    limit: 100,
  }, restrictedMailToken));
  const audienceData = await audience.json();
  assert.equal(audience.status, 200);
  assert.deepEqual(audienceData.audience.sample, []);
  assert.deepEqual(audienceData.audience.excluded, []);
});
