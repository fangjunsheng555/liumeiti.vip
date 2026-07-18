const TRIAL_PLAN_PATTERN = /(?:trial|test|试用|测试|体验)/i;

function formatAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return amount.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function displayCycle(value) {
  const cycle = String(value || "").trim();
  if (/^1\s*年$/.test(cycle)) return "年";
  if (/^1\s*个月$/.test(cycle)) return "月";
  return cycle;
}

function englishCycle(value) {
  const cycle = String(value || "").trim();
  if (cycle === "年" || cycle === "1年") return "yr";
  if (cycle === "月" || cycle === "1个月") return "mo";
  if (cycle === "次") return "one-time";
  if (cycle === "三个月") return "3 mo";
  const months = cycle.match(/^(\d+)\s*个月$/);
  if (months) return `${months[1]} mo`;
  const years = cycle.match(/^(\d+)\s*年$/);
  if (years) return Number(years[1]) === 1 ? "yr" : `${years[1]} yr`;
  return cycle;
}

export function isCatalogStartingPlan(plan) {
  if (!plan || plan.active === false || plan.excludeFromStartingPrice === true) return false;
  const amount = Number(plan.amount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return !TRIAL_PLAN_PATTERN.test(`${plan.id || ""} ${plan.label || ""}`);
}

export function getCatalogStartingPlan(product) {
  const plans = Array.isArray(product?.plans) ? product.plans : [];
  return plans.reduce((lowest, plan) => {
    if (!isCatalogStartingPlan(plan)) return lowest;
    if (!lowest || Number(plan.amount) < Number(lowest.amount)) return plan;
    return lowest;
  }, null);
}

// Card prices are derived from active plan amounts. This prevents the editable
// display copy from drifting away from checkout and email prices.
export function getCatalogDisplayPrice(product) {
  const fallback = String(product?.priceText || product?.price || "").trim();
  if (!product || product.quoteOnly || product.key === "proxy-pay") return fallback;
  const startingPlan = getCatalogStartingPlan(product);
  if (!startingPlan) return fallback;
  const amount = formatAmount(startingPlan.amount);
  const cycle = displayCycle(startingPlan.cycle || product.cycle);
  return cycle ? `¥${amount}/${cycle}起` : `¥${amount}起`;
}

export function localizeCatalogDisplayPrice(priceText, locale, fallback = "") {
  const source = String(priceText || "").trim();
  if (locale !== "en" || !source) return source || String(fallback || "");

  const discount = source.match(/(\d+(?:\.\d+)?)\s*折/);
  if (discount) {
    const percent = Number(discount[1]) * 10;
    return Number.isFinite(percent) ? `From ${formatAmount(percent)}%` : String(fallback || source);
  }

  const price = source.match(/¥\s*([\d,.]+)(?:\s*\/\s*([^起]+))?/);
  if (!price) return String(fallback || source);
  const cycle = englishCycle(price[2]);
  return cycle ? `From ¥${price[1]}/${cycle}` : `From ¥${price[1]}`;
}
