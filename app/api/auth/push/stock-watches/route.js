import { getMergedCatalog } from "../../../_catalog.js";
import {
  addStockWatch,
  getPushAccountState,
  pushStockProductKey,
  removeStockWatch,
} from "../../../_push.js";
import {
  authenticateUserRequest,
  userAuthErrorResponse,
} from "../../../_auth-session.js";
import { checkRateLimit, rateLimitResponse } from "../../../_utils.js";
import { pushMutationRequestError } from "../_request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return { response: userAuthErrorResponse(auth) };
  return { auth };
}

async function validCatalogPlan(service, plan) {
  const key = pushStockProductKey(service, plan);
  if (!key) return false;
  const [serviceKey, planId] = key.split(":");
  const catalog = await getMergedCatalog();
  const product = catalog.find((item) => item.key === serviceKey && item.active !== false);
  return Boolean(product?.plans?.some((item) => item.id === planId && item.active !== false));
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function rateLimited(request, auth) {
  const guard = await checkRateLimit(request, {
    namespace: "push:stock-watch",
    limit: 40,
    windowSec: 10 * 60,
    identity: auth.email,
  });
  return guard.ok ? null : rateLimitResponse(guard, "到货提醒操作过于频繁，请稍后再试");
}

export async function GET(request) {
  const result = await gate(request);
  if (result.response) return result.response;
  const state = await getPushAccountState(result.auth);
  return Response.json(state.ok
    ? { ok: true, watches: state.stockWatches || [] }
    : { ok: false, error: state.error || "storage_unavailable" }, {
    status: state.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request) {
  const requestError = pushMutationRequestError(request);
  if (requestError) return requestError;
  const result = await gate(request);
  if (result.response) return result.response;
  const limited = await rateLimited(request, result.auth);
  if (limited) return limited;
  const body = await readBody(request);
  if (!await validCatalogPlan(body.service, body.plan)) {
    return Response.json({ ok: false, error: "invalid_stock_watch" }, { status: 400 });
  }
  const saved = await addStockWatch(result.auth, body.service, body.plan);
  const status = saved.ok ? 200
    : saved.error === "push_subscription_required" ? 409
      : saved.error === "stock_watch_limit" ? 409
        : 503;
  return Response.json(saved, { status, headers: { "cache-control": "no-store" } });
}

export async function DELETE(request) {
  const requestError = pushMutationRequestError(request);
  if (requestError) return requestError;
  const result = await gate(request);
  if (result.response) return result.response;
  const limited = await rateLimited(request, result.auth);
  if (limited) return limited;
  const body = await readBody(request);
  if (!pushStockProductKey(body.service, body.plan)) {
    return Response.json({ ok: false, error: "invalid_stock_watch" }, { status: 400 });
  }
  const removed = await removeStockWatch(result.auth, body.service, body.plan);
  return Response.json(removed, {
    status: removed.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
