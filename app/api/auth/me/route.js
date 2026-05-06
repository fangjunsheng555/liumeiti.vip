import {
  getCookieFromRequest, verifySession, getAllOrders,
  getUser, setUser, validUsername, generateRandomUsername, clean,
  publicCoupons,
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
      if (it.service === "rocket") {
        out.subscriptionLinks = subscriptionLinks(order.orderId);
      } else if (it.subscriptionLinks) {
        out.subscriptionLinks = it.subscriptionLinks;
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
      subscriptionLinks: order.service === "rocket" ? subscriptionLinks(order.orderId) : null,
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
    redeemCode: order.redeemCode || "",
    finalAmount: Number(order.finalAmount || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    couponDiscount: Number(order.couponDiscount || 0),
    couponTitle: order.couponTitle || "",
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

  const sessionEmail = session.email;
  const user = await getUser(sessionEmail);
  // Backfill username for legacy accounts on the fly
  let username = user?.username;
  if (user && !username) {
    username = generateRandomUsername();
    user.username = username;
    await setUser(sessionEmail, user);
  }

  const all = await getAllOrders();
  // Match by user session email (preferred — captures orders where buyer
  // typed a different delivery email) OR by the buyer-entered email
  // (backward compat for orders placed before login feature).
  const myOrders = all
    .filter((o) =>
      (o.userEmail || "").toLowerCase() === sessionEmail ||
      (o.email || "").toLowerCase() === sessionEmail
    )
    .map(publicOrder);

  return Response.json({
    ok: true,
    email: sessionEmail,
    username: username || "",
    balance: Number(user?.balance || 0),
    coupons: publicCoupons(user),
    banned: !!user?.banned,
    orders: myOrders,
  });
}

// PATCH /api/auth/me  body: { username }
export async function PATCH(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) {
    return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const username = clean(body.username, 40).trim();
  if (!validUsername(username)) {
    return Response.json({
      ok: false,
      error: "invalid_username",
      message: "用户名 2-20 位,支持中文/字母/数字/下划线",
    }, { status: 400 });
  }
  const user = await getUser(session.email);
  if (!user) return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  user.username = username;
  const saved = await setUser(session.email, user);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  return Response.json({ ok: true, username });
}
