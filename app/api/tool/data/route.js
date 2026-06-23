// 工具数据跨设备同步 — 每用户按桶存非敏感数据（收藏 / 常用工具 / AI 历史摘要）。
// 身份 = lm_user 会话。与 /api/tool/2fa 同架构，但收藏类非敏感故不加密。CORS 由 middleware 的 /api/tool/* 覆盖。
import {
  getCookieFromRequest, verifySession, validEmail,
  checkRateLimit, rateLimitResponse, redisCmd,
} from "../../_utils.js";

export const runtime = "nodejs";

const BUCKETS = new Set(["favs", "recent_tools", "ai_history"]);
const MAX_BYTES = 64 * 1024; // 单桶 64KB 上限

function authedEmail(request) {
  const s = verifySession(getCookieFromRequest(request, "lm_user"));
  return s && validEmail(s.email) ? String(s.email).toLowerCase() : null;
}
function dataKey(email, bucket) { return "liumeiti:tool:data:" + email + ":" + bucket; }
function json(obj, status = 200) { return Response.json(obj, { status }); }

export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  const bucket = (new URL(request.url).searchParams.get("bucket") || "").trim();
  if (!BUCKETS.has(bucket)) return json({ ok: false, error: "bad_bucket" }, 400);
  const raw = await redisCmd(["GET", dataKey(email, bucket)]);
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
  return json({ ok: true, bucket, data });
}

export async function PUT(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  const guard = await checkRateLimit(request, { namespace: "tool:data", limit: 30, windowSec: 60, identity: email });
  if (!guard.ok) return rateLimitResponse(guard, "保存太频繁，请稍候再试");
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const bucket = String(body.bucket || "").trim();
  if (!BUCKETS.has(bucket)) return json({ ok: false, error: "bad_bucket" }, 400);
  const str = JSON.stringify(body.data == null ? null : body.data);
  if (str.length > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
  await redisCmd(["SET", dataKey(email, bucket), str]);
  return json({ ok: true });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
