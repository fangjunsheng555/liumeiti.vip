// 后台「数据洞察」数据接口。仅超级管理员可见。
// 成交额 = 直接支付成交额 + 已核销服务兑换码的商品等值金额；余额码只在余额实际支付订单时计入，避免重复。
import { randomBytes } from "node:crypto";
import {
  adminSessionFromRequest, isRootAdminSession,
  redisPipeline, getAllOrdersStrict, listAllUserEmailsStrict,
} from "../../_utils.js";
import { getMergedCatalog } from "../../_catalog.js";
import {
  PAYMENT_CHANNEL_LABELS,
  ORDER_STATUS_LABELS,
  addValueBreakdown,
  isRecognizedSale,
  isServiceCodeOrder,
  intersectionSize,
  orderVisitorId,
  orderServiceAllocations,
  orderSource,
  orderValueBreakdown,
  paymentChannel,
  percent,
  round2,
} from "./metrics.js";
import { effectiveQuoteStatus } from "../../_quote-expiry.js";

export const runtime = "nodejs";

const DAY_MS = 86400000;
const ALLOWED_DAYS = [7, 30, 90];
const UNIQUE_TTL_SECONDS = 180 * 24 * 60 * 60;
const VISITOR_INDEX_KEY = "lm:visit:index";
const VISITOR_RECORD_PREFIX = "lm:visit:v:";
const VISITOR_DAY_PREFIX = "lm:visit:day:";
const EVENT_UNIQUE_DAY_PREFIX = "lm:ev:uniq:";
const UNIQUE_BACKFILL_KEY = "lm:analytics:unique-backfill:v2";
const UNIQUE_BACKFILL_LOCK_KEY = UNIQUE_BACKFILL_KEY + ":lock";
const FUNNEL_EVENTS = new Set(["service_view", "cta_click", "checkout_started"]);

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

function beijingDayStart(ms) {
  const value = new Date(ms + 8 * 3600 * 1000);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3600 * 1000;
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

function pipelineResult(value) {
  return value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : value;
}

function validRedisCount(value) {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
}

async function strictRedisValues(commands, code = "insights_store_unavailable") {
  const response = await redisPipeline([...commands, ["PING"]]);
  if (!Array.isArray(response) || response.length !== commands.length + 1
      || response.some((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "error"))) {
    throw new Error(code);
  }
  const values = response.map(pipelineResult);
  if (values.at(-1) !== "PONG" || values.slice(0, -1).some((value) => value === undefined)) {
    throw new Error(code);
  }
  return values.slice(0, -1);
}

async function deleteBackfillCompletion() {
  try {
    const [removed] = await strictRedisValues([["DEL", UNIQUE_BACKFILL_KEY]], "insights_backfill_cleanup_failed");
    if (removed == null || !Number.isSafeInteger(Number(removed)) || Number(removed) < 0) throw new Error("insights_backfill_cleanup_failed");
  } catch (error) {
    console.warn("[insights] analytics backfill completion cleanup failed", { error: error?.message || String(error) });
  }
}

async function releaseOwnedBackfillLock(token) {
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  try {
    const [removed] = await strictRedisValues([
      ["EVAL", script, "1", UNIQUE_BACKFILL_LOCK_KEY, token],
    ], "insights_backfill_lock_release_failed");
    if (![0, 1].includes(Number(removed))) throw new Error("insights_backfill_lock_release_failed");
  } catch (error) {
    console.warn("[insights] analytics backfill lock release failed", { error: error?.message || String(error) });
  }
}

function parseTimelineEntry(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (error) { return null; }
}

function uniqueMembers(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function addBackfillMember(groups, key, visitorId) {
  if (!key || !visitorId) return;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(visitorId);
}

async function ensureUniqueAnalyticsBackfill(now = Date.now()) {
  const [completed] = await strictRedisValues([["GET", UNIQUE_BACKFILL_KEY]]);
  if (completed) return;
  const lockToken = randomBytes(24).toString("hex");
  const [locked] = await strictRedisValues([["SET", UNIQUE_BACKFILL_LOCK_KEY, lockToken, "NX", "EX", "300"]]);
  if (locked !== "OK") return;
  try {
    const [ids] = await strictRedisValues([["ZRANGE", VISITOR_INDEX_KEY, "0", "-1"]]);
    if (!Array.isArray(ids)) throw new Error("insights_backfill_index_unavailable");
    const groups = new Map();
    const cutoff = now - UNIQUE_TTL_SECONDS * 1000;
    let skippedTimelineRecords = 0;
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200).map(String);
      const timelineRows = await strictRedisValues(batch.flatMap((id) => [
        ["LRANGE", VISITOR_RECORD_PREFIX + id + ":pages", "0", "-1"],
        ["LRANGE", VISITOR_RECORD_PREFIX + id + ":events", "0", "-1"],
      ]), "insights_backfill_timeline_unavailable");
      batch.forEach((id, index) => {
        const pages = timelineRows[index * 2];
        const events = timelineRows[index * 2 + 1];
        if (!Array.isArray(pages) || !Array.isArray(events)) throw new Error("insights_backfill_timeline_unavailable");
        for (const raw of pages) {
          const entry = parseTimelineEntry(raw);
          const timestamp = Number(entry?.ts || 0);
          if (!entry || !Number.isFinite(timestamp) || timestamp <= 0) {
            skippedTimelineRecords += 1;
            continue;
          }
          if (timestamp < cutoff || timestamp > now + DAY_MS) continue;
          addBackfillMember(groups, VISITOR_DAY_PREFIX + dayKey(timestamp), id);
        }
        for (const raw of events) {
          const entry = parseTimelineEntry(raw);
          const timestamp = Number(entry?.ts || 0);
          if (!entry || !Number.isFinite(timestamp) || timestamp <= 0) {
            skippedTimelineRecords += 1;
            continue;
          }
          if (timestamp < cutoff || timestamp > now + DAY_MS) continue;
          const day = dayKey(timestamp);
          addBackfillMember(groups, VISITOR_DAY_PREFIX + day, id);
          if (FUNNEL_EVENTS.has(entry?.name)) {
            addBackfillMember(groups, EVENT_UNIQUE_DAY_PREFIX + day + ":" + entry.name, id);
          }
        }
      });
    }
    if (skippedTimelineRecords) console.warn("[insights] skipped unreadable analytics timeline records during backfill", { skipped: skippedTimelineRecords });
    const commands = [];
    groups.forEach((members, key) => {
      if (!members.size) return;
      commands.push(["SADD", key, ...members], ["EXPIRE", key, String(UNIQUE_TTL_SECONDS)]);
    });
    for (let offset = 0; offset < commands.length; offset += 100) {
      const results = await strictRedisValues(commands.slice(offset, offset + 100), "insights_backfill_write_failed");
      // audit-partial-failure: allow partial-failure-predicate-abort -- Backfill writes are an all-or-nothing pre-completion integrity fence.
      if (results.some((value) => !validRedisCount(value))) throw new Error("insights_backfill_write_failed");
    }
    const [saved] = await strictRedisValues([["SET", UNIQUE_BACKFILL_KEY, new Date(now).toISOString()]], "insights_backfill_write_failed");
    if (saved !== "OK") throw new Error("insights_backfill_write_failed");
  } catch (error) {
    await deleteBackfillCompletion();
    throw error;
  } finally {
    await releaseOwnedBackfillLock(lockToken);
  }
}

async function unionAnalyticsMembers(keys) {
  if (!Array.isArray(keys) || !keys.length) return new Set();
  const [members] = await strictRedisValues([["SUNION", ...keys]]);
  if (!Array.isArray(members)) throw new Error("insights_store_unavailable");
  return uniqueMembers(members);
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
  const todayStart = beijingDayStart(now);
  const currentStart = todayStart - (days - 1) * DAY_MS;
  const previousStart = currentStart - days * DAY_MS;
  const currentDayKeys = [];
  const previousDayKeys = [];
  for (let index = days - 1; index >= 0; index -= 1) currentDayKeys.push(dayKey(now - index * DAY_MS));
  for (let index = 2 * days - 1; index >= days; index -= 1) previousDayKeys.push(dayKey(now - index * DAY_MS));
  const visitKeys = (keys) => keys.map((key) => VISITOR_DAY_PREFIX + key);
  const eventKeys = (keys, name) => keys.map((key) => EVENT_UNIQUE_DAY_PREFIX + key + ":" + name);
  const dailyUniqueCommands = currentDayKeys.flatMap((key) => [
    ["SCARD", EVENT_UNIQUE_DAY_PREFIX + key + ":service_view"],
    ["SCARD", EVENT_UNIQUE_DAY_PREFIX + key + ":cta_click"],
    ["SCARD", EVENT_UNIQUE_DAY_PREFIX + key + ":checkout_started"],
  ]);

  let visitorsAll;
  let eventsTotalRaw;
  let userEmails;
  let ordersRaw;
  let currentVisitorMembers;
  let previousVisitorMembers;
  let currentViewMembers;
  let previousViewMembers;
  let currentCtaMembers;
  let currentCheckoutMembers;
  let previousCheckoutMembers;
  let dailyUniqueRaws;
  let serviceRaws;
  try {
    await ensureUniqueAnalyticsBackfill(now);
    const [
      overviewValues,
      loadedUserEmails,
      loadedOrders,
      currentVisitors,
      previousVisitors,
      currentViews,
      previousViews,
      currentCtas,
      currentCheckouts,
      previousCheckouts,
      loadedDailyValues,
      loadedServiceValues,
    ] = await Promise.all([
      strictRedisValues([["ZCARD", VISITOR_INDEX_KEY], ["HGETALL", "lm:ev:total"]]),
      listAllUserEmailsStrict(),
      getAllOrdersStrict(),
      unionAnalyticsMembers(visitKeys(currentDayKeys)),
      unionAnalyticsMembers(visitKeys(previousDayKeys)),
      unionAnalyticsMembers(eventKeys(currentDayKeys, "service_view")),
      unionAnalyticsMembers(eventKeys(previousDayKeys, "service_view")),
      unionAnalyticsMembers(eventKeys(currentDayKeys, "cta_click")),
      unionAnalyticsMembers(eventKeys(currentDayKeys, "checkout_started")),
      unionAnalyticsMembers(eventKeys(previousDayKeys, "checkout_started")),
      strictRedisValues(dailyUniqueCommands),
      strictRedisValues(serviceDefinitions.map((service) => ["HGETALL", "lm:svc:" + service.key])),
    ]);
    [visitorsAll, eventsTotalRaw] = overviewValues;
    userEmails = loadedUserEmails;
    ordersRaw = loadedOrders;
    currentVisitorMembers = currentVisitors;
    previousVisitorMembers = previousVisitors;
    currentViewMembers = currentViews;
    previousViewMembers = previousViews;
    currentCtaMembers = currentCtas;
    currentCheckoutMembers = currentCheckouts;
    previousCheckoutMembers = previousCheckouts;
    dailyUniqueRaws = loadedDailyValues;
    serviceRaws = loadedServiceValues;

    const visitorTotal = Number(visitorsAll);
    if (visitorsAll == null || !Number.isSafeInteger(visitorTotal) || visitorTotal < 0
        || (!Array.isArray(eventsTotalRaw) && (!eventsTotalRaw || typeof eventsTotalRaw !== "object"))
        || !Array.isArray(userEmails) || !Array.isArray(ordersRaw)
        || dailyUniqueRaws.length !== dailyUniqueCommands.length
        || dailyUniqueRaws.some((value) => value == null || !Number.isSafeInteger(Number(value)) || Number(value) < 0)
        || serviceRaws.length !== serviceDefinitions.length
        || serviceRaws.some((value) => !Array.isArray(value) && (!value || typeof value !== "object"))) {
      throw new Error("insights_store_invalid");
    }
  } catch (error) {
    console.error("[insights] analytics data unavailable", error?.message || error);
    return Response.json({ ok: false, error: "insights_store_unavailable" }, { status: 503 });
  }

  const uniqueDayMap = {};
  currentDayKeys.forEach((key, index) => {
    uniqueDayMap[key] = {
      service_view: Number(dailyUniqueRaws[index * 3]),
      cta_click: Number(dailyUniqueRaws[index * 3 + 1]),
      checkout_started: Number(dailyUniqueRaws[index * 3 + 2]),
    };
  });

  const orders = ordersRaw;
  const rangeOrders = orders.filter((order) => orderInRange(order, currentStart, now + 1));
  const previousRangeOrders = orders.filter((order) => orderInRange(order, previousStart, currentStart));
  const validOrders = orders.filter((order) => order.status !== "invalid");
  const currentValid = rangeOrders.filter((order) => order.status !== "invalid");
  const previousValid = previousRangeOrders.filter((order) => order.status !== "invalid");
  const currentSales = summarizeSales(currentValid);
  const previousSales = summarizeSales(previousValid);
  const allSales = summarizeSales(validOrders);

  const currentViews = currentViewMembers.size;
  const currentCta = currentCtaMembers.size;
  const currentCheckout = currentCheckoutMembers.size;
  const previousViews = previousViewMembers.size;
  const previousCheckout = previousCheckoutMembers.size;
  const currentVisitorCount = currentVisitorMembers.size;
  const previousVisitorCount = previousVisitorMembers.size;
  const completedCurrent = currentValid.filter((order) => order.status === "completed").length;
  const currentOrderVisitorIds = currentValid.map(orderVisitorId);
  const paidOrders = currentValid.filter(isRecognizedSale);
  const currentPaidVisitorIds = paidOrders.map(orderVisitorId);
  const missingOrderAttribution = currentOrderVisitorIds.filter((id) => !id).length;
  const missingPaidAttribution = currentPaidVisitorIds.filter((id) => !id).length;
  if (missingOrderAttribution || missingPaidAttribution) {
    // Historical/guest orders may legitimately predate visitor attribution.
    // Keep order and revenue totals intact; only the visitor-linked funnel is smaller.
    console.warn("[insights] orders without visitor attribution excluded from funnel identity counts", {
      orders: missingOrderAttribution,
      paid: missingPaidAttribution,
    });
  }
  const currentOrderVisitors = uniqueMembers(currentOrderVisitorIds.filter(Boolean));
  const currentPaidVisitors = uniqueMembers(currentPaidVisitorIds.filter(Boolean));

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
      viewToCheckout: percent(intersectionSize(currentViewMembers, currentCheckoutMembers), currentViews),
      checkoutToPaid: percent(intersectionSize(currentCheckoutMembers, currentPaidVisitors), currentCheckout),
      visitorToPaid: percent(intersectionSize(currentVisitorMembers, currentPaidVisitors), currentVisitorCount),
      checkoutToOrder: percent(intersectionSize(currentCheckoutMembers, currentOrderVisitors), currentCheckout),
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
    const events = uniqueDayMap[key] || {};
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
    const key = effectiveQuoteStatus(order);
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  });
  const statusPriority = ["completed", "received", "awaiting_quote", "pending_payment", "quote_expired", "invalid"];
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
    serviceTraffic[service.key] = flatToObj(serviceRaws[index]);
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
      funnelTrafficUnit: "unique_visitors",
      funnelTimezone: "Asia/Shanghai",
      unattributedCurrentOrders: currentValid.filter((order) => !orderVisitorId(order)).length,
      uniqueHistoryBackfilledFromRetainedEvents: true,
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

export const insightsInternals = {
  ensureUniqueAnalyticsBackfill,
  strictRedisValues,
};

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
