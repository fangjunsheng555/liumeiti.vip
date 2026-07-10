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

export const MARKETING_MAIL_TEMPLATE_ID = "membership_edm_v4";
export const MARKETING_MAIL_SUBJECT = "常用会员服务，明码标价 · 付款秒开通";
export const MARKETING_MAIL_PREVIEW = "Spotify、4K 影音、AI 会员与机场节点 —— 官方渠道，付款后即开通，售后有保障。";

// 默认展示的服务(未从目录传入时的兜底)。route 会用合并目录覆盖价格,后台改价即时同步。
function defaultProducts(origin) {
  return [
    { name: "Spotify", subtitle: "欧美日高价区多规格订阅", price: "查看实时价格", href: origin + "/services/spotify", icon: "spotify.jpg" },
    { name: "4K 影音会员", subtitle: "Netflix · Disney+ · HBO Max", price: "查看实时价格", href: origin + "/shop", icon: "streaming-4k-edm-v2.jpg" },
    { name: "AI 会员", subtitle: "ChatGPT · Claude 官方会员", price: "查看实时价格", href: origin + "/services/ai", icon: "ai.jpg" },
    { name: "机场节点", subtitle: "稳定高速科学上网节点", price: "查看实时价格", href: origin + "/services/airport-node", icon: "rocket.jpg" },
  ];
}

export function buildMarketingMailHtml({ brandName, siteDomain, siteUrl, products, support } = {}) {
  const origin = normalizeOrigin(siteDomain, siteUrl);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const homeUrl = escapeHtml(origin);
  const shopUrl = escapeHtml(origin + "/shop");
  const serviceCenterUrl = escapeHtml(origin + "/service-center");
  const accountUrl = escapeHtml(origin + "/account");
  const logoUrl = escapeHtml(origin + "/email-logo.png");
  const asset = (file) => escapeHtml(/^https?:\/\//i.test(file) ? file : origin + "/products/" + file);

  const list = Array.isArray(products) && products.length ? products : defaultProducts(origin);
  const heroTiles = list.slice(0, 4);
  const supportLine = buildSupportLine(support);

  return `<!doctype html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>${escapeHtml(MARKETING_MAIL_SUBJECT)}</title>
  </head>
  <body style="margin:0;padding:0;background:#e9edf1;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:0;">${escapeHtml(MARKETING_MAIL_PREVIEW)}&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;&#8199;</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#e9edf1;">
      <tr>
        <td align="center" style="padding:22px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e4e8ee;border-radius:22px;overflow:hidden;box-shadow:0 12px 30px rgba(15,23,42,0.06);">

            <!-- Header -->
            <tr>
              <td align="center" style="padding:22px 26px 18px;background:#ffffff;">
                <a href="${homeUrl}" style="text-decoration:none;display:inline-block;">
                  <img src="${logoUrl}" width="150" alt="${safeBrand}" style="display:block;width:150px;max-width:150px;height:auto;border:0;" />
                </a>
              </td>
            </tr>
            <tr><td style="padding:0;"><div style="height:3px;background:#0f766e;background:linear-gradient(90deg,#0f766e,#14b8a6);line-height:3px;font-size:0;">&nbsp;</div></td></tr>

            <!-- Hero -->
            <tr>
              <td align="center" style="padding:34px 30px 26px;background:#f1faf8;">
                <div style="color:#0f766e;font-size:12px;line-height:1;font-weight:800;letter-spacing:.22em;text-transform:uppercase;">会员特惠 · Membership</div>
                <h1 style="margin:14px 0 12px;color:#0f172a;font-size:32px;line-height:1.18;font-weight:900;letter-spacing:-0.01em;">常用会员<br />一站开通</h1>
                <p style="margin:0 auto;color:#475569;font-size:15px;line-height:1.7;max-width:340px;">官方渠道 · 明码标价 · 付款后即开通，四类热门服务任你选。</p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px auto 22px;">
                  <tr>
                    ${heroTiles.map((p) => heroTile(asset(p.icon), p.name)).join("")}
                  </tr>
                </table>
                <a href="${homeUrl}" style="display:inline-block;background:#0f766e;border-radius:999px;padding:15px 46px;color:#ffffff;font-size:15px;line-height:1;font-weight:800;text-decoration:none;box-shadow:0 8px 18px rgba(15,118,110,0.28);">立即选购 &nbsp;→</a>
              </td>
            </tr>

            <!-- Benefits -->
            <tr>
              <td style="padding:0;background:#ffffff;border-top:1px solid #eef1f5;border-bottom:1px solid #eef1f5;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    ${benefit("明码标价")}
                    ${benefit("付款秒开通")}
                    ${benefit("售后有保障")}
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Products -->
            <tr>
              <td style="padding:26px 26px 8px;background:#ffffff;">
                <div style="color:#0f766e;font-size:12px;line-height:1;font-weight:800;letter-spacing:.2em;text-transform:uppercase;margin-bottom:4px;">Hot services</div>
                <div style="color:#0f172a;font-size:19px;line-height:1.3;font-weight:900;margin-bottom:14px;">热门服务</div>
                ${list.map((p) => productCard(asset(p.icon), p.name, p.subtitle, p.price, p.href)).join("")}
              </td>
            </tr>

            <!-- Secondary CTA -->
            <tr>
              <td align="center" style="padding:8px 26px 30px;background:#ffffff;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1faf8;border:1px solid #d6efe9;border-radius:16px;">
                  <tr>
                    <td align="center" style="padding:22px 20px;">
                      <div style="color:#0f172a;font-size:16px;line-height:1.4;font-weight:900;margin-bottom:4px;">没找到想要的服务？</div>
                      <div style="color:#5b6b7a;font-size:13.5px;line-height:1.6;margin-bottom:16px;">全部服务与规格都在网站，欢迎咨询在线客服。</div>
                      <a href="${shopUrl}" style="display:inline-block;background:#0f766e;border-radius:999px;padding:13px 34px;color:#ffffff;font-size:14px;line-height:1;font-weight:800;text-decoration:none;">浏览全部服务</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#0f172a;padding:24px 26px 26px;text-align:center;">
                <div style="color:#e2e8f0;font-size:13px;line-height:1.5;font-weight:800;">${safeBrand} · Maoyang Taiwan Inc</div>
                ${supportLine}
                <div style="margin-top:12px;font-size:12.5px;line-height:1.8;">
                  <a href="${homeUrl}" style="color:#5eead4;font-weight:700;text-decoration:none;">服务目录</a>
                  <span style="color:#475569;">&nbsp;·&nbsp;</span>
                  <a href="${serviceCenterUrl}" style="color:#5eead4;font-weight:700;text-decoration:none;">服务中心</a>
                  <span style="color:#475569;">&nbsp;·&nbsp;</span>
                  <a href="${accountUrl}" style="color:#5eead4;font-weight:700;text-decoration:none;">账号中心</a>
                </div>
                <div style="margin-top:12px;color:#64748b;font-size:11px;line-height:1.6;">本邮件为服务通知，如非本人订阅可忽略。</div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function heroTile(src, alt) {
  return `<td width="72" style="width:72px;padding:0 4px;text-align:center;vertical-align:top;">
    <img src="${src}" width="56" height="56" alt="${escapeHtml(alt)}" style="display:block;margin:0 auto 6px;width:56px;height:56px;border-radius:15px;border:1px solid #dbe4e2;background:#fff;object-fit:cover;" />
    <div style="color:#334155;font-size:11px;line-height:1.25;font-weight:700;">${escapeHtml(alt)}</div>
  </td>`;
}

function benefit(label) {
  return `<td width="33.33%" align="center" style="padding:15px 6px;">
    <span style="display:inline-block;width:18px;height:18px;border-radius:999px;background:#0f766e;color:#ffffff;font-size:11px;line-height:18px;font-weight:900;text-align:center;vertical-align:middle;">✓</span>
    <span style="color:#0f172a;font-size:13px;line-height:1.2;font-weight:800;vertical-align:middle;">&nbsp;${escapeHtml(label)}</span>
  </td>`;
}

function productCard(icon, name, subtitle, price, href) {
  const safeHref = escapeHtml(href || "");
  return `<a href="${safeHref}" style="display:block;text-decoration:none;margin-bottom:10px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fbfdfc;border:1px solid #e6ecea;border-radius:14px;">
      <tr>
        <td width="52" style="width:52px;padding:12px 0 12px 12px;">
          <img src="${icon}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border-radius:11px;border:1px solid #e5e7eb;background:#fff;object-fit:cover;" />
        </td>
        <td style="padding:12px 8px 12px 12px;">
          <div style="color:#0f172a;font-size:15px;line-height:1.3;font-weight:900;">${escapeHtml(name)}</div>
          <div style="color:#64748b;font-size:12.5px;line-height:1.4;margin-top:2px;">${escapeHtml(subtitle || "")}</div>
        </td>
        <td align="right" style="padding:12px 14px 12px 6px;white-space:nowrap;vertical-align:middle;">
          <span style="color:#b7791f;font-size:14.5px;line-height:1;font-weight:900;">${escapeHtml(price || "")}</span>
          <span style="color:#0f766e;font-size:15px;font-weight:900;">&nbsp;→</span>
        </td>
      </tr>
    </table>
  </a>`;
}

function buildSupportLine(support) {
  if (!support) return "";
  const parts = [];
  if (support.qq && support.qq.value) parts.push(`QQ ${escapeHtml(support.qq.value)}`);
  if (support.whatsapp && support.whatsapp.value) parts.push(`WhatsApp ${escapeHtml(support.whatsapp.value)}`);
  if (support.telegram && support.telegram.value) parts.push(`Telegram ${escapeHtml(support.telegram.value)}`);
  if (!parts.length) return "";
  return `<div style="margin-top:8px;color:#94a3b8;font-size:12px;line-height:1.7;">在线客服：${parts.join(" &nbsp;·&nbsp; ")}</div>`;
}

export function buildMarketingMailText({ brandName, siteUrl, products } = {}) {
  const brand = brandName || "冒央会社";
  const home = normalizeOrigin("", siteUrl);
  const list = Array.isArray(products) && products.length ? products : defaultProducts(home);
  const lines = [
    `${brand} · ${MARKETING_MAIL_SUBJECT}`,
    "",
    "官方渠道 · 明码标价 · 付款后即开通。",
    "",
    "热门服务：",
    ...list.map((p) => `· ${p.name} ${p.price}  ${p.href}`),
    "",
    "立即选购：",
    home,
  ];
  return lines.join("\n");
}
