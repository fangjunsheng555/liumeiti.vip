import {
  validEmail, verifyPassword, getUser, setUser,
  signSession, setCookieValue, clearCookieValue,
  registerUserEmail, generateRandomUsername, ensureUserReferralProfile,
  checkRateLimit, rateLimitResponse,
} from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!validEmail(email) || !password) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 400 });
  }
  const guard = await checkRateLimit(request, {
    namespace: "auth:login",
    limit: 8,
    windowSec: 10 * 60,
    identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard, "登录尝试过多，请稍后再试");

  const user = await getUser(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }
  if (user.banned) {
    return Response.json({ ok: false, error: "account_banned" }, { status: 403 });
  }

  // Backfill: ensure email is in the registered set + user has a username
  // (for accounts created before these fields existed).
  let needSave = false;
  const hadInviteCode = Boolean(user.inviteCode);
  if (!user.username) { user.username = generateRandomUsername(); needSave = true; }
  if (typeof user.balance !== "number") { user.balance = 0; needSave = true; }
  await ensureUserReferralProfile(email, user);
  if (needSave || !hadInviteCode) await setUser(email, user);
  await registerUserEmail(email);

  const token = signSession({ email, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 });
  return Response.json({ ok: true, email }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", token) },
  });
}

export async function DELETE() {
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": clearCookieValue("lm_user") },
  });
}
