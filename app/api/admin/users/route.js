import {
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, getUser, getBalanceTxs,
  validEmail, clean,
  adminSessionFromRequest, adminPermissionProfile,
  getReferralDownlineRecords, normalizeInviteCode,
} from "../../_utils.js";
import { applyBalanceEffectAtomic, requiredIdempotencyKey } from "../../_money.js";
import { readUserAuthState } from "../../_auth-session.js";
import {
  isRetryableMoneyOperationFailure,
  retryableMoneyOperationFields,
} from "../../../lib/money-operation-failure.js";

function adminSession(request) {
  return adminSessionFromRequest(request);
}

function lowerEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function userReferralDetail(email, user) {
  // 走反向索引(getReferralDownlineRecords),不再全表扫描全站用户。
  const downlines = await getReferralDownlineRecords(email);

  return {
    inviteCode: normalizeInviteCode(user.inviteCode),
    invitedByEmail: lowerEmail(user.invitedByEmail),
    invitedByCode: normalizeInviteCode(user.invitedByCode),
    invitedBy2Email: lowerEmail(user.invitedBy2Email),
    invitedAtBeijing: user.invitedAtBeijing || "",
    levelOneCount: downlines.filter((item) => item.level === 1).length,
    levelTwoCount: downlines.filter((item) => item.level === 2).length,
    downlines,
  };
}

// GET /api/admin/users?email=xxx@xxx.com — fetch a user with balance + transactions
export async function GET(request) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canViewUsers && !permissions.canAdjustBalance) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const user = await getUser(email);
  if (!user) {
    return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  }
  const txs = await getBalanceTxs(email);
  const referral = permissions.canViewUsers ? await userReferralDetail(email, user) : null;
  return Response.json({
    ok: true,
    user: {
      email: user.email,
      username: user.username || "",
      balance: Number(user.balance || 0),
      createdAtBeijing: user.createdAtBeijing || "",
      referral,
    },
    transactions: txs,
  });
}

// POST /api/admin/users — adjust balance
// body: { email, amount (positive=add, negative=deduct), reason }
export async function POST(request) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canAdjustBalance) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  const amount = Number(body.amount);
  const reason = clean(body.reason, 200);

  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return Response.json({ ok: false, error: "invalid_amount" }, { status: 400 });
  }
  if (Math.abs(amount) > 100000) {
    return Response.json({ ok: false, error: "amount_too_large" }, { status: 400 });
  }
  if (!reason) {
    return Response.json({ ok: false, error: "reason_required" }, { status: 400 });
  }
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  // Pin the adjustment to the exact account lifecycle observed by this
  // request. The money Lua script checks it again atomically before either an
  // old idempotent result or a balance mutation can be returned.
  const targetState = await readUserAuthState(email);
  if (!targetState.ok) {
    const targetStatus = targetState.status === 401
      ? 404
      : Number.isInteger(targetState.status) && targetState.status >= 400 && targetState.status <= 599
        ? targetState.status
        : 500;
    return Response.json({ ok: false, error: targetState.error || "user_not_found" }, {
      status: targetStatus,
    });
  }
  const adjusted = await applyBalanceEffectAtomic({
    email,
    delta: amount,
    effectId: `admin-adjust:${idempotency.key}`,
    idempotencyReason: reason,
    reason: reason + " · " + adminActorLabel(actor),
    source: "admin",
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
    detail: { reason },
    expectedAccountLifecycleId: targetState.accountLifecycleId,
  });
  if (!adjusted.ok) {
    const retryableFailure = isRetryableMoneyOperationFailure(adjusted);
    const status = retryableFailure ? 503
      : adjusted.error === "user_not_found" ? 404
      : adjusted.error === "idempotency_conflict" ? 409
        : adjusted.error === "account_lifecycle_changed" || adjusted.error === "account_lifecycle_required" ? 409 : 400;
    return Response.json({
      ok: false,
      error: adjusted.error || "storage_unavailable",
      currentBalance: adjusted.currentBalance,
      ...(retryableFailure ? retryableMoneyOperationFields(adjusted) : {}),
    }, { status });
  }
  if (!adjusted.idempotent) await pushAdminActionLog({
    action: "user_balance_adjust",
    actor,
    target: "user:" + email,
    detail: { amount, balanceBefore: adjusted.balanceBefore, balanceAfter: adjusted.balance },
  });

  return Response.json({
    ok: true,
    email,
    balance: adjusted.balance,
    delta: amount,
    transaction: adjusted.transaction,
    idempotent: Boolean(adjusted.idempotent),
  });
}
