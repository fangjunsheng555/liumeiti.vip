function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlLines(value) {
  return escapeHtml(value)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function buildCustomerMailHtml({ subject, content, brandName, siteDomain, siteUrl, staffId }) {
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const safeSubject = escapeHtml(subject || "客服服务通知");
  const safeSiteDomain = escapeHtml(siteDomain || "liumeiti.vip");
  const safeSiteUrl = escapeHtml(siteUrl || "https://liumeiti.vip");
  const staffBadge = staffId ? `#${escapeHtml(staffId)}` : "#1";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;background:#f3f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:22px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #dbe7ef;box-shadow:0 16px 40px rgba(15,23,42,.08);">
            <tr>
              <td style="padding:22px 20px;background:linear-gradient(135deg,#0f172a,#0f766e);color:#ffffff;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.78;">Customer Service</div>
                <div style="font-size:24px;font-weight:900;line-height:1.25;margin-top:6px;">${safeBrand}客服人员</div>
                <div style="font-size:13px;line-height:1.7;margin-top:8px;opacity:.88;">${safeSubject}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 20px 8px;">
                <div style="font-size:15px;line-height:1.8;color:#334155;">
                  <p style="margin:0 0 12px;">您好，这里是${safeBrand}客服人员,关于您的服务咨询或订单协助，我们整理了以下说明：</p>
                </div>
                <div style="border:1px solid #dbeafe;background:#f8fbff;border-radius:16px;padding:16px 15px;font-size:15px;line-height:1.85;color:#102033;">
                  ${htmlLines(content)}
                </div>
                <div style="font-size:15px;line-height:1.8;color:#334155;margin-top:14px;">
                  <p style="margin:0;">如仍需协助，请通过网站联系方式联系在线客服，我们会继续为您处理。感谢您选择${safeBrand}</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px 22px;">
                <div style="border-top:1px solid #e2e8f0;padding-top:14px;font-size:12px;line-height:1.7;color:#64748b;">
                  本邮件由${safeBrand}客服人员发送，工作人员编号 ${staffBadge},如仍需协助可直接回复此邮件或访问
                  <a href="${safeSiteUrl}" style="color:#0f766e;text-decoration:none;font-weight:700;">${safeSiteDomain}</a>
                  联系在线客服
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildCustomerMailText({ subject, content, brandName, siteDomain, siteUrl, staffId }) {
  const brand = brandName || "冒央会社";
  return [
    `${brand}客服人员 · ${subject || "客服服务通知"}`,
    "",
    `您好，这里是${brand}客服人员，关于您的服务咨询或订单协助，我们整理了以下说明：`,
    "",
    String(content || "").trim(),
    "",
    `如仍需协助，可直接回复此邮件或通过网站联系方式联系在线客服，我们会继续为您处理。感谢您选择${brand}`,
    "",
    `工作人员编号 #${staffId || 1}`,
    `${siteDomain || "liumeiti.vip"} ${siteUrl || "https://liumeiti.vip"}`,
  ].join("\n");
}
