import {
  getCookieFromRequest, verifySession, getUser, getBalanceTxs,
} from "../../_utils.js";

export async function GET(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) {
    return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  }
  const user = await getUser(session.email);
  const balance = Number(user?.balance || 0);
  const txs = await getBalanceTxs(session.email);
  return Response.json({
    ok: true,
    email: session.email,
    balance,
    transactions: txs,
  });
}
