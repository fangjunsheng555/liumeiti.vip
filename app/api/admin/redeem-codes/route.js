import {
  getCookieFromRequest, verifySession, createRedeemCode, listRedeemCodes, clean,
} from "../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

export async function GET(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const codes = await listRedeemCodes();
  return Response.json({ ok: true, codes });
}

export async function POST(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createRedeemCode({
    type: body.type || "balance",
    amount: body.amount,
    services: Array.isArray(body.services) ? body.services : [],
  });
  if (!result.ok) return Response.json({ ok: false, error: clean(result.error, 80) }, { status: 400 });
  const codes = await listRedeemCodes();
  return Response.json({ ok: true, code: result.code, codes });
}
