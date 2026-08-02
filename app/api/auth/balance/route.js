import {
  getBalanceTxs,
  publicCoupons, listWithdrawals, WITHDRAWAL_STATUS_LABEL,
  publicReferral, ensureUserReferralProfile,
} from "../../_utils.js";
import { authenticateUserRequest, userAuthErrorResponse } from "../../_auth-session.js";

export async function GET(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const user = await ensureUserReferralProfile(auth.email, auth.user, {
    expectedAuthVersion: auth.authVersion,
    expectedAccountLifecycleId: auth.accountLifecycleId,
    updateOnly: true,
  });
  if (!user) {
    return Response.json({ ok: false, error: "session_state_changed" }, { status: 409 });
  }
  const balance = Number(user?.balance || 0);
  const txs = await getBalanceTxs(auth.email);
  const withdrawals = (await listWithdrawals()).filter((w) => w.userEmail === auth.email);
  const withdrawalMap = new Map(withdrawals.map((w) => [w.id, w]));
  return Response.json({
    ok: true,
    email: auth.email,
    username: user?.username || "",
    balance,
    coupons: publicCoupons(user),
    referral: publicReferral(user),
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
