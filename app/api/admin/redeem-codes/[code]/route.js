import {
  getCookieFromRequest, verifySession, updateRedeemCodeStatus, deleteRedeemCode, listRedeemCodes, clean,
} from "../../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

export async function PATCH(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { code } = await params;
  const result = await updateRedeemCodeStatus(code, "void");
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const codes = await listRedeemCodes();
  return Response.json({ ok: true, code: result.code, codes });
}

export async function DELETE(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { code } = await params;
  const result = await deleteRedeemCode(code);
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const codes = await listRedeemCodes();
  return Response.json({ ok: true, codes });
}
