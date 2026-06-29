import {
  getAllOrders,
  formatBeijingTime,
  adminSessionFromRequest,
  isRootAdminSession,
  adminPermissionProfile,
} from "../../_utils.js";

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function minutesSince(value) {
  const time = new Date(value || "").getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 60000));
}

function abnormalInfo(order) {
  const status = order.status || "received";
  if (status === "invalid") return { abnormal: true, reason: "已标记无效", level: "danger" };
  if (status !== "received") return { abnormal: false, reason: "", level: "" };
  const age = minutesSince(order.createdAt);
  const paymentMethod = order.paymentMethod || "alipay";
  if ((paymentMethod === "redeem" || paymentMethod === "balance") && age >= 15) {
    return { abnormal: true, reason: `免支付订单待处理 ${age} 分钟`, level: "warn" };
  }
  if (age >= 30) return { abnormal: true, reason: `待处理 ${age} 分钟`, level: "warn" };
  return { abnormal: false, reason: "", level: "" };
}

function normalizeOrder(order) {
  // Ensure items array exists; add defaults
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => ({
      service: it.service || "",
      label: it.label || "",
      cycle: it.cycle || "",
      amount: Number(it.amount || 0),
      account: it.account || "",
      password: it.password || "",
      staffAccount: it.staffAccount || "",
      staffPassword: it.staffPassword || "",
      subscriptionLinks: it.subscriptionLinks || (it.service === "rocket" && (it.staffAccount || it.account) ? subscriptionLinks(it.staffAccount || it.account) : null),
    }));
  } else {
    items = [{
      service: order.service || "",
      label: order.serviceLabel || "",
      cycle: order.cycle || "",
      amount: Number(order.finalAmount || 0),
      account: order.account || "",
      password: order.password || "",
      staffAccount: "",
      staffPassword: "",
      subscriptionLinks: order.service === "rocket" && order.account ? subscriptionLinks(order.account) : null,
    }];
  }
  const abnormal = abnormalInfo(order);
  const referralEntries = Array.isArray(order.referralCommissionEntries)
    ? order.referralCommissionEntries.map((entry) => ({
      email: entry?.email || "",
      level: Number(entry?.level || 0),
      rate: Number(entry?.rate || 0),
      amount: Number(entry?.amount || 0),
      balanceAfter: Number(entry?.balanceAfter || 0),
    }))
    : [];
  const referralReversedEntries = Array.isArray(order.referralCommissionReversedEntries)
    ? order.referralCommissionReversedEntries.map((entry) => ({
      email: entry?.email || "",
      level: Number(entry?.level || 0),
      amount: Number(entry?.amount || 0),
      balanceAfter: Number(entry?.balanceAfter || 0),
    }))
    : [];
  return {
    orderId: order.orderId || "",
    status: order.status || "received",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAt: order.completedAt || null,
    completedAtBeijing: order.completedAtBeijing || null,
    items,
    itemCount: items.length,
    serviceLabel: order.serviceLabel || items.map((i) => i.label).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    redeemCode: order.redeemCode || "",
    redeemCodeType: order.redeemCodeType || "",
    subtotal: Number(order.subtotal || items.reduce((s, i) => s + i.amount, 0)),
    discountRate: Number(order.discountRate || 0),
    discountLabel: order.discountLabel || "",
    bundleFinalAmount: Number(order.bundleFinalAmount || 0),
    couponDiscount: Number(order.couponDiscount || 0),
    couponTitle: order.couponTitle || "",
    finalAmount: Number(order.finalAmount || 0),
    finalUsdt: Number(order.finalUsdt || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    referral: order.referral ? {
      source: order.referral.source || "",
      inviteCode: order.referral.inviteCode || "",
      levelOneEmail: order.referral.levelOneEmail || "",
      levelOneRate: Number(order.referral.levelOneRate || 0),
      levelTwoEmail: order.referral.levelTwoEmail || "",
      levelTwoRate: Number(order.referral.levelTwoRate || 0),
    } : null,
    referralCommissionSettledAt: order.referralCommissionSettledAt || "",
    referralCommissionSettledAtBeijing: order.referralCommissionSettledAtBeijing || "",
    referralCommissionEntries: referralEntries,
    referralCommissionReversedAt: order.referralCommissionReversedAt || "",
    referralCommissionReversedAtBeijing: order.referralCommissionReversedAtBeijing || "",
    referralCommissionReversedEntries: referralReversedEntries,
    refundedAt: order.refundedAt || "",
    refundedAtBeijing: order.refundedAtBeijing || "",
    refund: order.refund ? {
      balance: Number(order.refund.balance || 0),
      coupon: !!order.refund.coupon,
      redeem: !!order.refund.redeem,
    } : null,
    paidByBalance: !!order.paidByBalance,
    couponId: order.couponId || "",
    couponTitle: order.couponTitle || "",
    couponDiscount: Number(order.couponDiscount || 0),
    email: order.email || "",
    contact: order.contact || "",
    clientIp: order.clientIp || "",
    userAgent: order.userAgent || "",
    remark: order.remark || "",
    staffNotes: order.staffNotes || "",
    staffAudit: Array.isArray(order.staffAudit) ? order.staffAudit : [],
    lastStaffId: Array.isArray(order.staffAudit) && order.staffAudit[0]?.staffId ? Number(order.staffAudit[0].staffId) : null,
    abnormal: abnormal.abnormal,
    abnormalReason: abnormal.reason,
    abnormalLevel: abnormal.level,
  };
}

function csvCell(v) {
  const s = String(v == null ? "" : v).replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function ordersToCsv(orders) {
  const head = ["订单号", "状态", "下单时间", "完成时间", "服务", "件数", "支付方式", "实付金额", "实付币种", "折后CNY", "优惠券抵扣", "下单邮箱", "联系方式", "用户IP", "买家备注", "客服备注"];
  const statusLabel = { received: "未完成", completed: "已完成", invalid: "无效" };
  const rows = orders.map((o) => [
    o.orderId, statusLabel[o.status] || o.status, o.createdAtBeijing, o.completedAtBeijing || "",
    o.serviceLabel, o.itemCount, o.paymentMethod, o.paidAmount, o.paidCurrency,
    o.finalAmount, o.couponDiscount, o.email, o.contact, o.clientIp, o.remark, o.staffNotes,
  ].map(csvCell).join(","));
  return "﻿" + [head.map(csvCell).join(","), ...rows].join("\r\n"); // BOM 兼容 Excel 中文
}

// GET /api/admin/orders[?q=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD&offset=&limit=&format=csv]
export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const status = String(url.searchParams.get("status") || "").trim();
  const from = String(url.searchParams.get("from") || "").trim();   // 北京日期 起
  const to = String(url.searchParams.get("to") || "").trim();       // 北京日期 止
  const format = String(url.searchParams.get("format") || "").trim();
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));

  const all = await getAllOrders();
  let filtered = all.map(normalizeOrder);
  if (status === "abnormal") {
    filtered = filtered.filter((o) => o.abnormal);
  } else if (status === "received" || status === "completed" || status === "invalid") {
    filtered = filtered.filter((o) => o.status === status);
  }
  if (from || to) {
    filtered = filtered.filter((o) => {
      const d = String(o.createdAtBeijing || "").slice(0, 10); // YYYY-MM-DD
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  if (q) {
    filtered = filtered.filter((o) => {
      const hay = [
        o.orderId, o.email, o.contact, o.serviceLabel, o.staffNotes, o.remark,
        ...o.items.flatMap((i) => [i.label, i.account, i.password, i.staffAccount, i.staffPassword]),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  // CSV 导出:按当前筛选导出全部匹配(不分页),仅可看订单的角色
  if (format === "csv") {
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return new Response(ordersToCsv(filtered), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json({
    ok: true,
    orders: filtered.slice(offset, offset + limit),
    total: all.length,
    filteredCount: filtered.length,
    offset, limit,
    hasMore: offset + limit < filtered.length,
    currentStaff: {
      id: Number(session.staffId || 1),
      username: session.staffUsername || "admin",
      root: isRootAdminSession(session),
      role: adminPermissionProfile(session).role,
      permissions: adminPermissionProfile(session),
    },
  });
}
