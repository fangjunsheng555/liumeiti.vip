// 站点设置「唯一权威默认值」(pure data,无 React/无 redis,前后端可引)。
// 默认值 = 当前线上硬编码/env 的值;后台覆盖(Redis lm:settings)在此之上合并。
// 改这里 = 改默认;站主后台改 = 写覆盖。所有消费点都读「合并后」的值,保证全站+邮件一致。

export const SETTINGS_DEFAULTS = {
  // 客服联系方式(站点客服按钮 + 服务中心 + 邮件 + Telegram 文案共用)
  support: {
    qq: { value: "2802632995", href: "mqq://im/chat?chat_type=wpa&uin=2802632995&version=1&src_type=web" },
    whatsapp: { value: "+34 671143339", href: "https://wa.me/message/4ISUO4RPBYSSJ1" },
    telegram: { value: "@MaoyangSupport", href: "https://t.me/MaoyangSupport" },
    hours: "9:00 - 23:00",   // 客服在线时间
  },
  // 品牌 + 站点标题
  brand: {
    name: "冒央会社", nameEn: "Maoyang Taiwan Inc",
    siteTitle: "冒央会社 - 流媒体会员服务", siteTitleEn: "Maoyang Taiwan Inc — Streaming memberships",
  },
  // 页脚(公司信息·版权)
  footer: {
    brand: "冒央会社 · Maoyang Taiwan Inc", brandEn: "Maoyang Taiwan Inc",
    address: "地址：台湾新北市板桥区远东路1号3-218",
    addressEn: "Addr: 3-218, No.1 Yuandong Rd, Banqiao, New Taipei, Taiwan",
    copyright: "Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved",
  },
  // USDT 结算
  usdt: {
    address: "TDoUMF4nF244o5GZvBBwX5t9axvnSoP1Cm",
    discount: 0.9,        // USDT 支付折扣(0.9 = 9折)
    rateOverride: "",     // 空 = 用每日自动汇率;填数字 = 固定该汇率(美元兑人民币)
  },
  // 组合优惠档位
  bundle: { tier2Rate: 0.05, tier3Rate: 0.10 },
  // 收款二维码(支付宝 + USDT 都可换图)
  payment: { alipayQr: "/payment/alipay.jpg", usdtQr: "/payment/usdt.png" },
  // Telegram 新订单通知开关(token/chatId 仍在 env,不在前端暴露)
  notify: { telegramEnabled: true },
};

// 合并工具:把覆盖深合并到默认上(只接受已知字段,防注入;非法值回退默认)。
export function mergeSettings(overrides) {
  const d = SETTINGS_DEFAULTS;
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const str = (v, fb) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const num = (v, fb, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : fb; };
  const link = (key) => {
    const ov = o.support && o.support[key];
    return { value: str(ov?.value, d.support[key].value), href: str(ov?.href, d.support[key].href) };
  };
  return {
    support: {
      qq: link("qq"), whatsapp: link("whatsapp"), telegram: link("telegram"),
      hours: str(o.support?.hours, d.support.hours),
    },
    brand: {
      name: str(o.brand?.name, d.brand.name),
      nameEn: str(o.brand?.nameEn, d.brand.nameEn),
      siteTitle: str(o.brand?.siteTitle, d.brand.siteTitle),
      siteTitleEn: str(o.brand?.siteTitleEn, d.brand.siteTitleEn),
    },
    footer: {
      brand: str(o.footer?.brand, d.footer.brand),
      brandEn: str(o.footer?.brandEn, d.footer.brandEn),
      address: str(o.footer?.address, d.footer.address),
      addressEn: str(o.footer?.addressEn, d.footer.addressEn),
      copyright: str(o.footer?.copyright, d.footer.copyright),
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
    payment: {
      alipayQr: str(o.payment?.alipayQr, d.payment.alipayQr),
      usdtQr: str(o.payment?.usdtQr, d.payment.usdtQr),
    },
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
