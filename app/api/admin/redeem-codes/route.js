import {
  adminSessionFromRequest, adminActorFromSession,
  adminPermissionProfile, createRedeemCodes, listManageableRedeemCodesAndBatches, clean,
} from "../../_utils.js";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({ ok: true, codes, batches });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canManageCodes) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createRedeemCodes({
    type: body.type || "balance",
    amount: body.amount,
    services: Array.isArray(body.services) ? body.services : [],
    quantity: body.quantity,
    remark: body.remark,
    customCode: body.customCode,
  }, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const { codes, batches } = await listManageableRedeemCodesAndBatches();
  return Response.json({ ok: true, code: result.code, generatedCodes: result.codes, batch: result.batch, codes, batches });
}
