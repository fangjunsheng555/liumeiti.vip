import { verifyAdminLogin, signSession, setCookieValue } from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const username = String(body.username || "");
  const password = String(body.password || "");

  const login = await verifyAdminLogin(username, password);
  if (!login.ok) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  const token = signSession({
    role: "admin",
    staffId: login.staff.id,
    staffUsername: login.staff.username,
    staffRoot: Boolean(login.staff.root),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  });
  return Response.json({ ok: true, staff: login.staff }, {
    headers: { "Set-Cookie": setCookieValue("lm_admin", token, 12 * 60 * 60) },
  });
}

export async function DELETE() {
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": "lm_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" },
  });
}
