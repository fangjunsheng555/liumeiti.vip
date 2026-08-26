import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rocketSubscriptionUrl, readRocketSubscriptionUrl } from "../app/lib/rocket-subscription.js";

// A node order hands out exactly one subscription URL: the Clash-format list
// addressed by the order number. Every supported client reads it, so a second
// link only gave customers a way to import the wrong one.

const ORDER_ID = "LM11BD1CB30341DFFD6B05";
const EXPECTED = `https://hk.joinvip.vip:2056/sub/${ORDER_ID}?format=clash`;

test("the subscription URL is the order number in Clash format", () => {
  assert.equal(rocketSubscriptionUrl(ORDER_ID), EXPECTED);
});

test("an order without a number yields no link rather than a broken one", () => {
  for (const value of [null, undefined, "", "   ", 0, false, {}, []]) {
    assert.equal(rocketSubscriptionUrl(value), "", `${JSON.stringify(value)} must produce no link`);
  }
});

test("stray whitespace around an order number does not reach the URL", () => {
  assert.equal(rocketSubscriptionUrl(`  ${ORDER_ID}  `), EXPECTED);
  assert.equal(rocketSubscriptionUrl(`LM11BD1CB3 0341DFFD6B05`), EXPECTED);
});

test("an order stored before this change still resolves to one link", () => {
  // Records written by the previous release held a { shadowrocket, clash } pair.
  const legacy = {
    shadowrocket: `https://hk.joinvip.vip:2056/sub/${ORDER_ID}`,
    clash: EXPECTED,
  };
  assert.equal(readRocketSubscriptionUrl(legacy), EXPECTED);
  // A pair missing its Clash half still has to produce the Clash list.
  assert.equal(readRocketSubscriptionUrl({ shadowrocket: `https://hk.joinvip.vip:2056/sub/${ORDER_ID}` }), EXPECTED);
});

test("a stored value of any other shape reads as no link", () => {
  for (const value of [null, undefined, 7, true, [EXPECTED], {}, { clash: 5 }]) {
    assert.equal(readRocketSubscriptionUrl(value), "", `${JSON.stringify(value)} must read as no link`);
  }
});

test("a value already in the new shape passes through untouched", () => {
  assert.equal(readRocketSubscriptionUrl(EXPECTED), EXPECTED);
});

// ── No caller may reconstruct the URL or reach for the retired fields ──────

const APP_FILES = [
  "app/lib/store.js",
  "app/checkout/page.jsx",
  "app/account/page.jsx",
  "app/service-center/page.jsx",
  "app/admin/page.jsx",
  "app/admin/DeliveryWorkbench.jsx",
  "app/api/order/route.js",
  "app/api/order/completion-email.js",
  "app/api/order/email-template.js",
  "app/api/order-query/route.js",
  "app/api/auth/me/route.js",
  "app/api/admin/orders/route.js",
  "app/api/admin/orders/[orderId]/route.js",
  "app/api/admin/after-sales/reference-notification-email.js",
  "app/api/admin/after-sales/notify-by-reference/route.js",
];

const sources = new Map();
for (const file of APP_FILES) {
  sources.set(file, await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
}

test("no page or route still reads the retired shadowrocket and clash fields", () => {
  for (const [file, source] of sources) {
    assert.ok(!/\.shadowrocket\b/.test(source), `${file} still reads .shadowrocket`);
    assert.ok(!/\.clash\b/.test(source), `${file} still reads .clash`);
  }
});

const ownerSource = await readFile(new URL("../app/lib/rocket-subscription.js", import.meta.url), "utf8");

test("the subscription host appears only in the module that owns it", () => {
  // Six routes used to build this URL by hand, and half of them keyed it on the
  // delivered account rather than the order number, so one order could be shown
  // two different links depending on the page.
  for (const [file, source] of sources) {
    assert.ok(!source.includes("hk.joinvip.vip"), `${file} builds the subscription URL itself`);
  }
  assert.ok(ownerSource.includes("hk.joinvip.vip:2056/sub/"));
});

test("every generated link is keyed on the order number", () => {
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/rocketSubscriptionUrl\(([^)]*)\)/g)) {
      assert.match(
        match[1],
        /orderId/,
        `${file} builds a link from ${match[1] || "nothing"} instead of the order number`,
      );
    }
  }
});
