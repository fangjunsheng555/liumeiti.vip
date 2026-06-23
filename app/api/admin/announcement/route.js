// 站内公告 — 后台编辑（仅超级管理员）。GET 当前；POST 设置。
import { adminSessionFromRequest, isRootAdminSession, redisCmd } from "../../_utils.js";

export const runtime = "nodejs";
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let a = { text: "", link: "", active: false, id: 0 };
  try { const raw = await redisCmd(["GET", "lm:announce"]); if (raw) a = { ...a, ...JSON.parse(raw) }; } catch (e) {}
  return Response.json({ ok: true, announce: a });
}

export async function POST(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const text = String(body.text || "").slice(0, 300).trim();
  const link = String(body.link || "").slice(0, 300).trim();
  const active = Boolean(body.active) && !!text;
  const a = { id: Date.now(), text, link, active, updatedAt: Date.now() };
  await redisCmd(["SET", "lm:announce", JSON.stringify(a)]);
  return Response.json({ ok: true, announce: a });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
