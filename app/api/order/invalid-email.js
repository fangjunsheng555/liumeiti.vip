import { buildEmailBrandHeader } from "../email-brand.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { supportContactHtml, supportContactText } from "../support-links.js";
import { supportHtml } from "../../lib/settings-defaults.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  return "¥" + Number(value || 0).toFixed(0);
}

function orderItems(order, locale) {
  const raw = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [{ label: order?.serviceLabel || "订单服务", cycle: order?.cycle || "1年", amount: order?.finalAmount || 0, service: order?.service, plan: order?.plan || order?.rocketPlan }];
  return raw.map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label || (locale === "en" ? "Order service" : "订单服务"), locale),
    cycle: localizeCycle(it.cycle || "1年", locale),
  }));
}

export function buildInvalidOrderEmailHtml({ order, brandName, siteDomain, siteUrl, supportContact, support, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const queryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const items = orderItems(order, locale);
  const itemsRows = items.map((item, index) => `
    <tr>
      <td style="padding:12px 0;border-bottom:${index === items.length - 1 ? "0" : "1px solid #edf2f7"};">
        <div style="font-size:14px;font-weight:800;color:#0f172a;line-height:1.45;">${escapeHtml(item.label || L("订单服务", "Order service"))}</div>
        <div style="margin-top:3px;font-size:12.5px;color:#64748b;">${escapeHtml(item.cycle || L("1年", "1 yr"))} · ${formatMoney(item.amount || 0)}</div>
      </td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${L("订单未收到付款", "Payment not received")} - ${escapeHtml(brandName)}</title>
  </head>
  <body style="margin:0;background:#f3f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(brandName)} ${L(`订单 ${escapeHtml(order.orderId)} 暂未收到付款，订单已标记为无效`, `order ${escapeHtml(order.orderId)} has no payment yet and has been marked invalid`)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:24px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #dbe7ef;box-shadow:0 16px 40px rgba(15,23,42,.08);">
            ${buildEmailBrandHeader({ brandName, siteDomain, label: L("订单通知", "Order Notice") })}
            <tr>
              <td style="padding:28px 24px 8px;text-align:center;">
                <div style="display:inline-block;padding:9px 14px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#c2410c;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;">Payment Not Received</div>
                <h1 style="margin:16px 0 8px;font-size:24px;line-height:1.25;font-weight:900;color:#0f172a;letter-spacing:-.03em;">${L("未收到付款，订单已无效", "Payment not received — order marked invalid")}</h1>
                <p style="margin:0;color:#475569;font-size:14px;line-height:1.75;">${L("我们暂未收到此订单对应付款，系统已将订单状态更新为无效。若您已经完成付款，请及时联系在线客服核对。", "We haven't received payment for this order, so it has been marked invalid. If you've already paid, please contact our online support to verify.")}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:16px;background:#fff7ed;border:1px solid #fed7aa;">
                  <tr>
                    <td style="padding:15px 16px;">
                      <div style="font-size:11px;color:#c2410c;font-weight:800;letter-spacing:.12em;text-transform:uppercase;">${L("订单号", "Order ID")}</div>
                      <a href="${escapeHtml(queryUrl)}" style="display:inline-block;margin-top:3px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:800;color:#9a3412;text-decoration:underline;word-break:break-all;">${escapeHtml(order.orderId)}</a>
                    </td>
                    <td style="padding:15px 16px;text-align:right;border-left:1px solid #fed7aa;">
                      <div style="font-size:11px;color:#c2410c;font-weight:800;letter-spacing:.12em;text-transform:uppercase;">${L("订单状态", "Status")}</div>
                      <div style="margin-top:3px;font-size:15px;font-weight:900;color:#c2410c;">${L("无效 · 未收到付款", "Invalid · unpaid")}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 0;">
                <div style="font-size:11px;color:#94a3b8;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;">${L("订单内容", "Order items")}</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${itemsRows}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 0;">
                <div style="border-radius:16px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;padding:16px;">
                  <div style="font-size:14px;font-weight:900;color:#0f766e;margin-bottom:8px;">${L("如果您已经付款", "If you've already paid")}</div>
                  <p style="margin:0;font-size:13.5px;line-height:1.8;color:#134e4a;">${L("请携带付款凭证、订单号与下单邮箱联系在线客服，我们会尽快为您核对并继续处理。", "Contact our online support with your payment proof, order ID and order email, and we'll verify and continue processing as soon as possible.")}</p>
                  <p style="margin:10px 0 0;font-size:13px;line-height:1.75;color:#475569;">${support ? supportHtml(support, locale) : supportContactHtml(locale)}</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 0;">
                <p style="margin:0 0 10px;text-align:center;font-size:12.5px;line-height:1.7;color:#64748b;">${L("点击下方按钮可查看订单详情与当前状态。", "Use the button below to view the order details and current status.")}</p>
                <a href="${escapeHtml(queryUrl)}" style="display:block;text-align:center;text-decoration:none;border-radius:14px;background:#0f172a;color:#ffffff;font-size:14px;font-weight:900;padding:14px 16px;">${L("查看订单状态", "View order status")}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 24px 28px;">
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;" />
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="font-size:13px;font-weight:900;color:#0f172a;">${escapeHtml(brandName)}</td>
                    <td style="text-align:right;font-size:11.5px;color:#94a3b8;">${escapeHtml(siteDomain)}</td>
                  </tr>
                </table>
                <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">${L("本邮件由系统自动发送，请勿直接回复", "This email was sent automatically — please don't reply")}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildInvalidOrderEmailText({ order, brandName, siteDomain, siteUrl, supportContact, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const queryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const lines = [
    `${brandName} - ${L("未收到付款，订单已无效", "Payment not received — order marked invalid")}`,
    "",
    `${L("订单号", "Order ID")}: ${order.orderId}`,
    `${L("状态", "Status")}: ${L("无效 · 未收到付款", "Invalid · unpaid")}`,
    `${L("查看订单详情与状态", "View order details and status")}: ${queryUrl}`,
    "",
    `${L("订单内容:", "Order items:")}`,
  ];
  orderItems(order, locale).forEach((item) => {
    lines.push(`- ${item.label || L("订单服务", "Order service")} (${item.cycle || L("1年", "1 yr")}) ${formatMoney(item.amount || 0)}`);
  });
  lines.push(
    "",
    L("我们暂未收到此订单对应付款，系统已将订单状态更新为无效。", "We haven't received payment for this order, so it has been marked invalid."),
    L("如果您已经付款，请携带付款凭证、订单号与下单邮箱联系在线客服核对。", "If you've already paid, contact our online support with your payment proof, order ID and order email to verify."),
    "",
    supportContactText(locale),
    siteDomain || "liumeiti.vip"
  );
  return lines.join("\n");
}
