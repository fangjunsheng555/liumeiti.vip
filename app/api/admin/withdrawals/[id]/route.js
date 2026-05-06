import {
  getCookieFromRequest, verifySession, getWithdrawalDetail, updateWithdrawalStatus, clean,
} from "../../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

export async function GET(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const detail = await getWithdrawalDetail(id);
  if (!detail) return Response.json({ ok: false, error: "withdrawal_not_found" }, { status: 404 });
  return Response.json({ ok: true, ...detail });
}

export async function PATCH(request, { params }) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await updateWithdrawalStatus(id, body.status, body.reviewNote);
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code }, { status: 400 });
  }
  const detail = await getWithdrawalDetail(id);
  return Response.json({ ok: true, ...detail });
}
