import {
  getAllOrders, getOrderOverviewRows, getOrderSummariesPageFast, getOrderListRevision,
  adminSessionFromRequest,
  isRootAdminSession,
  adminPermissionProfile,
  listAssignableAdminStaff,
} from "../../_utils.js";
import { hasPendingSpotifyPasswordCorrection } from "../../../lib/order-attention.js";
import { getOrderSla } from "../../../lib/order-sla.js";
import { effectiveQuoteStatus } from "../../_quote-expiry.js";

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function abnormalInfo(order, status = effectiveQuoteStatus(order)) {
  if (status === "invalid") return { abnormal: true, reason: "已标记无效", level: "danger" };
  if (status === "quote_expired") return { abnormal: true, reason: "报价已失效，等待重新报价", level: "warn" };
  if (hasPendingSpotifyPasswordCorrection(order)) {
    return { abnormal: true, reason: "Spotify 登录资料待用户更新", level: "warn" };
  }
  const sla = getOrderSla({ ...order, status });
  if (sla.overdue) return { abnormal: true, reason: `已超过预计处理时间 ${sla.overdueMinutes} 分钟`, level: "warn" };
  return { abnormal: false, reason: "", level: "" };
}

function normalizeOrder(order) {
  const status = effectiveQuoteStatus(order);
  // Ensure items array exists; add defaults
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => ({
      service: it.service || "",
      label: it.label || "",
      cycle: it.cycle || "",
      amount: Number(it.amount || 0),
      plan: it.plan || it.rocketPlan || "",
      planLabel: it.planLabel || it.rocketPlanLabel || "",
      platformUrl: it.platformUrl || "",
      productPrice: it.productPrice || "",
      account: it.account || "",
      password: it.password || "",
      staffAccount: it.staffAccount || "",
      staffPassword: it.staffPassword || "",
      passwordCorrectionRequestedAt: it.passwordCorrectionRequestedAt || "",
      passwordCorrectionRequestedAtBeijing: it.passwordCorrectionRequestedAtBeijing || "",
      passwordCorrectionExpiresAt: it.passwordCorrectionExpiresAt || "",
      passwordCorrectionEmailSentAtBeijing: it.passwordCorrectionEmailSentAtBeijing || "",
      passwordCorrectionEmailOk: Boolean(it.passwordCorrectionEmailOk),
      passwordCorrectionStaffNote: it.passwordCorrectionStaffNote || "",
      customerPasswordUpdatedAt: it.customerPasswordUpdatedAt || "",
      customerPasswordUpdatedAtBeijing: it.customerPasswordUpdatedAtBeijing || "",
      customerPasswordUpdateCount: Number(it.customerPasswordUpdateCount || 0),
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
  const abnormal = abnormalInfo(order, status);
  const sla = getOrderSla({ ...order, status });
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
    orderType: order.orderType || "standard",
    status,
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
    usdtPayAmount: Number(order.usdtPayAmount || 0),
    usdtConfirmedAmount: Number(order.usdtConfirmedAmount || 0),
    usdtConfirmedAt: order.usdtConfirmedAt || "",
    usdtConfirmedAtBeijing: order.usdtConfirmedAtBeijing || "",
    usdtChainTimestamp: order.usdtChainTimestamp || "",
    usdtTxId: order.usdtTxId || "",
    platformUrl: order.platformUrl || items[0]?.platformUrl || "",
    productPrice: order.productPrice || items[0]?.productPrice || "",
    quoteAmount: Number(order.quoteAmount || 0),
    quotedAtBeijing: order.quotedAtBeijing || "",
    quoteExpiresAt: order.quoteExpiresAt || "",
    quoteExpiresAtBeijing: order.quoteExpiresAtBeijing || "",
    quoteValidDays: Number(order.quoteValidDays || 7),
    quoteExpiredAtBeijing: order.quoteExpiredAtBeijing || "",
    quoteEmailSentAtBeijing: order.quoteEmailSentAtBeijing || "",
    quoteEmailOk: order.quoteEmailOk !== false,
    paymentSubmittedAtBeijing: order.paymentSubmittedAtBeijing || "",
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
    assignedStaffId: Number(order.assignedStaffId || 0),
    assignedStaffUsername: order.assignedStaffUsername || "",
    assignedAt: order.assignedAt || "",
    assignedAtBeijing: order.assignedAtBeijing || "",
    sla,
    abnormal: abnormal.abnormal,
    abnormalReason: abnormal.reason,
    abnormalLevel: abnormal.level,
  };
}

function normalizeOrderSummary(order) {
  const status = effectiveQuoteStatus(order);
  const items = Array.isArray(order.items) && order.items.length
    ? order.items.map((item) => ({
      service: item?.service || "",
      label: item?.label || "",
      cycle: item?.cycle || "",
      amount: Number(item?.amount || 0),
      plan: item?.plan || "",
      passwordCorrectionRequestedAt: item?.passwordCorrectionRequestedAt || "",
      customerPasswordUpdatedAt: item?.customerPasswordUpdatedAt || "",
      customerPasswordUpdatedAtBeijing: item?.customerPasswordUpdatedAtBeijing || "",
      customerPasswordUpdateCount: Number(item?.customerPasswordUpdateCount || 0),
    }))
    : [];
  const source = { ...order, status, items };
  const abnormal = abnormalInfo(source, status);
  return {
    _summaryOnly: true,
    orderId: order.orderId || "",
    orderType: order.orderType || "standard",
    status,
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    items,
    itemCount: items.length || 1,
    serviceLabel: order.serviceLabel || items.map((item) => item.label).filter(Boolean).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    finalAmount: Number(order.finalAmount || 0),
    paidAmount: Number(order.paidAmount || order.finalAmount || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    quoteAmount: Number(order.quoteAmount || 0),
    email: order.email || "",
    usdtConfirmedAt: order.usdtConfirmedAt || "",
    usdtTxId: order.usdtTxId || "",
    referral: order.referral?.levelOneEmail ? { levelOneEmail: order.referral.levelOneEmail } : null,
    referralCommissionSettledAt: order.referralCommissionSettledAt || "",
    referralCommissionSettledAtBeijing: order.referralCommissionSettledAtBeijing || "",
    referralCommissionEntries: Array.isArray(order.referralCommissionEntries) ? order.referralCommissionEntries : [],
    referralCommissionReversedAt: order.referralCommissionReversedAt || "",
    referralCommissionReversedAtBeijing: order.referralCommissionReversedAtBeijing || "",
    referralCommissionReversedEntries: Array.isArray(order.referralCommissionReversedEntries) ? order.referralCommissionReversedEntries : [],
    lastStaffId: Number(order.lastStaffId || 0) || null,
    assignedStaffId: Number(order.assignedStaffId || 0),
    assignedStaffUsername: order.assignedStaffUsername || "",
    sla: getOrderSla(source),
    abnormal: abnormal.abnormal,
    abnormalReason: abnormal.reason,
    abnormalLevel: abnormal.level,
  };
}

function applyOrderFilters(orders, { status, from, to }) {
  let filtered = orders;
  if (status === "abnormal") {
    filtered = filtered.filter((order) => order.abnormal);
  } else if (status === "sla_overdue") {
    filtered = filtered.filter((order) => order.sla?.overdue);
  } else if (["awaiting_quote", "pending_payment", "quote_expired", "received", "completed", "invalid"].includes(status)) {
    filtered = filtered.filter((order) => order.status === status);
  }
  if (from || to) {
    filtered = filtered.filter((order) => {
      const date = String(order.createdAtBeijing || "").slice(0, 10);
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });
  }
  return filtered;
}

function orderContactEmails(orders) {
  const emails = new Set();
  for (const order of orders) {
    const values = [order?.email, order?.userEmail, order?.contact];
    for (const value of values) {
      const matches = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      matches.forEach((email) => emails.add(email.toLowerCase()));
    }
  }
  return Array.from(emails);
}

function csvCell(v) {
  const s = String(v == null ? "" : v).replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function ordersToCsv(orders) {
  const head = ["订单号", "状态", "下单时间", "完成时间", "服务", "件数", "支付方式", "实付金额", "实付币种", "折后CNY", "优惠券抵扣", "下单邮箱", "联系方式", "用户IP", "买家备注", "客服备注"];
  const statusLabel = { awaiting_quote: "待报价", pending_payment: "待付款", quote_expired: "报价已失效", received: "已收到", completed: "已完成", invalid: "无效" };
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
  const mode = String(url.searchParams.get("mode") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const status = String(url.searchParams.get("status") || "").trim();
  const from = String(url.searchParams.get("from") || "").trim();
  const to = String(url.searchParams.get("to") || "").trim();
  const format = String(url.searchParams.get("format") || "").trim();
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const permissions = adminPermissionProfile(session);

  if (mode === "revision") {
    const revision = await getOrderListRevision();
    if (!revision) return Response.json({ ok: false, error: "order_revision_unavailable" }, { status: 503 });
    return Response.json({ ok: true, ...revision }, { headers: { "Cache-Control": "no-store" } });
  }

  if (mode === "recipient-emails") {
    const all = await getAllOrders();
    return Response.json({ ok: true, emails: orderContactEmails(all) }, { headers: { "Cache-Control": "no-store" } });
  }

  const assignableStaff = permissions.canEditOrders ? await listAssignableAdminStaff() : [];
  const currentStaff = {
    id: Number(session.staffId || 1),
    username: session.staffUsername || "admin",
    root: isRootAdminSession(session),
    role: permissions.role,
    permissions,
  };

  const noFilter = !q && !status && !from && !to && format !== "csv";
  if (noFilter) {
    const fast = await getOrderSummariesPageFast(offset, limit);
    if (fast) {
      return Response.json({
        ok: true,
        orders: fast.orders.map(normalizeOrderSummary),
        total: fast.total,
        filteredCount: fast.total,
        offset, limit,
        hasMore: fast.hasMore,
        listRevision: fast.listRevision,
        assignableStaff,
        currentStaff,
      }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  let allCount = 0;
  let filtered;
  if (q || format === "csv") {
    const all = await getAllOrders();
    allCount = all.length;
    let detailed = applyOrderFilters(all.map(normalizeOrder), { status, from, to });
    if (q) {
      detailed = detailed.filter((order) => {
        const hay = [
          order.orderId, order.email, order.contact, order.serviceLabel, order.staffNotes, order.remark,
          order.platformUrl, order.productPrice, order.assignedStaffUsername,
          ...order.items.flatMap((item) => [
            item.label, item.account, item.password, item.staffAccount, item.staffPassword,
            item.platformUrl, item.productPrice,
          ]),
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    if (format === "csv") {
      const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      return new Response(ordersToCsv(detailed), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="orders-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    filtered = detailed.map(normalizeOrderSummary);
  } else {
    const overviewRows = await getOrderOverviewRows();
    allCount = overviewRows.length;
    filtered = applyOrderFilters(overviewRows.map(normalizeOrderSummary), { status, from, to })
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  const revision = await getOrderListRevision();

  return Response.json({
    ok: true,
    orders: filtered.slice(offset, offset + limit),
    total: allCount,
    filteredCount: filtered.length,
    offset, limit,
    hasMore: offset + limit < filtered.length,
    listRevision: revision?.revision || "0",
    assignableStaff,
    currentStaff,
  }, { headers: { "Cache-Control": "no-store" } });
}
