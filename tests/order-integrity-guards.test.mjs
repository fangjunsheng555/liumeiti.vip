import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://order-integrity.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const { orderArchiveEligibility } = await import("../app/api/_utils.js");

function invalidOrder(overrides = {}) {
  return {
    orderId: "LMARCHIVE1",
    status: "invalid",
    items: [{ service: "spotify", plan: "member", stockReserved: false, aiStockReserved: false }],
    ...overrides,
  };
}

test("orders can be archived once their side effects are settled, whatever the status", () => {
  // Status is not a gate: an operator must be able to remove a finished order
  // without first voiding it, which would rewrite delivery history.
  assert.equal(orderArchiveEligibility({ ...invalidOrder(), status: "received" }).ok, true);
  assert.equal(orderArchiveEligibility({ ...invalidOrder(), status: "completed" }).ok, true);
  assert.equal(orderArchiveEligibility({ ...invalidOrder(), status: "pending" }).ok, true);
  // Every open side effect still blocks the archive with a precise reason.
  assert.equal(orderArchiveEligibility({ ...invalidOrder(), status: "completed", paidByBalance: true, finalAmount: 20 }).error, "order_financial_effects_open");
  assert.equal(orderArchiveEligibility({ ...invalidOrder(), status: "completed", items: [{ service: "spotify", stockReserved: true }] }).error, "order_stock_effect_open");
  assert.equal(orderArchiveEligibility(invalidOrder({ paidByBalance: true, finalAmount: 20 })).error, "order_financial_effects_open");
  assert.equal(orderArchiveEligibility(invalidOrder({ couponId: "COUPON1" })).error, "order_financial_effects_open");
  assert.equal(orderArchiveEligibility(invalidOrder({ referralCommissionSettledAt: new Date().toISOString() })).error, "order_commission_effect_open");
  assert.equal(orderArchiveEligibility(invalidOrder({ items: [{ service: "spotify", stockReserved: true }] })).error, "order_stock_effect_open");
  assert.equal(orderArchiveEligibility(invalidOrder({ pendingTransition: { id: "transition" } })).error, "order_transition_pending");
  assert.equal(orderArchiveEligibility(invalidOrder({ paidByBalance: true, refundedAt: new Date().toISOString() })).ok, true);
});

test("order writers use canonical locks, Lua CAS, durable transitions and full-record archive", async () => {
  const [utils, single, batch, quote, expiry, transition] = await Promise.all([
    readFile(new URL("../app/api/_utils.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/orders/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/orders/batch/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/quote-orders/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_quote-expiry.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_order-transition.js", import.meta.url), "utf8"),
  ]);
  assert.match(utils, /SET_ORDER_AT_SCRIPT/);
  assert.match(utils, /current~=ARGV\[1\]/);
  assert.match(utils, /completeTransitionId/);
  assert.match(utils, /archiveOrderAt/);
  assert.match(utils, /\.\.\.order,[\s\S]*deleted: true,[\s\S]*archived: true/);
  assert.doesNotMatch(single, /order-delete-stock:/);
  assert.doesNotMatch(batch, /order-delete-stock:/);
  for (const source of [single, batch, quote, expiry]) assert.match(source, /lm:order:update-lock:/);
  assert.match(single, /normalizedOrderId\(orderId\)/);
  assert.match(batch, /toUpperCase\(\)/);
  assert.match(quote, /normalizeOrderId/);
  assert.match(expiry, /normalizeQuoteOrderId/);
  assert.match(transition, /pendingTransition/);
  assert.match(transition, /adjustStockBatchEffectAtomic/);
  assert.match(transition, /resumePendingOrderTransition/);
});
