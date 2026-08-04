import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { requestAccountLoad } from "../app/account/load-account.js";

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function loadFrom(baseUrl, timeoutMs) {
  return requestAccountLoad({
    timeoutMs,
    fetchImpl: (url, init) => fetch(`${baseUrl}${url}`, init),
  });
}

test("final convergence C1: a real HTTP 502 exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 502, { ok: false, error: "bad_gateway" });
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 502);
    assert.ok(result.error);
  });
});

test("final convergence C2: a real truncated JSON response exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"ok":true');
    }
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.ok(result.error);
  });
});

test("final convergence C3: a real mid-body socket disconnect exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
      return response.socket.destroy();
    }
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.ok(result.error);
  });
});

test("final convergence C4: a real stalled response body reaches the finite deadline", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true');
      return;
    }
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const startedAt = Date.now();
    const result = await loadFrom(baseUrl, 40);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.ok(Date.now() - startedAt < 500);
  });
});

test("final convergence C5: a real balance 504 keeps account orders visible and money locked", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, {
      ok: true,
      email: "http-balance@example.com",
      accountLifecycleId: "f".repeat(32),
      balance: 7,
      orders: [{ orderId: "LM-HTTP-KEEP" }],
    });
    return json(response, 504, { ok: false, error: "gateway_timeout" });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, true);
    assert.equal(result.state.financeReady, false);
    assert.equal(result.state.orders[0].orderId, "LM-HTTP-KEEP");
    assert.equal(result.state.balance, 7);
    assert.ok(result.state.financeError);
  });
});

test("final convergence D1: a real HTTP 429 exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 429, { ok: false, error: "rate_limited" });
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 429);
    assert.ok(result.error);
  });
});

test("final convergence D2: a real empty 204 response exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return response.writeHead(204).end();
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 204);
  });
});

test("final convergence D3: a real JSON array response exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, []);
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 200);
  });
});

test("final convergence D4: a real JSON null response exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, null);
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 200);
  });
});

test("final convergence D5: a real balance 418 keeps account orders visible and money locked", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, {
      ok: true,
      email: "http-balance-418@example.com",
      accountLifecycleId: "e".repeat(32),
      balance: 9,
      orders: [{ orderId: "LM-HTTP-418" }],
    });
    return json(response, 418, { ok: false, error: "unexpected_response" });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, true);
    assert.equal(result.state.financeReady, false);
    assert.equal(result.state.orders[0].orderId, "LM-HTTP-418");
    assert.equal(result.state.balance, 9);
    assert.ok(result.state.financeError);
  });
});

test("final convergence G1: a real non-JSON 503 exits account loading", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") {
      response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      return response.end("<h1>maintenance</h1>");
    }
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 503);
    assert.ok(result.error);
  });
});

test("final convergence G2: a string success flag cannot authenticate account data", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, { ok: "true", email: "string-ok@example.com" });
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 200);
  });
});

test("final convergence G3: a numeric success flag cannot authenticate account data", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, { ok: 1, email: "numeric-ok@example.com" });
    return json(response, 200, { ok: true, balance: 0, transactions: [], withdrawals: [], coupons: [] });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.equal(result.status, 200);
  });
});

test("final convergence G4: an array balance body keeps orders visible and money locked", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, {
      ok: true,
      email: "array-balance@example.com",
      accountLifecycleId: "d".repeat(32),
      balance: 11,
      orders: [{ orderId: "LM-ARRAY-BALANCE" }],
    });
    return json(response, 200, []);
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, true);
    assert.equal(result.state.financeReady, false);
    assert.equal(result.state.balance, 11);
    assert.equal(result.state.orders[0].orderId, "LM-ARRAY-BALANCE");
    assert.ok(result.state.financeError);
  });
});

test("final convergence G5: a string balance success flag cannot unlock money actions", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/auth/me") return json(response, 200, {
      ok: true,
      email: "string-balance-ok@example.com",
      accountLifecycleId: "c".repeat(32),
      balance: 13,
      orders: [{ orderId: "LM-STRING-BALANCE" }],
    });
    return json(response, 200, {
      ok: "true",
      email: "string-balance-ok@example.com",
      accountLifecycleId: "c".repeat(32),
      balance: 999,
      transactions: [],
      withdrawals: [],
      coupons: [],
    });
  }, async (baseUrl) => {
    const result = await loadFrom(baseUrl, 500);
    assert.equal(result.loading, false);
    assert.equal(result.ok, true);
    assert.equal(result.state.financeReady, false);
    assert.equal(result.state.balance, 13);
    assert.equal(result.state.orders[0].orderId, "LM-STRING-BALANCE");
    assert.ok(result.state.financeError);
  });
});
