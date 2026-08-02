import {
  validEmail, hashPassword,
  setCookieValue,
  checkCriticalRateLimit, rateLimitResponse,
} from "../../_utils.js";
import { createUserSession, resetPasswordAndRevokeSessions } from "../../_auth-session.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  const newPassword = String(body.newPassword || "");

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const guard = await checkCriticalRateLimit(request, {
    namespace: "auth:reset",
    identityLimit: 8,
    ipLimit: 40,
    windowSec: 15 * 60,
    identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard, "重置尝试过多，请稍后再试");
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return Response.json({ ok: false, error: "password_length" }, { status: 400 });
  }

  // The password field update and session-version bump are one Redis commit.
  // Login pins the version read with the password, so an old password checked
  // concurrently can never receive the newly issued version.
  const revoked = await resetPasswordAndRevokeSessions(email, hashPassword(newPassword), code);
  if (!revoked.ok) {
    const status = revoked.error === "code_invalid_or_expired" ? 400
      : revoked.error === "user_not_found" ? 404 : 503;
    return Response.json({ ok: false, error: revoked.error || "auth_store_unavailable" }, { status });
  }

  // Log the user in directly after reset
  const session = await createUserSession(email, Date.now(), revoked.authVersion);
  if (!session.ok) {
    const status = session.error === "session_state_changed" || session.error === "user_not_found" ? 409 : 503;
    return Response.json({ ok: false, error: session.error || "auth_store_unavailable" }, { status });
  }
  return Response.json({ ok: true, email, accountLifecycleId: session.accountLifecycleId }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", session.token) },
  });
}
