import assert from "node:assert/strict";
import test from "node:test";

import {
  getCatalogDisplayPrice,
  getCatalogStartingPlan,
  localizeCatalogDisplayPrice,
} from "../app/lib/catalog-price.js";
import { getMergedCatalog } from "../app/api/_catalog.js";

const airport = {
  key: "rocket",
  cycle: "1年",
  priceText: "¥128/年起",
  plans: [
    { id: "basic", label: "普通套餐", amount: 108, cycle: "1年" },
    { id: "pro", label: "高级套餐", amount: 188, cycle: "1年" },
    { id: "trial", label: "5元10GB测试", amount: 5, cycle: "次" },
  ],
};

test("card price follows the lowest active regular plan and ignores trial plans", () => {
  assert.equal(getCatalogStartingPlan(airport)?.id, "basic");
  assert.equal(getCatalogDisplayPrice(airport), "¥108/年起");
});

test("inactive plans do not affect the displayed starting price", () => {
  const product = {
    ...airport,
    plans: [
      { id: "legacy", label: "旧套餐", amount: 88, cycle: "1年", active: false },
      ...airport.plans,
    ],
  };
  assert.equal(getCatalogDisplayPrice(product), "¥108/年起");
});

test("quote-only copy is preserved and live prices localize to English", () => {
  assert.equal(getCatalogDisplayPrice({ key: "proxy-pay", quoteOnly: true, priceText: "3折起", plans: [] }), "3折起");
  assert.equal(localizeCatalogDisplayPrice("¥108/年起", "en"), "From ¥108/yr");
  assert.equal(localizeCatalogDisplayPrice("¥229/三个月起", "en"), "From ¥229/3 mo");
  assert.equal(localizeCatalogDisplayPrice("3折起", "en"), "From 30%");
});

test("merged catalog derives display price from backend plan overrides", async () => {
  const catalog = await getMergedCatalog({
    products: {
      rocket: {
        priceText: "¥128/年起",
        plans: {
          basic: { amount: 108 },
          pro: { amount: 188 },
          luxury: { amount: 328 },
          unlimited: { amount: 588 },
        },
      },
    },
  });
  assert.equal(catalog.find((product) => product.key === "rocket")?.priceText, "¥108/年起");
});
