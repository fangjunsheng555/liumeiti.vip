import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("service-center order query keeps a visible, explicit accessible label", () => {
  assert.match(page, /htmlFor="service-order-query-input"/);
  assert.match(page, /id="service-order-query-input"/);
  assert.match(page, /aria-label=\{L\("完整订单号或下单邮箱"/);
  assert.doesNotMatch(css, /\.order-query-field span\s*\{\s*display:\s*none\s*!important/);
});

test("mobile service query heading owns a full-width stacked layout", () => {
  assert.match(page, /section-head simple-head service-query-head/);
  assert.match(css, /\.service-query-head\s*\{[\s\S]*?flex-direction:\s*column\s*!important/);
  assert.match(css, /\.service-query-head \.section-title\s*\{[\s\S]*?word-break:\s*keep-all/);
});
