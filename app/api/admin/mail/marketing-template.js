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
export const MARKETING_MAIL_SUBJECT = "数字会员服务台｜常用会员不必重新找";
export const MARKETING_MAIL_PREVIEW = "营销邮件：数字会员服务台";

export function buildMarketingMailHtml({ brandName, siteDomain, siteUrl }) {
  const origin = normalizeOrigin(siteDomain, siteUrl);
  const safeBrand = escapeHtml(brandName || "冒央会社");
  const safeSiteUrl = escapeHtml(origin);
  const safeAccountUrl = escapeHtml(origin + "/account");
  const logoUrl = escapeHtml(origin + "/email-logo.png");
  const heroUrl = escapeHtml(origin + "/marketing/hero-concierge-v4.png");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(MARKETING_MAIL_SUBJECT)}</title>
  </head>
  <body style="margin:0;padding:0;background:#061615;color:#102523;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">把常用数字会员放进一个可查询、有售后的长期服务入口。</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#061615;padding:30px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#f6efe2;border-radius:28px;overflow:hidden;">
            <tr>
              <td style="padding:24px 44px 22px;background:#f6efe2;">
                <img src="${logoUrl}" width="156" alt="${safeBrand}" style="display:block;width:156px;max-width:156px;height:auto;border:0;" />
              </td>
            </tr>
            <tr>
              <td>
                <img src="${heroUrl}" width="640" alt="${safeBrand}数字会员服务台" style="display:block;width:100%;max-width:640px;height:auto;border:0;" />
              </td>
            </tr>
            <tr>
              <td style="background:#061d1b;padding:38px 44px 42px;">
                <div style="display:inline-block;color:#f0bf72;border-bottom:1px solid rgba(240,191,114,.55);padding-bottom:7px;font-size:12px;line-height:1.2;font-weight:900;letter-spacing:.16em;">PRIVATE SERVICE NOTE</div>
                <h1 style="margin:22px 0 15px;color:#fff7e8;font-size:42px;line-height:1.08;font-weight:900;letter-spacing:-.02em;">常用数字会员，<br />不必重新找。</h1>
                <p style="margin:0;color:#d7e7e2;font-size:16px;line-height:1.82;">音乐、4K 影音、AI 会员与节点，集中到一个长期服务入口。先看清规格，再提交订单，售后进度都能接上。</p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:30px;">
                  <tr>
                    <td style="background:#efb45e;border-radius:999px;">
                      <a href="${safeSiteUrl}" style="display:inline-block;padding:16px 28px;color:#211407;font-size:15px;font-weight:900;text-decoration:none;">打开服务入口</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#f6efe2;padding:38px 44px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr><td style="border-top:1px solid #d8cbb7;padding-top:26px;color:#0a665d;font-size:12px;font-weight:900;letter-spacing:.14em;">WHY IT MATTERS</td></tr>
                  <tr><td style="padding-top:14px;padding-bottom:22px;"><h2 style="margin:0;color:#102523;font-size:30px;line-height:1.18;font-weight:900;">从临时购买，<br />变成可追踪服务。</h2></td></tr>
                  <tr><td style="border-top:1px solid #ded2bf;padding:18px 0;"><strong style="display:block;color:#c77b27;font-size:28px;line-height:1;font-weight:900;">01</strong><b style="display:block;margin-top:10px;color:#102523;font-size:18px;">先看清规格</b><span style="display:block;margin-top:5px;color:#60736f;font-size:14px;line-height:1.65;">价格、周期、套餐说明和适用场景，先在下单页看明白。</span></td></tr>
                  <tr><td style="border-top:1px solid #ded2bf;padding:18px 0;"><strong style="display:block;color:#c77b27;font-size:28px;line-height:1;font-weight:900;">02</strong><b style="display:block;margin-top:10px;color:#102523;font-size:18px;">订单留有记录</b><span style="display:block;margin-top:5px;color:#60736f;font-size:14px;line-height:1.65;">订单号、支付方式、处理状态可以回到页面查询。</span></td></tr>
                  <tr><td style="border-top:1px solid #ded2bf;border-bottom:1px solid #ded2bf;padding:18px 0;"><strong style="display:block;color:#c77b27;font-size:28px;line-height:1;font-weight:900;">03</strong><b style="display:block;margin-top:10px;color:#102523;font-size:18px;">售后接得上</b><span style="display:block;margin-top:5px;color:#60736f;font-size:14px;line-height:1.65;">遇到登录、配置或账号问题，不用重新解释前因后果。</span></td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#fffaf2;padding:36px 44px;">
                <div style="color:#0a665d;font-size:12px;font-weight:900;letter-spacing:.14em;">SERVICE RANGE</div>
                <h2 style="margin:13px 0 8px;color:#102523;font-size:30px;line-height:1.18;font-weight:900;">不做复杂目录，<br />只给判断入口。</h2>
                <p style="margin:0 0 18px;color:#66766f;font-size:14px;line-height:1.75;">完整规格、库存、优惠与最终金额以下单页为准。</p>
                ${serviceRow("Spotify 高价区订阅", "家庭成员、个人、双人、家庭套餐", "¥128/年起")}
                ${serviceRow("4K 影音会员", "Netflix、Disney+、HBO Max 车位或整号", "¥108/年起")}
                ${serviceRow("AI 会员", "GPT Plus、GPT Pro、Claude Pro / Max", "¥198/三个月起")}
                ${serviceRow("机场节点", "真实流量套餐，支持测试后再长期使用", "¥5/次 · ¥128/年起", true)}
              </td>
            </tr>
            <tr>
              <td style="background:#061d1b;padding:36px 44px 40px;">
                <div style="color:#efb45e;font-size:12px;font-weight:900;letter-spacing:.14em;">NEXT STEP</div>
                <h2 style="margin:13px 0 12px;color:#fff7e8;font-size:31px;line-height:1.18;font-weight:900;">先打开服务入口，<br />看清楚再决定。</h2>
                <p style="margin:0 0 26px;color:#d1e4df;font-size:15px;line-height:1.8;">只是想试节点，可以从 ¥5/次测试开始；确定长期使用，再选择对应规格。</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="center" style="background:#efb45e;border-radius:999px;">
                      <a href="${safeSiteUrl}" style="display:block;padding:17px 24px;color:#211407;font-size:16px;font-weight:900;text-decoration:none;">查看所有可用服务</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#061615;padding:22px 24px 26px;text-align:center;color:#8da8a2;font-size:12px;line-height:1.8;">
                Maoyang Taiwan Inc · liumeiti.vip<br />
                具体开通方式、库存、优惠与最终价格以网站订单页为准。<br />
                <a href="${safeSiteUrl}" style="color:#efb45e;font-weight:850;text-decoration:none;">访问网站</a>
                <span style="color:#42615b;"> · </span>
                <a href="${safeAccountUrl}" style="color:#efb45e;font-weight:850;text-decoration:none;">账号中心</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function serviceRow(label, desc, price, accent = false) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3d8c8;">
    <tr>
      <td style="padding:16px 0;">
        <b style="display:block;color:#102523;font-size:17px;line-height:1.35;">${escapeHtml(label)}</b>
        <span style="display:block;margin-top:4px;color:#60736f;font-size:13px;line-height:1.55;">${escapeHtml(desc)}</span>
        <strong style="display:block;margin-top:8px;color:${accent ? "#b85115" : "#00675f"};font-size:21px;line-height:1.2;font-weight:900;">${escapeHtml(price)}</strong>
      </td>
    </tr>
  </table>`;
}

export function buildMarketingMailText({ brandName, siteUrl }) {
  const brand = brandName || "冒央会社";
  const url = normalizeOrigin("", siteUrl);
  return [
    `${brand} · ${MARKETING_MAIL_SUBJECT}`,
    "",
    "常用数字会员，不必重新找。",
    "音乐、4K 影音、AI 会员与节点，集中到一个长期服务入口。先看清规格，再提交订单，售后进度都能接上。",
    "",
    "为什么值得看：",
    "1. 先看清规格：价格、周期、套餐说明和适用场景，先在下单页看明白。",
    "2. 订单留有记录：订单号、支付方式、处理状态可以回到页面查询。",
    "3. 售后接得上：遇到登录、配置或账号问题，不用重新解释前因后果。",
    "",
    "服务入口：",
    "Spotify 高价区订阅：¥128/年起",
    "4K 影音会员：¥108/年起",
    "AI 会员：¥198/三个月起",
    "机场节点：¥5/次 · ¥128/年起",
    "",
    "查看所有可用服务：",
    url,
    "",
    "具体开通方式、库存、优惠与最终价格以网站订单页为准。",
  ].join("\n");
}
