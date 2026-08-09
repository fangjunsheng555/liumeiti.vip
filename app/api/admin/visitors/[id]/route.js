// 后台「历史访客」— 单个访客详情 + 其访问过的所有页面。仅超级管理员。
import {
  adminSessionFromRequest, isRootAdminSession, redisPipeline, formatBeijingTime,
} from "../../../_utils.js";

export const runtime = "nodejs";
const PREFIX = "lm:visit:";

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {};
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}

function pipelineRows(value) { return Array.isArray(value) ? value : (Array.isArray(value?.result) ? value.result : []); }
function pipelineValue(entry) { return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result") ? entry.result : entry; }

async function strictVisitorRead(command) {
  // audit-partial-failure: allow partial-failure-pipeline-errors -- Redis command errors invalidate this read; audit-partial-failure: allow partial-failure-pipeline-shape -- The requested row and PING must both arrive before classifying its body.
  const rows = pipelineRows(await redisPipeline([command, ["PING"]]));
  let commandFailed = false;
  for (const entry of rows) if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "error")) commandFailed = true;
  if (rows.length !== 2 || commandFailed || pipelineValue(rows[1]) !== "PONG") throw new Error("visitor_store_unavailable");
  return pipelineValue(rows[0]);
}

export async function GET(request, ctx) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const p = ctx && ctx.params ? await ctx.params : {};
  const id = String(p.id || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
  if (!id) return Response.json({ ok: false, error: "bad_id" }, { status: 400 });

  const vkey = PREFIX + "v:" + id;
  let h;
  try {
    const rawHash = await strictVisitorRead(["HGETALL", vkey]);
    if (!Array.isArray(rawHash) && (!rawHash || typeof rawHash !== "object")) throw new Error("visitor_store_unavailable");
    h = flatToObj(rawHash);
  } catch (error) {
    console.error("[visitors] visitor record unavailable", error?.message || error);
    return Response.json({ ok: false, error: "visitor_store_unavailable" }, { status: 503 });
  }
  if (!h.ip && !h.lastSeen) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  let raw;
  try { raw = await strictVisitorRead(["LRANGE", vkey + ":pages", "0", "-1"]); } catch { raw = null; }
  if (!Array.isArray(raw)) return Response.json({ ok: false, error: "visitor_store_unavailable" }, { status: 503 });
  const pages = [];
  let skippedPages = 0;
  // audit-partial-failure: allow partial-failure-loop-throw -- Each validation throw is caught inside the same callback and only skips that page record.
  raw.forEach((value) => {
    try {
      const o = typeof value === "string" ? JSON.parse(value) : value;
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("invalid_page_record");
      if ((o.site != null && typeof o.site !== "string") || (o.path != null && typeof o.path !== "string")) throw new Error("invalid_page_record");
      const timestamp = o.ts == null || o.ts === "" ? 0 : Number(o.ts);
      if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("invalid_page_record");
      pages.push({ site: o.site || "", path: o.path || "", ts: timestamp, text: timestamp ? formatBeijingTime(timestamp) : "" });
    } catch { skippedPages += 1; }
  });
  if (skippedPages) console.warn("[visitors] skipped unreadable page records", { visitorId: id, skipped: skippedPages });

  return Response.json({ ok: true, visitor: {
    id, ip: h.ip || "", ua: h.ua || "", email: h.email || "", lastSite: h.lastSite || "",
    count: Number(h.count || 0), firstSeen: Number(h.firstSeen || 0),
    firstSeenText: h.firstSeen ? formatBeijingTime(Number(h.firstSeen)) : "",
    lastSeen: Number(h.lastSeen || 0), lastSeenText: h.lastSeen ? formatBeijingTime(Number(h.lastSeen)) : "",
  }, pages });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
