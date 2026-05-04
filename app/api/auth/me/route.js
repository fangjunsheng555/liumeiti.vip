import {
  getCookieFromRequest, verifySession, getAllOrders,
} from "../../_utils.js";

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function publicOrder(order) {
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => {
      const out = {
        service: it.service || "",
        label: it.label || "",
        cycle: it.cycle || "",
        amount: Number(it.amount || 0),
        // Show staff-filled credentials when available, fall back to buyer's
        account: it.staffAccount || it.account || "",
        password: it.staffPassword || it.password || "",
      };
      if (it.subscriptionLinks) out.subscriptionLinks = it.subscriptionLinks;
      else if (it.service === "rocket" && (it.staffAccount || it.account)) {
        out.subscriptionLinks = subscriptionLinks(it.staffAccount || it.account);
      }
      return out;
    });
  } else {
    items = [{
      service: order.service || "",
      label: order.serviceLabel || "",
      cycle: order.cycle || "",
      amount: Number(order.finalAmount || 0),
      account: order.account || "",
      password: order.password || "",
      subscriptionLinks: order.service === "rocket" && order.account ? subscriptionLinks(order.account) : null,
    }];
  }
  return {
    orderId: order.orderId || "",
    status: order.status || "received",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
    items,
    itemCount: items.length,
    serviceLabel: order.serviceLabel || items.map((i) => i.label).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    finalAmount: Number(order.finalAmount || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    contact: order.contact || "",
    remark: order.remark || "",
    staffNotes: order.staffNotes || "",
  };
}

export async function GET(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) {
    return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  }

  const all = await getAllOrders();
  const myOrders = all
    .filter((o) => (o.email || "").toLowerCase() === session.email)
    .map(publicOrder);

  return Response.json({
    ok: true,
    email: session.email,
    orders: myOrders,
  });
}
