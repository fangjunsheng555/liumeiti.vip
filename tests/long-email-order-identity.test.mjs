import assert from "node:assert/strict";
import test from "node:test";
import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "long-email-order-identity-secret-32";
process.env.KV_REST_API_URL = "http://long-email-order.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.SITE_URL = "https://www.liumeiti.vip";

const redis = installMarketingRedisMock("http://long-email-order.redis.test");
const auth = await import("../app/api/_auth-session.js");
const orderRoute = await import("../app/api/order/route.js");
const quoteRoute = await import("../app/api/quote-orders/route.js");

test("a 201-character authenticated identity survives both real order request contracts", async () => {
  const email = `${"a".repeat(189)}@example.com`;
  const lifecycle = "b".repeat(32);
  assert.equal(email.length, 201);
  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "long-owner", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, lifecycle]);
  const token = auth.signUserSessionForVersion(email, 1);
  const headers = {
    cookie: `lm_user=${encodeURIComponent(token)}`,
    "content-type": "application/json",
    "idempotency-key": "long-email-identity-probe",
    "x-order-expected-account": email,
    "x-operation-expected-lifecycle": lifecycle,
  };

  const requests = [
    orderRoute.POST(new Request("https://www.liumeiti.vip/api/order", {
      method: "POST", headers,
      body: JSON.stringify({
        email: "delivery@example.com", expectedAccountEmail: email, expectedAccountLifecycleId: lifecycle,
        items: [{ service: "identity-probe-invalid-service" }], paymentMethod: "alipay",
      }),
    })),
    quoteRoute.POST(new Request("https://www.liumeiti.vip/api/quote-orders", {
      method: "POST", headers: { ...headers, "idempotency-key": "long-email-quote-identity-probe" },
      body: JSON.stringify({
        email: "delivery@example.com", expectedAccountEmail: email, expectedAccountLifecycleId: lifecycle,
        platformUrl: "", productPrice: "", contact: "",
      }),
    })),
  ];
  for (const response of await Promise.all(requests)) {
    const body = await response.json();
    assert.notEqual(body.error, "operation_identity_changed");
    assert.notEqual(body.error, "operation_identity_mismatch");
    assert.notEqual(body.error, "invalid_expected_account");
  }
});

test("real order request contracts reject control characters in delivery and expected account emails", async () => {
  const routeCases = [
    [orderRoute, { items: [{ service: "invalid-service" }], paymentMethod: "alipay" }],
    [quoteRoute, { platformUrl: "", productPrice: "", contact: "" }],
  ];
  for (const [route, baseBody] of routeCases) {
    const deliveryResponse = await route.POST(new Request("https://www.liumeiti.vip/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `control-delivery-${route === orderRoute ? "order" : "quote"}` },
      body: JSON.stringify({ ...baseBody, email: "buyer\u0000@example.com" }),
    }));
    assert.equal(deliveryResponse.status, 400);
    assert.equal((await deliveryResponse.json()).error, "invalid_email");

    const identityResponse = await route.POST(new Request("https://www.liumeiti.vip/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `control-identity-${route === orderRoute ? "order" : "quote"}` },
      body: JSON.stringify({ ...baseBody, email: "buyer@example.com", expectedAccountEmail: "owner\u007f@example.com" }),
    }));
    assert.equal(identityResponse.status, 400);
    assert.equal((await identityResponse.json()).error, "invalid_expected_account");
  }
});

test("final convergence B: five adverse legacy email shapes cross real order HTTP contracts", async (t) => {
  const routes = [
    ["order", orderRoute, { items: [{ service: "invalid-service" }], paymentMethod: "alipay" }],
    ["quote", quoteRoute, { platformUrl: "", productPrice: "", contact: "" }],
  ];
  const send = (name, route, body, key) => route.POST(new Request(`https://www.liumeiti.vip/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  }));

  await t.test("exactly 254 characters survives validation", async () => {
    const email = `${"a".repeat(242)}@example.com`;
    assert.equal(email.length, 254);
    for (const [name, route, baseBody] of routes) {
      const body = await (await send(name, route, { ...baseBody, email }, `final-b-254-${name}`)).json();
      assert.notEqual(body.error, "invalid_email");
    }
  });
  await t.test("255 characters is rejected", async () => {
    const email = `${"a".repeat(243)}@example.com`;
    for (const [name, route, baseBody] of routes) {
      const response = await send(name, route, { ...baseBody, email }, `final-b-255-${name}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_email");
    }
  });
  await t.test("unit-separator control character is rejected", async () => {
    for (const [name, route, baseBody] of routes) {
      const response = await send(name, route, { ...baseBody, email: "buyer\u001f@example.com" }, `final-b-control-${name}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_email");
    }
  });
  await t.test("object expected identity is rejected", async () => {
    for (const [name, route, baseBody] of routes) {
      const response = await send(name, route, { ...baseBody, email: "buyer@example.com", expectedAccountEmail: {} }, `final-b-object-${name}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_expected_account");
    }
  });
  await t.test("legacy null expected identity stays a guest request", async () => {
    for (const [name, route, baseBody] of routes) {
      const response = await send(name, route, { ...baseBody, email: "buyer@example.com", expectedAccountEmail: null }, `final-b-null-${name}`);
      const body = await response.json();
      assert.notEqual(body.error, "invalid_expected_account");
      assert.notEqual(body.error, "operation_identity_auth_required");
      assert.notEqual(body.error, "operation_identity_changed");
    }
  });
});
