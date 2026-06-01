import {
  verifyAdminLogin, signSession, setCookieValue, clearCookieValue,
  checkRateLimit, rateLimitResponse, pushAdminActionLog,
  clientIpFromRequest, clientUserAgentFromRequest,
} from "../../_utils.js";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const username = String(body.username || "");
  const password = String(body.password || "");
  const guard = await checkRateLimit(request, {
    namespace: "admin:login",
    limit: 6,
    windowSec: 15 * 60,
    identity: username,
  });
  if (!guard.ok) return rateLimitResponse(guard, "后台登录尝试过多，请稍后再试");

  const login = await verifyAdminLogin(username, password);
  if (!login.ok) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  const token = signSession({
    role: "admin",
    staffId: login.staff.id,
    staffUsername: login.staff.username,
    staffRole: login.staff.role || (login.staff.root ? "owner" : "operator"),
    staffRoot: Boolean(login.staff.root),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  });
  await pushAdminActionLog({
    action: "admin_login",
    actor: { staffId: login.staff.id, staffUsername: login.staff.username },
    target: "staff:" + login.staff.id,
    detail: { ip: clientIpFromRequest(request), userAgent: clientUserAgentFromRequest(request) },
  });
  return Response.json({ ok: true, staff: login.staff }, {
    headers: { "Set-Cookie": setCookieValue("lm_admin", token, 12 * 60 * 60) },
  });
}

export async function DELETE() {
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": clearCookieValue("lm_admin") },
  });
}
