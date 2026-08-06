// 后台商品/价格管理(仅超级管理员)。读:默认+覆盖+合并结果;写:保存覆盖到 Redis。
import {
  adminSessionFromRequest, isRootAdminSession, adminActorFromRequest,
  pushAdminActionLog, roundMoney, clean, getCatalogStockMap,
} from "../../_utils.js";
import { setStockAndMaybeEnqueueRestock } from "../../_push.js";
import { normalizeStockValue } from "../../_stock-input.js";
import { getMergedCatalog, getCatalogOverrides } from "../../_catalog.js";
import { commitCatalogVersion, ensureCatalogBaseline, listCatalogVersions } from "../../_catalog-versions.js";
import { recordHealthStatus } from "../../_health.js";
import { withApiTelemetry } from "../../_observability.js";
import { CATALOG_DEFAULTS } from "../../../lib/catalog-defaults.js";
import { getCatalogDisplayPrice } from "../../../lib/catalog-price.js";

export const runtime = "nodejs";

function gate(request) {
  const s = adminSessionFromRequest(request);
  return s && isRootAdminSession(s) ? s : null;
}

const PRODUCT_STRING_LIMITS = {
  title: 120,
  subtitle: 240,
  priceText: 120,
  shortIntro: 600,
  cycle: 60,
  defaultPlan: 40,
  image: 500,
  detailTitle: 240,
  detailBody: 4000,
};
const REQUIRED_PRODUCT_STRINGS = new Set(["title", "subtitle", "priceText", "shortIntro", "cycle", "defaultPlan", "image"]);

const PLAN_STRING_LIMITS = { label: 80, desc: 500, cycle: 60 };

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasAtMostTwoDecimals(value) {
  return Math.abs(value - Math.round(value * 100) / 100) < 1e-9;
}

export function isSafeCatalogImage(value) {
  if (typeof value !== "string") return false;
  const image = value.trim();
  if (!image || image.length > PRODUCT_STRING_LIMITS.image || /[\u0000-\u001f\u007f\\]/.test(image)) return false;
  if (image.startsWith("/")) return !image.startsWith("//");
  try {
    const url = new URL(image);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// The admin editor submits the complete merged catalog. Validate that closed
// contract before deriving overrides so an old/malformed client can neither
// create products/plans nor publish a free active checkout option.
export function validateCatalogPayload(catalog) {
  const fieldErrors = {};
  const fail = (field, code, message) => {
    if (!fieldErrors[field]) fieldErrors[field] = { code, message };
  };
  if (!Array.isArray(catalog)) {
    fail("catalog", "catalog_required", "商品目录不能为空");
    return { ok: false, error: "invalid_catalog", message: "请检查商品目录后重试", fieldErrors };
  }

  const defaultsByKey = new Map(CATALOG_DEFAULTS.map((product) => [product.key, product]));
  const submittedByKey = new Map();
  catalog.forEach((product, productIndex) => {
    const prefix = `catalog.${productIndex}`;
    if (!isPlainRecord(product)) {
      fail(prefix, "invalid_product", "商品数据格式不正确");
      return;
    }
    if (typeof product.key !== "string" || !product.key.trim()) {
      fail(`${prefix}.key`, "product_key_required", "商品标识不能为空");
      return;
    }
    const key = product.key.trim();
    if (product.key !== key) {
      fail(`${prefix}.key`, "invalid_product_key", "商品标识格式不正确，请刷新后重试");
      return;
    }
    if (!defaultsByKey.has(key)) {
      fail(`${prefix}.key`, "unknown_product", "不允许新增未知商品");
      return;
    }
    if (submittedByKey.has(key)) {
      fail(`${prefix}.key`, "duplicate_product", "商品重复，请刷新后重试");
      return;
    }
    submittedByKey.set(key, { product, productIndex });
  });

  for (const def of CATALOG_DEFAULTS) {
    const submitted = submittedByKey.get(def.key);
    if (!submitted) {
      fail(`products.${def.key}`, "missing_product", "商品缺失，请刷新后重试");
      continue;
    }
    const { product, productIndex } = submitted;
    const prefix = `catalog.${productIndex}`;
    if (typeof product.active !== "boolean") fail(`${prefix}.active`, "invalid_boolean", "上架状态格式不正确");
    if (typeof product.sort !== "number" || !Number.isFinite(product.sort)) fail(`${prefix}.sort`, "invalid_number", "排序必须是有效数字");

    for (const [field, limit] of Object.entries(PRODUCT_STRING_LIMITS)) {
      if (!Object.hasOwn(product, field) && !REQUIRED_PRODUCT_STRINGS.has(field)) continue;
      if (typeof product[field] !== "string") {
        fail(`${prefix}.${field}`, "invalid_string", "请输入有效文本");
      } else if (product[field].trim().length > limit) {
        fail(`${prefix}.${field}`, "text_too_long", `内容不能超过 ${limit} 个字符`);
      }
    }
    if (typeof product.image === "string" && !isSafeCatalogImage(product.image)) {
      fail(`${prefix}.image`, "unsafe_image_url", "图片地址仅支持站内 / 路径或 HTTPS 地址");
    }
    if (!Array.isArray(product.highlights)) {
      fail(`${prefix}.highlights`, "invalid_highlights", "商品亮点格式不正确");
    } else if (product.highlights.length > 8 || product.highlights.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 60)) {
      fail(`${prefix}.highlights`, "invalid_highlights", "商品亮点最多 8 条，每条不超过 60 个字符");
    }

    if (!Array.isArray(product.plans)) {
      fail(`${prefix}.plans`, "plans_required", "商品规格不能为空");
      continue;
    }
    const defaultPlans = new Map((def.plans || []).map((plan) => [plan.id, plan]));
    const submittedPlans = new Map();
    product.plans.forEach((plan, planIndex) => {
      const planPrefix = `${prefix}.plans.${planIndex}`;
      if (!isPlainRecord(plan)) {
        fail(planPrefix, "invalid_plan", "规格数据格式不正确");
        return;
      }
      if (typeof plan.id !== "string" || !plan.id.trim()) {
        fail(`${planPrefix}.id`, "plan_id_required", "规格标识不能为空");
        return;
      }
      const planId = plan.id.trim();
      if (plan.id !== planId) {
        fail(`${planPrefix}.id`, "invalid_plan_id", "规格标识格式不正确，请刷新后重试");
        return;
      }
      if (!defaultPlans.has(planId)) {
        fail(`${planPrefix}.id`, "unknown_plan", "不允许新增未知规格");
        return;
      }
      if (submittedPlans.has(planId)) {
        fail(`${planPrefix}.id`, "duplicate_plan", "规格重复，请刷新后重试");
        return;
      }
      submittedPlans.set(planId, plan);
      if (Object.hasOwn(plan, "active") && typeof plan.active !== "boolean") fail(`${planPrefix}.active`, "invalid_boolean", "规格状态格式不正确");
      for (const [field, limit] of Object.entries(PLAN_STRING_LIMITS)) {
        if (typeof plan[field] !== "string") fail(`${planPrefix}.${field}`, "invalid_string", "请输入有效文本");
        else if (!plan[field].trim() || plan[field].trim().length > limit) fail(`${planPrefix}.${field}`, "invalid_text", `内容不能为空且不能超过 ${limit} 个字符`);
      }
      const amount = plan.amount;
      const minimum = def.quoteOnly ? 0 : Number.MIN_VALUE;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < minimum || amount > 1_000_000 || !hasAtMostTwoDecimals(amount)) {
        fail(
          `${planPrefix}.amount`,
          def.quoteOnly ? "invalid_quote_price" : "invalid_price",
          def.quoteOnly ? "报价商品价格须为 0 至 1,000,000 元，最多两位小数" : "商品价格须大于 0 且不超过 1,000,000 元，最多两位小数",
        );
      }
    });

    for (const plan of def.plans || []) {
      if (!submittedPlans.has(plan.id)) fail(`${prefix}.plans.${plan.id}`, "missing_plan", "规格缺失，请刷新后重试");
    }
    if (typeof product.defaultPlan === "string") {
      const selected = submittedPlans.get(product.defaultPlan.trim());
      if (!selected) fail(`${prefix}.defaultPlan`, "invalid_default_plan", "默认规格必须属于当前商品");
      else if (selected.active === false) fail(`${prefix}.defaultPlan`, "inactive_default_plan", "默认规格必须处于上架状态");
    }
    if (product.active === true && !Array.from(submittedPlans.values()).some((plan) => plan.active !== false)) {
      fail(`${prefix}.plans`, "active_plan_required", "上架商品至少需要一个上架规格");
    }
  }

  if (catalog.length !== CATALOG_DEFAULTS.length && !Object.values(fieldErrors).some((item) => item.code === "missing_product")) {
    fail("catalog", "invalid_product_count", "商品数量与当前目录不一致，请刷新后重试");
  }
  return Object.keys(fieldErrors).length
    ? { ok: false, error: "invalid_catalog", message: "请修正标记字段后再保存", fieldErrors }
    : { ok: true, catalog };
}

// 合并后的目录,每个规格附当前库存(null=不限)
async function catalogWithStock(overrides) {
  const catalog = await getMergedCatalog(overrides);
  const stock = await getCatalogStockMap(catalog);
  return catalog.map((p) => ({
    ...p,
    plans: (p.plans || []).map((pl) => ({ ...pl, stock: stock[p.key + ":" + pl.id] ?? null })),
  }));
}

async function getCatalogHandler(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const overrides = await getCatalogOverrides();
  await ensureCatalogBaseline(overrides, adminActorFromRequest(request));
  const versionState = await listCatalogVersions(20);
  const catalog = await catalogWithStock(overrides);
  return Response.json({ ok: true, defaults: CATALOG_DEFAULTS, overrides, catalog, ...versionState });
}

// 把后台编辑面板提交的「合并后目录」反推成「覆盖」:只存与默认不同的字段,保持覆盖层精简、
// 默认变动时仍能自动跟随。
export function diffToOverrides(edited) {
  const out = { products: {} };
  const byKey = {};
  CATALOG_DEFAULTS.forEach((d) => { byKey[d.key] = d; });
  for (const p of Array.isArray(edited) ? edited : []) {
    const def = byKey[p.key];
    if (!def) continue; // v1 只允许编辑已有商品
    const normalized = { ...p, priceText: getCatalogDisplayPrice(p) };
    const ov = {};
    for (const f of ["title", "subtitle", "priceText", "shortIntro", "cycle", "defaultPlan", "image", "detailTitle", "detailBody"]) {
      const v = clean(normalized[f], f === "detailBody" ? 4000 : f === "image" ? 500 : 400);
      if (v && v !== (def[f] || "")) ov[f] = v;
    }
    if (Array.isArray(p.highlights)) {
      const hl = p.highlights.filter((x) => typeof x === "string" && x.trim()).slice(0, 8).map((x) => clean(x, 60));
      if (JSON.stringify(hl) !== JSON.stringify(def.highlights || [])) ov.highlights = hl;
    }
    if (typeof p.active === "boolean" && p.active !== (def.active !== false)) ov.active = p.active;
    if (Number.isFinite(p.sort) && Number(p.sort) !== (def.sort || 0)) ov.sort = Number(p.sort);

    const planOv = {};
    const defPlanById = {};
    (def.plans || []).forEach((pl) => { defPlanById[pl.id] = pl; });
    for (const pl of Array.isArray(p.plans) ? p.plans : []) {
      const dpl = defPlanById[pl.id];
      if (!dpl) continue; // 已有规格的修改(新增规格 v1 暂不从面板加)
      const po = {};
      if (Number.isFinite(pl.amount) && roundMoney(pl.amount) !== dpl.amount && roundMoney(pl.amount) >= 0) po.amount = roundMoney(pl.amount);
      const lbl = clean(pl.label, 60); if (lbl && lbl !== dpl.label) po.label = lbl;
      const dsc = clean(pl.desc, 300); if (dsc !== (dpl.desc || "")) po.desc = dsc;
      const cyc = clean(pl.cycle, 30); if (cyc && cyc !== (dpl.cycle || def.cycle)) po.cycle = cyc;
      if (typeof pl.active === "boolean" && pl.active !== (dpl.active !== false)) po.active = pl.active;
      if (Object.keys(po).length) planOv[pl.id] = po;
    }
    if (Object.keys(planOv).length) ov.plans = planOv;

    if (Object.keys(ov).length) out.products[p.key] = ov;
  }
  return out;
}

async function updateCatalogHandler(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const validatedCatalog = validateCatalogPayload(body.catalog);
  if (!validatedCatalog.ok) return Response.json(validatedCatalog, { status: 400 });
  const editedCatalog = validatedCatalog.catalog;
  if (Object.hasOwn(body, "stockEdits") && !isPlainRecord(body.stockEdits)) {
    return Response.json({
      ok: false,
      error: "invalid_stock_edit",
      message: "库存修改格式不正确，请刷新后重试",
      fieldErrors: { stockEdits: { code: "invalid_stock_edits", message: "库存修改格式不正确" } },
    }, { status: 400 });
  }
  const stockEdits = (body.stockEdits && typeof body.stockEdits === "object" && !Array.isArray(body.stockEdits))
    ? body.stockEdits
    : {};
  const normalizedStockEdits = [];
  for (const [key, rawValue] of Object.entries(stockEdits)) {
    const separator = String(key).indexOf(":");
    const service = separator > 0 ? clean(String(key).slice(0, separator), 40) : "";
    const planId = separator > 0 ? clean(String(key).slice(separator + 1), 40) : "";
    const product = editedCatalog.find((item) => item?.key === service);
    const plan = product?.plans?.find((item) => item?.id === planId);
    const normalized = normalizeStockValue(rawValue);
    if (!service || !planId || !product || !plan || !normalized.ok) {
      return Response.json({ ok: false, error: "invalid_stock_edit", target: clean(key, 100) }, { status: 400 });
    }
    normalizedStockEdits.push({ service, planId, value: normalized.value, product, plan });
  }
  const previousOverrides = await getCatalogOverrides();
  const overrides = diffToOverrides(editedCatalog);
  const actor = adminActorFromRequest(request);
  const committed = await commitCatalogVersion({
    overrides,
    previousOverrides,
    expectedVersion: body.baseVersion,
    actor,
    source: "save",
    note: clean(body.note || "后台保存目录", 160),
  });
  if (committed.conflict) {
    return Response.json({ ok: false, error: "version_conflict", currentVersion: committed.currentVersion }, { status: 409 });
  }
  if (!committed.ok) return Response.json({ ok: false, error: committed.error || "save_failed" }, { status: 500 });

  // 库存编辑(只对面板里实际改过的规格生效,key 形如 "<service>:<planId>",值 ""=不限/整数≥0)
  let stockChanged = 0;
  const stockFailures = [];
  for (const { service: svc, planId: pid, value: val, product, plan } of normalizedStockEdits) {
    const result = await setStockAndMaybeEnqueueRestock(
      svc,
      pid,
      val,
      `catalog:${committed.currentVersion}:${svc}:${pid}`,
      {
        serviceLabelZh: product?.title || svc,
        serviceLabelEn: product?.title || svc,
        planLabelZh: plan?.label || pid,
        planLabelEn: plan?.label || pid,
      },
    );
    if (result.ok) stockChanged += 1;
    else stockFailures.push({ service: svc, plan: pid, error: result.error || "stock_update_failed" });
  }

  try {
    await pushAdminActionLog({
      action: "catalog_update", actor, target: "catalog",
      detail: { changedProducts: Object.keys(overrides.products), stockChanged, stockFailures, version: committed.currentVersion },
    });
  } catch {
    // The catalog and any completed stock writes are already committed. Audit
    // availability must not turn a successful primary mutation into a retry.
  }
  await recordHealthStatus("catalog", {
    status: stockFailures.length ? "error" : "ok",
    summary: stockFailures.length ? "商品目录已发布，但部分库存更新失败" : "商品目录已发布",
    error: stockFailures.length ? "stock_update_failed" : "",
    metrics: { version: committed.currentVersion, products: Object.keys(overrides.products).length, stockChanged, stockFailed: stockFailures.length },
  }).catch(() => {});
  const catalog = await catalogWithStock(overrides);
  if (stockFailures.length) {
    return Response.json({
      ok: false,
      error: "stock_update_failed",
      catalogCommitted: true,
      partial: stockChanged > 0,
      stockChanged,
      failedStock: stockFailures,
      overrides,
      catalog,
      currentVersion: committed.currentVersion,
      version: committed.version,
    }, { status: 503 });
  }
  return Response.json({ ok: true, overrides, catalog, currentVersion: committed.currentVersion, version: committed.version });
}

export const GET = withApiTelemetry("admin_catalog", getCatalogHandler);
export const PUT = withApiTelemetry("admin_catalog", updateCatalogHandler);
