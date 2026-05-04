import {
  getAllOrders,
  getCookieFromRequest,
  verifySession,
  formatBeijingTime,
} from "../../_utils.js";

function adminOk(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin";
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
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
    subtotal: Number(order.subtotal || items.reduce((s, i) => s + i.amount, 0)),
    discountRate: Number(order.discountRate || 0),
    discountLabel: order.discountLabel || "",
    finalAmount: Number(order.finalAmount || 0),
    finalUsdt: Number(order.finalUsdt || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    staffNotes: order.staffNotes || "",
  };
}

// GET /api/admin/orders[?q=search]
export async function GET(request) {
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const status = String(url.searchParams.get("status") || "").trim();

  const all = await getAllOrders();
  let filtered = all.map(normalizeOrder);
  if (status === "received" || status === "completed" || status === "invalid") {
    filtered = filtered.filter((o) => o.status === status);
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
  return Response.json({
    ok: true,
    orders: filtered.slice(0, 200),
    total: all.length,
    filteredCount: filtered.length,
  });
}
