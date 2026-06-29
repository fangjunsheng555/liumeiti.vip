import {
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, getUser, setUser,
  addBalanceTx, getBalanceTxs, pushAdminBalanceLog,
  validEmail, formatBeijingTime, clean,
  adminSessionFromRequest, adminPermissionProfile,
  listAllUserEmails, normalizeInviteCode,
} from "../../_utils.js";

function adminSession(request) {
  return adminSessionFromRequest(request);
}

function lowerEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function userReferralDetail(email, user) {
  const lower = lowerEmail(email);
  const emails = await listAllUserEmails();
  const records = (await Promise.all(emails.map((item) => getUser(item)))).filter(Boolean);
  const downlines = records
    .map((item) => {
      const targetEmail = lowerEmail(item.email);
      if (!targetEmail || targetEmail === lower) return null;
      const first = lowerEmail(item.invitedByEmail);
      const second = lowerEmail(item.invitedBy2Email);
      const level = first === lower ? 1 : second === lower ? 2 : 0;
      if (!level) return null;
      return {
        email: targetEmail,
        username: item.username || "",
        level,
        balance: Number(item.balance || 0),
        banned: !!item.banned,
        inviteCode: normalizeInviteCode(item.inviteCode),
        invitedAtBeijing: item.invitedAtBeijing || item.createdAtBeijing || "",
        createdAtBeijing: item.createdAtBeijing || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.level - b.level || String(b.createdAtBeijing || "").localeCompare(String(a.createdAtBeijing || "")));

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

  const user = await getUser(email);
  if (!user) {
    return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  }

  const prev = Number(user.balance || 0);
  const next = Math.round((prev + amount) * 100) / 100;
  if (next < 0) {
    return Response.json({ ok: false, error: "insufficient_balance", currentBalance: prev }, { status: 400 });
  }

  user.balance = next;
  const saved = await setUser(email, user);
  if (!saved) {
    return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  }

  const now = new Date();
  const tx = {
    id: "TX" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    amount,
    reason: reason + " · " + adminActorLabel(actor),
    balanceAfter: next,
    source: "admin",
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  };
  await addBalanceTx(email, tx);
  // Also append to the global admin ledger so the admin dashboard
  // can display every adjustment across all users in one place.
  await pushAdminBalanceLog({
    ...tx,
    email,
    balanceBefore: prev,
  });
  await pushAdminActionLog({
    action: "user_balance_adjust",
    actor,
    target: "user:" + email,
    detail: { amount, balanceBefore: prev, balanceAfter: next },
  });

  return Response.json({
    ok: true,
    email,
    balance: next,
    delta: amount,
    transaction: tx,
  });
}
