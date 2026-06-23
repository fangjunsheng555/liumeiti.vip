// 访客埋点 — 记录主站 liumeiti.vip 与子域 tool.liumeiti.vip 的页面浏览。
// 客户端只发 {path, site, title?, ref?}；IP / UA / 北京时间在服务端取，绝不信任客户端。
// 访客 = sha256(IP + UA)（IP+UA 归并）。存 Upstash Redis：
//   lm:visit:index            ZSET  member=访客id, score=最后访问毫秒（排序/分页/按时间筛选删除）
//   lm:visit:v:<id>           HASH  ip / ua / firstSeen / lastSeen / count / lastPath / lastSite / email?
//   lm:visit:v:<id>:pages     LIST  每条 JSON {site,path,ts}，LTRIM 封顶最近 MAX_PAGES
// 不设 TTL（按用户要求：后台手动按「30 天前」批量删，不自动过期）。
// 纯加性，复用既有 helpers。

import { createHash } from "node:crypto";
import {
  clientIpFromRequest, clientUserAgentFromRequest,
  getCookieFromRequest, verifySession, validEmail, redisCmd, redisPipeline,
} from "../_utils.js";

export const runtime = "nodejs";

const PREFIX = "lm:visit:";
const INDEX = PREFIX + "index";
const MAX_PAGES = 300;       // 每访客最多保留最近 N 条页面（防单访客刷爆）
const DEDUP_SEC = 8;         // 同访客同页面 N 秒内只记一次（防刷新刷量）
const MAX_PATH = 300;
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|phantom|python-requests|curl\/|wget|axios\/|node-fetch|go-http|libwww|httpclient|monitor|uptime|pingdom|semrush|ahrefs|mj12|dotbot/i;

function vid(ip, ua) {
  return createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 24);
}
function cleanPath(p) {
  let s = String(p || "").trim().slice(0, MAX_PATH);
  if (!s) return "/";
  if (s[0] !== "/") { try { s = new URL(s).pathname + new URL(s).search; } catch (e) { s = "/" + s.replace(/^https?:\/\/[^/]+/i, ""); } }
  return s.slice(0, MAX_PATH) || "/";
}
function authedEmail(request) {
  try { const s = verifySession(getCookieFromRequest(request, "lm_user")); return s && validEmail(s.email) ? String(s.email).toLowerCase() : ""; }
  catch (e) { return ""; }
}

function noContent() {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function POST(request) {
  // 即使出错也回 204：埋点失败绝不能影响用户页面
  try {
    const ua = clientUserAgentFromRequest(request);
    if (!ua || BOT_RE.test(ua)) return noContent();          // 跳过空 UA / 爬虫
    const ip = clientIpFromRequest(request);

    let body = {};
    try { body = await request.json(); } catch (e) {}
    const path = cleanPath(body.path);
    const site = body.site === "tool" ? "tool" : "main";
    const now = Date.now();
    const id = vid(ip, ua);

    // 同访客同页面短时去重（也是写入节流，压低 Redis 命令量）
    const dk = PREFIX + "dedup:" + id + ":" + createHash("sha256").update(site + path).digest("hex").slice(0, 12);
    const set = await redisCmd(["SET", dk, "1", "NX", "EX", String(DEDUP_SEC)]);
    if (set !== "OK") return noContent();                     // 最近记过同页 → 跳过

    const vkey = PREFIX + "v:" + id;
    const pkey = vkey + ":pages";
    const email = authedEmail(request);
    const pageEntry = JSON.stringify({ site, path, ts: now });

    const hset = ["HSET", vkey, "ip", ip, "ua", ua, "lastSeen", String(now), "lastPath", path, "lastSite", site];
    if (email) { hset.push("email", email); }

    await redisPipeline([
      ["ZADD", INDEX, String(now), id],
      hset,
      ["HSETNX", vkey, "firstSeen", String(now)],
      ["HINCRBY", vkey, "count", "1"],
      ["LPUSH", pkey, pageEntry],
      ["LTRIM", pkey, "0", String(MAX_PAGES - 1)],
    ]);
  } catch (e) { /* swallow — never break the page */ }
  return noContent();
}

export async function GET() { return noContent(); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
