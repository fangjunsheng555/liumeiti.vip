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

export const runtime = "nodejs";

const BASE = String(process.env.CHAT_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.CHAT_API_KEY || "";
const MODEL = process.env.CHAT_MODEL || "claude-opus-4-8";
const DAILY = Math.max(1, Number(process.env.CHAT_DAILY_LIMIT || 30));
const MAX_TOKENS = Math.max(64, Number(process.env.CHAT_MAX_TOKENS || 800));
const IP_LIMIT = Math.max(DAILY, Number(process.env.CHAT_IP_DAILY_LIMIT || DAILY * 2)); // 同 IP 每日总额度（默认=2 个账号份），防换号薅额度

const MAX_TURNS = 6;            // last N exchanges forwarded upstream
const MAX_MSG_CHARS = 2000;     // per message
const MAX_TOTAL_CHARS = 12000;  // safety cap across forwarded messages

const SYSTEM = [
  "你是「Claude opus4.8 AI」，冒央会社（liumeiti.vip）旗下的轻量日常助手。",
  "用简洁、友好、准确的中文回答日常问题、写作、答疑与闲聊。",
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

// GET — return today's quota for the UI (no increment).
export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  const used = Number((await redisCmd(["GET", quotaKey(email)])) || 0);
  return json({ ok: true, limit: DAILY, used, remaining: Math.max(0, DAILY - used), model: MODEL });
}

// POST — stream a chat completion from the relay. Body: { messages: [{role, content}] }.
export async function POST(request) {
  const email = authedEmail(request);
  if (!email) return json({ ok: false, error: "not_logged_in" }, 401);
  if (!BASE || !KEY) return json({ ok: false, error: "chat_not_configured" }, 500);

  const guard = await checkRateLimit(request, { namespace: "tool:chat", limit: 20, windowSec: 60, identity: email });
  if (!guard.ok) return rateLimitResponse(guard, "发送太快了，请稍候再试");

  const qk = quotaKey(email);
  const used = Number((await redisCmd(["GET", qk])) || 0);
  if (used >= DAILY) return json({ ok: false, error: "quota_exceeded", limit: DAILY, used }, 429);

  // 同 IP 防刷：账号额度之外再限每 IP 每日总量（默认 40）。前端不暴露此维度，被卡时按"额度用完"处理。
  const ik = ipKey(request);
  const ipUsed = Number((await redisCmd(["GET", ik])) || 0);
  if (ipUsed >= IP_LIMIT) return json({ ok: false, error: "quota_exceeded", limit: DAILY, used }, 429);

  // ── validate + sanitize the conversation ──
  let body = {};
  try { body = await request.json(); } catch (e) {}
  let msgs = Array.isArray(body.messages) ? body.messages : [];
  msgs = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }))
    .slice(-MAX_TURNS * 2);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();           // must start with user
  while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop(); // must end with user
  if (!msgs.length) return json({ ok: false, error: "empty_message" }, 400);
  let total = 0;
  for (const m of msgs) total += m.content.length;
  if (total > MAX_TOTAL_CHARS) {
    // drop oldest turns until under the cap
    while (msgs.length > 2 && total > MAX_TOTAL_CHARS) {
      total -= (msgs.shift().content.length || 0);
      while (msgs.length && msgs[0].role !== "user") total -= (msgs.shift().content.length || 0);
    }
  }

  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: msgs,
    stream: true,
    // No temperature/top_p/thinking — Opus 4.8 rejects sampling params and we want
    // thinking off (snappy). Omitting `thinking` runs without extended thinking.
  };

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
    return json({ ok: false, error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
    return json({ ok: false, error: "upstream_error", status: upstream.status, detail }, 502);
  }

  // count one use only after a successful upstream connection
  const n = Number((await redisCmd(["INCR", qk])) || 0);
  if (n === 1) await redisCmd(["EXPIRE", qk, "129600"]); // ~36h, covers the day boundary
  const ipN = Number((await redisCmd(["INCR", ik])) || 0); // 同 IP 计数同步 +1
  if (ipN === 1) await redisCmd(["EXPIRE", ik, "129600"]);

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
