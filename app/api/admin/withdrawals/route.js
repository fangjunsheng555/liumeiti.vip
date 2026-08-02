import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile, listWithdrawals, deleteWithdrawals, clean,
} from "../../_utils.js";
import { requiredIdempotencyKey } from "../../_money.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canReviewWithdrawals) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let withdrawals;
  try {
    withdrawals = await listWithdrawals();
  } catch (error) {
    return Response.json({ ok: false, error: "storage_failed" }, { status: 503 });
  }
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
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteWithdrawals(ids, adminActorFromSession(session), { operationId: idempotency.key });
  if (!result.ok) {
    const conflictErrors = new Set([
      "withdrawal_active",
      "withdrawal_already_archived",
      "withdrawal_not_found",
      "withdrawal_not_indexed",
      "idempotency_conflict",
    ]);
    const status = conflictErrors.has(result.error) ? 409 : (result.error === "storage_failed" ? 503 : 400);
    return Response.json({ ok: false, error: result.error, id: result.id || "", withdrawalStatus: result.status || "" }, { status });
  }
  return Response.json(result);
}
