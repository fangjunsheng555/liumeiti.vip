// 后台商品/价格管理(仅超级管理员)。读:默认+覆盖+合并结果;写:保存覆盖到 Redis。
import {
  adminSessionFromRequest, isRootAdminSession, adminActorFromRequest,
  pushAdminActionLog, roundMoney, clean, getCatalogStockMap, setStock,
} from "../../_utils.js";
import { getMergedCatalog, getCatalogOverrides } from "../../_catalog.js";
import { commitCatalogVersion, ensureCatalogBaseline, listCatalogVersions } from "../../_catalog-versions.js";
import { recordHealthStatus } from "../../_health.js";
import { CATALOG_DEFAULTS } from "../../../lib/catalog-defaults.js";
import { getCatalogDisplayPrice } from "../../../lib/catalog-price.js";

export const runtime = "nodejs";

function gate(request) {
  const s = adminSessionFromRequest(request);
  return s && isRootAdminSession(s) ? s : null;
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

export async function GET(request) {
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
function diffToOverrides(edited) {
  const out = { products: {} };
  const byKey = {};
  CATALOG_DEFAULTS.forEach((d) => { byKey[d.key] = d; });
  for (const p of Array.isArray(edited) ? edited : []) {
    const def = byKey[p.key];
    if (!def) continue; // v1 只允许编辑已有商品
    const normalized = { ...p, priceText: getCatalogDisplayPrice(p) };
    const ov = {};
    for (const f of ["title", "subtitle", "priceText", "shortIntro", "cycle", "defaultPlan", "detailTitle", "detailBody"]) {
      const v = clean(normalized[f], f === "detailBody" ? 4000 : 400);
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

export async function PUT(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const previousOverrides = await getCatalogOverrides();
  const overrides = diffToOverrides(body.catalog);
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
  const stockEdits = (body.stockEdits && typeof body.stockEdits === "object") ? body.stockEdits : {};
  let stockChanged = 0;
  for (const [k, v] of Object.entries(stockEdits)) {
    const i = String(k).indexOf(":");
    if (i <= 0) continue;
    const svc = clean(k.slice(0, i), 40);
    const pid = clean(k.slice(i + 1), 40);
    const val = (v === "" || v == null) ? "" : Math.max(0, Math.floor(Number(v)));
    if (v !== "" && v != null && !Number.isFinite(Number(v))) continue;
    if (await setStock(svc, pid, val)) stockChanged += 1;
  }

  await pushAdminActionLog({
    action: "catalog_update", actor, target: "catalog",
    detail: { changedProducts: Object.keys(overrides.products), stockChanged, version: committed.currentVersion },
  });
  await recordHealthStatus("catalog", {
    status: "ok",
    summary: "商品目录已发布",
    metrics: { version: committed.currentVersion, products: Object.keys(overrides.products).length, stockChanged },
  }).catch(() => {});
  const catalog = await catalogWithStock(overrides);
  return Response.json({ ok: true, overrides, catalog, currentVersion: committed.currentVersion, version: committed.version });
}
