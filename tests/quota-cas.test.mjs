import assert from "node:assert/strict";
import test from "node:test";

process.env.KV_REST_API_URL = "https://redis.quota-cas.test";
process.env.KV_REST_API_TOKEN = "test-token";

const quota = await import("../app/api/tool/_quota.js");

class QuotaRedis {
  constructor() {
    this.values = new Map();
    this.holdReads = 0;
    this.waitingReads = [];
    this.unavailable = false;
  }

  holdNextReads(count) {
    this.holdReads = count;
  }

  async maybeHoldRead(result) {
    if (this.holdReads <= 0) return result;
    return new Promise((resolve) => {
      this.waitingReads.push(() => resolve(result));
      if (this.waitingReads.length === this.holdReads) {
        const waiting = this.waitingReads.splice(0);
        this.holdReads = 0;
        for (const release of waiting) release();
      }
    });
  }

  fetch = async (input) => {
    if (this.unavailable) return new Response("unavailable", { status: 503 });
    const parts = new URL(String(input)).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    assert.equal(parts[0], "EVAL");
    const script = parts[1];
    const keyCount = Number(parts[2]);
    const keys = parts.slice(3, 3 + keyCount);
    const args = parts.slice(3 + keyCount);

    if (script.includes("exists=true,raw=raw")) {
      const raw = this.values.get(keys[0]);
      const result = JSON.stringify(raw == null
        ? { ok: true, exists: false }
        : { ok: true, exists: true, raw });
      return Response.json({ result: await this.maybeHoldRead(result) });
    }

    if (script.includes("session_state_changed")) {
      const userRaw = this.values.get(keys[1]);
      const user = userRaw ? JSON.parse(userRaw) : null;
      const currentVersion = Number(this.values.get(keys[2]) || 1);
      if (!user || user.banned || currentVersion !== Number(args[3])) {
        return Response.json({ result: JSON.stringify({ ok: false, error: "session_state_changed" }) });
      }
    }

    const current = this.values.get(keys[0]);
    const matches = args[0] === "0" ? current == null : current != null && current === args[1];
    if (!matches) return Response.json({ result: JSON.stringify({ ok: false, error: "conflict" }) });
    this.values.set(keys[0], args[2]);
    return Response.json({ result: JSON.stringify({ ok: true }) });
  };
}

async function withRedis(redis, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = redis.fetch;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

test("user request and admin override CAS preserve both concurrent mutations", async () => {
  const redis = new QuotaRedis();
  redis.values.set("liumeiti:users:user@example.com", JSON.stringify({ email: "user@example.com", banned: false }));
  redis.values.set("lm:user:authver:user@example.com", "4");
  redis.holdNextReads(2);

  await withRedis(redis, async () => {
    const [requestResult, overrideResult] = await Promise.all([
      quota.createQuotaRequest({
        email: "user@example.com",
        type: "chat",
        requested: 25,
        authVersion: 4,
        id: "QR-CONCURRENT-1",
        now: 100,
      }),
      quota.setQuotaOverride({ type: "image", email: "other@example.com", daily: 9, ts: 101 }),
    ]);
    assert.equal(requestResult.ok, true);
    assert.equal(overrideResult.ok, true);

    const state = await quota.readQuotaState();
    assert.equal(state.ok, true);
    assert.deepEqual(state.data.requests.map((entry) => entry.id), ["QR-CONCURRENT-1"]);
    assert.deepEqual(state.data.overrides.map((entry) => `${entry.type}:${entry.email}`), ["image:other@example.com"]);
  });
});

test("quota reads fail closed on outage and stale user writes cannot resurrect state", async () => {
  const redis = new QuotaRedis();
  redis.values.set("liumeiti:users:user@example.com", JSON.stringify({ email: "user@example.com", banned: false }));
  redis.values.set("lm:user:authver:user@example.com", "8");

  await withRedis(redis, async () => {
    const stale = await quota.createQuotaRequest({
      email: "user@example.com",
      type: "chat",
      requested: 5,
      authVersion: 7,
      id: "QR-STALE-1",
    });
    assert.equal(stale.error, "session_state_changed");
    assert.equal(redis.values.has(quota.quotaInternals.KEY), false);

    redis.unavailable = true;
    const state = await quota.readQuotaState();
    const override = await quota.getOverrideState("chat", "user@example.com");
    assert.equal(state.ok, false);
    assert.equal(state.error, "quota_store_unavailable");
    assert.equal(override.ok, false);
  });
});
