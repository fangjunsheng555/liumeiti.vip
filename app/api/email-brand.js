function escapeEmailHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildEmailBrandHeader({ brandName, siteDomain, label }) {
  const safeBrand = escapeEmailHtml(brandName || "\u5192\u592e\u4f1a\u793e");
  const safeDomain = escapeEmailHtml(siteDomain || "liumeiti.vip");
  const safeLabel = escapeEmailHtml(label || "Service Mail");

  return `
          <tr>
            <td style="padding:20px 22px;background:linear-gradient(135deg,#f8fffd 0%,#ecfeff 46%,#eefcf7 100%);border-bottom:1px solid #d7f2ed;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;width:52px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:44px;height:44px;border-radius:15px;background:linear-gradient(135deg,#5b5cf6 0%,#20c6df 52%,#10b981 100%);box-shadow:0 8px 18px rgba(15,118,110,0.18);">
                      <tr>
                        <td align="center" valign="middle" style="height:44px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;font-weight:900;letter-spacing:-0.04em;">MY</td>
                      </tr>
                    </table>
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <div style="font-size:18px;line-height:1.15;font-weight:900;color:#0f172a;letter-spacing:-0.04em;">${safeBrand}</div>
                    <div style="margin-top:3px;font-size:10px;line-height:1.2;font-weight:800;color:#0f766e;letter-spacing:0.16em;text-transform:uppercase;">Maoyang Taiwan Inc</div>
                  </td>
                  <td align="right" style="vertical-align:middle;padding-left:10px;">
                    <div style="display:inline-block;padding:5px 10px;border-radius:999px;background:#ffffff;border:1px solid rgba(15,118,110,0.14);color:#0f766e;font-size:10.5px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">${safeLabel}</div>
                    <div style="margin-top:5px;color:#64748b;font-size:11.5px;font-weight:700;">${safeDomain}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}
