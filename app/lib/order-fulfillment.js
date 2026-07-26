import { orderExpirySummary } from "./order-expiry.js";

export const THIRD_PARTY_NOTICE_ZH = "核查您的订单来自于第三方平台，请在该平台确认收货，方便的话给予真实评价！";
export const THIRD_PARTY_NOTICE_EN = "We confirmed that this order originated from a third-party platform. Please confirm receipt there and, if convenient, leave an honest review.";

const REGION_LABELS = {
  europe: ["欧洲区", "Europe"],
  us: ["美国区", "United States"],
  japan: ["日本区", "Japan"],
  uk: ["英国区", "United Kingdom"],
  other: ["其他地区", "the selected region"],
};

const SPOTIFY_OUTCOMES = {
  family_joined: ["Spotify 家庭成员订阅已开通", "Your Spotify Family Member subscription is active"],
  individual_activated: ["Spotify 个人订阅已开通", "Your Spotify Individual subscription is active"],
  duo_activated: ["Spotify 双人订阅已开通", "Your Spotify Duo subscription is active"],
  family_activated: ["Spotify 家庭套餐已开通", "Your Spotify Family subscription is active"],
  account_provided: ["Spotify 订阅账号已开通", "Your Spotify account and subscription are ready"],
  activated: ["Spotify 订阅已开通", "Your Spotify subscription is active"],
};

function text(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function boolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function defaultSpotifyOutcome(item) {
  const plan = text(item?.plan || item?.rocketPlan, 40);
  if (plan === "member") return "family_joined";
  if (plan === "individual") return "individual_activated";
  if (plan === "duo") return "duo_activated";
  if (plan === "family") return "family_activated";
  return "activated";
}

export function normalizeFulfillment(service, input = {}, item = {}) {
  const source = input && typeof input === "object" ? input : {};
  if (service === "spotify") {
    const outcome = Object.prototype.hasOwnProperty.call(SPOTIFY_OUTCOMES, source.outcome)
      ? source.outcome
      : defaultSpotifyOutcome(item);
    return {
      region: Object.prototype.hasOwnProperty.call(REGION_LABELS, source.region) ? source.region : "",
      outcome,
      emailConfirmation: boolean(source.emailConfirmation),
    };
  }
  if (["netflix", "disney", "max"].includes(service)) {
    return {
      profileNumber: text(source.profileNumber, 20),
      pin: text(source.pin, 30),
      loginHelp: boolean(source.loginHelp, true),
    };
  }
  if (service === "rocket") {
    return {
      clientGuide: boolean(source.clientGuide, true),
    };
  }
  if (service === "ai") {
    return {
      loginMethod: ["email", "google", "provided"].includes(source.loginMethod)
        ? source.loginMethod
        : "provided",
      twoFactorInstruction: boolean(source.twoFactorInstruction),
    };
  }
  return {};
}

export function thirdPartyNoticeForLocale(locale) {
  return locale === "en" ? THIRD_PARTY_NOTICE_EN : THIRD_PARTY_NOTICE_ZH;
}

export function hasThirdPartyNotice(value) {
  const source = String(value || "");
  return source.includes(THIRD_PARTY_NOTICE_ZH) || source.includes(THIRD_PARTY_NOTICE_EN);
}

export function applyThirdPartyNotice(value, enabled, locale = "zh") {
  let message = String(value || "");
  for (const notice of [THIRD_PARTY_NOTICE_ZH, THIRD_PARTY_NOTICE_EN]) {
    message = message.split(notice).join("");
  }
  message = message.replace(/\n{3,}/g, "\n\n").trim();
  if (!enabled) return message;
  const notice = thirdPartyNoticeForLocale(locale);
  return message ? `${message}\n\n${notice}` : notice;
}

function beijingDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function itemExpiry(order, item) {
  if (!order || !item) return null;
  const summary = orderExpirySummary({ ...order, items: [item] });
  return summary?.items?.[0] || null;
}

export function itemValidityLabel(order, item, locale = "zh") {
  const expiry = itemExpiry(order, item);
  if (expiry?.expiresAt) {
    const date = beijingDate(expiry.expiresAt);
    return locale === "en" ? `Valid until ${date}` : `有效期至 ${date}`;
  }
  const cycle = text(item?.cycle, 40);
  if (!cycle || /次|按单|报价|one[- ]?time/i.test(cycle)) {
    return locale === "en" ? "No fixed expiry" : "无固定有效期";
  }
  return locale === "en" ? `Validity: ${cycle}` : `有效期：${cycle}`;
}

function validitySentence(order, item, locale) {
  const label = itemValidityLabel(order, item, locale);
  if (label === "无固定有效期" || label === "No fixed expiry") return "";
  return locale === "en" ? `${label}.` : `${label}。`;
}

function credentialSentence(locale) {
  return locale === "en"
    ? "The login email and password are included with the order and can be viewed in the completion email or order details."
    : "账号与密码已随订单交付，可在完成邮件或订单详情中查看。";
}

function joinSentences(parts, locale) {
  return parts.filter(Boolean).join(locale === "en" ? " " : "");
}

function spotifyMessage(order, item, fulfillment, locale) {
  const en = locale === "en";
  const outcome = SPOTIFY_OUTCOMES[fulfillment.outcome] || SPOTIFY_OUTCOMES.activated;
  const region = REGION_LABELS[fulfillment.region];
  const parts = [en ? outcome[1] : outcome[0]];
  if (region) {
    parts[0] += en ? ` for ${region[1]}` : `，所属地区为${region[0]}`;
  }
  parts[0] += en ? "." : "。";
  const validity = validitySentence(order, item, locale);
  if (validity) parts.push(validity);
  parts.push(credentialSentence(locale));
  if (fulfillment.emailConfirmation) {
    parts.push(en
      ? "Spotify has sent a confirmation email to your inbox. Follow the instructions in that email to finish confirmation."
      : "Spotify 已向您的邮箱发送确认邮件，请按邮件提示完成确认。");
  }
  return joinSentences(parts, locale);
}

function profileServiceMessage(order, item, fulfillment, locale) {
  const en = locale === "en";
  const name = item.service === "max" ? "HBO Max" : item.service === "disney" ? "Disney+" : "Netflix";
  const fullAccount = item.plan === "full";
  const parts = [
    en ? `${name} is active.` : `${name} 已开通。`,
    credentialSentence(locale),
  ];
  if (fulfillment.profileNumber) {
    parts.push(en
      ? `Use profile ${fulfillment.profileNumber}.`
      : `请使用 ${fulfillment.profileNumber} 号用户档案。`);
  }
  if (fulfillment.pin) {
    parts.push(en ? `Profile PIN: ${fulfillment.pin}.` : `用户档案 PIN：${fulfillment.pin}。`);
  }
  if (fulfillment.loginHelp) {
    parts.push(en
      ? "If you cannot sign in, verify the account and password first. You can request after-sales support from the order details if the issue continues."
      : "如无法登录，请先核对账号与密码；仍有异常可从订单详情申请售后。");
  }
  if (fullAccount) {
    parts.push(en
      ? "This is a full-account plan, so you can manage its profiles as needed."
      : "本订单为整号规格，可按需管理账号内的用户档案。");
  } else {
    parts.push(en
      ? "Use only the assigned profile. Do not change the account details, password, or other profiles."
      : "请仅使用分配的用户档案，不要修改账号资料、密码或其他用户档案。");
  }
  const validity = validitySentence(order, item, locale);
  if (validity) parts.push(validity);
  return joinSentences(parts, locale);
}

function rocketMessage(order, item, fulfillment, locale) {
  const en = locale === "en";
  const parts = [en
    ? "The VPN subscription links are included with the order and can be copied from the completion email or order details."
    : "机场节点订阅链接已随订单交付，可在完成邮件或订单详情中复制。"];
  if (fulfillment.clientGuide) {
    parts.push(en
      ? "It supports Shadowrocket, Clash Meta and Clash Verge. Follow the VPN setup guide to import the subscription."
      : "支持 Shadowrocket、Clash Meta 和 Clash Verge，请按机场节点使用指南导入订阅。");
  }
  const validity = validitySentence(order, item, locale);
  if (validity) parts.push(validity);
  return joinSentences(parts, locale);
}

function aiMessage(order, item, fulfillment, locale) {
  const en = locale === "en";
  const plan = text(item?.planLabel || item?.label, 80);
  const parts = [en
    ? `${plan || "AI membership"} is active.`
    : `${plan || "AI 会员"}已开通。`];
  parts.push(credentialSentence(locale));
  if (fulfillment.loginMethod === "google") {
    parts.push(en ? "Select Google when signing in." : "登录时请选择 Google 登录。");
  } else if (fulfillment.loginMethod === "email") {
    parts.push(en ? "Select email when signing in." : "登录时请选择邮箱登录。");
  }
  if (fulfillment.twoFactorInstruction) {
    parts.push(en
      ? "If two-factor verification is requested, follow the instructions included with the order."
      : "如需二次验证，请按订单内说明操作。");
  }
  const validity = validitySentence(order, item, locale);
  if (validity) parts.push(validity);
  return joinSentences(parts, locale);
}

function genericMessage(order, item, locale) {
  const en = locale === "en";
  const label = text(item?.label, 80) || (en ? "Service" : "服务");
  const validity = validitySentence(order, item, locale);
  return en
    ? `${label} is ready.${validity ? ` ${validity}` : ""}`
    : `${label}已处理完成。${validity}`;
}

export function buildDeliveryMessage(order, items = order?.items || [], thirdPartyPlatformNotice = false) {
  const locale = order?.locale === "en" ? "en" : "zh";
  const messages = (Array.isArray(items) ? items : []).map((item) => {
    const fulfillment = normalizeFulfillment(item?.service, item?.fulfillment, item);
    if (item?.service === "spotify") return spotifyMessage(order, item, fulfillment, locale);
    if (["netflix", "disney", "max"].includes(item?.service)) {
      return profileServiceMessage(order, item, fulfillment, locale);
    }
    if (item?.service === "rocket") return rocketMessage(order, item, fulfillment, locale);
    if (item?.service === "ai") return aiMessage(order, item, fulfillment, locale);
    return genericMessage(order, item, locale);
  }).filter(Boolean);
  return applyThirdPartyNotice(messages.join("\n\n"), thirdPartyPlatformNotice, locale);
}
