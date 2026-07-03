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
  <body style="margin:0;padding:0;background:#080c17;color:#151a27;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(MARKETING_MAIL_PREVIEW)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#080c17;padding:24px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#f8f3ea;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="background:#101624;padding:28px 34px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:26px;">
                  <tr>
                    <td valign="middle">
                      <img src="${logoUrl}" width="150" alt="${safeBrand}" style="display:block;width:150px;max-width:150px;height:auto;border:0;" />
                    </td>
                    <td valign="middle" align="right" style="color:#d6ad64;font-size:11px;line-height:1.2;font-weight:900;letter-spacing:.16em;white-space:nowrap;">
                      OFFICIAL SERVICE DESK
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle" style="padding-right:22px;">
                      <div style="color:#d6ad64;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.15em;">STREAMING · AI · VPN</div>
                      <h1 style="margin:14px 0 10px;color:#fff7ea;font-size:36px;line-height:1.08;font-weight:900;letter-spacing:-.01em;">常用会员服务，<br />一处下单和售后。</h1>
                      <p style="margin:0;color:#dce1ec;font-size:15px;line-height:1.72;">Spotify、Netflix、Disney+、HBO Max、AI 会员与机场节点，统一选择、查询订单和处理问题。</p>
                      <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px;">
                        <tr>
                          <td style="background:#d7ad64;border-radius:999px;">
                            <a href="${homeUrl}" style="display:inline-block;padding:14px 22px;color:#11131b;font-size:14px;font-weight:900;text-decoration:none;">查看服务</a>
                          </td>
                          <td width="10"></td>
                          <td style="border:1px solid rgba(215,173,100,.72);border-radius:999px;">
                            <a href="${serviceCenterUrl}" style="display:inline-block;padding:13px 20px;color:#f6ddb0;font-size:14px;font-weight:900;text-decoration:none;">查询订单</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td valign="middle" width="184" style="width:184px;">
                      <table role="presentation" width="184" cellspacing="0" cellpadding="0" style="width:184px;">
                        <tr>
                          ${heroLogo(product("spotify.jpg"), "Spotify")}
                          ${heroLogo(product("netflix.jpg"), "Netflix")}
                          ${heroLogo(product("disney.jpg"), "Disney+")}
                        </tr>
                        <tr>
                          ${heroLogo(product("hbomax.jpg"), "HBO Max")}
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
              <td style="padding:26px 34px 8px;background:#f8f3ea;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    ${pointCell("价格先看清", "规格、周期、库存以下单页为准。")}
                    ${pointCell("订单可查询", "进度和售后集中到服务中心。")}
                    ${pointCell("问题可接续", "围绕同一订单继续处理。")}
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 34px 26px;background:#f8f3ea;">
                ${serviceLine(product("spotify.jpg"), "Spotify 高价区订阅", "¥128/年起", origin + "/services/spotify")}
                ${serviceLine(product("netflix.jpg"), "4K 影音会员", "进入 Shop 查看", origin + "/shop")}
                ${serviceLine(product("ai.jpg"), "AI 会员", "¥198/三个月起", origin + "/services/ai")}
                ${serviceLine(product("rocket.jpg"), "机场节点", "¥5/次 · ¥128/年起", origin + "/services/airport-node", true)}
              </td>
            </tr>
            <tr>
              <td style="background:#101624;padding:24px 34px;text-align:center;">
                <div style="color:#fff7ea;font-size:22px;line-height:1.28;font-weight:900;">已下单？直接进服务中心。</div>
                <p style="margin:8px 0 18px;color:#dce1ec;font-size:14px;line-height:1.65;">订单查询、支付状态、售后处理都放在这里。</p>
                <a href="${serviceCenterUrl}" style="display:inline-block;background:#d7ad64;border-radius:999px;padding:14px 28px;color:#11131b;font-size:14px;font-weight:900;text-decoration:none;">进入服务中心</a>
              </td>
            </tr>
            <tr>
              <td style="background:#080c17;padding:18px 24px 22px;text-align:center;color:#9fa8ba;font-size:12px;line-height:1.75;">
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
  return `<td width="58" style="width:58px;padding:0 0 9px 5px;">
    <img src="${src}" width="52" height="52" alt="${escapeHtml(alt)}" style="display:block;width:52px;height:52px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:#fff;object-fit:cover;" />
  </td>`;
}

function pointCell(title, desc) {
  return `<td valign="top" width="33.333%" style="width:33.333%;padding:0 8px 16px 0;">
    <b style="display:block;color:#151a27;font-size:15px;line-height:1.35;font-weight:900;">${escapeHtml(title)}</b>
    <span style="display:block;margin-top:5px;color:#667085;font-size:12.5px;line-height:1.55;">${escapeHtml(desc)}</span>
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
