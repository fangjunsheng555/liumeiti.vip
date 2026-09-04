import { buildEmailBrandHeader } from "../email-brand.js";
import { customerSubscriptionUrl } from "../../lib/rocket-subscription.js";
import { validEmail } from "../_utils.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { supportContactHtml } from "../support-links.js";
import { supportHtml } from "../../lib/settings-defaults.js";
import {
  orderItemService,
  publicNetflixStaffNotes,
} from "../../lib/netflix-delivery.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) { return "¥" + Number(value || 0).toFixed(0); }

function completionItems(order) {
  if (Array.isArray(order?.items) && order.items.length > 0) {
    return order.items.map((item, index) => {
      const service = orderItemService(order, item, index);
      return index === 0 && service === "netflix"
        ? {
          ...item,
          service,
          account: item.account || order.account || "",
          password: item.password || order.password || "",
          staffAccount: item.staffAccount || order.staffAccount || "",
          staffPassword: item.staffPassword || order.staffPassword || "",
        }
        : { ...item, service };
    });
  }
  return [{
    service: orderItemService(order, order, 0),
    label: order?.serviceLabel || "",
    cycle: order?.cycle || "",
    amount: Number(order?.finalAmount || 0),
    plan: order?.plan || order?.rocketPlan || "",
    account: order?.account || "",
    password: order?.password || "",
    staffAccount: order?.staffAccount || "",
    staffPassword: order?.staffPassword || "",
    subscriptionLinks: order?.subscriptionLinks || null,
  }];
}

export function buildCompletionEmailHtml({ order, brandName, siteDomain, siteUrl, supportContact, support, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const items = completionItems(order).map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label, locale),
    cycle: localizeCycle(it.cycle || "1年", locale),
  }));
  const isUsdt = order.paymentMethod === "usdt";
  const orderQueryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const netflixCodeUrl = `${siteUrl || "https://" + (siteDomain || "")}/netflix-code`;
  const netflixSelfServiceDelivery = order.netflixDeliveryMode === "self_service";
  const netflixAccounts = items
    .filter((item) => item.service === "netflix")
    .map((item) => String(item.staffAccount || item.account || "").trim().toLowerCase());
  const netflixAccountReady = netflixAccounts.length > 0
    && netflixAccounts.every(validEmail)
    && new Set(netflixAccounts).size === 1;
  const netflixOnlineCodeEnabled = netflixSelfServiceDelivery
    && order.netflixSelfServiceEnabled !== false
    && netflixAccountReady;
  const netflixOnlineCodePaused = netflixSelfServiceDelivery
    && !netflixOnlineCodeEnabled;
  const visibleStaffNotes = publicNetflixStaffNotes(order, {
    onlineCodeAvailable: netflixOnlineCodeEnabled,
  });

  const itemsRows = items.map((it, idx) => {
    // Use staff-filled credentials if present, otherwise buyer's
    const account = it.staffAccount || it.account;
    const password = it.service === "netflix" && netflixSelfServiceDelivery
      ? ""
      : it.staffPassword || it.password;
    const accountRow = account
      ? `<div style="margin-top:6px;font-size:12.5px;color:#475569;line-height:1.7;">
          <span style="color:#94a3b8;">${it.service === "rocket"
            ? L("用户名", "Username")
            : it.service === "netflix" && netflixSelfServiceDelivery
              ? L("Netflix 登录邮箱", "Netflix sign-in email")
              : L("账号", "Account")}:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:700;background:#f8fafc;padding:1px 6px;border-radius:4px;">${escapeHtml(account)}</span>
        </div>`
      : "";
    const passwordRow = password
      ? `<div style="font-size:12.5px;color:#475569;line-height:1.7;">
          <span style="color:#94a3b8;">${L("密码", "Password")}:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:700;background:#f8fafc;padding:1px 6px;border-radius:4px;">${escapeHtml(password)}</span>
        </div>`
      : "";
    const subscriptionUrl = customerSubscriptionUrl({ status: order.status, orderId: order.orderId, stored: it.subscriptionLinks });
    const subRows = subscriptionUrl
      ? `<div style="margin-top:10px;padding:11px 13px;background:#f0fdfa;border-radius:10px;border:1px solid #a7f3d0;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">${L("浏览器打开下方链接以使用服务", "Open this link in a browser to use the service")}</div>
          <a href="${escapeHtml(subscriptionUrl)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#134e4a;word-break:break-all;text-decoration:underline;">${escapeHtml(subscriptionUrl)}</a>
        </div>`
      : "";
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:${idx === items.length - 1 ? "0" : "1px solid #f1f5f9"};">
          <div style="color:#0f172a;font-size:14.5px;font-weight:800;letter-spacing:-0.01em;">
            ${escapeHtml(it.label)}
            <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#f0fdfa;color:#0f766e;font-size:10.5px;font-weight:700;">${escapeHtml(it.cycle || L("1年", "1 yr"))}</span>
          </div>
          ${accountRow}
          ${passwordRow}
          ${subRows}
        </td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-CN"}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${L("订单已开通", "Order ready")} - ${escapeHtml(brandName)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(brandName)} ${L(`订单 ${escapeHtml(order.orderId)} 已开通,账号信息已就绪`, `order ${escapeHtml(order.orderId)} is ready — your account details are inside`)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
        ${buildEmailBrandHeader({ brandName, siteDomain, label: L("订单已开通", "Order Completed") })}

        <tr><td style="padding:32px 32px 12px;text-align:center;">
          <div style="display:inline-block;width:72px;height:72px;line-height:72px;border-radius:50%;background:linear-gradient(135deg,#d1fae5,#a7f3d0);margin-bottom:16px;">
            <span style="font-size:36px;color:#047857;">🎉</span>
          </div>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">${L("订单已开通", "Your order is ready")}</h1>
          <p style="margin:0;color:#64748b;font-size:14px;line-height:1.6;">${en ? "Your service is ready — your account details are below<br>Reach our online support anytime if you have questions" : "您的服务已就绪,请查收下方账号信息<br>有任何问题随时联系在线客服"}</p>
        </td></tr>

        <tr><td style="padding:18px 32px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#f0fdf4;border:1px solid #bbf7d0;">
            <tr>
              <td style="padding:14px 16px;">
                <div style="font-size:11px;color:#15803d;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${L("订单号(点击查询)", "Order ID (tap to track)")}</div>
                <a href="${escapeHtml(orderQueryUrl)}" style="display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:#15803d;margin-top:2px;letter-spacing:-0.01em;text-decoration:underline;">${escapeHtml(order.orderId)}</a>
              </td>
              <td style="padding:14px 16px;text-align:right;border-left:1px solid #bbf7d0;">
                <div style="font-size:11px;color:#15803d;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${L("订单状态", "Status")}</div>
                <div style="font-size:15px;font-weight:900;color:#047857;margin-top:2px;letter-spacing:-0.01em;">✓ ${L("已完成", "Completed")}</div>
              </td>
            </tr>
          </table>
          <div style="margin-top:8px;font-size:11.5px;color:#15803d;font-weight:600;text-align:center;">${L("完成时间:", "Completed at: ")}${escapeHtml(order.completedAtBeijing || "")}</div>
        </td></tr>

        <tr><td style="padding:24px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${items.length > 1 ? L(`账号信息 · ${items.length} 件`, `Account details · ${items.length}`) : L("账号信息", "Account details")}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${itemsRows}</table>
        </td></tr>

        ${netflixOnlineCodeEnabled ? `
        <tr><td style="padding:18px 32px 0;">
          <div style="padding:14px 16px;border-radius:12px;background:#f0fdfa;border:1px solid #99f6e4;color:#134e4a;font-size:13px;line-height:1.7;">
            <strong style="display:block;color:#0f766e;margin-bottom:4px;">${L("需要 Netflix 登录码？", "Need a Netflix sign-in code?")}</strong>
            ${L("请先在 Netflix 官方登录页输入订单中的邮箱并继续，再按页面提示在线获取登录码或打开官方确认链接。", "Enter the email shown in the order on Netflix’s official sign-in page and continue, then follow the page instructions to retrieve a sign-in code or open the official confirmation link.")}
            <div style="margin-top:10px;"><a href="${escapeHtml(netflixCodeUrl)}" style="display:inline-block;padding:8px 13px;border-radius:8px;background:#0f766e;color:#ffffff;font-size:12px;font-weight:800;text-decoration:none;">${L("在线获取 Netflix 登录码", "Get Netflix sign-in code")}</a></div>
          </div>
        </td></tr>` : ""}

        ${netflixOnlineCodePaused ? `
        <tr><td style="padding:18px 32px 0;">
          <div style="padding:12px 14px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12.5px;line-height:1.65;">
            <strong>${L("在线获取登录码暂不可用", "Online sign-in codes are temporarily unavailable")}</strong><br>
            ${L("如需登录帮助，请通过订单详情联系在线客服。", "For sign-in help, contact online support from your order details.")}
          </div>
        </td></tr>` : ""}

        ${visibleStaffNotes ? `
        <tr><td style="padding:18px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${L("客服备注", "Support note")}</div>
          <div style="padding:13px 16px;border-radius:12px;background:#fef3c7;border:1px solid #fcd34d;color:#92400e;font-size:13px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(visibleStaffNotes)}</div>
        </td></tr>` : ""}

        <tr><td style="padding:24px 32px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;">
            <tr><td style="padding:16px 18px;">
              <div style="font-size:13px;font-weight:800;color:#0f766e;margin-bottom:8px;">${L("使用提示:", "Tips:")}</div>
              <ul style="margin:0;padding-left:18px;color:#134e4a;font-size:13px;line-height:1.85;">
                <li>${L("请妥善保存账号信息,避免泄露", "Keep your account details safe and private")}</li>
                <li>${L("使用过程中如出现异常,请及时联系客服", "If anything goes wrong, reach our support promptly")}</li>
                <li>${L("本订单全程售后保障，再次感谢您选择冒央会社！", "After-sales support covers this order — thanks again for choosing Maoyang Taiwan Inc!")}</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">${L("需要帮助?", "Need help?")}</div>
          <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${support ? supportHtml(support, locale) : supportContactHtml(locale)}</p>
          <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">${L("客服在线时间:北京时间 09:00 – 23:00 · 真人值守", "Support hours: 9:00 – 23:00 Beijing time · staffed by real people")}</p>
        </td></tr>

        <tr><td style="padding:28px 32px 32px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="color:#0f172a;font-size:13px;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(brandName)}</td>
              <td style="text-align:right;color:#94a3b8;font-size:11.5px;">${escapeHtml(siteDomain)}</td>
            </tr>
          </table>
          <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">${L("本邮件由系统自动发送,请勿直接回复", "This email was sent automatically — please don't reply")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function buildCompletionEmailText({ order, brandName, siteDomain, siteUrl, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const items = completionItems(order).map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label, locale),
    cycle: localizeCycle(it.cycle || "1年", locale),
  }));
  const queryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const netflixCodeUrl = `${siteUrl || "https://" + (siteDomain || "")}/netflix-code`;
  const netflixSelfServiceDelivery = order.netflixDeliveryMode === "self_service";
  const netflixAccounts = items
    .filter((item) => item.service === "netflix")
    .map((item) => String(item.staffAccount || item.account || "").trim().toLowerCase());
  const netflixAccountReady = netflixAccounts.length > 0
    && netflixAccounts.every(validEmail)
    && new Set(netflixAccounts).size === 1;
  const netflixOnlineCodeEnabled = netflixSelfServiceDelivery
    && order.netflixSelfServiceEnabled !== false
    && netflixAccountReady;
  const netflixOnlineCodePaused = netflixSelfServiceDelivery
    && !netflixOnlineCodeEnabled;
  const visibleStaffNotes = publicNetflixStaffNotes(order, {
    onlineCodeAvailable: netflixOnlineCodeEnabled,
  });
  const lines = [
    `${brandName} - ${L("订单已开通", "Order ready")} 🎉`,
    `===========================`,
    `${L("订单号", "Order ID")}: ${order.orderId}`,
    `${L("状态", "Status")}: ✓ ${L("已完成", "Completed")}`,
    `${L("完成时间", "Completed at")}: ${order.completedAtBeijing || ""}`,
    `${L("查询", "Track")}: ${queryUrl}`,
    ``,
    `${L("账号信息:", "Account details:")}`,
  ];
  items.forEach((it) => {
    const account = it.staffAccount || it.account;
    const password = it.service === "netflix" && netflixSelfServiceDelivery
      ? ""
      : it.staffPassword || it.password;
    lines.push(`  · ${it.label} (${it.cycle || L("1年", "1 yr")})`);
    if (account) lines.push(`      ${it.service === "rocket"
      ? L("用户名", "Username")
      : it.service === "netflix" && netflixSelfServiceDelivery
        ? L("Netflix 登录邮箱", "Netflix sign-in email")
        : L("账号", "Account")}: ${account}`);
    if (password) lines.push(`      ${L("密码", "Password")}: ${password}`);
    const subscriptionUrl = customerSubscriptionUrl({ status: order.status, orderId: order.orderId, stored: it.subscriptionLinks });
    if (subscriptionUrl) lines.push(`      ${L("浏览器打开下方链接以使用服务", "Open this link in a browser to use the service")}: ${subscriptionUrl}`);
  });
  if (netflixOnlineCodeEnabled) {
    lines.push(
      ``,
      `${L("在线获取 Netflix 登录码", "Get Netflix sign-in code")}: ${netflixCodeUrl}`,
      L("请先在 Netflix 官方登录页输入订单中的邮箱并继续，再按页面提示读取登录码或打开官方确认链接。", "Enter the email shown in the order on Netflix’s official sign-in page and continue, then follow the page instructions to retrieve the code or open the official confirmation link."),
    );
  }
  if (netflixOnlineCodePaused) {
    lines.push(
      ``,
      L("在线获取登录码暂不可用。如需登录帮助，请通过订单详情联系在线客服。", "Online sign-in codes are temporarily unavailable. For sign-in help, contact online support from your order details."),
    );
  }
  if (visibleStaffNotes) {
    lines.push(``, `${L("客服备注:", "Support note:")}`, visibleStaffNotes);
  }
  lines.push(``, L("如有问题请联系在线客服", "Questions? Reach our online support"), `${L("查询订单", "Track order")}: ${queryUrl}`);
  return lines.join("\n");
}
