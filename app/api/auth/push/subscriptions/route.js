import {
  bindPushSubscription,
  getPushAccountState,
  removePushSubscription,
  updatePushPreferences,
} from "../../../_push.js";
import {
  authenticateUserRequest,
  userAuthErrorResponse,
} from "../../../_auth-session.js";
import { checkRateLimit, rateLimitResponse } from "../../../_utils.js";
import { pushMutationRequestError } from "../_request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authenticated(request) {
  const auth = await authenticateUserRequest(request);
  return auth.ok ? { auth } : { response: userAuthErrorResponse(auth) };
}

async function guarded(request, auth, action) {
  const guard = await checkRateLimit(request, {
    namespace: `push:${action}`,
    limit: action === "bind" ? 20 : 40,
    windowSec: 10 * 60,
    identity: auth.email,
  });
  return guard.ok ? null : rateLimitResponse(guard, "通知设置操作过于频繁，请稍后再试");
}

export async function GET(request) {
  const gate = await authenticated(request);
  if (gate.response) return gate.response;
  const state = await getPushAccountState(gate.auth);
  return Response.json(state, {
    status: state.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request) {
  const requestError = pushMutationRequestError(request);
  if (requestError) return requestError;
  const gate = await authenticated(request);
  if (gate.response) return gate.response;
  const limited = await guarded(request, gate.auth, "bind");
  if (limited) return limited;
  let body = {};
  try { body = await request.json(); } catch {}
  const result = await bindPushSubscription(gate.auth, body.subscription, {
    locale: body.locale,
    preferences: body.preferences,
  });
  const status = result.ok ? 200
    : ["invalid_subscription", "subscription_required"].includes(result.error) ? 400
      : result.error === "subscription_limit" ? 409
        : result.error === "push_disabled" ? 409
          : 503;
  return Response.json(result, { status, headers: { "cache-control": "no-store" } });
}

export async function PATCH(request) {
  const requestError = pushMutationRequestError(request);
  if (requestError) return requestError;
  const gate = await authenticated(request);
  if (gate.response) return gate.response;
  const limited = await guarded(request, gate.auth, "preferences");
  if (limited) return limited;
  let body = null;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: "invalid_json" }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ ok: false, error: "invalid_json" }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const result = await updatePushPreferences(gate.auth, body.preferences || body);
  return Response.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export async function DELETE(request) {
  const requestError = pushMutationRequestError(request);
  if (requestError) return requestError;
  const gate = await authenticated(request);
  if (gate.response) return gate.response;
  const limited = await guarded(request, gate.auth, "remove");
  if (limited) return limited;
  let body = {};
  try { body = await request.json(); } catch {}
  const result = await removePushSubscription(gate.auth, {
    endpoint: body.endpoint,
    allDevices: body.allDevices === true,
  });
  const status = result.ok ? 200
    : result.error === "subscription_required" ? 400
      : result.error === "storage_unavailable" ? 503
        : 409;
  return Response.json(result, { status, headers: { "cache-control": "no-store" } });
}
