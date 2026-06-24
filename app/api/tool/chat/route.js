// 冒央 AI — lightweight chat, proxied server-side to the relay (Anthropic Messages API).
// Identity = the shared liumeiti.vip account (lm_user). Usage is controlled by a
// per-user daily quota in Redis + a short-window rate limit + input/context caps.
//
// The relay is HTTP-only; by proxying here, the browser↔server hop is HTTPS and
// only this server↔relay hop is plaintext. The relay key never reaches the browser.
// Purely additive — imports existing helpers, edits nothing.

import { createHash } from "node:crypto";
import {
  getCookieFromRequest, verifySession, validEmail,
  checkRateLimit, rateLimitResponse, redisCmd, clientIpFromRequest,
} from "../../_utils.js";
import { getOverride, UNLIMITED } from "../_quota.js";

export const runtime = "nodejs";

const BASE = String(process.env.CHAT_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.CHAT_API_KEY || "";
const MODEL = process.env.CHAT_MODEL || "claude-opus-4-8";
const DAILY = Math.max(1, Number(process.env.CHAT_DAILY_LIMIT || 30));
const MAX_TOKENS = Math.max(64, Number(process.env.CHAT_MAX_TOKENS || 800));
// 「不限 token」用户的单次回复上限(API 仍要求一个数,取一个很高的值≈不限;可用 env 调高）
const MAX_TOKENS_UNLIMITED = Math.max(MAX_TOKENS, Number(process.env.CHAT_MAX_TOKENS_UNLIMITED || 8192));
const IP_LIMIT = Math.max(DAILY, Number(process.env.CHAT_IP_DAILY_LIMIT || DAILY * 2)); // 同 IP 每日总额度（默认=2 个账号份），防换号薅额度

const MAX_TURNS = 6;            // last N exchanges forwarded upstream
const MAX_MSG_CHARS = 2000;     // per message
const MAX_TOTAL_CHARS = 12000;  // safety cap across forwarded text (images excluded)
const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES_PER_MSG = 2;              // vision: images per user message
const MAX_IMG_B64 = 1.4 * 1024 * 1024;     // per-image base64 cap (~1MB image)
const MAX_TOTAL_IMG_B64 = 3 * 1024 * 1024; // aggregate base64 budget across ALL forwarded images — keeps total body under Vercel's ~4.5MB limit
const WEB_SEARCH_MAX_USES = Math.max(1, Number(process.env.CHAT_WEB_SEARCH_MAX_USES || 3));

const SYSTEM = [
  "你是「Maoyang AI」（冒央 AI），冒央会社（liumeiti.vip）旗下的多功能 AI 助手。",
  "你的对话能力由 Claude opus4.8 驱动，文字生成图片能力由 OpenAI image2 驱动。被问到“你是什么模型”时如实说明这一点。",
  "用简洁、友好、准确的中文回答日常问题、写作、答疑、翻译与闲聊；你也支持看图识图、联网搜索、文字生成图片（这些在产品界面里以按钮提供）。",
  "直接给出最终答案，不要输出思考过程或自我分析。",
  "遇到超长、超复杂或需要专门工具的任务（大型代码工程、长文档处理等），礼貌说明你是轻量助手，建议用户使用更专业的工具或服务，不要勉强长篇输出。",
].join("");

function authedEmail(request) {
  const s = verifySession(getCookieFromRequest(request, "lm_user"));
  return s && validEmail(s.email) ? String(s.email).toLowerCase() : null;
}

function beijingDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
function quotaKey(email) {
  return "liumeiti:tool:chat:" + email + ":" + beijingDay();
}
function ipKey(request) {
  const ip = clientIpFromRequest(request) || "unknown";
  const h = createHash("sha256").update("chat-ip:" + ip).digest("hex").slice(0, 24); // 哈希，不存原始 IP
  return "liumeiti:tool:chat:ip:" + h + ":" + beijingDay();
}

function json(obj, status = 200) {
  return Response.json(obj, { status });
}

// length of just the *text* in a message's content (images excluded from char caps)
function textLen(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) if (b && b.type === "text" && typeof b.text === "string") n += b.text.length;
    return n;
  }
  return 0;
}

// Normalize one message's content to a safe string | array-of-blocks, or null if empty.
// Allows text + base64 image blocks (vision, USER role only); drops everything else.
// `budget` = { bytes } shared across the whole conversation to bound total body size.
function sanitizeContent(content, role, budget) {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? t.slice(0, MAX_MSG_CHARS) : null;
  }
  if (Array.isArray(content)) {
    const out = [];
    let imgs = 0;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        const t = b.text.slice(0, MAX_MSG_CHARS);
        if (t.trim()) out.push({ type: "text", text: t });
      } else if (
        role === "user" &&
        b.type === "image" && b.source && b.source.type === "base64" &&
        ALLOWED_MEDIA.has(b.source.media_type) && typeof b.source.data === "string" &&
        b.source.data.length > 0 && b.source.data.length <= MAX_IMG_B64 &&
        imgs < MAX_IMAGES_PER_MSG && budget.bytes >= b.source.data.length
      ) {
        out.push({ type: "image", source: { type: "base64", media_type: b.source.media_type, data: b.source.data } });
        imgs++; budget.bytes -= b.source.data.length;
      }
    }
    return out.length ? out : null;
  }
  return null;
}

// Merge adjacent same-role messages so roles strictly alternate (Anthropic requires it).
function alternate(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content.slice() : [{ type: "text", text: String(last.content) }];
      const b = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
      last.content = a.concat(b);
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

// Atomically reserve one unit against account + IP keys. INCR-first (no GET-then-INCR
// race), fail CLOSED if Redis is unavailable (these routes front paid upstream calls),
// auto-refund the over-limit increment. Returns {ok} or {error,status,body}.
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
  return { ok: true };
}
async function refundQuota(qk, ik) {
  try { await redisCmd(["DECR", qk]); await redisCmd(["DECR", ik]); } catch (e) {}
}

// GET — return today's quota for the UI (no increment).
export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  const used = Number((await redisCmd(["GET", quotaKey(email)])) || 0);
  const ov = await getOverride("chat", email);
  const unlimited = !!(ov && ov.daily === UNLIMITED);
  const limit = unlimited ? -1 : (ov && typeof ov.daily === "number" ? ov.daily : DAILY);
  return json({ ok: true, limit, used, remaining: unlimited ? -1 : Math.max(0, limit - used), unlimited, model: MODEL });
}

// POST — stream a chat completion from the relay. Body: { messages: [{role, content}] }.
export async function POST(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  if (!BASE || !KEY) return json({ ok: false, error: "chat_not_configured" }, 500);

  const guard = await checkRateLimit(request, { namespace: "tool:chat", limit: 20, windowSec: 60, identity: email });
  if (!guard.ok) return rateLimitResponse(guard, "发送太快了，请稍候再试");

  // ── validate + sanitize the conversation (before reserving quota) ──
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const budget = { bytes: MAX_TOTAL_IMG_B64 };
  let msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-MAX_TURNS * 2)
    .map((m) => ({ role: m.role, content: sanitizeContent(m.content, m.role, budget) }))
    .filter((m) => m.content != null);
  msgs = alternate(msgs);                                                  // strict user/assistant alternation
  while (msgs.length && msgs[0].role !== "user") msgs.shift();            // must start with user
  while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop(); // must end with user
  if (!msgs.length) return json({ ok: false, error: "empty_message" }, 400);
  let total = 0;
  for (const m of msgs) total += textLen(m.content);
  if (total > MAX_TOTAL_CHARS) {
    // drop oldest turns until under the cap (by text length; images don't count)
    while (msgs.length > 2 && total > MAX_TOTAL_CHARS) {
      total -= textLen(msgs.shift().content);
      while (msgs.length && msgs[0].role !== "user") total -= textLen(msgs.shift().content);
    }
  }

  // ── 每用户配额覆盖(后台可设自定义/不限额、不限 token) ──
  const ov = await getOverride("chat", email);
  const unlimited = !!(ov && ov.daily === UNLIMITED);
  const accLimit = unlimited ? Number.MAX_SAFE_INTEGER : (ov && typeof ov.daily === "number" ? ov.daily : DAILY);
  const ipLimitEff = unlimited ? Number.MAX_SAFE_INTEGER : IP_LIMIT;
  const effMaxTokens = (ov && ov.maxTokens === UNLIMITED) ? MAX_TOKENS_UNLIMITED
    : (ov && typeof ov.maxTokens === "number" ? Math.max(64, ov.maxTokens) : MAX_TOKENS);

  // ── reserve quota atomically (INCR-first; fail-closed on Redis outage; refund on upstream failure) ──
  const qk = quotaKey(email), ik = ipKey(request);
  const rsv = await reserveQuota(qk, ik, accLimit, ipLimitEff);
  if (rsv.error) return json(rsv.body, rsv.status);

  // 联网搜索：前端开启时挂上 Anthropic 服务端 web_search 工具（实测中转支持）。
  const wantWeb = body.web_search === true || body.web_search === "1";
  const payload = {
    model: MODEL,
    max_tokens: effMaxTokens,
    system: SYSTEM,
    messages: msgs,
    stream: true,
    // No temperature/top_p/thinking — Opus 4.8 rejects sampling params and we want
    // thinking off (snappy). Omitting `thinking` runs without extended thinking.
  };
  if (wantWeb) {
    payload.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }];
  }

  let upstream;
  try {
    upstream = await fetch(BASE + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    await refundQuota(qk, ik); // 上游没连上，不计费
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    await refundQuota(qk, ik); // 上游报错，不计费
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
    return json({ ok: false, error: "upstream_error", status: upstream.status, detail }, 502);
  }

  // stream the relay's SSE straight through to the browser
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
