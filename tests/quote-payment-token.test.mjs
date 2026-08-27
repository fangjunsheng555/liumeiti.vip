import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "auth-secret-value-for-quote-token-tests-32chars";

const { signSession } = await import("../app/api/_utils.js");
const { paymentToken } = await import("../app/api/quote-orders/[orderId]/route.js");

// The quote payment link carries a signed capability that the route only ever
// compares by hash. Reading it must return it whole: a token shortened by even
// one character hashes to a value that can never match, and the customer is
// told their payment link is invalid with no way to recover.

function realToken(orderId = "LMD41BD151A01A07766992") {
  return signSession({
    typ: "quote-payment-link",
    orderId,
    mutationId: randomBytes(16).toString("hex"),
    mutationHash: createHash("sha256").update("payload").digest("hex"),
    itemIndex: -1,
  });
}

const hash = (value) => createHash("sha256").update(String(value || "")).digest("hex");

function request(headers = {}) {
  return new Request("https://www.liumeiti.vip/api/quote-orders/LMD41BD151A01A07766992", { headers });
}

test("a real payment token is far longer than a short field cap", () => {
  // The regression this guards: the token was read with a 200-character cap,
  // which silently truncated every one of them.
  const token = realToken();
  assert.ok(token.length > 200, `expected a long token, got ${token.length} characters`);
});

test("the token survives the Authorization header whole", () => {
  const token = realToken();
  const read = paymentToken(request({ authorization: `Bearer ${token}` }));
  assert.equal(read, token);
  assert.equal(hash(read), hash(token));
});

test("the token survives the request body whole", () => {
  const token = realToken();
  const read = paymentToken(request(), { token });
  assert.equal(read, token);
  assert.equal(hash(read), hash(token));
});

test("both ways of sending the same token read identically", () => {
  // The page loads over the header and submits over the body. When the two
  // disagreed, the quote opened and then refused every payment.
  const token = realToken();
  assert.equal(
    paymentToken(request({ authorization: `Bearer ${token}` })),
    paymentToken(request(), { token }),
  );
});

test("the header wins when both carry a token", () => {
  const header = realToken();
  const body = realToken();
  assert.equal(paymentToken(request({ authorization: `Bearer ${header}` }), { token: body }), header);
});

test("a missing or malformed token reads as empty rather than as something", () => {
  assert.equal(paymentToken(request()), "");
  assert.equal(paymentToken(request(), {}), "");
  assert.equal(paymentToken(request(), { token: "" }), "");
  assert.equal(paymentToken(request(), { token: null }), "");
  assert.equal(paymentToken(request(), { token: undefined }), "");
  assert.equal(paymentToken(request({ authorization: "Bearer" })), "");
  assert.equal(paymentToken(request({ authorization: "Basic abc" }), {}), "");
});

test("the bearer prefix is accepted whatever its casing or spacing", () => {
  const token = realToken();
  for (const header of [`Bearer ${token}`, `bearer ${token}`, `BEARER  ${token}`, `Bearer ${token}  `]) {
    assert.equal(paymentToken(request({ authorization: header })), token, `failed for ${header.slice(0, 10)}`);
  }
});

test("nothing in the route caps the token below its real length", async () => {
  const source = await readFile(new URL("../app/api/quote-orders/[orderId]/route.js", import.meta.url), "utf8");
  for (const match of source.matchAll(/clean\(\s*(?:body\?\.)?token[^,]*,\s*(\d+)\s*\)/g)) {
    assert.ok(
      Number(match[1]) >= 1000,
      `the token is read with a ${match[1]}-character cap, which truncates it`,
    );
  }
  // Both handlers must go through the one reader, or they can drift apart again.
  assert.equal((source.match(/const token = paymentToken\(request/g) || []).length, 2);
  assert.ok(!/auth\.slice\(/.test(source), "a handler still slices the header itself");
});
