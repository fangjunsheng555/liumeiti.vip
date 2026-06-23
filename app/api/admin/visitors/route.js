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
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
async function getHashes(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = (await redisPipeline(chunk.map((id) => ["HGETALL", PREFIX + "v:" + id]))) || [];
    chunk.forEach((id, idx) => out.push({ id, h: flatToObj(res[idx] && res[idx].result) }));
  }
  return out;
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
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const older = url.searchParams.get("older") === "1";
  const days = Math.max(1, Number(url.searchParams.get("days") || 30));
  const cutoff = Date.now() - days * 86400000;

  if (q) {
    const recent = (await redisCmd(["ZRANGE", INDEX, "0", String(SEARCH_SCAN - 1), "REV"])) || [];
    const hashes = await getHashes(recent);
    const matched = hashes.filter((x) =>
      (x.h.ip || "").toLowerCase().includes(q) || (x.h.email || "").toLowerCase().includes(q));
    const page = matched.slice(offset, offset + limit).map((x) => row(x.id, x.h));
    return Response.json({ ok: true, total: matched.length, rows: page, searchCapped: recent.length >= SEARCH_SCAN });
  }

  let ids = [];
  let total = 0;
  if (older) {
    total = Number((await redisCmd(["ZCOUNT", INDEX, "0", String(cutoff)])) || 0);
    ids = (await redisCmd(["ZRANGE", INDEX, String(cutoff), "0", "BYSCORE", "REV", "LIMIT", String(offset), String(limit)])) || [];
  } else {
    total = Number((await redisCmd(["ZCARD", INDEX])) || 0);
    ids = (await redisCmd(["ZRANGE", INDEX, String(offset), String(offset + limit - 1), "REV"])) || [];
  }
  const hashes = await getHashes(ids);
  return Response.json({ ok: true, total, days, rows: hashes.map((x) => row(x.id, x.h)) });
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
