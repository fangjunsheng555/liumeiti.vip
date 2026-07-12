// 后台「数据洞察」数据接口。仅超级管理员可见。
// 成交额 = 直接支付成交额 + 已核销服务兑换码的商品等值金额；余额码只在余额实际支付订单时计入，避免重复。
import {
  adminSessionFromRequest, isRootAdminSession,
  redisCmd, redisPipeline, getAllOrders, listAllUserEmails,
} from "../../_utils.js";
import { getMergedCatalog } from "../../_catalog.js";
import {
  PAYMENT_CHANNEL_LABELS,
  ORDER_STATUS_LABELS,
  addValueBreakdown,
  isRecognizedSale,
  isServiceCodeOrder,
  orderServiceAllocations,
  orderSource,
  orderValueBreakdown,
  paymentChannel,
  percent,
  round2,
} from "./metrics.js";

export const runtime = "nodejs";

const DAY_MS = 86400000;
const ALLOWED_DAYS = [7, 30, 90];

function flatToObj(value) {
  if (value && !Array.isArray(value) && typeof value === "object") return value;
  const output = {};
  if (Array.isArray(value)) {
    for (let index = 0; index + 1 < value.length; index += 2) output[value[index]] = value[index + 1];
  }
  return output;
}

function dayKey(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

function orderMs(order) {
  const time = Date.parse(order?.createdAt || "");
  return Number.isNaN(time) ? 0 : time;
}

function delta(current, previous) {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  if (current > 0) return null;
  return 0;
}

function sumEvents(keys, dayMap, field) {
  return keys.reduce((sum, key) => sum + Number(dayMap[key]?.[field] || 0), 0);
}

function summarizeSales(orders) {
  const result = { orders: 0, revenue: 0, directRevenue: 0, codeRevenue: 0, codeOrders: 0 };
  orders.forEach((order) => {
    if (!isRecognizedSale(order)) return;
    result.orders += 1;
    if (isServiceCodeOrder(order)) result.codeOrders += 1;
    addValueBreakdown(result, orderValueBreakdown(order));
  });
  return result;
}

function orderInRange(order, start, end) {
  const time = orderMs(order);
  return time >= start && time < end;
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  let days = Number.parseInt(url.searchParams.get("days") || "30", 10);
  if (!ALLOWED_DAYS.includes(days)) days = 30;

  const catalog = await getMergedCatalog();
  const serviceDefinitions = catalog.map((product) => ({
    key: product.key,
    name: product.title,
    active: product.active !== false,
  }));

  const now = Date.now();
  const currentStart = now - days * DAY_MS;
  const previousStart = now - 2 * days * DAY_MS;
  const currentDayKeys = [];
  const previousDayKeys = [];
  for (let index = days - 1; index >= 0; index -= 1) currentDayKeys.push(dayKey(now - index * DAY_MS));
  for (let index = 2 * days - 1; index >= days; index -= 1) previousDayKeys.push(dayKey(now - index * DAY_MS));
  const allDayKeys = currentDayKeys.concat(previousDayKeys);

  const [visitorsAll, eventsTotalRaw, userEmails, ordersRaw, visitorsCurrent, visitorsPrevious, dayRaws, serviceRaws] = await Promise.all([
    redisCmd(["ZCARD", "lm:visit:index"]),
    redisCmd(["HGETALL", "lm:ev:total"]),
    listAllUserEmails(),
    getAllOrders(),
    redisCmd(["ZCOUNT", "lm:visit:index", String(currentStart), String(now)]),
    redisCmd(["ZCOUNT", "lm:visit:index", String(previousStart), String(currentStart)]),
    redisPipeline(allDayKeys.map((key) => ["HGETALL", "lm:ev:day:" + key])),
    redisPipeline(serviceDefinitions.map((service) => ["HGETALL", "lm:svc:" + service.key])),
  ]);

  const dayMap = {};
  (Array.isArray(dayRaws) ? dayRaws : []).forEach((row, index) => {
    dayMap[allDayKeys[index]] = flatToObj(row?.result);
  });

  const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
  const rangeOrders = orders.filter((order) => orderInRange(order, currentStart, now + 1));
  const previousRangeOrders = orders.filter((order) => orderInRange(order, previousStart, currentStart));
  const validOrders = orders.filter((order) => order.status !== "invalid");
  const currentValid = rangeOrders.filter((order) => order.status !== "invalid");
  const previousValid = previousRangeOrders.filter((order) => order.status !== "invalid");
  const currentSales = summarizeSales(currentValid);
  const previousSales = summarizeSales(previousValid);
  const allSales = summarizeSales(validOrders);

  const currentViews = sumEvents(currentDayKeys, dayMap, "service_view");
  const currentCta = sumEvents(currentDayKeys, dayMap, "cta_click");
  const currentCheckout = sumEvents(currentDayKeys, dayMap, "checkout_started");
  const previousViews = sumEvents(previousDayKeys, dayMap, "service_view");
  const previousCheckout = sumEvents(previousDayKeys, dayMap, "checkout_started");
  const currentVisitorCount = Number(visitorsCurrent || 0);
  const previousVisitorCount = Number(visitorsPrevious || 0);
  const completedCurrent = currentValid.filter((order) => order.status === "completed").length;

  const funnel = {
    visitors: currentVisitorCount,
    serviceViews: currentViews,
    ctaClicks: currentCta,
    checkoutStarted: currentCheckout,
    orders: currentValid.length,
    paid: currentSales.orders,
    completed: completedCurrent,
    pending: currentValid.length - completedCurrent,
    invalid: rangeOrders.length - currentValid.length,
    revenue: currentSales.revenue,
    directRevenue: currentSales.directRevenue,
    codeRevenue: currentSales.codeRevenue,
    codeOrders: currentSales.codeOrders,
    rates: {
      viewToCheckout: percent(currentCheckout, currentViews),
      checkoutToPaid: percent(currentSales.orders, currentCheckout),
      visitorToPaid: percent(currentSales.orders, currentVisitorCount),
      checkoutToOrder: percent(currentValid.length, currentCheckout),
      orderToPaid: percent(currentSales.orders, currentValid.length),
      orderCompletion: percent(completedCurrent, currentValid.length),
      ordersPer100Visitors: percent(currentSales.orders, currentVisitorCount),
      codeShare: percent(currentSales.codeRevenue, currentSales.revenue),
      aov: currentSales.orders ? round2(currentSales.revenue / currentSales.orders) : 0,
    },
  };

  const compare = {
    visitors: { cur: currentVisitorCount, prev: previousVisitorCount, delta: delta(currentVisitorCount, previousVisitorCount) },
    serviceViews: { cur: currentViews, prev: previousViews, delta: delta(currentViews, previousViews) },
    checkoutStarted: { cur: currentCheckout, prev: previousCheckout, delta: delta(currentCheckout, previousCheckout) },
    orders: { cur: currentValid.length, prev: previousValid.length, delta: delta(currentValid.length, previousValid.length) },
    paid: { cur: currentSales.orders, prev: previousSales.orders, delta: delta(currentSales.orders, previousSales.orders) },
    revenue: { cur: currentSales.revenue, prev: previousSales.revenue, delta: delta(currentSales.revenue, previousSales.revenue) },
    directRevenue: { cur: currentSales.directRevenue, prev: previousSales.directRevenue, delta: delta(currentSales.directRevenue, previousSales.directRevenue) },
    codeRevenue: { cur: currentSales.codeRevenue, prev: previousSales.codeRevenue, delta: delta(currentSales.codeRevenue, previousSales.codeRevenue) },
    codeOrders: { cur: currentSales.codeOrders, prev: previousSales.codeOrders, delta: delta(currentSales.codeOrders, previousSales.codeOrders) },
  };

  const daily = currentDayKeys.map((key) => {
    const events = dayMap[key] || {};
    return {
      date: key,
      serviceViews: Number(events.service_view || 0),
      ctaClicks: Number(events.cta_click || 0),
      checkoutStarted: Number(events.checkout_started || 0),
      orders: 0,
      paid: 0,
      codeOrders: 0,
      revenue: 0,
      directRevenue: 0,
      codeRevenue: 0,
    };
  });
  const dailyIndex = {};
  daily.forEach((row, index) => { dailyIndex[row.date] = index; });
  currentValid.forEach((order) => {
    const index = dailyIndex[dayKey(orderMs(order))];
    if (index == null) return;
    daily[index].orders += 1;
    if (!isRecognizedSale(order)) return;
    daily[index].paid += 1;
    if (isServiceCodeOrder(order)) daily[index].codeOrders += 1;
    addValueBreakdown(daily[index], orderValueBreakdown(order));
  });

  const sourceMap = {};
  currentValid.forEach((order) => {
    const source = orderSource(order);
    const row = sourceMap[source] || {
      source,
      orders: 0,
      paid: 0,
      codeOrders: 0,
      revenue: 0,
      directRevenue: 0,
      codeRevenue: 0,
    };
    row.orders += 1;
    if (isRecognizedSale(order)) {
      row.paid += 1;
      if (isServiceCodeOrder(order)) row.codeOrders += 1;
      addValueBreakdown(row, orderValueBreakdown(order));
    }
    sourceMap[source] = row;
  });
  const bySource = Object.values(sourceMap)
    .map((row) => ({
      ...row,
      completionRate: percent(row.paid, row.orders),
      revenueShare: percent(row.revenue, currentSales.revenue),
    }))
    .sort((left, right) => right.revenue - left.revenue || right.orders - left.orders);

  const paymentMap = {};
  currentValid.forEach((order) => {
    const key = paymentChannel(order);
    const row = paymentMap[key] || {
      key,
      label: PAYMENT_CHANNEL_LABELS[key] || PAYMENT_CHANNEL_LABELS.other,
      orders: 0,
      paid: 0,
      codeOrders: 0,
      revenue: 0,
      directRevenue: 0,
      codeRevenue: 0,
    };
    row.orders += 1;
    if (isRecognizedSale(order)) {
      row.paid += 1;
      if (isServiceCodeOrder(order)) row.codeOrders += 1;
      addValueBreakdown(row, orderValueBreakdown(order));
    }
    paymentMap[key] = row;
  });
  const paymentPriority = ["alipay", "usdt", "balance", "redeem", "quote", "other"];
  const payments = Object.values(paymentMap)
    .map((row) => ({
      ...row,
      completionRate: percent(row.paid, row.orders),
      revenueShare: percent(row.revenue, currentSales.revenue),
      aov: row.paid ? round2(row.revenue / row.paid) : 0,
    }))
    .sort((left, right) => paymentPriority.indexOf(left.key) - paymentPriority.indexOf(right.key));

  const statusCounts = {};
  rangeOrders.forEach((order) => {
    const key = order.status || "received";
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  });
  const statusPriority = ["completed", "received", "awaiting_quote", "pending_payment", "invalid"];
  const statusKeys = Array.from(new Set(statusPriority.concat(Object.keys(statusCounts))));
  const statuses = statusKeys.map((key) => ({
    key,
    label: ORDER_STATUS_LABELS[key] || key,
    count: statusCounts[key] || 0,
    share: percent(statusCounts[key] || 0, rangeOrders.length),
  }));

  const serviceOrderMap = {};
  currentValid.forEach((order) => {
    const allocations = orderServiceAllocations(order);
    allocations.forEach((allocation) => {
      const row = serviceOrderMap[allocation.service] || {
        orders: 0,
        paid: 0,
        codeOrders: 0,
        revenue: 0,
        directRevenue: 0,
        codeRevenue: 0,
      };
      row.orders += 1;
      if (isRecognizedSale(order)) {
        row.paid += 1;
        if (isServiceCodeOrder(order)) row.codeOrders += 1;
        addValueBreakdown(row, {
          gross: allocation.gross,
          direct: allocation.direct,
          codeEquivalent: allocation.codeEquivalent,
        });
      }
      serviceOrderMap[allocation.service] = row;
    });
  });

  const serviceTraffic = {};
  serviceDefinitions.forEach((service, index) => {
    serviceTraffic[service.key] = flatToObj(serviceRaws?.[index]?.result);
  });
  const knownServiceKeys = new Set(serviceDefinitions.map((service) => service.key));
  const allServiceDefinitions = serviceDefinitions.concat(
    Object.keys(serviceOrderMap)
      .filter((key) => !knownServiceKeys.has(key))
      .map((key) => ({ key, name: key, active: false })),
  );
  const services = allServiceDefinitions.map((service) => {
    const traffic = serviceTraffic[service.key] || {};
    const ordersForService = serviceOrderMap[service.key] || {
      orders: 0,
      paid: 0,
      codeOrders: 0,
      revenue: 0,
      directRevenue: 0,
      codeRevenue: 0,
    };
    return {
      key: service.key,
      name: service.name,
      active: service.active,
      views: Number(traffic.views || 0),
      cta: Number(traffic.cta || 0),
      ...ordersForService,
      completionRate: percent(ordersForService.paid, ordersForService.orders),
      revenueShare: percent(ordersForService.revenue, currentSales.revenue),
      aov: ordersForService.paid ? round2(ordersForService.revenue / ordersForService.paid) : 0,
    };
  }).sort((left, right) => right.revenue - left.revenue || right.orders - left.orders || right.views - left.views);

  const eventsTotal = flatToObj(eventsTotalRaw);
  const totals = {
    visitorsAll: Number(visitorsAll || 0),
    signups: Array.isArray(userEmails) ? userEmails.length : 0,
    serviceViewsAll: Number(eventsTotal.service_view || 0),
    checkoutStartedAll: Number(eventsTotal.checkout_started || 0),
    ordersAll: validOrders.length,
    paidAll: allSales.orders,
    completedAll: validOrders.filter((order) => order.status === "completed").length,
    codeOrdersAll: allSales.codeOrders,
    directRevenueAll: allSales.directRevenue,
    codeRevenueAll: allSales.codeRevenue,
    revenueAll: allSales.revenue,
  };

  return Response.json({
    ok: true,
    days,
    scope: {
      serviceCodeEquivalentIncluded: true,
      balanceCodeRedeemExcluded: true,
      invalidOrdersExcluded: true,
      serviceTrafficPeriod: "all_time",
    },
    funnel,
    compare,
    daily,
    bySource,
    payments,
    statuses,
    services,
    totals,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
