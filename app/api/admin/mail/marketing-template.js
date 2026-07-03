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
export const MARKETING_MAIL_SUBJECT = "常用会员服务，立即下单开通";
export const MARKETING_MAIL_PREVIEW = "Spotify、4K 影音、AI 会员与机场节点，明码标价，付款后开通。";

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
  <body style="margin:0;padding:0;background:#eef2f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(MARKETING_MAIL_PREVIEW)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#eef2f6;padding:18px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fffaf2;border:1px solid #e5dccf;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="background:#ffffff;padding:18px 26px;border-bottom:1px solid #e7ded0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle" align="center">
                      <a href="${homeUrl}" style="display:inline-block;text-decoration:none;">
                        <img src="${logoUrl}" width="146" alt="${safeBrand}" style="display:block;width:146px;max-width:146px;height:auto;border:0;" />
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="background:#fffaf2;padding:30px 28px 22px;">
                <div style="color:#9a6b28;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.14em;">MEMBERSHIP SHOP</div>
                <h1 style="margin:14px 0 10px;color:#111827;font-size:34px;line-height:1.12;font-weight:900;letter-spacing:0;">会员服务<br />立即下单</h1>
                <p style="margin:0 auto;color:#475569;font-size:15px;line-height:1.72;width:300px;max-width:300px;">四类热门服务，明码标价，付款后开通。</p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px auto 18px;">
                  <tr>
                    ${heroLogo(product("spotify.jpg"), "Spotify")}
                    ${heroLogo(product("streaming-4k-edm-v2.jpg"), "4K 影音会员")}
                    ${heroLogo(product("ai.jpg"), "AI")}
                    ${heroLogo(product("rocket.jpg"), "机场节点")}
                  </tr>
                </table>
                <a href="${homeUrl}" style="display:inline-block;background:#111827;border-radius:999px;padding:15px 42px;color:#fffaf2;font-size:15px;line-height:1.2;font-weight:900;text-decoration:none;">去网站下单</a>
              </td>
            </tr>
            <tr>
              <td align="center" style="background:#ffffff;padding:14px 18px;border-top:1px solid #e7ded0;border-bottom:1px solid #e7ded0;color:#111827;font-size:13px;line-height:1.5;font-weight:900;">
                <span style="color:#d7ad64;">●</span>&nbsp;明码标价&nbsp;&nbsp;
                <span style="color:#d7ad64;">●</span>&nbsp;快速开通&nbsp;&nbsp;
                <span style="color:#d7ad64;">●</span>&nbsp;售后保障
              </td>
            </tr>
            <tr>
              <td style="padding:22px 28px 24px;background:#f8f3ea;">
                <div style="color:#8a632d;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.14em;margin-bottom:10px;">HOT SERVICES</div>
                ${serviceLine(product("spotify.jpg"), "Spotify 高价区订阅", "¥128/年起", origin + "/services/spotify")}
                ${serviceLine(product("streaming-4k-edm-v2.jpg"), "4K 影音会员", "¥108/年起", origin + "/shop")}
                ${serviceLine(product("ai.jpg"), "AI 会员", "¥198/三个月起", origin + "/services/ai")}
                ${serviceLine(product("rocket.jpg"), "机场节点", "¥5/次 · ¥128/年起", origin + "/services/airport-node", true)}
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;padding:22px 26px;text-align:center;">
                <a href="${homeUrl}" style="display:inline-block;background:#111827;border-radius:999px;padding:14px 36px;color:#fffaf2;font-size:14px;line-height:1.2;font-weight:900;text-decoration:none;">立即选择服务</a>
              </td>
            </tr>
            <tr>
              <td style="background:#f4eee5;padding:16px 22px 20px;text-align:center;color:#667085;font-size:12px;line-height:1.75;">
                Maoyang Taiwan Inc · liumeiti.vip<br />
                <a href="${homeUrl}" style="color:#8a632d;font-weight:850;text-decoration:none;">服务目录</a>
                <span style="color:#b6a99a;"> · </span>
                <a href="${serviceCenterUrl}" style="color:#8a632d;font-weight:850;text-decoration:none;">服务中心</a>
                <span style="color:#b6a99a;"> · </span>
                <a href="${accountUrl}" style="color:#8a632d;font-weight:850;text-decoration:none;">账号中心</a>
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
  return `<td width="68" style="width:68px;padding:0 5px;">
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
              <td width="44" style="width:44px;padding-right:10px;">
                <img src="${icon}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:10px;border:1px solid #e5e7eb;object-fit:cover;" />
              </td>
              <td style="color:#111827;font-size:15px;line-height:1.35;font-weight:900;">
                ${escapeHtml(label)}
                <div style="margin-top:4px;color:${accent ? "#b45f20" : "#8a632d"};font-size:14px;line-height:1.35;font-weight:900;">${escapeHtml(price)} →</div>
              </td>
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
  const shop = home + "/shop";
  return [
    `${brand} · ${MARKETING_MAIL_SUBJECT}`,
    "",
    "四类热门服务，明码标价，付款后开通。",
    "",
    "立即下单：",
    home,
    "",
    "4K 影音会员：",
    shop,
  ].join("\n");
}
