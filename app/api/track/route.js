// 访客埋点 + 通用事件 + 首次归因。记录主站 liumeiti.vip 与子域 tool.liumeiti.vip。
// 客户端只发 {path/type/name/meta/site/attr}；IP/UA/北京时间在服务端取，绝不信任客户端。
// 访客 = sha256(IP+UA)。Redis（前缀 lm:visit:）：
//   index ZSET(score=lastSeen) ; v:<id> HASH ; v:<id>:pages LIST ; v:<id>:events LIST
// 事件聚合：lm:ev:day:<北京日> HASH(name→计数) ; lm:svc:<slug> HASH(views/cta)
// 归因：访客 HASH 的 attr 字段（HSETNX 首次写入，记 utm/referrer/landing/fromTool）。
// 不设 TTL（后台手动按时间批量删）。前端静默，无隐私提示（见 [[liumeiti-no-privacy-notice]]）。

import { createHash } from "node:crypto";
import { after } from "next/server";
import { runMaintenanceTick } from "../_keeper.js";
import {
  clientIpFromRequest, clientUserAgentFromRequest,
  getCookieFromRequest, verifySession, validEmail, redisCmd, redisPipeline,
} from "../_utils.js";

export const runtime = "nodejs";
// keeper(链上确认/续费提醒)经 after() 在本路由生命周期内执行,预留足够时长防中途被杀
export const maxDuration = 60;

const PREFIX = "lm:visit:";
const INDEX = PREFIX + "index";
const CART_INDEX = "lm:cart:index"; // 弃单索引 ZSET(score=ts, member=访客id)
// 账号级真实活动流(用户360只读这里):只记「该账号本人已登录态」下的浏览/事件,
// 与设备级访客记录(vid=IP+UA)解耦 —— 同 IP+UA 不同人不会再被并进同一个用户的 360。
const UACT = "lm:uact:";
const MAX_PAGES = 300;
const MAX_EVENTS = 120;
const DEDUP_SEC = 12;
const ANALYTICS_UNIQUE_TTL = 180 * 24 * 60 * 60;
const VISITOR_DAY_PREFIX = "lm:visit:day:";
const EVENT_UNIQUE_DAY_PREFIX = "lm:ev:uniq:";
const MAX_PATH = 300;
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|phantom|python-requests|curl\/|wget|axios\/|node-fetch|go-http|libwww|httpclient|monitor|uptime|pingdom|semrush|ahrefs|mj12|dotbot/i;
// 允许的事件名 → 去重窗口秒（0=不去重）
const EVENT_DEDUP = { service_view: 1800, cta_click: 5, checkout_started: 1800, signup: 0 };

function vid(ip, ua) { return createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 24); }
function beijingDay(now) { return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ""); }
function cleanStr(s, n) { return String(s == null ? "" : s).slice(0, n); }
// 噪声查询参数(不进访客记录,否则同一页因这些参数被记成多条、还绕过去重):
// OAuth 回跳状态 auth、缓存破坏 v、归因 utm/点击 id(已在 attr 里另存)。业务参数(items/*Plan/redeem)保留。
const NOISE_PARAMS = new Set(["auth", "v", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref", "_t"]);
function cleanPath(p) {
  let s = cleanStr(p, MAX_PATH).trim();
  if (!s) return "/";
  let pathname, search;
  if (s[0] === "/") {
    const qi = s.indexOf("?");
    pathname = qi >= 0 ? s.slice(0, qi) : s;
    search = qi >= 0 ? s.slice(qi + 1) : "";
  } else {
    try { const u = new URL(s); pathname = u.pathname; search = u.search.replace(/^\?/, ""); }
    catch (e) { return ("/" + s.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "")).slice(0, MAX_PATH) || "/"; }
  }
  if (search) {
    const kept = search.split("&").filter((part) => {
      const key = part.split("=")[0];
      return key && !NOISE_PARAMS.has(decodeURIComponent(key).toLowerCase());
    });
    search = kept.length ? "?" + kept.join("&") : "";
  }
  return ((pathname || "/") + search).slice(0, MAX_PATH) || "/";
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
    // 流量搭车维护 tick(响应后异步执行,节流锁保证窗口内至多跑一次,绝不拖慢信标)。
    try { after(() => runMaintenanceTick()); } catch (e) {}
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
      let duplicateEvent = false;
      if (win > 0) {
        const dk = PREFIX + "edup:" + id + ":" + name + ":" + createHash("sha256").update(slug + "|" + label).digest("hex").slice(0, 10);
        duplicateEvent = (await redisCmd(["SET", dk, "1", "NX", "EX", String(win)])) !== "OK";
        // A second checkout beacon can add the email to the abandoned-cart record,
        // but must not increment the funnel or activity stream again.
        if (duplicateEvent && name !== "checkout_started") return noContent();
      }
      const day = beijingDay(now);
      const evJson = JSON.stringify({ name, slug: slug || undefined, label: label || undefined, ts: now });
      const cmds = [
        ["ZADD", INDEX, String(now), id],
        ["HSET", vkey, "ip", ip, "ua", ua, "lastSeen", String(now)],
        ["HSETNX", vkey, "firstSeen", String(now)],
        ["SADD", VISITOR_DAY_PREFIX + day, id],
        ["EXPIRE", VISITOR_DAY_PREFIX + day, String(ANALYTICS_UNIQUE_TTL)],
      ];
      if (!duplicateEvent) cmds.push(
        ["SADD", EVENT_UNIQUE_DAY_PREFIX + day + ":" + name, id],
        ["EXPIRE", EVENT_UNIQUE_DAY_PREFIX + day + ":" + name, String(ANALYTICS_UNIQUE_TTL)],
        ["LPUSH", vkey + ":events", evJson],
        ["LTRIM", vkey + ":events", "0", String(MAX_EVENTS - 1)],
        ["HINCRBY", "lm:ev:day:" + day, name, "1"],
        ["EXPIRE", "lm:ev:day:" + day, "7776000"], // 按日事件桶保留 90 天，避免孤儿 key 无界增长
        ["HINCRBY", "lm:ev:total", name, "1"], // 全局累计
      );
      if (email) {
        cmds.push(["HSET", vkey, "email", email], ["SADD", "lm:visit:email:" + email, id]);
        // 账号级活动流(用户360 来源)
        if (!duplicateEvent) cmds.push(
            ["LPUSH", UACT + email + ":events", evJson],
            ["LTRIM", UACT + email + ":events", "0", String(MAX_EVENTS - 1)],
            ["HSET", UACT + email, "lastSeen", String(now)],
            ["HSETNX", UACT + email, "firstSeen", String(now)],
          );
        if (attr) cmds.push(["HSETNX", UACT + email, "attr", JSON.stringify(attr)]);
      }
      if (attr) cmds.push(["HSETNX", vkey, "attr", JSON.stringify(attr)]);
      if (!duplicateEvent && slug && (name === "service_view" || name === "cta_click")) {
        cmds.push(["HINCRBY", "lm:svc:" + slug, name === "service_view" ? "views" : "cta", "1"]);
      }
      // 弃单：到结算页即记一条「待召回」（下单成功后由 /api/order 清除）
      if (name === "checkout_started") {
        const ckey = "lm:cart:v:" + id;
        const cemail = email || (validEmail(meta.email) ? String(meta.email).toLowerCase() : "");
        const chash = ["HSET", ckey, "ip", ip, "ua", ua, "ts", String(now),
          "services", cleanStr(meta.services, 200), "amount", cleanStr(String(meta.amount == null ? "" : meta.amount), 20), "status", "open"];
        if (cemail) chash.push("email", cemail);
        if (meta.locale === "en") chash.push("locale", "en"); // 召回邮件按下单时语言本地化
        if (attr) chash.push("attr", JSON.stringify(attr));
        cmds.push(chash, ["EXPIRE", ckey, "3888000"], ["ZADD", CART_INDEX, String(now), id]); // 弃单 hash 45 天自动过期，避免无界增长
      }
      await redisPipeline(cmds);
      return noContent();
    }

    // ── 页面浏览（默认） ──
    const path = cleanPath(body.path);
    const site = body.site === "tool" ? "tool" : "main";
    // 后台自身浏览不计入访客统计(主站 /admin)。
    if (site === "main" && /^\/admin(?:[/?]|$)/.test(path)) return noContent();
    const dk = PREFIX + "dedup:" + id + ":" + createHash("sha256").update(site + path).digest("hex").slice(0, 12);
    if ((await redisCmd(["SET", dk, "1", "NX", "EX", String(DEDUP_SEC)])) !== "OK") return noContent();
    const pageEntry = JSON.stringify({ site, path, ts: now });
    const day = beijingDay(now);
    const hset = ["HSET", vkey, "ip", ip, "ua", ua, "lastSeen", String(now), "lastPath", path, "lastSite", site];
    if (email) hset.push("email", email);
    const cmds = [
      ["ZADD", INDEX, String(now), id],
      hset,
      ["HSETNX", vkey, "firstSeen", String(now)],
      ["HINCRBY", vkey, "count", "1"],
      ["LPUSH", vkey + ":pages", pageEntry],
      ["LTRIM", vkey + ":pages", "0", String(MAX_PAGES - 1)],
      ["SADD", VISITOR_DAY_PREFIX + day, id],
      ["EXPIRE", VISITOR_DAY_PREFIX + day, String(ANALYTICS_UNIQUE_TTL)],
    ];
    if (email) {
      cmds.push(["SADD", "lm:visit:email:" + email, id]); // 邮箱→访客 反向索引(历史访客用)
      // 账号级活动流(用户360 来源):只记本人已登录态下的真实浏览,带当时 IP。
      cmds.push(
        ["LPUSH", UACT + email + ":pages", JSON.stringify({ site, path, ts: now, ip })],
        ["LTRIM", UACT + email + ":pages", "0", String(MAX_PAGES - 1)],
        ["HSET", UACT + email, "lastSeen", String(now), "lastIp", ip],
        ["HSETNX", UACT + email, "firstSeen", String(now)],
        ["HINCRBY", UACT + email, "count", "1"],
        ["SADD", UACT + email + ":ips", ip],
      );
      if (attr) cmds.push(["HSETNX", UACT + email, "attr", JSON.stringify(attr)]);
    }
    if (attr) cmds.push(["HSETNX", vkey, "attr", JSON.stringify(attr)]);
    await redisPipeline(cmds);
  } catch (e) { /* swallow — never break the page */ }
  return noContent();
}

export async function GET() { return noContent(); }
export async function OPTIONS() { return new Response(null, { status: 204 }); }
