import test from "node:test";
import assert from "node:assert/strict";
import { axisScale } from "../app/admin/chart-axis-scale.js";

test("an all-zero admin trend exposes only the real zero tick", () => {
  assert.deepEqual(axisScale(0, 4, true), { max: 1, ticks: [0] });
  assert.deepEqual(axisScale("", 4, false), { max: 1, ticks: [0] });
});

test("non-zero order and revenue trends keep useful rounded scales", () => {
  assert.deepEqual(axisScale(3, 4, true), { max: 4, ticks: [0, 1, 2, 3, 4] });
  assert.deepEqual(axisScale(188, 4, false), { max: 200, ticks: [0, 50, 100, 150, 200] });
});
