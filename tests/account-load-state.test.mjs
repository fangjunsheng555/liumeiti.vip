import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requestAccountLoad } from "../app/account/load-account.js";

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function assertRetryableFailure(result, expectedText) {
  assert.equal(result.loading, false);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.retry, true);
  assert.match(result.error, expectedText);
}

test("/api/auth/me 503 exits account loading with a readable retry state", async () => {
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => url.endsWith("/me")
      ? jsonResponse(503, { ok: false, error: "auth_record_invalid" })
      : jsonResponse(200, { ok: true, balance: 0 }),
  });
  assertRetryableFailure(result, /账户服务暂时不可用/);
});

test("/api/auth/me 401 exits loading into the signed-out account state", async () => {
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => url.endsWith("/me")
      ? jsonResponse(401, { ok: false, error: "unauthorized" })
      : jsonResponse(200, { ok: true, balance: 0 }),
  });
  assert.equal(result.loading, false);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.retry, false);
  assert.equal(result.guest, true);
  assert.equal(result.status, 401);
  assert.equal(result.error, "");
  assert.equal(result.state?.loading, false);
  assert.equal(result.state?.email, null);
});

for (const { status, expectedText } of [
  { status: 403, expectedText: /无法读取账户信息/ },
  { status: 409, expectedText: /无法读取账户信息/ },
  { status: 500, expectedText: /账户服务暂时不可用/ },
]) {
  test(`/api/auth/me ${status} exits loading with a readable retry state`, async () => {
    const result = await requestAccountLoad({
      timeoutMs: 100,
      fetchImpl: async (url) => url.endsWith("/me")
        ? jsonResponse(status, { ok: false, error: `http_${status}` })
        : jsonResponse(200, { ok: true, balance: 0 }),
    });
    assertRetryableFailure(result, expectedText);
  });
}

test("an invalid JSON /api/auth/me response exits account loading", async () => {
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => url.endsWith("/me")
      ? { status: 200, ok: true, async json() { throw new SyntaxError("bad json"); } }
      : jsonResponse(200, { ok: true, balance: 0 }),
  });
  assertRetryableFailure(result, /无法读取账户信息/);
});

test("a rejected account request exits account loading", async () => {
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => {
      if (url.endsWith("/me")) throw new TypeError("network disconnected");
      return jsonResponse(200, { ok: true, balance: 0 });
    },
  });
  assertRetryableFailure(result, /账户信息加载失败/);
});

test("a request that never settles exits through the helper deadline", async () => {
  const startedAt = Date.now();
  const result = await requestAccountLoad({
    timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}),
  });
  assertRetryableFailure(result, /账户信息读取超时/);
  assert.ok(Date.now() - startedAt < 500, "the test must prove a finite deadline, not wait for the mock");
});

test("post-auth account load accepts only the exact email and lifecycle returned by the mutation", async () => {
  const lifecycle = "a".repeat(32);
  const matching = await requestAccountLoad({
    timeoutMs: 100,
    expectedIdentity: { email: "old@example.com", accountLifecycleId: lifecycle },
    fetchImpl: async (url) => url.endsWith("/me")
      ? jsonResponse(200, { ok: true, email: "OLD@example.com", accountLifecycleId: lifecycle, orders: [], balance: 0 })
      : jsonResponse(200, { ok: true, email: "old@example.com", accountLifecycleId: lifecycle, balance: 0, transactions: [], withdrawals: [], coupons: [] }),
  });
  assert.equal(matching.ok, true);
  assert.equal(matching.state.email, "OLD@example.com");
  assert.equal(matching.state.financeReady, true);

  for (const me of [
    { ok: true, email: "other@example.com", accountLifecycleId: lifecycle, orders: [], balance: 0 },
    { ok: true, email: "old@example.com", accountLifecycleId: "b".repeat(32), orders: [], balance: 0 },
  ]) {
    const mismatch = await requestAccountLoad({
      timeoutMs: 100,
      expectedIdentity: { email: "old@example.com", accountLifecycleId: lifecycle },
      fetchImpl: async (url) => url.endsWith("/me")
        ? jsonResponse(200, me)
        : jsonResponse(200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] }),
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.identityMismatch, true);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.state.email, null, "a mismatched session must never expose the other account");
  }
});

for (const scenario of [
  { name: "403", response: () => jsonResponse(403, { ok: false, error: "forbidden" }), expected: /资金信息暂时无法确认/ },
  { name: "409", response: () => jsonResponse(409, { ok: false, error: "session_state_changed" }), expected: /资金信息暂时无法确认/ },
  { name: "503", response: () => jsonResponse(503, { ok: false, error: "storage_unavailable" }), expected: /资金服务暂时不可用/ },
  { name: "bad JSON", response: () => ({ status: 200, ok: true, async json() { throw new SyntaxError("bad json"); } }), expected: /资金信息暂时无法确认/ },
]) {
  test(`/api/auth/balance ${scenario.name} keeps orders visible but locks money actions`, async () => {
    const result = await requestAccountLoad({
      timeoutMs: 100,
      fetchImpl: async (url) => url.endsWith("/me")
        ? jsonResponse(200, { ok: true, email: "legacy@example.com", orders: [{ orderId: "LM-OLD-1" }], balance: 88 })
        : scenario.response(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.email, "legacy@example.com");
    assert.equal(result.state.orders[0].orderId, "LM-OLD-1");
    assert.equal(result.state.financeReady, false);
    assert.match(result.state.financeError, scenario.expected);
    assert.deepEqual(result.state.txs, []);
    assert.deepEqual(result.state.withdrawals, []);
  });
}

test("a hanging balance request becomes a partial retry state instead of hiding account orders", async () => {
  let balanceSignal = null;
  const result = await requestAccountLoad({
    timeoutMs: 40,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/me")) return jsonResponse(200, { ok: true, email: "orders@example.com", orders: [{ orderId: "LM-KEEP-1" }] });
      balanceSignal = init.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.loading, false);
  assert.equal(result.state.financeReady, false);
  assert.match(result.state.financeError, /资金信息读取超时/);
  assert.equal(result.state.orders[0].orderId, "LM-KEEP-1");
  assert.equal(balanceSignal?.aborted, true, "the timed-out finance request must be cancelled");
});

test("verified balance data unlocks money actions", async () => {
  const lifecycle = "c".repeat(32);
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => url.endsWith("/me")
      ? jsonResponse(200, { ok: true, email: "ready@example.com", accountLifecycleId: lifecycle, orders: [] })
      : jsonResponse(200, { ok: true, email: "READY@example.com", accountLifecycleId: lifecycle, balance: 12.5, transactions: [{ id: "TX1" }], withdrawals: [], coupons: [] }),
  });
  assert.equal(result.state.financeReady, true);
  assert.equal(result.state.financeError, "");
  assert.equal(result.state.balance, 12.5);
  assert.equal(result.state.txs[0].id, "TX1");
});

test("balance data from another account or lifecycle never unlocks finance actions", async () => {
  const lifecycle = "d".repeat(32);
  for (const balanceIdentity of [
    { email: "other@example.com", accountLifecycleId: lifecycle },
    { email: "same@example.com", accountLifecycleId: "e".repeat(32) },
  ]) {
    const result = await requestAccountLoad({
      timeoutMs: 100,
      fetchImpl: async (url) => url.endsWith("/me")
        ? jsonResponse(200, { ok: true, email: "same@example.com", accountLifecycleId: lifecycle, orders: [{ orderId: "LM-A" }], balance: 9 })
        : jsonResponse(200, { ok: true, ...balanceIdentity, balance: 777, transactions: [{ id: "B-TX" }], withdrawals: [], coupons: [] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.email, "same@example.com");
    assert.equal(result.state.orders[0].orderId, "LM-A");
    assert.equal(result.state.financeReady, false);
    assert.equal(result.state.balance, 9, "an unbound balance response must fall back to the /me display balance");
    assert.deepEqual(result.state.txs, []);
    assert.match(result.state.financeError, /资金信息暂时无法确认/);
  }
});

for (const [name, payload] of [
  ["non-numeric balance", { ok: true, balance: "bad", transactions: [], withdrawals: [], coupons: [] }],
  ["missing balance", { ok: true, transactions: [], withdrawals: [], coupons: [] }],
  ["infinite balance", { ok: true, balance: Infinity, transactions: [], withdrawals: [], coupons: [] }],
  ["object balance", { ok: true, balance: {}, transactions: [], withdrawals: [], coupons: [] }],
  ["empty-string balance", { ok: true, balance: "", transactions: [], withdrawals: [], coupons: [] }],
  ["null balance", { ok: true, balance: null, transactions: [], withdrawals: [], coupons: [] }],
  ["empty-array balance", { ok: true, balance: [], transactions: [], withdrawals: [], coupons: [] }],
  ["boolean balance", { ok: true, balance: false, transactions: [], withdrawals: [], coupons: [] }],
  ["missing transactions", { ok: true, balance: 12, withdrawals: [], coupons: [] }],
  ["object withdrawals", { ok: true, balance: 12, transactions: [], withdrawals: {}, coupons: [] }],
  ["object coupons", { ok: true, balance: 12, transactions: [], withdrawals: [], coupons: {} }],
]) {
  test(`a nominally successful balance response with ${name} stays locked`, async () => {
    const result = await requestAccountLoad({
      timeoutMs: 100,
      fetchImpl: async (url) => url.endsWith("/me")
        ? jsonResponse(200, { ok: true, email: "shape@example.com", orders: [], balance: 99, coupons: [] })
        : jsonResponse(200, payload),
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.financeReady, false);
    assert.match(result.state.financeError, /资金信息暂时无法确认/);
    assert.deepEqual(result.state.txs, []);
    assert.deepEqual(result.state.withdrawals, []);
  });
}

test("a rejected balance request keeps account data visible and money actions locked", async () => {
  const result = await requestAccountLoad({
    timeoutMs: 100,
    fetchImpl: async (url) => url.endsWith("/me")
      ? jsonResponse(200, { ok: true, email: "offline@example.com", orders: [{ orderId: "LM-OFFLINE-1" }], coupons: [] })
      : Promise.reject(new TypeError("offline")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.financeReady, false);
  assert.match(result.state.financeError, /资金信息加载失败/);
  assert.equal(result.state.orders[0].orderId, "LM-OFFLINE-1");
});

test("the Account page uses the tested helper and renders its retry action", async () => {
  const page = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");
  const balanceRoute = await readFile(new URL("../app/api/auth/balance/route.js", import.meta.url), "utf8");
  assert.match(page, /import \{ requestAccountLoad \} from "\.\/load-account\.js"/);
  assert.match(page, /const result = await requestAccountLoad\(/);
  assert.match(page, /fetchImpl: fetch/);
  assert.match(page, /if \(result\.state\) setState\(result\.state\)/);
  assert.match(page, /className="account-load-error" role="alert"/);
  assert.match(page, /<button type="button" onClick=\{load\}>[\s\S]*?重试/);
  assert.match(page, /if \(!state\.financeReady\)/);
  assert.match(page, /disabled=\{!state\.financeReady \|\| moneyBusy === "transfer"\}/);
  assert.match(balanceRoute, /accountLifecycleId:\s*auth\.accountLifecycleId/);
});

test("mobile account promos and auth links reserve space for their floating controls", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.account-auth-page \.account-invite-poster > div:nth-child\(2\) > span \{ padding-right: 82px; \}/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.account-auth-page \.auth-hints \{ padding-right: 54px; \}/);
});
