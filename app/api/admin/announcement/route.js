// 站内公告 — 后台编辑（仅超级管理员）。GET 当前；POST 设置。
import { adminSessionFromRequest, isRootAdminSession, redisCmd } from "../../_utils.js";

export const runtime = "nodejs";
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }

// 只放行 http(s) 绝对链接或站内相对链接，过滤 javascript:/data: 等危险协议（防 banner XSS）。
function safeLink(v) {
  const s = String(v || "").slice(0, 300).trim();
  if (!s) return "";
  if (s.startsWith("/")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return "";
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let a = { text: "", textEn: "", link: "", active: false, id: 0 };
  try { const raw = await redisCmd(["GET", "lm:announce"]); if (raw) a = { ...a, ...JSON.parse(raw) }; } catch (e) {}
  return Response.json({ ok: true, announce: a });
}

export async function POST(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const text = String(body.text || "").slice(0, 300).trim();
  const textEn = String(body.textEn || "").slice(0, 300).trim();
  const link = safeLink(body.link);
  const active = Boolean(body.active) && !!text;
  const a = { id: Date.now(), text, textEn, link, active, updatedAt: Date.now() };
  await redisCmd(["SET", "lm:announce", JSON.stringify(a)]);
  return Response.json({ ok: true, announce: a });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
