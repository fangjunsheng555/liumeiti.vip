// 用户 360 — 某登录用户的访问/行为/归因汇总。仅超级管理员。
// 通过 lm:visit:email:<email>（反向索引，登录时写入）找到该用户的访客记录，聚合页面/事件/来源。
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisCmd, redisPipeline, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";
const V = "lm:visit:v:";

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {}; if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}

export async function GET(request) {
  const s = adminSessionFromRequest(request);
  if (!s || !isRootAdminSession(s)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const email = (new URL(request.url).searchParams.get("email") || "").toLowerCase().trim();
  if (!validEmail(email)) return Response.json({ ok: false, error: "bad_email" }, { status: 400 });

  const vids = (await redisCmd(["SMEMBERS", "lm:visit:email:" + email])) || [];
  if (!vids.length) return Response.json({ ok: true, found: false, devices: 0, totalPages: 0, events: [], pages: [], servicesViewed: [], attribution: null });

  const cap = vids.slice(0, 20);
  const cmds = [];
  cap.forEach((id) => { cmds.push(["HGETALL", V + id], ["LRANGE", V + id + ":events", "0", "29"], ["LRANGE", V + id + ":pages", "0", "29"]); });
  const res = (await redisPipeline(cmds)) || [];

  let totalPages = 0, lastSeen = 0, attribution = null;
  const ips = new Set(), events = [], pages = [], servicesViewed = new Set();
  cap.forEach((id, i) => {
    const h = flatToObj(res[i * 3] && res[i * 3].result);
    totalPages += Number(h.count || 0);
    if (h.ip) ips.add(h.ip);
    if (Number(h.lastSeen || 0) > lastSeen) lastSeen = Number(h.lastSeen || 0);
    if (!attribution && h.attr) { try { attribution = JSON.parse(h.attr); } catch (e) {} }
    ((res[i * 3 + 1] && res[i * 3 + 1].result) || []).forEach((str) => {
      try { const o = JSON.parse(str); events.push(o); if (o.name === "service_view" && o.slug) servicesViewed.add(o.slug); } catch (e) {}
    });
    ((res[i * 3 + 2] && res[i * 3 + 2].result) || []).forEach((str) => { try { pages.push(JSON.parse(str)); } catch (e) {} });
  });
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  pages.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const fmt = (arr) => arr.slice(0, 30).map((x) => ({ ...x, text: x.ts ? formatBeijingTime(Number(x.ts)) : "" }));

  return Response.json({
    ok: true, found: true,
    devices: ips.size,
    totalPages,
    lastSeen, lastSeenText: lastSeen ? formatBeijingTime(lastSeen) : "",
    attribution,
    servicesViewed: [...servicesViewed],
    events: fmt(events),
    pages: fmt(pages),
  });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
