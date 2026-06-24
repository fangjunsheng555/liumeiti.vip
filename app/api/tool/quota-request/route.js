// 工具站 AI 配额申请 — 用户侧。提交一条 chat/image 提额申请、查询自己的申请记录。
// 每个 type 同一时间只允许一条 pending 申请,避免重复刷。后台审批见 /api/admin/quota。
import { readQuota, writeQuota } from "../_quota.js";
import {
  getCookieFromRequest,
  verifySession,
  validEmail,
  checkRateLimit,
  rateLimitResponse,
} from "../../_utils.js";

export const runtime = "nodejs";

function authedEmail(request) {
  const s = verifySession(getCookieFromRequest(request, "lm_user"));
  return s && validEmail(s.email) ? String(s.email).toLowerCase() : null;
}

const TYPES = ["chat", "image"];

function clampInt(value, min, max) {
  let n = Math.floor(Number(value));
  if (!Number.isFinite(n)) n = min;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

export async function POST(request) {
  const email = authedEmail(request);
  if (!email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });

  const guard = await checkRateLimit(request, {
    namespace: "tool:quota-req",
    limit: 5,
    windowSec: 600,
    identity: email,
  });
  if (guard && guard.ok === false) return rateLimitResponse(guard);

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const type = TYPES.includes(body.type) ? body.type : "";
  if (!type) return Response.json({ ok: false, error: "bad_type" }, { status: 400 });
  const requested = clampInt(body.requested, 1, 100000);
  const reason = String(body.reason || "").slice(0, 300);

  const data = await readQuota();
  const exists = data.requests.find(
    (r) => r && r.email === email && r.type === type && r.status === "pending"
  );
  if (exists) return Response.json({ ok: false, error: "pending_exists" });

  const req = {
    id: Date.now(),
    email,
    type,
    requested,
    reason: reason || "",
    status: "pending",
    createdAt: Date.now(),
  };
  data.requests.push(req);
  await writeQuota(data);
  return Response.json({ ok: true, request: req });
}

export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  const data = await readQuota();
  const requests = data.requests
    .filter((r) => r && r.email === email)
    .sort((a, b) => (b.createdAt || b.id || 0) - (a.createdAt || a.id || 0));
  return Response.json({ ok: true, requests });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
