import {
  validEmail, verifyPassword,
  setCookieValue, clearCookieValue,
  checkCriticalRateLimit, rateLimitResponse,
} from "../../_utils.js";
import {
  authenticateUserRequest,
  createUserSession,
  readUserAuthState,
  revokeUserSessions,
} from "../../_auth-session.js";
import { withApiTelemetry } from "../../_observability.js";

async function loginHandler(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!validEmail(email) || !password || password.length > 64) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 400 });
  }
  const guard = await checkCriticalRateLimit(request, {
    namespace: "auth:login",
    identityLimit: 8,
    ipLimit: 80,
    windowSec: 10 * 60,
    identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard, "登录尝试过多，请稍后再试");

  // Read the password hash and auth version in the same Redis command. The
  // version is pinned through issuance, closing the reset/login race where an
  // old password could otherwise receive the post-reset session version.
  const loginState = await readUserAuthState(email);
  if (!loginState.ok && Number(loginState.status) >= 409) {
    return Response.json(
      { ok: false, error: loginState.error || "auth_store_unavailable" },
      { status: Number(loginState.status) || 500 },
    );
  }
  const user = loginState.ok ? loginState.user : null;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }
  if (user.banned) {
    return Response.json({ ok: false, error: "account_banned" }, { status: 403 });
  }

  // Login is intentionally read-only for the profile. Writing a stale profile
  // here could overwrite a password reset that committed concurrently.
  const session = await createUserSession(email, Date.now(), loginState.authVersion);
  if (!session.ok) {
    const status = session.error === "account_banned" ? 403
      : (session.error === "session_state_changed" || session.error === "user_not_found"
          || session.error === "account_record_invalid" ? 409
        : session.error === "storage_unavailable" || session.error === "redis_cluster_keyspace_not_supported" ? 503
          : 500);
    return Response.json({ ok: false, error: session.error || "auth_store_unavailable" }, { status });
  }
  return Response.json({ ok: true, email, accountLifecycleId: session.accountLifecycleId }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", session.token) },
  });
}

async function logoutHandler(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) {
    // An absent, expired or already-revoked cookie is safe to clear locally.
    // A store outage is different: keep the only authenticated browser copy
    // so the user can retry the durable all-device revocation.
    if (auth.status === 503) {
      return Response.json({ ok: false, error: auth.error || "auth_store_unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      });
    }
    return Response.json({ ok: true, revoked: false }, {
      headers: { "Set-Cookie": clearCookieValue("lm_user") },
    });
  }
  const revoked = await revokeUserSessions(auth.email);
  if (!revoked.ok) {
    return Response.json({ ok: false, error: revoked.error || "auth_store_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
    });
  }
  return Response.json({ ok: true, revoked: true }, {
    headers: { "Set-Cookie": clearCookieValue("lm_user") },
  });
}

export const POST = withApiTelemetry("auth_login", loginHandler);
export const DELETE = withApiTelemetry("auth_logout", logoutHandler);
