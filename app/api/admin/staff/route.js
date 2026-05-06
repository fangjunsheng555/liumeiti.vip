import {
  adminSessionFromRequest, adminActorFromSession,
  listAdminStaff, createAdminStaff, getAdminActionLog, clean,
} from "../../_utils.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const [staff, actions] = await Promise.all([listAdminStaff(), getAdminActionLog()]);
  return Response.json({
    ok: true,
    currentStaffId: Number(session.staffId || 1),
    staff,
    actions,
  });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createAdminStaff(body, adminActorFromSession(session));
  if (!result.ok) {
    return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  }
  const [staff, actions] = await Promise.all([listAdminStaff(), getAdminActionLog()]);
  return Response.json({ ok: true, created: result.staff, staff, actions });
}
