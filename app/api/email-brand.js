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
  const safeLogoUrl = escapeEmailHtml(`https://${String(siteDomain || "liumeiti.vip").replace(/^https?:\/\//, "").replace(/\/$/, "")}/email-logo.png`);

  return `
          <tr>
            <td align="center" style="padding:20px 18px 18px;background:linear-gradient(135deg,#f7fffd 0%,#ecfeff 45%,#edfdf6 100%);border-bottom:1px solid #d7f2ed;">
              <img src="${safeLogoUrl}" width="250" alt="${safeBrand}" style="display:block;width:250px;max-width:84%;height:auto;margin:0 auto 10px;border:0;outline:none;text-decoration:none;" />
              <div style="display:inline-block;padding:5px 11px;border-radius:999px;background:#ffffff;border:1px solid rgba(15,118,110,0.14);color:#0f766e;font-size:10.5px;line-height:1.2;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">${safeLabel}</div>
              <div style="margin-top:7px;color:#64748b;font-size:11.5px;line-height:1.35;font-weight:700;">${safeDomain}</div>
            </td>
          </tr>`;
}
