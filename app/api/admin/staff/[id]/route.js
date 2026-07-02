import {
  adminSessionFromRequest, adminActorFromSession,
  deleteAdminStaff, updateAdminStaff, kickAdminStaff, clearStaff2fa,
  listAdminStaff, getAdminActionLog, clean, isRootAdminSession, pushAdminActionLog,
} from "../../../_utils.js";

// PATCH /api/admin/staff/:id — 更新员工(细粒度权限/角色/备注/重置密码/启停用),或 {action:"kick"} 强制下线。仅超管。
export async function PATCH(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const actor = adminActorFromSession(session);

  if (body.action === "kick") {
    const staffId = Number(id);
    if (!Number.isFinite(staffId) || staffId <= 1) return Response.json({ ok: false, error: "cannot_kick_root" }, { status: 400 });
    const ok = await kickAdminStaff(staffId);
    if (!ok) return Response.json({ ok: false, error: "kick_failed" }, { status: 500 });
    await pushAdminActionLog({ action: "staff_kick", actor, target: "staff:" + staffId, detail: {} });
    return Response.json({ ok: true, kicked: staffId });
  }

  // 员工丢手机等场景:超管重置其 2FA(解绑),并踢下线。
  if (body.action === "reset2fa") {
    const staffId = Number(id);
    if (!Number.isFinite(staffId) || staffId <= 1) return Response.json({ ok: false, error: "cannot_reset_root" }, { status: 400 });
    await clearStaff2fa(staffId);
    await kickAdminStaff(staffId);
    await pushAdminActionLog({ action: "staff_2fa_reset", actor, target: "staff:" + staffId, detail: {} });
    return Response.json({ ok: true, reset: staffId });
  }

  const result = await updateAdminStaff(id, {
    perms: body.perms,
    role: typeof body.role === "string" ? body.role : undefined,
    remark: typeof body.remark === "string" ? body.remark : undefined,
    password: typeof body.password === "string" ? body.password : undefined,
    active: typeof body.active === "boolean" ? body.active : undefined,
  }, actor);
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const staff = await listAdminStaff();
  return Response.json({ ok: true, staff, updated: result.staff });
}

export async function DELETE(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const result = await deleteAdminStaff(id, adminActorFromSession(session));
  if (!result.ok) {
    return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  }
  const [staff, actions] = await Promise.all([listAdminStaff(), getAdminActionLog()]);
  return Response.json({ ok: true, staff, actions });
}
