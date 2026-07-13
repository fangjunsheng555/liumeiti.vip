import { adminSessionFromRequest, isRootAdminSession } from "../../../_utils.js";
import { listCatalogVersions } from "../../../_catalog-versions.js";

export const runtime = "nodejs";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const state = await listCatalogVersions(60);
  return Response.json({ ok: true, ...state }, { headers: { "Cache-Control": "no-store" } });
}
