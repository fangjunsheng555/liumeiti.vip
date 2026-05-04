import {
  validEmail, verifyPassword, getUser, setUser,
  signSession, setCookieValue, clearCookieValue,
  registerUserEmail, generateRandomUsername,
} from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const captchaA = Number(body.captchaA);
  const captchaB = Number(body.captchaB);
  const captchaAnswer = Number(body.captchaAnswer);

  if (!validEmail(email) || !password) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 400 });
  }
  if (!Number.isFinite(captchaA) || !Number.isFinite(captchaB) || captchaA + captchaB !== captchaAnswer) {
    return Response.json({ ok: false, error: "captcha_failed" }, { status: 400 });
  }

  const user = await getUser(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  // Backfill: ensure email is in the registered set + user has a username
  // (for accounts created before these fields existed).
  let needSave = false;
  if (!user.username) { user.username = generateRandomUsername(); needSave = true; }
  if (typeof user.balance !== "number") { user.balance = 0; needSave = true; }
  if (needSave) await setUser(email, user);
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
