// 服务到期续费提醒:keeper 定时扫描已完成订单,到期前 3 天(含到期当天)
// 向下单邮箱发送双语续费提醒(带一键续费预填链接);每单每个到期点只发一次
// (renewalReminderForExpiresAt 幂等标记),setOrderAt 持久化。
import {
  formatBeijingTime,
  getAllOrders,
  redisConfig,
  sendSimpleEmail,
  setOrderAt,
  validEmail,
} from "./_utils.js";
import { getSettings } from "./_settings.js";
import { buildEmailBrandHeader } from "./email-brand.js";
import { orderExpirySummary, renewalCheckoutPath } from "../lib/order-expiry.js";

const REMIND_BEFORE_DAYS = 3;   // 到期前 3 天开始提醒
const REMIND_GRACE_DAYS = 1;    // 已过期 1 天内仍补发(keeper 停摆兜底)
const MAX_SENDS_PER_RUN = 20;   // 单次扫描发送上限,防异常风暴
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function expiryDateLabel(iso, en) {
  const ts = new Date(iso || 0).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), day = String(d.getUTCDate()).padStart(2, "0");
  return en ? `${y}-${m}-${day}` : `${y}年${m}月${day}日`;
}

function buildRenewalEmail({ order, summary, renewUrl, brandName, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const dateLabel = expiryDateLabel(summary.expiresAt, en);
  const dueText = summary.daysLeft <= 0
    ? L("已于近日到期", "has just expired")
    : L(`将在 ${summary.daysLeft} 天后(${dateLabel})到期`, `expires in ${summary.daysLeft} day${summary.daysLeft > 1 ? "s" : ""} (${dateLabel})`);
  const itemsHtml = summary.items.map((item) => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13.5px;color:#0f172a;font-weight:700;">${escapeHtml(item.label || item.service)}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;color:#64748b;text-align:right;white-space:nowrap;">${escapeHtml(expiryDateLabel(item.expiresAt, en))}</td>
    </tr>`).join("");
  const html = `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
        ${buildEmailBrandHeader({ brandName, siteDomain: SITE_DOMAIN, label: L("续费提醒", "Renewal Reminder") })}
        <tr><td style="padding:30px 32px 10px;">
          <h2 style="margin:0 0 8px;font-size:20px;font-weight:900;color:#0f172a;letter-spacing:-0.02em;">${L("您的服务即将到期", "Your service is expiring soon")}</h2>
          <p style="margin:0 0 16px;font-size:13.5px;line-height:1.7;color:#475569;">${L(`您在 ${brandName} 的订单 ${escapeHtml(order.orderId)} 中的服务${dueText}。点击下方按钮可按原规格续费。`, `The service in your ${brandName} order ${escapeHtml(order.orderId)} ${dueText}. Use the button below to renew the same plan.`)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;">${itemsHtml}</table>
        </td></tr>
        <tr><td style="padding:8px 32px 26px;" align="center">
          <a href="${escapeHtml(renewUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 34px;border-radius:999px;background:linear-gradient(135deg,#071627 0%,#0f766e 100%);color:#ffffff;font-size:14.5px;font-weight:800;text-decoration:none;letter-spacing:.01em;">${L("一键续费", "Renew now")}</a>
          <p style="margin:12px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.6;">${L("页面已预填相同规格，核对后提交订单。", "The same plan is pre-filled; review it before placing the order.")}</p>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 14px;">
          <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.6;">${L("如已续费或不再需要,请忽略本邮件。", "If you've already renewed or no longer need the service, please ignore this email.")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const itemsText = summary.items.map((item) => `- ${item.label || item.service}: ${L("到期", "expires")} ${expiryDateLabel(item.expiresAt, en)}`).join("\n");
  const text = L(
    `${brandName} 续费提醒\n\n您的订单 ${order.orderId} 中的服务${dueText}。\n\n${itemsText}\n\n点击下方链接可按原规格续费: ${renewUrl}\n\n如已续费或不再需要,请忽略本邮件。`,
    `${brandName} renewal reminder\n\nThe service in your order ${order.orderId} ${dueText}.\n\n${itemsText}\n\nUse the link below to renew the same plan: ${renewUrl}\n\nIf you've already renewed or no longer need the service, please ignore this email.`,
  );
  return {
    subject: L(`${brandName} · 服务到期提醒 — 订单 ${order.orderId}`, `${brandName} · Service expiring soon — order ${order.orderId}`),
    html,
    text,
  };
}

// 扫描并发送到期提醒。幂等:每单每个到期点只发一次。
export async function sendDueRenewalReminders({ now = Date.now() } = {}) {
  if (!redisConfig()) return { ok: false, error: "storage_unavailable" };
  const [orders, settings] = await Promise.all([getAllOrders(), getSettings()]);
  const due = [];
  for (const order of orders) {
    if ((order.status || "") !== "completed" || !validEmail(order.email)) continue;
    const summary = orderExpirySummary(order, now);
    if (!summary) continue;
    if (summary.daysLeft > REMIND_BEFORE_DAYS || summary.daysLeft < -REMIND_GRACE_DAYS) continue;
    if (order.renewalReminderForExpiresAt === summary.expiresAt) continue; // 该到期点已提醒
    const renewUrl = renewalCheckoutPath(order);
    if (!renewUrl) continue;
    due.push({ order, summary, renewUrl });
  }

  let sent = 0;
  const results = [];
  for (const { order, summary, renewUrl } of due.slice(0, MAX_SENDS_PER_RUN)) {
    const locale = order.locale === "en" ? "en" : "zh";
    const brandName = (locale === "en" ? settings.brand.nameEn : settings.brand.name) || "冒央会社";
    const mail = buildRenewalEmail({ order, summary, renewUrl: SITE_URL + renewUrl + "&utm_source=renewal-email", brandName, locale });
    const delivery = await sendSimpleEmail({
      to: order.email,
      category: "renewal",
      relatedType: "order",
      relatedId: order.orderId,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      support: settings.support,
      locale,
    }).catch(() => ({ ok: false }));
    if (!delivery?.ok) { results.push({ orderId: order.orderId, ok: false }); continue; }
    const at = new Date();
    const updated = {
      ...order,
      renewalReminderSentAt: at.toISOString(),
      renewalReminderSentAtBeijing: formatBeijingTime(at),
      renewalReminderForExpiresAt: summary.expiresAt,
    };
    await setOrderAt({ orderId: order.orderId, legacyIndex: null }, updated);
    sent += 1;
    results.push({ orderId: order.orderId, ok: true, daysLeft: summary.daysLeft });
  }
  return { ok: true, scanned: orders.length, due: due.length, sent, results };
}
