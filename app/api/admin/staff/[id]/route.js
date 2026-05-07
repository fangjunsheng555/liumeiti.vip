import {
  adminSessionFromRequest, adminActorFromSession,
  deleteAdminStaff, listAdminStaff, getAdminActionLog, clean, isRootAdminSession,
} from "../../../_utils.js";

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
