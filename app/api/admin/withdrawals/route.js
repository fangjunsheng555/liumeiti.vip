import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile, listWithdrawals, deleteWithdrawals, clean,
} from "../../_utils.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canReviewWithdrawals) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const withdrawals = await listWithdrawals();
  return Response.json({
    ok: true,
    withdrawals,
    currentStaff: {
      id: Number(session.staffId || 1),
      username: session.staffUsername || "admin",
      root: isRootAdminSession(session),
      role: permissions.role,
      permissions,
    },
  });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canDeleteRecords) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteWithdrawals(ids, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
  return Response.json(result);
}
