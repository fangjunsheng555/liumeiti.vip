import assert from "node:assert/strict";
import test from "node:test";

import { catalogVersionDiff } from "../app/api/_catalog-versions.js";

test("catalog version diff reports changed products and fields", () => {
  const before = { products: { spotify: { title: "Spotify", plans: { family: { amount: 128 } } } } };
  const after = { products: { spotify: { title: "Spotify", plans: { family: { amount: 138 } } }, netflix: { active: false } } };
  const result = catalogVersionDiff(before, after);

  assert.deepEqual(result.productKeys, ["netflix", "spotify"]);
  assert.equal(result.productCount, 2);
  assert.equal(result.fieldCount, 2);
  assert.equal(result.changes.some((item) => item.path === "products.spotify.plans.family.amount" && item.after === "138"), true);
});

test("catalog version diff is empty for equivalent snapshots", () => {
  const value = { products: { ai: { plans: { quarter: { amount: 229 } } } } };
  assert.deepEqual(catalogVersionDiff(value, structuredClone(value)), {
    productKeys: [],
    productCount: 0,
    fieldCount: 0,
    changes: [],
  });
});
