import { adminPermissionProfile, adminSessionFromRequest } from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { confirmPendingUsdtPayments } from "../../_usdt-confirm.js";

export const runtime = "nodejs";
export const maxDuration = 30;

function authorize(request) {
  const session = adminSessionFromRequest(request);
  if (session && adminPermissionProfile(session).canViewOrders) {
    return { ok: true, actor: { staffId: session.staffId, staffUsername: session.staffUsername } };
  }
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  const legacyHeader = request.headers.get("x-cron-secret");
  if (secret && (authorization === `Bearer ${secret}` || legacyHeader === secret)) {
    return { ok: true, actor: { staffId: 0, staffUsername: "cron" } };
  }
  return { ok: false };
}

async function run(request) {
  const auth = authorize(request);
  if (!auth.ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const settings = await getSettings();
  const result = await confirmPendingUsdtPayments({ settings, actor: auth.actor });
  return Response.json(result, {
    status: result.ok ? 200 : result.error === "no_usdt_address" ? 400 : 502,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request) {
  return run(request);
}

export async function GET(request) {
  return run(request);
}
