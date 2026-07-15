import { buildEmailBrandHeader } from "../../email-brand.js";

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
  const safeSiteUrl = escapeHtml(siteUrl || "https://www.liumeiti.vip");
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
            ${buildEmailBrandHeader({ brandName, siteDomain, label: "Customer Service" })}
            <tr>
              <td style="padding:20px 20px 0;background:#ffffff;">
                <div style="font-size:23px;font-weight:900;line-height:1.25;color:#0f172a;letter-spacing:-0.03em;">${safeBrand}客服</div>
                <div style="font-size:13px;line-height:1.7;margin-top:7px;color:#64748b;">${safeSubject}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 20px 8px;">
                <div style="font-size:14px;line-height:1.7;color:#475569;margin-bottom:14px;">
                  您好 👋 这里是${safeBrand}客服，以下是为您整理的答复：<br />
                  <span style="color:#94a3b8;">Hi, this is ${safeBrand} support — here's our reply for you:</span>
                </div>
                <div style="border:1px solid #e2e8f0;background:#f8fafc;border-radius:16px;padding:16px 15px;font-size:15px;line-height:1.85;color:#0f172a;">
                  ${htmlLines(content)}
                </div>
                <div style="font-size:13.5px;line-height:1.7;color:#475569;margin-top:16px;">
                  如仍需帮助，直接回复本邮件即可，我们会继续为您处理。<br />
                  <span style="color:#94a3b8;">Need more help? Just reply to this email and we'll continue to assist you.</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px 22px;">
                <div style="border-top:1px solid #e2e8f0;padding-top:14px;font-size:12px;line-height:1.7;color:#64748b;">
                  本邮件由${safeBrand}客服发送，客服编号 ${staffBadge}。如仍需协助，可直接回复此邮件或访问
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
    `${brand}客服 · ${subject || "客服服务通知"}`,
    "",
    `您好，这里是${brand}客服，以下是为您整理的答复：`,
    `Hi, this is ${brand} support — here's our reply:`,
    "",
    String(content || "").trim(),
    "",
    `如仍需帮助，直接回复本邮件即可。 / Need more help? Just reply to this email.`,
    "",
    `客服编号 #${staffId || 1}`,
    `${siteDomain || "www.liumeiti.vip"} ${siteUrl || "https://www.liumeiti.vip"}`,
  ].join("\n");
}
