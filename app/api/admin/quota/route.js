import {
  UNLIMITED,
  cancelQuotaOverride,
  cancelQuotaRequest,
  decideQuotaRequest,
  readQuotaState,
  setQuotaOverride,
} from "../../tool/_quota.js";
import { adminSessionFromRequest, isRootAdminSession, validEmail } from "../../_utils.js";

export const runtime = "nodejs";

const TYPES = ["chat", "image"];

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

function decider(session) {
  return String(session.username || session.id || "admin");
}

function mutationError(result) {
  const status = result?.error === "not_found" ? 404
    : result?.error === "request_already_decided" ? 409 : 503;
  return Response.json({ ok: false, error: result?.error || "quota_store_unavailable" }, { status });
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const state = await readQuotaState();
  if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 503 });
  const requests = [...state.data.requests].sort(
    (left, right) => (right.createdAt || right.id || 0) - (left.createdAt || left.id || 0),
  );
  return Response.json({ ok: true, requests, overrides: state.data.overrides });
}

export async function POST(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch {}
  const action = String(body.action || "");

  if (action === "approve") {
    const state = await readQuotaState();
    if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 503 });
    const requestEntry = state.data.requests.find((entry) => entry && String(entry.id) === String(body.id));
    if (!requestEntry) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    const daily = body.unlimited
      ? UNLIMITED
      : (typeof body.daily === "number" && Number.isFinite(body.daily) ? body.daily : requestEntry.requested);
    let maxTokens;
    if (requestEntry.type === "chat") {
      if (body.tokensUnlimited) maxTokens = UNLIMITED;
      else if (typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)) maxTokens = body.maxTokens;
    }
    const result = await decideQuotaRequest({
      id: body.id,
      status: "approved",
      decidedBy: decider(session),
      override: {
        type: requestEntry.type,
        email: requestEntry.email,
        daily,
        maxTokens,
        note: "批准申请",
        by: decider(session),
        ts: Date.now(),
      },
    });
    return result.ok
      ? Response.json({ ok: true, idempotent: Boolean(result.idempotent) })
      : mutationError(result);
  }

  if (action === "reject") {
    const result = await decideQuotaRequest({
      id: body.id,
      status: "rejected",
      decidedBy: decider(session),
    });
    return result.ok
      ? Response.json({ ok: true, idempotent: Boolean(result.idempotent) })
      : mutationError(result);
  }

  if (action === "setOverride") {
    const type = TYPES.includes(body.type) ? body.type : "";
    const email = validEmail(body.email) ? String(body.email).toLowerCase() : "";
    if (!type || !email) return Response.json({ ok: false, error: "bad_input" }, { status: 400 });
    const daily = body.unlimited ? UNLIMITED : Number(body.daily);
    if (daily !== UNLIMITED && !Number.isFinite(daily)) {
      return Response.json({ ok: false, error: "bad_daily" }, { status: 400 });
    }
    let maxTokens;
    if (type === "chat") {
      if (body.tokensUnlimited) maxTokens = UNLIMITED;
      else if (typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)) maxTokens = body.maxTokens;
    }
    const result = await setQuotaOverride({
      type,
      email,
      daily,
      maxTokens,
      note: String(body.note || "").slice(0, 200),
      by: decider(session),
      ts: Date.now(),
    });
    return result.ok ? Response.json({ ok: true }) : mutationError(result);
  }

  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

export async function DELETE(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch {}
  const action = String(body.action || "");

  if (action === "cancelOverride") {
    const type = TYPES.includes(body.type) ? body.type : "";
    const email = validEmail(body.email) ? String(body.email).toLowerCase() : "";
    if (!type || !email) return Response.json({ ok: false, error: "bad_input" }, { status: 400 });
    const result = await cancelQuotaOverride(type, email);
    return result.ok ? Response.json({ ok: true }) : mutationError(result);
  }

  if (action === "cancelRequest") {
    const result = await cancelQuotaRequest(body.id);
    return result.ok ? Response.json({ ok: true }) : mutationError(result);
  }

  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
