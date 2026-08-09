// 后台「历史访客」— 列表 + 批量删除。仅超级管理员（staffId===1）。
// 数据来自 /api/track 写入的 Redis：
//   lm:visit:index  ZSET(score=lastSeenMs)  ;  lm:visit:v:<id> HASH  ;  lm:visit:v:<id>:pages LIST
import {
  adminSessionFromRequest, isRootAdminSession, redisCmd, redisPipeline, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";

const PREFIX = "lm:visit:";
const INDEX = PREFIX + "index";
const SEARCH_SCAN = 2000;     // IP/邮箱搜索时最多扫描的最近访客数
const DEL_BATCH_MAX = 3000;   // 单次「按时间」批量删除上限

function unauth() { return Response.json({ ok: false, error: "unauthorized" }, { status: 401 }); }
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }

// Upstash HGETALL 可能返回扁平数组 [f,v,f,v] 或对象，统一成对象
function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {};
  if (!Array.isArray(v) || v.length % 2 !== 0) return null;
  for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
function pipelineRows(value) { return Array.isArray(value) ? value : (Array.isArray(value?.result) ? value.result : null); }
function pipelineValue(entry) { return entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry; }
function pipelineEntryFailed(entry) { return Boolean(entry && typeof entry === "object" && Object.hasOwn(entry, "error")); }
async function strictPipeline(commands) {
  const rows = pipelineRows(await redisPipeline([...commands, ["PING"]]));
  // audit-partial-failure: allow partial-failure-predicate-abort -- Redis command errors are transport failures, so the whole read must fail rather than fabricate partial visitor data.
  if (!rows || rows.length !== commands.length + 1 || rows.some(pipelineEntryFailed)
      || pipelineValue(rows.at(-1)) !== "PONG") throw new Error("visitor_store_unavailable");
  return rows.slice(0, -1).map(pipelineValue);
}
function validVisitorHash(hash) {
  if (!hash || typeof hash !== "object" || Array.isArray(hash)) return false;
  const lastSeen = Number(hash.lastSeen);
  const firstSeen = Number(hash.firstSeen);
  const count = Number(hash.count || 0);
  return ((Number.isSafeInteger(lastSeen) && lastSeen > 0) || (Number.isSafeInteger(firstSeen) && firstSeen > 0))
    && Number.isSafeInteger(count) && count >= 0
    && ["ip", "ua", "email", "lastSite", "lastPath"].every((field) => hash[field] == null || typeof hash[field] === "string");
}
async function getHashes(ids) {
  const out = [];
  const skipped = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const values = await strictPipeline(chunk.map((id) => ["HGETALL", PREFIX + "v:" + id]));
    chunk.forEach((id, idx) => {
      const hash = flatToObj(values[idx]);
      if (validVisitorHash(hash)) out.push({ id, h: hash });
      else skipped.push(id);
    });
  }
  if (skipped.length) console.warn("[visitors] skipped invalid or missing visitor records", { skipped: skipped.length, ids: skipped.slice(0, 20) });
  return { records: out, skipped: skipped.length };
}

async function readVisitorWindow({ older, cutoff, offset, limit }) {
  const pageEnd = offset + limit, target = pageEnd + 1, rows = [];
  let skipped = 0;
  const pageSize = 200; let rawOffset = 0;
  while (rows.length < target) {
    const command = older
      ? ["ZRANGE", INDEX, String(cutoff), "0", "BYSCORE", "REV", "LIMIT", String(rawOffset), String(pageSize)]
      : ["ZRANGE", INDEX, String(rawOffset), String(rawOffset + pageSize - 1), "REV"];
    const [rawIds] = await strictPipeline([command]);
    if (!Array.isArray(rawIds)) throw new Error("visitor_store_unavailable");
    if (!rawIds.length) break;
    const ids = rawIds.filter((id) => typeof id === "string" && /^[a-f0-9]{8,32}$/i.test(id));
    const invalidIndexCount = rawIds.length - ids.length;
    if (invalidIndexCount) console.warn("[visitors] skipped invalid visitor index members", { skipped: invalidIndexCount });
    skipped += invalidIndexCount;
    const batch = await getHashes(ids);
    rows.push(...batch.records);
    skipped += batch.skipped;
    rawOffset += rawIds.length;
    if (rawIds.length < pageSize) break;
  }
  return { records: rows.slice(offset, pageEnd), skipped, hasMore: rows.length > pageEnd };
}
function row(id, h) {
  const ls = Number(h.lastSeen || 0);
  return {
    id, ip: h.ip || "", ua: h.ua || "", email: h.email || "",
    site: h.lastSite || "", lastPath: h.lastPath || "",
    count: Number(h.count || 0),
    lastSeen: ls, lastSeenText: ls ? formatBeijingTime(ls) : "",
    firstSeen: Number(h.firstSeen || 0),
  };
}

export async function GET(request) {
  if (!gate(request)) return unauth();
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const older = url.searchParams.get("older") === "1";
    const days = Math.max(1, Number(url.searchParams.get("days") || 30));
    const cutoff = Date.now() - days * 86400000;

    if (q) {
      const [recent] = await strictPipeline([["ZRANGE", INDEX, "0", String(SEARCH_SCAN - 1), "REV"]]);
      if (!Array.isArray(recent)) throw new Error("visitor_store_unavailable");
      const ids = recent.filter((id) => typeof id === "string" && /^[a-f0-9]{8,32}$/i.test(id));
      if (ids.length !== recent.length) console.warn("[visitors] skipped invalid visitor index members", { skipped: recent.length - ids.length });
      const hashes = await getHashes(ids);
      const matched = hashes.records.filter((x) =>
        (x.h.ip || "").toLowerCase().includes(q) || (x.h.email || "").toLowerCase().includes(q));
      const page = matched.slice(offset, offset + limit).map((x) => row(x.id, x.h));
      return Response.json({ ok: true, total: matched.length, rows: page, hasMore: offset + page.length < matched.length, searchCapped: recent.length >= SEARCH_SCAN });
    }

    const countCommand = older ? ["ZCOUNT", INDEX, "0", String(cutoff)] : ["ZCARD", INDEX];
    const [rawTotal] = await strictPipeline([countCommand]);
    const total = Number(rawTotal);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("visitor_store_unavailable");
    const window = await readVisitorWindow({ older, cutoff, offset, limit });
    const knownTotal = Math.max(0, total - window.skipped);
    return Response.json({ ok: true,
      total: window.hasMore ? Math.max(offset + window.records.length + 1, knownTotal) : knownTotal,
      hasMore: window.hasMore, days, rows: window.records.map((x) => row(x.id, x.h)) });
  } catch (error) {
    console.error("[visitors] list unavailable", error?.message || error);
    return Response.json({ ok: false, error: "visitor_store_unavailable" }, { status: 503 });
  }
}

// DELETE — body: { ids:[...] }（按选择删）或 { olderThanDays:30 }（按时间批量删）
export async function DELETE(request) {
  if (!gate(request)) return unauth();
  let body = {};
  try { body = await request.json(); } catch (e) {}

  let ids = [];
  let byTime = false;
  if (Array.isArray(body.ids) && body.ids.length) {
    ids = body.ids.map((x) => String(x)).filter((x) => /^[a-f0-9]{8,32}$/.test(x)).slice(0, 5000);
  } else if (body.olderThanDays) {
    byTime = true;
    const days = Math.max(1, Number(body.olderThanDays));
    const cutoff = Date.now() - days * 86400000;
    ids = (await redisCmd(["ZRANGE", INDEX, String(cutoff), "0", "BYSCORE", "REV", "LIMIT", "0", String(DEL_BATCH_MAX)])) || [];
  }
  if (!ids.length) return Response.json({ ok: true, deleted: 0, remaining: 0 });

  const cmds = [];
  for (const id of ids) {
    cmds.push(["ZREM", INDEX, id], ["DEL", PREFIX + "v:" + id], ["DEL", PREFIX + "v:" + id + ":pages"]);
  }
  for (let i = 0; i < cmds.length; i += 300) await redisPipeline(cmds.slice(i, i + 300));

  let remaining = 0;
  if (byTime) {
    const cutoff = Date.now() - Math.max(1, Number(body.olderThanDays)) * 86400000;
    remaining = Number((await redisCmd(["ZCOUNT", INDEX, "0", String(cutoff)])) || 0);
  }
  return Response.json({ ok: true, deleted: ids.length, remaining });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
