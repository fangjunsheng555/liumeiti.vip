import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createPendingIdempotencyRecord,
  idempotencyFingerprint,
  isExplicitTerminalIdempotencyResponse,
  nextIdempotencyRequest,
  restorePendingIdempotencyRecord,
} from "../app/lib/idempotency.js";
import {
  clearSinglePendingOperation,
  prepareSinglePendingOperation,
} from "../app/lib/single-pending-journal.js";

test("equivalent payloads reuse one idempotency key across retries", () => {
  const first = nextIdempotencyRequest(null, "transfer", { amount: 50, email: "to@example.com" }, 1_000);
  const retry = nextIdempotencyRequest(first, "transfer", { email: "to@example.com", amount: 50 }, 2_000);
  const changed = nextIdempotencyRequest(first, "transfer", { amount: 51, email: "to@example.com" }, 2_000);
  assert.equal(retry.key, first.key);
  assert.notEqual(changed.key, first.key);
  assert.equal(
    idempotencyFingerprint("order", { b: 2, a: { d: 4, c: 3 } }),
    idempotencyFingerprint("order", { a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("a pending request survives a lost response, reload, and more than 24 hours", () => {
  const values = new Map();
  const firstSessionStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const payload = { amount: 100 };
  const identity = { accountEmail: "payer@example.com" };
  const legacyPayload = { accountEmail: identity.accountEmail, ...payload };
  const record = createPendingIdempotencyRecord(null, "money-withdraw", payload, { identity, now: 10_000 });
  firstSessionStorage.setItem("withdraw-key", JSON.stringify(record));

  // Model a later browser session backed by the same localStorage after the
  // server may have committed but its response never reached the client.
  const laterSessionStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const moreThanTwentyFourHoursLater = 10_000 + 25 * 60 * 60 * 1000;
  const recovered = prepareSinglePendingOperation(
    laterSessionStorage,
    "withdraw-key",
    "money-withdraw",
    payload,
    { identity, legacyPayload },
  );

  assert.equal(recovered.idempotencyRequest.key, record.idempotencyRequest.key);

  // Only an explicit terminal outcome (success or user cancellation) removes
  // the pending record and permits a future attempt to receive a new key.
  clearSinglePendingOperation(laterSessionStorage, "withdraw-key", recovered.idempotencyRequest.key);
  assert.equal(laterSessionStorage.getItem("withdraw-key"), null);
  assert.notEqual(
    nextIdempotencyRequest(null, "money-withdraw", legacyPayload, moreThanTwentyFourHoursLater + 1).key,
    record.idempotencyRequest.key,
  );
});

test("checkout reload replays the exact persisted quote payload and original key", () => {
  const originalPayload = {
    email: "buyer@example.com",
    contact: "buyer-contact",
    remark: "",
    expectedAccountEmail: "payer@example.com",
    paymentMethod: "usdt",
    paymentQuoteToken: "quote-token-original",
    redeemCode: "",
    inviteCode: "",
    items: [{ service: "spotify", account: "", password: "", plan: "member" }],
  };
  const pending = createPendingIdempotencyRecord(null, "checkout-order", originalPayload, {
    identity: { accountEmail: "payer@example.com" },
    metadata: {
      cart: ["spotify"],
      paymentQuote: { usdtNonce: 0.0012, usdtPrecision: 4, paymentAdjustment: 0 },
    },
    now: 10_000,
  });

  // A refresh serializes through localStorage. Meanwhile a newly requested
  // quote may exist in live React state, but it must not replace the journal.
  const fromLocalStorage = JSON.parse(JSON.stringify(pending));
  const livePayloadAfterRefresh = { ...originalPayload, paymentQuoteToken: "quote-token-new" };
  const restored = restorePendingIdempotencyRecord(fromLocalStorage, "checkout-order");

  assert.equal(restored.ok, true);
  assert.deepEqual(restored.record.payload, originalPayload);
  assert.equal(restored.record.payload.paymentQuoteToken, "quote-token-original");
  assert.equal(restored.record.idempotencyRequest.key, pending.idempotencyRequest.key);

  // Demonstrate the regression: rebuilding from the new quote would mint a
  // different operation. The restored record instead supplies old body+key.
  const wrongNewAttempt = createPendingIdempotencyRecord(
    pending.idempotencyRequest,
    "checkout-order",
    livePayloadAfterRefresh,
    { identity: { accountEmail: "payer@example.com" }, now: 20_000 },
  );
  assert.notEqual(wrongNewAttempt.idempotencyRequest.key, pending.idempotencyRequest.key);
  assert.equal(restored.record.idempotencyRequest.key, pending.idempotencyRequest.key);
});

test("tampered pending checkout fails closed instead of authorizing a new key", () => {
  const pending = createPendingIdempotencyRecord(null, "checkout-order", {
    email: "buyer@example.com",
    paymentMethod: "alipay",
    paymentQuoteToken: "quote-a",
    items: [{ service: "ai", plan: "gpt-pro" }],
  }, { identity: { accountEmail: "" }, now: 30_000 });
  const tampered = JSON.parse(JSON.stringify(pending));
  tampered.payload.paymentQuoteToken = "quote-b";

  const restored = restorePendingIdempotencyRecord(tampered, "checkout-order");
  assert.equal(restored.ok, false);
  assert.equal(restored.error, "pending_fingerprint_mismatch");
});

test("only an explicit terminal order response permits pending cleanup", () => {
  assert.equal(isExplicitTerminalIdempotencyResponse(200, { ok: true, orderId: "LM1" }), true);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "payment_quote_required" }), true);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "insufficient_balance" }), true);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "invalid_storage_response" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "invalid_operation_record" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "unknown", ambiguous: true }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "idempotency_key_required" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "operation_identity_required" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "invalid_expected_account" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "operation_lifecycle_required" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, { ok: false, error: "account_lifecycle_changed" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(409, { ok: false, error: "operation_identity_mismatch" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(401, { ok: false, error: "session_revoked" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(403, { ok: false, error: "account_banned" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(409, { ok: false, error: "idempotency_conflict" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(429, { ok: false, error: "too_many_attempts" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(503, { ok: false, error: "storage_unavailable" }), false);
  assert.equal(isExplicitTerminalIdempotencyResponse(200, null), false);
});

test("checkout success is completed once by the exact-request dispatcher", async () => {
  const source = await readFile(new URL("../app/checkout/page.jsx", import.meta.url), "utf8");
  const journalSource = await readFile(new URL("../app/lib/checkout-pending-journal.js", import.meta.url), "utf8");
  const dispatchStart = source.indexOf("async function dispatchExactOrder");
  const replayStart = source.indexOf("async function replayPendingOrder", dispatchStart);
  const goPayStart = source.indexOf("async function goPay", replayStart);
  const submitStart = source.indexOf("async function submitOrders");
  const renderStart = source.indexOf("if (!checkoutReady", submitStart);
  assert.ok(dispatchStart >= 0 && replayStart > dispatchStart);
  assert.ok(goPayStart > replayStart && submitStart > goPayStart && renderStart > submitStart);

  const dispatchSource = source.slice(dispatchStart, replayStart);
  const replaySource = source.slice(replayStart, goPayStart);
  const goPaySource = source.slice(goPayStart, submitStart);
  const submitSource = source.slice(submitStart, renderStart);
  assert.match(dispatchSource, /if \(data\?\.ok\) \{\s*finishOrderSubmission\(data, payload, operation\.key\);/);
  assert.match(dispatchSource, /credentials: originalAccount \? "same-origin" : "omit"/);
  assert.match(dispatchSource, /"X-Order-Expected-Account": originalAccount\.toLowerCase\(\) \|\| "__guest__"/);
  assert.match(replaySource, /await withCheckoutSubmissionCoordination\(\(\) => dispatchExactOrder\(pending\)\)/);
  assert.match(submitSource, /expectedAccountEmail: authedUser\?\.email \|\| ""/);
  assert.match(source, /action:\s*mustReauthenticate\s*\?\s*"reauthenticate"/);
  assert.match(source, /mustSignOutForGuest\s*\?\s*"logout-guest"/);
  assert.match(source, /await replayPendingOrder\(pending, account\.email\)/);
  assert.ok(goPaySource.indexOf("await replayPendingOrder(pending)") < goPaySource.indexOf('fetch("/api/order-quote"'));
  assert.match(submitSource, /await withCheckoutSubmissionCoordination\(async \(\) => \{/);
  assert.match(submitSource, /const snapshot = readCheckoutPendingJournals\(window\.localStorage\)/);
  assert.match(submitSource, /const persisted = writeCheckoutPendingJournal\(window\.localStorage, pending\)/);
  assert.match(submitSource, /await dispatchExactOrder\(persisted\.record\);/);
  assert.match(journalSource, /navigator\?\.locks\?\.request/);
  assert.match(source, /window\.addEventListener\("storage", syncPendingJournal\)/);
  assert.match(source, /CHECKOUT_PENDING_LEGACY_KEY/);
  assert.match(source, /error: "checkout_journal_restore_failed"/);
  assert.match(source, /orderRequestRef\.current = null/);
  assert.doesNotMatch(submitSource, /\bdata\./);
});

test("order identity binding is checked before any idempotency lookup", async () => {
  const source = await readFile(new URL("../app/api/order/route.js", import.meta.url), "utf8");
  const headerRead = source.indexOf('request.headers.get("x-order-expected-account")');
  const bodyHeaderMismatch = source.indexOf('error: "operation_identity_mismatch"');
  const cookieMismatch = source.indexOf('error: "operation_identity_changed"');
  const lookup = source.indexOf("findOrderCreationByIdempotencyKey(serverOperationId, requestHash)");
  assert.ok(headerRead >= 0);
  assert.ok(bodyHeaderMismatch > headerRead);
  assert.ok(cookieMismatch > bodyHeaderMismatch);
  assert.ok(lookup > cookieMismatch);
  assert.match(source, /expectedIdentityHeader === "__guest__" \? "" : expectedIdentityHeader/);
});
