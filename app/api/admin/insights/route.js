// 后台「数据洞察」— 转化漏斗 + 按来源 + 服务级表现。仅超级管理员。
// 聚合：访客(lm:visit:index) + 注册数 + 事件累计(lm:ev:total) + 服务计数(lm:svc:<key>) + 订单(getAllOrders, 含 attribution)。
import {
  adminSessionFromRequest, isRootAdminSession,
  redisCmd, redisPipeline, getAllOrders, listAllUserEmails,
} from "../../_utils.js";

export const runtime = "nodejs";

const SERVICES = [
  { key: "spotify", name: "Spotify" }, { key: "ai", name: "AI 会员" }, { key: "netflix", name: "Netflix" },
  { key: "disney", name: "Disney+" }, { key: "max", name: "HBO Max" }, { key: "rocket", name: "机场节点" },
];

function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {}; if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
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

export async function GET(request) {
  const s = adminSessionFromRequest(request);
  if (!s || !isRootAdminSession(s)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const [visitors, evTotalRaw, userEmails, ordersRaw, svcRaw] = await Promise.all([
    redisCmd(["ZCARD", "lm:visit:index"]),
    redisCmd(["HGETALL", "lm:ev:total"]),
    listAllUserEmails(),
    getAllOrders(),
    redisPipeline(SERVICES.map((x) => ["HGETALL", "lm:svc:" + x.key])),
  ]);

  const ev = flatToObj(evTotalRaw);
  const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
  const live = orders.filter((o) => o.status !== "invalid");        // 有效（非无效）订单
  const paid = orders.filter((o) => o.status === "completed");      // 已完成=成交
  const revenue = paid.reduce((sum, o) => sum + orderRevenue(o), 0);

  // 漏斗（累计）
  const funnel = {
    visitors: Number(visitors || 0),
    signups: Array.isArray(userEmails) ? userEmails.length : 0,
    checkoutStarted: Number(ev.checkout_started || 0),
    orders: live.length,
    paid: paid.length,
    revenue: Math.round(revenue * 100) / 100,
    serviceViews: Number(ev.service_view || 0),
    ctaClicks: Number(ev.cta_click || 0),
  };

  // 按来源（有效订单）
  const bySourceMap = {};
  for (const o of live) {
    const src = orderSource(o);
    const m = (bySourceMap[src] = bySourceMap[src] || { source: src, orders: 0, paid: 0, revenue: 0 });
    m.orders += 1;
    if (o.status === "completed") { m.paid += 1; m.revenue += orderRevenue(o); }
  }
  const bySource = Object.values(bySourceMap).map((m) => ({ ...m, revenue: Math.round(m.revenue * 100) / 100 })).sort((a, b) => b.orders - a.orders);

  // 服务级：浏览/点击(lm:svc) + 下单/成交/营收(订单 items)
  const svcOrders = {};
  for (const o of live) {
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
      orders: so.orders, paid: so.paid, revenue: Math.round(so.revenue * 100) / 100,
      viewToPaid: views ? Math.round((so.paid / views) * 1000) / 10 : 0, // %
    };
  }).sort((a, b) => b.revenue - a.revenue || b.views - a.views);

  return Response.json({ ok: true, funnel, bySource, services });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
