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
export const maxDuration = 60; // image generation can take 10–30s

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

  const qk = quotaKey(email);
  const used = Number((await redisCmd(["GET", qk])) || 0);
  if (used >= DAILY) return json({ ok: false, error: "quota_exceeded", limit: DAILY, used }, 429);

  // 同 IP 防刷：账号额度之外再限每 IP 每日总量。任一超限即拒，前端按"额度用完"处理（不暴露 IP 维度）。
  const ik = ipKey(request);
  const ipUsed = Number((await redisCmd(["GET", ik])) || 0);
  if (ipUsed >= IP_LIMIT) return json({ ok: false, error: "quota_exceeded", limit: DAILY, used }, 429);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return json({ ok: false, error: "empty_prompt" }, 400);

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
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  try { data = await upstream.json(); } catch (e) { data = null; }

  if (!upstream.ok || !data || data.error) {
    const msg = (data && data.error && data.error.message) || "";
    // surface a friendly hint for the relay's transient "no account pool" state
    const transient = /no available|compatible account|overload/i.test(msg);
    return json({ ok: false, error: transient ? "upstream_busy" : "upstream_error", detail: String(msg).slice(0, 200) }, 502);
  }

  const item = (Array.isArray(data.data) && data.data[0]) || {};
  const b64 = item.b64_json || "";
  const url = item.url || "";
  if (!b64 && !url) return json({ ok: false, error: "no_image" }, 502);

  // count one use only after a successful generation
  const n = Number((await redisCmd(["INCR", qk])) || 0);
  if (n === 1) await redisCmd(["EXPIRE", qk, "129600"]); // ~36h, covers the day boundary
  const ipN = Number((await redisCmd(["INCR", ik])) || 0);
  if (ipN === 1) await redisCmd(["EXPIRE", ik, "129600"]);

  return json({
    ok: true,
    image: b64 ? ("data:image/png;base64," + b64) : url,
    prompt,
    remaining: Math.max(0, DAILY - n),
    limit: DAILY,
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
