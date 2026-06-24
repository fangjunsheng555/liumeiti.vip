// 弃单召回邮件 — 专业品牌模板（与订单确认邮件同级：table 邮件安全布局 + 品牌头 + 卡片 + 信任标识 + 双语）。
import { buildEmailBrandHeader } from "../../email-brand.js";
import { supportContactHtml, supportContactText } from "../../support-links.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 商品 key → 展示名（与 lib/store PRODUCTS 一致）。弃单 services 存的是逗号分隔的 key。
const PRODUCT_NAMES = {
  spotify: { zh: "Spotify", en: "Spotify" },
  ai: { zh: "AI 会员", en: "AI Membership" },
  netflix: { zh: "Netflix", en: "Netflix" },
  disney: { zh: "Disney+", en: "Disney+" },
  max: { zh: "HBO Max", en: "HBO Max" },
  rocket: { zh: "机场节点", en: "Airport nodes" },
};

// 解析 services → { displayHtml(好看的名称), ctaUrl(带商品的结算页或选购页) }
function resolveServices(services, base, en) {
  const raw = String(services || "");
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const validKeys = keys.filter((k) => PRODUCT_NAMES[k]);
  if (validKeys.length) {
    const names = validKeys.map((k) => (en ? PRODUCT_NAMES[k].en : PRODUCT_NAMES[k].zh));
    return {
      displayHtml: escapeHtml(names.join(" · ")),
      displayText: names.join(" · "),
      // 点击=自动把这些商品加回购物车并续上结算
      ctaUrl: base + "/checkout?items=" + encodeURIComponent(validKeys.join(",")),
      resume: true,
    };
  }
  // 非标准 key（老数据等）→ 原样显示 + 回选购页兜底
  const fallback = raw || (en ? "the services you picked" : "您挑选的服务");
  return { displayHtml: escapeHtml(fallback), displayText: fallback, ctaUrl: base + "/shop", resume: false };
}

export function buildRecoveryEmailHtml({ services, amount, brandName, siteDomain, siteUrl, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const base = siteUrl || "https://" + (siteDomain || "www.liumeiti.vip");
  const svc = resolveServices(services, base, en);
  const safeServices = svc.displayHtml;
  const ctaUrl = svc.ctaUrl;
  const amountNum = Number(amount);
  const hasAmount = !isNaN(amountNum) && amountNum > 0;

  const trust = [
    { t: L("支付宝担保", "Escrow pay"), d: L("先开通后确认", "Setup, then confirm") },
    { t: L("7 天可退", "7-day refund"), d: L("账号原因无法用", "If it can't be used") },
    { t: L("约 10 分钟开通", "~10-min setup"), d: L("真人值守处理", "Real staff on duty") },
  ];
  const trustCells = trust.map((x) => `
    <td width="33.33%" align="center" style="padding:12px 6px;vertical-align:top;">
      <div style="font-size:13px;font-weight:800;color:#0f766e;letter-spacing:-0.01em;">${x.t}</div>
      <div style="font-size:11px;color:#94a3b8;line-height:1.5;margin-top:3px;">${x.d}</div>
    </td>`).join("");

  return `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-CN"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L("您的订单还差一步", "Your order is one step away")} - ${escapeHtml(brandName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${L("您挑选的服务还在，回来一键继续下单 · ", "Your picks are saved — come back to finish · ")}${escapeHtml(brandName)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
          <!-- Header -->
          ${buildEmailBrandHeader({ brandName, siteDomain, label: L("购物车提醒", "Cart Reminder") })}

          <!-- Hero -->
          <tr>
            <td style="padding:32px 32px 12px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:50%;background:linear-gradient(135deg,#ccfbf1,#a7f3d0);margin-bottom:14px;">
                <span style="font-size:30px;">🛒</span>
              </div>
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">${L("您的订单还差一步", "You're one step from done")}</h1>
              <p style="margin:0;color:#64748b;font-size:13.5px;line-height:1.7;">${L("您挑选的服务我们帮您留着了，回来 30 秒即可完成开通。", "We saved your picks — come back and finish in about 30 seconds.")}</p>
            </td>
          </tr>

          <!-- Selected service card -->
          <tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:16px 18px;">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${L("您挑选的服务", "Your selection")}</div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="vertical-align:middle;color:#0f172a;font-size:14.5px;font-weight:800;letter-spacing:-0.01em;">${safeServices}</td>
                        ${hasAmount ? `<td style="vertical-align:middle;text-align:right;white-space:nowrap;color:#134e4a;font-size:16px;font-weight:900;letter-spacing:-0.02em;">¥${amountNum.toFixed(0)}<span style="font-size:11px;color:#94a3b8;font-weight:600;">${L(" 起", "")}</span></td>` : ""}
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:24px 32px 4px;text-align:center;">
              <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:linear-gradient(135deg,#0f766e 0%,#14b8a6 100%);color:#ffffff;text-decoration:none;padding:15px 44px;border-radius:999px;font-size:15.5px;font-weight:800;letter-spacing:0.01em;box-shadow:0 10px 24px -10px rgba(15,118,110,0.7);">${L("回去完成下单 →", "Complete my order →")}</a>
              <div style="margin-top:10px;font-size:11.5px;color:#94a3b8;">${svc.resume ? L("商品已为您加回购物车，点击即可直接结算", "Your items are added back to the cart — tap to check out") : L("回到选购页即可继续", "Continue from the shop")}</div>
            </td>
          </tr>

          <!-- Trust strip -->
          <tr>
            <td style="padding:22px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;">
                <tr>${trustCells}</tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">${L("有疑问?", "Questions?")}</div>
              <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${supportContactHtml(locale)}</p>
              <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">${L("客服在线时间:北京时间 09:00 – 23:00 · 真人值守", "Support hours: 9:00 – 23:00 Beijing time · staffed by real people")}</p>
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
              <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">${L("本邮件由系统自动发送，请勿直接回复。若您已完成下单，请忽略本邮件。", "This email was sent automatically — please don't reply. If you've already completed your order, kindly ignore this.")}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildRecoveryEmailText({ services, amount, brandName, siteDomain, siteUrl, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const base = siteUrl || "https://" + (siteDomain || "www.liumeiti.vip");
  const resolved = resolveServices(services, base, en);
  const svc = resolved.displayText;
  const ctaUrl = resolved.ctaUrl;
  const amountNum = Number(amount);
  const hasAmount = !isNaN(amountNum) && amountNum > 0;
  const lines = [
    `${brandName} · ${L("您的订单还差一步", "Your order is one step away")}`,
    `===========================`,
    ``,
    L(`您挑选的「${svc}」我们帮您留着了，回来 30 秒即可完成开通${hasAmount ? `（¥${amountNum.toFixed(0)} 起）` : ""}。`,
      `We saved your selection "${svc}"${hasAmount ? ` (from ¥${amountNum.toFixed(0)})` : ""} — come back and finish in ~30 seconds.`),
    ``,
    `${resolved.resume ? L("点此带商品直接结算", "Resume checkout with your items") : L("回去完成下单", "Complete your order")}: ${ctaUrl}`,
    ``,
    L("· 支付宝担保 · 7 天可退 · 约 10 分钟开通 · 真人客服值守", "· Alipay escrow · 7-day refund · ~10-min setup · real staffed support"),
    ``,
    supportContactText(locale),
    L("客服在线:北京时间 09:00 – 23:00", "Support: 9:00 – 23:00 Beijing time"),
    ``,
    L("若您已完成下单，请忽略本邮件。", "If you've already completed your order, please ignore this email."),
    `— ${brandName}`,
  ];
  return lines.join("\n");
}
