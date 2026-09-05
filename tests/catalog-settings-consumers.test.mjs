import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("catalog image and detail copy reach client product surfaces", async () => {
  const store = await import("../app/lib/store.js");
  store.applyCatalogOverride([{
    key: "netflix",
    title: "Netflix 新标题",
    subtitle: "新的副标题",
    image: "https://cdn.example.com/netflix.webp",
    detailTitle: "新的服务标题",
    detailBody: "新的完整介绍",
    shortIntro: "新的短简介",
    highlights: ["卖点一"],
    cycle: "1年",
    defaultPlan: "seat",
    plans: [{ id: "seat", label: "单独车位", amount: 168, cycle: "1年", desc: "说明" }],
  }]);
  const product = store.getCatalogProduct("netflix");
  assert.equal(product.image, "https://cdn.example.com/netflix.webp");
  assert.equal(product.detailTitle, "新的服务标题");
  assert.equal(product.detailBody, "新的完整介绍");

  store.applyCatalogOverride([{
    key: "netflix",
    title: "Netflix 新标题",
    image: "/products/netflix.jpg",
    highlights: [],
    plans: [{ id: "seat", label: "单独车位", amount: 168, cycle: "1年", desc: "说明" }],
  }]);
  assert.deepEqual(store.getCatalogProduct("netflix").highlights, [], "an explicitly empty highlight list must not resurrect defaults");

  const home = await readFile(new URL("../app/page.jsx", import.meta.url), "utf8");
  assert.match(home, /image:\s*p\.image \|\| service\.image/);
});

test("service catalog application preserves English copy while synchronizing locale-independent image and price", async () => {
  const { getServiceBySlug, localizeService } = await import("../app/services/service-data.js");
  const { applyCatalogToService, serviceCatalogLowPrice, serviceJsonLdImage } = await import("../app/services/catalog-service.js");
  const raw = getServiceBySlug("netflix");
  const catalog = {
    key: "netflix",
    title: "中文新名称",
    subtitle: "中文新副标题",
    image: "https://cdn.example.com/netflix.webp",
    detailTitle: "中文详情标题",
    detailBody: "中文详情内容",
    priceText: "¥88/年起",
    highlights: ["中文卖点"],
    plans: [
      { id: "seat", label: "车位", amount: 168, cycle: "1年", desc: "中文车位" },
      { id: "full", label: "整号", amount: 88, cycle: "1年", desc: "中文整号" },
    ],
  };
  const zh = applyCatalogToService(raw, catalog, "zh", {});
  const enBase = localizeService(raw, "en");
  const en = applyCatalogToService(enBase, catalog, "en", {});

  assert.equal(zh.image, catalog.image);
  assert.equal(zh.title, catalog.detailTitle);
  assert.equal(zh.description, catalog.detailBody);
  assert.deepEqual(zh.highlights, catalog.highlights);
  assert.equal(en.image, catalog.image);
  assert.equal(en.title, enBase.title);
  assert.notEqual(en.plans[0][0], catalog.plans[0].label);
  assert.equal(serviceJsonLdImage("/products/netflix.jpg"), "https://www.liumeiti.vip/products/netflix.jpg");
  assert.equal(serviceJsonLdImage(catalog.image), catalog.image);
  assert.equal(serviceCatalogLowPrice(zh, catalog), "88");
  assert.deepEqual(applyCatalogToService(raw, { ...catalog, highlights: [] }, "zh", {}).highlights, []);
});

test("existing settings now drive previously hard-coded public copy", async () => {
  const serviceCenter = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
  const legal = await readFile(new URL("../app/legal/page.jsx", import.meta.url), "utf8");
  const proxy = await readFile(new URL("../app/components/ProxyQuotePayment.jsx", import.meta.url), "utf8");
  assert.match(serviceCenter, /const footerCfg = siteSettings\.footer/);
  assert.match(serviceCenter, /footerCfg\.copyright/);
  assert.match(legal, /getSettings\(\)/);
  assert.match(legal, /footerCfg\.addressEn/);
  assert.match(proxy, /usdtPaymentPresentation\(locale\)/);
  assert.doesNotMatch(proxy, /L\("9 折", "10% off"\)/);
});

test("USDT without a discount has complete customer-facing copy and no empty badge", async () => {
  const store = await import("../app/lib/store.js");
  const { SETTINGS_DEFAULTS } = await import("../app/lib/settings-defaults.js");
  const settings = structuredClone(SETTINGS_DEFAULTS);
  settings.usdt.discount = 1;
  store.applySiteSettings(settings);
  assert.deepEqual(store.usdtPaymentPresentation("zh"), { discount: "", methodNote: "TRC20", shopHint: "USDT 支付", faqQualifier: "" });
  assert.deepEqual(store.usdtPaymentPresentation("en"), { discount: "", methodNote: "TRC20", shopHint: "Pay with USDT", faqQualifier: "" });

  const checkout = await readFile(new URL("../app/checkout/page.jsx", import.meta.url), "utf8");
  const shop = await readFile(new URL("../app/shop/page.jsx", import.meta.url), "utf8");
  const serviceCenter = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
  const proxy = await readFile(new URL("../app/components/ProxyQuotePayment.jsx", import.meta.url), "utf8");
  assert.match(checkout, /usdtPresentation\.methodNote/);
  assert.match(checkout, /usdtPresentation\.discount && <div className="payment-method-badge"/);
  assert.match(shop, /usdtPresentation\.shopHint/);
  assert.doesNotMatch(shop, /usdtDiscountLabel/);
  assert.match(serviceCenter, /usdtPresentation\.faqQualifier/);
  assert.match(proxy, /usdtPresentation\.discount && <em>/);
});

test("shop cards do not expose an interactive role around their real action buttons", async () => {
  const source = await readFile(new URL("../app/shop/page.jsx", import.meta.url), "utf8");
  const start = source.indexOf("<article");
  const card = source.slice(start, source.indexOf("</article>", start) + 10);
  assert.match(card, /className=\{`glass-card product-card/);
  assert.doesNotMatch(card, /role="button"|tabIndex=\{0\}/);
  assert.equal((card.match(/<button/g) || []).length, 2);
});

test("sold-out plans in the shop dialogs say so and offer no restock alert, and the plan list scrolls", async () => {
  // The alert button under every sold-out plan pushed the picker past the
  // dialog's clipped height, so the last plans and the actions were cut off,
  // and the alert itself relied on browser notifications few customers allow.
  const shop = await readFile(new URL("../app/shop/page.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(!shop.includes("StockAlertButton"), "the shop page must not render the restock alert");
  assert.ok(!shop.includes("到货提醒") && !shop.includes("Restock alert") && !shop.includes("restock alert"), "no restock copy may remain in the shop");
  // A sold-out product is disabled and labelled as such, on the card and in the detail dialog.
  assert.ok(shop.includes("disabled={soldOut}"), "the card CTA is disabled when every plan is sold out");
  assert.ok(shop.includes("disabled={allPlansSoldOut(selectedProduct.key)}"), "the detail dialog CTA is disabled when every plan is sold out");
  assert.equal((shop.match(/L\("已售罄", "Sold out"\)/g) || []).length >= 3, true, "card, detail dialog and picker all say sold out");
  // The plan list is the scrolling region of the picker dialog.
  const compact = css.slice(css.indexOf(".shop-rocket-plan-picker.compact {"));
  const rule = compact.slice(0, compact.indexOf("}"));
  assert.ok(rule.includes("overflow-y: auto"), "the compact plan list must scroll");
  assert.ok(rule.includes("min-height: 0"), "the list must be allowed to shrink inside the flex dialog");
  // The dialog is sized to show the whole catalogue at once; the scroll is only
  // a safety net for very short screens and must not show a bar.
  assert.ok(rule.includes("scrollbar-width: none"), "no scrollbar may show on the plan list");
  assert.ok(css.includes(".shop-rocket-plan-picker.compact::-webkit-scrollbar {"), "WebKit scrollbar hidden too");
  assert.ok(css.includes("max-height: min(94dvh, 700px);"), "the mobile dialog is tall enough for six plans");
});
