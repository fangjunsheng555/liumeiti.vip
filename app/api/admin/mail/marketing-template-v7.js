import { supportHtml } from "../../../lib/settings-defaults.js";

export const MARKETING_MAIL_V7_TEMPLATE_ID = "service_selection_edm_v7";
export const MARKETING_MAIL_V7_SUBJECT = "会员服务限时优惠｜按你的使用场景轻松选择";
export const MARKETING_MAIL_V7_PREVIEW = "本期会员与数字服务优惠、适用范围和截止时间一目了然。";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(value, limit = 240) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function originOf(siteDomain, siteUrl) {
  const raw = String(siteUrl || "").trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(raw)) return raw;
  const domain = String(siteDomain || "www.liumeiti.vip").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return `https://${domain}`;
}

function safePath(value, fallback = "/shop") {
  const raw = cleanText(value, 500);
  if (!raw) return fallback;
  if (/^\/(?!\/)/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

export function normalizeMarketingOffer(value = {}) {
  const startsAt = cleanText(value.startsAt, 80);
  const endsAt = cleanText(value.endsAt, 80);
  return {
    badge: cleanText(value.badge || "本期精选", 30),
    headline: cleanText(value.headline || "常用数字服务，优惠与规格一次看清", 80),
    description: cleanText(value.description || "价格、适用范围与服务周期均以活动页面为准，确认后再提交订单。", 220),
    originalPrice: cleanText(value.originalPrice, 30),
    currentPrice: cleanText(value.currentPrice || "查看活动价格", 40),
    savingText: cleanText(value.savingText, 50),
    couponCode: cleanText(value.couponCode, 40).replace(/[^A-Za-z0-9_-]/g, ""),
    startsAt,
    endsAt,
    deadlineText: cleanText(value.deadlineText || (endsAt ? `优惠截止：${endsAt.slice(0, 10)}` : "价格与库存以活动页面为准"), 70),
    ctaLabel: cleanText(value.ctaLabel || "查看优惠详情", 32),
    ctaPath: safePath(value.ctaPath, "/shop"),
    serviceKeys: Array.from(new Set((Array.isArray(value.serviceKeys) ? value.serviceKeys : [])
      .map((item) => cleanText(item, 40).replace(/[^a-z0-9-]/gi, ""))
      .filter(Boolean))).slice(0, 6),
  };
}

export function validateMarketingOffer(value = {}, now = Date.now()) {
  const offer = normalizeMarketingOffer(value);
  const start = offer.startsAt ? Date.parse(offer.startsAt) : 0;
  const end = offer.endsAt ? Date.parse(offer.endsAt) : 0;
  if (offer.startsAt && !Number.isFinite(start)) return { ok: false, error: "invalid_offer_start" };
  if (offer.endsAt && !Number.isFinite(end)) return { ok: false, error: "invalid_offer_end" };
  if (start && end && start >= end) return { ok: false, error: "invalid_offer_window" };
  if (end && end <= Number(now)) return { ok: false, error: "offer_expired" };
  if (offer.originalPrice && offer.currentPrice === offer.originalPrice) return { ok: false, error: "offer_price_unchanged" };
  return { ok: true, offer };
}

export function sanitizeMarketingMailHtml(value) {
  return String(value || "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|base)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|base)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)[\s\S]*?\2/gi, " $1=$2#$2")
    .trim()
    .slice(0, 120000);
}

function productRows(products, offer, origin) {
  const active = (Array.isArray(products) ? products : []).filter((product) => product && product.active !== false);
  const priority = new Map(offer.serviceKeys.map((key, index) => [key, index]));
  const selected = active
    .sort((a, b) => (priority.get(a.key) ?? 99) - (priority.get(b.key) ?? 99))
    .slice(0, 3);
  return selected.map((product) => {
    const href = /^https?:\/\//i.test(product.href || "") ? product.href : `${origin}${safePath(product.href, "/shop")}`;
    const icon = /^https?:\/\//i.test(product.icon || "") ? product.icon : `${origin}/products/${cleanText(product.icon, 100)}`;
    return `<tr><td style="padding:18px 0;border-bottom:1px solid #e7e1d5;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr>
        <td width="54" valign="top" style="width:54px;padding-right:14px;"><img src="${escapeHtml(icon)}" width="48" height="48" alt="${escapeHtml(product.name)}" style="display:block;width:48px;height:48px;border-radius:12px;border:1px solid #e2dacb;object-fit:cover;background:#fff;" /></td>
        <td valign="middle"><div style="font-size:16px;line-height:1.35;font-weight:850;color:#082d2b;">${escapeHtml(product.name)}</div><div style="margin-top:3px;font-size:12.5px;line-height:1.55;color:#6e776f;">${escapeHtml(product.subtitle || "查看适用规格与服务周期")}</div></td>
        <td valign="middle" align="right" style="padding-left:12px;white-space:nowrap;"><div style="font-size:14px;line-height:1.35;font-weight:850;color:#006c62;">${escapeHtml(product.price || "查看价格")}</div><a href="${escapeHtml(href)}" style="display:inline-block;margin-top:5px;color:#bd6d18;font-size:12px;font-weight:800;text-decoration:none;">查看详情 →</a></td>
      </tr></table>
    </td></tr>`;
  }).join("");
}

export function buildMarketingMailV7Html({ brandName, siteDomain, siteUrl, products, support, offer: rawOffer } = {}) {
  const origin = originOf(siteDomain, siteUrl);
  const offer = normalizeMarketingOffer(rawOffer);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const ctaUrl = `${origin}${offer.ctaPath}`;
  const heroUrl = `${origin}/marketing/hero-concierge-v5.png`;
  const rows = productRows(products, offer, origin);
  const price = offer.originalPrice
    ? `<span style="color:#9a8f7e;font-size:14px;text-decoration:line-through;">${escapeHtml(offer.originalPrice)}</span><span style="padding-left:9px;color:#f6b955;font-size:27px;font-weight:900;">${escapeHtml(offer.currentPrice)}</span>`
    : `<span style="color:#f6b955;font-size:25px;font-weight:900;">${escapeHtml(offer.currentPrice)}</span>`;
  const coupon = offer.couponCode
    ? `<div style="margin-top:12px;color:#d8e7df;font-size:12.5px;line-height:1.6;">优惠码 <strong style="display:inline-block;margin-left:5px;padding:4px 9px;border:1px dashed #d49a49;color:#ffd58e;letter-spacing:1px;">${escapeHtml(offer.couponCode)}</strong></div>`
    : "";
  const saving = offer.savingText ? `<span style="display:inline-block;margin-left:8px;padding:4px 8px;background:#f6b955;color:#062a28;font-size:11px;font-weight:900;">${escapeHtml(offer.savingText)}</span>` : "";

  return `<!doctype html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml"><head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(MARKETING_MAIL_V7_SUBJECT)}</title>
</head><body style="width:100%;margin:0;padding:0;background:#061f1e;color:#092f2c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:0;">${escapeHtml(MARKETING_MAIL_V7_PREVIEW)}&#8199;&#8199;&#8199;&#8199;&#8199;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#061f1e;"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#f7f0e4;border-radius:22px;overflow:hidden;">
      <tr><td style="padding:19px 26px;background:#f7f0e4;border-bottom:1px solid #dfd4c2;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr>
        <td><a href="${escapeHtml(origin)}" style="text-decoration:none;"><img src="${escapeHtml(origin)}/email-logo.png" width="140" alt="${safeBrand}" style="display:block;width:140px;max-width:100%;height:auto;border:0;" /></a></td>
        <td align="right" style="font-size:11px;line-height:1.4;font-weight:850;letter-spacing:1.2px;color:#557069;">DIGITAL MEMBERSHIP DESK</td>
      </tr></table></td></tr>
      <tr><td><img src="${escapeHtml(heroUrl)}" width="640" alt="数字会员与服务优惠" style="display:block;width:100%;max-width:640px;height:auto;border:0;background:#0b302d;" /></td></tr>
      <tr><td style="padding:34px 30px 36px;background:#082d2b;color:#fdf8ef;">
        <div style="color:#f6b955;font-size:11px;line-height:1.3;font-weight:900;letter-spacing:1.8px;">${escapeHtml(offer.badge.toUpperCase())}</div>
        <h1 style="margin:12px 0 12px;font-size:31px;line-height:1.2;font-weight:950;letter-spacing:-.5px;color:#fffaf0;">${escapeHtml(offer.headline)}</h1>
        <p style="margin:0;max-width:520px;color:#d8e7df;font-size:14px;line-height:1.75;">${escapeHtml(offer.description)}</p>
        <div style="margin-top:18px;">${price}${saving}</div>${coupon}
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:22px;"><tr><td style="background:#f6b955;border-radius:999px;mso-padding-alt:14px 24px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;min-height:20px;padding:14px 24px;color:#082d2b;font-size:14px;line-height:20px;font-weight:900;text-decoration:none;mso-line-height-rule:exactly;">${escapeHtml(offer.ctaLabel)} →</a></td></tr></table>
        <div style="margin-top:11px;color:#9eb8b0;font-size:11px;line-height:1.6;">${escapeHtml(offer.deadlineText)}</div>
      </td></tr>
      <tr><td style="padding:31px 30px 12px;background:#f7f0e4;">
        <div style="color:#08746a;font-size:10px;font-weight:900;letter-spacing:1.5px;">WHY IT MATTERS</div>
        <h2 style="margin:8px 0 17px;color:#082d2b;font-size:23px;line-height:1.35;font-weight:950;">从优惠到售后，信息保持清楚。</h2>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
          <tr><td width="42" style="padding:13px 0;border-top:1px solid #ddd2c0;color:#c9771c;font-size:18px;font-weight:900;">01</td><td style="padding:13px 0;border-top:1px solid #ddd2c0;"><strong style="font-size:14px;color:#082d2b;">先看清规格</strong><div style="margin-top:3px;color:#6e776f;font-size:12px;line-height:1.6;">价格、周期和适用场景在活动页面完整说明。</div></td></tr>
          <tr><td width="42" style="padding:13px 0;border-top:1px solid #ddd2c0;color:#c9771c;font-size:18px;font-weight:900;">02</td><td style="padding:13px 0;border-top:1px solid #ddd2c0;"><strong style="font-size:14px;color:#082d2b;">订单留有记录</strong><div style="margin-top:3px;color:#6e776f;font-size:12px;line-height:1.6;">订单号、付款与处理状态可回到站内查询。</div></td></tr>
          <tr><td width="42" style="padding:13px 0;border-top:1px solid #ddd2c0;color:#c9771c;font-size:18px;font-weight:900;">03</td><td style="padding:13px 0;border-top:1px solid #ddd2c0;"><strong style="font-size:14px;color:#082d2b;">售后进度接得上</strong><div style="margin-top:3px;color:#6e776f;font-size:12px;line-height:1.6;">遇到登录、配置或账号问题，可从服务中心提交。</div></td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:24px 30px 18px;background:#fffaf2;border-top:1px solid #e2d8c8;">
        <div style="color:#08746a;font-size:10px;font-weight:900;letter-spacing:1.5px;">RECOMMENDED FOR YOU</div>
        <h2 style="margin:7px 0 7px;color:#082d2b;font-size:21px;line-height:1.35;font-weight:950;">本期相关服务</h2>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">${rows || `<tr><td style="padding:18px 0;color:#6e776f;font-size:13px;">前往服务目录查看当前可用方案。</td></tr>`}</table>
      </td></tr>
      <tr><td align="center" style="padding:25px 28px 28px;background:#f7f0e4;border-top:1px solid #dfd4c2;">
        <div style="color:#082d2b;font-size:13px;line-height:1.5;font-weight:900;">${safeBrand} · Maoyang Taiwan Inc.</div>
        ${support ? `<div style="margin-top:8px;color:#68766f;font-size:11.5px;line-height:1.8;">${supportHtml(support, "zh")}</div>` : ""}
        <!-- LM_MARKETING_PREFERENCES_SLOT_V1 -->
        <div style="margin-top:9px;color:#8d958e;font-size:10.5px;line-height:1.65;">优惠、价格与库存以活动页面实时状态为准。实际发送邮件底部提供邮件偏好与一键退订入口。</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function buildMarketingMailV7Text({ brandName, siteUrl, products, offer: rawOffer } = {}) {
  const origin = originOf("", siteUrl);
  const offer = normalizeMarketingOffer(rawOffer);
  const priority = new Map(offer.serviceKeys.map((key, index) => [key, index]));
  const selected = (Array.isArray(products) ? products : [])
    .filter((item) => item?.active !== false)
    .sort((left, right) => (priority.get(left?.key) ?? 99) - (priority.get(right?.key) ?? 99))
    .slice(0, 3);
  return [
    `${brandName || "冒央会社"} · ${offer.headline}`,
    offer.badge,
    "",
    offer.description,
    offer.originalPrice ? `原价：${offer.originalPrice}` : "",
    `活动价：${offer.currentPrice}`,
    offer.savingText,
    offer.couponCode ? `优惠码：${offer.couponCode}` : "",
    offer.deadlineText,
    `${offer.ctaLabel}：${origin}${offer.ctaPath}`,
    "",
    ...selected.map((product) => {
      const href = /^https?:\/\//i.test(product.href || "") ? product.href : `${origin}${safePath(product.href, "/shop")}`;
      return `${product.name}｜${product.price || "查看价格"}\n${href}`;
    }),
    "",
    "价格与库存以活动页面实时状态为准。",
  ].filter(Boolean).join("\n");
}
