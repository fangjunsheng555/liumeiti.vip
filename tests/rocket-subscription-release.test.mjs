import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  customerSubscriptionUrl,
  readRocketSubscriptionUrl,
  rocketSubscriptionUrl,
} from "../app/lib/rocket-subscription.js";

// A node order's subscription URL is released only once the order is completed
// — before that the panel user does not exist and the address serves an empty
// list — and the address itself is the one the panel issued, not one the site
// composed. These pin both rules and the copy that goes with them.

const ORDER_ID = "LM7D4E5F6A7B8C9D0E1F";
const PLAIN = `https://hk.joinvip.vip:2056/sub/${ORDER_ID}`;
const PANEL_ISSUED = `https://hk-2.joinvip.vip:2056/sub/${ORDER_ID}`;

test("nothing is released before the order is completed", () => {
  for (const status of ["awaiting_quote", "pending_payment", "quote_expired", "received", "invalid", undefined, ""]) {
    assert.equal(
      customerSubscriptionUrl({ status, orderId: ORDER_ID, stored: PANEL_ISSUED }),
      "",
      `status ${JSON.stringify(status)} must release no link, even with one already recorded`,
    );
  }
});

test("a completed order serves the address the panel issued", () => {
  assert.equal(customerSubscriptionUrl({ status: "completed", orderId: ORDER_ID, stored: PANEL_ISSUED }), PANEL_ISSUED);
});

test("an order with nothing recorded falls back to the built address", () => {
  // Completed before provisioning existed, or provisioning has not succeeded
  // yet: the customer still gets a usable link rather than a blank row.
  for (const stored of [undefined, null, "", " ", {}, [], 7]) {
    assert.equal(
      customerSubscriptionUrl({ status: "completed", orderId: ORDER_ID, stored }),
      PLAIN,
      `stored ${JSON.stringify(stored)} must fall back to the built address`,
    );
  }
  assert.equal(customerSubscriptionUrl({ status: "completed", orderId: "", stored: "" }), "");
});

test("every historical shape resolves to the plain landing address", () => {
  // Orders written before this change stored a client-format URL, and older
  // ones a pair of them. One customer must never see a different link from
  // another for the same order.
  assert.equal(readRocketSubscriptionUrl(`${PLAIN}?format=clash`), PLAIN);
  assert.equal(readRocketSubscriptionUrl({ clash: `${PLAIN}?format=clash`, shadowrocket: PLAIN }), PLAIN);
  assert.equal(readRocketSubscriptionUrl({ shadowrocket: PLAIN }), PLAIN);
  assert.equal(readRocketSubscriptionUrl(`${PLAIN}?format=json`), PLAIN);
  assert.equal(customerSubscriptionUrl({ status: "completed", orderId: ORDER_ID, stored: `${PLAIN}?format=clash` }), PLAIN);
});

test("the built address carries no client-format query", () => {
  assert.equal(rocketSubscriptionUrl(ORDER_ID), PLAIN);
  assert.equal(rocketSubscriptionUrl(ORDER_ID).includes("format="), false);
});

// ── Wiring ─────────────────────────────────────────────────────────────────

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [orderRoute, orderQuery, authMe, completionEmail, orderEmail, provisionRoute, account, serviceCentre, checkout] = await Promise.all([
  read("../app/api/order/route.js"),
  read("../app/api/order-query/route.js"),
  read("../app/api/auth/me/route.js"),
  read("../app/api/order/completion-email.js"),
  read("../app/api/order/email-template.js"),
  read("../app/api/admin/orders/[orderId]/route.js"),
  read("../app/account/page.jsx"),
  read("../app/service-center/page.jsx"),
  read("../app/checkout/page.jsx"),
]);

test("checkout mints no subscription URL", () => {
  // The confirmation email and the Telegram notice are built from the order as
  // created, so not writing the field is what keeps the link out of both.
  assert.doesNotMatch(orderRoute, /it\.subscriptionLinks = /);
  assert.match(orderRoute, /No subscription URL is minted here/);
});

test("every customer surface releases the link through the one gate", () => {
  for (const [name, source] of [
    ["order query", orderQuery],
    ["account feed", authMe],
    ["completion email", completionEmail],
    ["order email", orderEmail],
    ["telegram notice", orderRoute],
  ]) {
    assert.match(source, /customerSubscriptionUrl\(\{ status: order\.status, orderId: order\.orderId, stored:/, name);
    // No surface may build the address itself and skip the completion check.
    assert.doesNotMatch(source, /rocketSubscriptionUrl\(/, name);
  }
});

test("provisioning records the panel's own address on the order", () => {
  assert.match(provisionRoute, /if \(result\.ok && result\.subLink\) \{/);
  assert.match(provisionRoute, /for \(const item of nodeItemsOf\(order\)\) item\.subscriptionLinks = clean\(result\.subLink, 300\);/);
  assert.match(provisionRoute, /subLink: result\.ok \? clean\(result\.subLink, 300\)/);
  // Editing an item must not overwrite what the panel issued with a guess.
  assert.match(provisionRoute, /if \(service === "rocket" && !readRocketSubscriptionUrl\(it\.subscriptionLinks\)\) \{/);
});

test("the panel is provisioned before the completion email, and saved after it", () => {
  // The email must carry the address the panel issued, and the panel user
  // must exist by the time the customer opens it — so provisioning runs
  // first. Its outcome is saved after the email: a stale-revision conflict on
  // that save must not cost the customer their email.
  const provision = provisionRoute.indexOf('trigger: "completion"');
  const save = provisionRoute.indexOf("const provisionSaved = await setOrderAt(");
  assert.ok(provision > 0 && save > 0, "provisioning and its save must both be present");
  // The first-run completion email is the one sent between the two. (The
  // idempotent replay branch earlier in the handler re-delivers an email
  // whose one-shot key already exists; it provisions nothing.)
  const email = provisionRoute.indexOf(":completed-email`", provision);
  assert.ok(email > provision && email < save, "the completion email is sent after provisioning and before its outcome is saved");
});

test("the link is introduced as something to open, in both languages", () => {
  const ZH = "浏览器打开下方链接以使用服务";
  const EN = "Open this link in a browser to use the service";
  for (const [name, source] of [
    ["completion email", completionEmail],
    ["order email", orderEmail],
    ["account", account],
    ["service centre", serviceCentre],
    ["checkout", checkout],
  ]) {
    assert.ok(source.includes(ZH), `${name} must introduce the link as something to open`);
    assert.ok(source.includes(EN), `${name} must carry the English wording`);
  }
  assert.ok(orderRoute.includes(ZH));
  // The bare old label must not survive anywhere a customer reads.
  for (const [name, source] of [["account", account], ["service centre", serviceCentre], ["checkout", checkout]]) {
    assert.doesNotMatch(source, /L\("订阅链接"/, name);
  }
});
