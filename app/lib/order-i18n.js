// Server-safe order-label localization (NO "use client" — imported by API routes).
// Orders store the service key + plan id, so English labels are reconstructed at
// read time. Chinese stays the source of truth in storage.

const PRODUCT_TITLE_EN = {
  spotify: "Spotify",
  netflix: "Netflix",
  disney: "Disney+",
  max: "HBO Max",
  rocket: "VPN",
  ai: "AI Membership",
};

const PLAN_LABEL_EN = {
  spotify: { member: "Family member", individual: "Individual", duo: "Duo", family: "Family" },
  netflix: { seat: "Dedicated Profile", full: "Full account" },
  disney: { seat: "Dedicated Profile", full: "Full account" },
  max: { seat: "Dedicated Profile", full: "Full account" },
  rocket: {
    basic: "Standard",
    pro: "Plus",
    luxury: "Premium",
    unlimited: "Unlimited",
    trial: "Trial 10 GB · ¥5",
  },
  ai: {
    "gpt-plus": "GPT Plus",
    "gpt-pro": "GPT 5x Pro",
    "gpt-20x-pro": "GPT 20x Pro",
    "claude-pro": "Claude Pro",
    "claude-max": "Claude 5x Max",
    "claude-20x-max": "Claude 20x Max",
  },
};

const CYCLE_EN = { "1年": "1 yr", "次": "once", "三个月": "3 months" };

export function localizeOrderItemLabel(service, plan, fallbackLabel, locale) {
  if (locale !== "en") return fallbackLabel;
  const title = PRODUCT_TITLE_EN[service];
  if (!title) return fallbackLabel || "";
  const planEn = plan ? PLAN_LABEL_EN[service]?.[plan] : "";
  return planEn ? `${title} · ${planEn}` : title;
}

export function localizeCycle(cycle, locale) {
  if (locale !== "en" || !cycle) return cycle;
  return CYCLE_EN[cycle] || cycle;
}

export function localeFromCookieValue(value) {
  return value === "en" ? "en" : "zh";
}
