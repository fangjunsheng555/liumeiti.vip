import assert from "node:assert/strict";
import test from "node:test";

import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "abandoned-delivery-secret-32-characters";
process.env.MAIL_PREFERENCES_SECRET = process.env.AUTH_SECRET;
process.env.KV_REST_API_URL = "http://abandoned-delivery.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.SITE_URL = "https://www.liumeiti.vip";
process.env.RESEND_API_KEY = "re_abandoned_delivery_test";
process.env.RESEND_FROM = "info@liumeiti.vip";
process.env.EMAIL_PROVIDER = "resend";

const redis = installMarketingRedisMock("http://abandoned-delivery.redis.test");
const utils = await import("../app/api/_utils.js");
const preferences = await import("../app/api/_mail-preferences.js");
const abandonedRoute = await import("../app/api/admin/abandoned/route.js");
const deliveryModule = await import("../app/api/_delivery-once.js");
const marketingQueue = await import("../app/api/_marketing-campaign-queue.js");

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "admin",
  exp: Date.now() + 60_000,
});

const redisFetch = globalThis.fetch;
const providerRequests = [];
const physicalDeliveries = [];
const acceptedByIdempotencyKey = new Map();
let providerBehavior = "ok";
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.resend.com") return redisFetch(input, options);
  providerRequests.push({
    body: JSON.parse(options.body || "{}"),
    headers: new Headers(options.headers || {}),
  });
  if (providerBehavior === "uncertain") {
    return Response.json({ message: "provider unavailable" }, { status: 503 });
  }
  if (providerBehavior === "definite") {
    return Response.json({ message: "recipient rejected" }, { status: 422 });
  }
  if (providerBehavior === "conflict") {
    return Response.json({ name: "invalid_idempotent_request", message: "payload conflict" }, { status: 409 });
  }
  const key = new Headers(options.headers || {}).get("idempotency-key") || "";
  const payload = String(options.body || "{}");
  const accepted = acceptedByIdempotencyKey.get(key);
  if (accepted) {
    if (accepted.payload !== payload) {
      return Response.json({ name: "invalid_idempotent_request", message: "payload changed" }, { status: 409 });
    }
    return Response.json({ id: accepted.id });
  }
  const id = `abandoned-provider-${physicalDeliveries.length + 1}`;
  acceptedByIdempotencyKey.set(key, { id, payload });
  physicalDeliveries.push({ id, key, payload });
  return Response.json({ id });
};

function seedCart(id, email) {
  redis.execute(["HSET", `lm:cart:v:${id}`,
    "ts", String(Date.now()),
    "email", email,
    "services", "Netflix",
    "amount", "129",
    "locale", "en",
  ]);
  redis.execute(["ZADD", "lm:cart:index", String(Date.now()), id]);
}

function emailRequest(id) {
  return new Request("https://www.liumeiti.vip/api/admin/abandoned", {
    method: "POST",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, action: "email" }),
  });
}

function currentMarketingDayKey() {
  const day = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return `lm:mail:marketing:daily:${day}`;
}

function preparedSnapshot(id, email, now = Date.now() - 3 * 60_000) {
  return abandonedRoute.abandonedDeliveryInternals.buildAbandonedAttemptSnapshot({
    id,
    to: email,
    subject: `Recovery ${id}`,
    text: `Resume ${id}`,
    html: `<html><body><a href="/checkout">Resume ${id}</a></body></html>`,
    fromName: "Test Brand",
    support: {},
    locale: "en",
    now,
  });
}

function seedAttemptSnapshot(snapshot) {
  redis.values.set(
    abandonedRoute.abandonedDeliveryInternals.abandonedAttemptKey(snapshot.cartId),
    JSON.stringify(snapshot),
  );
}

function seedStaleSending(snapshot, ageMs = 2 * 60_000) {
  const key = deliveryModule.deliveryInternals.deliveryKey(snapshot.deliveryId);
  const score = Date.now() - ageMs;
  redis.values.set(key, JSON.stringify({
    status: "sending",
    token: "a".repeat(36),
    at: new Date(score).toISOString(),
    score,
    storageKey: key,
    recoveryTag: snapshot.recoveryTag,
  }));
  if (!redis.sortedSets.has(deliveryModule.deliveryInternals.DELIVERY_SENDING_INDEX)) {
    redis.sortedSets.set(deliveryModule.deliveryInternals.DELIVERY_SENDING_INDEX, new Map());
  }
  redis.sortedSets.get(deliveryModule.deliveryInternals.DELIVERY_SENDING_INDEX).set(key, score);
  return key;
}

test("a suppressed abandoned-cart email remains in the queue across retries", async () => {
  const id = "aa000001";
  const email = "abandoned-suppressed@example.com";
  seedCart(id, email);
  await preferences.suppressMailAddress({ email, scope: "marketing", reason: "marketing_unsubscribed", source: "test" });
  const callsBefore = providerRequests.length;
  const dailyKey = currentMarketingDayKey();
  const dailyBefore = redis.values.get(dailyKey) ?? null;

  const first = await abandonedRoute.POST(emailRequest(id));
  assert.equal(first.status, 502);
  assert.equal((await first.json()).error, "marketing_unsubscribed");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));

  const retry = await abandonedRoute.POST(emailRequest(id));
  assert.equal(retry.status, 502);
  assert.equal((await retry.json()).error, "marketing_unsubscribed");
  assert.equal(providerRequests.length, callsBefore);
  assert.equal(redis.values.get(dailyKey) ?? null, dailyBefore, "suppression must not consume the shared daily quota");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"), "suppression must never be mistaken for a delivered idempotent retry");
});

test("a successful delivery followed by cart cleanup failure retries cleanup without sending twice", async () => {
  const id = "aa000002";
  seedCart(id, "abandoned-success@example.com");
  providerBehavior = "ok";
  const callsBefore = providerRequests.length;
  redis.failNextCommand("DEL", `lm:cart:v:${id}`);

  const first = await abandonedRoute.POST(emailRequest(id));
  const firstBody = await first.json();
  assert.equal(first.status, 503);
  assert.equal(firstBody.sent, true);
  assert.equal(providerRequests.length, callsBefore + 1);
  assert.match(providerRequests.at(-1).headers.get("idempotency-key") || "", new RegExp(`^abandoned:${id}:email:[a-f0-9]{36}$`));
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));

  const retry = await abandonedRoute.POST(emailRequest(id));
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.removed, true);
  assert.equal(providerRequests.length, callsBefore + 1, "the durable delivery journal must absorb the retry");
  assert.equal(redis.hashes.has(`lm:cart:v:${id}`), false);
  assert.doesNotMatch(JSON.stringify(retryBody), /@example\.com/);
});

test("an uncertain abandoned-cart provider result is retained and not automatically resent", async () => {
  const id = "aa000003";
  seedCart(id, "abandoned-uncertain@example.com");
  providerBehavior = "uncertain";
  const callsBefore = providerRequests.length;

  const first = await abandonedRoute.POST(emailRequest(id));
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, "delivery_result_uncertain");
  assert.equal(providerRequests.length, callsBefore + 2, "Resend performs its bounded two attempts");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));

  const retry = await abandonedRoute.POST(emailRequest(id));
  assert.equal(retry.status, 503);
  assert.equal((await retry.json()).error, "delivery_result_uncertain");
  assert.equal(providerRequests.length, callsBefore + 2, "uncertain work must be recovered deliberately, not blindly resent");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));
  providerBehavior = "ok";
});

test("abandoned-cart marketing cannot bypass the shared Beijing-day limit", async () => {
  const id = "aa000004";
  seedCart(id, "abandoned-daily-limit@example.com");
  const dailyKey = currentMarketingDayKey();
  redis.values.set(dailyKey, "50");
  const callsBefore = providerRequests.length;

  const response = await abandonedRoute.POST(emailRequest(id));
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.error, "marketing_daily_limit");
  assert.equal(providerRequests.length, callsBefore);
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));
  redis.values.delete(dailyKey);
});

test("the fiftieth shared marketing reservation sends once and closes the day", async () => {
  const id = "aa000005";
  seedCart(id, "abandoned-fiftieth@example.com");
  const dailyKey = currentMarketingDayKey();
  redis.values.set(dailyKey, "49");
  const callsBefore = providerRequests.length;
  providerBehavior = "ok";

  const response = await abandonedRoute.POST(emailRequest(id));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, true);
  assert.equal(providerRequests.length, callsBefore + 1);
  assert.equal(redis.values.get(dailyKey), "50");
  redis.values.delete(dailyKey);
});

test("a crash after the journal claim but before the callback resumes from the durable snapshot", async () => {
  const id = "aa000006";
  const email = "abandoned-before-callback@example.com";
  seedCart(id, email);
  const snapshot = preparedSnapshot(id, email);
  seedAttemptSnapshot(snapshot);
  seedStaleSending(snapshot);
  const physicalBefore = physicalDeliveries.length;

  const response = await abandonedRoute.POST(emailRequest(id));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, true);
  assert.equal(physicalDeliveries.length, physicalBefore + 1);
  assert.equal(JSON.parse(redis.values.get(deliveryModule.deliveryInternals.deliveryKey(snapshot.deliveryId))).status, "done");
  redis.values.delete(currentMarketingDayKey());
});

test("a crash after quota reservation but before Resend reuses the reservation and sends once", async () => {
  const id = "aa000007";
  const email = "abandoned-after-budget@example.com";
  seedCart(id, email);
  const snapshot = preparedSnapshot(id, email);
  seedAttemptSnapshot(snapshot);
  seedStaleSending(snapshot);
  const dailyKey = currentMarketingDayKey();
  redis.values.delete(dailyKey);
  const reservation = await marketingQueue.reserveMarketingSendBudget({
    reservationId: `${snapshot.idempotencyKey}:${new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "")}`,
    now: Date.now(),
  });
  assert.equal(reservation.ok, true);
  const reservedCount = redis.values.get(dailyKey);
  const physicalBefore = physicalDeliveries.length;

  const response = await abandonedRoute.POST(emailRequest(id));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, true);
  assert.equal(redis.values.get(dailyKey), reservedCount, "crash recovery must not charge the same budget twice");
  assert.equal(physicalDeliveries.length, physicalBefore + 1);
  redis.values.delete(dailyKey);
});

test("a crash after Resend acceptance replays byte-identical payload inside 22h without a second physical email", async () => {
  const id = "aa000008";
  seedCart(id, "abandoned-after-provider@example.com");
  providerBehavior = "ok";
  const requestBefore = providerRequests.length;
  const physicalBefore = physicalDeliveries.length;
  redis.failNextEvalContaining("delivery_invalid_completion");

  const interrupted = await abandonedRoute.POST(emailRequest(id));
  assert.equal(interrupted.status, 503);
  assert.equal((await interrupted.json()).error, "delivery_result_uncertain");
  assert.equal(physicalDeliveries.length, physicalBefore + 1);
  const firstProviderRequest = providerRequests[requestBefore];
  const snapshotRaw = redis.values.get(abandonedRoute.abandonedDeliveryInternals.abandonedAttemptKey(id));
  const snapshot = JSON.parse(snapshotRaw);
  assert.equal(snapshot.phase, "provider_started");
  assert.ok(Date.parse(snapshot.resendIdempotencyDeadlineAt) - Date.parse(snapshot.providerAttemptStartedAt)
    === abandonedRoute.abandonedDeliveryInternals.RESEND_RECOVERY_MS);

  const journalKey = deliveryModule.deliveryInternals.deliveryKey(snapshot.deliveryId);
  const journal = JSON.parse(redis.values.get(journalKey));
  const staleScore = Date.now() - 2 * 60_000;
  redis.values.set(journalKey, JSON.stringify({ ...journal, score: staleScore, at: new Date(staleScore).toISOString() }));
  redis.sortedSets.get(deliveryModule.deliveryInternals.DELIVERY_SENDING_INDEX).set(journalKey, staleScore);

  const recovered = await abandonedRoute.POST(emailRequest(id));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).removed, true);
  assert.equal(providerRequests.length, requestBefore + 2, "recovery asks Resend for the same idempotent result");
  assert.equal(physicalDeliveries.length, physicalBefore + 1, "Resend must accept only one physical email");
  const replayRequest = providerRequests[requestBefore + 1];
  assert.equal(replayRequest.headers.get("idempotency-key"), firstProviderRequest.headers.get("idempotency-key"));
  assert.deepEqual(replayRequest.body, firstProviderRequest.body, "provider payload must remain byte-equivalent after recovery");
  redis.values.delete(currentMarketingDayKey());
});

test("an abandoned provider-start crash older than the 22h Resend window fails safe", async () => {
  const id = "aa000009";
  const email = "abandoned-expired-recovery@example.com";
  seedCart(id, email);
  const startedMs = Date.now() - 23 * 60 * 60 * 1000;
  const prepared = preparedSnapshot(id, email, startedMs - 1000);
  const snapshot = {
    ...prepared,
    phase: "provider_started",
    providerAttemptStartedAt: new Date(startedMs).toISOString(),
    resendIdempotencyDeadlineAt: new Date(startedMs + abandonedRoute.abandonedDeliveryInternals.RESEND_RECOVERY_MS).toISOString(),
  };
  seedAttemptSnapshot(snapshot);
  seedStaleSending(snapshot);
  const requestsBefore = providerRequests.length;
  const physicalBefore = physicalDeliveries.length;

  const response = await abandonedRoute.POST(emailRequest(id));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "delivery_result_uncertain");
  assert.equal(providerRequests.length, requestsBefore);
  assert.equal(physicalDeliveries.length, physicalBefore);
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));
});

test("a durable definite provider rejection can rotate to a new attempt after 22h", async () => {
  const id = "aa000010";
  seedCart(id, "abandoned-definite-retry@example.com");
  providerBehavior = "definite";
  const first = await abandonedRoute.POST(emailRequest(id));
  assert.equal(first.status, 502);
  const attemptKey = abandonedRoute.abandonedDeliveryInternals.abandonedAttemptKey(id);
  const failed = JSON.parse(redis.values.get(attemptKey));
  assert.equal(failed.phase, "definite_failure");
  const oldStarted = Date.now() - 23 * 60 * 60 * 1000;
  redis.values.set(attemptKey, JSON.stringify({
    ...failed,
    createdAt: new Date(oldStarted - 1000).toISOString(),
    providerAttemptStartedAt: new Date(oldStarted).toISOString(),
    resendIdempotencyDeadlineAt: new Date(oldStarted + abandonedRoute.abandonedDeliveryInternals.RESEND_RECOVERY_MS).toISOString(),
    providerFailedAt: new Date(oldStarted + 1000).toISOString(),
  }));
  const firstKey = failed.idempotencyKey;
  providerBehavior = "ok";

  const retry = await abandonedRoute.POST(emailRequest(id));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).removed, true);
  assert.notEqual(providerRequests.at(-1).headers.get("idempotency-key"), firstKey);
  redis.values.delete(currentMarketingDayKey());
});

test("a Resend idempotency conflict is quarantined and never retried with a new key", async () => {
  const id = "aa000011";
  seedCart(id, "abandoned-conflict@example.com");
  providerBehavior = "conflict";
  const before = providerRequests.length;

  const first = await abandonedRoute.POST(emailRequest(id));
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, "delivery_result_uncertain");
  assert.equal(providerRequests.length, before + 1);
  providerBehavior = "ok";
  const retry = await abandonedRoute.POST(emailRequest(id));
  assert.equal(retry.status, 503);
  assert.equal((await retry.json()).error, "delivery_result_uncertain");
  assert.equal(providerRequests.length, before + 1, "conflict must not rotate to a new provider key");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));
  redis.values.delete(currentMarketingDayKey());
});
