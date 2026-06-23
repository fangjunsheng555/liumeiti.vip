// 文生图 — server-side proxy to the relay's OpenAI-compatible images endpoint.
// Identity = the shared liumeiti.vip account (lm_user). Because image generation
// is expensive, it has its own tight daily quota: per-account + a silent per-IP cap
// (same anti-abuse shape as the chat route). The frontend only ever sees the
// account dimension; the IP cap is never surfaced.
//
// The relay is HTTP-only; proxying here keeps the browser↔server hop HTTPS and the
// relay key out of the browser. Purely additive — reuses existing helpers.

import { createHash } from "node:crypto";
import {
  getCookieFromRequest, verifySession, validEmail,
  checkRateLimit, rateLimitResponse, redisCmd, clientIpFromRequest,
} from "../../_utils.js";

export const runtime = "nodejs";
export const maxDuration = 300; // gpt-image-2 实测：简单图 ~30s，复杂图 60–80s+。给足时间别让函数掐断（需 Vercel 套餐允许，或开启 Fluid Compute）

// Base/key default to the chat relay's base but a SEPARATE key (OpenAI-format,
// Bearer). The relay exposes both Anthropic (/v1/messages, x-api-key) and
// OpenAI (/v1/images/generations, Bearer) surfaces on the same host.
const BASE = String(process.env.IMAGE_BASE_URL || process.env.CHAT_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.IMAGE_API_KEY || "";
const MODEL = process.env.IMAGE_MODEL || "gpt-image-2"; // image-1/1.5 have no account pool on the relay
const SIZE = process.env.IMAGE_SIZE || "1024x1024";
const DAILY = Math.max(1, Number(process.env.IMAGE_DAILY_LIMIT || 2));            // 每账号每日
const IP_LIMIT = Math.max(DAILY, Number(process.env.IMAGE_IP_DAILY_LIMIT || DAILY * 2)); // 每 IP 每日（默认 2 个账号份）
const MAX_PROMPT = 1000;

function authedEmail(request) {
  const s = verifySession(getCookieFromRequest(request, "lm_user"));
  return s && validEmail(s.email) ? String(s.email).toLowerCase() : null;
}
function beijingDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
function quotaKey(email) {
  return "liumeiti:tool:image:" + email + ":" + beijingDay();
}
function ipKey(request) {
  const ip = clientIpFromRequest(request) || "unknown";
  const h = createHash("sha256").update("image-ip:" + ip).digest("hex").slice(0, 24); // 哈希，不存原始 IP
  return "liumeiti:tool:image:ip:" + h + ":" + beijingDay();
}
function json(obj, status = 200) {
  return Response.json(obj, { status });
}

// Atomically reserve one unit against account + IP keys. INCR-first (no GET-then-INCR
// race), fail CLOSED on Redis outage, auto-refund the over-limit increment.
// Returns { ok, acc } or { error, status, body }.
async function reserveQuota(qk, ik, accLimit, ipLimit) {
  const aRaw = await redisCmd(["INCR", qk]);
  if (aRaw == null) return { error: true, status: 503, body: { ok: false, error: "quota_unavailable" } };
  const a = Number(aRaw);
  if (a === 1) await redisCmd(["EXPIRE", qk, "129600"]);
  const iRaw = await redisCmd(["INCR", ik]);
  if (iRaw == null) { await redisCmd(["DECR", qk]); return { error: true, status: 503, body: { ok: false, error: "quota_unavailable" } }; }
  const i = Number(iRaw);
  if (i === 1) await redisCmd(["EXPIRE", ik, "129600"]);
  if (a > accLimit || i > ipLimit) {
    await redisCmd(["DECR", qk]); await redisCmd(["DECR", ik]);
    return { error: true, status: 429, body: { ok: false, error: "quota_exceeded", limit: accLimit, used: Math.min(a - 1, accLimit) } };
  }
  return { ok: true, acc: a };
}
async function refundQuota(qk, ik) {
  try { await redisCmd(["DECR", qk]); await redisCmd(["DECR", ik]); } catch (e) {}
}

// GET — today's account quota for the UI (no increment, no IP info leaked).
export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  const used = Number((await redisCmd(["GET", quotaKey(email)])) || 0);
  return json({ ok: true, limit: DAILY, used, remaining: Math.max(0, DAILY - used), model: MODEL });
}

// POST — generate one image. Body: { prompt: string }.
export async function POST(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  if (!BASE || !KEY) return json({ ok: false, error: "image_not_configured" }, 500);

  const guard = await checkRateLimit(request, { namespace: "tool:image", limit: 6, windowSec: 60, identity: email });
  if (!guard.ok) return rateLimitResponse(guard, "生成太快了，请稍候再试");

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return json({ ok: false, error: "empty_prompt" }, 400);

  // ── reserve quota atomically (INCR-first; fail-closed on Redis outage; refund on failure) ──
  const qk = quotaKey(email), ik = ipKey(request);
  const rsv = await reserveQuota(qk, ik, DAILY, IP_LIMIT);
  if (rsv.error) return json(rsv.body, rsv.status);

  let upstream, data;
  try {
    upstream = await fetch(BASE + "/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + KEY,
      },
      body: JSON.stringify({ model: MODEL, prompt, n: 1, size: SIZE }),
    });
  } catch (e) {
    await refundQuota(qk, ik);
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  try { data = await upstream.json(); } catch (e) { data = null; }

  if (!upstream.ok || !data || data.error) {
    await refundQuota(qk, ik); // 生成失败，不计费
    const msg = (data && data.error && data.error.message) || "";
    // surface a friendly hint for the relay's transient "no account pool" state
    const transient = /no available|compatible account|overload/i.test(msg);
    return json({ ok: false, error: transient ? "upstream_busy" : "upstream_error", detail: String(msg).slice(0, 200) }, 502);
  }

  const item = (Array.isArray(data.data) && data.data[0]) || {};
  const b64 = item.b64_json || "";
  const url = item.url || "";
  if (!b64 && !url) { await refundQuota(qk, ik); return json({ ok: false, error: "no_image" }, 502); }

  return json({
    ok: true,
    image: b64 ? ("data:image/png;base64," + b64) : url,
    prompt,
    remaining: Math.max(0, DAILY - rsv.acc),
    limit: DAILY,
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
