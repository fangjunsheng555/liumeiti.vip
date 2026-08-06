import { getLocalizedServicePlanCopy, localizeServicePlanCycle } from "./service-data.js";
import { localizeCatalogDisplayPrice } from "../lib/catalog-price.js";

// Apply runtime catalog fields without letting Chinese copy overwrite the
// curated English translation. Product images and authoritative prices are
// locale-independent and therefore apply in both languages.
export function applyCatalogToService(service, catProd, locale, soldOutMap = {}) {
  if (!catProd) return service;
  const activePlans = (catProd.plans || []).filter((plan) => plan.active !== false);
  const next = { ...service };
  if (catProd.image) next.image = catProd.image;
  if (locale !== "en") {
    if (catProd.title) next.shortTitle = catProd.title;
    if (catProd.subtitle) next.subtitle = catProd.subtitle;
    if (catProd.detailTitle) next.title = catProd.detailTitle;
    if (catProd.detailBody || catProd.shortIntro) next.description = catProd.detailBody || catProd.shortIntro;
    if (Array.isArray(catProd.highlights)) next.highlights = catProd.highlights;
  }
  if (catProd.priceText) {
    next.price = locale === "en"
      ? localizeCatalogDisplayPrice(catProd.priceText, "en", next.price)
      : catProd.priceText;
  }
  if (catProd.quoteOnly || catProd.key === "proxy-pay") return next;
  if (Array.isArray(service.plans) && activePlans.length) {
    next.plans = activePlans.map((plan) => {
      const copy = getLocalizedServicePlanCopy(service.slug, plan.id, locale, {
        label: plan.label,
        description: plan.desc,
      });
      const cycle = localizeServicePlanCycle(plan.cycle, locale);
      return [copy.name, `¥${plan.amount}/${cycle}`, copy.description, !!soldOutMap[`${catProd.key}:${plan.id}`]];
    });
    next.planIds = activePlans.map((plan) => plan.id);
  }
  return next;
}

export function serviceJsonLdImage(image) {
  const value = String(image || "");
  return /^https:\/\//i.test(value) ? value : `https://www.liumeiti.vip${value}`;
}

export function serviceCatalogLowPrice(service, catProd) {
  const amounts = (catProd?.plans || [])
    .filter((plan) => plan?.active !== false)
    .map((plan) => Number(plan?.amount))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (amounts.length) return String(Math.min(...amounts));
  return String(service?.plans?.[0]?.[1] || service?.price || "").replace(/[^\d.]/g, "") || "0";
}
