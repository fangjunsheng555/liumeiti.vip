import assert from "node:assert/strict";
import test from "node:test";
import { getOrderSla, ORDER_SLA_MINUTES } from "../app/lib/order-sla.js";

const now = new Date("2026-07-14T10:00:00.000Z");

test("standard paid orders use a 30 minute SLA", () => {
  const sla = getOrderSla({ status: "received", createdAt: "2026-07-14T09:20:00.000Z", paymentMethod: "alipay" }, now);
  assert.equal(sla.expectedMinutes, ORDER_SLA_MINUTES.standard);
  assert.equal(sla.overdue, true);
  assert.equal(sla.overdueMinutes, 10);
});

test("orders become overdue immediately after the deadline", () => {
  const sla = getOrderSla(
    { status: "received", createdAt: "2026-07-14T09:30:00.000Z", paymentMethod: "alipay" },
    new Date("2026-07-14T10:00:00.001Z"),
  );
  assert.equal(sla.overdue, true);
  assert.equal(sla.overdueMinutes, 1);
});

test("balance and redeem orders use a 15 minute SLA", () => {
  const sla = getOrderSla({ status: "received", createdAt: "2026-07-14T09:50:00.000Z", paymentMethod: "balance" }, now);
  assert.equal(sla.expectedMinutes, ORDER_SLA_MINUTES.instant);
  assert.equal(sla.overdue, false);
  assert.equal(sla.remainingMinutes, 5);
});

test("quotes use a two hour SLA", () => {
  const sla = getOrderSla({ status: "awaiting_quote", createdAt: "2026-07-14T08:30:00.000Z", orderType: "proxy_payment" }, now);
  assert.equal(sla.expectedMinutes, ORDER_SLA_MINUTES.quote);
  assert.equal(sla.remainingMinutes, 30);
});

test("unconfirmed USDT and pending customer corrections pause SLA", () => {
  assert.equal(getOrderSla({ status: "received", createdAt: "2026-07-14T08:00:00.000Z", paidCurrency: "USDT" }, now).state, "waiting");
  assert.equal(getOrderSla({
    status: "received",
    createdAt: "2026-07-14T08:00:00.000Z",
    items: [{ service: "spotify", passwordCorrectionRequestedAt: "2026-07-14T09:00:00.000Z" }],
  }, now).state, "waiting");
});

test("completed orders do not have an active SLA", () => {
  const sla = getOrderSla({ status: "completed", createdAt: "2026-07-14T08:00:00.000Z" }, now);
  assert.equal(sla.active, false);
  assert.equal(sla.state, "closed");
});
