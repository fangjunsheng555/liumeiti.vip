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
export const MARKETING_MAIL_SUBJECT = "常用会员服务，一处下单和售后";
export const MARKETING_MAIL_PREVIEW = "Spotify、Netflix、Disney+、HBO Max、AI 与机场节点，一处下单、查询和售后。";

export function buildMarketingMailHtml({ brandName, siteDomain, siteUrl }) {
  const origin = normalizeOrigin(siteDomain, siteUrl);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const homeUrl = escapeHtml(origin);
  const shopUrl = escapeHtml(origin + "/shop");
  const serviceCenterUrl = escapeHtml(origin + "/service-center");
  const accountUrl = escapeHtml(origin + "/account");
  const logoUrl = escapeHtml(origin + "/email-logo.png");
  const product = (file) => escapeHtml(origin + "/products/" + file);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(MARKETING_MAIL_SUBJECT)}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef2f6;color:#151a27;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(MARKETING_MAIL_PREVIEW)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#eef2f6;padding:24px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fffaf2;border-radius:24px;overflow:hidden;border:1px solid #e5dccf;">
            <tr>
              <td style="background:#ffffff;padding:18px 28px;border-bottom:1px solid #e7ded0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle">
                      <a href="${homeUrl}" style="display:inline-block;text-decoration:none;">
                        <img src="${logoUrl}" width="146" alt="${safeBrand}" style="display:block;width:146px;max-width:146px;height:auto;border:0;" />
                      </a>
                    </td>
                    <td valign="middle" align="right" style="font-size:12px;line-height:1.2;font-weight:900;white-space:nowrap;">
                      <a href="${homeUrl}" style="color:#8a632d;text-decoration:none;">服务目录</a>
                      <span style="color:#c6b9a5;">&nbsp;|&nbsp;</span>
                      <a href="${serviceCenterUrl}" style="color:#8a632d;text-decoration:none;">服务中心</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#fffaf2;padding:30px 34px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle" style="padding-right:22px;">
                      <div style="color:#9a6b28;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.15em;">STREAMING · AI · VPN</div>
                      <h1 style="margin:14px 0 10px;color:#111827;font-size:35px;line-height:1.08;font-weight:900;letter-spacing:-.01em;">常用会员服务，<br />一处下单和售后。</h1>
                      <p style="margin:0;color:#475569;font-size:15px;line-height:1.7;">影音、音乐、AI 与机场节点集中处理，购买、查单、售后不用反复换入口。</p>
                      <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px;">
                        <tr>
                          <td style="background:#111827;border-radius:999px;">
                            <a href="${homeUrl}" style="display:inline-block;padding:14px 22px;color:#fffaf2;font-size:14px;font-weight:900;text-decoration:none;">查看服务</a>
                          </td>
                          <td width="10"></td>
                          <td style="border:1px solid #d7ad64;border-radius:999px;">
                            <a href="${serviceCenterUrl}" style="display:inline-block;padding:13px 20px;color:#8a632d;font-size:14px;font-weight:900;text-decoration:none;">查询订单</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td valign="middle" width="148" style="width:148px;">
                      <table role="presentation" width="148" cellspacing="0" cellpadding="0" style="width:148px;background:#ffffff;border:1px solid #e7ded0;border-radius:24px;padding:12px;">
                        <tr>
                          ${heroLogo(product("spotify.jpg"), "Spotify")}
                          ${heroLogo(product("streaming-4k.jpg"), "4K 影音会员")}
                        </tr>
                        <tr>
                          ${heroLogo(product("ai.jpg"), "AI")}
                          ${heroLogo(product("rocket.jpg"), "机场节点")}
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 34px 28px;background:#f8f3ea;">
                <div style="color:#8a632d;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.14em;margin-bottom:12px;">POPULAR SERVICES</div>
                ${serviceLine(product("spotify.jpg"), "Spotify 高价区订阅", "¥128/年起", origin + "/services/spotify")}
                ${serviceLine(product("streaming-4k.jpg"), "4K 影音会员", "¥108/年起", origin + "/shop")}
                ${serviceLine(product("ai.jpg"), "AI 会员", "¥198/三个月起", origin + "/services/ai")}
                ${serviceLine(product("rocket.jpg"), "机场节点", "¥5/次 · ¥128/年起", origin + "/services/airport-node", true)}
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;padding:22px 34px;text-align:center;border-top:1px solid #e7ded0;">
                <span style="display:block;color:#475569;font-size:14px;line-height:1.65;margin-bottom:14px;">已下单用户可直接查询订单、支付状态和售后进度。</span>
                <a href="${serviceCenterUrl}" style="display:inline-block;background:#111827;border-radius:999px;padding:13px 26px;color:#fffaf2;font-size:14px;font-weight:900;text-decoration:none;">进入服务中心</a>
              </td>
            </tr>
            <tr>
              <td style="background:#f4eee5;padding:18px 24px 22px;text-align:center;color:#667085;font-size:12px;line-height:1.75;">
                Maoyang Taiwan Inc · liumeiti.vip<br />
                <a href="${homeUrl}" style="color:#d8b56f;font-weight:850;text-decoration:none;">服务目录</a>
                <span style="color:#566176;"> · </span>
                <a href="${serviceCenterUrl}" style="color:#d8b56f;font-weight:850;text-decoration:none;">服务中心</a>
                <span style="color:#566176;"> · </span>
                <a href="${accountUrl}" style="color:#d8b56f;font-weight:850;text-decoration:none;">账号中心</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function heroLogo(src, alt) {
  return `<td width="62" style="width:62px;padding:4px;">
    <img src="${src}" width="58" height="58" alt="${escapeHtml(alt)}" style="display:block;width:58px;height:58px;border-radius:16px;border:1px solid #e5e7eb;background:#fff;object-fit:cover;" />
  </td>`;
}

function serviceLine(icon, label, price, href, accent = false) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3d8c8;">
    <tr>
      <td style="padding:12px 0;">
        <a href="${escapeHtml(href)}" style="display:block;text-decoration:none;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td width="42" style="width:42px;padding-right:10px;">
                <img src="${icon}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border-radius:9px;border:1px solid #e5e7eb;object-fit:cover;" />
              </td>
              <td style="color:#151a27;font-size:15px;line-height:1.35;font-weight:900;">${escapeHtml(label)}</td>
              <td align="right" style="color:${accent ? "#b45f20" : "#8a632d"};font-size:14px;line-height:1.35;font-weight:900;white-space:nowrap;">${escapeHtml(price)} →</td>
            </tr>
          </table>
        </a>
      </td>
    </tr>
  </table>`;
}

export function buildMarketingMailText({ brandName, siteUrl }) {
  const brand = brandName || "冒央会社";
  const home = normalizeOrigin("", siteUrl);
  const serviceCenter = home + "/service-center";
  const shop = home + "/shop";
  return [
    `${brand} · ${MARKETING_MAIL_SUBJECT}`,
    "",
    "Spotify、Netflix、Disney+、HBO Max、AI 会员与机场节点，统一选择、查询订单和处理问题。",
    "",
    "查看服务：",
    home,
    "",
    "4K 影音会员：",
    shop,
    "",
    "查询订单 / 售后：",
    serviceCenter,
  ].join("\n");
}
