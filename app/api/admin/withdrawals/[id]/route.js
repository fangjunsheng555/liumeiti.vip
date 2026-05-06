import {
  adminSessionFromRequest, adminActorFromSession, getWithdrawalDetail, updateWithdrawalStatus, clean,
} from "../../../_utils.js";

export async function GET(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const detail = await getWithdrawalDetail(id);
  if (!detail) return Response.json({ ok: false, error: "withdrawal_not_found" }, { status: 404 });
  return Response.json({ ok: true, ...detail });
}

export async function PATCH(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await updateWithdrawalStatus(id, body.status, body.reviewNote, adminActorFromSession(session));
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code }, { status: 400 });
  }
  const detail = await getWithdrawalDetail(id);
  return Response.json({ ok: true, ...detail });
}
