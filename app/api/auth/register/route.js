import {
  validEmail, hashPassword, getUser, setUser,
  setCookieValue, formatBeijingTime,
  generateRandomUsername, attachRegisterCoupon,
  generateRandomUserAvatarId,
  getCookieFromRequest, inviteCodeFromRequest, normalizeInviteCode,
  prepareNewUserReferralProfile,
  checkCriticalRateLimit, consumeRegisterCaptcha, rateLimitResponse,
} from "../../_utils.js";
import { createUserSession } from "../../_auth-session.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const captchaToken = String(body.captchaToken || "");
  const captchaAnswer = String(body.captchaAnswer || "");

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const guard = await checkCriticalRateLimit(request, {
    namespace: "auth:register",
    identityLimit: 5,
    ipLimit: 30,
    windowSec: 30 * 60,
    identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard, "注册请求过多，请稍后再试");
  if (password.length < 6 || password.length > 64) {
    return Response.json({ ok: false, error: "password_length" }, { status: 400 });
  }
  const existing = await getUser(email);
  if (existing) {
    return Response.json({ ok: false, error: "email_taken" }, { status: 409 });
  }
  const captcha = await consumeRegisterCaptcha(captchaToken, captchaAnswer);
  if (!captcha.ok) {
    const unavailable = captcha.error === "captcha_store_unavailable";
    return Response.json({ ok: false, error: captcha.error }, { status: unavailable ? 503 : 400 });
  }

  const now = new Date();
  const inviteCode = normalizeInviteCode(body.inviteCode || inviteCodeFromRequest(request) || getCookieFromRequest(request, "lm_invite"));
  const user = await prepareNewUserReferralProfile(email, attachRegisterCoupon({
    email,
    username: generateRandomUsername(),
    avatarId: generateRandomUserAvatarId(),
    passwordHash: hashPassword(password),
    balance: 0,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  }, now), inviteCode);
  const saved = await setUser(email, user, { createOnly: true, returnResult: true });
  if (!saved?.ok) {
    if (saved?.error === "user_exists") {
      return Response.json({ ok: false, error: "email_taken" }, { status: 409 });
    }
    return Response.json({ ok: false, error: saved?.error || "storage_failed" }, { status: 503 });
  }
  // Pin issuance to the lifecycle that won the create-only profile write. If
  // an admin deletes and the address is re-registered before this line runs,
  // the tombstone version has advanced and no cookie is minted for that newer
  // account.
  const session = await createUserSession(email, Date.now(), saved.authVersion);
  if (!session.ok) {
    const status = session.error === "account_banned" ? 403
      : (session.error === "user_not_found" || session.error === "session_state_changed" ? 409 : 503);
    return Response.json({ ok: false, error: session.error || "auth_store_unavailable" }, { status });
  }
  return Response.json({ ok: true, email, accountLifecycleId: session.accountLifecycleId }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", session.token) },
  });
}
