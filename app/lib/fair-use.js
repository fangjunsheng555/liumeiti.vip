// The unlimited node plan has no traffic cap, but it is sold for one person's
// own devices. Wherever the plan is described — the shop picker, the service
// page, checkout, the buying guide — the same note explains the fair-use
// boundary, so a customer never meets it for the first time after paying.

export const UNLIMITED_NODE_PRODUCT_KEY = "rocket";
export const UNLIMITED_NODE_PLAN_ID = "unlimited";

const NOTE = {
  zh: "需遵守防滥用原则，如大量向不同用户共享订阅、长时间大速率入站等违反公平使用原则的行为，可能导致被限制同时在线设备数量/带宽速率。",
  en: "Subject to our anti-abuse policy: sharing the subscription with many different users, sustained high-rate inbound traffic and other breaches of fair use may result in limits on concurrent devices and/or bandwidth.",
};

const TITLE = {
  zh: "无限套餐提示",
  en: "Unlimited plan note",
};

export function unlimitedFairUseNote(locale) {
  return locale === "en" ? NOTE.en : NOTE.zh;
}

export function unlimitedFairUseTitle(locale) {
  return locale === "en" ? TITLE.en : TITLE.zh;
}

export function isUnlimitedNodePlan(productKey, planId) {
  return productKey === UNLIMITED_NODE_PRODUCT_KEY && planId === UNLIMITED_NODE_PLAN_ID;
}
