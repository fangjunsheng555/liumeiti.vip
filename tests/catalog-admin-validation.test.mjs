import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG_DEFAULTS } from "../app/lib/catalog-defaults.js";
import {
  diffToOverrides,
  isSafeCatalogImage,
  validateCatalogPayload,
} from "../app/api/admin/catalog/route.js";

function catalogFixture() {
  return structuredClone(CATALOG_DEFAULTS);
}

function errorCodes(result) {
  return Object.values(result.fieldErrors || {}).map((entry) => entry.code);
}

test("catalog validation rejects an empty or non-array payload with field errors", () => {
  for (const payload of [undefined, null, {}, "catalog", 0]) {
    const result = validateCatalogPayload(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_catalog");
    assert.equal(result.fieldErrors.catalog.code, "catalog_required");
  }
});

test("catalog validation rejects missing, unknown, and duplicate products or plans", () => {
  const missingProduct = catalogFixture();
  const removedProduct = missingProduct.pop();
  assert.ok(errorCodes(validateCatalogPayload(missingProduct)).includes("missing_product"));

  const unknownProduct = catalogFixture();
  unknownProduct.push({ ...structuredClone(removedProduct), key: "new-product" });
  assert.ok(errorCodes(validateCatalogPayload(unknownProduct)).includes("unknown_product"));

  const duplicateProduct = catalogFixture();
  duplicateProduct.push(structuredClone(duplicateProduct[0]));
  assert.ok(errorCodes(validateCatalogPayload(duplicateProduct)).includes("duplicate_product"));

  const missingPlan = catalogFixture();
  missingPlan[0].plans.pop();
  assert.ok(errorCodes(validateCatalogPayload(missingPlan)).includes("missing_plan"));

  const unknownPlan = catalogFixture();
  unknownPlan[0].plans.push({ id: "new-plan", label: "新规格", amount: 1, cycle: "1月", desc: "test" });
  assert.ok(errorCodes(validateCatalogPayload(unknownPlan)).includes("unknown_plan"));

  const duplicatePlan = catalogFixture();
  duplicatePlan[0].plans.push(structuredClone(duplicatePlan[0].plans[0]));
  assert.ok(errorCodes(validateCatalogPayload(duplicatePlan)).includes("duplicate_plan"));
});

test("normal product prices must be positive finite money while quote-only may remain zero", () => {
  for (const amount of [0, -1, 1.001, 1_000_000.01, Number.POSITIVE_INFINITY, "128"]) {
    const catalog = catalogFixture();
    catalog[0].plans[0].amount = amount;
    const result = validateCatalogPayload(catalog);
    assert.equal(result.ok, false, String(amount));
    assert.ok(errorCodes(result).includes("invalid_price"), String(amount));
  }

  const valid = catalogFixture();
  const quote = valid.find((product) => product.quoteOnly === true);
  assert.equal(quote.plans[0].amount, 0);
  assert.equal(validateCatalogPayload(valid).ok, true);
});

test("catalog validation rejects invalid editable field types", () => {
  const badProduct = catalogFixture();
  badProduct[0].active = "true";
  badProduct[0].sort = null;
  badProduct[0].highlights = {};
  const productResult = validateCatalogPayload(badProduct);
  assert.equal(productResult.ok, false);
  assert.ok(errorCodes(productResult).includes("invalid_boolean"));
  assert.ok(errorCodes(productResult).includes("invalid_number"));
  assert.ok(errorCodes(productResult).includes("invalid_highlights"));

  const badPlan = catalogFixture();
  badPlan[0].plans[0].active = "false";
  badPlan[0].plans[0].label = null;
  const planResult = validateCatalogPayload(badPlan);
  assert.equal(planResult.ok, false);
  assert.ok(errorCodes(planResult).includes("invalid_boolean"));
  assert.ok(errorCodes(planResult).includes("invalid_string"));
});

test("default plan must exist and stay active and an active product needs an active plan", () => {
  const missingDefault = catalogFixture();
  missingDefault[0].defaultPlan = "does-not-exist";
  assert.ok(errorCodes(validateCatalogPayload(missingDefault)).includes("invalid_default_plan"));

  const inactiveDefault = catalogFixture();
  inactiveDefault[0].plans[0].active = false;
  assert.ok(errorCodes(validateCatalogPayload(inactiveDefault)).includes("inactive_default_plan"));

  const noActivePlan = catalogFixture();
  noActivePlan[0].plans.forEach((plan) => { plan.active = false; });
  assert.ok(errorCodes(validateCatalogPayload(noActivePlan)).includes("active_plan_required"));
});

test("catalog image accepts only bounded site-relative or HTTPS URLs", () => {
  for (const image of [
    "/products/custom.jpg",
    "https://cdn.example.com/catalog/custom.webp?version=2",
  ]) assert.equal(isSafeCatalogImage(image), true, image);

  for (const image of [
    "",
    "products/custom.jpg",
    "//evil.example/catalog.jpg",
    "http://cdn.example.com/catalog.jpg",
    "javascript:alert(1)",
    "https://user:pass@cdn.example.com/catalog.jpg",
    `https://cdn.example.com/${"x".repeat(501)}`,
  ]) assert.equal(isSafeCatalogImage(image), false, image);

  const unsafe = catalogFixture();
  unsafe[0].image = "http://cdn.example.com/catalog.jpg";
  assert.ok(errorCodes(validateCatalogPayload(unsafe)).includes("unsafe_image_url"));
});

test("a complete legal catalog validates and persists a safe image override", () => {
  const catalog = catalogFixture();
  catalog[0].image = "https://cdn.example.com/products/spotify-v2.webp";
  catalog[0].plans[0].amount = 128.88;
  const validation = validateCatalogPayload(catalog);
  assert.equal(validation.ok, true);

  const overrides = diffToOverrides(validation.catalog);
  assert.equal(overrides.products[catalog[0].key].image, catalog[0].image);
  assert.equal(overrides.products[catalog[0].key].plans[catalog[0].plans[0].id].amount, 128.88);
});
