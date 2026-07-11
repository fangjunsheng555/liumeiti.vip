import {
  adminSessionFromRequest, isRootAdminSession, adminPermissionProfile,
  getOrderOverviewRows, listWithdrawals, listRedeemCodes, getAdminMailLog, listAllUserEmails,
  redisCmd,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { getAfterSalesCounts } from "../../after-sales/_store.js";

function beijingDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const ts = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function orderBeijingDateKey(order) {
  if (order.createdAt) return beijingDateKey(order.createdAt);
  const match = String(order.createdAtBeijing || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function orderServiceAmount(order) {
  const itemsTotal = Array.isArray(order.items)
    ? order.items.reduce((sum, item) => sum + Number(item?.amount || 0), 0)
    : 0;
  return Number(order.subtotal || itemsTotal || order.originalAmount || order.bundleFinalAmount || 0);
}

function orderRevenueAmount(order) {
  if (!["received", "completed"].includes(order.status || "received")) return 0;
  if (order.paymentMethod === "redeem" || order.paidCurrency === "CODE") {
    return orderServiceAmount(order);
  }
  return Number(order.finalAmount || (order.paidCurrency === "CNY" ? order.paidAmount : 0) || 0);
}

function minutesSince(value) {
  const time = new Date(value || "").getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 60000));
}

function isAbnormalOrder(order) {
  const status = order.status || "received";
  if (status === "invalid") return true;
  if (status !== "received") return false;
  const age = minutesSince(order.createdAt);
  const paymentMethod = order.paymentMethod || "alipay";
  if ((paymentMethod === "redeem" || paymentMethod === "balance") && age >= 15) return true;
  return age >= 30;
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const [ordersRaw, withdrawals, codes, mailLogs, userEmails, afterSalesCounts] = await Promise.all([
    getOrderOverviewRows(),
    listWithdrawals(),
    listRedeemCodes(),
    getAdminMailLog(),
    listAllUserEmails(),
    getAfterSalesCounts(),
  ]);

  const orders = ordersRaw
    .map((order) => ({
      orderId: order.orderId || "",
      status: order.status || "received",
      paymentMethod: order.paymentMethod || "alipay",
      paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
      usdtPayAmount: Number(order.usdtPayAmount || 0),
      usdtQuoteId: order.usdtQuoteId || "",
      usdtConfirmedAt: order.usdtConfirmedAt || "",
      createdAt: order.createdAt || "",
      createdAtBeijing: order.createdAtBeijing || "",
      email: order.email || "",
      serviceLabel: order.serviceLabel || "",
      displayAmount: order.paymentMethod === "redeem"
        ? orderServiceAmount(order)
        : Number(order.finalAmount || order.paidAmount || orderServiceAmount(order) || 0),
      revenueAmount: orderRevenueAmount(order),
    }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const latestOrder = orders[0] || null;
  const todayKey = beijingDateKey();
  const revenueOrders = orders.filter((order) => ["received", "completed"].includes(order.status));
  const totalRevenue = revenueOrders.reduce((sum, order) => sum + Number(order.revenueAmount || 0), 0);
  const todayRevenue = revenueOrders
    .filter((order) => orderBeijingDateKey(order) === todayKey)
    .reduce((sum, order) => sum + Number(order.revenueAmount || 0), 0);

  const overview = {
    ordersTotal: orders.length,
    todayOrders: orders.filter((order) => orderBeijingDateKey(order) === todayKey).length,
    todayRevenue: Math.round(todayRevenue * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    pendingOrders: orders.filter((order) => ["awaiting_quote", "pending_payment", "received"].includes(order.status)).length,
    receivedOrders: orders.filter((order) => order.status === "received").length,
    awaitingQuotes: orders.filter((order) => order.status === "awaiting_quote").length,
    pendingQuotePayments: orders.filter((order) => order.status === "pending_payment").length,
    abnormalOrders: orders.filter(isAbnormalOrder).length,
    usdtPendingConfirm: orders.filter((order) =>
      order.paidCurrency === "USDT" && order.status === "received" && !order.usdtConfirmedAt
      && order.usdtPayAmount > 0 && order.usdtQuoteId
    ).length,
    completedOrders: orders.filter((order) => order.status === "completed").length,
    invalidOrders: orders.filter((order) => order.status === "invalid").length,
    latestOrderId: latestOrder?.orderId || "",
    latestOrderAt: latestOrder?.createdAt || "",
    latestOrderTime: latestOrder?.createdAtBeijing || "",
    latestOrderEmail: latestOrder?.email || "",
    latestOrderService: latestOrder?.serviceLabel || "",
    latestOrderStatus: latestOrder?.status || "",
    latestOrderAmount: Math.round(Number(latestOrder?.displayAmount || 0) * 100) / 100,
    withdrawalsTotal: withdrawals.length,
    pendingWithdrawals: withdrawals.filter((item) => item.status === "pending").length,
    processingWithdrawals: withdrawals.filter((item) => item.status === "processing").length,
    activeCodes: codes.filter((item) => item.status === "active").length,
    usedCodes: codes.filter((item) => item.status === "used").length,
    voidCodes: codes.filter((item) => item.status === "void").length,
    failedMails: mailLogs.filter((item) => item.ok === false).length,
    usersTotal: userEmails.length,
    afterSalesTotal: Number(afterSalesCounts.all || 0),
    pendingAfterSales: Number(afterSalesCounts.pending || 0),
    completedAfterSales: Number(afterSalesCounts.completed || 0),
  };

  // 近 14 天订单/营收趋势(总览迷你趋势图 + 今日环比昨日)——直接用已加载的订单算,零额外 IO。
  const dayKeys = [];
  for (let i = 13; i >= 0; i -= 1) {
    dayKeys.push(beijingDateKey(new Date(Date.now() - i * 86400000)));
  }
  const trendIdx = {};
  const trend = dayKeys.map((date, i) => { trendIdx[date] = i; return { date, orders: 0, revenue: 0 }; });
  for (const order of orders) {
    const i = trendIdx[orderBeijingDateKey(order)];
    if (i == null) continue;
    trend[i].orders += 1;
    if (["received", "completed"].includes(order.status)) trend[i].revenue = Math.round((trend[i].revenue + Number(order.revenueAmount || 0)) * 100) / 100;
  }
  overview.trend = trend;
  const yesterday = trend[trend.length - 2] || { orders: 0, revenue: 0 };
  overview.yesterdayOrders = yesterday.orders;
  overview.yesterdayRevenue = yesterday.revenue;

  // 周期营收 + 客单价(全部从已加载订单算,零额外 IO)。营收口径与总营收一致:仅 received/completed。
  const dayKeyN = (n) => beijingDateKey(new Date(Date.now() - n * 86400000));
  const monthPrefix = todayKey.slice(0, 7); // YYYY-MM
  const key7 = dayKeyN(6), key30 = dayKeyN(29);
  let revenue7d = 0, revenue30d = 0, revenueMonth = 0, paidOrders = 0;
  for (const order of revenueOrders) {
    const dk = orderBeijingDateKey(order);
    const amt = Number(order.revenueAmount || 0);
    if (dk >= key7) revenue7d += amt;
    if (dk >= key30) revenue30d += amt;
    if (dk.startsWith(monthPrefix)) revenueMonth += amt;
    paidOrders += 1;
  }
  const round2 = (v) => Math.round(v * 100) / 100;
  overview.revenue7d = round2(revenue7d);
  overview.revenue30d = round2(revenue30d);
  overview.revenueMonth = round2(revenueMonth);
  overview.paidOrders = paidOrders;
  overview.avgOrderValue = paidOrders > 0 ? round2(totalRevenue / paidOrders) : 0;

  // 低库存预警(可管库存的角色):受限库存 ≤3 的规格(0=售罄)。
  if (adminPermissionProfile(session).canManageStock) {
    try {
      const { getMergedCatalog } = await import("../../_catalog.js");
      const { getCatalogStockMap } = await import("../../_utils.js");
      const catalog = await getMergedCatalog();
      const stockMap = await getCatalogStockMap(catalog);
      const low = [];
      for (const p of catalog) {
        if (p.active === false || p.quoteOnly) continue;
        for (const pl of (p.plans || [])) {
          if (pl.active === false) continue;
          const stock = stockMap[p.key + ":" + pl.id];
          if (stock != null && stock <= 3) {
            low.push({ key: p.key, title: p.title, planId: pl.id, planLabel: pl.label, stock });
          }
        }
      }
      overview.lowStock = low.sort((a, b) => a.stock - b.stock).slice(0, 12);
    } catch (e) {}
  }

  // 弃单待召回计数（仅超管，给 tab 徽章用；ZCARD 廉价单次调用）
  if (isRootAdminSession(session)) {
    try { overview.abandonedTotal = Number((await redisCmd(["ZCARD", "lm:cart:index"])) || 0); } catch (e) {}
  }
  try {
    overview.usdtAutoConfirm = Boolean((await getSettings()).usdt.autoConfirm);
  } catch (e) {
    overview.usdtAutoConfirm = false;
  }

  return Response.json({
    ok: true,
    overview,
    currentStaff: {
      id: Number(session.staffId || 1),
      username: session.staffUsername || "admin",
      root: isRootAdminSession(session),
      role: adminPermissionProfile(session).role,
      permissions: adminPermissionProfile(session),
    },
  });
}
