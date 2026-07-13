const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function safeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function sumAmounts(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + safeAmount(row?.amount), 0);
}

export function isServiceCodeOrder(order) {
  return order?.paymentMethod === "redeem" || order?.paidCurrency === "CODE";
}

export function isRecognizedSale(order) {
  if (!order || order.status === "invalid") return false;
  if (order.status === "completed") return true;
  if (isServiceCodeOrder(order)) return true;
  if (order.paymentMethod === "balance") return true;
  return order.paidCurrency === "USDT" && Boolean(order.usdtConfirmedAt);
}

export function orderServiceValue(order) {
  const candidates = [
    order?.subtotal,
    order?.originalAmount,
    sumAmounts(order?.redeemServices),
    sumAmounts(order?.items),
    order?.bundleFinalAmount,
  ];
  const value = candidates.map(safeAmount).find((amount) => amount > 0);
  return round2(value || 0);
}

function directOrderValue(order) {
  const finalAmount = safeAmount(order?.finalAmount);
  if (finalAmount > 0) return round2(finalAmount);

  const quoteAmount = safeAmount(order?.quoteAmount);
  if (quoteAmount > 0) return round2(quoteAmount);

  if (order?.paidCurrency === "CNY") {
    const paidAmount = safeAmount(order?.paidAmount);
    if (paidAmount > 0) return round2(paidAmount);
  }

  if (order?.paidCurrency === "USDT") {
    const usdt = safeAmount(order?.usdtConfirmedAmount || order?.paidAmount || order?.usdtPayAmount);
    const rate = safeAmount(order?.usdtRate);
    if (usdt > 0 && rate > 0) return round2(usdt * rate);
  }

  // A legitimate fully-discounted order can have an explicit zero total.
  if (order && Object.prototype.hasOwnProperty.call(order, "finalAmount")) return 0;
  return round2(safeAmount(order?.bundleFinalAmount || order?.paidAmount));
}

export function orderValueBreakdown(order) {
  if (isServiceCodeOrder(order)) {
    const codeEquivalent = orderServiceValue(order);
    return { gross: codeEquivalent, direct: 0, codeEquivalent };
  }
  const direct = directOrderValue(order);
  return { gross: direct, direct, codeEquivalent: 0 };
}

function orderServiceRows(order) {
  const items = (Array.isArray(order?.items) ? order.items : [])
    .map((item) => ({
      service: String(item?.service || item?.key || "").trim(),
      amount: safeAmount(item?.amount),
    }))
    .filter((item) => item.service);
  if (items.length) return items;
  const legacyService = String(order?.service || "").trim();
  return legacyService ? [{ service: legacyService, amount: orderServiceValue(order) }] : [];
}

function splitAmount(total, groups) {
  if (!groups.length || total <= 0) return groups.map(() => 0);
  const weightTotal = groups.reduce((sum, group) => sum + group.weight, 0);
  let assigned = 0;
  return groups.map((group, index) => {
    if (index === groups.length - 1) return round2(total - assigned);
    const share = weightTotal > 0 ? group.weight / weightTotal : 1 / groups.length;
    const amount = round2(total * share);
    assigned = round2(assigned + amount);
    return amount;
  });
}

export function orderServiceAllocations(order) {
  const grouped = new Map();
  orderServiceRows(order).forEach((item) => {
    grouped.set(item.service, safeAmount(grouped.get(item.service)) + item.amount);
  });
  const groups = Array.from(grouped, ([service, weight]) => ({ service, weight }));
  const value = orderValueBreakdown(order);
  const gross = splitAmount(value.gross, groups);
  const direct = splitAmount(value.direct, groups);
  const codeEquivalent = splitAmount(value.codeEquivalent, groups);
  return groups.map((group, index) => ({
    service: group.service,
    gross: gross[index],
    direct: direct[index],
    codeEquivalent: codeEquivalent[index],
  }));
}

export function paymentChannel(order) {
  if (isServiceCodeOrder(order)) return "redeem";
  if (order?.paymentMethod === "usdt" || order?.paidCurrency === "USDT") return "usdt";
  if (order?.paymentMethod === "balance" || order?.paidByBalance) return "balance";
  if (order?.paymentMethod === "quote") return "quote";
  if (order?.paymentMethod === "alipay" || order?.paidCurrency === "CNY") return "alipay";
  return "other";
}

export const PAYMENT_CHANNEL_LABELS = {
  alipay: "支付宝",
  usdt: "USDT-TRC20",
  balance: "账户余额",
  redeem: "服务兑换码",
  quote: "待人工报价",
  other: "其他",
};

export const ORDER_STATUS_LABELS = {
  completed: "已完成",
  received: "已收到",
  awaiting_quote: "待报价",
  pending_payment: "待付款",
  quote_expired: "报价已失效",
  invalid: "无效订单",
};

export function orderSource(order) {
  const attribution = order?.attribution;
  if (attribution) {
    if (attribution.utm_source) return "UTM·" + attribution.utm_source;
    if (attribution.fromTool) return "工具站";
    if (attribution.referrer) {
      try {
        return "外链·" + new URL(attribution.referrer).hostname.replace(/^www\./, "");
      } catch (error) {
        return "外链";
      }
    }
  }
  if (order?.referral) return "推荐";
  return "直接访问";
}

export function addValueBreakdown(target, value) {
  target.revenue = round2(safeAmount(target.revenue) + safeAmount(value?.gross));
  target.directRevenue = round2(safeAmount(target.directRevenue) + safeAmount(value?.direct));
  target.codeRevenue = round2(safeAmount(target.codeRevenue) + safeAmount(value?.codeEquivalent));
  return target;
}

export function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((Number(numerator || 0) / denominator) * 1000) / 10 : 0;
}

export { round2 };
