import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "critical-auth-test-secret-0123456789abcdef";
process.env.KV_REST_API_URL = "https://redis.critical-auth.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");

class GuardRedis {
  constructor() {
    this.values = new Map();
    this.unavailable = false;
  }

  fetch = async (input) => {
    if (this.unavailable) return new Response("unavailable", { status: 503 });
    const parts = new URL(String(input)).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    assert.equal(parts[0], "EVAL");
    const script = parts[1];
    const keyCount = Number(parts[2]);
    const keys = parts.slice(3, 3 + keyCount);
    const args = parts.slice(3 + keyCount);
    if (script.includes("identityCount") && script.includes("ipCount")) {
      const identityCount = Number(this.values.get(keys[0]) || 0) + 1;
      const ipCount = Number(this.values.get(keys[1]) || 0) + 1;
      this.values.set(keys[0], String(identityCount));
      this.values.set(keys[1], String(ipCount));
      return Response.json({ result: JSON.stringify({
        ok: true,
        identityCount,
        ipCount,
        identityTtl: Number(args[0]),
        ipTtl: Number(args[0]),
      }) });
    }
    if (script.includes("return 'consumed'")) {
      if (this.values.has(keys[0])) return Response.json({ result: "used" });
      this.values.set(keys[0], "1");
      return Response.json({ result: "consumed" });
    }
    throw new Error("unsupported script");
  };
}

async function withRedis(redis, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = redis.fetch;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

test("critical rate limits cannot be bypassed by rotating User-Agent and fail closed on Redis outage", async () => {
  const redis = new GuardRedis();
  await withRedis(redis, async () => {
    const results = [];
    for (const userAgent of ["ua-one", "ua-two", "ua-three"]) {
      results.push(await utils.checkCriticalRateLimit(new Request("https://www.liumeiti.vip/api/auth/login", {
        headers: { "x-forwarded-for": "203.0.113.9", "user-agent": userAgent },
      }), {
        namespace: "test:login",
        identity: "same@example.com",
        identityLimit: 2,
        ipLimit: 20,
        windowSec: 600,
      }));
    }
    assert.deepEqual(results.map((result) => result.ok), [true, true, false]);
    assert.equal(results[2].limit, 2);

    redis.unavailable = true;
    const outage = await utils.checkCriticalRateLimit(new Request("https://www.liumeiti.vip/api/auth/login"), {
      namespace: "test:outage",
      identity: "user@example.com",
    });
    assert.equal(outage.ok, false);
    assert.equal(outage.unavailable, true);
    assert.equal(outage.status, 503);
  });
});

test("a solved registration captcha token is consumed exactly once", async () => {
  const redis = new GuardRedis();
  await withRedis(redis, async () => {
    const token = utils.signRegisterCaptcha("2468");
    const first = await utils.consumeRegisterCaptcha(token, "2468");
    const replay = await utils.consumeRegisterCaptcha(token, "2468");
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(replay, { ok: false, error: "captcha_reused" });

    redis.unavailable = true;
    const unavailable = await utils.consumeRegisterCaptcha(utils.signRegisterCaptcha("3579"), "3579");
    assert.deepEqual(unavailable, { ok: false, error: "captcha_store_unavailable" });
  });
});
