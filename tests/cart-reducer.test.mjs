import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reduceCartBundle } from "../app/lib/store.js";

test("cart reducer computes add, remove and plan changes without mutating inputs", () => {
  const cart = ["spotify"];
  const plans = { spotify: "spotify-individual-1y" };
  const added = reduceCartBundle(cart, plans, { type: "add", key: "netflix" });
  assert.deepEqual(added.cart, ["spotify", "netflix"]);
  assert.deepEqual(cart, ["spotify"]);
  assert.deepEqual(plans, { spotify: "spotify-individual-1y" });

  const removed = reduceCartBundle(added.cart, added.plans, { type: "remove", key: "spotify" });
  assert.deepEqual(removed.cart, ["netflix"]);
  assert.equal(removed.plans.spotify, undefined);
});

test("quote-only cart action atomically replaces products and plans", () => {
  const next = reduceCartBundle(
    ["spotify", "netflix"],
    { spotify: "spotify-individual-1y", netflix: "netflix-slot-1m" },
    { type: "add", key: "proxy-pay" },
  );
  assert.deepEqual(next, { cart: ["proxy-pay"], plans: {} });
});

test("cart persistence and update broadcasts stay outside React state updaters", async () => {
  const source = await readFile(new URL("../app/lib/store.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setCartState\s*\(\s*\([^)]*\)\s*=>[\s\S]{0,600}?(?:saveCart|saveCartBundle|emitCartUpdate)\s*\(/);
  assert.doesNotMatch(source, /setCartPlansState\s*\(\s*\([^)]*\)\s*=>[\s\S]{0,600}?(?:saveCartPlans|saveCartBundle|emitCartUpdate)\s*\(/);
  assert.match(source, /setCartState\(next\.cart\);\s*setCartPlansState\(next\.plans\);\s*saveCartBundle\(next\.cart, next\.plans\);/);
});
