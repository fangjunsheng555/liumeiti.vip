import { createQuotaRequest, readQuotaState } from "../_quota.js";
import { checkRateLimit, rateLimitResponse } from "../../_utils.js";
import { authenticateUserRequest, userAuthErrorResponse } from "../../_auth-session.js";

export const runtime = "nodejs";

const TYPES = ["chat", "image"];

function clampInt(value, min, max) {
  let number = Math.floor(Number(value));
  if (!Number.isFinite(number)) number = min;
  return Math.max(min, Math.min(max, number));
}

export async function POST(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const guard = await checkRateLimit(request, {
    namespace: "tool:quota-req",
    limit: 5,
    windowSec: 600,
    identity: auth.email,
  });
  if (!guard.ok) return rateLimitResponse(guard);

  let body = {};
  try { body = await request.json(); } catch {}
  const type = TYPES.includes(body.type) ? body.type : "";
  if (!type) return Response.json({ ok: false, error: "bad_type" }, { status: 400 });
  const result = await createQuotaRequest({
    email: auth.email,
    authVersion: auth.authVersion,
    type,
    requested: clampInt(body.requested, 1, 100000),
    reason: String(body.reason || "").slice(0, 300),
  });
  if (!result.ok) {
    const status = result.error === "pending_exists" ? 409
      : result.error === "session_state_changed" ? 401 : 503;
    return Response.json({ ok: false, error: result.error, request: result.request }, { status });
  }
  return Response.json({ ok: true, request: result.request });
}

export async function GET(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const state = await readQuotaState();
  if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 503 });
  const requests = state.data.requests
    .filter((entry) => entry?.email === auth.email)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  return Response.json({ ok: true, requests });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
