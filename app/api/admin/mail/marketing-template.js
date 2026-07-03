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
export const MARKETING_MAIL_SUBJECT = "数字会员服务台｜常用会员与售后统一入口";
export const MARKETING_MAIL_PREVIEW = "营销邮件：数字会员服务台";

export function buildMarketingMailHtml({ brandName, siteDomain, siteUrl }) {
  const origin = normalizeOrigin(siteDomain, siteUrl);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const homeUrl = escapeHtml(origin);
  const shopUrl = escapeHtml(origin + "/shop");
  const serviceCenterUrl = escapeHtml(origin + "/service-center");
  const accountUrl = escapeHtml(origin + "/account");
  const logoUrl = escapeHtml(origin + "/email-logo.png");
  const heroUrl = escapeHtml(origin + "/marketing/hero-concierge-v5.png");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(MARKETING_MAIL_SUBJECT)}</title>
  </head>
  <body style="margin:0;padding:0;background:#070b16;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">常用会员、影音、AI 与节点服务，统一下单、查询订单和处理售后。</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#070b16;padding:28px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#f5efe3;border-radius:26px;overflow:hidden;">
            <tr>
              <td style="padding:24px 42px 20px;background:#f5efe3;border-bottom:1px solid #ded3c2;">
                <img src="${logoUrl}" width="152" alt="${safeBrand}" style="display:block;width:152px;max-width:152px;height:auto;border:0;" />
              </td>
            </tr>
            <tr>
              <td>
                <img src="${heroUrl}" width="640" alt="${safeBrand}数字会员服务台" style="display:block;width:100%;max-width:640px;height:auto;border:0;" />
              </td>
            </tr>
            <tr>
              <td style="background:#0b1020;padding:40px 42px 42px;">
                <div style="display:inline-block;color:#d8b56f;border-bottom:1px solid rgba(216,181,111,.62);padding-bottom:7px;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.16em;">MEMBERSHIP SERVICE DESK</div>
                <h1 style="margin:22px 0 15px;color:#fff7e8;font-size:40px;line-height:1.1;font-weight:900;letter-spacing:-.01em;">把常用会员服务，<br />交给一个稳定入口。</h1>
                <p style="margin:0;color:#d9deea;font-size:15.5px;line-height:1.85;">音乐、4K 影音、AI 会员与机场节点，集中在同一个服务台完成选择、下单、订单查询与售后跟进。少一点临时沟通，多一点可追踪记录。</p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:30px;">
                  <tr>
                    <td style="background:#d7ad64;border-radius:999px;">
                      <a href="${homeUrl}" style="display:inline-block;padding:15px 24px;color:#121019;font-size:15px;font-weight:900;text-decoration:none;">查看服务目录</a>
                    </td>
                    <td width="10"></td>
                    <td style="border:1px solid rgba(215,173,100,.7);border-radius:999px;">
                      <a href="${serviceCenterUrl}" style="display:inline-block;padding:14px 22px;color:#f6ddb0;font-size:15px;font-weight:900;text-decoration:none;">查询订单与售后</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#f5efe3;padding:36px 42px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="border-top:1px solid #d9cdbb;padding-top:24px;color:#8a632d;font-size:12px;font-weight:900;letter-spacing:.14em;">WHY THIS MATTERS</td>
                  </tr>
                  <tr>
                    <td style="padding-top:13px;padding-bottom:20px;">
                      <h2 style="margin:0;color:#121827;font-size:29px;line-height:1.2;font-weight:900;">不是再找一次卖家，<br />而是回到同一个服务台。</h2>
                    </td>
                  </tr>
                  ${reasonRow("01", "规格先看清", "价格、周期、套餐说明、适用场景与最终应付金额，以网站下单页展示为准。")}
                  ${reasonRow("02", "订单可追踪", "下单后可在服务中心查询订单进度、支付状态和售后处理信息。")}
                  ${reasonRow("03", "售后接得上", "账号、配置、节点或会员使用问题，都可以围绕同一条订单继续处理。", true)}
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#fffaf2;padding:34px 42px;">
                <div style="color:#8a632d;font-size:12px;font-weight:900;letter-spacing:.14em;">SERVICE RANGE</div>
                <h2 style="margin:13px 0 8px;color:#121827;font-size:29px;line-height:1.2;font-weight:900;">常用服务保持集中，<br />入口保持简单。</h2>
                <p style="margin:0 0 18px;color:#667085;font-size:14px;line-height:1.75;">下方为常用服务范围，具体规格、库存、优惠和最终价格以网站实时页面为准。</p>
                ${serviceRow("Spotify 高价区订阅", "家庭成员、个人、双人、家庭套餐，适合长期稳定使用。", "¥128/年起", homeUrl)}
                ${serviceRow("4K 影音会员", "Netflix、Disney+、HBO Max 等影音服务，车位或整号按页面选择。", "进入 Shop 查看", shopUrl)}
                ${serviceRow("AI 会员", "GPT Plus / Pro、Claude Pro / Max 等高频工作服务。", "¥198/三个月起", homeUrl)}
                ${serviceRow("机场节点", "真实流量套餐，支持测试后再选择长期规格。", "¥5/次 · ¥128/年起", homeUrl, true)}
              </td>
            </tr>
            <tr>
              <td style="background:#0b1020;padding:36px 42px 40px;">
                <div style="color:#d8b56f;font-size:12px;font-weight:900;letter-spacing:.14em;">ORDER & SUPPORT</div>
                <h2 style="margin:13px 0 12px;color:#fff7e8;font-size:30px;line-height:1.18;font-weight:900;">已下单用户，<br />从服务中心继续处理。</h2>
                <p style="margin:0 0 25px;color:#d9deea;font-size:15px;line-height:1.8;">订单查询、售后沟通、使用问题和后续处理入口已集中到服务中心。需要购买新服务时，再回到服务目录选择即可。</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="center" style="background:#d7ad64;border-radius:999px;">
                      <a href="${serviceCenterUrl}" style="display:block;padding:16px 22px;color:#121019;font-size:16px;font-weight:900;text-decoration:none;">进入服务中心</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#070b16;padding:22px 24px 26px;text-align:center;color:#a5adbd;font-size:12px;line-height:1.8;">
                Maoyang Taiwan Inc · liumeiti.vip<br />
                具体开通方式、库存、优惠与最终价格以网站订单页为准。<br />
                <a href="${homeUrl}" style="color:#d8b56f;font-weight:850;text-decoration:none;">访问网站</a>
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

function reasonRow(index, title, desc, last = false) {
  return `<tr>
    <td style="border-top:1px solid #ded2bf;${last ? "border-bottom:1px solid #ded2bf;" : ""}padding:18px 0;">
      <strong style="display:block;color:#b9873d;font-size:28px;line-height:1;font-weight:900;">${escapeHtml(index)}</strong>
      <b style="display:block;margin-top:10px;color:#121827;font-size:18px;">${escapeHtml(title)}</b>
      <span style="display:block;margin-top:5px;color:#667085;font-size:14px;line-height:1.65;">${escapeHtml(desc)}</span>
    </td>
  </tr>`;
}

function serviceRow(label, desc, price, href, accent = false) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3d8c8;">
    <tr>
      <td style="padding:16px 0;">
        <a href="${href}" style="display:block;text-decoration:none;">
          <b style="display:block;color:#121827;font-size:17px;line-height:1.35;">${escapeHtml(label)}</b>
          <span style="display:block;margin-top:4px;color:#667085;font-size:13px;line-height:1.55;">${escapeHtml(desc)}</span>
          <strong style="display:block;margin-top:8px;color:${accent ? "#b45f20" : "#8a632d"};font-size:20px;line-height:1.2;font-weight:900;">${escapeHtml(price)} →</strong>
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
    "把常用会员服务，交给一个稳定入口。",
    "音乐、4K 影音、AI 会员与机场节点，集中在同一个服务台完成选择、下单、订单查询与售后跟进。",
    "",
    "服务范围：",
    "Spotify 高价区订阅：¥128/年起",
    `4K 影音会员：${shop}`,
    "AI 会员：¥198/三个月起",
    "机场节点：¥5/次 · ¥128/年起",
    "",
    "服务目录：",
    home,
    "",
    "订单查询与售后：",
    serviceCenter,
    "",
    "具体开通方式、库存、优惠与最终价格以网站订单页为准。",
  ].join("\n");
}
