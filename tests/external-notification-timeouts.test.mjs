import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const targets = [
  ["app/api/order/route.js", 2],
  ["app/api/quote-orders/route.js", 2],
  ["app/api/quote-orders/[orderId]/route.js", 2],
  ["app/api/admin/orders/[orderId]/route.js", 1],
];

test("order Telegram and webhook requests have a finite server-side deadline", async () => {
  for (const [file, expected] of targets) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const deadlines = source.match(/AbortSignal\.timeout\(8000\)/g) || [];
    assert.ok(
      deadlines.length >= expected,
      `${file} must apply an 8-second deadline to every audited external notification request`,
    );
  }
});
