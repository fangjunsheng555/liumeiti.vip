// 后台「历史访客」— 单个访客详情 + 其访问过的所有页面。仅超级管理员。
import {
  adminSessionFromRequest, isRootAdminSession, redisCmd, formatBeijingTime,
} from "../../../_utils.js";

export const runtime = "nodejs";
const PREFIX = "lm:visit:";

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {};
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}

export async function GET(request, ctx) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const p = ctx && ctx.params ? await ctx.params : {};
  const id = String(p.id || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
  if (!id) return Response.json({ ok: false, error: "bad_id" }, { status: 400 });

  const vkey = PREFIX + "v:" + id;
  const h = flatToObj(await redisCmd(["HGETALL", vkey]));
  if (!h.ip && !h.lastSeen) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const raw = (await redisCmd(["LRANGE", vkey + ":pages", "0", "-1"])) || [];
  const pages = raw.map((s) => {
    try { const o = JSON.parse(s); return { site: o.site || "", path: o.path || "", ts: Number(o.ts || 0), text: o.ts ? formatBeijingTime(Number(o.ts)) : "" }; }
    catch (e) { return null; }
  }).filter(Boolean);

  return Response.json({
    ok: true,
    visitor: {
      id,
      ip: h.ip || "",
      ua: h.ua || "",
      email: h.email || "",
      lastSite: h.lastSite || "",
      count: Number(h.count || 0),
      firstSeen: Number(h.firstSeen || 0),
      firstSeenText: h.firstSeen ? formatBeijingTime(Number(h.firstSeen)) : "",
      lastSeen: Number(h.lastSeen || 0),
      lastSeenText: h.lastSeen ? formatBeijingTime(Number(h.lastSeen)) : "",
    },
    pages,
  });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
