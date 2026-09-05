import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isUnlimitedNodePlan, unlimitedFairUseNote, unlimitedFairUseTitle } from "../app/lib/fair-use.js";

// The unlimited node plan carries a fair-use note wherever it is described, so
// a customer never meets the rule for the first time after paying. These pin
// the wording, the plan it applies to, and every surface that shows it.

test("the note names the behaviours and the consequence, in both languages", () => {
  const zh = unlimitedFairUseNote("zh");
  assert.ok(zh.includes("防滥用原则"));
  assert.ok(zh.includes("向不同用户共享订阅"));
  assert.ok(zh.includes("长时间大速率入站"));
  assert.ok(zh.includes("公平使用原则"));
  assert.ok(zh.includes("同时在线设备数量/带宽速率"));
  const en = unlimitedFairUseNote("en");
  assert.ok(/anti-abuse/i.test(en));
  assert.ok(/sharing the subscription/i.test(en));
  assert.ok(/inbound traffic/i.test(en));
  assert.ok(/fair use/i.test(en));
  assert.ok(/concurrent devices/i.test(en) && /bandwidth/i.test(en));
  assert.equal(unlimitedFairUseNote(undefined), zh, "Chinese is the default");
  assert.equal(unlimitedFairUseTitle("zh"), "无限套餐提示");
  assert.equal(unlimitedFairUseTitle("en"), "Unlimited plan note");
});

test("only the node product's unlimited plan carries the note", () => {
  assert.equal(isUnlimitedNodePlan("rocket", "unlimited"), true);
  for (const [product, plan] of [["rocket", "luxury"], ["rocket", "basic"], ["rocket", "trial"], ["ai", "unlimited"], ["netflix", "unlimited"], ["rocket", undefined], [undefined, "unlimited"]]) {
    assert.equal(isUnlimitedNodePlan(product, plan), false, `${product}/${plan} must not carry the note`);
  }
});

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [shop, actions, landing, serviceData, guides, checkout, css] = await Promise.all([
  read("../app/shop/page.jsx"),
  read("../app/services/ServiceOrderActions.jsx"),
  read("../app/services/[slug]/page.jsx"),
  read("../app/services/service-data.js"),
  read("../app/guides/guides-data.js"),
  read("../app/checkout/page.jsx"),
  read("../app/globals.css"),
]);

test("every surface that describes the plan renders the shared note, never its own copy", () => {
  for (const [name, source] of [["shop picker", shop], ["service order picker", actions], ["service page", landing], ["checkout", checkout]]) {
    assert.ok(source.includes("unlimitedFairUseNote(locale)"), `${name} must render the shared note`);
    assert.ok(source.includes("unlimitedFairUseTitle(locale)"), `${name} must render the shared title`);
    assert.ok(!source.includes("防滥用"), `${name} must not carry its own copy of the wording`);
  }
  // The pickers show it beneath the plan list only when the unlimited plan is offered.
  assert.ok(shop.includes("getProductPlanOptions(planPickerProduct.key).some((plan) => isUnlimitedNodePlan(planPickerProduct.key, plan.id))"));
  assert.ok(actions.includes("planOptions.some((plan) => isUnlimitedNodePlan(productKey, plan.id))"));
  // The service page attaches it to the unlimited card by plan id, with a static order as fallback.
  assert.ok(landing.includes("isUnlimitedNodePlan(service.key, service.planIds?.[i])"));
  assert.ok(serviceData.includes('planIds: ["basic", "pro", "luxury", "unlimited", "trial"]'));
  // Checkout shows it when the chosen plan is the unlimited one.
  assert.ok(checkout.includes("isUnlimitedNodePlan(item.key, getProductPlan(item.key, planMap[item.key])?.id)"));
});

test("the service page and the buying guide answer it in their FAQ, in both languages", () => {
  for (const [name, source] of [["service data", serviceData], ["guide", guides]]) {
    assert.ok(source.includes('["无限套餐有哪些使用限制？", unlimitedFairUseNote("zh")]'), `${name} zh FAQ`);
    assert.ok(source.includes('["Are there usage limits on the Unlimited plan?", unlimitedFairUseNote("en")]'), `${name} en FAQ`);
  }
  assert.ok(guides.includes("需遵守公平使用原则，见下方问答"));
  assert.ok(guides.includes("fair-use rules apply; see the FAQ below"));
});

test("the note is styled as a small aside, and its title does not inherit the plan card's price styling", () => {
  assert.ok(css.includes(".plan-fair-use-note {"));
  assert.ok(css.includes(".service-plan-note {"));
  // .service-plan-card b makes a 22px block and is declared later in the file,
  // so the note's title rule must outrank it by specificity, not by position.
  assert.ok(!css.includes("\n.service-plan-note b {"), "an unscoped note-title rule loses to the card price rule");
  const start = css.indexOf(".service-plan-card .service-plan-note b {");
  assert.ok(start > 0, "the note title rule must be scoped under the card");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.ok(rule.includes("display: inline"));
  assert.ok(rule.includes("font-size: inherit"));
});
