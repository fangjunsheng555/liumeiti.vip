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
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({ ok: true, batch: result.batch, codes, batches });
}

export async function DELETE(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const result = await deleteRedeemBatch(id, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({ ok: true, codes, batches });
}
