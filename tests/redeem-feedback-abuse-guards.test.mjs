import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

process.env.AUTH_SECRET = "redeem-feedback-guard-test-secret-0123456789";
process.env.KV_REST_API_URL = "https://redis.redeem-feedback-guard.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");
const redeemCodeRoute = await import("../app/api/redeem-code/route.js");
const feedbackRoute = await import("../app/api/tool/feedback/route.js");

const CODE_PREFIX = "liumeiti:redeem-code:";

class RedeemGuardRedis {
  constructor() {
    this.values = new Map();
    this.ttls = new Map();
    this.failPipeline = false;
    this.failPipelineOnCall = 0;
    this.pipelineCalls = 0;
  }

  command(command) {
    const [rawName, key, value] = command;
    const name = String(rawName || "").toUpperCase();
    if (name === "GET") return this.values.get(key) ?? null;
    if (name === "TTL") return this.values.has(key) ? (this.ttls.get(key) ?? -1) : -2;
    if (name === "PING") return "PONG";
    if (name === "INCR") {
      const count = Number(this.values.get(key) || 0) + 1;
      this.values.set(key, String(count));
      return count;
    }
    if (name === "EXPIRE") {
      if (!this.values.has(key)) return 0;
      this.ttls.set(key, Number(value));
      return 1;
    }
    if (name === "DEL") {
      const existed = this.values.delete(key);
      this.ttls.delete(key);
      return existed ? 1 : 0;
    }
    throw new Error(`unsupported Redis command: ${name}`);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      this.pipelineCalls += 1;
      if (this.failPipeline || this.pipelineCalls === this.failPipelineOnCall) {
        return new Response("pipeline failed", { status: 502 });
      }
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({ result: this.command(command) })));
    }
    const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return Response.json({ result: this.command(command) });
  };
}

async function withFetch(fetchImpl, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

function requestWithAgent(userAgent) {
  return new Request("https://www.liumeiti.vip/api/redeem-code?code=NOPE", {
    headers: { "x-forwarded-for": "203.0.113.44", "user-agent": userAgent },
  });
}

test("redeem failures share one IP bucket when User-Agent changes", async () => {
  const redis = new RedeemGuardRedis();
  await withFetch(redis.fetch, async () => {
    const keys = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const guard = await utils.checkRedeemRateLimit(requestWithAgent(`rotating-agent-${attempt}`));
      assert.equal(guard.ok, true);
      keys.push(guard.key);
      const recorded = await utils.recordRedeemRateFailure(guard);
      assert.equal(recorded.ok, true);
      assert.equal(recorded.count, attempt + 1);
    }
    assert.equal(new Set(keys).size, 1);

    const blocked = await utils.checkRedeemRateLimit(requestWithAgent("brand-new-agent"));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.unavailable, undefined);
    assert.equal(blocked.limit, 5);
    assert.equal(blocked.retryAfter, 300);
  });
});

test("redeem and feedback routes fail closed when Redis is missing or errors", async () => {
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    const guard = await utils.checkRedeemRateLimit(requestWithAgent("missing-config"));
    assert.equal(guard.ok, false);
    assert.equal(guard.unavailable, true);
    assert.equal(guard.status, 503);

    const response = await redeemCodeRoute.GET(requestWithAgent("missing-config-route"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "rate_limit_unavailable");

    const feedback = await feedbackRoute.POST(new Request("https://www.liumeiti.vip/api/tool/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.45" },
      body: JSON.stringify({ email: "visitor@example.com", content: "page feedback" }),
    }));
    assert.equal(feedback.status, 503);
    assert.equal((await feedback.json()).error, "rate_limit_unavailable");
  } finally {
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }

  const redis = new RedeemGuardRedis();
  redis.failPipeline = true;
  await withFetch(redis.fetch, async () => {
    const guard = await utils.checkRedeemRateLimit(requestWithAgent("pipeline-error"));
    assert.equal(guard.ok, false);
    assert.equal(guard.unavailable, true);
    assert.equal(guard.status, 503);
  });

  const writeFailureRedis = new RedeemGuardRedis();
  writeFailureRedis.failPipelineOnCall = 2;
  await withFetch(writeFailureRedis.fetch, async () => {
    const response = await redeemCodeRoute.GET(requestWithAgent("write-error"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "rate_limit_unavailable");
  });
});

test("legacy short redeem codes remain readable and usable but cannot be newly created", async () => {
  const redis = new RedeemGuardRedis();
  redis.values.set(`${CODE_PREFIX}ABCD`, JSON.stringify({
    code: "ABCD",
    type: "service",
    status: "active",
    services: [{ key: "netflix" }],
    createdAt: "2024-01-01T00:00:00.000Z",
  }));

  await withFetch(redis.fetch, async () => {
    const publicCode = await utils.getRedeemCodePublic("ABCD");
    assert.equal(publicCode.ok, true);
    assert.equal(publicCode.code, "ABCD");

    const validation = await utils.validateServiceRedeemCode("ABCD", [{ key: "netflix" }]);
    assert.equal(validation.ok, true);
    assert.equal(validation.code, "ABCD");

    const creation = await utils.createRedeemCode(
      { customCode: "ABCD", type: "balance", amount: 5 },
      { staffId: 1, staffUsername: "admin" },
      { operationId: "legacy-short-code-create-001" },
    );
    assert.deepEqual(creation, { ok: false, error: "invalid_custom_code" });
  });

  const adminSource = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(adminSource, /invalid_custom_code:\s*"自定义代码需为12-40位字母或数字"/);
  assert.match(adminSource, /minLength=\{12\}[\s\S]{0,80}maxLength=\{40\}/);
});

test("feedback route uses the fail-closed identity and IP guard without User-Agent", async () => {
  const source = await readFile(new URL("../app/api/tool/feedback/route.js", import.meta.url), "utf8");
  assert.match(source, /checkCriticalRateLimit\(request/);
  assert.match(source, /identity:\s*email \|\| clientIpFromRequest\(request\)/);
  assert.match(source, /identityLimit:\s*5/);
  assert.match(source, /ipLimit:\s*5/);
  assert.doesNotMatch(source.slice(source.indexOf("checkCriticalRateLimit(request"), source.indexOf("if (!guard.ok)")), /user-agent|clientUserAgent/);
});

test("all redeem entry points map unavailable guard reads and writes to the shared 503 response", async () => {
  for (const relativePath of [
    "../app/api/redeem-code/route.js",
    "../app/api/auth/redeem/route.js",
    "../app/api/order/route.js",
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /\.unavailable\) return rateLimitResponse\(/, relativePath);
    assert.match(source, /const recorded = await recordRedeemRateFailure\(/, relativePath);
    assert.match(source, /if \(!recorded\.ok\) return rateLimitResponse\(recorded\)/, relativePath);
  }
});
