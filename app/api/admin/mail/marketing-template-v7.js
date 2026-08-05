import { supportHtml } from "../../../lib/settings-defaults.js";

export const MARKETING_MAIL_V7_TEMPLATE_ID = "service_selection_edm_v7";
export const MARKETING_MAIL_V7_SUBJECT = "本期数字服务精选｜按需要选择合适方案";
export const MARKETING_MAIL_V7_PREVIEW = "查看当前可用服务、起售价格与服务周期。";

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

function cleanPlainText(value, fallback = "", limit = 240) {
  const scalar = typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : "";
  const normalized = cleanText(scalar, limit * 2)
    .replace(/<(script|style|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return normalized || fallback;
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

function siteUrlOf(value, origin, fallbackPath) {
  try {
    const site = new URL(origin);
    const url = new URL(String(value || fallbackPath), site);
    if (!/^https?:$/.test(url.protocol) || url.origin !== site.origin) return new URL(fallbackPath, site).toString();
    return url.toString();
  } catch {
    return `${origin}${fallbackPath}`;
  }
}

function uniqueServiceKeys(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 40).replace(/[^a-z0-9-]/gi, ""))
    .filter(Boolean))).slice(0, 6);
}

export function normalizeMarketingOffer(value = {}) {
  const startsAt = cleanText(value.startsAt, 80);
  const endsAt = cleanText(value.endsAt, 80);
  const featuredServiceKeys = uniqueServiceKeys(
    Array.isArray(value.featuredServiceKeys) ? value.featuredServiceKeys : value.serviceKeys,
  );
  return {
    badge: cleanPlainText(value.badge, "本期服务精选", 30),
    headline: cleanPlainText(value.headline, "按需要选择合适的数字服务", 80),
    description: cleanPlainText(value.description, "我们整理了当前可用的服务与起售价格，点击即可查看规格、周期和下单说明。", 220),
    startsAt,
    endsAt,
    ctaLabel: cleanPlainText(value.ctaLabel, "查看全部服务", 32),
    ctaPath: safePath(value.ctaPath, "/shop"),
    featuredServiceKeys,
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
  return { ok: true, offer };
}

function decodeSanitizerEntities(value) {
  return String(value || "")
    // Decode only syntax-neutral ASCII. Delimiters stay encoded so an entity
    // in text cannot create a new tag or terminate a quoted attribute.
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, (match, hex, decimal) => {
      const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x7f || [34, 38, 39, 60, 62].includes(code)) return match;
      return String.fromCharCode(code);
    })
    .replace(/&(colon|tab|newline);/gi, (match, name) => ({ colon: ":", tab: "\t", newline: "\n" }[name.toLowerCase()] || match));
}

function decodeCssEscapes(value) {
  let decoded = String(value || "");
  for (let index = 0; index < 2; index += 1) {
    decoded = decoded
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (match, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      })
      .replace(/\\([^\r\n])/g, "$1");
  }
  return decoded;
}

function unsafeMarketingUrl(value, attributeName) {
  const decoded = decodeSanitizerEntities(value).replace(/<!--[\s\S]*?-->/g, "");
  const compact = decoded.replace(/[\x00-\x20\x7f-\x9f]/g, "").toLowerCase();
  if (!compact) return false;

  // Inline raster images remain compatible with historical email HTML. SVG
  // and every non-image data URI are rejected because they can carry script.
  if (compact.startsWith("data:")) {
    return !(attributeName === "src"
      && /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(compact));
  }
  if (attributeName === "srcset" && /(?:^|,)(?:javascript|vbscript|data|file|filesystem|blob):/i.test(compact)) return true;

  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] || "";
  return Boolean(scheme && !["http", "https", "mailto", "tel", "cid"].includes(scheme));
}

function unsafeMarketingCss(value) {
  const decoded = decodeCssEscapes(decodeSanitizerEntities(value))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[\x00-\x20\x7f-\x9f]/g, "")
    .toLowerCase();
  return /(?:javascript|vbscript):|data:(?:text\/html|image\/svg\+xml)|expression\(|behavior:|-moz-binding:|@import/i.test(decoded);
}

export function sanitizeMarketingMailHtml(value) {
  return decodeSanitizerEntities(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/<(script|iframe|object|form|button|textarea|select|svg|math|applet|frameset|audio|video)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>/gi, (match, tagName, attributes) => (
      /\/\s*$/.test(attributes) ? match : ""
    ))
    .replace(/<\/?(?:script|iframe|object|form|button|textarea|select|svg|math|applet|frameset|audio|video|embed|input|base|frame|meta|link|source|track)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, "")
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (match, attributes, css) => (
      unsafeMarketingCss(`${attributes} ${css}`) ? "" : match
    ))
    .replace(/([\s/]+)on[a-z0-9:_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    .replace(/([\s/]+)style\s*=\s*(?:(["'])([\s\S]*?)\2|([^\s>]*))/gi, (match, boundary, quote, quoted, unquoted) => (
      unsafeMarketingCss(quote ? quoted : unquoted) ? " " : match
    ))
    .replace(/([\s/]+)(href|src|srcset|xlink:href|action|formaction|poster|background)\s*=\s*(?:(["'])([\s\S]*?)\3|([^\s>]*))/gi, (match, boundary, name, quote, quoted, unquoted) => (
      unsafeMarketingUrl(quote ? quoted : unquoted, name.toLowerCase())
        ? ` ${name}="#"`
        : match
    ))
    .trim()
    .slice(0, 120000);
}

function selectedProducts(products, offer) {
  const active = (Array.isArray(products) ? products : []).filter((product) => product && product.active !== false);
  if (!offer.featuredServiceKeys.length) return active.slice(0, 3);
  const byKey = new Map(active.map((product) => [product.key, product]));
  return offer.featuredServiceKeys.map((key) => byKey.get(key)).filter(Boolean).slice(0, 3);
}

function productRows(products, offer, origin) {
  return selectedProducts(products, offer).map((product) => {
    const href = siteUrlOf(product.href, origin, "/shop");
    const icon = siteUrlOf(product.icon, origin, "/email-logo.png");
    const name = cleanPlainText(product.name, "数字服务", 80);
    const subtitle = cleanPlainText(product.subtitle, "查看当前规格、周期与服务说明", 160);
    const price = cleanPlainText(product.price, "查看当前价格", 80);
    return `<tr><td style="padding:0 0 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;border-collapse:separate;background:#ffffff;border:1px solid #dbe8e4;border-radius:14px;">
        <tr><td width="58" valign="top" style="width:58px;padding:16px 0 8px 16px;"><img src="${escapeHtml(icon)}" width="46" height="46" alt="" style="display:block;width:46px;height:46px;border-radius:11px;border:1px solid #e0e9e6;object-fit:cover;background:#fff;" /></td>
        <td valign="top" style="padding:16px 16px 8px 12px;"><div style="font-size:16px;line-height:1.35;font-weight:800;color:#123f3a;">${escapeHtml(name)}</div><div style="margin-top:4px;font-size:13px;line-height:1.6;color:#667a76;">${escapeHtml(subtitle)}</div></td></tr>
        <tr><td></td><td style="padding:0 16px 16px 12px;"><strong style="display:inline-block;margin-right:12px;color:#0f766e;font-size:15px;line-height:1.5;">${escapeHtml(price)}</strong><a href="${escapeHtml(href)}" style="display:inline-block;color:#a85f13;font-size:13px;line-height:1.5;font-weight:800;text-decoration:underline;">查看 ${escapeHtml(name)} 方案</a></td></tr>
      </table>
    </td></tr>`;
  }).join("");
}

function benefitLines(benefits = {}) {
  const tier2 = cleanPlainText(benefits.bundleTier2Label, "", 20);
  const tier3 = cleanPlainText(benefits.bundleTier3Label, "", 20);
  const usdt = cleanPlainText(benefits.usdtDiscountLabel, "", 20);
  const lines = [];
  if (tier2 || tier3) {
    const parts = [tier2 ? `同时选购 2 项享 ${tier2}` : "", tier3 ? `3 项及以上享 ${tier3}` : ""].filter(Boolean);
    lines.push(parts.join("，"));
  }
  if (usdt) lines.push(`USDT 支付享 ${usdt}`);
  return lines;
}

export function buildMarketingMailV7Html({ brandName, siteDomain, siteUrl, products, support, benefits, offer: rawOffer } = {}) {
  const origin = originOf(siteDomain, siteUrl);
  const offer = normalizeMarketingOffer(rawOffer);
  const safeBrand = escapeHtml(cleanPlainText(brandName, "冒央会社", 80));
  const ctaUrl = siteUrlOf(offer.ctaPath, origin, "/shop");
  const shopUrl = siteUrlOf("/shop", origin, "/shop");
  const serviceCenterUrl = siteUrlOf("/service-center", origin, "/service-center");
  const rows = productRows(products, offer, origin);
  const benefitsCopy = benefitLines(benefits);
  const benefitsHtml = benefitsCopy.length ? `<tr><td style="padding:0 28px 22px;background:#f5faf8;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#e7f5f1" style="width:100%;border-collapse:separate;background:#e7f5f1;border:1px solid #cce6df;border-radius:12px;"><tr><td style="padding:15px 16px;">
      <div style="color:#0c6259;font-size:13px;line-height:1.5;font-weight:850;">结算优惠自动计算</div>
      <div style="margin-top:4px;color:#496e68;font-size:12.5px;line-height:1.75;">${benefitsCopy.map(escapeHtml).join("<br />")}<br />结算页会按当前规则计算，无需额外操作。</div>
    </td></tr></table>
  </td></tr>` : "";

  return `<!doctype html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml"><head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(MARKETING_MAIL_V7_SUBJECT)}</title>
</head><body style="width:100%;margin:0;padding:0;background:#eef4f2;color:#123f3a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:0;">${escapeHtml(MARKETING_MAIL_V7_PREVIEW)}&#8199;&#8199;&#8199;&#8199;&#8199;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eef4f2" style="width:100%;border-collapse:collapse;background:#eef4f2;"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:620px;border-collapse:separate;background:#ffffff;border:1px solid #d9e5e2;border-radius:18px;overflow:hidden;">
      <tr><td style="padding:18px 26px;background:#ffffff;border-bottom:1px solid #e3ece9;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr>
        <td><a href="${escapeHtml(origin)}" style="text-decoration:none;"><img src="${escapeHtml(origin)}/email-logo.png" width="136" alt="${safeBrand}" style="display:block;width:136px;max-width:100%;height:auto;border:0;" /></a></td>
        <td align="right" style="font-size:12px;line-height:1.5;white-space:nowrap;"><a href="${escapeHtml(shopUrl)}" style="color:#416b65;font-weight:700;text-decoration:none;">服务目录</a><span style="padding:0 7px;color:#b8c8c4;">|</span><a href="${escapeHtml(serviceCenterUrl)}" style="color:#416b65;font-weight:700;text-decoration:none;">服务中心</a></td>
      </tr></table></td></tr>
      <tr><td bgcolor="#0b4f49" style="padding:32px 28px 30px;background:#0b4f49;color:#ffffff;">
        <div style="color:#b9e5da;font-size:12px;line-height:1.4;font-weight:800;letter-spacing:.08em;">${escapeHtml(offer.badge)}</div>
        <h1 style="margin:10px 0 11px;font-size:29px;line-height:1.28;font-weight:900;letter-spacing:-.3px;color:#ffffff;">${escapeHtml(offer.headline)}</h1>
        <p style="margin:0;max-width:520px;color:#d7ebe6;font-size:14px;line-height:1.75;">${escapeHtml(offer.description)}</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:20px;"><tr><td bgcolor="#f4c56a" style="background:#f4c56a;border-radius:9px;mso-padding-alt:13px 21px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 21px;color:#173f3a;font-size:14px;line-height:20px;font-weight:900;text-decoration:none;">${escapeHtml(offer.ctaLabel)} →</a></td></tr></table>
      </td></tr>
      <tr><td style="padding:25px 28px 11px;background:#f5faf8;">
        <h2 style="margin:0 0 5px;color:#123f3a;font-size:21px;line-height:1.4;font-weight:900;">当前可用服务</h2>
        <p style="margin:0 0 15px;color:#526762;font-size:13px;line-height:1.6;">价格来自当前商品目录；点击商品可查看完整规格与服务周期。</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">${rows || `<tr><td style="padding:14px 0 20px;color:#667a76;font-size:14px;line-height:1.7;">请前往服务目录查看当前可用方案。</td></tr>`}</table>
      </td></tr>
      ${benefitsHtml}
      <tr><td style="padding:22px 28px;background:#ffffff;border-top:1px solid #e3ece9;">
        <h2 style="margin:0 0 7px;color:#123f3a;font-size:17px;line-height:1.45;font-weight:850;">下单与售后</h2>
        <p style="margin:0;color:#647873;font-size:13px;line-height:1.8;">登录后可在个人中心查看订单，也可凭订单号和邮箱在服务中心查询。符合条件的有效订单可提交售后工单。</p>
        <p style="margin:8px 0 0;color:#647873;font-size:13px;line-height:1.8;">最终可选规格、库存与应付金额以结算页显示为准。</p>
      </td></tr>
      <tr><td align="center" style="padding:22px 24px 24px;background:#f5f8f7;border-top:1px solid #e0e9e6;">
        <div style="color:#173f3a;font-size:13px;line-height:1.5;font-weight:850;">${safeBrand}</div>
        ${support ? `<div style="margin-top:8px;color:#61736f;font-size:12px;line-height:1.8;">${supportHtml(support, "zh")}</div>` : ""}
        <!-- LM_MARKETING_PREFERENCES_SLOT_V1 -->
        <div style="margin-top:9px;color:#526762;font-size:12px;line-height:1.7;">服务内容、价格与库存以商品详情页及提交订单时显示为准。</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function buildMarketingMailV7Text({ brandName, siteUrl, products, benefits, offer: rawOffer } = {}) {
  const origin = originOf("", siteUrl);
  const offer = normalizeMarketingOffer(rawOffer);
  const selected = selectedProducts(products, offer);
  const lines = benefitLines(benefits);
  return [
    `${cleanPlainText(brandName, "冒央会社", 80)} · ${cleanPlainText(offer.headline, "按需要选择合适的数字服务", 80)}`,
    cleanPlainText(offer.badge, "本期服务精选", 30),
    "",
    cleanPlainText(offer.description, "查看当前可用服务、起售价格与服务周期。", 220),
    `${cleanPlainText(offer.ctaLabel, "查看全部服务", 32)}：${siteUrlOf(offer.ctaPath, origin, "/shop")}`,
    "",
    "当前可用服务",
    ...selected.map((product) => `${cleanPlainText(product?.name, "数字服务", 80)}｜${cleanPlainText(product?.price, "查看当前价格", 80)}\n${siteUrlOf(product?.href, origin, "/shop")}`),
    ...(lines.length ? ["", "结算优惠自动计算", ...lines.map((line) => cleanPlainText(line, "", 120)).filter(Boolean), "结算页会按当前规则计算，无需额外操作。"] : []),
    "",
    "订单可在个人中心或服务中心查询；符合条件的有效订单可提交售后工单。",
    "最终可选规格、库存与应付金额以结算页显示为准。",
  ].filter(Boolean).join("\n");
}
