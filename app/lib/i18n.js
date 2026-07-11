// 轻量 i18n（Cookie 切换式）——中文为源语言，英文为翻译。
// t(key) 未命中时回退中文原文，保证不破坏现有功能。

export const LOCALES = ["zh", "en"];
export const DEFAULT_LOCALE = "zh";
export const LOCALE_COOKIE = "locale";

// 自动识别：浏览器语言以 zh 开头 → 中文，否则英文
export function detectLocale() {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const lang = (navigator.language || navigator.userLanguage || "").toLowerCase();
  return lang.startsWith("zh") ? "zh" : "en";
}

export const messages = {
  zh: {
    "nav.services": "服务产品",
    "nav.process": "下单流程",
    "nav.orderQuery": "订单查询/申请售后",
    "nav.legal": "企业保障",
    "nav.faq": "FAQ",
    "nav.shop": "选购",
    "nav.support": "客服",
    "bnav.home": "首页",
    "bnav.shop": "选购",
    "bnav.cart": "购物车",
    "bnav.center": "服务中心",
    "bnav.account": "我的",
    "lang.switchTo": "English",
    "lang.label": "语言",

    "hero.tagline": "专业流媒体、AI 会员订阅与机场节点服务",
    "hero.badge.instant": "即时开通",
    "hero.badge.refund": "7 天内退款",
    "hero.badge.lowest": "全网最低价",
    "hero.cta.start": "立即开通",
    "hero.cta.account": "个人中心",
    "hero.cta.login": "登录 / 注册",
    "hero.cta.orderQuery": "订单查询/申请售后",
    "hero.authTip": "新用户注册立减 ¥8.88",
    "hero.metric.processed": "今日已完成订单",
    "hero.metric.response": "平均响应时间",
    "hero.metric.queue": "当前排队数量",
    "hero.metric.years": "服务运行年限",

    "ticker.ordered": "下单了",

    "trust.title": "平台优势",
    "trust.stable.t": "稳定渠道",
    "trust.stable.d": "安全稳定",
    "trust.team.t": "专业团队",
    "trust.team.d": "7x24在线",
    "trust.fast.t": "快速处理",
    "trust.fast.d": "及时跟进",
    "trust.privacy.t": "隐私保护",
    "trust.privacy.d": "放心使用",

    "services.kicker": "服务产品",
    "services.title": "数字会员、节点与全球代付",

    "redeem.kicker": "权益兑换",
    "redeem.title": "兑换码兑换",
    "redeem.desc": "输入兑换码即可领取余额或专属服务权益",
    "redeem.placeholder": "准确输入兑换码，支持粘贴",
    "redeem.paste": "粘贴",
    "redeem.submit": "立即兑换",

    "process.kicker": "服务流程",
    "process.title": "下单/兑换流程",
    "process.s1.t": "选择服务",
    "process.s1.d": "选购所需服务，或使用兑换码进行兑换",
    "process.s2.t": "填写资料",
    "process.s2.d": "按要求填写所需邮箱、联系方式与开通资料",
    "process.s3.t": "确认提交",
    "process.s3.d": "核对信息无误后完成支付，兑换码订单无需支付",
    "process.s4.t": "订单进度",
    "process.s4.d": "订单状态更新会向你的邮箱发信，也可在服务中心查询",

    "reviews.kicker": "用户反馈",
    "reviews.title": "用户评价",

    "nav.serviceCenter": "服务中心",
    "nav.contact": "联系我们",
    "svc.plansTitle": "规格与价格",
    "svc.orderTitle": "下单与售后说明",
    "svc.orderDesc": "选择规格后提交订单，完成支付或使用服务兑换码后，可通过邮箱或订单号查询进度",
    "svc.step1": "选择规格",
    "svc.step2": "填写资料",
    "svc.step3": "提交订单",
    "svc.step4": "售后查询",
    "svc.back": "返回选购",
    "svc.orderNow": "立即下单",
    "svc.askSupport": "咨询客服",
    "svc.selectPlan": "选择规格",
    "svc.pickAndOrder": "选择规格并下单",
    "common.close": "关闭",
    "footer.brand": "冒央会社 · Maoyang Taiwan Inc",
    "footer.legal": "企业资质与服务保障",
    "footer.airportNode": "机场节点",
    "footer.address": "地址：台湾新北市板桥区远东路1号3-218",
    "footer.copyright": "Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved",
  },
  en: {
    "nav.services": "Services",
    "nav.process": "How it works",
    "nav.orderQuery": "Orders / after-sales",
    "nav.legal": "Guarantees",
    "nav.faq": "FAQ",
    "nav.shop": "Shop",
    "nav.support": "Support",
    "bnav.home": "Home",
    "bnav.shop": "Shop",
    "bnav.cart": "Cart",
    "bnav.center": "Support",
    "bnav.account": "Account",
    "lang.switchTo": "中文",
    "lang.label": "Language",

    "hero.tagline": "Professional streaming, AI memberships & VPN service",
    "hero.badge.instant": "Instant setup",
    "hero.badge.refund": "7-day refund",
    "hero.badge.lowest": "Best price",
    "hero.cta.start": "Get started",
    "hero.cta.account": "My account",
    "hero.cta.login": "Sign in / Sign up",
    "hero.cta.orderQuery": "Orders / after-sales",
    "hero.authTip": "¥8.88 off for new sign-ups",
    "hero.metric.processed": "Orders today",
    "hero.metric.response": "Avg. reply",
    "hero.metric.queue": "In queue",
    "hero.metric.years": "In operation",

    "ticker.ordered": "ordered",

    "trust.title": "Why choose us",
    "trust.stable.t": "Reliable",
    "trust.stable.d": "Safe & stable",
    "trust.team.t": "Expert team",
    "trust.team.d": "24/7 online",
    "trust.fast.t": "Fast",
    "trust.fast.d": "Prompt follow-up",
    "trust.privacy.t": "Private",
    "trust.privacy.d": "Worry-free",

    "services.kicker": "Services",
    "services.title": "Memberships, VPN & proxy pay",

    "redeem.kicker": "Redeem",
    "redeem.title": "Redeem a code",
    "redeem.desc": "Enter a code to claim balance or exclusive service benefits",
    "redeem.placeholder": "Enter your code — paste supported",
    "redeem.paste": "Paste",
    "redeem.submit": "Redeem now",

    "process.kicker": "Process",
    "process.title": "Order / redeem flow",
    "process.s1.t": "Choose a service",
    "process.s1.d": "Pick the service you need, or redeem with a code",
    "process.s2.t": "Fill in details",
    "process.s2.d": "Provide the required email, contact and setup info",
    "process.s3.t": "Confirm & pay",
    "process.s3.d": "Review and complete payment — code orders need no payment",
    "process.s4.t": "Track progress",
    "process.s4.d": "Status updates are emailed to you, or check the Service Center",

    "reviews.kicker": "Feedback",
    "reviews.title": "Customer reviews",

    "nav.serviceCenter": "Service Center",
    "nav.contact": "Contact",
    "svc.plansTitle": "Plans & pricing",
    "svc.orderTitle": "Ordering & after-sales",
    "svc.orderDesc": "Choose a plan and submit your order; after payment or redeeming a code, track progress by email or order number",
    "svc.step1": "Choose a plan",
    "svc.step2": "Fill in details",
    "svc.step3": "Submit order",
    "svc.step4": "Track & support",
    "svc.back": "Back to shop",
    "svc.orderNow": "Order now",
    "svc.askSupport": "Contact support",
    "svc.selectPlan": "Select plan",
    "svc.pickAndOrder": "Select plan & order",
    "common.close": "Close",
    "footer.brand": "Maoyang Taiwan Inc",
    "footer.legal": "Credentials & service assurance",
    "footer.airportNode": "VPN",
    "footer.address": "Addr: 3-218, No.1 Yuandong Rd, Banqiao, New Taipei, Taiwan",
    "footer.copyright": "Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved",
  },
};

// 首页服务卡英文（副标题/价格），不改共享 service-data
export const serviceCardEn = {
  spotify: { subtitle: "Premium Individual / Duo / Family", price: "From ¥128/yr" },
  netflix: { subtitle: "Global 4K Dolby Profile / full account", price: "From ¥168/yr" },
  disney: { subtitle: "Global 4K Dolby Profile / full account", price: "From ¥108/yr" },
  "hbo-max": { subtitle: "Global 4K Dolby Profile / full account", price: "From ¥148/yr" },
  "airport-node": { name: "VPN", subtitle: "Real-traffic plans & multi-node speed", price: "From ¥128/yr" },
  ai: { name: "AI Membership", subtitle: "ChatGPT & Claude official plans", price: "From ¥198/3 mo" },
  "proxy-payment": { name: "Proxy Pay", subtitle: "Overseas websites · manual quote", price: "From 30%" },
};

// 实时下单条时间本地化
export function localizeTime(value, locale) {
  if (locale !== "en" || typeof value !== "string") return value;
  if (value === "刚刚") return "just now";
  const m = value.match(/^(\d+)\s*分钟前$/);
  return m ? `${m[1]} min ago` : value;
}

export function getT(locale) {
  const loc = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return (key) => {
    const v = messages[loc] && messages[loc][key];
    if (v != null) return v;
    // 回退中文，再回退 key 本身
    return (messages.zh && messages.zh[key]) != null ? messages.zh[key] : key;
  };
}

// 运营数据单位的本地化（值由算法生成，含中文单位）
export function localizeMetric(value, locale) {
  if (locale !== "en" || typeof value !== "string") return value;
  return value
    .replace(/单$/, "")
    .replace(/^<1分钟$/, "<1 min")
    .replace(/(\d+)分钟内$/, "<$1 min")
    .replace(/^近6年$/, "~6 yrs");
}
