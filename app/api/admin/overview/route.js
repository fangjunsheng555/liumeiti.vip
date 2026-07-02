import {
  adminSessionFromRequest, isRootAdminSession, adminPermissionProfile,
  getAllOrders, listWithdrawals, listRedeemCodes, getAdminMailLog, listAllUserEmails,
  redisCmd,
} from "../../_utils.js";

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

  const [ordersRaw, withdrawals, codes, mailLogs, userEmails] = await Promise.all([
    getAllOrders(),
    listWithdrawals(),
    listRedeemCodes(),
    getAdminMailLog(),
    listAllUserEmails(),
  ]);

  const orders = ordersRaw
    .map((order) => ({
      orderId: order.orderId || "",
      status: order.status || "received",
      paymentMethod: order.paymentMethod || "alipay",
      createdAt: order.createdAt || "",
      createdAtBeijing: order.createdAtBeijing || "",
      email: order.email || "",
      serviceLabel: order.serviceLabel || "",
      revenueAmount: orderRevenueAmount(order),
    }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const latestOrder = orders[0] || null;
  const todayKey = beijingDateKey();
  const revenueOrders = orders.filter((order) => order.status !== "invalid");
  const totalRevenue = revenueOrders.reduce((sum, order) => sum + Number(order.revenueAmount || 0), 0);
  const todayRevenue = revenueOrders
    .filter((order) => orderBeijingDateKey(order) === todayKey)
    .reduce((sum, order) => sum + Number(order.revenueAmount || 0), 0);

  const overview = {
    ordersTotal: orders.length,
    todayOrders: orders.filter((order) => orderBeijingDateKey(order) === todayKey).length,
    todayRevenue: Math.round(todayRevenue * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    pendingOrders: orders.filter((order) => order.status === "received").length,
    abnormalOrders: orders.filter(isAbnormalOrder).length,
    completedOrders: orders.filter((order) => order.status === "completed").length,
    invalidOrders: orders.filter((order) => order.status === "invalid").length,
    latestOrderId: latestOrder?.orderId || "",
    latestOrderAt: latestOrder?.createdAt || "",
    latestOrderTime: latestOrder?.createdAtBeijing || "",
    latestOrderEmail: latestOrder?.email || "",
    latestOrderService: latestOrder?.serviceLabel || "",
    withdrawalsTotal: withdrawals.length,
    pendingWithdrawals: withdrawals.filter((item) => item.status === "pending").length,
    processingWithdrawals: withdrawals.filter((item) => item.status === "processing").length,
    activeCodes: codes.filter((item) => item.status === "active").length,
    usedCodes: codes.filter((item) => item.status === "used").length,
    voidCodes: codes.filter((item) => item.status === "void").length,
    failedMails: mailLogs.filter((item) => item.ok === false).length,
    usersTotal: userEmails.length,
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
    if (order.status !== "invalid") trend[i].revenue = Math.round((trend[i].revenue + Number(order.revenueAmount || 0)) * 100) / 100;
  }
  overview.trend = trend;
  const yesterday = trend[trend.length - 2] || { orders: 0, revenue: 0 };
  overview.yesterdayOrders = yesterday.orders;
  overview.yesterdayRevenue = yesterday.revenue;

  // 低库存预警(可管库存的角色):受限库存 ≤3 的规格(0=售罄)。
  if (adminPermissionProfile(session).canManageStock) {
    try {
      const { getMergedCatalog } = await import("../../_catalog.js");
      const { getCatalogStockMap } = await import("../../_utils.js");
      const catalog = await getMergedCatalog();
      const stockMap = await getCatalogStockMap(catalog);
      const low = [];
      for (const p of catalog) {
        if (p.active === false) continue;
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
