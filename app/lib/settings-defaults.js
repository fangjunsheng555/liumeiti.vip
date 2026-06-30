// 站点设置「唯一权威默认值」(pure data,无 React/无 redis,前后端可引)。
// 默认值 = 当前线上硬编码/env 的值;后台覆盖(Redis lm:settings)在此之上合并。
// 改这里 = 改默认;站主后台改 = 写覆盖。所有消费点都读「合并后」的值,保证全站+邮件一致。

export const SETTINGS_DEFAULTS = {
  // 客服联系方式(站点 + 邮件 + Telegram 文案共用)
  support: {
    qq: { value: "2802632995", href: "mqq://im/chat?chat_type=wpa&uin=2802632995&version=1&src_type=web" },
    whatsapp: { value: "+34 671143339", href: "https://wa.me/message/4ISUO4RPBYSSJ1" },
    telegram: { value: "@MaoyangSupport", href: "https://t.me/MaoyangSupport" },
  },
  // 品牌
  brand: { name: "冒央会社", nameEn: "Maoyang Taiwan Inc" },
  // USDT 结算
  usdt: {
    address: "TDoUMF4nF244o5GZvBBwX5t9axvnSoP1Cm",
    discount: 0.9,        // USDT 支付折扣(0.9 = 9折)
    rateOverride: "",     // 空 = 用每日自动汇率;填数字 = 固定该汇率(美元兑人民币)
  },
  // 组合优惠档位
  bundle: {
    tier2Rate: 0.05,      // 满 2 件折扣(0.05 = 95折)
    tier3Rate: 0.10,      // 满 3 件折扣(0.10 = 9折)
  },
  // 收款
  payment: { alipayQr: "/payment/alipay.jpg" },
  // Telegram 新订单通知开关(token/chatId 仍在 env,不在前端暴露)
  notify: { telegramEnabled: true },
};

// 合并工具:把覆盖 patch 深合并到默认上(只接受已知字段,防注入)。
export function mergeSettings(overrides) {
  const d = SETTINGS_DEFAULTS;
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const str = (v, fb) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const num = (v, fb, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
  };
  const link = (key) => {
    const ov = o.support && o.support[key];
    return {
      value: str(ov?.value, d.support[key].value),
      href: str(ov?.href, d.support[key].href),
    };
  };
  return {
    support: { qq: link("qq"), whatsapp: link("whatsapp"), telegram: link("telegram") },
    brand: {
      name: str(o.brand?.name, d.brand.name),
      nameEn: str(o.brand?.nameEn, d.brand.nameEn),
    },
    usdt: {
      address: str(o.usdt?.address, d.usdt.address),
      discount: num(o.usdt?.discount, d.usdt.discount, 0.1, 1),
      rateOverride: (o.usdt?.rateOverride === "" || o.usdt?.rateOverride == null)
        ? "" : String(num(o.usdt?.rateOverride, "", 0.1, 1000) || ""),
    },
    bundle: {
      tier2Rate: num(o.bundle?.tier2Rate, d.bundle.tier2Rate, 0, 0.9),
      tier3Rate: num(o.bundle?.tier3Rate, d.bundle.tier3Rate, 0, 0.9),
    },
    payment: { alipayQr: str(o.payment?.alipayQr, d.payment.alipayQr) },
    notify: { telegramEnabled: typeof o.notify?.telegramEnabled === "boolean" ? o.notify.telegramEnabled : d.notify.telegramEnabled },
  };
}

// 客服文案(纯文本 / HTML),供邮件与站点共用,基于合并后的 support。
export function supportText(support, locale) {
  const body = `QQ ${support.qq.value} / WhatsApp ${support.whatsapp.value} / Telegram ${support.telegram.value}`;
  return locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
}
export function supportHtml(support, locale) {
  const link = (c) => `<a href="${c.href}" target="_blank" rel="noopener noreferrer" style="color:#0f766e;font-weight:700;text-decoration:underline;white-space:nowrap;">${c.value}</a>`;
  const body = `QQ ${link(support.qq)} &nbsp;/&nbsp; WhatsApp ${link(support.whatsapp)} &nbsp;/&nbsp; Telegram ${link(support.telegram)}`;
  return locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
}
