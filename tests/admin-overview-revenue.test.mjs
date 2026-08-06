import assert from "node:assert/strict";
import test from "node:test";

import { overviewSaleBreakdown } from "../app/api/admin/overview/route.js";

test("admin overview only counts recognized direct revenue", () => {
  assert.deepEqual(overviewSaleBreakdown({
    status: "received",
    paymentMethod: "alipay",
    paidCurrency: "CNY",
    finalAmount: 188,
    paidAmount: 188,
  }), {
    recognizedSale: false,
    revenueAmount: 0,
    codeEquivalentAmount: 0,
  });

  assert.deepEqual(overviewSaleBreakdown({
    status: "received",
    paymentMethod: "balance",
    paidCurrency: "CNY",
    finalAmount: 88,
  }), {
    recognizedSale: true,
    revenueAmount: 88,
    codeEquivalentAmount: 0,
  });

  assert.deepEqual(overviewSaleBreakdown({
    status: "received",
    paymentMethod: "usdt",
    paidCurrency: "USDT",
    finalAmount: 99,
    usdtConfirmedAt: "2026-08-06T00:00:00.000Z",
  }), {
    recognizedSale: true,
    revenueAmount: 99,
    codeEquivalentAmount: 0,
  });

  assert.deepEqual(overviewSaleBreakdown({
    status: "received",
    paymentMethod: "redeem",
    paidCurrency: "CODE",
    items: [{ service: "netflix", amount: 188 }],
  }), {
    recognizedSale: true,
    revenueAmount: 0,
    codeEquivalentAmount: 188,
  });
});
