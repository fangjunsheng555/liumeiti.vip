import { hasPendingSpotifyPasswordCorrection } from "./order-attention.js";

const MINUTE = 60 * 1000;

export const ORDER_SLA_MINUTES = Object.freeze({
  instant: 15,
  standard: 30,
  quote: 120,
  proxyPaid: 240,
});

function timestamp(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function inactive(state, label) {
  return {
    active: false,
    overdue: false,
    state,
    label,
    expectedMinutes: 0,
    remainingMinutes: 0,
    overdueMinutes: 0,
    dueAt: "",
    key: "",
  };
}

export function getOrderSla(order, now = Date.now()) {
  if (!order || order.deleted) return inactive("closed", "无需处理");
  const status = String(order.status || "received");
  if (["completed", "invalid", "quote_expired"].includes(status)) return inactive("closed", "已结束");
  if (status === "pending_payment") return inactive("waiting", "等待用户付款");
  if (hasPendingSpotifyPasswordCorrection(order)) return inactive("waiting", "等待用户更新资料");

  const usdtPending = status === "received"
    && (order.paidCurrency === "USDT" || order.paymentMethod === "usdt")
    && !order.usdtConfirmedAt;
  if (usdtPending) return inactive("waiting", "等待链上确认");

  let expectedMinutes = 0;
  let baseAt = 0;
  let label = "";
  if (status === "awaiting_quote") {
    expectedMinutes = ORDER_SLA_MINUTES.quote;
    baseAt = timestamp(order.createdAt);
    label = "预计 2 小时内报价";
  } else if (status === "received" && order.orderType === "proxy_payment") {
    expectedMinutes = ORDER_SLA_MINUTES.proxyPaid;
    baseAt = timestamp(order.paymentSubmittedAt) || timestamp(order.usdtConfirmedAt) || timestamp(order.createdAt);
    label = "预计 4 小时内处理";
  } else if (status === "received") {
    const instant = order.paymentMethod === "redeem" || order.paymentMethod === "balance";
    expectedMinutes = instant ? ORDER_SLA_MINUTES.instant : ORDER_SLA_MINUTES.standard;
    baseAt = timestamp(order.usdtConfirmedAt) || timestamp(order.createdAt);
    label = instant ? "预计 15 分钟内处理" : "预计 30 分钟内处理";
  } else {
    return inactive("waiting", "等待下一步");
  }

  if (!baseAt) return inactive("waiting", "等待时间记录");
  const nowAt = now instanceof Date ? now.getTime() : Number(now);
  const effectiveNow = Number.isFinite(nowAt) ? nowAt : Date.now();
  const dueAtMs = baseAt + expectedMinutes * MINUTE;
  const overdue = effectiveNow > dueAtMs;
  const remainingMinutes = Math.ceil((dueAtMs - effectiveNow) / MINUTE);
  const overdueMinutes = Math.ceil((effectiveNow - dueAtMs) / MINUTE);
  return {
    active: true,
    overdue,
    state: overdue ? "overdue" : "active",
    label,
    expectedMinutes,
    remainingMinutes: overdue ? 0 : Math.max(0, remainingMinutes),
    overdueMinutes: overdue ? Math.max(1, overdueMinutes) : 0,
    dueAt: new Date(dueAtMs).toISOString(),
    key: `${status}:${new Date(baseAt).toISOString()}:${new Date(dueAtMs).toISOString()}`,
  };
}
