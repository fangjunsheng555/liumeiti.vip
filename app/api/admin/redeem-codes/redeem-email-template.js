function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeUrl(value, fallback = "https://www.liumeiti.vip") {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return fallback;
  return /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, "")}`;
}

function formatMoney(value) {
  const num = Number(value || 0);
  return `¥${Number.isFinite(num) ? num.toFixed(2) : "0.00"}`;
}

function serviceLabels(services, locale) {
  if (!Array.isArray(services)) return "";
  return services
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (locale === "en") {
        return item.nameEn || item.labelEn || item.variantEn || item.planEn || item.name || item.label || item.id || "";
      }
      return item.name || item.label || item.variant || item.plan || item.nameEn || item.labelEn || item.id || "";
    })
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" + ");
}

function contentLabel({ type, services, amount, locale }) {
  if (type === "balance") {
    return locale === "en" ? `Balance ${formatMoney(amount)}` : `余额 ${formatMoney(amount)}`;
  }
  const labels = serviceLabels(services, locale);
  if (labels) return labels;
  return locale === "en" ? "Service redeem code" : "服务兑换码";
}

export function buildRedeemEmailSubject({ code, type, services, amount, brandName, locale }) {
  const content = contentLabel({ type, services, amount, locale });
  if (locale === "en") return `Redeem code ${code} · ${content} · ${brandName || "Maoyang Taiwan Inc"}`;
  return `兑换码 ${code} · ${content} · ${brandName || "冒央会社"}`;
}

export function buildRedeemEmailText({ code, type, services, amount, brandName, siteUrl, redeemUrl, locale }) {
  const origin = normalizeUrl(siteUrl);
  const link = normalizeUrl(redeemUrl, origin);
  const content = contentLabel({ type, services, amount, locale });

  if (locale === "en") {
    return [
      `${brandName || "Maoyang Taiwan Inc"} service notification`,
      "",
      `Redeem code: ${code}`,
      `Content: ${content}`,
      `Redeem page: ${link}`,
      "",
      "How to use:",
      "1. Open the redeem page.",
      "2. Paste the redeem code exactly as shown above.",
      "3. If you have already placed an order, contact support with this code.",
      "",
      "This is an automated transactional notification for your redeem code.",
      origin,
    ].join("\n");
  }

  return [
    `${brandName || "冒央会社"} 服务通知`,
    "",
    `兑换码：${code}`,
    `内容：${content}`,
    `兑换页面：${link}`,
    "",
    "使用说明：",
    "1. 打开兑换页面。",
    "2. 按上方内容完整输入兑换码。",
    "3. 如已下单，请把兑换码发给客服核对。",
    "",
    "这是一封兑换码系统通知，请妥善保存。",
    origin,
  ].join("\n");
}

export function buildRedeemEmailHtml({
  code,
  type,
  services,
  amount,
  brandName,
  siteDomain,
  siteUrl,
  redeemUrl,
  supportContact,
  locale,
}) {
  const origin = normalizeUrl(siteUrl || siteDomain);
  const link = normalizeUrl(redeemUrl, origin);
  const safeBrand = escapeHtml(brandName || (locale === "en" ? "Maoyang Taiwan Inc" : "冒央会社"));
  const safeCode = escapeHtml(code);
  const safeContent = escapeHtml(contentLabel({ type, services, amount, locale }));
  const safeLink = escapeHtml(link);
  const safeSupport = escapeHtml(supportContact || (locale === "en" ? "Contact online support if you need help." : "如需帮助，请联系在线客服。"));
  const L = (zh, en) => (locale === "en" ? en : zh);

  return `<!doctype html>
<html lang="${locale === "en" ? "en" : "zh-CN"}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>${escapeHtml(buildRedeemEmailSubject({ code, type, services, amount, brandName, locale }))}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:0;">
      ${escapeHtml(L(`兑换码：${code}`, `Redeem code: ${code}`))}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f5f7fb;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:22px 24px;border-bottom:1px solid #eef2f7;">
                <div style="font-size:14px;line-height:1.4;color:#64748b;">${safeBrand}</div>
                <div style="margin-top:6px;font-size:22px;line-height:1.25;font-weight:800;color:#111827;">${escapeHtml(L("兑换码通知", "Redeem Code Notice"))}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <div style="font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(L("请保存以下兑换码，兑换时需要完整输入。", "Save this redeem code and enter it exactly when redeeming."))}</div>
                <div style="margin:16px 0 18px;padding:18px;border:1px solid #dbeafe;border-radius:14px;background:#eff6ff;text-align:center;">
                  <div style="font-size:12px;line-height:1.2;color:#1d4ed8;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(L("兑换码", "Redeem Code"))}</div>
                  <div style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;line-height:1.2;font-weight:900;letter-spacing:.08em;color:#0f172a;word-break:break-all;">${safeCode}</div>
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #eef2f7;border-radius:14px;overflow:hidden;">
                  <tr>
                    <td style="padding:12px 14px;background:#f8fafc;color:#64748b;font-size:13px;">${escapeHtml(L("兑换内容", "Content"))}</td>
                    <td align="right" style="padding:12px 14px;background:#f8fafc;color:#111827;font-size:14px;font-weight:700;">${safeContent}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-top:1px solid #eef2f7;color:#64748b;font-size:13px;">${escapeHtml(L("兑换页面", "Redeem page"))}</td>
                    <td align="right" style="padding:12px 14px;border-top:1px solid #eef2f7;color:#111827;font-size:14px;font-weight:700;">
                      <a href="${safeLink}" style="color:#0f766e;text-decoration:none;">${escapeHtml(L("打开兑换页面", "Open redeem page"))}</a>
                    </td>
                  </tr>
                </table>
                <div style="margin-top:18px;padding:14px 16px;border-radius:14px;background:#f8fafc;color:#475569;font-size:13px;line-height:1.7;">
                  <strong style="color:#111827;">${escapeHtml(L("使用说明", "Instructions"))}</strong><br />
                  ${escapeHtml(L("打开兑换页面后，粘贴兑换码并提交。如已下单，请把兑换码发给客服核对。", "Open the redeem page, paste the code, and submit it. If you already placed an order, send this code to support for verification."))}
                </div>
                <div style="margin-top:16px;color:#64748b;font-size:13px;line-height:1.7;">${safeSupport}</div>
                <div style="margin-top:18px;color:#94a3b8;font-size:12px;line-height:1.6;">
                  ${escapeHtml(L("这是一封兑换码系统通知，不包含促销内容。", "This is an automated redeem code notification and contains no promotional content."))}
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
