// 工具数据跨设备同步 — 每用户按桶存非敏感数据（收藏 / 常用工具 / AI 历史摘要）。
// 身份 = lm_user 会话。与 /api/tool/2fa 同架构，但收藏类非敏感故不加密。CORS 由 middleware 的 /api/tool/* 覆盖。
import {
  checkRateLimit, rateLimitResponse, redisCmd,
} from "../../_utils.js";
import { authenticateUserRequest, userAuthErrorResponse } from "../../_auth-session.js";

export const runtime = "nodejs";

const BUCKETS = new Set(["favs", "recent_tools", "ai_history"]);
const MAX_BYTES = 64 * 1024; // 单桶 64KB 上限

function dataKey(email, bucket) { return "liumeiti:tool:data:" + email + ":" + bucket; }
function json(obj, status = 200) { return Response.json(obj, { status }); }

export async function GET(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const email = auth.email;
  const bucket = (new URL(request.url).searchParams.get("bucket") || "").trim();
  if (!BUCKETS.has(bucket)) return json({ ok: false, error: "bad_bucket" }, 400);
  const raw = await redisCmd(["GET", dataKey(email, bucket)]);
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
  return json({ ok: true, bucket, data });
}

export async function PUT(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const email = auth.email;
  const guard = await checkRateLimit(request, { namespace: "tool:data", limit: 30, windowSec: 60, identity: email });
  if (!guard.ok) return rateLimitResponse(guard, "保存太频繁，请稍候再试");
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const bucket = String(body.bucket || "").trim();
  if (!BUCKETS.has(bucket)) return json({ ok: false, error: "bad_bucket" }, 400);
  const str = JSON.stringify(body.data == null ? null : body.data);
  if (Buffer.byteLength(str, "utf8") > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
  const script = `
local function kind(key)
  local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok end; return value
end
if kind(KEYS[2])~='string' then return 'session_state_changed' end
local decoded,user=pcall(cjson.decode,redis.call('GET',KEYS[2]))
if not decoded or type(user)~='table' or user.banned==true then return 'session_state_changed' end
local versionType=kind(KEYS[3])
if versionType~='none' and versionType~='string' then return 'session_state_changed' end
local current=versionType=='string' and tonumber(redis.call('GET',KEYS[3])) or 1
if not current or current~=math.floor(current) or current~=tonumber(ARGV[2]) then return 'session_state_changed' end
redis.call('SET',KEYS[1],ARGV[1])
return 'saved'`;
  const saved = await redisCmd([
    "EVAL",
    script,
    "3",
    dataKey(email, bucket),
    "liumeiti:users:" + email,
    "lm:user:authver:" + email,
    str,
    String(auth.authVersion),
  ]);
  if (saved === "session_state_changed") return json({ ok: false, error: saved }, 401);
  if (saved !== "saved") return json({ ok: false, error: "storage_unavailable" }, 503);
  return json({ ok: true });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
