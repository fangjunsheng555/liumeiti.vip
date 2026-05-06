import { getCookieFromRequest, verifySession, listWithdrawals } from "../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

export async function GET(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const withdrawals = await listWithdrawals();
  return Response.json({ ok: true, withdrawals });
}
