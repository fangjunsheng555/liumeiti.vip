import {
  orderItemService,
  publicNetflixStaffNotes,
  stripNetflixCredentialSecrets,
} from "../../../lib/netflix-delivery.js";
import { readRocketSubscriptionUrl } from "../../../lib/rocket-subscription.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function latestItems(order) {
  const source = Array.isArray(order?.items) && order.items.length
    ? order.items
    : [{
        label: order?.serviceLabel || "",
        cycle: order?.cycle || "",
        service: order?.service || "",
        account: order?.account || "",
        password: order?.password || "",
        staffAccount: order?.staffAccount || "",
        staffPassword: order?.staffPassword || "",
        subscriptionLinks: order?.subscriptionLinks || null,
      }];
  return source.map((item, index) => {
    const service = orderItemService(order, item, index);
    const netflixSelfService = service === "netflix" && order?.netflixDeliveryMode === "self_service";
    return {
      label: item?.label || item?.service || order?.serviceLabel || "--",
      cycle: item?.cycle || "",
      service,
      account: item?.staffAccount || item?.account || (index === 0 ? order?.staffAccount || order?.account || "" : ""),
      password: netflixSelfService
        ? ""
        : item?.staffPassword || item?.password || (index === 0 ? order?.staffPassword || order?.password || "" : ""),
      netflixSelfService,
      subscriptionLinks: item?.subscriptionLinks || null,
    };
  });
}

function detailRow(label, value, { link = false } = {}) {
  if (!value) return "";
  const safeValue = esc(value);
  return `<tr>
    <td width="72" valign="top" style="padding:4px 0;color:#64748b!important;font-size:12px;line-height:1.55;">${esc(label)}</td>
    <td valign="top" style="padding:4px 0;color:#0f172a!important;font:700 12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${link ? `<a href="${safeValue}" style="color:#0f766e!important;text-decoration:underline;">${safeValue}</a>` : safeValue}</td>
  </tr>`;
}

function credentialSection(order, en) {
  const L = (zh, english) => en ? english : zh;
  const rows = latestItems(order).map((item) => {
    const accountLabel = item.service === "rocket"
      ? L("用户名", "Username")
      : item.netflixSelfService
        ? L("Netflix 登录邮箱", "Netflix sign-in email")
        : L("账号", "Account");
    const details = [
      detailRow(accountLabel, item.account),
      detailRow(L("密码", "Password"), item.password),
      detailRow(L("浏览器打开下方链接以使用服务", "Open this link in a browser to use the service"), readRocketSubscriptionUrl(item.subscriptionLinks), { link: true }),
    ].filter(Boolean).join("");
    if (!details) return "";
    return `<div style="padding:10px 0;border-bottom:1px solid #edf2f7;">
      <div style="margin-bottom:4px;color:#0f172a!important;font-size:13px;font-weight:800;line-height:1.5;">${esc(item.label)}${item.cycle ? `<span style="margin-left:6px;color:#64748b!important;font-size:11px;font-weight:600;">${esc(item.cycle)}</span>` : ""}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${details}</table>
    </div>`;
  }).filter(Boolean).join("");
  if (!rows) return "";
  return `<div style="margin-top:18px;">
    <div style="margin-bottom:2px;color:#0f766e!important;font-size:11px;font-weight:800;letter-spacing:.08em;">${L("最新账号资料", "Current account details")}</div>
    ${rows}
  </div>`;
}

function noteSection(label, value) {
  if (!value) return "";
  return `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0;">
    <div style="margin-bottom:5px;color:#64748b!important;font-size:11px;font-weight:800;">${esc(label)}</div>
    <div style="color:#334155!important;font-size:13px;line-height:1.75;white-space:pre-wrap;">${esc(value)}</div>
  </div>`;
}

export function buildReferenceNotificationEmail({ orders, subject, message, brandName, siteDomain, locale = "zh" }) {
  const en = locale === "en";
  const L = (zh, english) => en ? english : zh;
  const publicValue = (value) => orders.reduce(
    (current, order) => stripNetflixCredentialSecrets(order, current),
    String(value || ""),
  );
  const safeSubject = publicValue(subject) || L("订单服务更新", "Order service update");
  const safeMessage = publicValue(message)
    || L("请查看下方订单的最新信息。", "Please review the latest order information below.");
  const logoUrl = `https://${String(siteDomain || "www.liumeiti.vip").replace(/^https?:\/\//, "").replace(/\/$/, "")}/email-logo.png`;
  const orderRows = orders.map((order) => {
    const detailsUrl = `https://${siteDomain}/service-center?order=${encodeURIComponent(order.orderId)}#order-query`;
    const orderItems = latestItems(order);
    const services = orderItems.map((item) => item.label).filter(Boolean).join(" / ");
    const visibleStaffNotes = publicNetflixStaffNotes(order, { onlineCodeAvailable: false });
    return `<tr><td bgcolor="#ffffff" style="padding:22px 0;border-top:1px solid #dbe4ea;background:#ffffff!important;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="top" style="color:#64748b!important;font-size:11px;line-height:1.5;">${L("关联订单", "Related order")}</td>
          <td align="right" valign="top" style="color:#0f172a!important;font:700 12px/1.5 ui-monospace,Menlo,Consolas,monospace;">${esc(order.orderId)}</td>
        </tr>
        <tr><td colspan="2" style="padding-top:7px;color:#0f172a!important;font-size:14px;font-weight:800;line-height:1.5;">${esc(services || order.serviceLabel || L("订单服务", "Order service"))}</td></tr>
      </table>
      ${credentialSection(order, en)}
      ${noteSection(L("下单备注", "Order note"), order.remark)}
      ${noteSection(L("订单备注", "Service note"), visibleStaffNotes)}
      <div style="margin-top:18px;"><a href="${esc(detailsUrl)}" style="display:inline-block;padding:9px 15px;border-radius:6px;background:#0f766e!important;color:#ffffff!important;text-decoration:none;font-size:12px;font-weight:800;">${L("查看订单", "View order")}</a></div>
    </td></tr>`;
  }).join("");

  const html = `<!doctype html><html lang="${en ? "en" : "zh-CN"}" style="color-scheme:light only;supported-color-schemes:light;">
  <head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
    <title>${esc(safeSubject)}</title>
    <style>
      :root{color-scheme:light only!important;supported-color-schemes:light!important}
      body,.email-bg,.email-shell,.email-content{background-color:#ffffff!important;color:#0f172a!important}
      @media(prefers-color-scheme:dark){body,.email-bg,.email-shell,.email-content{background:#ffffff!important;color:#0f172a!important}}
      [data-ogsc] .email-bg,[data-ogsc] .email-shell,[data-ogsc] .email-content{background:#ffffff!important;color:#0f172a!important}
    </style>
  </head>
  <body bgcolor="#ffffff" style="margin:0;background:#ffffff!important;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a!important;">
    <div style="display:none;max-height:0;overflow:hidden;color:#ffffff;">${esc(safeSubject)} · ${esc(safeMessage)}</div>
    <table class="email-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff!important;"><tr><td align="center" bgcolor="#ffffff" style="padding:18px 14px;background:#ffffff!important;">
      <table class="email-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;background:#ffffff!important;">
        <tr><td bgcolor="#ffffff" style="padding:8px 0 18px;border-bottom:1px solid #dbe4ea;background:#ffffff!important;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td><img src="${esc(logoUrl)}" width="178" height="40" alt="${esc(brandName)}" style="display:block;width:178px;height:40px;border:0;outline:none;"></td>
            <td align="right" style="color:#64748b!important;font-size:11px;font-weight:800;">${L("订单服务", "ORDER SERVICE")}</td>
          </tr></table>
        </td></tr>
        <tr><td class="email-content" bgcolor="#ffffff" style="padding:26px 0 24px;background:#ffffff!important;">
          <h1 style="margin:0 0 10px;color:#0f172a!important;font-size:23px;line-height:1.35;">${esc(safeSubject)}</h1>
          <div style="padding-left:13px;border-left:3px solid #14b8a6;color:#334155!important;font-size:14px;line-height:1.8;white-space:pre-wrap;">${esc(safeMessage)}</div>
        </td></tr>
        <tr><td class="email-content" bgcolor="#ffffff" style="padding:0 0 12px;background:#ffffff!important;">${orderRows}</td></tr>
        <tr><td bgcolor="#ffffff" style="padding:18px 0 8px;border-top:1px solid #dbe4ea;background:#ffffff!important;color:#94a3b8!important;font-size:10.5px;line-height:1.65;">
          ${esc(brandName)} · ${esc(siteDomain)}
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = [safeSubject, "", safeMessage, ""];
  for (const order of orders) {
    const orderItems = latestItems(order);
    const visibleStaffNotes = publicNetflixStaffNotes(order, { onlineCodeAvailable: false });
    text.push(`${L("关联订单", "Related order")}: ${order.orderId}`);
    for (const item of orderItems) {
      text.push(`${L("服务", "Service")}: ${item.label}${item.cycle ? ` · ${item.cycle}` : ""}`);
      if (item.account) text.push(`${item.service === "rocket" ? L("用户名", "Username") : item.netflixSelfService ? L("Netflix 登录邮箱", "Netflix sign-in email") : L("账号", "Account")}: ${item.account}`);
      if (item.password) text.push(`${L("密码", "Password")}: ${item.password}`);
      const subscriptionUrl = readRocketSubscriptionUrl(item.subscriptionLinks);
      if (subscriptionUrl) text.push(`${L("浏览器打开下方链接以使用服务", "Open this link in a browser to use the service")}: ${subscriptionUrl}`);
    }
    if (order.remark) text.push(`${L("下单备注", "Order note")}: ${order.remark}`);
    if (visibleStaffNotes) text.push(`${L("订单备注", "Service note")}: ${visibleStaffNotes}`);
    text.push(`${L("查看订单", "View order")}: https://${siteDomain}/service-center?order=${encodeURIComponent(order.orderId)}#order-query`, "");
  }
  return { subject: safeSubject, html, text: text.join("\n") };
}
