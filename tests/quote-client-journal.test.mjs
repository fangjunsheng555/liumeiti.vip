import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("quote checkout persists and dispatches an exact identity-bound request", async () => {
  const source = await readFile(new URL("../app/components/ProxyPaymentCheckout.jsx", import.meta.url), "utf8");
  assert.match(source, /createPendingIdempotencyRecord\(null, "quote-order", currentPayload/);
  assert.match(source, /restorePendingIdempotencyRecord\(stored, "quote-order"\)/);
  assert.match(source, /expectedAccountEmail: currentAccount/);
  assert.match(source, /expectedAccountLifecycleId: currentLifecycle/);
  assert.match(source, /validQuoteOperationIdentity\(restored\.record\.identity\)/);
  assert.match(source, /credentials: originalAccount \? "same-origin" : "omit"/);
  assert.match(source, /"X-Order-Expected-Account": originalAccount \|\| "__guest__"/);
  assert.match(source, /"X-Operation-Expected-Lifecycle": originalAccount \? originalLifecycle : "__guest__"/);
  assert.match(source, /body: JSON\.stringify\(exactPayload\)/);
  assert.match(source, /withCheckoutSubmissionCoordination\(callback\)/);
  assert.match(source, /completeSinglePendingOperation\([\s\S]*?operation\.key,[\s\S]*?completed/);
  assert.doesNotMatch(source, /localStorage\.setItem\(QUOTE_ORDER_PENDING_KEY, JSON\.stringify\(completed\)\)/);
  assert.match(source, /setForm\(visibleQuoteForm\(restored\.record\.payload\)\)/);
  assert.match(source, /else if \(!sameVisibleQuoteForm\(pending\.payload, form\)\)/);
  assert.doesNotMatch(source, /return callback\(\)/);
  assert.match(source, /window\.localStorage\.getItem\(QUOTE_ORDER_PENDING_KEY\) !== encoded/);
  assert.doesNotMatch(source, /readIdempotencyRequest/);
});

test("quote checkout serializes tabs and lets a confirmed completion yield to a new identity", async () => {
  const source = await readFile(new URL("../app/components/ProxyPaymentCheckout.jsx", import.meta.url), "utf8");
  const lock = source.indexOf("await withQuoteOrderLock(async () => {");
  const storageRead = source.indexOf("stored = JSON.parse", lock);
  const staleRefFallback = source.indexOf("if (!pending && requestRef.current)", storageRead);
  const completed = source.indexOf("if (pending.completed)", staleRefFallback);
  const completionProof = source.indexOf("!pending.result?.orderId", completed);
  const unresolvedIdentity = source.indexOf("else if (originalAccount !== currentAccount)", completed);
  const createFresh = source.indexOf("if (!pending) {", unresolvedIdentity);
  assert.ok(lock >= 0);
  assert.ok(storageRead > lock, "the persisted cross-tab record must be authoritative");
  assert.ok(staleRefFallback > storageRead);
  assert.ok(completed > staleRefFallback);
  assert.ok(completionProof > completed, "a completion marker needs a server result before it can be replaced");
  assert.ok(unresolvedIdentity > completionProof, "only unresolved requests should bind the original account");
  assert.ok(createFresh > unresolvedIdentity, "a confirmed A completion must allow B to create a new request");
});

test("quote order checks persisted account identity before operation lookup", async () => {
  const source = await readFile(new URL("../app/api/quote-orders/route.js", import.meta.url), "utf8");
  const headerRead = source.indexOf('request.headers.get("x-order-expected-account")');
  const mismatch = source.indexOf('error: "operation_identity_changed"');
  const operationLookup = source.indexOf("findOrderCreationByIdempotencyKey(serverOperationId, requestHash)");
  assert.ok(headerRead >= 0);
  assert.ok(mismatch > headerRead);
  assert.ok(operationLookup > mismatch);
  assert.match(source, /expectedIdentityHeader === "__guest__" \? "" : expectedIdentityHeader/);
});
