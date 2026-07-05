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
      if (typeof item === "string") return item;
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

function usageTitle(type, locale) {
  return locale === "en"
    ? "Open the redeem page and follow the site instructions"
    : "打开兑换页面后，按网站提示完成兑换";
}

function usageSteps(type, locale) {
  if (locale === "en") {
    return [
      "Open the redeem page from this email. The code is included in the link.",
      "Confirm the code or paste it into the redeem field if the page asks.",
      "Follow the page instructions. If sign-in is required, the site will ask you to sign in first.",
    ];
  }

  return [
    "点击邮件里的“打开兑换页面”按钮，链接已带入兑换码。",
    "确认页面识别到的兑换码；如页面要求手动输入，请粘贴邮件里的兑换码。",
    "按页面提示继续操作；如果需要登录，网站会自动提示先登录或注册。",
  ];
}

function fallbackHint(type, locale, code) {
  if (locale === "en") {
    return `If the button does not open, go to the site, open the Redeem Code area, and paste this code: ${code}`;
  }
  return `如果按钮打不开，请访问网站首页的兑换码入口，粘贴此兑换码：${code}`;
}

export function buildRedeemEmailSubject({ code, type, services, amount, brandName, locale }) {
  const content = contentLabel({ type, services, amount, locale });
  if (locale === "en") {
    return type === "balance"
      ? `Redeem code ${code} · Account balance ${content} · ${brandName || "Maoyang Taiwan Inc"}`
      : `Redeem code ${code} · ${content} · ${brandName || "Maoyang Taiwan Inc"}`;
  }
  return type === "balance"
    ? `余额兑换码 ${code} · ${content} · ${brandName || "冒央会社"}`
    : `服务兑换码 ${code} · ${content} · ${brandName || "冒央会社"}`;
}

export function buildRedeemEmailText({ code, type, services, amount, brandName, siteUrl, redeemUrl, locale }) {
  const origin = normalizeUrl(siteUrl);
  const link = normalizeUrl(redeemUrl, origin);
  const content = contentLabel({ type, services, amount, locale });
  const steps = usageSteps(type, locale);

  if (locale === "en") {
    return [
      `${brandName || "Maoyang Taiwan Inc"} redeem code notice`,
      "",
      `Redeem code: ${code}`,
      `Redeem content: ${content}`,
      `Redeem page: ${link}`,
      "",
      usageTitle(type, locale),
      `1. ${steps[0]}`,
      `2. ${steps[1]}`,
      `3. ${steps[2]}`,
      "",
      fallbackHint(type, locale, code),
      "",
      "Keep this email until redemption is complete. Do not forward the code to others.",
      origin,
    ].join("\n");
  }

  return [
    `${brandName || "冒央会社"} 兑换码通知`,
    "",
    `兑换码：${code}`,
    `兑换内容：${content}`,
    `兑换页面：${link}`,
    "",
    usageTitle(type, locale),
    `1. ${steps[0]}`,
    `2. ${steps[1]}`,
    `3. ${steps[2]}`,
    "",
    fallbackHint(type, locale, code),
    "",
    "请在兑换完成前保留这封邮件，不要把兑换码转发给他人。",
    origin,
  ].join("\n");
}

function stepRow(index, text) {
  return `
    <tr>
      <td valign="top" width="32" style="padding:0 0 12px;">
        <div style="width:24px;height:24px;border-radius:50%;background:#0f766e;color:#ffffff;font-size:12px;line-height:24px;text-align:center;font-weight:800;">${index}</div>
      </td>
      <td valign="top" style="padding:2px 0 12px;color:#334155;font-size:14px;line-height:1.65;">${escapeHtml(text)}</td>
    </tr>`;
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
  const safeOrigin = escapeHtml(origin);
  const safeSupport = escapeHtml(supportContact || (locale === "en" ? "Contact online support if you need help." : "如需帮助，请联系在线客服。"));
  const steps = usageSteps(type, locale);
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
      ${escapeHtml(L(`兑换码：${code}，打开邮件内链接即可兑换。`, `Redeem code: ${code}. Open the link in this email to redeem.`))}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f5f7fb;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:22px 24px;border-bottom:1px solid #eef2f7;">
                <div style="font-size:14px;line-height:1.4;color:#64748b;">${safeBrand}</div>
                <div style="margin-top:6px;font-size:22px;line-height:1.25;font-weight:850;color:#111827;">${escapeHtml(L("你的兑换码已生成", "Your redeem code is ready"))}</div>
                <div style="margin-top:8px;color:#64748b;font-size:13px;line-height:1.65;">${escapeHtml(usageTitle(type, locale))}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <div style="padding:18px;border:1px solid #dbeafe;border-radius:14px;background:#eff6ff;text-align:center;">
                  <div style="font-size:12px;line-height:1.2;color:#1d4ed8;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(L("兑换码", "Redeem Code"))}</div>
                  <div style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;line-height:1.2;font-weight:900;letter-spacing:.08em;color:#0f172a;word-break:break-all;">${safeCode}</div>
                </div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;width:100%;border:1px solid #eef2f7;border-radius:14px;overflow:hidden;">
                  <tr>
                    <td style="padding:12px 14px;background:#f8fafc;color:#64748b;font-size:13px;">${escapeHtml(L("兑换内容", "Content"))}</td>
                    <td align="right" style="padding:12px 14px;background:#f8fafc;color:#111827;font-size:14px;font-weight:800;">${safeContent}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-top:1px solid #eef2f7;color:#64748b;font-size:13px;">${escapeHtml(L("兑换方式", "How it works"))}</td>
                    <td align="right" style="padding:12px 14px;border-top:1px solid #eef2f7;color:#111827;font-size:14px;font-weight:700;">${escapeHtml(L("网站自动识别", "Auto detected by site"))}</td>
                  </tr>
                </table>

                <div style="margin-top:18px;text-align:center;">
                  <a href="${safeLink}" style="display:inline-block;width:100%;box-sizing:border-box;padding:14px 20px;border-radius:12px;background:#0f766e;color:#ffffff;text-decoration:none;font-size:15px;line-height:1.2;font-weight:850;">${escapeHtml(L("打开兑换页面", "Open redeem page"))}</a>
                  <div style="margin-top:8px;color:#64748b;font-size:12px;line-height:1.5;">${escapeHtml(L("点击后按页面提示完成兑换。", "Follow the page instructions after opening."))}</div>
                </div>

                <div style="margin-top:22px;padding:16px;border-radius:14px;background:#f8fafc;border:1px solid #eef2f7;">
                  <div style="margin-bottom:12px;color:#111827;font-size:15px;line-height:1.3;font-weight:850;">${escapeHtml(L("新买家兑换步骤", "Redeem steps"))}</div>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;">
                    ${steps.map((text, index) => stepRow(index + 1, text)).join("")}
                  </table>
                </div>

                <div style="margin-top:16px;padding:14px 16px;border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;font-size:13px;line-height:1.7;">
                  <strong style="color:#9a3412;">${escapeHtml(L("按钮打不开？", "Button not working?"))}</strong><br />
                  ${escapeHtml(fallbackHint(type, locale, code))}
                  <div style="margin-top:8px;padding:9px 10px;border-radius:10px;background:#ffffff;border:1px solid #ffedd5;color:#334155;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;">${safeLink}</div>
                </div>

                <div style="margin-top:16px;color:#64748b;font-size:13px;line-height:1.7;">
                  ${safeSupport}
                </div>
                <div style="margin-top:18px;padding-top:16px;border-top:1px solid #eef2f7;color:#94a3b8;font-size:12px;line-height:1.6;">
                  ${escapeHtml(L("系统通知，请勿直接回复。请在兑换完成前保留这封邮件，不要把兑换码转发给他人。", "Automated notice. Please do not reply directly. Keep this email until redemption is complete and do not forward the code to others."))}
                  <br />
                  <a href="${safeOrigin}" style="color:#94a3b8;text-decoration:none;">${safeOrigin}</a>
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
