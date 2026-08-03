import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "stock-validation-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://stock-validation.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const { normalizeStockValue } = await import("../app/api/_stock-input.js");

test("admin stock accepts only unlimited or bounded non-negative safe integers", () => {
  assert.deepEqual(normalizeStockValue(""), { ok: true, value: "" });
  assert.deepEqual(normalizeStockValue(null), { ok: true, value: "" });
  assert.deepEqual(normalizeStockValue("unlimited"), { ok: true, value: "" });
  assert.deepEqual(normalizeStockValue("00012"), { ok: true, value: 12 });
  assert.deepEqual(normalizeStockValue(0), { ok: true, value: 0 });
  assert.deepEqual(normalizeStockValue(1_000_000_000), { ok: true, value: 1_000_000_000 });

  for (const value of [" ", "1.9", 1.9, -1, "-1", true, {}, [], "NaN", Infinity, 1_000_000_001]) {
    assert.deepEqual(normalizeStockValue(value), { ok: false }, `expected ${String(value)} to be rejected`);
  }
});
