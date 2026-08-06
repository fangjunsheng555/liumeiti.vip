import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);

test("authoritative settings and catalog loaders reject failed or malformed responses before applying data", async () => {
  const originalFetch = globalThis.fetch;
  const store = await import("../app/lib/store.js");
  const { SETTINGS_DEFAULTS } = await import("../app/lib/settings-defaults.js");
  const originalSettings = store.getSiteSettings();

  try {
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 503 });
    await assert.rejects(
      store.loadSiteSettingsSnapshot(),
      (error) => error?.code === "settings_http_503" && error?.status === 503,
    );
    assert.equal(store.getSiteSettings(), originalSettings, "a 503 must not apply defaults as authoritative settings");

    globalThis.fetch = async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(
      store.loadSiteSettingsSnapshot(),
      (error) => error?.code === "settings_invalid_response",
    );
    assert.equal(store.getSiteSettings(), originalSettings, "invalid JSON must not mutate settings");

    globalThis.fetch = async () => Response.json({ ok: true, settings: {} });
    await assert.rejects(
      store.loadSiteSettingsSnapshot(),
      (error) => error?.code === "settings_invalid_response",
    );

    const authoritativeSettings = structuredClone(SETTINGS_DEFAULTS);
    authoritativeSettings.usdt.address = "TAUTHORITATIVEPAYMENTADDRESS";
    globalThis.fetch = async () => Response.json({ ok: true, settings: authoritativeSettings });
    const loadedSettings = await store.loadSiteSettingsSnapshot();
    assert.equal(loadedSettings.usdt.address, "TAUTHORITATIVEPAYMENTADDRESS");
    assert.equal(store.getSiteSettings().usdt.address, "TAUTHORITATIVEPAYMENTADDRESS");

    globalThis.fetch = async () => Response.json({ ok: true, products: null });
    await assert.rejects(
      store.loadCatalogSnapshot(),
      (error) => error?.code === "catalog_invalid_response",
    );

    globalThis.fetch = async () => Response.json({
      ok: true,
      products: [{
        key: "spotify",
        title: "Authoritative Spotify",
        plans: [{ id: "member", label: "Member", amount: 129, cycle: "1 year", desc: "" }],
      }],
    });
    await store.loadCatalogSnapshot();
    assert.equal(store.catalogOverrideLoaded(), true);
    assert.equal(store.getCatalogProduct("spotify").title, "Authoritative Spotify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state hooks have finite failure states, explicit retry, and preserve legacy return contracts", async () => {
  const source = await readFile(new URL("app/lib/store.js", ROOT), "utf8");
  assert.match(source, /import \{ clientFetch \} from "\.\/client-fetch\.js"/);
  assert.match(source, /export function useSiteSettingsState\(\)/);
  assert.match(source, /export function useCatalogSyncState\(\)/);
  assert.equal((source.match(/ready: false, loading: false, error: snapshotErrorCode/g) || []).length, 2);
  assert.equal((source.match(/const retry = useCallback\(\(\) => setAttempt\(\(value\) => value \+ 1\), \[\]\)/g) || []).length, 2);
  assert.match(source, /return \{ \.\.\.state, settings: state\.data, retry \}/);
  assert.match(source, /return useSiteSettingsState\(\)\.data/);
  assert.match(source, /return useCatalogSyncState\(\)\.version/);
});

test("checkout cannot enter or submit a new payment before both authoritative snapshots are ready", async () => {
  const source = await readFile(new URL("app/checkout/page.jsx", ROOT), "utf8");
  assert.match(source, /const checkoutConfigReady = catalogState\.ready && settingsState\.ready/);
  assert.match(source, /onClick=\{\(\) => \{ catalogState\.retry\(\); settingsState\.retry\(\); \}\}/);
  assert.match(source, /暂时无法读取最新商品价格与收款信息/);

  const goPay = source.slice(source.indexOf("async function goPay"), source.indexOf("async function submitOrders"));
  assert.ok(goPay.indexOf("pendingOrderRef.current") < goPay.indexOf("if (!checkoutConfigReady)"), "an already-paid pending order must remain recoverable");
  assert.ok(goPay.indexOf("if (!checkoutConfigReady)") < goPay.indexOf('fetch("/api/order-quote"'), "new payment quoting must be guarded");

  const submit = source.slice(source.indexOf("async function submitOrders"), source.indexOf("if (!checkoutReady"));
  assert.ok(submit.indexOf("pendingOrderRef.current") < submit.indexOf("if (!checkoutConfigReady)"), "pending replay must run before the new-order guard");
  assert.ok(submit.indexOf("if (!checkoutConfigReady)") < submit.indexOf("createPendingIdempotencyRecord"), "new order persistence must be guarded");
  assert.equal((source.match(/disabled=\{cartCount === 0 \|\| submitting \|\| !accountReady \|\| !checkoutPaymentReady\}/g) || []).length, 2);
  assert.match(source, /disabled=\{submitting \|\| !accountReady \|\| !checkoutPaymentReady\}/);
  assert.match(source, /checkoutPaymentReady && paymentMethod !== "balance"/);
  assert.match(source, /checkoutPaymentReady && paymentMethod === "usdt"/);
  assert.doesNotMatch(source, /USDT_ADDRESS|\/payment\/(?:usdt\.png|alipay\.jpg)/);
  assert.doesNotMatch(source, /siteSettings\.usdt\.address\s*\|\|/);
});

test("checkout requires a verified positive rate only for an actual USDT payment", async () => {
  const source = await readFile(new URL("app/checkout/page.jsx", ROOT), "utf8");
  assert.doesNotMatch(source, /USDT_RATE|useState\(6\.85\)/);
  assert.match(source, /const override = Number\(siteSettings\.usdt\.rateOverride\)/);
  assert.match(source, /Number\.isFinite\(override\) && override > 0/);
  assert.match(source, /!response\.ok \|\| !data\?\.ok \|\| !Number\.isFinite\(rate\) \|\| rate <= 0/);
  assert.match(source, /setUsdtRateState\(\{ rate: 0, ready: false, loading: false, error: code \}\)/);
  assert.match(source, /const requiresUsdtRate = !serviceRedeemActive && paymentMethod === "usdt" && finalCny > 0/);
  assert.match(source, /const checkoutPaymentReady = checkoutConfigReady && \(!requiresUsdtRate \|\| usdtRateReady\)/);
  assert.match(source, /setUsdtRateAttempt\(\(value\) => value \+ 1\)/);
  assert.match(source, /暂时无法读取当前 USDT 汇率/);

  const goPay = source.slice(source.indexOf("async function goPay"), source.indexOf("async function submitOrders"));
  const submit = source.slice(source.indexOf("async function submitOrders"), source.indexOf("if (!checkoutReady"));
  for (const operation of [goPay, submit]) {
    assert.ok(operation.indexOf("pendingOrderRef.current") < operation.indexOf("requiresUsdtRate && !usdtRateReady"));
    assert.match(operation, /requiresUsdtRate && !usdtRateReady/);
  }
});

test("quote payment hides every payment target until settings are authoritative and keeps retry available", async () => {
  const source = await readFile(new URL("app/components/ProxyQuotePayment.jsx", ROOT), "utf8");
  assert.match(source, /const settingsState = useSiteSettingsState\(\)/);
  assert.match(source, /const paymentUiReady = settingsState\.ready && rateReady && !paymentUncertain/);
  assert.match(source, /if \(submitting \|\| !token \|\| !order \|\| !settingsState\.ready\) return/);
  assert.match(source, /settingsState\.error && <button type="button" onClick=\{settingsState\.retry\}/);
  assert.match(source, /disabled=\{submitting \|\| \(!paymentUncertain && \(!settingsState\.ready \|\| !rateReady\)\)\}/);
  assert.match(source, /settingsState\.ready \? settings\.payment\.alipayQr : ""/);
  assert.match(source, /settingsState\.ready \? settings\.payment\.usdtQr : ""/);
  assert.doesNotMatch(source, /\/payment\/(?:usdt\.png|alipay\.jpg)/);
  assert.doesNotMatch(source, /settings\.payment\.(?:alipayQr|usdtQr)\s*\|\|/);
});
