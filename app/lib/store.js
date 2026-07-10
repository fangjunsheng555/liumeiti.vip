"use client";

import { useEffect, useState } from "react";
import { SETTINGS_DEFAULTS, discountLabel } from "./settings-defaults.js";

export const USDT_ADDRESS = "TDoUMF4nF244o5GZvBBwX5t9axvnSoP1Cm";
export const USDT_DISCOUNT = 0.9;
export const USDT_RATE = 6.85;

// ── 站点设置(运行时覆盖) ──
// useSiteSettings() 拉 /api/settings(默认+后台覆盖的合并值)写入;组合优惠档位、USDT 折扣、
// 收款地址/二维码、客服联系方式等都读合并后的值,保证站点显示与结账实收一致。未加载=默认。
let SITE_SETTINGS = SETTINGS_DEFAULTS;
export function applySiteSettings(s) { if (s && typeof s === "object") SITE_SETTINGS = s; }
export function getSiteSettings() { return SITE_SETTINGS; }
export function useSiteSettings() {
  const [settings, setSettings] = useState(SITE_SETTINGS);
  useEffect(() => {
    let on = true;
    fetch("/api/settings", { cache: "no-store", credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => { if (on && j && j.ok && j.settings) { applySiteSettings(j.settings); setSettings(j.settings); } })
      .catch(() => {});
    return () => { on = false; };
  }, []);
  return settings;
}

export const PRODUCTS = [
  {
    key: "spotify",
    image: "/products/spotify.jpg",
    title: "Spotify",
    subtitle: "欧美日高价区多规格订阅",
    amount: 128,
    cycle: "1年",
    hasPlan: true,
    price: "¥128/年起",
    shortIntro: "欧美日高价区订阅，家庭成员、个人、双人与家庭套餐可选",
    highlights: ["高价区订阅", "多规格可选", "售后保障"],
    detailTitle: "欧美日高价区 Spotify 订阅，按需选择成员或套餐",
    detailBody:
      "支持无损音质、播客、AIDJ、离线下载、合辑歌单与完整曲库。可选家庭成员席位 ¥128/年、个人订阅 ¥388/年、双人订阅 ¥488/年（可邀请 1 个账号免费享用订阅）、家庭套餐 ¥588/年（可邀请 5 个账号免费享用订阅），均为欧美日高价区订阅并包含售后协助",
    orderTitle: "Spotify · 多规格年付订阅",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "ai",
    image: "/products/ai.jpg",
    title: "AI 会员",
    subtitle: "ChatGPT / Claude 官方会员",
    amount: 198,
    cycle: "三个月",
    hasPlan: true,
    price: "¥198/三个月起",
    shortIntro: "ChatGPT 与 Claude 官方会员，官方渠道直充，独立账号，包售后",
    highlights: ["官方充值", "独立账号", "包售后"],
    detailTitle: "ChatGPT / Claude 官方会员，官方渠道直充",
    detailBody:
      "官方渠道直充会员/订阅，独立账号、非共享，开通后稳定可用，支持 ChatGPT 与 Claude 全部会员功能。可选 GPT Plus ¥198、GPT 5x Pro ¥998、GPT 20x Pro ¥1888、Claude Pro ¥198、Claude 5x Max ¥998、Claude 20x Max ¥1888（均为三个月），下单后充值人员将在30分钟内联系开通，全程包售后",
    orderTitle: "AI 会员 · 规格选择",
    orderBody:
      "填写邮箱与联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "netflix",
    image: "/products/netflix.jpg",
    title: "Netflix",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 168,
    cycle: "1年",
    hasPlan: true,
    price: "¥168/年起",
    shortIntro: "最高级别4K杜比套餐，单独车位或整号购买可选",
    highlights: ["4K杜比", "车位可锁", "整号可选"],
    detailTitle: "Netflix 最高级别 4K 杜比套餐，车位与整号均可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥168/年，一人独享一个用户档案，可设置 PIN 锁，高峰不排队不被挤；整号购买 ¥588/年，最多支持 5 个用户档案/车位，适合家庭或多人长期稳定使用",
    orderTitle: "Netflix · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "disney",
    image: "/products/disney.jpg",
    title: "Disney+",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 108,
    cycle: "1年",
    hasPlan: true,
    price: "¥108/年起",
    shortIntro: "最高级别4K杜比套餐，独立车位与整号可选",
    highlights: ["4K杜比", "全球可用", "整号可选"],
    detailTitle: "Disney+ 顶级 4K 杜比套餐，单独车位与整号可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥108/年，一人一位置互不干扰；整号购买 ¥588/年，最多支持 7 个用户档案/车位，适合家庭共享与长期使用，订单均包含售后保障",
    orderTitle: "Disney+ · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "proxy-pay",
    image: "/products/proxy-pay.jpg",
    title: "全球代付",
    subtitle: "海外网站与平台人工代付",
    amount: 0,
    cycle: "人工报价",
    price: "3折起",
    quoteOnly: true,
    shortIntro: "代付海外网站与平台，中国大陆网站除外",
    highlights: ["海外平台可用", "人工核价", "报价后付款"],
    detailTitle: "提交代付需求，收到人工报价后再付款",
    detailBody: "填写邮箱、网站链接、商品标价与联系方式。工作人员核验平台及商品后发送报价邮件，您可通过邮件中的专属链接付款。中国大陆网站暂不支持。",
    orderTitle: "全球代付 · 人工报价",
    orderBody: "提交需求后等待报价，无需预先付款",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "rocket",
    image: "/products/rocket.jpg",
    title: "机场节点",
    subtitle: "多档真实流量套餐·最高速率5Gbps·解锁全球平台",
    amount: 128,
    cycle: "1年",
    needsUsername: true,
    hasPlan: true,
    price: "¥128/年起",
    shortIntro: "大厂机房多线路，最高5Gbps带宽，按月提供真实流量，解锁流媒体/AI/社交软件",
    highlights: ["真实流量套餐", "高速稳定多节点", "全加密无日志"],
    detailTitle: "大厂机房多线路，真实流量套餐可选，年仅 ¥128 起",
    detailBody:
      "优选大厂VPS，多线路港日台韩新美英德法等，最高速率可达5Gbps，高峰不拥堵不卡顿，解锁所有主流流媒体/AI软件/社交软件，全加密协议无日志隐私保障，实时维护24×7线路不中断。可选 普通套餐 ¥128/年（50GB/月真实流量）、高级套餐 ¥198/年（100GB/月真实流量）、豪华套餐 ¥398/年（200GB/月真实流量）、无限套餐 ¥698/年（无限流量）。另有 ¥5/次 10GB 测试套餐",
    orderTitle: "机场节点 · 支付宝扫码支付",
    orderBody:
      "请在支付完成后点击付款完成提交订单，提交后会生成订阅链接",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "max",
    image: "/products/hbomax.jpg",
    title: "HBO Max",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 148,
    cycle: "1年",
    hasPlan: true,
    price: "¥148/年起",
    shortIntro: "最高级别4K杜比套餐，独立车位或整号购买可选",
    highlights: ["4K杜比", "全球可用", "整号可选"],
    detailTitle: "HBO Max 最高级别 4K 杜比套餐，车位与整号均可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥148/年，一人独享一个位置，互不干扰；整号购买 ¥588/年，最多支持 5 个用户档案/车位，适合影迷家庭与多人稳定使用",
    orderTitle: "HBO Max · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
];

export const ROCKET_PLANS = {
  basic: { id: "basic", label: "普通套餐", amount: 128, desc: "50 GB/月真实流量" },
  pro: { id: "pro", label: "高级套餐", amount: 198, desc: "100 GB/月真实流量" },
  luxury: { id: "luxury", label: "豪华套餐", amount: 398, desc: "200 GB/月真实流量" },
  unlimited: { id: "unlimited", label: "无限套餐", amount: 698, desc: "无限流量" },
  trial: { id: "trial", label: "5元10GB测试", amount: 5, desc: "10 GB测试流量", unit: "次", cycle: "次", requiresLogin: false, onePerUser: false },
};
export const PRODUCT_PLANS = {
  spotify: {
    member: { id: "member", label: "家庭成员", amount: 128, desc: "加入欧美日高价区家庭计划，成员席位" },
    individual: { id: "individual", label: "个人订阅", amount: 388, desc: "欧美日高价区个人订阅，独立使用" },
    duo: { id: "duo", label: "双人订阅", amount: 488, desc: "可邀请 1 个账号免费享用订阅" },
    family: { id: "family", label: "家庭套餐", amount: 588, desc: "可邀请 5 个账号免费享用订阅" },
  },
  netflix: {
    seat: { id: "seat", label: "单独车位", amount: 168, desc: "4K 杜比独立用户档案，可上锁" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  disney: {
    seat: { id: "seat", label: "单独车位", amount: 108, desc: "4K 杜比独立用户档案，互不干扰" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 7 个用户档案/车位" },
  },
  max: {
    seat: { id: "seat", label: "单独车位", amount: 148, desc: "4K 杜比独立用户档案，稳定售后" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  rocket: ROCKET_PLANS,
  ai: {
    "gpt-plus": { id: "gpt-plus", label: "GPT Plus", amount: 198, unit: "三个月", desc: "ChatGPT Plus 官方会员 · 三个月" },
    "gpt-pro": { id: "gpt-pro", label: "GPT 5x Pro", amount: 998, unit: "三个月", desc: "ChatGPT Pro 5x 高额度 · 三个月" },
    "gpt-20x-pro": { id: "gpt-20x-pro", label: "GPT 20x Pro", amount: 1888, unit: "三个月", desc: "ChatGPT Pro 20x 超大额度 · 三个月" },
    "claude-pro": { id: "claude-pro", label: "Claude Pro", amount: 198, unit: "三个月", desc: "Claude Pro 官方会员 · 三个月" },
    "claude-max": { id: "claude-max", label: "Claude 5x Max", amount: 998, unit: "三个月", desc: "Claude Max 5x 高额度 · 三个月" },
    "claude-20x-max": { id: "claude-20x-max", label: "Claude 20x Max", amount: 1888, unit: "三个月", desc: "Claude Max 20x 超大额度 · 三个月" },
  },
};
export const DEFAULT_PRODUCT_PLANS = {
  spotify: "member",
  netflix: "seat",
  disney: "seat",
  max: "seat",
  rocket: "basic",
  ai: "gpt-plus",
};
export const DEFAULT_ROCKET_PLAN = DEFAULT_PRODUCT_PLANS.rocket;

// ── 后台商品/价格覆盖(运行时) ──
// useCatalogSync() 拉 /api/catalog(默认+后台覆盖的合并值)写入此处;所有价格/规格/上下架
// 解析都会优先读它,从而首页/选购/服务页/结账与「结账实收价(服务端权威)」完全一致。
// 未加载时(首屏/SSR)= 静态默认值,默认值已与 catalog-defaults 一一对应,故无不一致。
let CATALOG_OVERRIDE = null; // { byKey:{[key]:{active,fields...,plans:{[id]:{...}},activePlanIds:Set}}, order:[key...] }

export function applyCatalogOverride(apiProducts) {
  if (!Array.isArray(apiProducts)) return;
  const byKey = {};
  const order = [];
  for (const p of apiProducts) {
    if (!p || !p.key) continue;
    order.push(p.key);
    const plans = {};
    (p.plans || []).forEach((pl) => { plans[pl.id] = { id: pl.id, amount: Number(pl.amount), label: pl.label, desc: pl.desc, cycle: pl.cycle, unit: pl.cycle, soldOut: !!pl.soldOut }; });
    byKey[p.key] = {
      active: true,
      title: p.title, subtitle: p.subtitle, price: p.priceText, cycle: p.cycle,
      shortIntro: p.shortIntro, highlights: p.highlights,
      detailTitle: p.detailTitle, detailBody: p.detailBody, defaultPlan: p.defaultPlan,
      quoteOnly: !!p.quoteOnly,
      plans, activePlanIds: new Set((p.plans || []).map((pl) => pl.id)),
    };
  }
  CATALOG_OVERRIDE = { byKey, order };
}

export function catalogOverrideLoaded() { return CATALOG_OVERRIDE !== null; }
function ovProduct(key) { return CATALOG_OVERRIDE ? (CATALOG_OVERRIDE.byKey[key] || null) : null; }

// 合并后的商品列表(给首页/选购/结账用):未加载=默认全部;加载后=仅上架商品、按后台排序、字段覆盖。
export function getCatalogProducts() {
  if (!CATALOG_OVERRIDE) return PRODUCTS;
  const baseByKey = {};
  PRODUCTS.forEach((p) => { baseByKey[p.key] = p; });
  return CATALOG_OVERRIDE.order
    .map((key) => {
      const base = baseByKey[key];
      if (!base) return null;
      const ov = CATALOG_OVERRIDE.byKey[key];
      return {
        ...base,
        title: ov.title || base.title,
        subtitle: ov.subtitle || base.subtitle,
        price: ov.price || base.price,
        cycle: ov.cycle || base.cycle,
        shortIntro: ov.shortIntro || base.shortIntro,
        highlights: Array.isArray(ov.highlights) && ov.highlights.length ? ov.highlights : base.highlights,
        detailTitle: ov.detailTitle || base.detailTitle,
        detailBody: ov.detailBody || base.detailBody,
        quoteOnly: ov.quoteOnly || base.quoteOnly || false,
      };
    })
    .filter(Boolean);
}

export function getCatalogProduct(key) {
  return getCatalogProducts().find((p) => p.key === key) || null;
}

// 拉取并应用后台覆盖;返回版本号(变化即触发组件重渲染,显示最新价格/上下架)。
// 任何展示价格的客户端页面在顶部调用一次即可。
export function useCatalogSync() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let on = true;
    fetch("/api/catalog", { cache: "no-store", credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => { if (on && j && j.ok) { applyCatalogOverride(j.products); setVersion((v) => v + 1); } })
      .catch(() => {});
    return () => { on = false; };
  }, []);
  return version;
}

// --- English localization (display only; ids/amounts unchanged) ---
export const PRODUCT_EN = {
  spotify: {
    title: "Spotify",
    subtitle: "Premium Individual / Duo / Family",
    price: "From ¥128/yr",
    cycle: "1 yr",
    shortIntro: "Premium-region accounts — Family member, Individual, Duo or Family",
    highlights: ["Premium region", "Multiple plans", "After-sales support"],
    detailTitle: "Premium-region Spotify accounts — choose a seat or plan",
    detailBody:
      "Includes lossless audio, podcasts, AI DJ, offline downloads, playlists and the full catalog. Choose Family member ¥128/yr, Individual ¥388/yr, Duo ¥488/yr (invite 1 account free) or Family ¥588/yr (invite 5 accounts free) — all on premium-region accounts with after-sales support.",
    orderTitle: "Spotify · annual plans",
    orderBody: "Enter your contact details and pay via Alipay. Once you submit, our team will reach out within 30 minutes.",
  },
  netflix: {
    title: "Netflix",
    subtitle: "Global 4K Dolby Profile / full account",
    price: "From ¥168/yr",
    cycle: "1 yr",
    shortIntro: "Top 4K Dolby tier — Dedicated Profile or full account",
    highlights: ["4K Dolby", "Lockable Profile", "Full account"],
    detailTitle: "Netflix's top 4K Dolby tier — Profile or full account",
    detailBody:
      "Top-tier 4K Dolby, available worldwide. Dedicated Profile ¥168/yr — your own profile with a PIN lock and no peak-time queues. Full account ¥588/yr — up to 5 profiles, ideal for families or long-term multi-user use.",
    orderTitle: "Netflix · 4K Dolby plan",
    orderBody: "Enter your contact details and pay via Alipay. Once you submit, our team will reach out within 30 minutes.",
  },
  disney: {
    title: "Disney+",
    subtitle: "Global 4K Dolby Profile / full account",
    price: "From ¥108/yr",
    cycle: "1 yr",
    shortIntro: "Top 4K Dolby tier — Dedicated Profile or full account",
    highlights: ["4K Dolby", "Worldwide", "Full account"],
    detailTitle: "Disney+'s top 4K Dolby tier — Profile or full account",
    detailBody:
      "Top-tier 4K Dolby, available worldwide. Dedicated Profile ¥108/yr — your own private spot, kept separate from others. Full account ¥588/yr — up to 7 profiles, great for family sharing and long-term use; every order includes after-sales support.",
    orderTitle: "Disney+ · 4K Dolby plan",
    orderBody: "Enter your contact details and pay via Alipay. Once you submit, our team will reach out within 30 minutes.",
  },
  max: {
    title: "HBO Max",
    subtitle: "Global 4K Dolby Profile / full account",
    price: "From ¥148/yr",
    cycle: "1 yr",
    shortIntro: "Top 4K Dolby tier — Dedicated Profile or full account",
    highlights: ["4K Dolby", "Worldwide", "Full account"],
    detailTitle: "HBO Max's top 4K Dolby tier — Profile or full account",
    detailBody:
      "Top-tier 4K Dolby, available worldwide. Dedicated Profile ¥148/yr — your own private spot, kept separate from others. Full account ¥588/yr — up to 5 profiles, ideal for film-loving families and stable multi-user use.",
    orderTitle: "HBO Max · 4K Dolby plan",
    orderBody: "Enter your contact details and pay via Alipay. Once you submit, our team will reach out within 30 minutes.",
  },
  rocket: {
    title: "VPN",
    subtitle: "Real-traffic plans & multi-node speed",
    price: "From ¥128/yr",
    cycle: "1 yr",
    shortIntro: "Premium data centers, multi-line up to 5 Gbps, monthly real traffic — unblocks streaming / AI / social",
    highlights: ["Real-traffic plans", "Fast multi-node", "Encrypted, no logs"],
    detailTitle: "Premium data centers, multi-line — real-traffic plans from ¥128/yr",
    detailBody:
      "Premium VPS across Hong Kong, Japan, Taiwan, Korea, Singapore, the US, UK, Germany, France and more, reaching up to 5 Gbps with no congestion at peak. Unblocks all major streaming / AI / social apps, fully encrypted with no logs, maintained 24/7. Choose Standard ¥128/yr (50 GB/mo), Plus ¥198/yr (100 GB/mo), Premium ¥398/yr (200 GB/mo) or Unlimited ¥698/yr (unlimited). A ¥5 / 10 GB trial is also available.",
    orderTitle: "VPN · Alipay QR payment",
    orderBody: "After paying, tap \"I've paid\" to submit. Your subscription link is generated once the order is submitted.",
  },
  ai: {
    title: "AI Membership",
    subtitle: "ChatGPT & Claude official plans",
    price: "From ¥198/3 mo",
    cycle: "3 months",
    shortIntro: "Official ChatGPT and Claude memberships — direct official top-up, private account, after-sales included",
    highlights: ["Official top-up", "Private account", "After-sales included"],
    detailTitle: "Official ChatGPT / Claude memberships, topped up through official channels",
    detailBody:
      "Memberships topped up directly through official channels — private, non-shared accounts that stay stable after activation, with full ChatGPT and Claude membership features. Choose GPT Plus ¥198, GPT 5x Pro ¥998, GPT 20x Pro ¥1888, Claude Pro ¥198, Claude 5x Max ¥998 or Claude 20x Max ¥1888 (all 3 months). Our team reaches out within 30 minutes after you order, with full after-sales support.",
    orderTitle: "AI Membership · choose a plan",
    orderBody: "Enter your email and contact details and pay via Alipay. Once you submit, our team will reach out within 30 minutes.",
  },
  "proxy-pay": {
    title: "Global Proxy Pay",
    subtitle: "Manual payment for overseas websites",
    price: "From 30%",
    cycle: "Custom quote",
    shortIntro: "Proxy payment for overseas websites and platforms; mainland China excluded",
    highlights: ["Overseas platforms", "Manual review", "Pay after quote"],
    detailTitle: "Send your payment request and pay only after receiving a quote",
    detailBody: "Enter your email, website link, listed price and contact. Our team verifies the platform and item, then emails a secure payment link with the quote. Mainland China websites are not supported.",
    orderTitle: "Global Proxy Pay · custom quote",
    orderBody: "Submit your request and wait for a quote. No upfront payment is required.",
  },
};

export const PRODUCT_PLAN_EN = {
  spotify: {
    member: { label: "Family member", desc: "Premium-region family plan, one member seat" },
    individual: { label: "Individual", desc: "Premium-region individual plan, private use" },
    duo: { label: "Duo", desc: "Invite 1 account to use free" },
    family: { label: "Family", desc: "Invite 5 accounts to use free" },
  },
  netflix: {
    seat: { label: "Dedicated Profile", desc: "4K Dolby private profile, lockable" },
    full: { label: "Full account", desc: "Up to 5 profiles / seats" },
  },
  disney: {
    seat: { label: "Dedicated Profile", desc: "4K Dolby private profile, kept separate" },
    full: { label: "Full account", desc: "Up to 7 profiles / seats" },
  },
  max: {
    seat: { label: "Dedicated Profile", desc: "4K Dolby private profile, with support" },
    full: { label: "Full account", desc: "Up to 5 profiles / seats" },
  },
  rocket: {
    basic: { label: "Standard", desc: "50 GB/mo real traffic" },
    pro: { label: "Plus", desc: "100 GB/mo real traffic" },
    luxury: { label: "Premium", desc: "200 GB/mo real traffic" },
    unlimited: { label: "Unlimited", desc: "Unlimited traffic" },
    trial: { label: "Trial 10 GB · ¥5", desc: "10 GB trial traffic", unit: "once", cycle: "once" },
  },
  ai: {
    "gpt-plus": { label: "GPT Plus", desc: "ChatGPT Plus official membership · 3 months", unit: "3 months" },
    "gpt-pro": { label: "GPT 5x Pro", desc: "ChatGPT Pro 5x higher limits · 3 months", unit: "3 months" },
    "gpt-20x-pro": { label: "GPT 20x Pro", desc: "ChatGPT Pro 20x much higher limits · 3 months", unit: "3 months" },
    "claude-pro": { label: "Claude Pro", desc: "Claude Pro official membership · 3 months", unit: "3 months" },
    "claude-max": { label: "Claude 5x Max", desc: "Claude Max 5x higher limits · 3 months", unit: "3 months" },
    "claude-20x-max": { label: "Claude 20x Max", desc: "Claude Max 20x much higher limits · 3 months", unit: "3 months" },
  },
};

export function localizeProduct(product, locale) {
  if (locale !== "en" || !product) return product;
  const en = PRODUCT_EN[product.key];
  return en ? { ...product, ...en } : product;
}

export function localizePlan(productKey, plan, locale) {
  if (locale !== "en" || !plan) return plan;
  const en = PRODUCT_PLAN_EN[productKey]?.[plan.id];
  return en ? { ...plan, ...en } : plan;
}

export function getRocketPlan(planId) {
  return getProductPlan("rocket", planId);
}

export function rocketPlanLabel(planId) {
  return getRocketPlan(planId).label;
}

export function hasProductPlans(productKey) {
  return Boolean(PRODUCT_PLANS[productKey]);
}

export function getDefaultProductPlan(productKey) {
  return DEFAULT_PRODUCT_PLANS[productKey] || "";
}

export function isProductPlan(productKey, planId) {
  const plans = PRODUCT_PLANS[productKey];
  if (!plans || !planId) return false;
  const aliases = productKey === "rocket" ? { single: "basic" } : {};
  const id = aliases[planId] || planId;
  return Boolean(plans[id]);
}

export function getProductPlan(productKey, planId) {
  const plans = PRODUCT_PLANS[productKey];
  if (!plans) return null;
  const aliases = productKey === "rocket" ? { single: "basic" } : {};
  const ov = ovProduct(productKey);
  const defId = (ov && ov.defaultPlan) || getDefaultProductPlan(productKey);
  let id = aliases[planId] || planId || defId;
  // 覆盖加载后:被下架(不在 activePlanIds)的规格回退到默认规格
  if (ov && id && !ov.activePlanIds.has(id)) id = defId;
  const base = plans[id] || plans[getDefaultProductPlan(productKey)] || Object.values(plans)[0] || null;
  if (!base) return null;
  const po = ov && ov.plans[base.id];
  if (!po) return base;
  return {
    ...base,
    amount: Number.isFinite(po.amount) ? po.amount : base.amount,
    label: po.label || base.label,
    desc: po.desc != null ? po.desc : base.desc,
    cycle: po.cycle || base.cycle,
    unit: po.cycle || base.unit,
    soldOut: !!po.soldOut,
  };
}

export function getProductPlanOptions(productKey) {
  const plans = PRODUCT_PLANS[productKey] || {};
  const ov = ovProduct(productKey);
  if (!ov) return Object.values(plans);
  // 仅返回上架规格(后台顺序),字段以覆盖为准
  return Object.keys(ov.plans).map((id) => {
    const base = plans[id] || { id };
    const po = ov.plans[id];
    return {
      ...base, id,
      amount: Number.isFinite(po.amount) ? po.amount : base.amount,
      label: po.label || base.label,
      desc: po.desc != null ? po.desc : base.desc,
      cycle: po.cycle || base.cycle,
      unit: po.cycle || base.unit,
      soldOut: !!po.soldOut,
    };
  });
}

// 某规格是否售罄(后台库存=0)。未加载覆盖时一律 false(不误报)。
export function isPlanSoldOut(productKey, planId) {
  const ov = ovProduct(productKey);
  if (!ov) return false;
  return Boolean(ov.plans[planId]?.soldOut);
}
// 某商品是否全规格售罄
export function isProductSoldOut(productKey) {
  const ov = ovProduct(productKey);
  if (!ov) return false;
  const ids = Object.keys(ov.plans);
  return ids.length > 0 && ids.every((id) => ov.plans[id].soldOut);
}

export function productItemAmount(product, plan) {
  if (!product) return 0;
  if (product.quoteOnly || product.key === "proxy-pay") return 0;
  if (hasProductPlans(product.key)) return getProductPlan(product.key, plan)?.amount || product.amount;
  return product.amount;
}

export function copyText(text) {
  if (typeof window === "undefined") return;
  const fallbackCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

export function money(amount) {
  return "¥" + Number(amount || 0).toFixed(0);
}

export function blankCheckoutForm() {
  return { email: "", contact: "", remark: "", fields: {} };
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function validUsername(value) {
  return /^[A-Za-z0-9]{4,10}$/.test(String(value || "").trim());
}

export function productNeedsAccountPassword(product) {
  return product?.key === "spotify";
}

export function bundleDiscountRate(itemCount) {
  const b = SITE_SETTINGS?.bundle || {};
  const t3 = Number.isFinite(b.tier3Rate) ? b.tier3Rate : 0.10;
  const t2 = Number.isFinite(b.tier2Rate) ? b.tier2Rate : 0.05;
  if (itemCount >= 3) return t3;
  if (itemCount >= 2) return t2;
  return 0;
}
function siteUsdtDiscount() {
  const d = Number(SITE_SETTINGS?.usdt?.discount);
  return Number.isFinite(d) && d > 0 ? d : USDT_DISCOUNT;
}

export function bundleDiscountLabel(itemCount, locale) {
  const rate = bundleDiscountRate(itemCount);
  if (rate <= 0) return "";
  const dl = discountLabel(rate, locale);
  if (itemCount >= 3) return locale === "en" ? `${dl} (3+)` : `3 件起 ${dl}`;
  if (itemCount >= 2) return locale === "en" ? `${dl} (2)` : `2 件 ${dl}`;
  return "";
}
// 组合优惠某档位的折扣文案(给升级提示用),itemCount=2/3
export function bundleTierLabel(itemCount, locale) {
  return discountLabel(bundleDiscountRate(itemCount), locale);
}
// USDT 支付折扣文案("9 折" / "10% off"),随设置变。
// 注:usdt.discount 是「实付倍率」(0.9=付9成),换算成 amount-off = 1-0.9 才是折扣额。
export function usdtDiscountLabel(locale) {
  return discountLabel(1 - siteUsdtDiscount(), locale);
}

export function cartSubtotalCny(items, planMap = {}) {
  return items.reduce((sum, p) => sum + productItemAmount(p, planMap?.[p?.key]), 0);
}

export function cartFinalCny(items, planMap = {}) {
  const subtotal = cartSubtotalCny(items, planMap);
  const rate = bundleDiscountRate(items.length);
  return Math.round(subtotal * (1 - rate));
}

export function cartFinalUsdt(items, planMap = {}) {
  const cny = cartFinalCny(items, planMap);
  return Math.round((cny * siteUsdtDiscount() / USDT_RATE) * 100) / 100;
}

export function usdtAmount(rmb) {
  return Math.round((Number(rmb || 0) * siteUsdtDiscount() / USDT_RATE) * 100) / 100;
}

export function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

const CART_STORAGE_KEY = "liumeiti:cart:v1";
const CART_PLAN_STORAGE_KEY = "liumeiti:cart-plans:v1";
const CART_EVENT = "liumeiti:cart-update";

function loadCart() {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(CART_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set(PRODUCTS.map((p) => p.key));
    return parsed.filter((k) => typeof k === "string" && valid.has(k));
  } catch {
    return [];
  }
}

function emitCartUpdate() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CART_EVENT));
}

function saveCart(cart, emit = true) {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    if (emit) emitCartUpdate();
  } catch {}
}

function loadCartPlans() {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(CART_PLAN_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    const next = {};
    Object.keys(PRODUCT_PLANS).forEach((key) => {
      const value = parsed[key];
      if (!value) return;
      const plan = getProductPlan(key, value);
      if (plan && isProductPlan(key, plan.id)) next[key] = plan.id;
    });
    return next;
  } catch {
    return {};
  }
}

function saveCartPlans(plans, emit = true) {
  try {
    localStorage.setItem(CART_PLAN_STORAGE_KEY, JSON.stringify(plans || {}));
    if (emit) emitCartUpdate();
  } catch {}
}

function saveCartBundle(cart, plans) {
  saveCart(cart, false);
  saveCartPlans(plans, false);
  emitCartUpdate();
}

export function useCart() {
  const [cart, setCartState] = useState([]);
  const [cartPlans, setCartPlansState] = useState({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCartState(loadCart());
    setCartPlansState(loadCartPlans());
    setHydrated(true);
    const sync = () => {
      setCartState(loadCart());
      setCartPlansState(loadCartPlans());
    };
    window.addEventListener(CART_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CART_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  function setCartPlan(key, planId) {
    if (!hasProductPlans(key)) return;
    const plan = getProductPlan(key, planId);
    if (!plan) return;
    const next = { ...loadCartPlans(), [key]: plan.id };
    setCartPlansState(next);
    saveCartPlans(next);
  }

  function addToCart(key, options = {}) {
    setCartState((current) => {
      const isQuoteOnly = key === "proxy-pay";
      const base = isQuoteOnly ? [] : current.filter((item) => item !== "proxy-pay");
      const next = base.includes(key) ? base : [...base, key];
      const nextPlans = isQuoteOnly ? {} : { ...loadCartPlans() };
      delete nextPlans["proxy-pay"];
      if (hasProductPlans(key)) {
        const plan = getProductPlan(key, options.plan || nextPlans[key] || getDefaultProductPlan(key));
        if (plan) nextPlans[key] = plan.id;
      }
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function removeFromCart(key) {
    setCartState((current) => {
      const next = current.filter((k) => k !== key);
      const nextPlans = { ...loadCartPlans() };
      if (hasProductPlans(key)) delete nextPlans[key];
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function toggleCart(key, options = {}) {
    setCartState((current) => {
      const removing = current.includes(key);
      const isQuoteOnly = key === "proxy-pay";
      const base = isQuoteOnly ? [] : current.filter((item) => item !== "proxy-pay");
      const next = removing ? current.filter((k) => k !== key) : [...base, key];
      const nextPlans = isQuoteOnly ? {} : { ...loadCartPlans() };
      delete nextPlans["proxy-pay"];
      if (hasProductPlans(key)) {
        if (removing) {
          delete nextPlans[key];
        } else {
          const plan = getProductPlan(key, options.plan || getDefaultProductPlan(key));
          if (plan) nextPlans[key] = plan.id;
        }
      }
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function replaceCart(keys) {
    const valid = new Set(PRODUCTS.map((p) => p.key));
    const seen = new Set();
    let next = (Array.isArray(keys) ? keys : [])
      .filter((key) => typeof key === "string" && valid.has(key) && !seen.has(key) && seen.add(key));
    if (next.includes("proxy-pay")) next = ["proxy-pay"];
    const currentPlans = loadCartPlans();
    const nextPlans = {};
    next.forEach((key) => {
      if (!hasProductPlans(key)) return;
      const plan = getProductPlan(key, currentPlans[key] || getDefaultProductPlan(key));
      if (plan) nextPlans[key] = plan.id;
    });
    setCartState(next);
    setCartPlansState(nextPlans);
    saveCartBundle(next, nextPlans);
  }

  function clearCart() {
    setCartState([]);
    setCartPlansState({});
    saveCartBundle([], {});
  }

  return { cart, cartPlans, hydrated, addToCart, removeFromCart, toggleCart, replaceCart, clearCart, setCartPlan };
}
