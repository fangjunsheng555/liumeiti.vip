// 公开商品目录(合并默认+后台覆盖)。前端首页/选购/服务页/结账读这里,保证文案与价格、
// 上下架与结账实收价完全一致。仅返回上架(active)商品与上架规格。
import { getMergedCatalog } from "../_catalog.js";
import { getCatalogSoldOutMap } from "../_utils.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 始终读最新覆盖,不被静态缓存

export async function GET() {
  const catalog = await getMergedCatalog();
  const soldOut = await getCatalogSoldOutMap(catalog); // { "<key>:<planId>": true }
  const products = catalog
    .filter((p) => p.active !== false)
    .map((p) => ({
      key: p.key, slug: p.slug || p.key, title: p.title, subtitle: p.subtitle,
      image: p.image, cycle: p.cycle, priceText: p.priceText, shortIntro: p.shortIntro,
      highlights: Array.isArray(p.highlights) ? p.highlights : [],
      detailTitle: p.detailTitle || "", detailBody: p.detailBody || "",
      defaultPlan: p.defaultPlan,
      quoteOnly: !!p.quoteOnly,
      needsAccountPassword: !!p.needsAccountPassword, needsContact: !!p.needsContact,
      plans: (p.plans || []).filter((pl) => pl.active !== false).map((pl) => ({
        id: pl.id, label: pl.label, amount: Number(pl.amount), cycle: pl.cycle || p.cycle, desc: pl.desc || "",
        soldOut: !!soldOut[p.key + ":" + pl.id],
      })),
    }));
  return Response.json({ ok: true, products }, { headers: { "cache-control": "no-store" } });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
