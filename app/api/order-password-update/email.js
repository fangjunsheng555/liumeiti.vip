import { buildEmailBrandHeader } from "../email-brand.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildSpotifyPasswordErrorEmail({ order, item, updateUrl, brandName, siteDomain, staffNote = "" }) {
  const en = order?.locale === "en";
  const safeOrderId = escapeHtml(order?.orderId || "");
  const safeAccount = escapeHtml(item?.account || "");
  const safeUrl = escapeHtml(updateUrl);
  const safeStaffNote = escapeHtml(staffNote);
  const subject = en
    ? `Please correct the Spotify password for order ${order.orderId} · ${brandName}`
    : `请更正 Spotify 密码 · 订单 ${order.orderId} · ${brandName}`;
  const title = en ? "Spotify password needs correction" : "Spotify 密码需要更正";
  const message = en
    ? "The password you entered is incorrect. Please enter the correct password again."
    : "您填写的密码错误，请重新填写准确的密码。";
  const button = en ? "Update order details" : "重新填写并提交";
  const accountLabel = en ? "Spotify account" : "Spotify 账号";
  const orderLabel = en ? "Order" : "订单号";
  const note = en
    ? "The secure link is valid for 7 days. The password field will remain blank."
    : "安全链接 7 天内有效，密码不会在页面中回显。";
  const text = [
    `${brandName}`,
    title,
    message,
    `${orderLabel}: ${order.orderId}`,
    safeAccount ? `${accountLabel}: ${item.account}` : "",
    staffNote ? `${en ? "Staff note" : "工作人员备注"}: ${staffNote}` : "",
    `${button}: ${updateUrl}`,
    note,
  ].filter(Boolean).join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f6f8;color:#132523;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f3f6f8;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border-collapse:collapse;background:#ffffff;border:1px solid #dfe8e7;border-radius:14px;overflow:hidden;">
        ${buildEmailBrandHeader({ brandName, siteDomain, label: en ? "Order update" : "订单资料更正" })}
        <tr><td style="padding:28px 28px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.35;color:#102a27;">${title}</h1>
          <p style="margin:0;color:#435b58;font-size:15px;line-height:1.75;">${message}</p>
        </td></tr>
        <tr><td style="padding:8px 28px 4px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #e7eeee;border-bottom:1px solid #e7eeee;">
            <tr><td style="padding:10px 0;color:#748783;font-size:12px;">${orderLabel}</td><td align="right" style="padding:10px 0;color:#193c38;font-size:12px;font-weight:700;">${safeOrderId}</td></tr>
            ${safeAccount ? `<tr><td style="padding:10px 0;border-top:1px solid #eef3f2;color:#748783;font-size:12px;">${accountLabel}</td><td align="right" style="padding:10px 0;border-top:1px solid #eef3f2;color:#193c38;font-size:12px;font-weight:700;">${safeAccount}</td></tr>` : ""}
          </table>
        </td></tr>
        ${safeStaffNote ? `<tr><td style="padding:14px 28px 0;color:#435b58;font-size:13px;line-height:1.7;"><strong style="color:#193c38;">${en ? "Staff note" : "工作人员备注"}</strong><br>${safeStaffNote}</td></tr>` : ""}
        <tr><td style="padding:20px 28px 10px;">
          <a href="${safeUrl}" style="display:block;padding:13px 18px;border-radius:9px;background:#0f766e;color:#ffffff;text-align:center;text-decoration:none;font-size:14px;font-weight:800;">${button}</a>
        </td></tr>
        <tr><td style="padding:4px 28px 26px;color:#81918e;font-size:11px;line-height:1.65;">${note}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
