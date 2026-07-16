import assert from "node:assert/strict";
import test from "node:test";

import {
  getLocalizedServicePlanCopy,
  localizeServicePlanCycle,
} from "../app/services/service-data.js";

test("English plan copy is selected by stable catalog id", () => {
  const reorderedCatalogPlans = ["family", "member", "duo", "individual"];
  assert.deepEqual(
    reorderedCatalogPlans.map((id) => getLocalizedServicePlanCopy("spotify", id, "en").name),
    ["Family", "Family Member", "Duo", "Individual"],
  );
  assert.equal(getLocalizedServicePlanCopy("airport-node", "trial", "en").description, "10 GB trial traffic");
});

test("new catalog plans use their own copy instead of an adjacent translation", () => {
  assert.deepEqual(
    getLocalizedServicePlanCopy("spotify", "student", "en", {
      label: "学生套餐",
      description: "后台新增规格",
    }),
    { name: "学生套餐", description: "后台新增规格" },
  );
});

test("plan cycles are localized semantically", () => {
  assert.equal(localizeServicePlanCycle("1年", "en"), "yr");
  assert.equal(localizeServicePlanCycle("三个月", "en"), "3 mo");
  assert.equal(localizeServicePlanCycle("次", "en"), "one-time");
  assert.equal(localizeServicePlanCycle("1年", "zh"), "年");
});
