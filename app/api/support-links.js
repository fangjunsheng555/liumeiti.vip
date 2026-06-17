// Centralized support contacts + jump links — mirrors the site's FloatingSupport button.
// Single source of truth so the number/links stay in sync across emails and the site.
export const SUPPORT_LINKS = {
  qq: {
    label: "QQ",
    value: process.env.SUPPORT_QQ || "2802632995",
    href: "mqq://im/chat?chat_type=wpa&uin=2802632995&version=1&src_type=web",
  },
  whatsapp: {
    label: "WhatsApp",
    value: process.env.SUPPORT_WHATSAPP || "+34 671143339",
    href: "https://wa.me/message/4ISUO4RPBYSSJ1",
  },
  telegram: {
    label: "Telegram",
    value: process.env.SUPPORT_TELEGRAM || "@MaoyangSupport",
    href: "https://t.me/MaoyangSupport",
  },
};

// Plain-text support line (for text emails / Telegram).
export function supportContactText(locale) {
  const c = SUPPORT_LINKS;
  const body = `QQ ${c.qq.value} / WhatsApp ${c.whatsapp.value} / Telegram ${c.telegram.value}`;
  return locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
}

// HTML support line with clickable jump links (for HTML emails).
export function supportContactHtml(locale) {
  const link = (c) =>
    `<a href="${c.href}" target="_blank" rel="noopener noreferrer" style="color:#0f766e;font-weight:700;text-decoration:underline;white-space:nowrap;">${c.label} ${c.value}</a>`;
  const body = `${link(SUPPORT_LINKS.qq)} &nbsp;/&nbsp; ${link(SUPPORT_LINKS.whatsapp)} &nbsp;/&nbsp; ${link(SUPPORT_LINKS.telegram)}`;
  return locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
}
