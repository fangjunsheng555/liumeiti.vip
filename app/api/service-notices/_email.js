import { buildEmailBrandHeader } from "../email-brand.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function englishServiceName(service, fallback) {
  return {
    ai: "AI Membership",
    rocket: "Airport Node",
    "proxy-pay": "Global Proxy Pay",
  }[service] || fallback;
}

export function buildServiceNoticeEmail({ post, service, serviceLabel, locale, brandName, siteDomain, siteUrl }) {
  const en = locale === "en";
  const title = en ? post.titleEn : post.title;
  const body = en ? post.bodyEn : post.body;
  const displayService = en ? englishServiceName(service, serviceLabel) : serviceLabel;
  const actionUrl = `${String(siteUrl || `https://${siteDomain}`).replace(/\/+$/, "")}${post.published === false ? "/service-center" : "/announcements"}`;
  const label = en ? "Service notice" : "服务通知";
  const lead = en
    ? `There is an important update for your ${displayService} service.`
    : `关于您使用的${displayService}服务，有一项重要更新。`;
  const button = en ? (post.published === false ? "Open Service Center" : "View announcement") : (post.published === false ? "进入服务中心" : "查看公告详情");
  const help = en
    ? "For order support, open the Service Center to look up your order or submit an after-sales request."
    : "如需订单协助，可前往服务中心查询订单或提交售后申请。";
  const subject = en ? `${displayService} service notice · ${brandName}` : `${displayService} 服务通知 · ${brandName}`;
  const safeBody = escapeHtml(body).replace(/\r?\n/g, "<br>");

  const html = `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:24px 10px;background:#f4f6f8;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        ${buildEmailBrandHeader({ brandName, siteDomain, label })}
        <tr><td style="padding:28px 30px 10px;">
          <div style="margin:0 0 10px;color:#0f766e;font-size:12px;font-weight:800;">${escapeHtml(displayService)}</div>
          <h1 style="margin:0 0 12px;color:#0f172a;font-size:24px;line-height:1.35;font-weight:850;">${escapeHtml(title)}</h1>
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.7;">${escapeHtml(lead)}</p>
        </td></tr>
        <tr><td style="padding:14px 30px 6px;">
          <div style="padding:16px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;color:#334155;font-size:14px;line-height:1.8;word-break:break-word;">${safeBody}</div>
        </td></tr>
        <tr><td style="padding:18px 30px 10px;">
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 20px;border-radius:9px;background:#0f766e;color:#fff;text-decoration:none;font-size:13px;font-weight:800;">${button}</a>
        </td></tr>
        <tr><td style="padding:10px 30px 26px;color:#64748b;font-size:12px;line-height:1.7;">${escapeHtml(help)}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [title, lead, "", body, "", `${button}: ${actionUrl}`, help].join("\n");
  return { subject, html, text };
}
