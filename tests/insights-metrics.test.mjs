import test from "node:test";
import assert from "node:assert/strict";

import {
  intersectionSize,
  isRecognizedSale,
  orderVisitorId,
  orderServiceAllocations,
  orderServiceValue,
  orderSource,
  orderValueBreakdown,
  paymentChannel,
} from "../app/api/admin/insights/metrics.js";

test("funnel cohorts use unique visitor intersections", () => {
  const viewers = new Set(["a", "b", "c"]);
  const checkoutVisitors = new Set(["b", "c", "d", "e"]);
  assert.equal(intersectionSize(viewers, checkoutVisitors), 2);
  assert.equal(intersectionSize(checkoutVisitors, viewers), 2);
  assert.equal(intersectionSize(viewers, null), 0);
});

test("orders reuse the same anonymous visitor identity as tracking", () => {
  const id = orderVisitorId({ clientIp: "203.0.113.8", userAgent: "Example Browser" });
  assert.equal(id.length, 24);
  assert.equal(id, orderVisitorId({ clientIp: "203.0.113.8", userAgent: "Example Browser" }));
  assert.equal(orderVisitorId({ clientIp: "203.0.113.8" }), "");
});

test("service-code orders use their product value instead of zero checkout total", () => {
  const order = {
    status: "received",
    paymentMethod: "redeem",
    paidCurrency: "CODE",
    finalAmount: 0,
    subtotal: 276,
    items: [
      { service: "spotify", amount: 128 },
      { service: "max", amount: 148 },
    ],
  };

  assert.equal(isRecognizedSale(order), true);
  assert.deepEqual(orderValueBreakdown(order), {
    gross: 276,
    direct: 0,
    codeEquivalent: 276,
  });
  assert.equal(paymentChannel(order), "redeem");
});

test("service-code value supports legacy order snapshots", () => {
  assert.equal(orderServiceValue({
    originalAmount: 0,
    redeemServices: [{ amount: 108 }, { amount: 168 }],
  }), 276);
  assert.equal(orderServiceValue({
    service: "spotify",
    originalAmount: 128,
  }), 128);
});

test("only confirmed direct-payment states are recognized before completion", () => {
  assert.equal(isRecognizedSale({ status: "received", paymentMethod: "alipay" }), false);
  assert.equal(isRecognizedSale({ status: "received", paymentMethod: "balance" }), true);
  assert.equal(isRecognizedSale({ status: "received", paidCurrency: "USDT", usdtConfirmedAt: "2026-07-12T00:00:00.000Z" }), true);
  assert.equal(isRecognizedSale({ status: "invalid", paymentMethod: "redeem", paidCurrency: "CODE" }), false);
  assert.equal(isRecognizedSale({ status: "completed", paymentMethod: "alipay" }), true);
});

test("multi-service orders allocate net value once instead of duplicating it per service", () => {
  const allocations = orderServiceAllocations({
    status: "completed",
    paymentMethod: "alipay",
    finalAmount: 270,
    items: [
      { service: "spotify", amount: 100 },
      { service: "netflix", amount: 200 },
    ],
  });

  assert.deepEqual(allocations, [
    { service: "spotify", gross: 90, direct: 90, codeEquivalent: 0 },
    { service: "netflix", gross: 180, direct: 180, codeEquivalent: 0 },
  ]);
  assert.equal(allocations.reduce((sum, row) => sum + row.gross, 0), 270);
});

test("multiple lines of the same service count as one service allocation", () => {
  const allocations = orderServiceAllocations({
    status: "completed",
    paymentMethod: "redeem",
    paidCurrency: "CODE",
    subtotal: 384,
    items: [
      { service: "spotify", amount: 128 },
      { service: "spotify", amount: 128 },
      { service: "netflix", amount: 128 },
    ],
  });

  assert.deepEqual(allocations, [
    { service: "spotify", gross: 256, direct: 0, codeEquivalent: 256 },
    { service: "netflix", gross: 128, direct: 0, codeEquivalent: 128 },
  ]);
});

test("service allocations conserve direct and code-equivalent totals", () => {
  const orders = [
    {
      status: "completed",
      paymentMethod: "alipay",
      finalAmount: 252,
      items: [{ service: "spotify", amount: 128 }, { service: "netflix", amount: 168 }],
    },
    {
      status: "received",
      paymentMethod: "redeem",
      paidCurrency: "CODE",
      finalAmount: 0,
      subtotal: 256,
      items: [{ service: "spotify", amount: 128 }, { service: "rocket", amount: 128 }],
    },
  ];
  const expected = orders.reduce((sum, order) => {
    const value = orderValueBreakdown(order);
    return {
      gross: sum.gross + value.gross,
      direct: sum.direct + value.direct,
      codeEquivalent: sum.codeEquivalent + value.codeEquivalent,
    };
  }, { gross: 0, direct: 0, codeEquivalent: 0 });
  const allocated = orders.flatMap(orderServiceAllocations).reduce((sum, row) => ({
    gross: sum.gross + row.gross,
    direct: sum.direct + row.direct,
    codeEquivalent: sum.codeEquivalent + row.codeEquivalent,
  }), { gross: 0, direct: 0, codeEquivalent: 0 });

  assert.deepEqual(allocated, expected);
  assert.deepEqual(expected, { gross: 508, direct: 252, codeEquivalent: 256 });
});

test("an explicit zero-value direct order is not inflated to catalog value", () => {
  assert.deepEqual(orderValueBreakdown({
    status: "completed",
    paymentMethod: "alipay",
    paidCurrency: "CNY",
    finalAmount: 0,
    paidAmount: 0,
    subtotal: 128,
    items: [{ service: "spotify", amount: 128 }],
  }), { gross: 0, direct: 0, codeEquivalent: 0 });
});

test("source and payment channel normalization preserve existing attribution", () => {
  assert.equal(orderSource({ attribution: { utm_source: "newsletter" } }), "UTM·newsletter");
  assert.equal(orderSource({ attribution: { referrer: "https://www.google.com/search?q=spotify" } }), "外链·google.com");
  assert.equal(orderSource({ referral: { inviter: "a@example.com" } }), "推荐");
  assert.equal(paymentChannel({ paymentMethod: "balance", paidCurrency: "CNY" }), "balance");
  assert.equal(paymentChannel({ paymentMethod: "usdt", paidCurrency: "USDT" }), "usdt");
});
