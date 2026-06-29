// 用户 360 — 某登录用户的访问/行为/归因汇总。仅超级管理员。
// 数据源(合并去重):
//   ① 账号级活动流 lm:uact:<email>（/api/track 在「本人登录态」下写入,干净、无串号,从修复后累计）。
//   ② 历史设备记录 lm:visit:email:<email> → lm:visit:v:<id>，但**只取该设备主账号==本人**的记录
//      (record.email===本人)——这样别人(你/员工)在共用 IP+UA 上的浏览(其 record.email≠本人)被排除,
//      既找回历史数据、又不把串号带回来。展示再过滤掉 /admin。
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
function parseList(arr) {
  const out = [];
  (arr || []).forEach((str) => { try { out.push(JSON.parse(str)); } catch (e) {} });
  return out;
}
// 后台自身页面不显示(主站 /admin)。
function isAdminPage(p) { return p && p.site !== "tool" && /^\/admin(?:[/?]|$)/.test(p.path || ""); }

export async function GET(request) {
  const s = adminSessionFromRequest(request);
  if (!s || !isRootAdminSession(s)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const email = (new URL(request.url).searchParams.get("email") || "").toLowerCase().trim();
  if (!validEmail(email)) return Response.json({ ok: false, error: "bad_email" }, { status: 400 });

  // ① 账号级活动流
  const k = "lm:uact:" + email;
  const base = (await redisPipeline([
    ["HGETALL", k],
    ["LRANGE", k + ":pages", "0", "49"],
    ["LRANGE", k + ":events", "0", "49"],
    ["SMEMBERS", k + ":ips"],
  ])) || [];
  const uh = flatToObj(base[0] && base[0].result);
  const allPages = parseList(base[1] && base[1].result);
  const allEvents = parseList(base[2] && base[2].result);
  const ips = new Set((base[3] && base[3].result) || []);
  let totalPages = Number(uh.count || 0);
  let attribution = null;
  if (uh.attr) { try { attribution = JSON.parse(uh.attr); } catch (e) {} }

  // ② 历史设备记录(仅 record.email===本人 的,降串号)
  const vids = ((await redisCmd(["SMEMBERS", "lm:visit:email:" + email])) || []).slice(0, 20);
  if (vids.length) {
    const cmds = [];
    vids.forEach((id) => { cmds.push(["HGETALL", V + id], ["LRANGE", V + id + ":pages", "0", "49"], ["LRANGE", V + id + ":events", "0", "49"]); });
    const r = (await redisPipeline(cmds)) || [];
    vids.forEach((id, i) => {
      const h = flatToObj(r[i * 3] && r[i * 3].result);
      if (String(h.email || "").toLowerCase() !== email) return; // 该设备主账号不是本人 → 跳过(剔除你/员工的浏览)
      totalPages += Number(h.count || 0);
      if (h.ip) ips.add(h.ip);
      if (!attribution && h.attr) { try { attribution = JSON.parse(h.attr); } catch (e) {} }
      parseList(r[i * 3 + 1] && r[i * 3 + 1].result).forEach((p) => allPages.push(p));
      parseList(r[i * 3 + 2] && r[i * 3 + 2].result).forEach((e) => allEvents.push(e));
    });
  }

  // 合并去重(①②可能因双写重叠) + 过滤 /admin + 排序
  const pageMap = new Map();
  allPages.forEach((p) => { if (!p || isAdminPage(p)) return; pageMap.set((p.site || "") + "|" + (p.path || "") + "|" + (p.ts || ""), p); });
  const evMap = new Map();
  const servicesViewed = new Set();
  allEvents.forEach((e) => { if (!e) return; evMap.set((e.name || "") + "|" + (e.slug || "") + "|" + (e.ts || ""), e); if (e.name === "service_view" && e.slug) servicesViewed.add(e.slug); });
  const pages = [...pageMap.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const events = [...evMap.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!pages.length && !events.length && !totalPages) {
    return Response.json({ ok: true, found: false, devices: 0, totalPages: 0, events: [], pages: [], servicesViewed: [], attribution: null });
  }

  let lastSeen = Number(uh.lastSeen || 0);
  pages.forEach((p) => { if (Number(p.ts || 0) > lastSeen) lastSeen = Number(p.ts || 0); });
  const fmt = (arr) => arr.slice(0, 30).map((x) => ({ ...x, text: x.ts ? formatBeijingTime(Number(x.ts)) : "" }));

  return Response.json({
    ok: true, found: true,
    devices: ips.size,
    totalPages: Math.max(totalPages, pages.length),
    lastSeen, lastSeenText: lastSeen ? formatBeijingTime(lastSeen) : "",
    attribution,
    servicesViewed: [...servicesViewed],
    events: fmt(events),
    pages: fmt(pages),
  });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
