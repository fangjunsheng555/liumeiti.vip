import assert from "node:assert/strict";
import test from "node:test";
import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "strict-admin-read-contract-secret-at-least-32-chars";
process.env.KV_REST_API_URL = "http://strict-admin-read.redis.test";
process.env.KV_REST_API_TOKEN = "strict-admin-read-token";

const redis = installMarketingRedisMock("http://strict-admin-read.redis.test");
const redisFetch = globalThis.fetch;
let forcedPipelineFailure = null;
let truncateNextPipeline = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://strict-admin-read.redis.test"
    && url.pathname === "/pipeline"
    && (forcedPipelineFailure || truncateNextPipeline)) {
    const commands = JSON.parse(String(options.body || "[]"));
    let consumed = false;
    const rows = commands.map((command) => {
      const name = String(command[0] || "").toUpperCase();
      const key = String(command[1] || "");
      if (forcedPipelineFailure && !consumed
        && name === forcedPipelineFailure.name
        && (!forcedPipelineFailure.keyPrefix || key.startsWith(forcedPipelineFailure.keyPrefix))) {
        consumed = true;
        forcedPipelineFailure = null;
        return { error: `forced_${name.toLowerCase()}_failure` };
      }
      return { result: redis.execute(command) };
    });
    if (truncateNextPipeline) {
      truncateNextPipeline = false;
      rows.pop();
    }
    return Response.json(rows);
  }
  return redisFetch(input, options);
};
const utils = await import("../app/api/_utils.js");
const timeline = await import("../app/api/_order-timeline.js");
const netflixStore = await import("../app/api/netflix-code/_store.js");
const adminNetflixRoute = await import("../app/api/admin/netflix-code/route.js");
const adminUsersRoute = await import("../app/api/admin/users/list/route.js");
const adminSearchRoute = await import("../app/api/admin/search/route.js");

test.after(() => redis.restore());

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "admin",
  exp: Date.now() + 60_000,
});

function adminRequest(path) {
  return new Request(`https://www.liumeiti.vip${path}`, {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  });
}

function failNext(name, keyPrefix = "") {
  forcedPipelineFailure = { name: String(name).toUpperCase(), keyPrefix };
}

test("order timeline skips malformed successful records but preserves valid events", async () => {
  const orderId = "LM-TIMELINE-STRICT-1";
  redis.lists.set(`liumeiti:order-timeline:${orderId}`, [
    JSON.stringify({ id: "evt-valid", type: "updated", createdAt: "2026-08-09T01:02:03.000Z", summaryEn: "Valid" }),
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify({ id: "evt-no-type", createdAt: "2026-08-09T01:02:03.000Z" }),
    JSON.stringify({ id: "evt-bad-time", type: "updated", createdAt: "local someday" }),
    "{broken-json",
  ]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const events = await timeline.getOrderTimeline({ orderId });
    assert.deepEqual(events.map((event) => event.id), ["evt-valid"]);
    assert.equal(warnings.some((entry) => String(entry[0]).includes("skipped unreadable event records")), true);
  } finally {
    console.warn = originalWarn;
  }
});

test("order timeline treats LRANGE command failure as storage failure", async () => {
  const orderId = "LM-TIMELINE-STRICT-2";
  failNext("LRANGE", `liumeiti:order-timeline:${orderId}`);
  await assert.rejects(
    timeline.getOrderTimeline({ orderId }),
    /order_timeline_store_unavailable/,
  );
});

test("latest Netflix receipts rejects a command error instead of returning empty receipts", async () => {
  const hash = netflixStore.netflixAccountHash("strict-receipt@example.com");
  failNext("ZREVRANGE", "liumeiti:netflix-mail:account:");
  await assert.rejects(
    netflixStore.latestNetflixMailReceipts([hash]),
    /netflix_record_store_unavailable/,
  );
});

test("latest Netflix receipts rejects a failed PING instead of trusting partial rows", async () => {
  const hash = netflixStore.netflixAccountHash("strict-ping@example.com");
  failNext("PING");
  await assert.rejects(
    netflixStore.latestNetflixMailReceipts([hash]),
    /netflix_record_store_unavailable/,
  );
});

test("latest Netflix receipts rejects a truncated pipeline response", async () => {
  const hash = netflixStore.netflixAccountHash("strict-truncated@example.com");
  truncateNextPipeline = true;
  await assert.rejects(
    netflixStore.latestNetflixMailReceipts([hash]),
    /netflix_record_store_unavailable/,
  );
});

test("admin Netflix panel returns 503 when the receipt index command fails", async () => {
  const ownerEmail = "netflix-owner@example.com";
  const account = "strict-netflix@example.com";
  redis.values.set("liumeiti:orders:overview:ready:v8", "1");
  redis.values.set("liumeiti:orders:list-revision", "7");
  redis.sortedSets.set("liumeiti:orders:summary-created", new Map([["LMNETSTRICT1", 1]]));
  redis.values.set("liumeiti:admin:netflix-order-directory:v1", JSON.stringify({
    signature: "7:1:LMNETSTRICT1",
    orders: [{
      orderId: "LMNETSTRICT1",
      email: ownerEmail,
      userEmail: ownerEmail,
      status: "completed",
      service: "netflix",
      staffAccount: account,
      items: [{ service: "netflix", staffAccount: account }],
    }],
  }));
  redis.values.set(`liumeiti:users:${ownerEmail}`, JSON.stringify({ email: ownerEmail, username: "Netflix Owner" }));
  failNext("ZREVRANGE", "liumeiti:netflix-mail:account:");
  const response = await adminNetflixRoute.GET(adminRequest("/api/admin/netflix-code"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "netflix_store_unavailable" });
});

test("admin Netflix panel returns 503 when its user-profile batch has a command error", async () => {
  const ownerEmail = "netflix-owner@example.com";
  failNext("MGET", `liumeiti:users:${ownerEmail}`);
  const response = await adminNetflixRoute.GET(adminRequest("/api/admin/netflix-code"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "user_store_unavailable" });
});

test("admin user list skips one malformed profile but keeps valid users", async () => {
  const validEmail = "strict-valid@example.com";
  const badEmail = "strict-bad@example.com";
  redis.sets.set("liumeiti:users:emails", new Set([validEmail, badEmail]));
  redis.values.set(`liumeiti:users:${validEmail}`, JSON.stringify({ email: ` ${validEmail.toUpperCase()} `, username: "Valid", balance: 12 }));
  redis.values.set(`liumeiti:users:${validEmail}:balance:cents`, "3456");
  redis.values.set(`liumeiti:users:${badEmail}`, "{bad-json");
  const response = await adminUsersRoute.GET(adminRequest("/api/admin/users/list"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.users.map((user) => user.email), [validEmail]);
  assert.equal(body.users[0].balance, 34.56);
});

test("admin user list returns 503 on profile command error", async () => {
  const email = "strict-command-error@example.com";
  redis.sets.set("liumeiti:users:emails", new Set([email]));
  redis.values.set(`liumeiti:users:${email}`, JSON.stringify({ email, username: "Must Not Be Guessed" }));
  failNext("MGET", `liumeiti:users:${email}`);
  const response = await adminUsersRoute.GET(adminRequest("/api/admin/users/list"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "user_store_unavailable" });
});

test("admin search returns 503 on user-index transport error instead of empty users", async () => {
  failNext("SMEMBERS", "liumeiti:users:emails");
  const response = await adminSearchRoute.GET(adminRequest("/api/admin/search?q=strict"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "user_store_unavailable" });
});

test("order summary fallback rejects a per-row Redis command error", async () => {
  const orderId = "LM-SUMMARY-FALLBACK-STRICT";
  redis.values.set("liumeiti:orders:overview:ready:v8", "1");
  redis.values.set("liumeiti:orders:list-revision", "11");
  redis.sortedSets.set("liumeiti:orders:summary-created", new Map([[orderId, 1]]));
  failNext("HMGET", "liumeiti:orders:overview");
  const result = await utils.getOrderSummariesPageFast(0, 20);
  assert.equal(result, null);
});
