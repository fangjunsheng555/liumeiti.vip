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
    autoConfirm: false,   // TRON 链上自动确认;完成真实小额测试后由后台开启
  },
  // 组合优惠档位
  bundle: { tier2Rate: 0.05, tier3Rate: 0.10 },
  // 收款二维码(支付宝 + USDT 都可换图)
  payment: { alipayQr: "/payment/alipay.jpg", usdtQr: "/payment/usdt.png" },
  // Telegram 通知开关(token/chatId 仍在 env,不在前端暴露)
  notify: { telegramEnabled: true, telegramWithdrawEnabled: true },
};

// 合并工具:把覆盖深合并到默认上(只接受已知字段,防注入;非法值回退默认)。
const SETTINGS_TEXT_LIMITS = {
  "support.qq.value": 100,
  "support.qq.href": 500,
  "support.whatsapp.value": 100,
  "support.whatsapp.href": 500,
  "support.telegram.value": 100,
  "support.telegram.href": 500,
  "support.hours": 80,
  "brand.name": 100,
  "brand.nameEn": 100,
  "brand.siteTitle": 200,
  "brand.siteTitleEn": 200,
  "footer.brand": 160,
  "footer.brandEn": 160,
  "footer.address": 300,
  "footer.addressEn": 300,
  "footer.copyright": 300,
};

const SETTINGS_SECTIONS = ["support", "brand", "footer", "usdt", "bundle", "payment", "notify"];
const MAX_IMAGE_DATA_URL_LENGTH = 500000;
const MAX_IMAGE_BINARY_BYTES = 360000;

function objectAt(value, key) {
  const next = value?.[key];
  return next && typeof next === "object" && !Array.isArray(next) ? next : null;
}

function pathValue(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function validSupportHref(value, kind) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return false;
  const source = value.trim();
  const webLink = /^https?:\/\//i.test(source);
  const qqLink = kind === "qq" && /^mqq:\/\//i.test(source);
  if (!webLink && !qqLink) return false;
  try {
    const parsed = new URL(source);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
    return kind === "qq" && parsed.protocol === "mqq:";
  } catch {
    return false;
  }
}

function validImageSource(value) {
  if (typeof value !== "string") return false;
  const source = value.trim();
  if (!source || source.length > MAX_IMAGE_DATA_URL_LENGTH) return false;
  if (source.startsWith("/") && !source.startsWith("//")) {
    return !/[\\\u0000-\u001f\u007f]/.test(source);
  }
  if (source.startsWith("data:")) {
    const match = source.match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i);
    if (!match || match[2].length % 4 !== 0) return false;
    const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
    return ((match[2].length * 3) / 4) - padding <= MAX_IMAGE_BINARY_BYTES;
  }
  try {
    const parsed = new URL(source);
    return /^https:\/\//i.test(source) && parsed.protocol === "https:"
      && Boolean(parsed.hostname) && !parsed.username && !parsed.password && source.length <= 2048;
  } catch {
    return false;
  }
}

function decimalNumber(value, { min, max, decimals = 4, allowEmpty = false } = {}) {
  if (allowEmpty && (value === "" || value == null)) return { ok: true, value: "" };
  if (typeof value !== "number" && typeof value !== "string") return { ok: false };
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return { ok: false };
  const fraction = text.includes(".") ? text.split(".")[1] : "";
  if (fraction.length > decimals) return { ok: false };
  const number = Number(text);
  if (!Number.isFinite(number) || number < min || number > max) return { ok: false };
  return { ok: true, value: number };
}

// The public merge remains deliberately fail-open. Admin writes use this
// complete-schema validator so malformed values can never be saved as defaults.
export function validateSettingsSubmission(input) {
  const fieldErrors = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, fieldErrors: { settings: "请提交完整的站点设置" } };
  }
  for (const section of SETTINGS_SECTIONS) {
    if (!objectAt(input, section)) fieldErrors[section] = "设置分组缺失或格式错误";
  }
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };

  const settings = {
    support: { qq: {}, whatsapp: {}, telegram: {}, hours: "" },
    brand: {}, footer: {}, usdt: {}, bundle: {}, payment: {}, notify: {},
  };
  for (const kind of ["qq", "whatsapp", "telegram"]) {
    if (!objectAt(input.support, kind)) fieldErrors[`support.${kind}`] = "联系方式格式错误";
  }
  for (const [path, limit] of Object.entries(SETTINGS_TEXT_LIMITS)) {
    const value = pathValue(input, path);
    if (typeof value !== "string" || !value.trim() || value.trim().length > limit
      || /[\u0000-\u001f\u007f]/.test(value)) {
      fieldErrors[path] = `请输入 1-${limit} 个有效字符`;
      continue;
    }
    const [section, key, child] = path.split(".");
    if (child) settings[section][key][child] = value.trim();
    else settings[section][key] = value.trim();
  }
  for (const kind of ["qq", "whatsapp", "telegram"]) {
    const href = input.support?.[kind]?.href;
    if (typeof href === "string" && href.trim() && !validSupportHref(href, kind)) {
      fieldErrors[`support.${kind}.href`] = kind === "qq"
        ? "仅支持 http、https 或 mqq 链接"
        : "仅支持 http 或 https 链接";
    }
  }

  const address = input.usdt.address;
  if (typeof address !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim())) {
    fieldErrors["usdt.address"] = "请输入有效的 TRON TRC20 地址";
  } else settings.usdt.address = address.trim();

  const discount = decimalNumber(input.usdt.discount, { min: 0.1, max: 1 });
  if (!discount.ok) fieldErrors["usdt.discount"] = "请输入 0.1-1 之间、最多 4 位小数的数值";
  else settings.usdt.discount = discount.value;
  const rate = decimalNumber(input.usdt.rateOverride, { min: 0.1, max: 1000, allowEmpty: true });
  if (!rate.ok) fieldErrors["usdt.rateOverride"] = "请留空或输入 0.1-1000 之间、最多 4 位小数的汇率";
  else settings.usdt.rateOverride = rate.value === "" ? "" : String(rate.value);
  if (typeof input.usdt.autoConfirm !== "boolean") fieldErrors["usdt.autoConfirm"] = "请选择开启或关闭";
  else settings.usdt.autoConfirm = input.usdt.autoConfirm;

  const tier2 = decimalNumber(input.bundle.tier2Rate, { min: 0, max: 0.9 });
  const tier3 = decimalNumber(input.bundle.tier3Rate, { min: 0, max: 0.9 });
  if (!tier2.ok) fieldErrors["bundle.tier2Rate"] = "请输入 0-0.9 之间、最多 4 位小数的折扣率";
  else settings.bundle.tier2Rate = tier2.value;
  if (!tier3.ok) fieldErrors["bundle.tier3Rate"] = "请输入 0-0.9 之间、最多 4 位小数的折扣率";
  else settings.bundle.tier3Rate = tier3.value;
  if (tier2.ok && tier3.ok && tier3.value < tier2.value) {
    fieldErrors["bundle.tier3Rate"] = "满 3 件优惠不能低于满 2 件优惠";
  }

  for (const key of ["alipayQr", "usdtQr"]) {
    if (!validImageSource(input.payment[key])) {
      fieldErrors[`payment.${key}`] = "仅支持站内路径、HTTPS 图片或受限的 PNG/JPEG/WebP 数据图片";
    } else settings.payment[key] = input.payment[key].trim();
  }
  for (const key of ["telegramEnabled", "telegramWithdrawEnabled"]) {
    if (typeof input.notify[key] !== "boolean") fieldErrors[`notify.${key}`] = "请选择开启或关闭";
    else settings.notify[key] = input.notify[key];
  }

  return Object.keys(fieldErrors).length
    ? { ok: false, fieldErrors }
    : { ok: true, settings };
}

export function mergeSettings(overrides) {
  const d = SETTINGS_DEFAULTS;
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const str = (v, fb) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const num = (v, fb, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : fb; };
  const img = (v, fb) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s || s.length > 500000) return fb;
    return s;
  };
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
      autoConfirm: typeof o.usdt?.autoConfirm === "boolean" ? o.usdt.autoConfirm : d.usdt.autoConfirm,
    },
    bundle: {
      tier2Rate: num(o.bundle?.tier2Rate, d.bundle.tier2Rate, 0, 0.9),
      tier3Rate: num(o.bundle?.tier3Rate, d.bundle.tier3Rate, 0, 0.9),
    },
    payment: {
      // 支持路径/URL/dataURL(后台直接上传的压缩图);超大值拒收回退默认,防撑爆存储。
      alipayQr: img(o.payment?.alipayQr, d.payment.alipayQr),
      usdtQr: img(o.payment?.usdtQr, d.payment.usdtQr),
    },
    notify: {
      telegramEnabled: typeof o.notify?.telegramEnabled === "boolean" ? o.notify.telegramEnabled : d.notify.telegramEnabled,
      telegramWithdrawEnabled: typeof o.notify?.telegramWithdrawEnabled === "boolean" ? o.notify.telegramWithdrawEnabled : d.notify.telegramWithdrawEnabled,
    },
  };
}

// 折扣文案:把折扣率转成展示文案("9 折" / "10% off")。rate 0.1 = 9折;<=0 返回空。
// 全站凡是显示折扣的文案都用它,改设置后文字随之变。
export function discountLabel(rate, locale) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return "";
  const zhe = (10 * (1 - r)).toFixed(1).replace(/\.0$/, "");
  const pct = Math.round(r * 100);
  return locale === "en" ? `${pct}% off` : `${zhe} 折`;
}

// 客服文案(纯文本 / HTML),供邮件与站点共用,基于合并后的 support。
export function supportText(support, locale) {
  const body = `QQ ${support.qq.value} / WhatsApp ${support.whatsapp.value} / Telegram ${support.telegram.value}`;
  return locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
}
export function supportHtml(support, locale) {
  const escape = (value) => String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const link = (label, c) => `<a href="${escape(c.href)}" target="_blank" rel="noopener noreferrer" style="color:#0f766e;font-weight:700;text-decoration:underline;white-space:nowrap;">${label} ${escape(c.value)}</a>`;
  const body = `${link("QQ", support.qq)} &nbsp;/&nbsp; ${link("WhatsApp", support.whatsapp)} &nbsp;/&nbsp; ${link("Telegram", support.telegram)}`;
  const copy = locale === "en" ? `Reach our online support via ${body}` : `请通过 ${body} 联系在线客服`;
  return `<span data-lm-support-contacts="1">${copy}</span>`;
}
