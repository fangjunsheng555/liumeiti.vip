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
const audienceData = await import("../app/api/admin/mail/audience-data.js");
const audienceRoute = await import("../app/api/admin/mail/audience/route.js");
const previewRoute = await import("../app/api/admin/mail/preview/route.js");
const adminMailRoute = await import("../app/api/admin/mail/route.js");
const campaignRoute = await import("../app/api/admin/mail/campaign/route.js");
const campaignsRoute = await import("../app/api/admin/mail/campaigns/route.js");
const campaignDetailRoute = await import("../app/api/admin/mail/campaigns/[campaignId]/route.js");
const campaignStatsRoute = await import("../app/api/admin/mail/campaigns/[campaignId]/stats/route.js");
const { CATALOG_DEFAULTS } = await import("../app/lib/catalog-defaults.js");
const { getCatalogDisplayPrice } = await import("../app/lib/catalog-price.js");

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

async function previewV7Content({ subject = "", offer = {} } = {}) {
  const response = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    subject,
    offer,
  }));
  const data = await response.json();
  assert.equal(response.status, 200, data.error || "v7 preview failed");
  assert.match(data.contentHash || "", /^[a-f0-9]{64}$/);
  assert.match(data.offerSnapshotHash || "", /^[a-f0-9]{64}$/);
  return { mailContentHash: data.contentHash, offerSnapshotHash: data.offerSnapshotHash };
}

async function previewAudienceHash({ segment, manualRecipients = [], maxRecipients = 2000 } = {}) {
  const response = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
    segment,
    manualRecipients,
    limit: maxRecipients,
  }));
  const data = await response.json();
  assert.equal(response.status, 200, data.error || "audience preview failed");
  assert.match(data.audience?.snapshotHash || "", /^[a-f0-9]{64}$/);
  return data.audience.snapshotHash;
}

async function previewV7ManualAudience(recipients, maxRecipients = 2000) {
  const segment = { sources: ["manual"], requireMarketingAllowed: true };
  const manualRecipients = Array.isArray(recipients) ? recipients : [recipients];
  const audienceSnapshotHash = await previewAudienceHash({ segment, manualRecipients, maxRecipients });
  return { segment, manualRecipients, maxRecipients, audienceSnapshotHash };
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

test("manual, registered and every historical order contact merge once before suppression", async () => {
  const pendingOrderId = "ORDER-MARKETING-MERGE-PENDING";
  const duplicateOrderId = "ORDER-MARKETING-MERGE-DUPLICATE";
  const splitIdentityOrderId = "ORDER-MARKETING-MERGE-SPLIT-IDENTITY";
  redis.execute(["SET", "liumeiti:orders:index:legacy-ready", "1"]);
  redis.execute(["SET", "liumeiti:orders:index:record-ready:v1", "1"]);
  redis.execute(["RPUSH", "liumeiti:orders:index", pendingOrderId, duplicateOrderId, splitIdentityOrderId]);
  redis.execute(["SET", `liumeiti:orders:record:${pendingOrderId}`, JSON.stringify({
    orderId: pendingOrderId,
    email: "merge-pending@example.com",
    status: "pending",
    service: "spotify",
    createdAt: "2025-01-02T03:04:05.000Z",
  })]);
  redis.execute(["SET", `liumeiti:orders:record:${duplicateOrderId}`, JSON.stringify({
    orderId: duplicateOrderId,
    email: "merge-duplicate@example.com",
    status: "cancelled",
    service: "ai",
    createdAt: "2025-01-03T03:04:05.000Z",
  })]);
  redis.execute(["SET", `liumeiti:orders:record:${splitIdentityOrderId}`, JSON.stringify({
    orderId: splitIdentityOrderId,
    userEmail: "merge-account-owner@example.com",
    email: "merge-order-contact@example.com",
    status: "pending",
    service: "netflix",
    createdAt: "2025-01-04T03:04:05.000Z",
  })]);
  redis.execute(["SADD", "liumeiti:users:emails",
    "merge-registered@example.com",
    "merge-duplicate@example.com",
    "merge-suppressed@example.com",
  ]);
  await preferences.suppressMailAddress({
    email: "merge-suppressed@example.com",
    scope: "marketing",
    reason: "marketing_unsubscribed",
    source: "test",
  });

  const audience = await audienceData.buildMailAudience({
    definition: { sources: ["manual", "registered", "order_contact"], requireMarketingAllowed: true },
    manualEmails: [
      "merge-manual@example.com",
      " MERGE-DUPLICATE@example.com ",
      "merge-manual@example.com",
      "bad address@example.com",
      "merge-suppressed@example.com",
    ],
    includeEmails: true,
    maxRecipients: 2000,
  });

  for (const email of [
    "merge-manual@example.com",
    "merge-registered@example.com",
    "merge-duplicate@example.com",
    "merge-pending@example.com",
    "merge-account-owner@example.com",
    "merge-order-contact@example.com",
  ]) {
    assert.equal(audience.emails.filter((candidate) => candidate === email).length, 1, `${email} must be merged exactly once`);
  }
  assert.equal(audience.emails.includes("merge-suppressed@example.com"), false);
  assert.equal(audience.emails.includes("bad address@example.com"), false);
  assert.equal(audience.snapshot.manualCandidateCount, 3);
  assert.equal(audience.snapshot.invalidManualCount, 1);
  assert.ok(audience.snapshot.suppressedCount >= 1);
});

test("audience reports source truncation instead of silently claiming every address was included", async () => {
  const oversized = Array.from({ length: 5001 }, (_, index) => `source-cap-${index}@example.com`);
  const manual = Array.from({ length: 2000 }, (_, index) => `manual-cap-${index}@example.com`);
  redis.execute(["SADD", "liumeiti:users:emails", ...oversized]);
  try {
    const audience = await audienceData.buildMailAudience({
      definition: { sources: ["registered"], requireMarketingAllowed: false },
      includeEmails: true,
      maxRecipients: 2000,
    });

    assert.equal(audience.snapshot.sourceTruncated, true);
    assert.equal(audience.snapshot.truncated, true);
    assert.equal(audience.snapshot.selectedCount, 2000);

    const policyBoundary = await audienceData.buildMailAudience({
      definition: { sources: ["manual"], requireMarketingAllowed: false },
      manualEmails: manual,
      includeEmails: true,
      maxRecipients: 2000,
    });
    assert.equal(policyBoundary.snapshot.selectedCount, 2000);
    assert.equal(policyBoundary.snapshot.eligibleCount, 2000);
    assert.equal(policyBoundary.snapshot.sourceTruncated, true);
    assert.equal(policyBoundary.snapshot.truncated, true, "a source-cap overflow must block scheduling even when the selected segment itself fits");

    const schedule = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
      campaignId: "CMP-TRUNCATED-AUDIENCE",
      scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      template: "service_selection_edm_v7",
      segment: { sources: ["registered"], requireMarketingAllowed: true },
      maxRecipients: 2000,
      offer: {},
    }));
    const data = await schedule.json();
    assert.equal(schedule.status, 409);
    assert.equal(data.error, "audience_truncated");
    assert.equal(data.audience.snapshot.sourceTruncated, true);
    assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-TRUNCATED-AUDIENCE"]), null);
  } finally {
    redis.execute(["SREM", "liumeiti:users:emails", ...oversized]);
  }
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

test("audience snapshot hashes a normalized set independent of order, case, and duplicates", () => {
  const first = audienceData.mailAudienceSnapshotHash([
    " Second@example.com ",
    "first@example.com",
    "FIRST@example.com",
    "not an email",
  ]);
  const second = audienceData.mailAudienceSnapshotHash([
    "FIRST@example.com",
    "second@example.com",
  ]);
  assert.equal(first, second);
});

test("a retryable suppression decision aborts the whole audience preview", async () => {
  const email = "retryable-policy@example.com";
  try {
    redis.execute(["SADD", "liumeiti:users:emails", email]);
    for (let index = 1; index <= 3; index += 1) {
      const feedback = await preferences.applyMailFeedback({
        email,
        status: "bounced",
        eventType: "soft_bounce",
        reason: "mailbox temporarily unavailable",
        provider: "test",
        eventId: `retryable-policy-${index}`,
      });
      assert.equal(feedback.ok, true);
    }
    const response = await audienceRoute.POST(adminRequest("/api/admin/mail/audience", "POST", {
      segment: { sources: ["registered"], requireMarketingAllowed: true },
      limit: 100,
    }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "mail_policy_unavailable");
  } finally {
    redis.execute(["SREM", "liumeiti:users:emails", email]);
  }
});

test("v7 preview accepts legacy offer fields but never presents invented discounts", async () => {
  const generated = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    subject: "本期服务精选",
    offer: {
      headline: "八月精选",
      description: {},
      badge: [],
      ctaLabel: true,
      originalPrice: "¥99999",
      currentPrice: "手填活动价-一元",
      savingText: "立省 ¥99998",
      couponCode: "LEGACY-NOT-A-REAL-DISCOUNT",
      deadlineText: "LEGACY-FAKE-DEADLINE",
      ctaPath: "/shop",
      serviceKeys: ["spotify"],
    },
  }));
  const generatedData = await generated.json();
  assert.equal(generated.status, 200);
  assert.match(generatedData.html, /八月精选/);
  assert.match(generatedData.html, /本期服务精选|查看全部服务|我们整理了当前可用的服务与起售价格/);
  assert.doesNotMatch(generatedData.html, /\[object Object\]/);
  assert.doesNotMatch(generatedData.text, /\[object Object\]/);
  assert.match(generatedData.html, /\/services\/spotify/);
  assert.deepEqual(generatedData.offer.featuredServiceKeys, ["spotify"]);
  for (const legacyField of ["couponCode", "originalPrice", "currentPrice", "savingText", "deadlineText", "serviceKeys"]) {
    assert.equal(Object.hasOwn(generatedData.offer, legacyField), false);
  }
  assert.doesNotMatch(generatedData.html, /LEGACY-NOT-A-REAL-DISCOUNT|LEGACY-FAKE-DEADLINE|¥99999|手填活动价-一元|立省 ¥99998|优惠码|原价\s*(?:<|[：:])|活动价\s*(?:<|[：:])/);
  assert.doesNotMatch(generatedData.text, /LEGACY-NOT-A-REAL-DISCOUNT|LEGACY-FAKE-DEADLINE|¥99999|手填活动价-一元|立省 ¥99998|优惠码|原价[：:]|活动价[：:]/);
  assert.match(generatedData.html, /同时选购/);
  assert.match(generatedData.html, /USDT/);
  assert.match(generatedData.html, /无需额外操作/);
  assert.match(generatedData.html, /结算优惠自动计算/);
  assert.doesNotMatch(generatedData.html, /DIGITAL MEMBERSHIP DESK|WHY IT MATTERS|RECOMMENDED FOR YOU|RFC\s*8058|服务端分群|活动 ID|归因模型|Hobby/i);

  const unsafe = "<div onclick=\"steal()\"><script>alert(1)</script><a href=\"javascript:alert(2)\">FAKE-COUPON-IN-CUSTOM-HTML</a></div>";
  const catalogOnly = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    html: unsafe,
    offer: { featuredServiceKeys: ["spotify"] },
  }));
  const catalogOnlyData = await catalogOnly.json();
  assert.equal(catalogOnlyData.customHtmlIgnored, true);
  assert.equal(catalogOnlyData.sanitized, false);
  assert.match(catalogOnlyData.html, /\/services\/spotify/);
  assert.doesNotMatch(catalogOnlyData.html, /FAKE-COUPON-IN-CUSTOM-HTML|<script|onclick|javascript:/i);
  assert.doesNotMatch(catalogOnlyData.text, /FAKE-COUPON-IN-CUSTOM-HTML/i);

  const legacySanitized = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v6",
    html: unsafe,
  }));
  const legacyData = await legacySanitized.json();
  assert.equal(legacyData.sanitized, true);
  assert.equal(legacyData.customHtmlIgnored, false);
  assert.doesNotMatch(legacyData.html, /<script|onclick|javascript:/i);
  assert.match(legacyData.text, /FAKE-COUPON-IN-CUSTOM-HTML/);
});

test("legacy v6 preview blocks entity, SVG data, CSS URL, and encoded-event sanitizer bypasses", async () => {
  const response = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v6",
    html: `<table role="presentation" style="width:100%;color:#123f3a">
      <tr><td><a href="https://www.liumeiti.vip/shop">SAFE-LEGACY-MARKUP</a></td></tr>
      <tr><td><a href="java&#x73;cript:alert(1)">ENTITY-PROTOCOL</a></td></tr>
      <tr><td><img src="data:image/svg+xml,<svg onload=alert(2)>" alt="SVG-DATA"></td></tr>
      <tr><td style="background:url(javascript:alert(3))">CSS-PROTOCOL</td></tr>
      <tr><td><img src="https://www.liumeiti.vip/email-logo.png" o&#x6e;error="alert(4)" alt="ENCODED-EVENT"></td></tr>
      <meta http-equiv="refresh" content="0;url=javascript:alert(5)">
      <link rel="stylesheet" href="https://outside.example/style.css">
      <audio autoplay src="https://outside.example/sound.mp3">ACTIVE-AUDIO</audio>
      <video autoplay src="https://outside.example/video.mp4"><source src="https://outside.example/alt.mp4"></video>
    </table>`,
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.sanitized, true);
  assert.equal(data.customHtmlIgnored, false);
  assert.match(data.html, /role="presentation"/);
  assert.match(data.html, /href="https:\/\/www\.liumeiti\.vip\/shop"/);
  assert.match(data.html, /src="https:\/\/www\.liumeiti\.vip\/email-logo\.png"/);
  assert.doesNotMatch(data.html, /javascript:|data:image\/svg\+xml|\bonerror\s*=|background:url\(|<\/?(?:meta|link|audio|video|source|track)\b/i);
  assert.equal((data.html.match(/(?:href|src)="#"/g) || []).length, 2);
});

test("v7 preview reads the displayed product name and price from the live catalog", async () => {
  redis.execute(["SET", "lm:catalog:overrides", JSON.stringify({
    products: {
      spotify: {
        title: "Spotify 目录同步测试",
        shortIntro: "此文案来自商品目录覆盖",
        plans: { member: { amount: 321 } },
      },
    },
  })]);
  try {
    const response = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: { featuredServiceKeys: ["spotify"], ctaPath: "/shop" },
    }));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(data.html, /Spotify 目录同步测试/);
    assert.match(data.html, /此文案来自商品目录覆盖/);
    assert.match(data.html, /¥321\/年起/);
    assert.match(data.html, /href="https:\/\/www\.liumeiti\.vip\/services\/spotify"/);
    assert.doesNotMatch(data.html, /机场节点|AI 会员|Netflix|Disney\+|HBO Max|全球代付/);
  } finally {
    redis.execute(["DEL", "lm:catalog:overrides"]);
  }
});

test("v7 preview and scheduling fail closed when the live catalog is unavailable or empty", async () => {
  redis.execute(["SET", "lm:catalog:overrides", "{}"]);
  const legacyEmptyOverrides = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    offer: {},
  }));
  assert.equal(legacyEmptyOverrides.status, 200, "a historical empty override object means no overrides, not an outage");
  redis.execute(["DEL", "lm:catalog:overrides"]);

  redis.failNextCommand("GET", "lm:catalog:overrides", { error: "catalog offline" });
  const unavailable = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
    template: "service_selection_edm_v7",
    offer: {},
  }));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "marketing_catalog_unavailable");

  redis.execute(["SET", "lm:catalog:overrides", JSON.stringify({
    products: Object.fromEntries(CATALOG_DEFAULTS.map((product) => [product.key, { active: false }])),
  })]);
  try {
    const emptyPreview = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: {},
    }));
    assert.equal(emptyPreview.status, 503);
    assert.equal((await emptyPreview.json()).error, "marketing_catalog_empty");

    const emptyAudience = await previewV7ManualAudience("catalog-empty@example.com");
    const emptySchedule = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
      campaignId: "CMP-EMPTY-LIVE-CATALOG",
      scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      template: "service_selection_edm_v7",
      ...emptyAudience,
      mailContentHash: "a".repeat(64),
      offerSnapshotHash: "b".repeat(64),
      offer: {},
    }));
    assert.equal(emptySchedule.status, 503);
    assert.equal((await emptySchedule.json()).error, "marketing_catalog_empty");
    assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-EMPTY-LIVE-CATALOG"]), null);

    const legacyPreview = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v6",
      html: "<p>legacy remains available</p>",
    }));
    assert.equal(legacyPreview.status, 200);
  } finally {
    redis.execute(["DEL", "lm:catalog:overrides"]);
  }
});

test("v7 marketing uses only sellable plans and recomputes the live starting price", async () => {
  const spotify = CATALOG_DEFAULTS.find((product) => product.key === "spotify");
  const stockKeys = spotify.plans.map((plan) => `liumeiti:stock:spotify:${plan.id}`);
  try {
    redis.execute(["SET", "liumeiti:stock:spotify:member", "0"]);
    const expectedPrice = getCatalogDisplayPrice({
      ...spotify,
      plans: spotify.plans.filter((plan) => plan.id !== "member"),
    });
    assert.notEqual(expectedPrice, spotify.priceText, "the sold-out cheapest plan must change the displayed starting price");

    const partial = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: { featuredServiceKeys: ["spotify"] },
    }));
    const partialData = await partial.json();
    assert.equal(partial.status, 200);
    assert.ok(partialData.html.includes(expectedPrice));
    assert.equal(partialData.html.includes(spotify.priceText), false);

    for (const plan of spotify.plans) redis.execute(["SET", `liumeiti:stock:spotify:${plan.id}`, "0"]);
    const unavailableProduct = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: { featuredServiceKeys: ["spotify"] },
    }));
    const unavailableProductData = await unavailableProduct.json();
    assert.equal(unavailableProduct.status, 200, "other live products keep the catalog usable");
    assert.doesNotMatch(unavailableProductData.html, /\/services\/spotify/);
  } finally {
    redis.execute(["DEL", ...stockKeys]);
  }
});

test("v7 marketing never falls back to a sold-out paid price when only a trial plan remains", async () => {
  const rocket = CATALOG_DEFAULTS.find((product) => product.key === "rocket");
  const paidPlans = rocket.plans.filter((plan) => plan.id !== "trial");
  const stockKeys = rocket.plans.map((plan) => `liumeiti:stock:rocket:${plan.id}`);
  try {
    for (const plan of paidPlans) redis.execute(["SET", `liumeiti:stock:rocket:${plan.id}`, "0"]);
    const response = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: { featuredServiceKeys: ["rocket"] },
    }));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(data.html, /查看当前可用规格/);
    assert.equal(data.html.includes(rocket.priceText), false);
    assert.match(data.html, /\/services\/rocket/);
  } finally {
    redis.execute(["DEL", ...stockKeys]);
  }
});

test("v7 marketing fails closed on invalid inventory and when every active plan is sold out", async () => {
  const stockKeys = CATALOG_DEFAULTS.flatMap((product) => (
    product.plans.map((plan) => `liumeiti:stock:${product.key}:${plan.id}`)
  ));
  try {
    redis.execute(["SET", stockKeys[0], "12.5"]);
    const invalid = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: {},
    }));
    assert.equal(invalid.status, 503);
    assert.equal((await invalid.json()).error, "marketing_catalog_unavailable");

    for (const key of stockKeys) redis.execute(["SET", key, "0"]);
    const empty = await previewRoute.POST(adminRequest("/api/admin/mail/preview", "POST", {
      template: "service_selection_edm_v7",
      offer: {},
    }));
    assert.equal(empty.status, 503);
    assert.equal((await empty.json()).error, "marketing_catalog_empty");
  } finally {
    redis.execute(["DEL", ...stockKeys]);
  }
});

test("v7 rejects direct recipients while the legacy v6 path remains compatible", async () => {
  const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-V7-DIRECT-BYPASS",
    recipients: ["direct-bypass@example.com"],
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    offer: {},
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "audience_preview_required");
  assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-V7-DIRECT-BYPASS"]), null);
});

test("campaign scheduling rejects array segments without breaking legacy v6 null compatibility", async () => {
  for (const [template, segment] of [
    ["service_selection_edm_v7", []],
    ["service_selection_edm_v6", []],
  ]) {
    const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
      campaignId: `CMP-INVALID-SEGMENT-${template.slice(-2)}-${segment === null ? "NULL" : "ARRAY"}`,
      recipients: ["must-not-be-used@example.com"],
      scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      template,
      segment,
      offer: {},
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_segment");
  }

  const v7Null = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-V7-NULL-SEGMENT",
    recipients: ["must-not-be-used@example.com"],
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    segment: null,
    offer: {},
  }));
  assert.equal(v7Null.status, 400);
  assert.equal((await v7Null.json()).error, "audience_preview_required");

  const v6Null = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-V6-NULL-SEGMENT",
    recipients: ["legacy-null-segment@example.com"],
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v6",
    segment: null,
  }));
  assert.equal(v6Null.status, 200);
  assert.equal((await v6Null.json()).scheduledCount, 1);
});

test("offer snapshot binds operational dates without changing the rendered-content hash", async () => {
  const firstOffer = { endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() };
  const secondOffer = { endsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() };
  const first = await previewV7Content({ offer: firstOffer });
  const second = await previewV7Content({ offer: secondOffer });
  assert.equal(first.mailContentHash, second.mailContentHash);
  assert.notEqual(first.offerSnapshotHash, second.offerSnapshotHash);

  const audienceFields = await previewV7ManualAudience("offer-snapshot@example.com");
  const schedule = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-OFFER-SNAPSHOT-CHANGED",
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    ...audienceFields,
    ...first,
    offer: secondOffer,
  }));
  const data = await schedule.json();
  assert.equal(schedule.status, 409);
  assert.equal(data.error, "offer_snapshot_changed");
  assert.equal(data.offerSnapshotHash, second.offerSnapshotHash);
  assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-OFFER-SNAPSHOT-CHANGED"]), null);
});

test("an unrendered catalog product change does not invalidate the exact rendered mail", async () => {
  const offer = { featuredServiceKeys: ["spotify"] };
  const [mailSnapshot, audienceFields] = await Promise.all([
    previewV7Content({ offer }),
    previewV7ManualAudience("unrendered-catalog-change@example.com"),
  ]);
  redis.execute(["SET", "lm:catalog:overrides", JSON.stringify({
    products: { ai: { title: "Unrendered AI catalog change", plans: { "gpt-plus": { amount: 777 } } } },
  })]);
  try {
    const changedPreview = await previewV7Content({ offer });
    assert.equal(changedPreview.mailContentHash, mailSnapshot.mailContentHash);
    const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
      campaignId: "CMP-UNRENDERED-CATALOG-CHANGE",
      scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      template: "service_selection_edm_v7",
      ...audienceFields,
      ...mailSnapshot,
      offer,
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scheduledCount, 1);
  } finally {
    redis.execute(["DEL", "lm:catalog:overrides"]);
  }
});

test("v7 scheduling binds both the final audience and the exact previewed catalog content", async () => {
  const segment = { sources: ["registered"], requireMarketingAllowed: true };
  redis.execute(["SADD", "liumeiti:users:emails", "snapshot-first@example.com"]);
  const audienceSnapshotHash = await previewAudienceHash({ segment, maxRecipients: 2000 });
  const mailSnapshot = await previewV7Content({ subject: "绑定预览测试", offer: { featuredServiceKeys: ["spotify"] } });

  const missingAudienceHash = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-AUDIENCE-SNAPSHOT-MISSING",
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    subject: "绑定预览测试",
    segment,
    maxRecipients: 2000,
    ...mailSnapshot,
    offer: { featuredServiceKeys: ["spotify"] },
  }));
  assert.equal(missingAudienceHash.status, 409);
  assert.equal((await missingAudienceHash.json()).error, "audience_changed");

  const missingMailHash = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-MAIL-PREVIEW-MISSING",
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    subject: "绑定预览测试",
    segment,
    maxRecipients: 2000,
    audienceSnapshotHash,
    offerSnapshotHash: mailSnapshot.offerSnapshotHash,
    offer: { featuredServiceKeys: ["spotify"] },
  }));
  assert.equal(missingMailHash.status, 409);
  assert.equal((await missingMailHash.json()).error, "mail_preview_changed");

  redis.execute(["SADD", "liumeiti:users:emails", "snapshot-added@example.com"]);
  const changedAudience = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-AUDIENCE-SNAPSHOT-CHANGED",
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    subject: "绑定预览测试",
    segment,
    maxRecipients: 2000,
    audienceSnapshotHash,
    ...mailSnapshot,
    offer: { featuredServiceKeys: ["spotify"] },
  }));
  const changedAudienceData = await changedAudience.json();
  assert.equal(changedAudience.status, 409);
  assert.equal(changedAudienceData.error, "audience_changed");
  assert.notEqual(changedAudienceData.audience.snapshotHash, audienceSnapshotHash);
  assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-AUDIENCE-SNAPSHOT-CHANGED"]), null);

  redis.execute(["SET", "lm:catalog:overrides", JSON.stringify({
    products: { spotify: { title: "目录签名已变化", plans: { member: { amount: 654 } } } },
  })]);
  try {
    const changedMailAudience = await previewV7ManualAudience("mail-preview-changed@example.com");
    const changedMail = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
      campaignId: "CMP-MAIL-PREVIEW-CHANGED",
      scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      template: "service_selection_edm_v7",
      subject: "绑定预览测试",
      ...changedMailAudience,
      ...mailSnapshot,
      offer: { featuredServiceKeys: ["spotify"] },
    }));
    const changedMailData = await changedMail.json();
    assert.equal(changedMail.status, 409);
    assert.equal(changedMailData.error, "mail_preview_changed");
    assert.notEqual(changedMailData.contentHash, mailSnapshot.mailContentHash);
    assert.equal(redis.execute(["GET", "lm:mail:marketing:campaign:CMP-MAIL-PREVIEW-CHANGED"]), null);
  } finally {
    redis.execute(["DEL", "lm:catalog:overrides"]);
  }
});

test("expired v7 preview is rejected and direct marketing delivery must use the campaign queue", async () => {
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
  assert.equal(delivery.status, 409);
  assert.equal((await preview.json()).error, "offer_expired");
  assert.equal((await delivery.json()).error, "marketing_campaign_required");
});

test("historical campaign snapshots with legacy promotion fields remain listable and pauseable", async () => {
  const campaignId = "CMP-LEGACY-OFFER-SNAPSHOT";
  const legacy = {
    id: campaignId,
    name: "historical campaign",
    status: "scheduled",
    templateId: "service_selection_edm_v7",
    templateVersion: 7,
    subject: "historical subject",
    html: "<p>historical stored body</p>",
    text: "historical stored body",
    scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAtMs: Date.now() - 1_000,
    offerSnapshot: {
      originalPrice: "¥199",
      currentPrice: "¥129",
      savingText: "立省 ¥70",
      couponCode: "OLD-SNAPSHOT-CODE",
      serviceKeys: ["spotify"],
    },
  };
  redis.execute(["SET", `lm:mail:marketing:campaign:${campaignId}`, JSON.stringify(legacy)]);
  redis.execute(["ZADD", "lm:mail:marketing:campaign:index", String(legacy.createdAtMs), campaignId]);

  const list = await campaignsRoute.GET(adminRequest("/api/admin/mail/campaigns?limit=100"));
  const listed = (await list.json()).campaigns.find((campaign) => campaign.id === campaignId);
  assert.equal(list.status, 200);
  assert.equal(listed.offerSnapshot.couponCode, "OLD-SNAPSHOT-CODE");

  const pause = await campaignDetailRoute.PATCH(
    adminRequest(`/api/admin/mail/campaigns/${campaignId}`, "PATCH", { action: "pause" }),
    { params: Promise.resolve({ campaignId }) },
  );
  const paused = await pause.json();
  assert.equal(pause.status, 200);
  assert.equal(paused.campaign.status, "paused");
  assert.equal(paused.campaign.offerSnapshot.couponCode, "OLD-SNAPSHOT-CODE");
});

test("campaign routes schedule v7, list activity, pause it, and expose attribution counters", async () => {
  const campaignId = "CMP-ROUTE-V7";
  const offer = {
    headline: "当前服务精选",
    currentPrice: "手填活动价-一元",
    originalPrice: "¥99999",
    savingText: "立省 ¥99998",
    couponCode: "LEGACY-ROUTE-CODE",
    deadlineText: "LEGACY-FAKE-DEADLINE",
    ctaPath: "/shop",
    serviceKeys: ["ai"],
  };
  const [mailSnapshot, audienceFields] = await Promise.all([
    previewV7Content({ subject: "本期服务精选", offer }),
    previewV7ManualAudience("campaign@example.com"),
  ]);
  const schedule = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId,
    name: "route campaign",
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    subject: "本期服务精选",
    html: "<h1>INVENTED-INTERNAL-OFFER</h1><p>优惠码：NOT-REAL</p>",
    ...audienceFields,
    ...mailSnapshot,
    locale: "zh",
    offer,
  }));
  const scheduled = await schedule.json();
  assert.equal(schedule.status, 200);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.scheduledCount, 1);
  assert.equal(scheduled.scheduler.mode, "external_hourly");
  assert.equal(scheduled.scheduler.cadenceMs, 60 * 60_000);
  assert.equal(scheduled.scheduler.dispatchRule, "next_scheduler_sweep");
  assert.equal(scheduled.scheduler.maxExpectedDelayMs, 60 * 60_000);
  assert.equal(scheduled.scheduler.provider, "resend");
  assert.equal(scheduled.scheduler.dailyLimit, 50);
  assert.ok(scheduled.scheduler.estimatedDays >= 1);

  const persisted = JSON.parse(redis.execute(["GET", `lm:mail:marketing:campaign:${campaignId}`]));
  assert.deepEqual(persisted.offerSnapshot.featuredServiceKeys, ["ai"]);
  for (const legacyField of ["couponCode", "originalPrice", "currentPrice", "savingText", "deadlineText", "serviceKeys"]) {
    assert.equal(Object.hasOwn(persisted.offerSnapshot, legacyField), false);
  }
  assert.doesNotMatch(persisted.html, /LEGACY-ROUTE-CODE|LEGACY-FAKE-DEADLINE|¥99999|手填活动价-一元|立省 ¥99998|优惠码|原价\s*(?:<|[：:])|活动价\s*(?:<|[：:])/);
  assert.doesNotMatch(persisted.text, /LEGACY-ROUTE-CODE|LEGACY-FAKE-DEADLINE|¥99999|手填活动价-一元|立省 ¥99998|优惠码|原价[：:]|活动价[：:]/);
  assert.doesNotMatch(persisted.html, /INVENTED-INTERNAL-OFFER|NOT-REAL/);
  assert.doesNotMatch(persisted.text, /INVENTED-INTERNAL-OFFER|NOT-REAL/);

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

test("legacy campaign scheduling retains sanitized custom HTML compatibility", async () => {
  const campaignId = "CMP-LEGACY-CUSTOM-HTML";
  const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId,
    recipients: ["legacy-custom@example.com"],
    scheduledAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v6",
    subject: "旧版自定义邮件",
    html: `<table role="presentation" style="width:100%;color:#123f3a"><tr><td>
      <a href="https://www.liumeiti.vip/shop"><strong>LEGACY-CUSTOM-BODY</strong></a>
      <a href="java&#x73;cript:bad()">BAD-LINK</a>
      <img src="data:image/svg+xml,<svg onload=bad()>" alt="BAD-SVG">
      <span style="background:url(javascript:bad())">BAD-STYLE</span>
      <img src="https://www.liumeiti.vip/email-logo.png" o&#x6e;error="bad()" alt="BAD-EVENT">
      <meta http-equiv="refresh" content="0;url=javascript:bad()">
      <link rel="stylesheet" href="https://outside.example/style.css">
      <audio autoplay src="https://outside.example/sound.mp3">BAD-AUDIO</audio>
      <video autoplay src="https://outside.example/video.mp4"><track src="https://outside.example/captions.vtt"></video>
      <script>bad()</script>
    </td></tr></table>`,
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.scheduledCount, 1);
  const stored = JSON.parse(redis.execute(["GET", `lm:mail:marketing:campaign:${campaignId}`]));
  assert.match(stored.html, /LEGACY-CUSTOM-BODY/);
  assert.match(stored.text, /LEGACY-CUSTOM-BODY/);
  assert.match(stored.html, /role="presentation"/);
  assert.match(stored.html, /href="https:\/\/www\.liumeiti\.vip\/shop"/);
  assert.match(stored.html, /src="https:\/\/www\.liumeiti\.vip\/email-logo\.png"/);
  assert.doesNotMatch(stored.html, /javascript:|data:image\/svg\+xml|\bonerror\s*=|background:url\(|<script|<\/?(?:meta|link|audio|video|source|track)\b/i);
  assert.equal((stored.html.match(/(?:href|src)="#"/g) || []).length, 2);
});

test("campaign audience excludes explicit opt-outs before scheduling", async () => {
  await preferences.suppressMailAddress({ email: "opted-out@example.com", scope: "marketing", reason: "marketing_unsubscribed", source: "test" });
  const [mailSnapshot, audienceFields] = await Promise.all([
    previewV7Content(),
    previewV7ManualAudience(["campaign-allowed@example.com", "opted-out@example.com"]),
  ]);
  const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-SUPPRESSED",
    scheduledAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    ...audienceFields,
    ...mailSnapshot,
    offer: {},
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.scheduledCount, 1);
  assert.equal(data.suppressedCount, 0);
  assert.equal(data.failedCount, 0);
  assert.equal(data.audience.snapshot.suppressedCount, 1);
});

test("campaign scheduling merges manualRecipients into the server-built audience", async () => {
  const campaignId = "CMP-MANUAL-MERGE";
  const segment = {
    sources: ["manual", "registered", "order_contact"],
    serviceKeys: ["no-existing-service-can-match-this"],
    requireMarketingAllowed: true,
  };
  const manualRecipients = [
    "campaign-manual@example.com",
    " CAMPAIGN-MANUAL@example.com ",
    "invalid address@example.com",
  ];
  const offer = { featuredServiceKeys: ["spotify"] };
  const [audienceSnapshotHash, mailSnapshot] = await Promise.all([
    previewAudienceHash({ segment, manualRecipients, maxRecipients: 20 }),
    previewV7Content({ offer }),
  ]);
  const response = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId,
    scheduledAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    template: "service_selection_edm_v7",
    segment,
    manualRecipients,
    maxRecipients: 20,
    audienceSnapshotHash,
    ...mailSnapshot,
    offer,
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.scheduledCount, 1);
  assert.equal(data.failedCount, 0);
  assert.equal(data.audience.snapshot.manualCandidateCount, 1);
  assert.equal(data.audience.snapshot.invalidManualCount, 1);
  assert.equal(data.audience.snapshot.selectedCount, 1);
  assert.deepEqual(data.audience.sample[0].sources, ["manual"]);

  const stored = JSON.parse(redis.execute(["GET", `lm:mail:marketing:campaign:${campaignId}`]));
  assert.equal(stored.audienceSnapshot.selectedCount, 1);
  assert.equal(stored.audienceSnapshot.invalidManualCount, 1);
});

test("campaign scheduling rejects offer deadlines before delivery and conflicting idempotency payloads", async () => {
  const scheduledAt = new Date(Date.now() + 12 * 60 * 1000).toISOString();
  const deadlineOffer = { endsAt: new Date(Date.now() + 8 * 60 * 1000).toISOString() };
  const [deadlineAudience, deadlineMailSnapshot] = await Promise.all([
    previewV7ManualAudience("deadline@example.com"),
    previewV7Content({ offer: deadlineOffer }),
  ]);
  const invalidDeadline = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-DEADLINE-BEFORE-SEND",
    scheduledAt,
    template: "service_selection_edm_v7",
    ...deadlineAudience,
    ...deadlineMailSnapshot,
    offer: deadlineOffer,
  }));
  assert.equal(invalidDeadline.status, 400);
  assert.equal((await invalidDeadline.json()).error, "offer_ends_before_schedule");

  const [conflictAudience, firstMailSnapshot] = await Promise.all([
    previewV7ManualAudience("conflict@example.com"),
    previewV7Content({ subject: "first payload" }),
  ]);
  const first = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-CONFLICTING-PAYLOAD",
    scheduledAt,
    template: "service_selection_edm_v7",
    subject: "first payload",
    ...conflictAudience,
    ...firstMailSnapshot,
    offer: {},
  }));
  assert.equal(first.status, 200);
  const changedMailSnapshot = await previewV7Content({ subject: "different payload" });
  const conflict = await campaignRoute.POST(adminRequest("/api/admin/mail/campaign", "POST", {
    campaignId: "CMP-CONFLICTING-PAYLOAD",
    scheduledAt,
    template: "service_selection_edm_v7",
    subject: "different payload",
    ...conflictAudience,
    ...changedMailSnapshot,
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
