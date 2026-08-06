import assert from "node:assert/strict";
import test from "node:test";
import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "admin-read-permission-boundaries-secret-32-chars";
delete process.env.CRON_SECRET;
process.env.KV_REST_API_URL = "http://admin-permissions.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = installMarketingRedisMock("http://admin-permissions.redis.test");
redis.sets.set("liumeiti:users:emails", new Set(["known-user@example.com"]));
redis.values.set("liumeiti:users:known-user@example.com", JSON.stringify({
  email: "known-user@example.com",
  username: "Known User",
  balance: 0,
}));
redis.lists.set("liumeiti:redeem-codes", ["KNOWNCODE"]);
redis.values.set("liumeiti:redeem-code:KNOWNCODE", JSON.stringify({
  code: "KNOWNCODE",
  status: "active",
  type: "balance",
  amount: 5,
}));

const utils = await import("../app/api/_utils.js");
const usdtRoute = await import("../app/api/admin/usdt-check/route.js");
const withdrawalDetailRoute = await import("../app/api/admin/withdrawals/[id]/route.js");
const ordersRoute = await import("../app/api/admin/orders/route.js");
const searchRoute = await import("../app/api/admin/search/route.js");
const mailRoute = await import("../app/api/admin/mail/route.js");

test.after(() => redis.restore());

const restrictedToken = utils.signSession({
  role: "admin",
  staffId: 2,
  staffUsername: "restricted",
  staffRole: "support",
  staffPerms: {
    canViewOrders: false,
    canEditOrders: false,
    canViewUsers: true,
    canViewCodes: true,
    canSendMail: false,
    canReviewWithdrawals: false,
  },
  exp: Date.now() + 60_000,
});

function adminRequest(path, method = "GET") {
  return new Request(`https://www.liumeiti.vip${path}`, {
    method,
    headers: { cookie: `lm_admin=${encodeURIComponent(restrictedToken)}` },
  });
}

test("USDT confirmation has no GET entry and POST requires order-edit permission", async () => {
  assert.equal("GET" in usdtRoute, false);

  const response = await usdtRoute.POST(adminRequest("/api/admin/usdt-check", "POST"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "forbidden" });
});

test("withdrawal detail requires withdrawal-review permission", async () => {
  const response = await withdrawalDetailRoute.GET(
    adminRequest("/api/admin/withdrawals/W-1"),
    { params: Promise.resolve({ id: "W-1" }) },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "forbidden" });
});

test("order list and recipient-email modes require order-view permission", async () => {
  for (const path of ["/api/admin/orders", "/api/admin/orders?mode=recipient-emails", "/api/admin/orders?format=csv"]) {
    const response = await ordersRoute.GET(adminRequest(path));
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { ok: false, error: "forbidden" });
  }
});

test("global search suppresses orders but preserves independently authorized result groups", async () => {
  const response = await searchRoute.GET(adminRequest("/api/admin/search?q=known"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.orders, []);
  assert.deepEqual(data.users.map((user) => user.email), ["known-user@example.com"]);
  assert.deepEqual(data.codes.map((code) => code.code), ["KNOWNCODE"]);
});

test("mail log GET requires mail permission", async () => {
  const response = await mailRoute.GET(adminRequest("/api/admin/mail"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "forbidden" });
});
