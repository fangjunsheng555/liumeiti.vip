import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatedUserMatches,
  isSuccessfulAuthResponse,
  safeLoginAfterConfirmedAuth,
  safeLoginAfterUncertainAuth,
  shouldReauthenticateAfterAuthVerification,
  shouldRecoverAuthMutationResponse,
} from "../app/lib/auth-recovery.js";

test("an uncertain register or reset moves to safe login without repeating the mutation", () => {
  const register = safeLoginAfterUncertainAuth("register", { email: "old@example.com", password: "register-pass", newPassword: "" });
  assert.equal(register.mode, "login");
  assert.equal(register.form.password, "register-pass");

  const reset = safeLoginAfterUncertainAuth("reset", { email: "old@example.com", password: "old-pass", newPassword: "new-pass" });
  assert.equal(reset.mode, "login");
  assert.equal(reset.form.password, "new-pass");
  assert.equal(safeLoginAfterUncertainAuth("login", {}), null);
});

test("a confirmed auth response that cannot verify its cookie falls back to login, never the mutation form", () => {
  const register = safeLoginAfterConfirmedAuth("register", { email: "old@example.com", password: "register-pass", newPassword: "" });
  assert.equal(register.mode, "login");
  assert.equal(register.form.email, "old@example.com");
  assert.equal(register.form.password, "register-pass");

  const reset = safeLoginAfterConfirmedAuth("reset", { email: "old@example.com", password: "old-pass", newPassword: "new-pass" });
  assert.equal(reset.mode, "login");
  assert.equal(reset.form.email, "old@example.com");
  assert.equal(reset.form.password, "new-pass");

  assert.equal(shouldReauthenticateAfterAuthVerification({ guest: true, status: 401 }), true);
  assert.equal(shouldReauthenticateAfterAuthVerification({ identityMismatch: true, status: 409 }), true);
  assert.equal(shouldReauthenticateAfterAuthVerification({ status: 403 }), true);
  assert.equal(shouldReauthenticateAfterAuthVerification({ status: 503 }), false);
  assert.equal(shouldReauthenticateAfterAuthVerification({ ok: true }), false);
});

test("auth response success requires strict transport and JSON booleans", () => {
  assert.equal(isSuccessfulAuthResponse({ ok: true }, { ok: true, accepted: true }, "forgot"), true);
  assert.equal(isSuccessfulAuthResponse({ ok: true }, { ok: true }, "login"), true);
  for (const [response, data, mode] of [
    [{ ok: false }, { ok: true, accepted: true }, "forgot"],
    [{ ok: "true" }, { ok: true, accepted: true }, "forgot"],
    [{ ok: true }, { ok: "false", accepted: true }, "forgot"],
    [{ ok: true }, { ok: 1, accepted: true }, "forgot"],
    [{ ok: true }, { ok: true, accepted: "true" }, "forgot"],
    [{ ok: true }, { ok: true }, "forgot"],
  ]) assert.equal(isSuccessfulAuthResponse(response, data, mode), false);
});

test("explicit post-write session failures enter safe recovery without replaying registration or reset", () => {
  for (const mode of ["register", "reset"]) {
    assert.equal(shouldRecoverAuthMutationResponse(mode, 503, "storage_unavailable"), true);
    assert.equal(shouldRecoverAuthMutationResponse(mode, 500, "auth_store_unavailable"), true);
    assert.equal(shouldRecoverAuthMutationResponse(mode, 409, "session_state_changed"), true);
    assert.equal(shouldRecoverAuthMutationResponse(mode, 409, "account_record_invalid"), true);
  }
  assert.equal(shouldRecoverAuthMutationResponse("register", 503, "captcha_store_unavailable"), false);
  assert.equal(shouldRecoverAuthMutationResponse("reset", 503, "captcha_store_unavailable"), true);
  assert.equal(shouldRecoverAuthMutationResponse("reset", 403, "account_banned"), true);
  assert.equal(shouldRecoverAuthMutationResponse("register", 403, ""), true);
  assert.equal(shouldRecoverAuthMutationResponse("reset", 409, "unknown_error"), true);
  assert.equal(shouldRecoverAuthMutationResponse("register", 409, "email_taken"), false);
  assert.equal(shouldRecoverAuthMutationResponse("reset", 400, "code_invalid_or_expired"), false);
  assert.equal(shouldRecoverAuthMutationResponse("login", 503, "storage_unavailable"), false);
  assert.equal(authenticatedUserMatches({ ok: true, email: "old@example.com", accountLifecycleId: "a".repeat(32) }, "OLD@example.com", "a".repeat(32)), true);
  assert.equal(authenticatedUserMatches({ ok: "false", email: "old@example.com", accountLifecycleId: "a".repeat(32) }, "old@example.com", "a".repeat(32)), false);
  assert.equal(authenticatedUserMatches({ ok: true, email: "old@example.com", accountLifecycleId: "a".repeat(32) }, "old@example.com", ""), false);
  assert.equal(authenticatedUserMatches({ ok: true, email: "other@example.com", accountLifecycleId: "a".repeat(32) }, "old@example.com", "a".repeat(32)), false);
  assert.equal(authenticatedUserMatches({ ok: true, email: "old@example.com", accountLifecycleId: "b".repeat(32) }, "old@example.com", "a".repeat(32)), false);
});
