import {
  getCookieFromRequest, verifySession,
  listAllUserEmails, getUser, adminPermissionProfile,
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
  if (!adminPermissionProfile(session).canManageUsers) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();

  const emails = await listAllUserEmails();
  const records = await Promise.all(emails.map((email) => getUser(email)));
  const users = records
    .filter(Boolean)
    .map((u) => ({
      email: u.email || "",
      username: u.username || "",
      balance: Number(u.balance || 0),
      banned: !!u.banned,
      createdAtBeijing: u.createdAtBeijing || "",
      createdAt: u.createdAt || "",
    }))
    // newest first
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  let filtered = users;
  if (q) {
    filtered = users.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q)
    );
  }

  return Response.json({
    ok: true,
    total: users.length,
    filteredCount: filtered.length,
    users: filtered,
  });
}
