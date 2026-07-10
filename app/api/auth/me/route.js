import {
  getCookieFromRequest, verifySession, getOrdersByEmail,
  getUser, setUser, validUsername, generateRandomUsername, clean,
  generateRandomUserAvatarId, validUserAvatarId,
  publicCoupons, publicReferral, ensureUserReferralProfile, getReferralDownlineRecords,
} from "../../_utils.js";
import { localizeOrderItemLabel, localizeCycle } from "../../../lib/order-i18n.js";

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function publicOrder(order, locale = "zh") {
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => {
      const out = {
        service: it.service || "",
        label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label || "", locale),
        cycle: localizeCycle(it.cycle || "", locale),
        amount: Number(it.amount || 0),
        plan: it.plan || it.rocketPlan || "",
        platformUrl: it.platformUrl || "",
        productPrice: it.productPrice || "",
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
      label: localizeOrderItemLabel(order.service, order.plan || order.rocketPlan, order.serviceLabel || "", locale),
      cycle: localizeCycle(order.cycle || "", locale),
      amount: Number(order.finalAmount || 0),
      account: order.account || "",
      password: order.password || "",
      subscriptionLinks: order.service === "rocket" ? subscriptionLinks(order.orderId) : null,
    }];
  }
  return {
    orderId: order.orderId || "",
    orderType: order.orderType || "standard",
    status: order.status || "received",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
    items,
    itemCount: items.length,
    serviceLabel: items.map((i) => i.label).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    redeemCode: order.redeemCode || "",
    finalAmount: Number(order.finalAmount || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    platformUrl: order.platformUrl || items[0]?.platformUrl || "",
    productPrice: order.productPrice || items[0]?.productPrice || "",
    quoteAmount: Number(order.quoteAmount || 0),
    quotedAtBeijing: order.quotedAtBeijing || "",
    paymentSubmittedAtBeijing: order.paymentSubmittedAtBeijing || "",
    couponDiscount: Number(order.couponDiscount || 0),
    couponTitle: order.couponTitle || "",
    contact: order.contact || "",
    remark: order.remark || "",
    staffNotes: order.staffNotes || "",
  };
}

function maskEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [local, domain = ""] = value.split("@");
  if (!local || !domain) return value ? value.slice(0, 2) + "***" : "";
  const localMask = local.length <= 2 ? local[0] + "***" : local.slice(0, 2) + "***" + local.slice(-1);
  const parts = domain.split(".");
  const domainMain = parts.shift() || "";
  const domainMask = domainMain.length <= 2 ? domainMain[0] + "***" : domainMain.slice(0, 2) + "***" + domainMain.slice(-1);
  return `${localMask}@${domainMask}${parts.length ? "." + parts.join(".") : ""}`;
}

async function publicReferralDownlines(email, locale = "zh") {
  // 走反向索引(getReferralDownlineRecords),不再全表扫描;已按 level→新到旧排序。
  const records = await getReferralDownlineRecords(email);
  return records.map((r) => ({
    email: maskEmail(r.email),
    level: r.level,
    levelLabel: locale === "en"
      ? (r.level === 1 ? "L1 agent" : "L2 agent")
      : (r.level === 1 ? "一级代理" : "二级代理"),
    joinedAtBeijing: r.createdAtBeijing || r.invitedAtBeijing || "",
  }));
}

export async function GET(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) {
    return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  }
  const locale = getCookieFromRequest(request, "locale") === "en" ? "en" : "zh";

  const sessionEmail = session.email;
  const user = await getUser(sessionEmail);
  // Backfill username for legacy accounts on the fly
  let username = user?.username;
  let avatarId = user?.avatarId;
  if (user && !username) {
    username = generateRandomUsername();
    user.username = username;
    await setUser(sessionEmail, user);
  }
  if (user && !validUserAvatarId(avatarId)) {
    avatarId = generateRandomUserAvatarId();
    user.avatarId = avatarId;
    await setUser(sessionEmail, user);
  }
  const profile = user ? await ensureUserReferralProfile(sessionEmail, user) : null;

  const myOrders = (await getOrdersByEmail(sessionEmail, 100))
    .map((o) => publicOrder(o, locale));

  return Response.json({
    ok: true,
    email: sessionEmail,
    username: profile?.username || username || "",
    avatarId: validUserAvatarId(profile?.avatarId) ? profile.avatarId : avatarId,
    balance: Number(profile?.balance || 0),
    coupons: publicCoupons(profile),
    referral: publicReferral(profile),
    referralDownlines: await publicReferralDownlines(sessionEmail, locale),
    banned: !!profile?.banned,
    orders: myOrders,
  });
}

// PATCH /api/auth/me  body: { username?, avatarId? }
export async function PATCH(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) {
    return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  }
  const en = getCookieFromRequest(request, "locale") === "en";
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const hasUsername = Object.prototype.hasOwnProperty.call(body, "username");
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, "avatarId");
  if (!hasUsername && !hasAvatar) {
    return Response.json({ ok: false, error: "empty_profile_update" }, { status: 400 });
  }
  const username = clean(body.username, 40).trim();
  if (hasUsername && !validUsername(username)) {
    return Response.json({
      ok: false,
      error: "invalid_username",
      message: en ? "Username must be 2-20 chars: letters / digits / _ / Chinese" : "用户名 2-20 位,支持中文/字母/数字/下划线",
    }, { status: 400 });
  }
  const avatarId = clean(body.avatarId, 40).trim();
  if (hasAvatar && !validUserAvatarId(avatarId)) {
    return Response.json({
      ok: false,
      error: "invalid_avatar",
      message: en ? "Please choose an available avatar" : "请选择可用头像",
    }, { status: 400 });
  }
  const user = await getUser(session.email);
  if (!user) return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
  if (hasUsername) user.username = username;
  if (hasAvatar) user.avatarId = avatarId;
  const saved = await setUser(session.email, user);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  return Response.json({ ok: true, username: user.username || "", avatarId: user.avatarId || "" });
}
