// 商品目录覆盖层(服务端)。默认值在 lib/catalog-defaults.js;站主在后台写覆盖到
// Redis lm:catalog:overrides;getMergedCatalog() 返回「默认 + 覆盖」合并结果,供
// 结账价格权威(order/order-quote)、公开 /api/catalog、后台读写共用。无覆盖时 = 默认,行为不变。
import { redisCmd, roundMoney, clean } from "./_utils.js";
import { CATALOG_DEFAULTS } from "../lib/catalog-defaults.js";
import { getCatalogDisplayPrice } from "../lib/catalog-price.js";

const OVERRIDES_KEY = "lm:catalog:overrides";

function isPrice(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000000; }

export async function getCatalogOverrides() {
  try {
    const raw = await redisCmd(["GET", OVERRIDES_KEY]);
    if (!raw) return { products: {} };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && parsed.products ? parsed : { products: {} };
  } catch (e) { return { products: {} }; }
}

export async function saveCatalogOverrides(overrides) {
  const safe = overrides && typeof overrides === "object" && overrides.products ? overrides : { products: {} };
  const ok = await redisCmd(["SET", OVERRIDES_KEY, JSON.stringify(safe)]);
  return ok === "OK";
}

function mergeProduct(def, ov) {
  const out = { ...def, plans: def.plans.map((p) => ({ ...p })) };
  if (!ov || typeof ov !== "object") return { ...out, priceText: getCatalogDisplayPrice(out) };
  for (const f of ["title", "subtitle", "priceText", "shortIntro", "cycle", "defaultPlan", "image", "detailTitle", "detailBody"]) {
    if (typeof ov[f] === "string" && ov[f].trim()) out[f] = clean(ov[f], f === "detailBody" ? 4000 : 400);
  }
  if (Array.isArray(ov.highlights)) out.highlights = ov.highlights.filter((x) => typeof x === "string" && x.trim()).slice(0, 8).map((x) => clean(x, 60));
  if (typeof ov.active === "boolean") out.active = ov.active;
  if (Number.isFinite(ov.sort)) out.sort = Number(ov.sort);

  const planOv = ov.plans && typeof ov.plans === "object" ? ov.plans : {};
  out.plans = out.plans.map((pl) => {
    const po = planOv[pl.id];
    if (!po || typeof po !== "object") return pl;
    const next = { ...pl };
    if (typeof po.label === "string" && po.label.trim()) next.label = clean(po.label, 60);
    if (typeof po.desc === "string") next.desc = clean(po.desc, 300);
    if (typeof po.cycle === "string" && po.cycle.trim()) next.cycle = clean(po.cycle, 30);
    if (isPrice(po.amount)) next.amount = roundMoney(po.amount);
    if (typeof po.active === "boolean") next.active = po.active;
    return next;
  });
  // 追加的新规格(同商品下)
  if (Array.isArray(ov.extraPlans)) {
    for (const ep of ov.extraPlans) {
      if (ep && ep.id && isPrice(ep.amount) && !out.plans.some((p) => p.id === ep.id)) {
        out.plans.push({ id: clean(ep.id, 30), label: clean(ep.label || ep.id, 60), amount: roundMoney(ep.amount), cycle: clean(ep.cycle || def.cycle, 30), desc: clean(ep.desc || "", 300), active: ep.active !== false });
      }
    }
  }
  return { ...out, priceText: getCatalogDisplayPrice(out) };
}

// 合并后的完整目录(含上下架的,带 active 标记);按 sort 升序。
export async function getMergedCatalog(overrides = null) {
  const ov = overrides || await getCatalogOverrides();
  const prods = (ov.products && typeof ov.products === "object") ? ov.products : {};
  return CATALOG_DEFAULTS
    .map((def) => mergeProduct(def, prods[def.key]))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));
}

// 结账价格权威:按 service+plan 取合并后的实收价(分)。找不到返回 null(由调用方拒单)。
export function resolvePlanFromCatalog(catalog, service, planId) {
  const prod = catalog.find((p) => p.key === service);
  if (!prod) return null;
  const wantId = clean(planId, 30);
  const plan = (prod.plans || []).find((p) => p.id === wantId) || (prod.plans || []).find((p) => p.id === prod.defaultPlan) || prod.plans?.[0] || null;
  if (!plan) return null;
  return { product: prod, plan, amount: roundMoney(plan.amount) };
}
