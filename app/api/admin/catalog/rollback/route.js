import {
  adminActorFromRequest,
  adminSessionFromRequest,
  getCatalogStockMap,
  isRootAdminSession,
  pushAdminActionLog,
} from "../../../_utils.js";
import { getCatalogOverrides, getMergedCatalog } from "../../../_catalog.js";
import { commitCatalogVersion, getCatalogVersion, listCatalogVersions } from "../../../_catalog-versions.js";
import { recordHealthStatus } from "../../../_health.js";

export const runtime = "nodejs";

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

async function catalogWithStock(overrides) {
  const catalog = await getMergedCatalog(overrides);
  const stock = await getCatalogStockMap(catalog);
  return catalog.map((product) => ({
    ...product,
    plans: (product.plans || []).map((plan) => ({ ...plan, stock: stock[`${product.key}:${plan.id}`] ?? null })),
  }));
}

export async function POST(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const target = await getCatalogVersion(body.versionId);
  if (!target) return Response.json({ ok: false, error: "version_not_found" }, { status: 404 });

  const state = await listCatalogVersions(1);
  if (target.id === state.currentVersion) {
    const overrides = await getCatalogOverrides();
    return Response.json({ ok: true, unchanged: true, currentVersion: state.currentVersion, catalog: await catalogWithStock(overrides) });
  }

  const previousOverrides = await getCatalogOverrides();
  const actor = adminActorFromRequest(request);
  const committed = await commitCatalogVersion({
    overrides: target.overrides,
    previousOverrides,
    expectedVersion: body.baseVersion,
    actor,
    source: "rollback",
    note: `回滚至 ${target.id}`,
    rollbackFrom: target.id,
  });
  if (committed.conflict) {
    return Response.json({ ok: false, error: "version_conflict", currentVersion: committed.currentVersion }, { status: 409 });
  }
  if (!committed.ok) return Response.json({ ok: false, error: committed.error || "rollback_failed" }, { status: 500 });

  await pushAdminActionLog({
    action: "catalog_rollback",
    actor,
    target: `catalog-version:${target.id}`,
    detail: { fromVersion: state.currentVersion, toSnapshot: target.id, createdVersion: committed.currentVersion },
  });
  await recordHealthStatus("catalog", {
    status: "ok",
    summary: "商品目录已恢复历史版本",
    metrics: { version: committed.currentVersion, restoredFrom: target.id },
  }).catch(() => {});
  return Response.json({
    ok: true,
    currentVersion: committed.currentVersion,
    version: committed.version,
    catalog: await catalogWithStock(target.overrides),
  });
}
