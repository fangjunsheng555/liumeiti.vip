import test from "node:test";
import assert from "node:assert/strict";

// 这些守卫此前在存储异常时把用户完全挡在门外。用例覆盖真实的失败形态：
// 脚本返回对象、返回垃圾、抛错、超时。
const ORIGINAL_ENV = { ...process.env };

async function loadUtils(redisImpl) {
  process.env.KV_REST_API_URL = "https://rate-limit.test";
  process.env.KV_REST_API_TOKEN = "token-for-rate-limit-tests";
  process.env.AUTH_SECRET = "rate-limit-test-secret-value-32-characters";
  const utils = await import(`../app/api/_utils.js?rate=${Math.random()}`);
  utils.resetSoftRateLimitCounters();
  globalThis.fetch = redisImpl;
  return utils;
}

function request(ip = "203.0.113.10") {
  return new Request("https://www.liumeiti.vip/api/auth/login", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "user-agent": "probe/1.0" },
  });
}

function restReply(body) {
  return async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("限流脚本返回已解析对象时仍能正常放行", async () => {
  const utils = await loadUtils(restReply({
    result: { ok: true, identityCount: 1, ipCount: 1, identityTtl: 600, ipTtl: 600, repaired: 0 },
  }));
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.notEqual(guard.degraded, true);
});

test("限流存储抛错时放行而不是 503", async () => {
  const utils = await loadUtils(async () => { throw new Error("network down"); });
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.degraded, true);
  assert.notEqual(guard.unavailable, true);
});

test("限流存储返回垃圾内容时放行", async () => {
  const utils = await loadUtils(restReply({ result: "not-json-at-all" }));
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.degraded, true);
});

test("限流存储超时后依然放行", async () => {
  const utils = await loadUtils(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw Object.assign(new Error("timeout"), { name: "AbortError" });
  });
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.degraded, true);
});

test("存储不可用时进程内软限流仍会挡住暴力尝试", async () => {
  const utils = await loadUtils(async () => { throw new Error("network down"); });
  const options = {
    namespace: "auth:login", identity: "victim@example.com", identityLimit: 3, ipLimit: 80, windowSec: 600,
  };
  const results = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    results.push(await utils.checkCriticalRateLimit(request(), options));
  }
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false]);
  assert.equal(results[3].degraded, true);
  assert.ok(results[3].retryAfter > 0);
});

test("守卫配置写错时记录错误但不拖垮登录", async () => {
  const utils = await loadUtils(restReply({ result: JSON.stringify({ ok: false, error: "rate_limit_config_invalid" }) }));
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.degraded, true);
  assert.notEqual(guard.unavailable, true);
});

test("完全没配置存储时保持 fail-closed（部署错误必须暴露）", async () => {
  const utils = await loadUtils(async () => { throw new Error("unused"); });
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const guard = await utils.checkCriticalRateLimit(request(), {
    namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.unavailable, true);
  assert.equal(guard.status, 503);
});

test("脚本返回数组、数字、null 等异常形态都按存储不可用降级处理", async () => {
  for (const shape of [null, 42, ["ok"], { unexpected: true }, { result: null }]) {
    const utils = await loadUtils(restReply({ result: shape }));
    const guard = await utils.checkCriticalRateLimit(request(), {
      namespace: "auth:login", identity: "user@example.com", identityLimit: 8, ipLimit: 80, windowSec: 600,
    });
    assert.equal(guard.ok, true, `形态 ${JSON.stringify(shape)} 应放行: ${JSON.stringify(guard)}`);
    assert.equal(guard.degraded, true);
  }
});

test("软限流计数窗口到期后自动放行", async () => {
  const utils = await loadUtils(async () => { throw new Error("network down"); });
  const options = {
    namespace: "auth:login", identity: "window@example.com", identityLimit: 1, ipLimit: 80, windowSec: 1,
  };
  assert.equal((await utils.checkCriticalRateLimit(request(), options)).ok, true);
  assert.equal((await utils.checkCriticalRateLimit(request(), options)).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await utils.checkCriticalRateLimit(request(), options)).ok, true);
});

test("大量不同身份不会让软限流表无限增长", async () => {
  const utils = await loadUtils(async () => { throw new Error("network down"); });
  for (let index = 0; index < 6000; index += 1) {
    const guard = await utils.checkCriticalRateLimit(request(`198.51.100.${index % 250}`), {
      namespace: "auth:login",
      identity: `bulk-${index}@example.com`,
      identityLimit: 8,
      ipLimit: 100000,
      windowSec: 600,
    });
    assert.equal(guard.ok, true);
  }
  // 表被裁剪后，仍要能正确拦住持续攻击同一身份的请求
  const options = {
    namespace: "auth:login", identity: "after-prune@example.com", identityLimit: 2, ipLimit: 100000, windowSec: 600,
  };
  const burst = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    burst.push((await utils.checkCriticalRateLimit(request("198.51.100.251"), options)).ok);
  }
  assert.deepEqual(burst, [true, true, false, false]);
});

test("软限流不会因为不同身份互相影响", async () => {
  const utils = await loadUtils(async () => { throw new Error("network down"); });
  const base = { namespace: "auth:login", identityLimit: 1, ipLimit: 80, windowSec: 600 };
  const first = await utils.checkCriticalRateLimit(request("198.51.100.7"), { ...base, identity: "a@example.com" });
  const second = await utils.checkCriticalRateLimit(request("198.51.100.8"), { ...base, identity: "b@example.com" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});
