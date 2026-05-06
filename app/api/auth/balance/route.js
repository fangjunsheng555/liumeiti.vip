import {
  getCookieFromRequest, verifySession, getUser, getBalanceTxs,
  publicCoupons, listWithdrawals, WITHDRAWAL_STATUS_LABEL,
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
  const withdrawals = (await listWithdrawals()).filter((w) => w.userEmail === session.email);
  const withdrawalMap = new Map(withdrawals.map((w) => [w.id, w]));
  return Response.json({
    ok: true,
    email: session.email,
    username: user?.username || "",
    balance,
    coupons: publicCoupons(user),
    withdrawals,
    transactions: txs.map((tx) => {
      const w = tx.withdrawalId ? withdrawalMap.get(tx.withdrawalId) : null;
      return w ? {
        ...tx,
        status: w.status,
        statusLabel: WITHDRAWAL_STATUS_LABEL[w.status] || w.statusLabel,
        reviewNote: w.reviewNote || "",
      } : tx;
    }),
  });
}
