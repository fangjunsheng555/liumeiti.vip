import {
  adminSessionFromRequest, isRootAdminSession,
  getAllOrders, listWithdrawals, listRedeemCodes, getAdminMailLog, listAllUserEmails,
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

  return Response.json({
    ok: true,
    overview,
    currentStaff: {
      id: Number(session.staffId || 1),
      username: session.staffUsername || "admin",
      root: isRootAdminSession(session),
    },
  });
}
