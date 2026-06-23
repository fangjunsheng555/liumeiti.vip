// 访客埋点 + 通用事件 + 首次归因。记录主站 liumeiti.vip 与子域 tool.liumeiti.vip。
// 客户端只发 {path/type/name/meta/site/attr}；IP/UA/北京时间在服务端取，绝不信任客户端。
// 访客 = sha256(IP+UA)。Redis（前缀 lm:visit:）：
//   index ZSET(score=lastSeen) ; v:<id> HASH ; v:<id>:pages LIST ; v:<id>:events LIST
// 事件聚合：lm:ev:day:<北京日> HASH(name→计数) ; lm:svc:<slug> HASH(views/cta)
// 归因：访客 HASH 的 attr 字段（HSETNX 首次写入，记 utm/referrer/landing/fromTool）。
// 不设 TTL（后台手动按时间批量删）。前端静默，无隐私提示（见 [[liumeiti-no-privacy-notice]]）。

import { createHash } from "node:crypto";
import {
  clientIpFromRequest, clientUserAgentFromRequest,
  getCookieFromRequest, verifySession, validEmail, redisCmd, redisPipeline,
} from "../_utils.js";

export const runtime = "nodejs";

const PREFIX = "lm:visit:";
const INDEX = PREFIX + "index";
const CART_INDEX = "lm:cart:index"; // 弃单索引 ZSET(score=ts, member=访客id)
const MAX_PAGES = 300;
const MAX_EVENTS = 120;
const DEDUP_SEC = 8;
const MAX_PATH = 300;
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|phantom|python-requests|curl\/|wget|axios\/|node-fetch|go-http|libwww|httpclient|monitor|uptime|pingdom|semrush|ahrefs|mj12|dotbot/i;
// 允许的事件名 → 去重窗口秒（0=不去重）
const EVENT_DEDUP = { service_view: 1800, cta_click: 5, checkout_started: 0, signup: 0 };

function vid(ip, ua) { return createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 24); }
function beijingDay(now) { return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ""); }
function cleanStr(s, n) { return String(s == null ? "" : s).slice(0, n); }
function cleanPath(p) {
  let s = cleanStr(p, MAX_PATH).trim();
  if (!s) return "/";
  if (s[0] !== "/") { try { const u = new URL(s); s = u.pathname + u.search; } catch (e) { s = "/" + s.replace(/^https?:\/\/[^/]+/i, ""); } }
  return s.slice(0, MAX_PATH) || "/";
}
function authedEmail(request) {
  try { const s = verifySession(getCookieFromRequest(request, "lm_user")); return s && validEmail(s.email) ? String(s.email).toLowerCase() : ""; }
  catch (e) { return ""; }
}
function safeAttr(a) {
  if (!a || typeof a !== "object") return null;
  const out = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "referrer", "landing"]) {
    if (typeof a[k] === "string" && a[k]) out[k] = a[k].slice(0, 200);
  }
  if (a.fromTool) out.fromTool = 1;
  if (a.firstTs) out.firstTs = Number(a.firstTs) || undefined;
  return Object.keys(out).length ? out : null;
}
function noContent() { return new Response(null, { status: 204, headers: { "cache-control": "no-store" } }); }

export async function POST(request) {
  try {
    const ua = clientUserAgentFromRequest(request);
    if (!ua || BOT_RE.test(ua)) return noContent();
    const ip = clientIpFromRequest(request);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const now = Date.now();
    const id = vid(ip, ua);
    const vkey = PREFIX + "v:" + id;
    const email = authedEmail(request);
    const attr = safeAttr(body.attr);

    // ── 通用事件 ──
    if (body.type === "event") {
      const name = cleanStr(body.name, 40).replace(/[^a-z_]/gi, "");
      if (!name || !(name in EVENT_DEDUP)) return noContent();
      const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
      const slug = cleanStr(meta.slug, 40).replace(/[^a-z0-9-]/gi, "");
      const label = cleanStr(meta.label, 60);
      const win = EVENT_DEDUP[name];
      if (win > 0) {
        const dk = PREFIX + "edup:" + id + ":" + name + ":" + createHash("sha256").update(slug + "|" + label).digest("hex").slice(0, 10);
        if ((await redisCmd(["SET", dk, "1", "NX", "EX", String(win)])) !== "OK") return noContent();
      }
      const day = beijingDay(now);
      const evJson = JSON.stringify({ name, slug: slug || undefined, label: label || undefined, ts: now });
      const cmds = [
        ["ZADD", INDEX, String(now), id],
        ["HSET", vkey, "ip", ip, "ua", ua, "lastSeen", String(now)],
        ["HSETNX", vkey, "firstSeen", String(now)],
        ["LPUSH", vkey + ":events", evJson],
        ["LTRIM", vkey + ":events", "0", String(MAX_EVENTS - 1)],
        ["HINCRBY", "lm:ev:day:" + day, name, "1"],
      ];
      if (email) cmds.push(["HSET", vkey, "email", email]);
      if (attr) cmds.push(["HSETNX", vkey, "attr", JSON.stringify(attr)]);
      if (slug && (name === "service_view" || name === "cta_click")) {
        cmds.push(["HINCRBY", "lm:svc:" + slug, name === "service_view" ? "views" : "cta", "1"]);
      }
      // 弃单：到结算页即记一条「待召回」（下单成功后由 /api/order 清除）
      if (name === "checkout_started") {
        const ckey = "lm:cart:v:" + id;
        const cemail = email || (validEmail(meta.email) ? String(meta.email).toLowerCase() : "");
        const chash = ["HSET", ckey, "ip", ip, "ua", ua, "ts", String(now),
          "services", cleanStr(meta.services, 200), "amount", cleanStr(String(meta.amount == null ? "" : meta.amount), 20), "status", "open"];
        if (cemail) chash.push("email", cemail);
        if (attr) chash.push("attr", JSON.stringify(attr));
        cmds.push(chash, ["ZADD", CART_INDEX, String(now), id]);
      }
      await redisPipeline(cmds);
      return noContent();
    }

    // ── 页面浏览（默认） ──
    const path = cleanPath(body.path);
    const site = body.site === "tool" ? "tool" : "main";
    const dk = PREFIX + "dedup:" + id + ":" + createHash("sha256").update(site + path).digest("hex").slice(0, 12);
    if ((await redisCmd(["SET", dk, "1", "NX", "EX", String(DEDUP_SEC)])) !== "OK") return noContent();
    const pageEntry = JSON.stringify({ site, path, ts: now });
    const hset = ["HSET", vkey, "ip", ip, "ua", ua, "lastSeen", String(now), "lastPath", path, "lastSite", site];
    if (email) hset.push("email", email);
    const cmds = [
      ["ZADD", INDEX, String(now), id],
      hset,
      ["HSETNX", vkey, "firstSeen", String(now)],
      ["HINCRBY", vkey, "count", "1"],
      ["LPUSH", vkey + ":pages", pageEntry],
      ["LTRIM", vkey + ":pages", "0", String(MAX_PAGES - 1)],
    ];
    if (attr) cmds.push(["HSETNX", vkey, "attr", JSON.stringify(attr)]);
    await redisPipeline(cmds);
  } catch (e) { /* swallow — never break the page */ }
  return noContent();
}

export async function GET() { return noContent(); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
