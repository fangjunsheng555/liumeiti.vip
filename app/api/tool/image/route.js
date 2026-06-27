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
import { getOverride, UNLIMITED, recordAiUsage } from "../_quota.js";

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
const MAX_EDIT_IMAGES = 4;                 // 改图/合成最多带几张参考图
const MAX_IMG_BYTES = 5 * 1024 * 1024;     // 单张解码后上限
const MAX_TOTAL_IMG_BYTES = 9 * 1024 * 1024; // 全部图片总上限(留余量给 Vercel 4.5MB? 注:前端已压;此为兜底)

// base64 → Blob(给 multipart 上传用)。返回 {blob,size} 或 null。
function decodeImage(im) {
  if (!im || typeof im.data !== "string") return null;
  const mt = /^image\/(png|jpe?g|webp)$/i.test(im.media_type || "") ? im.media_type : "image/png";
  let buf;
  try { buf = Buffer.from(im.data, "base64"); } catch (e) { return null; }
  if (!buf || !buf.length) return null;
  return { blob: new Blob([buf], { type: mt }), size: buf.length };
}

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
  const ov = await getOverride("image", email);
  const unlimited = !!(ov && ov.daily === UNLIMITED);
  const limit = unlimited ? -1 : (ov && typeof ov.daily === "number" ? ov.daily : DAILY);
  return json({ ok: true, limit, used, remaining: unlimited ? -1 : Math.max(0, limit - used), unlimited, model: MODEL });
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

  // ── 参考图(改图/抠图/合成):带图走 images/edits,无图走 generations(纯文生图) ──
  const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_EDIT_IMAGES) : [];
  const editBlobs = [];
  let totalImgBytes = 0;
  for (const im of rawImages) {
    const d = decodeImage(im);
    if (!d) continue;
    totalImgBytes += d.size;
    if (d.size > MAX_IMG_BYTES || totalImgBytes > MAX_TOTAL_IMG_BYTES) {
      return json({ ok: false, error: "image_too_large" }, 400);
    }
    editBlobs.push(d.blob);
  }
  const isEdit = editBlobs.length > 0;

  // ── 每用户配额覆盖(后台可设自定义/不限额) ──
  const ov = await getOverride("image", email);
  const unlimited = !!(ov && ov.daily === UNLIMITED);
  const accLimit = unlimited ? Number.MAX_SAFE_INTEGER : (ov && typeof ov.daily === "number" ? ov.daily : DAILY);
  const ipLimitEff = unlimited ? Number.MAX_SAFE_INTEGER : IP_LIMIT;

  // ── reserve quota atomically (INCR-first; fail-closed on Redis outage; refund on failure) ──
  const qk = quotaKey(email), ik = ipKey(request);
  const rsv = await reserveQuota(qk, ik, accLimit, ipLimitEff);
  if (rsv.error) return json(rsv.body, rsv.status);

  let upstream, data;
  try {
    if (isEdit) {
      // 带参考图 → 图像编辑(改图/抠图/合成),multipart 上传
      const form = new FormData();
      form.set("model", MODEL);
      form.set("prompt", prompt);
      form.set("n", "1");
      form.set("size", SIZE);
      editBlobs.forEach((blob, i) => form.append("image[]", blob, "ref" + i + ".png"));
      upstream = await fetch(BASE + "/v1/images/edits", {
        method: "POST",
        headers: { "authorization": "Bearer " + KEY }, // 不设 content-type,让 fetch 自动带 multipart boundary
        body: form,
      });
    } else {
      upstream = await fetch(BASE + "/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + KEY,
        },
        body: JSON.stringify({ model: MODEL, prompt, n: 1, size: SIZE }),
      });
    }
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

  // 计一张「生图用量」(成功出图才计,与配额口径一致)
  await recordAiUsage("image", email);

  return json({
    ok: true,
    image: b64 ? ("data:image/png;base64," + b64) : url,
    prompt,
    remaining: unlimited ? -1 : Math.max(0, accLimit - rsv.acc),
    limit: unlimited ? -1 : accLimit,
    unlimited,
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
