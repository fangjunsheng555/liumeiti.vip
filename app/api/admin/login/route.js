import {
  verifyAdminLogin, signSession, setCookieValue, clearCookieValue,
  checkRateLimit, rateLimitResponse, pushAdminActionLog,
  clientIpFromRequest, clientUserAgentFromRequest,
  adminPermissionProfile,
} from "../../_utils.js";

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

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

  const sessionPayload = {
    role: "admin",
    staffId: login.staff.id,
    staffUsername: login.staff.username,
    staffRole: login.staff.role || (login.staff.root ? "owner" : "operator"),
    staffRoot: Boolean(login.staff.root),
    staffPerms: login.staff.perms || undefined, // 细粒度权限覆盖(登录时嵌入,改权限后踢下线重登生效)
    iat: Date.now(), // 签发时间:配合 lm:staff:kick:<id> 实现强制下线
    exp: Date.now() + ADMIN_SESSION_SECONDS * 1000,
  };
  const token = signSession(sessionPayload);
  const staff = {
    ...login.staff,
    role: sessionPayload.staffRole,
    root: Boolean(login.staff.root),
    permissions: adminPermissionProfile(sessionPayload),
  };
  await pushAdminActionLog({
    action: "admin_login",
    actor: { staffId: login.staff.id, staffUsername: login.staff.username },
    target: "staff:" + login.staff.id,
    detail: { ip: clientIpFromRequest(request), userAgent: clientUserAgentFromRequest(request) },
  });
  return Response.json({ ok: true, staff }, {
    headers: { "Set-Cookie": setCookieValue("lm_admin", token, ADMIN_SESSION_SECONDS) },
  });
}

export async function DELETE() {
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": clearCookieValue("lm_admin") },
  });
}
