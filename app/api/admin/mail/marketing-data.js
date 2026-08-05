import { createHash } from "node:crypto";
import { getCatalogDisplayPrice, getCatalogStartingPlan } from "../../../lib/catalog-price.js";
import { discountLabel } from "../../../lib/settings-defaults.js";
import { clean, redisPipeline } from "../../_utils.js";

const CATALOG_OVERRIDES_KEY = "lm:catalog:overrides";

function pipelineValue(entry) {
  if (entry && typeof entry === "object" && Object.hasOwn(entry, "result")) return entry.result;
  return entry;
}

function pipelineEntryHasError(entry) {
  const value = pipelineValue(entry);
  return (entry && typeof entry === "object" && Object.hasOwn(entry, "error"))
    || (value && typeof value === "object" && Object.hasOwn(value, "error"));
}

async function strictCatalogOverrides() {
  const rawResponse = await redisPipeline([["GET", CATALOG_OVERRIDES_KEY], ["PING"]]);
  const response = Array.isArray(rawResponse)
    ? rawResponse
    : Array.isArray(rawResponse?.result) ? rawResponse.result : [];
  if (!Array.isArray(response) || response.length !== 2) throw new Error("marketing_catalog_unavailable");
  if (response.some(pipelineEntryHasError)) {
    throw new Error("marketing_catalog_unavailable");
  }
  const raw = pipelineValue(response[0]);
  if (pipelineValue(response[1]) !== "PONG" || raw === undefined) throw new Error("marketing_catalog_unavailable");
  if (raw == null) return { products: {} };
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("marketing_catalog_unavailable");
  }
  return {
    ...parsed,
    products: parsed.products && typeof parsed.products === "object" && !Array.isArray(parsed.products)
      ? parsed.products
      : {},
  };
}

function inventoryKey(service, planId) {
  // Keep this byte-identical to /api/catalog's getCatalogSoldOutMap source.
  return `liumeiti:stock:${clean(service, 40)}:${clean(planId, 40)}`;
}

function liveMarketingPrice(product, activePlans) {
  const sellableProduct = { ...product, plans: activePlans };
  if (product?.quoteOnly || product?.key === "proxy-pay") return getCatalogDisplayPrice(sellableProduct);
  return getCatalogStartingPlan(sellableProduct)
    ? getCatalogDisplayPrice(sellableProduct)
    : "查看当前可用规格";
}

async function strictCatalogStockMap(catalog) {
  const pairs = [];
  for (const product of (Array.isArray(catalog) ? catalog : [])) {
    for (const plan of (Array.isArray(product?.plans) ? product.plans : [])) {
      pairs.push([product.key, plan.id]);
    }
  }
  const commands = [...pairs.map(([service, planId]) => ["GET", inventoryKey(service, planId)]), ["PING"]];
  const rawResponse = await redisPipeline(commands);
  const response = Array.isArray(rawResponse)
    ? rawResponse
    : Array.isArray(rawResponse?.result) ? rawResponse.result : [];
  if (response.length !== commands.length || response.some(pipelineEntryHasError)
      || pipelineValue(response.at(-1)) !== "PONG") {
    throw new Error("marketing_catalog_unavailable");
  }
  const stock = {};
  pairs.forEach(([service, planId], index) => {
    const raw = pipelineValue(response[index]);
    if (raw == null) {
      stock[`${service}:${planId}`] = null;
      return;
    }
    const source = String(raw).trim();
    const value = Number(source);
    if (!/^(?:0|[1-9]\d*)$/.test(source) || !Number.isSafeInteger(value) || value > 1_000_000_000) {
      throw new Error("marketing_catalog_unavailable");
    }
    stock[`${service}:${planId}`] = value;
  });
  return stock;
}

export function marketingContentHash({ templateId, subject, html, text } = {}) {
  return createHash("sha256").update(JSON.stringify({
    templateId: String(templateId || ""),
    subject: String(subject || ""),
    html: String(html || ""),
    text: String(text || ""),
  })).digest("hex");
}

export function marketingOfferSnapshotHash(offer) {
  return createHash("sha256").update(JSON.stringify(offer && typeof offer === "object" ? offer : null)).digest("hex");
}

export async function buildMarketingArgs(brandName, siteDomain, siteUrl, { requireLiveCatalog = false } = {}) {
  const origin = String(siteUrl || "https://www.liumeiti.vip").replace(/\/$/, "");
  const base = { brandName, siteDomain, siteUrl };
  try {
    const [{ getMergedCatalog }, settingsModule] = await Promise.all([
      import("../../_catalog.js"),
      import("../../_settings.js"),
    ]);
    const [catalog, settings] = await Promise.all([
      requireLiveCatalog ? strictCatalogOverrides().then((overrides) => getMergedCatalog(overrides)) : getMergedCatalog(),
      requireLiveCatalog ? settingsModule.getSettingsStrict() : settingsModule.getSettings(),
    ]);
    if (!Array.isArray(catalog)) throw new Error("marketing_catalog_unavailable");
    const stock = requireLiveCatalog ? await strictCatalogStockMap(catalog) : {};
    const products = catalog.map((product) => {
      const activePlans = (Array.isArray(product.plans) ? product.plans : []).filter((plan) => (
        plan?.active !== false
        && (!requireLiveCatalog || stock[`${product.key}:${plan.id}`] == null || stock[`${product.key}:${plan.id}`] > 0)
      ));
      return {
        key: product.key,
        name: product.title,
        subtitle: product.shortIntro || product.subtitle,
        active: product.active !== false && (!requireLiveCatalog || activePlans.length > 0),
        price: requireLiveCatalog
          ? liveMarketingPrice(product, activePlans)
          : product.priceText || "查看当前价格",
        href: `${origin}/services/${product.slug || product.key}`,
        icon: product.image || `/products/${product.key}.jpg`,
      };
    });
    if (requireLiveCatalog && !products.some((product) => product.active !== false)) {
      throw new Error("marketing_catalog_empty");
    }
    return {
      ...base,
      support: settings.support,
      products,
      benefits: {
        bundleTier2Label: discountLabel(settings.bundle?.tier2Rate, "zh"),
        bundleTier3Label: discountLabel(settings.bundle?.tier3Rate, "zh"),
        usdtDiscountLabel: discountLabel(1 - Number(settings.usdt?.discount), "zh"),
      },
    };
  } catch (e) {
    if (requireLiveCatalog) throw e;
    return base;
  }
}
