import {
  getAllOrders, setOrderAt, getCookieFromRequest, verifySession,
  formatBeijingTime, clean,
} from "../../../_utils.js";
import { buildCompletionEmailHtml, buildCompletionEmailText } from "../../../order/completion-email.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +1 4315093334 / Telegram @MaoyangSupport 联系在线客服";

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
    const html = buildCompletionEmailHtml({
      order, brandName: BRAND_NAME, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, supportContact: SUPPORT_CONTACT,
    });
    const text = buildCompletionEmailText({
      order, brandName: BRAND_NAME, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL,
    });
    const subject = `🎉 订单 ${order.orderId} 已开通 · ${BRAND_NAME}`;
    const info = await transporter.sendMail({
      from: `"${BRAND_NAME}" <${from}>`,
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
  if (!adminOk(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { orderId } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const newStatus = body.status === "completed" ? "completed" : (body.status === "received" ? "received" : null);
  const staffNotes = clean(body.staffNotes, 1500);
  const itemUpdates = Array.isArray(body.items) ? body.items : [];

  // Read all orders, find target
  const all = await getAllOrders();
  let index = -1;
  let order = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i].orderId === orderId) {
      index = i;
      order = all[i];
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
  if (newStatus) {
    order.status = newStatus;
    if (newStatus === "completed" && !wasCompleted) {
      const now = new Date();
      order.completedAt = now.toISOString();
      order.completedAtBeijing = formatBeijingTime(now);
    }
    if (newStatus === "received") {
      order.completedAt = null;
      order.completedAtBeijing = null;
    }
  }

  // Save back
  const saved = await setOrderAt(index, order);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });

  // If transitioning to completed AND not already completed, send completion email + telegram
  let emailResult = null;
  let telegramResult = null;
  if (newStatus === "completed" && !wasCompleted) {
    emailResult = await sendCompletionEmail(order);
    const tg = `✅ 订单 ${order.orderId} 已完成\n买家: ${order.email}\n${order.staffNotes ? "备注: " + order.staffNotes : ""}`;
    telegramResult = await sendTelegramNotice(tg);
  }

  return Response.json({
    ok: true, order,
    completion: newStatus === "completed" && !wasCompleted ? { email: emailResult, telegram: telegramResult } : null,
  });
}
