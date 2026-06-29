// 用户 360 — 某登录用户的访问/行为/归因汇总。仅超级管理员。
// 数据源 = 账号级活动流 lm:uact:<email>（/api/track 在「该账号本人已登录态」下写入）。
// 不再用 IP+UA 设备记录聚合 —— 杜绝同 IP+UA 不同人被并到一起的串号(只显示本人真实浏览)。
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisCmd, redisPipeline, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";

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

  const k = "lm:uact:" + email;
  const res = (await redisPipeline([
    ["HGETALL", k],
    ["LRANGE", k + ":pages", "0", "29"],
    ["LRANGE", k + ":events", "0", "29"],
    ["SCARD", k + ":ips"],
  ])) || [];
  const h = flatToObj(res[0] && res[0].result);
  const pagesRaw = (res[1] && res[1].result) || [];
  const eventsRaw = (res[2] && res[2].result) || [];
  const devices = Number((res[3] && res[3].result) || 0);

  if (!h.count && !pagesRaw.length && !eventsRaw.length) {
    return Response.json({ ok: true, found: false, devices: 0, totalPages: 0, events: [], pages: [], servicesViewed: [], attribution: null });
  }

  let attribution = null;
  if (h.attr) { try { attribution = JSON.parse(h.attr); } catch (e) {} }
  const events = [], pages = [], servicesViewed = new Set();
  eventsRaw.forEach((str) => {
    try { const o = JSON.parse(str); events.push(o); if (o.name === "service_view" && o.slug) servicesViewed.add(o.slug); } catch (e) {}
  });
  pagesRaw.forEach((str) => { try { pages.push(JSON.parse(str)); } catch (e) {} });
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  pages.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const lastSeen = Number(h.lastSeen || 0);
  const fmt = (arr) => arr.slice(0, 30).map((x) => ({ ...x, text: x.ts ? formatBeijingTime(Number(x.ts)) : "" }));

  return Response.json({
    ok: true, found: true,
    devices,
    totalPages: Number(h.count || pages.length || 0),
    lastSeen, lastSeenText: lastSeen ? formatBeijingTime(lastSeen) : "",
    attribution,
    servicesViewed: [...servicesViewed],
    events: fmt(events),
    pages: fmt(pages),
  });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
