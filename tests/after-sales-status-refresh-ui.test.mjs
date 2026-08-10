import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [serviceCenter, account, styles] = await Promise.all([
  readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8"),
  readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

function afterSalesRefreshBlocks(source) {
  const refreshStart = source.indexOf("async function refreshAfterSalesStatus");
  const effectStart = source.indexOf("useEffect(() => {", refreshStart);
  const submitStart = source.indexOf("async function submitAfterSales", effectStart);
  assert.ok(refreshStart >= 0 && effectStart > refreshStart && submitStart > effectStart);
  return {
    refresh: source.slice(refreshStart, effectStart),
    effect: source.slice(effectStart, submitStart),
  };
}

for (const [name, source] of [["service center", serviceCenter], ["account", account]]) {
  test(`${name} refreshes a pending after-sales ticket without another email verification`, () => {
    assert.match(source, /fetch\("\/api\/after-sales\/status"/);
    assert.match(source, /body: JSON\.stringify\(\{ orderId: order\.orderId, token: order\.afterSalesToken \}\)/);
    assert.match(source, /replaceAfterSalesTicket\(order\.orderId, data\.ticket \|\| null\)/);
    assert.match(source, /window\.addEventListener\("focus", refresh\)/);
    assert.match(source, /document\.addEventListener\("visibilitychange", onVisible\)/);
    assert.match(source, /window\.setInterval\(refresh, 30_000\)/);
    assert.match(source, /className="query-after-sales-refresh"/);
    assert.match(source, /L\("刷新状态", "Refresh"\)/);
    assert.match(source, /too_many_requests:/);
    assert.match(source, /after_sales_store_unavailable:/);
  });
}

for (const [name, source] of [["service center", serviceCenter], ["account", account]]) {
  test(`${name} never polls after-sales status while the page is hidden`, () => {
    const { effect } = afterSalesRefreshBlocks(source);
    assert.match(effect, /const refresh = \(\) => \{\s*if \(document\.visibilityState !== "visible"\) return;/);
    assert.doesNotMatch(effect, /silent: document\.visibilityState !== "visible"/);
    assert.match(effect, /const onVisible = \(\) => \{ if \(document\.visibilityState === "visible"\) refresh\(\); \}/);
  });

  test(`${name} makes verification_required terminal for automatic polling and shows re-verification guidance`, () => {
    const { refresh, effect } = afterSalesRefreshBlocks(source);
    const clearsCapability = /error\?\.code === "verification_required"[\s\S]{0,800}(?:afterSalesToken:\s*""|clearAfterSalesVerification|invalidateAfterSalesToken)/.test(refresh);
    const recordsTerminalState = /error\?\.code === "verification_required"[\s\S]{0,800}(?:verificationRequired|verificationExpired|terminal):\s*true/.test(refresh);
    assert.equal(clearsCapability || recordsTerminalState, true, "verification_required must revoke polling state");
    if (clearsCapability) assert.match(effect, /!order\?\.afterSalesToken/);
    if (recordsTerminalState) assert.match(effect, /afterSalesRefresh\.(?:verificationRequired|verificationExpired|terminal)/);
    assert.match(refresh, /verification_required/);
    assert.match(refresh, /(?:look up the order again|Refresh the account page and retry)/);
  });
}

test("pending-ticket refresh stays compact on desktop and mobile", () => {
  assert.match(styles, /\.query-after-sales-pending\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.query-after-sales-refresh\s*\{/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.query-after-sales-refresh\s*\{\s*grid-column:\s*2;/);
});
