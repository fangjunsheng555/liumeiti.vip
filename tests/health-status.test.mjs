import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";
process.env.OPS_HIGH_FREQUENCY_CRON = "1";

const { healthStatusWithFreshness, HEALTH_COMPONENTS, HEALTH_STALE_AFTER_MS } = await import("../app/api/_health.js");

test("mail health includes both Resend and Brevo send and webhook components", () => {
  for (const component of ["resend", "resend_webhook", "brevo", "brevo_webhook"]) {
    assert.equal(HEALTH_COMPONENTS.includes(component), true);
  }
});

test("an old successful Resend result becomes a stale warning", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const result = healthStatusWithFreshness("resend", {
    status: "ok",
    summary: "最近一封邮件已提交",
    checkedAt: "2026-07-01T10:00:00.000Z",
  }, now);
  assert.equal(result.status, "warning");
  assert.equal(result.sourceStatus, "ok");
  assert.equal(result.stale, true);
});

test("recent mail status and explicit errors keep their original state", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  assert.equal(healthStatusWithFreshness("resend", {
    status: "ok",
    checkedAt: "2026-07-16T10:00:00.000Z",
  }, now).status, "ok");
  assert.equal(healthStatusWithFreshness("brevo", {
    status: "error",
    checkedAt: "2026-05-01T10:00:00.000Z",
  }, now).status, "error");
});

test("scheduler-driven component freshness shares the hourly Hobby policy", () => {
  const routineComponents = [
    "redis", "usdt", "api", "telegram", "job_runner", "order_transition",
    "quote_expiry", "order_sla", "after_sales_outbox", "marketing_queue", "push",
  ];
  for (const component of routineComponents) {
    assert.equal(HEALTH_STALE_AFTER_MS[component], 150 * 60_000, component);
  }
  assert.equal(HEALTH_STALE_AFTER_MS.renewal, 12 * 60 * 60_000);
});

test("hourly component is fresh before 150 minutes and stale after it", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const record = { status: "ok", summary: "维护任务运行完成" };
  assert.equal(healthStatusWithFreshness("job_runner", {
    ...record,
    checkedAt: new Date(now - 149 * 60_000).toISOString(),
  }, now).stale, false);
  const stale = healthStatusWithFreshness("job_runner", {
    ...record,
    checkedAt: new Date(now - 151 * 60_000).toISOString(),
  }, now);
  assert.equal(stale.stale, true);
  assert.equal(stale.status, "warning");
});
