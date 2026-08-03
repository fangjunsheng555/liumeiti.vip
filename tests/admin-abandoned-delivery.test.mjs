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

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "admin",
  exp: Date.now() + 60_000,
});

const redisFetch = globalThis.fetch;
const providerRequests = [];
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
  return Response.json({ id: `abandoned-provider-${providerRequests.length}` });
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

test("a suppressed abandoned-cart email remains in the queue across retries", async () => {
  const id = "aa000001";
  const email = "abandoned-suppressed@example.com";
  seedCart(id, email);
  await preferences.suppressMailAddress({ email, scope: "marketing", reason: "marketing_unsubscribed", source: "test" });
  const callsBefore = providerRequests.length;

  const first = await abandonedRoute.POST(emailRequest(id));
  assert.equal(first.status, 502);
  assert.equal((await first.json()).error, "send_failed");
  assert.ok(redis.hashes.get(`lm:cart:v:${id}`)?.get("ts"));

  const retry = await abandonedRoute.POST(emailRequest(id));
  assert.equal(retry.status, 502);
  assert.equal((await retry.json()).error, "send_failed");
  assert.equal(providerRequests.length, callsBefore);
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
  assert.equal(providerRequests.at(-1).headers.get("idempotency-key"), `abandoned:${id}:email`);
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
