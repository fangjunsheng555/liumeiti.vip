import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET ||= "test-auth-secret";

const { shouldFallbackToBackupSmtp } = await import("../app/api/_utils.js");

test("transactional mail falls back after an explicit Resend quota rejection", () => {
  assert.equal(shouldFallbackToBackupSmtp(
    { to: "buyer@example.com", category: "order" },
    { ok: false, code: 429, error: "daily_quota_exceeded" },
  ), true);
  assert.equal(shouldFallbackToBackupSmtp(
    { to: "buyer@example.com", category: "order" },
    { ok: false, code: 429, error: "rate_limit_exceeded" },
  ), true);
});

test("marketing and scheduled mail never use the transactional SMTP fallback", () => {
  const quotaError = { ok: false, code: 429, error: "daily_quota_exceeded" };
  assert.equal(shouldFallbackToBackupSmtp({ marketing: true }, quotaError), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "marketing" }, quotaError), false);
  assert.equal(shouldFallbackToBackupSmtp({ category: "order", scheduledAt: "2026-07-15T10:30:00Z" }, quotaError), false);
});

test("provider and transport failures use the transactional fallback", () => {
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: 401 }), true);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: 500 }), true);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: 400, error: "Domain is not verified" }), true);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: "TypeError", error: "fetch failed" }), true);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: "AbortError", error: "This operation was aborted" }), true);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, reason: "resend_api_key_missing" }), true);
});

test("recipient and content validation failures do not use another provider", () => {
  assert.equal(shouldFallbackToBackupSmtp({ category: "order" }, { ok: false, code: 422 }), false);
  assert.equal(shouldFallbackToBackupSmtp({ to: "not-an-email", category: "order" }, { ok: false, code: 500 }), false);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: false, code: 422 }), false);
  assert.equal(shouldFallbackToBackupSmtp({ to: "buyer@example.com", category: "order" }, { ok: true }), false);
});
