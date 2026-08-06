import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

process.env.AUTH_SECRET = "money-retryability-test-secret-0123456789abcdef";
process.env.KV_REST_API_URL = "https://redis.money-retryability.test";
process.env.KV_REST_API_TOKEN = "test-token";

const authSessions = await import("../app/api/_auth-session.js");
const transferRoute = await import("../app/api/auth/transfer/route.js");
const redeemRoute = await import("../app/api/auth/redeem/route.js");
const withdrawRoute = await import("../app/api/auth/withdraw/route.js");
const {
  isExplicitTerminalIdempotencyResponse,
} = await import("../app/lib/idempotency.js");
const {
  clearSinglePendingOperation,
  prepareSinglePendingOperation,
} = await import("../app/lib/single-pending-journal.js");

const EMAIL = "buyer@example.com";
const LIFECYCLE = "0123456789abcdef0123456789abcdef";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class MoneyFailureRedis {
  constructor({ moneyResult = "not-json" } = {}) {
    this.moneyResult = moneyResult;
    this.redeemFailureWrites = 0;
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      const command = commands[0];
      if (String(command?.[1] || "").startsWith("liumeiti:redeem-guard:")) {
        return Response.json(commands.map(([name]) => ({
          result: String(name).toUpperCase() === "GET" ? "0"
            : String(name).toUpperCase() === "TTL" ? -2
              : String(name).toUpperCase() === "PING" ? "PONG" : null,
        })));
      }
      const script = String(command?.[1] || "");
      if (script.includes("balanceCents=balanceRaw")) {
        return Response.json([{ result: JSON.stringify({
          ok: true,
          userRaw: JSON.stringify({ email: EMAIL, passwordHash: "hash", balance: 100 }),
          authVersion: 1,
          accountLifecycleId: LIFECYCLE,
          balanceCents: "10000",
        }) }]);
      }
      return Response.json([{ result: this.moneyResult }]);
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const command = String(parts[0] || "").toUpperCase();
    const key = String(parts[1] || "");
    if (command === "GET") {
      if (key.startsWith("liumeiti:redeem-guard:")) return Response.json({ result: "0" });
      if (key.startsWith("liumeiti:redeem-code:")) {
        return Response.json({ result: JSON.stringify({
          code: "MISSING1",
          status: "active",
          amount: 25,
          coupons: [],
        }) });
      }
      // executeOperation recovery miss: the EVAL response was malformed and
      // Redis cannot yet prove whether the operation record was committed.
      return Response.json({ result: null });
    }
    if (command === "INCR" && key.startsWith("liumeiti:redeem-guard:")) {
      this.redeemFailureWrites += 1;
      return Response.json({ result: 1 });
    }
    if (command === "EXPIRE" && key.startsWith("liumeiti:redeem-guard:")) {
      return Response.json({ result: 1 });
    }
    throw new Error(`unexpected Redis command: ${url.pathname}`);
  };
}

function operationRequest(path, body, idempotencyKey) {
  const token = authSessions.signUserSessionForVersion(EMAIL, 1);
  return new Request(`https://www.liumeiti.vip${path}`, {
    method: "POST",
    headers: {
      cookie: `lm_user=${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-operation-expected-account": EMAIL,
      "x-operation-expected-lifecycle": LIFECYCLE,
    },
    body: JSON.stringify(body),
  });
}

async function withFetch(fetchImpl, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

test("malformed money EVAL plus recovery miss returns retryable 503 and preserves the browser journal", async () => {
  const storage = new MemoryStorage();
  const storageKey = "liumeiti:idempotency:money:transfer";
  const payload = { email: "recipient@example.com", amount: 1 };
  const identity = { accountEmail: EMAIL, accountLifecycleId: LIFECYCLE };
  const pending = prepareSinglePendingOperation(
    storage,
    storageKey,
    "money-transfer",
    payload,
    { identity, requireAccountLifecycle: true },
  );
  const redis = new MoneyFailureRedis();

  const response = await withFetch(redis.fetch, () => transferRoute.POST(operationRequest(
    "/api/auth/transfer",
    pending.payload,
    pending.idempotencyRequest.key,
  )));
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.error, "invalid_storage_response");
  assert.equal(data.retryable, true);
  assert.equal(data.ambiguous, true);
  assert.equal(isExplicitTerminalIdempotencyResponse(response.status, data), false);

  if (isExplicitTerminalIdempotencyResponse(response.status, data)) {
    clearSinglePendingOperation(storage, storageKey, pending.idempotencyRequest.key);
  }
  assert.notEqual(storage.getItem(storageKey), null);
});

test("redeem and withdrawal routes also expose ambiguous money failures as retryable 503", async () => {
  for (const [route, path, body, key] of [
    [redeemRoute, "/api/auth/redeem", { code: "MISSING1" }, "retry-redeem-0001"],
    [withdrawRoute, "/api/auth/withdraw", { amount: 10, alipayAccount: "ali", realName: "Buyer" }, "retry-withdraw-0001"],
  ]) {
    const redis = new MoneyFailureRedis();
    const response = await withFetch(redis.fetch, () => route.POST(operationRequest(path, body, key)));
    const data = await response.json();
    assert.equal(response.status, 503, path);
    assert.equal(data.error, "invalid_storage_response", path);
    assert.equal(data.retryable, true, path);
    assert.equal(data.ambiguous, true, path);
    assert.equal(isExplicitTerminalIdempotencyResponse(response.status, data), false, path);
    assert.equal(redis.redeemFailureWrites, 0, `${path} must not count storage ambiguity as a bad code guess`);
  }
});

test("a Redis invariant failure is a retryable server error even without transport ambiguity", async () => {
  const redis = new MoneyFailureRedis({
    moneyResult: JSON.stringify({ ok: false, error: "invalid_operation_record" }),
  });
  const response = await withFetch(redis.fetch, () => transferRoute.POST(operationRequest(
    "/api/auth/transfer",
    { email: "recipient@example.com", amount: 1 },
    "retry-invalid-record-0001",
  )));
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.error, "invalid_operation_record");
  assert.equal(data.retryable, true);
  assert.equal(data.ambiguous, false);
  assert.equal(isExplicitTerminalIdempotencyResponse(400, data), false);
});

test("an explicit business 400 remains terminal and permits compare-clear", async () => {
  const storage = new MemoryStorage();
  const storageKey = "liumeiti:idempotency:money:transfer";
  const payload = { email: "recipient@example.com", amount: 500 };
  const identity = { accountEmail: EMAIL, accountLifecycleId: LIFECYCLE };
  const pending = prepareSinglePendingOperation(
    storage,
    storageKey,
    "money-transfer",
    payload,
    { identity, requireAccountLifecycle: true },
  );
  const redis = new MoneyFailureRedis({
    moneyResult: JSON.stringify({ ok: false, error: "insufficient_balance", currentBalanceCents: 10000 }),
  });
  const response = await withFetch(redis.fetch, () => transferRoute.POST(operationRequest(
    "/api/auth/transfer",
    pending.payload,
    pending.idempotencyRequest.key,
  )));
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.error, "insufficient_balance");
  assert.equal(isExplicitTerminalIdempotencyResponse(response.status, data), true);
  assert.equal(clearSinglePendingOperation(storage, storageKey, pending.idempotencyRequest.key), true);
  assert.equal(storage.getItem(storageKey), null);
});

test("every direct atomic-money API maps retryable failures through the shared classifier", async () => {
  const routePaths = [
    "../app/api/auth/transfer/route.js",
    "../app/api/auth/redeem/route.js",
    "../app/api/auth/withdraw/route.js",
    "../app/api/order/route.js",
    "../app/api/quote-orders/route.js",
    "../app/api/admin/users/route.js",
    "../app/api/admin/withdrawals/[id]/route.js",
  ];
  for (const routePath of routePaths) {
    const source = await readFile(new URL(routePath, import.meta.url), "utf8");
    assert.match(source, /isRetryableMoneyOperationFailure\(/, routePath);
    assert.match(source, /retryableMoneyOperationFields\(/, routePath);
  }
});
