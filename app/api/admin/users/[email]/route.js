import {
  getCookieFromRequest, verifySession,
  getUser, setUser, deleteUser,
  validEmail,
} from "../../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

// PATCH /api/admin/users/:email   body: { banned: boolean }
// Toggle ban status.
export async function PATCH(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail || "").toLowerCase().trim();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const banned = !!body.banned;

  const user = await getUser(email);
  if (!user) {
    return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  }
  user.banned = banned;
  user.bannedAt = banned ? new Date().toISOString() : null;
  const saved = await setUser(email, user);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  return Response.json({ ok: true, email, banned });
}

// DELETE /api/admin/users/:email
// Permanently removes user record + transaction list + email from set.
export async function DELETE(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail || "").toLowerCase().trim();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const user = await getUser(email);
  if (!user) return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  const ok = await deleteUser(email);
  if (!ok) return Response.json({ ok: false, error: "delete_failed" }, { status: 500 });
  return Response.json({ ok: true, deleted: email });
}
