import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile,
  updateRedeemBatchStatus, deleteRedeemBatch,
  listManageableRedeemCodesAndBatches, clean,
} from "../../../_utils.js";

export async function PATCH(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canManageCodes) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const result = await updateRedeemBatchStatus(id, "void", adminActorFromSession(session));
  if (!result.ok) {
    const error = clean(result.error, 80);
    return Response.json({ ok: false, error }, { status: error === "batch_conflict" ? 409 : (error === "storage_failed" ? 503 : 400) });
  }
  let listing = null;
  try { listing = await listManageableRedeemCodesAndBatches(); }
  catch (error) { console.warn("[admin-redeem] batch updated but refresh failed", error?.message || error); }
  return Response.json({ ok: true, batch: result.batch, ...(listing || {}), refreshRequired: !listing });
}

export async function DELETE(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const result = await deleteRedeemBatch(id, adminActorFromSession(session));
  if (!result.ok) {
    const error = clean(result.error, 80);
    return Response.json({ ok: false, error }, { status: error === "batch_conflict" ? 409 : (error === "storage_failed" ? 503 : 400) });
  }
  let listing = null;
  try { listing = await listManageableRedeemCodesAndBatches(); }
  catch (error) { console.warn("[admin-redeem] batch deleted but refresh failed", error?.message || error); }
  return Response.json({ ok: true, ...(listing || {}), refreshRequired: !listing });
}
