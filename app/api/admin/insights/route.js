// 后台「数据洞察」— 专业仪表盘数据接口。仅超级管理员。
// 支持时间范围(?days=7|30|90)：范围内转化漏斗+转化率 + 每日趋势序列 + 环比上一周期 + 按来源/服务(范围内) + 全站累计对照。
// 数据源：lm:visit:index(访客 ZSET) + lm:ev:day:<北京日>(每日事件) + lm:ev:total(累计) + lm:svc:<key>(服务计数) + getAllOrders(按 createdAt 分桶)。
import {
  adminSessionFromRequest, isRootAdminSession,
  redisCmd, redisPipeline, getAllOrders, listAllUserEmails,
} from "../../_utils.js";

export const runtime = "nodejs";

const SERVICES = [
  { key: "spotify", name: "Spotify" }, { key: "ai", name: "AI 会员" }, { key: "netflix", name: "Netflix" },
  { key: "disney", name: "Disney+" }, { key: "max", name: "HBO Max" }, { key: "rocket", name: "机场节点" },
];
const DAY_MS = 86400000;
const ALLOWED_DAYS = [7, 30, 90];

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {}; if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
// 北京日 YYYYMMDD（与 track 的 beijingDay 同格式）
function dayKey(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ""); }
function orderMs(o) { const t = Date.parse((o && o.createdAt) || ""); return isNaN(t) ? 0 : t; }
function orderSource(o) {
  const a = o && o.attribution;
  if (a) {
    if (a.utm_source) return "UTM·" + a.utm_source;
    if (a.fromTool) return "工具站";
    if (a.referrer) { try { return "外链·" + new URL(a.referrer).hostname.replace(/^www\./, ""); } catch (e) { return "外链"; } }
  }
  if (o && o.referral) return "推荐";
  return "直接访问";
}
function orderRevenue(o) {
  return Number(o.finalAmount || (o.paidCurrency === "CNY" ? o.paidAmount : 0) || 0) || 0;
}
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
function delta(cur, prev) {
  if (prev > 0) return Math.round(((cur - prev) / prev) * 1000) / 10; // 百分比变化
  if (cur > 0) return null; // 上期为 0、本期有量 → 无法计算百分比（前端显示「新增」）
  return 0;
}

export async function GET(request) {
  const s = adminSessionFromRequest(request);
  if (!s || !isRootAdminSession(s)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  let days = parseInt(url.searchParams.get("days") || "30", 10);
  if (!ALLOWED_DAYS.includes(days)) days = 30;

  const now = Date.now();
  const curStart = now - days * DAY_MS;
  const prevStart = now - 2 * days * DAY_MS;
  const curDayKeys = []; for (let i = days - 1; i >= 0; i--) curDayKeys.push(dayKey(now - i * DAY_MS));
  const prevDayKeys = []; for (let i = 2 * days - 1; i >= days; i--) prevDayKeys.push(dayKey(now - i * DAY_MS));
  const allDayKeys = curDayKeys.concat(prevDayKeys);

  const [visAll, evTotalRaw, userEmails, ordersRaw, visCur, visPrev, dayRaws, svcRaw] = await Promise.all([
    redisCmd(["ZCARD", "lm:visit:index"]),
    redisCmd(["HGETALL", "lm:ev:total"]),
    listAllUserEmails(),
    getAllOrders(),
    redisCmd(["ZCOUNT", "lm:visit:index", String(curStart), String(now)]),
    redisCmd(["ZCOUNT", "lm:visit:index", String(prevStart), String(curStart)]),
    redisPipeline(allDayKeys.map((k) => ["HGETALL", "lm:ev:day:" + k])),
    redisPipeline(SERVICES.map((x) => ["HGETALL", "lm:svc:" + x.key])),
  ]);

  // 每日事件计数
  const dayMap = {};
  (Array.isArray(dayRaws) ? dayRaws : []).forEach((r, i) => { dayMap[allDayKeys[i]] = flatToObj(r && r.result); });
  const sumEv = (keys, field) => keys.reduce((sum, k) => sum + Number((dayMap[k] || {})[field] || 0), 0);

  // 订单分桶
  const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
  const live = orders.filter((o) => o.status !== "invalid");
  const inRange = (o, a, b) => { const m = orderMs(o); return m >= a && m < b; };
  const liveCur = live.filter((o) => inRange(o, curStart, now + 1));
  const livePrev = live.filter((o) => inRange(o, prevStart, curStart));
  const paidCur = liveCur.filter((o) => o.status === "completed");
  const paidPrev = livePrev.filter((o) => o.status === "completed");
  const revCur = round2(paidCur.reduce((s, o) => s + orderRevenue(o), 0));
  const revPrev = round2(paidPrev.reduce((s, o) => s + orderRevenue(o), 0));

  const curViews = sumEv(curDayKeys, "service_view"), curCta = sumEv(curDayKeys, "cta_click"), curCheckout = sumEv(curDayKeys, "checkout_started");
  const prevViews = sumEv(prevDayKeys, "service_view"), prevCheckout = sumEv(prevDayKeys, "checkout_started");
  const vCur = Number(visCur || 0), vPrev = Number(visPrev || 0);

  // 范围内漏斗 + 转化率
  const funnel = {
    visitors: vCur, serviceViews: curViews, ctaClicks: curCta, checkoutStarted: curCheckout,
    orders: liveCur.length, paid: paidCur.length, revenue: revCur,
    rates: {
      viewToCheckout: pct(curCheckout, curViews),       // 浏览→发起结算
      checkoutToPaid: pct(paidCur.length, curCheckout),  // 结算→成交
      visitorToPaid: pct(paidCur.length, vCur),          // 访客→成交（整体转化）
      aov: paidCur.length ? round2(revCur / paidCur.length) : 0, // 客单价
    },
  };

  // 环比
  const compare = {
    visitors: { cur: vCur, prev: vPrev, delta: delta(vCur, vPrev) },
    serviceViews: { cur: curViews, prev: prevViews, delta: delta(curViews, prevViews) },
    checkoutStarted: { cur: curCheckout, prev: prevCheckout, delta: delta(curCheckout, prevCheckout) },
    orders: { cur: liveCur.length, prev: livePrev.length, delta: delta(liveCur.length, livePrev.length) },
    paid: { cur: paidCur.length, prev: paidPrev.length, delta: delta(paidCur.length, paidPrev.length) },
    revenue: { cur: revCur, prev: revPrev, delta: delta(revCur, revPrev) },
  };

  // 每日趋势序列（仅当前范围）
  const daily = curDayKeys.map((k) => {
    const ev = dayMap[k] || {};
    return { date: k, serviceViews: Number(ev.service_view || 0), ctaClicks: Number(ev.cta_click || 0), checkoutStarted: Number(ev.checkout_started || 0), orders: 0, paid: 0, revenue: 0 };
  });
  const dailyIdx = {}; daily.forEach((d, i) => { dailyIdx[d.date] = i; });
  liveCur.forEach((o) => {
    const i = dailyIdx[dayKey(orderMs(o))];
    if (i == null) return;
    daily[i].orders += 1;
    if (o.status === "completed") { daily[i].paid += 1; daily[i].revenue += orderRevenue(o); }
  });
  daily.forEach((d) => { d.revenue = round2(d.revenue); });

  // 按来源（范围内有效订单）
  const bySourceMap = {};
  for (const o of liveCur) {
    const src = orderSource(o);
    const m = (bySourceMap[src] = bySourceMap[src] || { source: src, orders: 0, paid: 0, revenue: 0 });
    m.orders += 1;
    if (o.status === "completed") { m.paid += 1; m.revenue += orderRevenue(o); }
  }
  const bySource = Object.values(bySourceMap).map((m) => ({ ...m, revenue: round2(m.revenue) })).sort((a, b) => b.orders - a.orders);

  // 服务级：浏览/点击(lm:svc 累计) + 下单/成交/营收(范围内订单 items)
  const svcOrders = {};
  for (const o of liveCur) {
    const items = Array.isArray(o.items) ? o.items : [];
    const seen = new Set();
    for (const it of items) {
      const key = it && it.service; if (!key || seen.has(key)) continue; seen.add(key);
      const m = (svcOrders[key] = svcOrders[key] || { orders: 0, paid: 0, revenue: 0 });
      m.orders += 1;
      if (o.status === "completed") { m.paid += 1; m.revenue += orderRevenue(o); }
    }
  }
  const services = SERVICES.map((x, i) => {
    const c = flatToObj(svcRaw && svcRaw[i] && svcRaw[i].result);
    const so = svcOrders[x.key] || { orders: 0, paid: 0, revenue: 0 };
    const views = Number(c.views || 0);
    return {
      key: x.key, name: x.name,
      views, cta: Number(c.cta || 0),
      orders: so.orders, paid: so.paid, revenue: round2(so.revenue),
      viewToPaid: views ? pct(so.paid, views) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue || b.views - a.views);

  // 全站累计（对照）
  const ev = flatToObj(evTotalRaw);
  const liveAllPaid = live.filter((o) => o.status === "completed");
  const totals = {
    visitorsAll: Number(visAll || 0),
    signups: Array.isArray(userEmails) ? userEmails.length : 0,
    serviceViewsAll: Number(ev.service_view || 0),
    checkoutStartedAll: Number(ev.checkout_started || 0),
    ordersAll: live.length,
    paidAll: liveAllPaid.length,
    revenueAll: round2(liveAllPaid.reduce((s, o) => s + orderRevenue(o), 0)),
  };

  return Response.json({ ok: true, days, funnel, compare, daily, bySource, services, totals });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
