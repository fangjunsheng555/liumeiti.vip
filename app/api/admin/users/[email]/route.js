import {
  getCookieFromRequest, verifySession, adminActorFromRequest, pushAdminActionLog, isRootAdminSession,
  deleteUser,
  validEmail, adminPermissionProfile,
} from "../../../_utils.js";
import { setUserBanStateAndRevokeSessions } from "../../../_auth-session.js";

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

function adminOk(request) {
  return Boolean(adminSession(request));
}

// PATCH /api/admin/users/:email   body: { banned: boolean }
// Toggle ban status.
export async function PATCH(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canBanUsers) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail || "").toLowerCase().trim();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const banned = !!body.banned;

  const updated = await setUserBanStateAndRevokeSessions(email, banned, actor);
  if (!updated.ok) {
    const status = updated.error === "user_not_found" ? 404 : 503;
    return Response.json({ ok: false, error: updated.error || "auth_store_unavailable" }, { status });
  }
  await pushAdminActionLog({
    action: banned ? "user_ban" : "user_unban",
    actor,
    target: "user:" + email,
    detail: { email },
  });
  return Response.json({ ok: true, email, banned });
}

// DELETE /api/admin/users/:email
// Atomically removes the user/balance/transactions/index membership and
// advances the durable auth-version tombstone, revoking every old lifecycle.
export async function DELETE(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canDeleteUsers) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail || "").toLowerCase().trim();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const deleted = await deleteUser(email);
  if (!deleted.ok) {
    const status = deleted.error === "user_not_found" ? 404 : 503;
    return Response.json({ ok: false, error: deleted.error || "delete_failed" }, { status });
  }
  await pushAdminActionLog({
    action: "user_delete",
    actor,
    target: "user:" + email,
    detail: { email, username: deleted.user?.username || "", authVersion: deleted.authVersion },
  });
  return Response.json({ ok: true, deleted: email });
}
