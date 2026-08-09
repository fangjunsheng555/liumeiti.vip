import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "strict-admin-log-read-contracts-secret";
process.env.KV_REST_API_URL = "https://strict-admin-logs.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const utils = await import("../app/api/_utils.js");
const actionsRoute = await import("../app/api/admin/actions/route.js");
const loginLogRoute = await import("../app/api/admin/login-log/route.js");
const balanceLogRoute = await import("../app/api/admin/balance-log/route.js");
const mailRoute = await import("../app/api/admin/mail/route.js");
const usersRoute = await import("../app/api/admin/users/route.js");

const originalFetch = global.fetch;
let pipelineHandler = () => [{ result: [] }, { result: "PONG" }];
let directHandler = () => ({ result: null });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(init.body || "[]"));
    const value = await pipelineHandler(commands);
    return jsonResponse(value);
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return jsonResponse(await directHandler(command));
};

test.after(() => { global.fetch = originalFetch; });

const rootToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "root",
  exp: Date.now() + 60_000,
});
const financeToken = utils.signSession({
  role: "admin",
  staffRole: "finance",
  staffId: 7,
  staffUsername: "finance",
  staffPerms: { canViewUsers: false, canAdjustBalance: true },
  exp: Date.now() + 60_000,
});

function adminRequest(path, token = rootToken) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  });
}

function adminJsonRequest(path, method, body, token = rootToken) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    method,
    headers: {
      cookie: `lm_admin=${encodeURIComponent(token)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("admin action list preserves a good record beside malformed stored JSON", async () => {
  pipelineHandler = () => [
    { result: [
      JSON.stringify({ id: "AL-GOOD", action: "order_update", detail: {}, createdAt: "2026-08-09T00:00:00.000Z" }),
      "{broken-json",
    ] },
    { result: "PONG" },
  ];
  const response = await actionsRoute.GET(adminRequest("/api/admin/actions"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.actions.map((entry) => entry.id), ["AL-GOOD"]);
});

test("admin login log exposes a Redis command error as 503", async () => {
  pipelineHandler = () => [{ error: "WRONGTYPE" }, { result: "PONG" }];
  const response = await loginLogRoute.GET(adminRequest("/api/admin/login-log"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "admin_login_log_store_unavailable");
});

test("admin login log fills its visible window past corrupt physical rows", async () => {
  const good = JSON.stringify({ id: "LG-AFTER-BAD", username: "admin", ok: true });
  pipelineHandler = () => [
    { result: [...Array.from({ length: 100 }, () => "{bad-json"), good] },
    { result: "PONG" },
  ];
  const response = await loginLogRoute.GET(adminRequest("/api/admin/login-log"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.entries.map((entry) => entry.id), ["LG-AFTER-BAD"]);
});

test("admin balance log rejects a truncated pipeline instead of reporting zero rows", async () => {
  pipelineHandler = () => [{ result: [] }];
  const response = await balanceLogRoute.GET(adminRequest("/api/admin/balance-log"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "admin_balance_log_store_unavailable");
});

test("admin mail log rejects a failed PING instead of reporting an empty history", async () => {
  pipelineHandler = () => [{ result: [] }, { error: "redis timeout" }];
  const response = await mailRoute.GET(adminRequest("/api/admin/mail"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "admin_mail_log_store_unavailable");
});

test("balance transaction list skips a corrupt monetary row without fabricating it", async () => {
  const email = "ledger@example.com";
  directHandler = (command) => {
    if (String(command[0]).toUpperCase() === "MGET") {
      return { result: [JSON.stringify({ email, username: "Ledger", balance: 12 }), "1200"] };
    }
    return { result: null };
  };
  pipelineHandler = (commands) => {
    assert.deepEqual(commands[0].slice(0, 2), ["LRANGE", `liumeiti:users:${email}:tx`]);
    return [
      { result: [
        JSON.stringify({ id: "TX-GOOD", amount: 2.5, amountCents: 250, source: "admin" }),
        JSON.stringify({ id: "TX-BAD", amount: "not-money", amountCents: 999999, source: "admin" }),
        JSON.stringify({ id: "TX-NULL", amount: null, amountCents: 0, source: "admin" }),
        JSON.stringify({ id: "TX-ARRAY", amount: [], amountCents: 0, source: "admin" }),
        JSON.stringify({ id: "TX-MISMATCH", amount: 2.5, amountCents: 251, source: "admin" }),
      ] },
      { result: "PONG" },
    ];
  };
  const response = await usersRoute.GET(adminRequest(`/api/admin/users?email=${email}`, financeToken));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.transactions.map((entry) => entry.id), ["TX-GOOD"]);
});

test("network failure during a strict log read returns 503", async () => {
  pipelineHandler = () => { throw new Error("socket disconnected"); };
  const response = await actionsRoute.GET(adminRequest("/api/admin/actions"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "admin_action_log_store_unavailable");
});

test("a successful action-log deletion is not reported failed when only its refresh fails", async () => {
  let listReads = 0;
  pipelineHandler = (commands) => {
    const command = commands[0]?.[0];
    if (command === "LRANGE") {
      listReads += 1;
      if (listReads > 1) throw new Error("refresh disconnected");
      return [
        { result: [JSON.stringify({ id: "AL-DELETE", action: "order_update", detail: {} })] },
        { result: "PONG" },
      ];
    }
    if (command === "EVAL") return [{ result: 0 }, { result: "PONG" }];
    return commands.map(() => ({ result: "OK" }));
  };
  const response = await actionsRoute.DELETE(adminJsonRequest(
    "/api/admin/actions",
    "DELETE",
    { ids: ["AL-DELETE"] },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.deletedCount, 1);
  assert.equal(body.refreshRequired, true);
  assert.equal(Object.hasOwn(body, "actions"), false,
    "a failed auxiliary refresh must not masquerade as a successfully empty log");
});

test("an atomic balance-log rewrite command error returns 503", async () => {
  pipelineHandler = (commands) => {
    if (commands[0]?.[0] === "LRANGE") {
      return [
        { result: [JSON.stringify({ id: "BL-DELETE", email: "user@example.com", amount: 1 })] },
        { result: "PONG" },
      ];
    }
    return [{ error: "READONLY replica" }, { result: "PONG" }];
  };
  const response = await balanceLogRoute.DELETE(adminJsonRequest(
    "/api/admin/balance-log",
    "DELETE",
    { ids: ["BL-DELETE"] },
  ));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "storage_failed");
});
