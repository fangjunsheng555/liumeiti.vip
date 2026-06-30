import {
  getAllOrdersWithIndex, setOrderAt, softDeleteOrderAt,
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, formatBeijingTime, clean, isRootAdminSession,
  settleOrderReferralCommission, reverseOrderReferralCommission, sendSimpleEmail, adminPermissionProfile,
  restoreStock, refundVoidedOrder,
} from "../../../_utils.js";
import { buildCompletionEmailHtml, buildCompletionEmailText } from "../../../order/completion-email.js";
import { buildInvalidOrderEmailHtml, buildInvalidOrderEmailText } from "../../../order/invalid-email.js";
import { getSettings } from "../../../_settings.js";
import { supportText } from "../../../../lib/settings-defaults.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +34 671143339 / Telegram @MaoyangSupport 联系在线客服";
const SUPPORT_CONTACT_EN = process.env.SUPPORT_CONTACT_EN
  || ("Reach our online support via " + SUPPORT_CONTACT.replace(/^请通过\s*/, "").replace(/\s*联系在线客服\s*$/, "").trim());

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

function adminOk(request) {
  return Boolean(adminSession(request));
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

async function sendCompletionEmail(order) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  if (!host || !user || !pass || !from || !order.email) {
    return { ok: false, reason: "smtp_or_email_missing" };
  }
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch (e) { return { ok: false, reason: "nodemailer_import_failed" }; }

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = port === 465;
  const transporter = nodemailer.createTransport({
    host, port, secure, auth: { user, pass },
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  });

  try {
    const emailLocale = order.locale === "en" ? "en" : "zh";
    const settings = await getSettings();
    const brandName = settings.brand.name || BRAND_NAME;
    const supportContact = supportText(settings.support, emailLocale);
    const html = buildCompletionEmailHtml({
      order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, supportContact, locale: emailLocale,
    });
    const text = buildCompletionEmailText({
      order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale: emailLocale,
    });
    const subject = emailLocale === "en"
      ? `🎉 Order ${order.orderId} is ready · ${brandName}`
      : `🎉 订单 ${order.orderId} 已开通 · ${brandName}`;
    const info = await transporter.sendMail({
      from: `"${brandName}" <${from}>`,
      to: order.email,
      subject, text, html,
    });
    console.log(`[completion-email] sent to ${order.email} (msg=${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error("[completion-email] failed:", e.message);
    return { ok: false, reason: "send_failed", error: e.message };
  }
}

async function sendTelegramNotice(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch (e) { return false; }
}

// PATCH /api/admin/orders/:orderId
// body: { status, staffNotes, items: [{index, account, password, staffAccount, staffPassword}] }
export async function PATCH(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canEditOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);

  const { orderId } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const ALLOWED_STATUS = ["received", "completed", "invalid"];
  const newStatus = ALLOWED_STATUS.includes(body.status) ? body.status : null;
  const staffNotes = clean(body.staffNotes, 1500);
  const itemUpdates = Array.isArray(body.items) ? body.items : [];

  // Read all orders with raw indexes (so we update the correct slot, not a
  // shifted one from a filtered array).
  const all = await getAllOrdersWithIndex();
  let index = -1;
  let order = null;
  for (const entry of all) {
    if (entry.order && entry.order.orderId === orderId && !entry.order.deleted) {
      index = entry.index;
      order = entry.order;
      break;
    }
  }
  if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });

  // Apply item updates
  if (Array.isArray(order.items)) {
    itemUpdates.forEach((upd) => {
      const idx = Number(upd.index);
      if (Number.isFinite(idx) && order.items[idx]) {
        const it = order.items[idx];
        if (typeof upd.account === "string") it.account = clean(upd.account, 80);
        if (typeof upd.password === "string") it.password = clean(upd.password, 120);
        if (typeof upd.staffAccount === "string") it.staffAccount = clean(upd.staffAccount, 80);
        if (typeof upd.staffPassword === "string") it.staffPassword = clean(upd.staffPassword, 120);
        // Refresh subscription links if rocket
        if (it.service === "rocket") {
          const u = it.staffAccount || it.account;
          if (u) it.subscriptionLinks = subscriptionLinks(u);
        }
      }
    });
  }

  if (typeof body.staffNotes === "string") order.staffNotes = staffNotes;

  // Status transition
  const wasCompleted = order.status === "completed";
  const wasInvalid = order.status === "invalid";
  let refundResult = null;
  if (newStatus) {
    order.status = newStatus;
    if (newStatus === "completed" && !wasCompleted) {
      const now = new Date();
      order.completedAt = now.toISOString();
      order.completedAtBeijing = formatBeijingTime(now);
    }
    if (newStatus !== "completed") {
      order.completedAt = null;
      order.completedAtBeijing = null;
    }
    if (newStatus === "invalid" && !wasInvalid) {
      const now = new Date();
      order.invalidAt = now.toISOString();
      order.invalidAtBeijing = formatBeijingTime(now);
      // 订单作废：返还此前占用的 AI 会员库存
      for (const it of (order.items || [])) {
        if (it.stockReserved || it.aiStockReserved) {
          await restoreStock(it.service, it.plan);
          it.stockReserved = false; it.aiStockReserved = false;
        }
      }
      // 退款闭环:余额支付退回余额、还优惠券、恢复兑换码(幂等)。
      refundResult = await refundVoidedOrder(order, actor);
    }
    if (newStatus !== "invalid") {
      order.invalidAt = null;
      order.invalidAtBeijing = null;
    }
  }

  order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
  order.staffAudit.unshift({
    id: "OA" + Date.now().toString(36).toUpperCase(),
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
    label: adminActorLabel(actor),
    action: "update",
    status: newStatus || order.status,
    createdAt: new Date().toISOString(),
    createdAtBeijing: formatBeijingTime(new Date()),
  });
  order.staffAudit = order.staffAudit.slice(0, 30);

  let commissionResult = null;
  if (newStatus === "completed" && !wasCompleted) {
    commissionResult = await settleOrderReferralCommission(order, actor);
  } else if (wasCompleted && newStatus && newStatus !== "completed") {
    // 已完成 → 作废/未完成:回收已发返佣。
    commissionResult = await reverseOrderReferralCommission(order, actor);
  }

  // Save back
  const saved = await setOrderAt(index, order);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  await pushAdminActionLog({
    action: "order_update",
    actor,
    target: "order:" + orderId,
    detail: { status: newStatus || order.status },
  });

  // Send status emails only on a real transition, not on repeated saves.
  // Telegram is NOT pinged for staff changes (only initial new orders).
  let emailResult = null;
  if (newStatus === "completed" && !wasCompleted) {
    emailResult = await sendCompletionEmail(order);
  }
  let invalidEmailResult = null;
  if (newStatus === "invalid" && !wasInvalid) {
    invalidEmailResult = await sendInvalidOrderEmail(order);
    const noticeAt = new Date();
    order.invalidEmailNoticeAt = noticeAt.toISOString();
    order.invalidEmailNoticeAtBeijing = formatBeijingTime(noticeAt);
    order.invalidEmailNoticeOk = Boolean(invalidEmailResult?.ok);
    order.invalidEmailNoticeError = invalidEmailResult?.ok ? "" : clean(invalidEmailResult?.reason || invalidEmailResult?.error || "send_failed", 120);
    await setOrderAt(index, order);
  }

  return Response.json({
    ok: true, order,
    completion: newStatus === "completed" && !wasCompleted ? { email: emailResult } : null,
    invalidNotice: newStatus === "invalid" && !wasInvalid ? { email: invalidEmailResult } : null,
    commission: commissionResult,
    refund: refundResult,
    statusChange: newStatus,
  });
}

async function sendInvalidOrderEmail(order) {
  const emailLocale = order.locale === "en" ? "en" : "zh";
  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const supportContact = supportText(settings.support, emailLocale);
  const html = buildInvalidOrderEmailHtml({
    order,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact,
    locale: emailLocale,
  });
  const text = buildInvalidOrderEmailText({
    order,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact,
    locale: emailLocale,
  });
  return sendSimpleEmail({
    to: order.email,
    subject: emailLocale === "en"
      ? `Order ${order.orderId}: payment not received, marked invalid · ${brandName}`
      : `订单 ${order.orderId} 未收到付款，已标记无效 · ${brandName}`,
    text,
    html,
    fromName: brandName,
  });
}

// DELETE /api/admin/orders/:orderId — soft-delete (tombstone in storage,
// filtered from query/account/admin lists; stays out permanently).
export async function DELETE(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);

  const { orderId } = await params;
  const all = await getAllOrdersWithIndex();
  let target = null;
  for (const entry of all) {
    if (entry.order && entry.order.orderId === orderId && !entry.order.deleted) {
      target = entry;
      break;
    }
  }
  if (!target) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });

  const ok = await softDeleteOrderAt(target.index, orderId, {
    deletedByStaffId: actor.staffId,
    deletedByStaffUsername: actor.staffUsername,
  });
  if (!ok) return Response.json({ ok: false, error: "delete_failed" }, { status: 500 });
  // 软删订单：返还此前占用的 AI 会员库存
  for (const it of (target.order.items || [])) {
    if (it.stockReserved || it.aiStockReserved) await restoreStock(it.service, it.plan);
  }
  await pushAdminActionLog({
    action: "order_delete",
    actor,
    target: "order:" + orderId,
    detail: { email: target.order.email || "" },
  });

  // Telegram is intentionally NOT pinged for staff actions (only new orders trigger it).
  return Response.json({ ok: true, deleted: orderId });
}
