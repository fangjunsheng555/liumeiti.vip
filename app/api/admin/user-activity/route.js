// 用户 360 — 某登录用户的访问/行为/归因汇总。仅超级管理员。
// 数据源(合并去重):
//   ① 账号级活动流 lm:uact:<email>（/api/track 在「本人登录态」下写入,干净、无串号,从修复后累计）。
//   ② 历史设备记录 lm:visit:email:<email> → lm:visit:v:<id>，但**只取该设备主账号==本人**的记录
//      (record.email===本人)——这样别人(你/员工)在共用 IP+UA 上的浏览(其 record.email≠本人)被排除,
//      既找回历史数据、又不把串号带回来。展示再过滤掉 /admin。
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisPipeline, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";
const V = "lm:visit:v:";

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  if (!Array.isArray(v) || v.length % 2 !== 0) return null;
  const o = {}; for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
function pipelineRows(value) { return Array.isArray(value) ? value : (Array.isArray(value?.result) ? value.result : null); }
function pipelineValue(entry) { return entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry; }
function pipelineEntryFailed(entry) { return Boolean(entry && typeof entry === "object" && Object.hasOwn(entry, "error")); }
async function strictPipeline(commands) {
  const rows = pipelineRows(await redisPipeline([...commands, ["PING"]]));
  // audit-partial-failure: allow partial-failure-predicate-abort -- Redis command errors are transport failures, so the whole read must fail rather than fabricate partial activity data.
  if (!rows || rows.length !== commands.length + 1 || rows.some(pipelineEntryFailed)
      || pipelineValue(rows.at(-1)) !== "PONG") throw new Error("user_activity_store_unavailable");
  return rows.slice(0, -1).map(pipelineValue);
}
function parseList(arr, scope) {
  if (!Array.isArray(arr)) throw new Error("user_activity_store_unavailable");
  const out = [];
  let skipped = 0;
  arr.forEach((str) => {
    try {
      const parsed = typeof str === "string" ? JSON.parse(str) : str;
      const numericTimestamp = Number(parsed?.ts);
      const timestamp = Number.isSafeInteger(numericTimestamp) && numericTimestamp >= 0
        ? numericTimestamp
        : (typeof parsed?.ts === "string" ? Date.parse(parsed.ts) : NaN);
      const coreValid = String(scope || "").includes("pages")
        ? typeof parsed?.path === "string" && (parsed?.site == null || typeof parsed.site === "string")
        : typeof parsed?.name === "string";
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !coreValid
          || !Number.isSafeInteger(timestamp) || timestamp < 0) skipped += 1;
      else out.push({ ...parsed, ts: timestamp });
    } catch { skipped += 1; }
  });
  if (skipped) console.warn("[user-activity] skipped unreadable activity records", { scope, skipped });
  return out;
}
// 后台自身页面不显示(主站 /admin)。
function isAdminPage(p) { return p && p.site !== "tool" && /^\/admin(?:[/?]|$)/.test(p.path || ""); }

export async function GET(request) {
  const s = adminSessionFromRequest(request);
  if (!s || !isRootAdminSession(s)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const email = (new URL(request.url).searchParams.get("email") || "").toLowerCase().trim();
  if (!validEmail(email)) return Response.json({ ok: false, error: "bad_email" }, { status: 400 });
  try {

  // ① 账号级活动流
  const k = "lm:uact:" + email;
  const base = await strictPipeline([["HGETALL", k], ["LRANGE", k + ":pages", "0", "49"],
    ["LRANGE", k + ":events", "0", "49"], ["SMEMBERS", k + ":ips"]]);
  const uh = flatToObj(base[0]);
  if (!uh || !Array.isArray(base[1]) || !Array.isArray(base[2]) || !Array.isArray(base[3])) throw new Error("user_activity_store_unavailable");
  const allPages = parseList(base[1], "account-pages");
  const allEvents = parseList(base[2], "account-events");
  const ips = new Set(base[3].filter((value) => typeof value === "string" && value));
  const rawTotalPages = Number(uh.count || 0);
  let totalPages = Number.isSafeInteger(rawTotalPages) && rawTotalPages >= 0 ? rawTotalPages : 0;
  if (uh.count != null && totalPages !== rawTotalPages) console.warn("[user-activity] ignored invalid account activity count", { email });
  let attribution = null;
  if (uh.attr) { try { attribution = JSON.parse(uh.attr); } catch (e) {} }

  // ② 历史设备记录(仅 record.email===本人 的,降串号)
  const [rawVids] = await strictPipeline([["SMEMBERS", "lm:visit:email:" + email]]);
  if (!Array.isArray(rawVids)) throw new Error("user_activity_store_unavailable");
  const vids = Array.from(new Set(rawVids.filter((id) => typeof id === "string" && /^[a-f0-9]{8,32}$/i.test(id))));
  if (vids.length !== rawVids.length) console.warn("[user-activity] skipped invalid visitor index members", { skipped: rawVids.length - vids.length });
  if (vids.length) {
    let acceptedDevices = 0;
    const skippedDevices = [];
    for (let start = 0; start < vids.length && acceptedDevices < 20; start += 20) {
      const batch = vids.slice(start, start + 20);
      const commands = [];
      batch.forEach((id) => { commands.push(["HGETALL", V + id], ["LRANGE", V + id + ":pages", "0", "49"], ["LRANGE", V + id + ":events", "0", "49"]); });
      const values = await strictPipeline(commands);
      batch.forEach((id, i) => {
        if (acceptedDevices >= 20) return;
        const h = flatToObj(values[i * 3]);
        const deviceCount = Number(h?.count || 0);
        if (!h || String(h.email || "").toLowerCase() !== email
            || !Number.isSafeInteger(deviceCount) || deviceCount < 0
            || !Array.isArray(values[i * 3 + 1]) || !Array.isArray(values[i * 3 + 2])) {
          skippedDevices.push(id);
          return;
        }
        acceptedDevices += 1;
        totalPages += deviceCount;
        if (h.ip) ips.add(h.ip);
        if (!attribution && h.attr) { try { attribution = JSON.parse(h.attr); } catch (e) {} }
        parseList(values[i * 3 + 1], `visitor-pages:${id}`).forEach((p) => allPages.push(p));
        parseList(values[i * 3 + 2], `visitor-events:${id}`).forEach((e) => allEvents.push(e));
      });
    }
    if (skippedDevices.length) console.warn("[user-activity] skipped stale or unreadable visitor records", { skipped: skippedDevices.length, ids: skippedDevices.slice(0, 20) });
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

  return Response.json({ ok: true, found: true, devices: ips.size,
    totalPages: Math.max(totalPages, pages.length), lastSeen,
    lastSeenText: lastSeen ? formatBeijingTime(lastSeen) : "", attribution,
    servicesViewed: [...servicesViewed], events: fmt(events), pages: fmt(pages) });
  } catch (error) {
    console.error("[user-activity] read unavailable", error?.message || error);
    return Response.json({ ok: false, error: "user_activity_store_unavailable" }, { status: 503 });
  }
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
