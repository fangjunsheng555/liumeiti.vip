// 工具站 AI 配额 — 后台审批(仅超级管理员)。审批/驳回用户申请、直接设/撤覆盖、删申请。
// 数据共用 /api/tool/_quota.js 的 lm:tool:quota。
import { readQuota, writeQuota, UNLIMITED } from "../../tool/_quota.js";
import { adminSessionFromRequest, isRootAdminSession, validEmail } from "../../_utils.js";

export const runtime = "nodejs";

function gate(request) {
  const s = adminSessionFromRequest(request);
  return s && isRootAdminSession(s) ? s : null;
}

const TYPES = ["chat", "image"];

function decider(session) {
  return String(session.username || session.id || "admin");
}

// 把覆盖按 type+email 去重写入(替换已存在的同键覆盖,否则追加)。
function upsertOverride(overrides, ov) {
  const idx = overrides.findIndex((o) => o && o.type === ov.type && o.email === ov.email);
  if (idx >= 0) overrides[idx] = ov;
  else overrides.push(ov);
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await readQuota();
  const requests = [...data.requests].sort(
    (a, b) => (b.createdAt || b.id || 0) - (a.createdAt || a.id || 0)
  );
  return Response.json({ ok: true, requests, overrides: data.overrides });
}

export async function POST(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = String(body.action || "");
  const data = await readQuota();

  if (action === "approve") {
    const req = data.requests.find((r) => r && Number(r.id) === Number(body.id));
    if (!req) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    req.status = "approved";
    req.decidedAt = Date.now();
    req.decidedBy = decider(session);

    let daily;
    if (body.unlimited) daily = UNLIMITED;
    else if (typeof body.daily === "number" && Number.isFinite(body.daily)) daily = body.daily;
    else daily = req.requested;

    let maxTokens;
    if (req.type === "chat") {
      if (body.tokensUnlimited) maxTokens = UNLIMITED;
      else if (typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)) maxTokens = body.maxTokens;
      else maxTokens = undefined;
    }

    upsertOverride(data.overrides, {
      type: req.type,
      email: req.email,
      daily,
      maxTokens,
      note: "批准申请",
      by: decider(session),
      ts: Date.now(),
    });
    await writeQuota(data);
    return Response.json({ ok: true });
  }

  if (action === "reject") {
    const req = data.requests.find((r) => r && Number(r.id) === Number(body.id));
    if (!req) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    req.status = "rejected";
    req.decidedAt = Date.now();
    req.decidedBy = decider(session);
    await writeQuota(data);
    return Response.json({ ok: true });
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
      else maxTokens = undefined;
    }

    upsertOverride(data.overrides, {
      type,
      email,
      daily,
      maxTokens,
      note: String(body.note || "").slice(0, 200),
      by: decider(session),
      ts: Date.now(),
    });
    await writeQuota(data);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

export async function DELETE(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = String(body.action || "");
  const data = await readQuota();

  if (action === "cancelOverride") {
    const type = TYPES.includes(body.type) ? body.type : "";
    const email = validEmail(body.email) ? String(body.email).toLowerCase() : "";
    if (!type || !email) return Response.json({ ok: false, error: "bad_input" }, { status: 400 });
    data.overrides = data.overrides.filter((o) => !(o && o.type === type && o.email === email));
    await writeQuota(data);
    return Response.json({ ok: true });
  }

  if (action === "cancelRequest") {
    data.requests = data.requests.filter((r) => !(r && Number(r.id) === Number(body.id)));
    await writeQuota(data);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
