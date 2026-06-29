import {
  getCookieFromRequest, verifySession,
  listAllUserEmails, getUser, adminPermissionProfile, normalizeInviteCode,
} from "../../../_utils.js";

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

// GET /api/admin/users/list[?q=keyword]
// Returns all registered users (email + username + balance + createdAt).
export async function GET(request) {
  const session = adminSession(request);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!adminPermissionProfile(session).canViewUsers) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();

  const emails = await listAllUserEmails();
  const records = (await Promise.all(emails.map((email) => getUser(email)))).filter(Boolean);
  const lowerEmail = (value) => String(value || "").trim().toLowerCase();
  const relationCounts = new Map();
  records.forEach((user) => {
    const first = lowerEmail(user.invitedByEmail);
    const second = lowerEmail(user.invitedBy2Email);
    if (first) {
      const item = relationCounts.get(first) || { levelOneCount: 0, levelTwoCount: 0 };
      item.levelOneCount += 1;
      relationCounts.set(first, item);
    }
    if (second) {
      const item = relationCounts.get(second) || { levelOneCount: 0, levelTwoCount: 0 };
      item.levelTwoCount += 1;
      relationCounts.set(second, item);
    }
  });
  const users = records
    .map((u) => ({
      email: u.email || "",
      username: u.username || "",
      balance: Number(u.balance || 0),
      banned: !!u.banned,
      createdAtBeijing: u.createdAtBeijing || "",
      createdAt: u.createdAt || "",
      referral: {
        inviteCode: normalizeInviteCode(u.inviteCode),
        invitedByEmail: lowerEmail(u.invitedByEmail),
        invitedByCode: normalizeInviteCode(u.invitedByCode),
        invitedBy2Email: lowerEmail(u.invitedBy2Email),
        levelOneCount: Number(relationCounts.get(lowerEmail(u.email))?.levelOneCount || 0),
        levelTwoCount: Number(relationCounts.get(lowerEmail(u.email))?.levelTwoCount || 0),
      },
    }))
    // newest first
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  let filtered = users;
  if (q) {
    filtered = users.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q) ||
      u.referral.inviteCode.toLowerCase().includes(q) ||
      u.referral.invitedByEmail.toLowerCase().includes(q)
    );
  }

  return Response.json({
    ok: true,
    total: users.length,
    filteredCount: filtered.length,
    users: filtered,
  });
}
