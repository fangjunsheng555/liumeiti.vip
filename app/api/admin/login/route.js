import { checkAdminPassword, signSession, setCookieValue } from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const password = String(body.password || "");

  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: "ADMIN_PASSWORD not configured" }, { status: 500 });
  }
  if (!checkAdminPassword(password)) {
    return Response.json({ ok: false, error: "invalid_password" }, { status: 401 });
  }

  const token = signSession({ role: "admin", exp: Date.now() + 12 * 60 * 60 * 1000 });
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": setCookieValue("lm_admin", token, 12 * 60 * 60) },
  });
}

export async function DELETE() {
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": "lm_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" },
  });
}
