import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";

const { shouldFallbackToBackupSmtp } = await import("../app/api/_utils.js");

test("transactional mail falls back after an explicit Resend quota rejection", () => {
  assert.equal(shouldFallbackToBackupSmtp(
    { category: "order" },
    { ok: false, code: 429, error: "daily_quota_exceeded" },
  ), true);
  assert.equal(shouldFallbackToBackupSmtp(
    { category: "order" },
    { ok: false, code: 429, error: "rate_limit_exceeded" },
  ), true);
});

test("marketing and scheduled mail never use the transactional SMTP fallback", () => {
  const quotaError = { ok: false, code: 429, error: "daily_quota_exceeded" };
  assert.equal(shouldFallbackToBackupSmtp({ marketing: true }, quotaError), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "marketing" }, quotaError), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "order", scheduledAt: "2026-07-15T10:30:00Z" }, quotaError), false);
});

test("validation, server and ambiguous network failures do not risk duplicate fallback mail", () => {
  assert.equal(shouldFallbackToBackupSmtp({ category: "order" }, { ok: false, code: 422 }), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "order" }, { ok: false, code: 500 }), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "order" }, { ok: false, code: "fetch_error" }), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "order" }, { ok: true }), false);
});
