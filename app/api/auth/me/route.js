import {
  getCookieFromRequest, getOrdersByEmail,
  setUser, setCookieValue, validUsername, generateRandomUsername, clean,
  generateRandomUserAvatarId, validUserAvatarId,
  publicCoupons, publicReferral, ensureUserReferralProfile, getReferralDownlineRecords,
} from "../../_utils.js";
import {
  authenticateUserRequest,
  refreshedUserSessionToken,
  signAfterSalesToken,
  userAuthErrorResponse,
} from "../../_auth-session.js";
import { localizeOrderItemLabel, localizeCycle } from "../../../lib/order-i18n.js";
import { getActiveAfterSalesTickets, publicAfterSalesSummary } from "../../after-sales/_store.js";
import { orderExpirySummary, renewalCheckoutPath } from "../../../lib/order-expiry.js";
import { effectiveQuoteStatus } from "../../_quote-expiry.js";
import { withApiTelemetry } from "../../_observability.js";

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
    const account = order.staffAccount || order.account || "";
    const password = order.staffPassword || order.password || "";
    items = [{
      service: order.service || "",
      label: localizeOrderItemLabel(order.service, order.plan || order.rocketPlan, order.serviceLabel || "", locale),
      cycle: localizeCycle(order.cycle || "", locale),
      amount: Number(order.finalAmount || 0),
      account,
      password,
      subscriptionLinks: order.service === "rocket" ? subscriptionLinks(order.orderId) : null,
    }];
  }
  return {
    orderId: order.orderId || "",
    orderType: order.orderType || "standard",
    status: effectiveQuoteStatus(order),
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
    quoteExpiresAt: order.quoteExpiresAt || "",
    quoteExpiresAtBeijing: order.quoteExpiresAtBeijing || "",
    quoteValidDays: Number(order.quoteValidDays || 7),
    paymentSubmittedAtBeijing: order.paymentSubmittedAtBeijing || "",
    couponDiscount: Number(order.couponDiscount || 0),
    couponTitle: order.couponTitle || "",
    contact: order.contact || "",
    remark: order.remark || "",
    staffNotes: order.staffNotes || "",
    email: order.email || "",
    ...expiryFields(order),
  };
}

// 服务到期摘要 + 一键续费预填路径(仅已完成且有周期的订单)
function expiryFields(order) {
  const expiry = orderExpirySummary(order);
  if (!expiry) return {};
  return {
    expiry: { expiresAt: expiry.expiresAt, daysLeft: expiry.daysLeft, expired: expiry.expired },
    renewPath: renewalCheckoutPath(order),
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

function isToolReadOnlyAccountRequest(request) {
  const allowed = new Set([
    "https://tool.liumeiti.vip",
    process.env.TOOL_ORIGIN || "",
    ...(process.env.NODE_ENV !== "production"
      ? ["http://localhost:8799", "http://127.0.0.1:8799"]
      : []),
  ].filter(Boolean));
  return allowed.has(String(request?.headers?.get?.("origin") || ""));
}

function refreshedSessionHeaders(auth) {
  const headers = { "Cache-Control": "no-store" };
  if (auth.legacy) {
    const refreshed = refreshedUserSessionToken(auth);
    if (refreshed) headers["Set-Cookie"] = setCookieValue("lm_user", refreshed);
  }
  return headers;
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

async function getAccountHandler(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const locale = getCookieFromRequest(request, "locale") === "en" ? "en" : "zh";

  const sessionEmail = auth.email;
  const user = auth.user;
  const profileWriteOptions = { expectedAuthVersion: auth.authVersion };
  // Backfill username for legacy accounts on the fly
  let username = user?.username;
  let avatarId = user?.avatarId;
  if (user && !username) {
    username = generateRandomUsername();
    user.username = username;
    await setUser(sessionEmail, user, profileWriteOptions);
  }
  if (user && !validUserAvatarId(avatarId)) {
    avatarId = generateRandomUserAvatarId();
    user.avatarId = avatarId;
    await setUser(sessionEmail, user, profileWriteOptions);
  }
  const profile = user ? await ensureUserReferralProfile(sessionEmail, user, profileWriteOptions) : null;

  // The external tools site needs only enough data for its account chrome.
  // Never expose order credentials, coupons, referrals or after-sales records
  // cross-origin, even though GET /api/auth/me itself is read-only.
  if (isToolReadOnlyAccountRequest(request)) {
    return Response.json({
      ok: true,
      email: sessionEmail,
      accountLifecycleId: auth.accountLifecycleId,
      username: profile?.username || username || "",
      avatarId: validUserAvatarId(profile?.avatarId) ? profile.avatarId : avatarId,
      balance: Number(profile?.balance || 0),
      banned: !!profile?.banned,
    }, { headers: refreshedSessionHeaders(auth) });
  }

  const myOrderRecords = await getOrdersByEmail(sessionEmail, 100);
  const activeTickets = await getActiveAfterSalesTickets(myOrderRecords.map((order) => order.orderId));
  const myOrders = myOrderRecords.map((order) => {
    const eligible = order.status !== "invalid";
    const activeTicket = eligible ? activeTickets[String(order.orderId || "").replace(/\s+/g, "").toUpperCase()] : null;
    return {
      ...publicOrder(order, locale),
      afterSalesEligible: eligible,
      afterSalesToken: eligible ? signAfterSalesToken({
        orderId: String(order.orderId || "").replace(/\s+/g, "").toUpperCase(),
        email: String(order.email || "").toLowerCase().trim(),
      }) : "",
      afterSalesTicket: publicAfterSalesSummary(activeTicket),
    };
  });

  return Response.json({
    ok: true,
    email: sessionEmail,
    accountLifecycleId: auth.accountLifecycleId,
    username: profile?.username || username || "",
    avatarId: validUserAvatarId(profile?.avatarId) ? profile.avatarId : avatarId,
    balance: Number(profile?.balance || 0),
    coupons: publicCoupons(profile),
    referral: publicReferral(profile),
    referralDownlines: await publicReferralDownlines(sessionEmail, locale),
    banned: !!profile?.banned,
    orders: myOrders,
  }, { headers: refreshedSessionHeaders(auth) });
}

// PATCH /api/auth/me  body: { username?, avatarId? }
async function updateAccountHandler(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
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
  const user = auth.user;
  if (hasUsername) user.username = username;
  if (hasAvatar) user.avatarId = avatarId;
  const saved = await setUser(auth.email, user, {
    expectedAuthVersion: auth.authVersion,
    returnResult: true,
  });
  if (!saved?.ok) {
    const stale = saved?.error === "session_state_changed";
    return Response.json({ ok: false, error: stale ? "session_revoked" : "save_failed" }, { status: stale ? 401 : 500 });
  }
  return Response.json({ ok: true, username: user.username || "", avatarId: user.avatarId || "" }, {
    headers: refreshedSessionHeaders(auth),
  });
}

export const GET = withApiTelemetry("auth_account", getAccountHandler);
export const PATCH = withApiTelemetry("auth_account", updateAccountHandler);
