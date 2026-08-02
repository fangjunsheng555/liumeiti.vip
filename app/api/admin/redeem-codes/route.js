import {
  adminSessionFromRequest, adminActorFromSession,
  adminPermissionProfile, createRedeemCodes, listManageableRedeemCodesAndBatches, clean,
} from "../../_utils.js";
import { requiredIdempotencyKey } from "../../_money.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canViewCodes) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({ ok: true, codes, batches });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canManageCodes) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createRedeemCodes({
    type: body.type || "balance",
    amount: body.amount,
    services: Array.isArray(body.services) ? body.services : [],
    quantity: body.quantity,
    remark: body.remark,
    customCode: body.customCode,
  }, adminActorFromSession(session), { operationId: idempotency.key });
  if (!result.ok) {
    const error = clean(result.error, 80);
    const status = error === "idempotency_conflict" || error === "custom_code_exists" || error === "code_exists"
      ? 409
      : (error === "storage_failed" ? 503 : 400);
    return Response.json({ ok: false, error }, { status });
  }
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({
    ok: true,
    code: result.code,
    generatedCodes: result.codes,
    batch: result.batch,
    codes,
    batches,
    idempotent: Boolean(result.idempotent),
    recovered: Boolean(result.recovered),
  });
}
