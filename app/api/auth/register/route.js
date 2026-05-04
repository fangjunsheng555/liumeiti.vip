import {
  validEmail, hashPassword, getUser, setUser,
  signSession, setCookieValue, formatBeijingTime,
} from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const captchaA = Number(body.captchaA);
  const captchaB = Number(body.captchaB);
  const captchaAnswer = Number(body.captchaAnswer);

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (password.length < 6 || password.length > 64) {
    return Response.json({ ok: false, error: "password_length" }, { status: 400 });
  }
  if (!Number.isFinite(captchaA) || !Number.isFinite(captchaB) || captchaA + captchaB !== captchaAnswer) {
    return Response.json({ ok: false, error: "captcha_failed" }, { status: 400 });
  }

  const existing = await getUser(email);
  if (existing) {
    return Response.json({ ok: false, error: "email_taken" }, { status: 409 });
  }

  const now = new Date();
  const user = {
    email,
    passwordHash: hashPassword(password),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  const saved = await setUser(email, user);
  if (!saved) {
    return Response.json({ ok: false, error: "storage_failed" }, { status: 500 });
  }

  const token = signSession({ email, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 });
  return Response.json({ ok: true, email }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", token) },
  });
}
