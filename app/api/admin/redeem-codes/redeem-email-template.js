import { buildEmailBrandHeader } from "../../email-brand.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  return "¥" + Number(value || 0).toFixed(2);
}

export function buildRedeemEmailSubject({ code, type, services, amount, brandName }) {
  if (type === "service") {
    const labels = (services || []).map((s) => s.label || s).join(" + ");
    return `您收到一份服务兑换码 · ${labels || "组合服务"} · ${brandName}`;
  }
  return `您收到一份余额兑换码 · ${formatMoney(amount)} · ${brandName}`;
}

export function buildRedeemEmailText({ code, type, services, amount, brandName, siteUrl, redeemUrl }) {
  const isService = type === "service";
  const valueText = isService
    ? (services || []).map((s) => s.label || s).join(" + ") || "组合服务"
    : `余额 ${formatMoney(amount)}`;
  const lines = [
    `${brandName} - 兑换码`,
    `===========================`,
    `您收到一份${isService ? "服务" : "余额"}兑换码`,
    ``,
    `兑换码: ${code}`,
    `内容: ${valueText}`,
    ``,
    `点击下面的链接前往首页兑换区域 (链接已自动填入兑换码)：`,
    redeemUrl,
    ``,
    isService
      ? `服务码无需登录，跳转后系统将自动识别并跳转至结算页提交`
      : `余额码需要先登录账号，金额将充入您的账户余额`,
    ``,
    `如有任何问题，请联系在线客服`,
    `站点: ${siteUrl}`,
  ];
  return lines.join("\n");
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
}) {
  const isService = type === "service";
  const safeCode = escapeHtml(code);
  const valueDisplay = isService
    ? escapeHtml((services || []).map((s) => s.label || s).join("  +  ") || "组合服务")
    : `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(formatMoney(amount))}</span>`;
  const heroTitle = isService ? "您收到一份服务兑换码" : "您收到一份余额兑换码";
  const heroDesc = isService
    ? "兑换码可直接兑换以下服务，无需支付，点击下方按钮即可一键跳转兑换"
    : "兑换码可为您账户充值以下余额，需登录账号后兑换，金额将直接到账";
  const usageHint = isService
    ? "点击「立即兑换」按钮跳转后，系统将自动识别并引导您完成订单提交（免支付）"
    : "点击「立即兑换」按钮跳转首页后请先登录，金额将立即到账";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heroTitle)} - ${escapeHtml(brandName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(brandName)} 兑换码 ${safeCode}：${escapeHtml(isService ? "服务码" : "余额码")}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
          <!-- Header -->
          ${buildEmailBrandHeader({ brandName, siteDomain, label: "Redeem Code" })}

          <!-- Hero -->
          <tr>
            <td style="padding:32px 32px 12px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:50%;background:linear-gradient(135deg,#fef3c7,#fde68a);margin-bottom:14px;">
                <span style="font-size:30px;color:#b45309;">🎁</span>
              </div>
              <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">${escapeHtml(heroTitle)}</h1>
              <p style="margin:0;color:#64748b;font-size:13.5px;line-height:1.7;">${escapeHtml(heroDesc)}</p>
            </td>
          </tr>

          <!-- Code box -->
          <tr>
            <td style="padding:22px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px dashed #5eead4;">
                <tr>
                  <td style="padding:20px 18px;text-align:center;">
                    <div style="font-size:11px;color:#0f766e;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;">兑换码</div>
                    <div style="margin-top:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:24px;font-weight:900;color:#0f172a;letter-spacing:0.06em;word-break:break-all;">${safeCode}</div>
                    <div style="margin-top:10px;font-size:13px;color:#475569;">
                      <span style="color:#94a3b8;">兑换内容：</span>
                      <strong style="color:#134e4a;">${valueDisplay}</strong>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:22px 32px 0;text-align:center;">
              <a href="${escapeHtml(redeemUrl)}"
                 style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0f766e 0%,#134e4a 100%);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;letter-spacing:0.02em;border-radius:999px;box-shadow:0 6px 18px rgba(15,118,110,0.28);">
                 立即兑换 →
              </a>
              <div style="margin-top:10px;font-size:11.5px;color:#94a3b8;">点击按钮跳转首页兑换区域，兑换码已为您自动填入</div>
            </td>
          </tr>

          <!-- Usage hint -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#fffbeb;border:1px solid #fde68a;">
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-size:12px;font-weight:800;color:#92400e;letter-spacing:.04em;margin-bottom:6px;">使用说明</div>
                    <div style="font-size:13px;color:#78350f;line-height:1.7;">${escapeHtml(usageHint)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Manual fallback -->
          <tr>
            <td style="padding:18px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">无法点击按钮？</div>
              <p style="margin:0;font-size:12.5px;color:#475569;line-height:1.65;">
                请复制下方链接到浏览器打开，或直接访问 <a href="${escapeHtml(siteUrl)}" style="color:#0f766e;font-weight:700;text-decoration:underline;">${escapeHtml(siteDomain)}</a> 在首页兑换区域中粘贴兑换码
              </p>
              <div style="margin-top:6px;padding:10px 12px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:#334155;word-break:break-all;">${escapeHtml(redeemUrl)}</div>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">需要帮助？</div>
              <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${escapeHtml(supportContact || "请通过 QQ / WhatsApp / Telegram 联系在线客服")}</p>
              <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">客服在线时间：北京时间 09:00 – 23:00 · 真人值守</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 32px 32px;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="color:#0f172a;font-size:13px;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(brandName)}</td>
                  <td style="text-align:right;color:#94a3b8;font-size:11.5px;">${escapeHtml(siteDomain)}</td>
                </tr>
              </table>
              <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">本邮件由系统自动发送，请勿直接回复。请妥善保管兑换码，遗失或泄露恕不补发</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
