import {
  adminSessionFromRequest, listRedeemCodes, getAllOrders, clean,
} from "../../_utils.js";

function serviceLabel(code) {
  if (code.type === "service") {
    const labels = Array.isArray(code.services)
      ? code.services.map((item) => item?.label).filter(Boolean)
      : [];
    return labels.join(" + ") || "服务兑换码";
  }
  return `余额 ¥${Number(code.amount || 0).toFixed(2)}`;
}

function orderInputs(order) {
  if (!order) return [];
  const rows = [];
  if (order.email) rows.push({ label: "邮箱", value: clean(order.email, 200) });
  if (order.contact) rows.push({ label: "联系方式", value: clean(order.contact, 200) });
  if (order.remark) rows.push({ label: "买家备注", value: clean(order.remark, 500) });
  const items = Array.isArray(order.items) ? order.items : [];
  items.forEach((item, index) => {
    const prefix = clean(item?.label || `商品 ${index + 1}`, 80);
    if (item?.account) rows.push({ label: `${prefix} 账号`, value: clean(item.account, 200) });
    if (item?.password) rows.push({ label: `${prefix} 密码`, value: clean(item.password, 200) });
  });
  return rows;
}

function normalizeHistoryCode(code, orderMap) {
  const orderId = clean(code.usedOrderId || "", 100);
  const order = orderId ? orderMap.get(orderId) : null;
  return {
    code: clean(code.code, 80),
    type: code.type === "service" ? "service" : "balance",
    typeLabel: code.type === "service" ? "服务码" : "余额码",
    valueLabel: serviceLabel(code),
    amount: Number(code.amount || 0),
    services: Array.isArray(code.services) ? code.services : [],
    usedBy: clean(code.usedBy || order?.email || "", 200),
    usedOrderId: orderId,
    usedAt: code.usedAt || "",
    usedAtBeijing: code.usedAtBeijing || "",
    usedIp: clean(code.usedIp || order?.clientIp || "", 80),
    batchId: clean(code.batchId || "", 100),
    remark: clean(code.remark || "", 180),
    order: order ? {
      orderId: clean(order.orderId || orderId, 100),
      email: clean(order.email || "", 200),
      contact: clean(order.contact || "", 200),
      remark: clean(order.remark || "", 500),
      serviceLabel: clean(order.serviceLabel || "", 200),
      createdAtBeijing: order.createdAtBeijing || "",
      completedAtBeijing: order.completedAtBeijing || "",
      paymentMethod: order.paymentMethod || "",
      inputs: orderInputs(order),
    } : null,
  };
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const q = clean(url.searchParams.get("q") || "", 80).toLowerCase();
  const [codes, orders] = await Promise.all([listRedeemCodes(), getAllOrders()]);
  const orderMap = new Map(orders.map((order) => [clean(order.orderId || "", 100), order]));
  let history = codes
    .filter((code) => code && code.status === "used")
    .map((code) => normalizeHistoryCode(code, orderMap))
    .sort((a, b) => String(b.usedAt || "").localeCompare(String(a.usedAt || "")));

  if (q) {
    history = history.filter((item) => [
      item.code,
      item.typeLabel,
      item.valueLabel,
      item.usedBy,
      item.usedOrderId,
      item.usedIp,
      item.order?.email,
      item.order?.contact,
      item.order?.serviceLabel,
    ].filter(Boolean).join(" ").toLowerCase().includes(q));
  }

  return Response.json({
    ok: true,
    total: history.length,
    history: history.slice(0, 200),
  });
}
