import {
  getCookieFromRequest, verifySession, getUser, setUser,
  addBalanceTx, getBalanceTxs, pushAdminBalanceLog,
  validEmail, formatBeijingTime, clean,
} from "../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

// GET /api/admin/users?email=xxx@xxx.com — fetch a user with balance + transactions
export async function GET(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
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
  return Response.json({
    ok: true,
    user: {
      email: user.email,
      username: user.username || "",
      balance: Number(user.balance || 0),
      createdAtBeijing: user.createdAtBeijing || "",
    },
    transactions: txs,
  });
}

// POST /api/admin/users — adjust balance
// body: { email, amount (positive=add, negative=deduct), reason }
export async function POST(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
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
    reason,
    balanceAfter: next,
    source: "admin",
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

  return Response.json({
    ok: true,
    email,
    balance: next,
    delta: amount,
    transaction: tx,
  });
}
