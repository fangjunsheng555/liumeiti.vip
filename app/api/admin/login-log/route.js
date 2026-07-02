// 后台登录日志(成功/失败,含 IP/UA)。仅超级管理员。
import { adminSessionFromRequest, isRootAdminSession, getAdminLoginLog } from "../../_utils.js";

export const runtime = "nodejs";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const entries = await getAdminLoginLog(100);
  return Response.json({ ok: true, entries });
}
