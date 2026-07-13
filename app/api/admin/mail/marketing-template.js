import { supportHtml } from "../../../lib/settings-defaults.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeOrigin(siteDomain, siteUrl) {
  const explicit = String(siteUrl || "").trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(explicit)) return explicit;
  const domain = String(siteDomain || "www.liumeiti.vip").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return "https://" + domain;
}

export const MARKETING_MAIL_TEMPLATE_ID = "service_selection_edm_v5";
export const MARKETING_MAIL_SUBJECT = "Spotify 与机场节点｜本期服务精选";
export const MARKETING_MAIL_PREVIEW = "高价区 Spotify、多档流量节点，AI 与 4K 影音服务一并可选。";

function defaultProducts(origin) {
  return [
    { key: "spotify", name: "Spotify", subtitle: "家庭成员、个人、双人及家庭套餐", price: "查看实时价格", href: origin + "/services/spotify", icon: "spotify.jpg" },
    { key: "rocket", name: "机场节点", subtitle: "月流量套餐、无限套餐与 10GB 测试", price: "查看实时价格", href: origin + "/services/airport-node", icon: "rocket.jpg" },
    { key: "ai", name: "AI 会员", subtitle: "ChatGPT 与 Claude 多档会员", price: "查看实时价格", href: origin + "/services/ai", icon: "ai.jpg" },
    { key: "netflix", name: "Netflix", subtitle: "4K 杜比车位或整号", price: "查看实时价格", href: origin + "/services/netflix", icon: "netflix.jpg" },
    { key: "disney", name: "Disney+", subtitle: "4K 杜比车位或整号", price: "查看实时价格", href: origin + "/services/disney", icon: "disney.jpg" },
    { key: "max", name: "HBO Max", subtitle: "4K 杜比车位或整号", price: "查看实时价格", href: origin + "/services/hbo-max", icon: "hbomax.jpg" },
    { key: "proxy-pay", name: "全球代付", subtitle: "海外网站与平台，审核报价后付款", price: "3折起", href: origin + "/services/proxy-payment", icon: "proxy-pay.jpg" },
  ];
}

function productMap(products, origin) {
  const source = Array.isArray(products) && products.length ? products : defaultProducts(origin);
  return Object.fromEntries(source.map((product) => [product.key, product]));
}

function imageUrl(origin, icon) {
  return escapeHtml(/^https?:\/\//i.test(icon || "") ? icon : `${origin}/products/${icon || ""}`);
}

function primaryService(product, origin, copy, detail) {
  if (!product) return "";
  return `<tr>
    <td style="padding:24px 0;border-top:1px solid #dce5f3;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        <tr>
          <td width="66" valign="top" style="width:66px;padding-right:16px;">
            <img src="${imageUrl(origin, product.icon)}" width="58" height="58" alt="${escapeHtml(product.name)}" style="display:block;width:58px;height:58px;border:1px solid #dce5f3;border-radius:14px;object-fit:cover;background:#fff;" />
          </td>
          <td valign="top">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td style="color:#101c36;font-size:20px;line-height:1.3;font-weight:800;">${escapeHtml(product.name)}</td>
              <td align="right" style="color:#1457d9;font-size:17px;line-height:1.3;font-weight:800;white-space:nowrap;">${escapeHtml(product.price || "查看实时价格")}</td>
            </tr></table>
            <div style="margin-top:5px;color:#53647f;font-size:14px;line-height:1.65;">${escapeHtml(copy)}</div>
            <div style="margin-top:8px;color:#101c36;font-size:13px;line-height:1.55;font-weight:700;">${escapeHtml(detail)}</div>
            <div style="margin-top:12px;"><a href="${escapeHtml(product.href)}" style="color:#1457d9;font-size:14px;line-height:1.4;font-weight:800;text-decoration:none;">查看规格与价格&nbsp; →</a></div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function secondaryService(product, origin, copy) {
  if (!product) return "";
  return `<tr>
    <td style="padding:17px 0;border-top:1px solid #e2e8f2;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        <tr>
          <td width="48" style="width:48px;padding-right:13px;"><img src="${imageUrl(origin, product.icon)}" width="42" height="42" alt="${escapeHtml(product.name)}" style="display:block;width:42px;height:42px;border-radius:11px;border:1px solid #dce5f3;object-fit:cover;background:#fff;" /></td>
          <td><div style="color:#101c36;font-size:16px;line-height:1.35;font-weight:800;">${escapeHtml(product.name)}</div><div style="margin-top:2px;color:#66758d;font-size:12.5px;line-height:1.5;">${escapeHtml(copy)}</div></td>
          <td align="right" style="padding-left:10px;white-space:nowrap;"><a href="${escapeHtml(product.href)}" style="color:#1457d9;font-size:13.5px;line-height:1.4;font-weight:800;text-decoration:none;">${escapeHtml(product.price || "查看价格")}&nbsp; →</a></td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function compactService(product, origin) {
  if (!product) return "";
  return `<td width="33.33%" valign="top" style="width:33.33%;padding:13px 8px 13px 0;border-top:1px solid #e2e8f2;">
    <a href="${escapeHtml(product.href)}" style="display:block;text-decoration:none;">
      <img src="${imageUrl(origin, product.icon)}" width="34" height="34" alt="${escapeHtml(product.name)}" style="display:block;width:34px;height:34px;border-radius:9px;border:1px solid #dce5f3;object-fit:cover;background:#fff;" />
      <div style="margin-top:8px;color:#101c36;font-size:13.5px;line-height:1.35;font-weight:800;">${escapeHtml(product.name)}</div>
      <div style="margin-top:3px;color:#1457d9;font-size:12.5px;line-height:1.4;font-weight:800;">${escapeHtml(product.price || "查看价格")} →</div>
    </a>
  </td>`;
}

function buildSupportLine(support) {
  if (!support) return "";
  return `<div style="margin-top:9px;color:#66758d;font-size:12px;line-height:1.8;">${supportHtml(support, "zh")}</div>`;
}

export function buildMarketingMailHtml({ brandName, siteDomain, siteUrl, products, support } = {}) {
  const origin = normalizeOrigin(siteDomain, siteUrl);
  const byKey = productMap(products, origin);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const homeUrl = escapeHtml(origin);
  const shopUrl = escapeHtml(origin + "/shop");
  const serviceCenterUrl = escapeHtml(origin + "/service-center");
  const guideUrl = escapeHtml(origin + "/guides");
  const logoUrl = escapeHtml(origin + "/email-logo.png");

  return `<!doctype html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(MARKETING_MAIL_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:#edf2f8;color:#101c36;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:0;">${escapeHtml(MARKETING_MAIL_PREVIEW)}&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#edf2f8;">
    <tr><td align="center" style="padding:18px 10px;">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#ffffff;">
        <tr><td style="padding:18px 28px;border-bottom:1px solid #dce5f3;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td><a href="${homeUrl}" style="text-decoration:none;"><img src="${logoUrl}" width="142" alt="${safeBrand}" style="display:block;width:142px;max-width:142px;height:auto;border:0;" /></a></td>
            <td align="right" style="font-size:12.5px;line-height:1.5;white-space:nowrap;"><a href="${shopUrl}" style="color:#53647f;font-weight:700;text-decoration:none;">服务目录</a><span style="color:#c5cfdd;">&nbsp;&nbsp;|&nbsp;&nbsp;</span><a href="${serviceCenterUrl}" style="color:#53647f;font-weight:700;text-decoration:none;">服务中心</a></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:42px 28px 38px;background:#f4f8ff;border-bottom:1px solid #dce5f3;">
          <div style="color:#1457d9;font-size:12px;line-height:1.3;font-weight:800;letter-spacing:1.5px;">本期服务精选 · JULY</div>
          <h1 style="margin:13px 0 12px;color:#101c36;font-size:34px;line-height:1.18;font-weight:900;letter-spacing:0;">听歌、稳定连接与<br />数字会员，一次选好</h1>
          <p style="margin:0;max-width:500px;color:#53647f;font-size:15px;line-height:1.75;">以 Spotify 高价区订阅与多档机场节点为本期重点；AI 会员、Netflix 及其他影音服务同页可选。规格与价格以网站实时目录为准。</p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px;"><tr>
            <td style="background:#1457d9;"><a href="${shopUrl}" style="display:inline-block;padding:14px 25px;color:#fff;font-size:14px;line-height:1;font-weight:800;text-decoration:none;">查看本期服务&nbsp; →</a></td>
            <td style="padding-left:18px;"><a href="${guideUrl}" style="color:#31415c;font-size:13.5px;line-height:1.4;font-weight:700;text-decoration:none;">先看购买指南</a></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:27px 28px 6px;">
          <div style="color:#1457d9;font-size:11px;line-height:1.3;font-weight:800;letter-spacing:1.4px;">重点推荐</div>
          <div style="margin-top:5px;color:#101c36;font-size:23px;line-height:1.35;font-weight:900;">Spotify 与机场节点</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;">
            ${primaryService(byKey.spotify, origin, "使用自己的 Spotify 账号开通；家庭成员、个人、双人及家庭套餐可选，也可由我们提供账号。", "家庭成员性价比更高，日常使用与个人订阅无异。")}
            ${primaryService(byKey.rocket, origin, "50GB、100GB、200GB 月流量，全年无限流量与 10GB 测试套餐可选。", "交付订阅链接并提供 iPhone、Android、Windows 与 macOS 配置指南。")}
          </table>
        </td></tr>

        <tr><td style="padding:24px 28px;background:#f7f9fc;border-top:1px solid #dce5f3;border-bottom:1px solid #dce5f3;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td width="33.33%" style="color:#101c36;font-size:13px;line-height:1.45;font-weight:800;">实时规格与价格</td>
            <td width="33.33%" style="color:#101c36;font-size:13px;line-height:1.45;font-weight:800;text-align:center;">订单进度可查询</td>
            <td width="33.33%" style="color:#101c36;font-size:13px;line-height:1.45;font-weight:800;text-align:right;">售后工单可追踪</td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:28px 28px 8px;">
          <div style="color:#1457d9;font-size:11px;line-height:1.3;font-weight:800;letter-spacing:1.4px;">更多常用服务</div>
          <div style="margin-top:5px;color:#101c36;font-size:22px;line-height:1.35;font-weight:900;">AI 与 4K 影音</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:15px;">
            ${secondaryService(byKey.ai, origin, "ChatGPT 与 Claude 官方会员，多档额度与周期可选。")}
            ${secondaryService(byKey.netflix, origin, "最高级别 4K 杜比套餐，单独车位或整号可选。")}
          </table>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:5px;"><tr>
            ${compactService(byKey.disney, origin)}
            ${compactService(byKey.max, origin)}
            ${compactService(byKey["proxy-pay"], origin)}
          </tr></table>
        </td></tr>

        <tr><td style="padding:28px;background:#fff7f1;border-top:1px solid #f1dfd1;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td><div style="color:#101c36;font-size:18px;line-height:1.4;font-weight:900;">按需求选规格，不必多买</div><div style="margin-top:5px;color:#66758d;font-size:13px;line-height:1.65;">商品页列出全部规格、交付说明与购买指南；提交订单后可在服务中心查询进度或申请售后。</div></td>
            <td align="right" style="padding-left:16px;white-space:nowrap;"><a href="${shopUrl}" style="display:inline-block;background:#ff633e;padding:13px 18px;color:#fff;font-size:13.5px;line-height:1;font-weight:800;text-decoration:none;">进入服务目录</a></td>
          </tr></table>
        </td></tr>

        <tr><td align="center" style="padding:25px 28px 27px;background:#ffffff;border-top:1px solid #dce5f3;">
          <div style="color:#101c36;font-size:13px;line-height:1.5;font-weight:800;">${safeBrand} · Maoyang Taiwan Inc.</div>
          ${buildSupportLine(support)}
          <div style="margin-top:10px;color:#8290a5;font-size:11px;line-height:1.7;">价格与库存以网站实时页面为准。如无需继续接收服务资讯，可直接回复“退订”。</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildMarketingMailText({ brandName, siteUrl, products } = {}) {
  const origin = normalizeOrigin("", siteUrl);
  const byKey = productMap(products, origin);
  const ordered = ["spotify", "rocket", "ai", "netflix", "disney", "max", "proxy-pay"]
    .map((key) => byKey[key])
    .filter(Boolean);
  return [
    `${brandName || "冒央会社"} · ${MARKETING_MAIL_SUBJECT}`,
    "",
    "Spotify 高价区订阅与多档机场节点为本期重点，AI 会员与 4K 影音服务一并可选。",
    "",
    ...ordered.map((product) => `${product.name}｜${product.price || "查看实时价格"}\n${product.href}`),
    "",
    `服务目录：${origin}/shop`,
    `服务中心：${origin}/service-center`,
    "",
    "价格与库存以网站实时页面为准。如无需继续接收服务资讯，可直接回复“退订”。",
  ].join("\n");
}
