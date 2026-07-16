import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";

const { healthStatusWithFreshness, HEALTH_COMPONENTS } = await import("../app/api/_health.js");

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
