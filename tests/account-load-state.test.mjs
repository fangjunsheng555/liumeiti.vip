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

test("the Account page uses the tested helper and renders its retry action", async () => {
  const page = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");
  assert.match(page, /import \{ requestAccountLoad \} from "\.\/load-account\.js"/);
  assert.match(page, /const result = await requestAccountLoad\(/);
  assert.match(page, /if \(result\.state\) setState\(result\.state\)/);
  assert.match(page, /className="account-load-error" role="alert"/);
  assert.match(page, /<button type="button" onClick=\{load\}>[\s\S]*?重试/);
});
