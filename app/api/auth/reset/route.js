import {
  validEmail, getUser, setUser, hashPassword,
  getResetCode, deleteResetCode,
  signSession, setCookieValue,
} from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  const newPassword = String(body.newPassword || "");

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return Response.json({ ok: false, error: "password_length" }, { status: 400 });
  }

  const stored = await getResetCode(email);
  if (!stored || stored !== code) {
    return Response.json({ ok: false, error: "code_invalid_or_expired" }, { status: 400 });
  }

  const user = await getUser(email);
  if (!user) {
    return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  }

  user.passwordHash = hashPassword(newPassword);
  user.passwordResetAt = new Date().toISOString();
  const saved = await setUser(email, user);
  if (!saved) {
    return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  }
  await deleteResetCode(email);

  // Log the user in directly after reset
  const token = signSession({ email, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 });
  return Response.json({ ok: true, email }, {
    headers: { "Set-Cookie": setCookieValue("lm_user", token) },
  });
}
