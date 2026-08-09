import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "admin-list-partial-failure-secret-at-least-32-chars";
process.env.KV_REST_API_URL = "http://admin-list-redis.test";
process.env.KV_REST_API_TOKEN = "admin-list-token";

const originalFetch = globalThis.fetch;
const sortedSets = new Map();
const hashes = new Map();
const lists = new Map();
const sets = new Map();
let failCommand = "";
let failKey = "";

function commandResult(command) {
  const name = String(command[0] || "").toUpperCase();
  const key = String(command[1] || "");
  if (name === failCommand && (!failKey || key.includes(failKey))) return { error: `forced_${name.toLowerCase()}_failure` };
  if (name === "PING") return { result: "PONG" };
  if (name === "ZCARD") return { result: (sortedSets.get(key) || []).length };
  if (name === "ZCOUNT") return { result: (sortedSets.get(key) || []).length };
  if (name === "ZRANGE") {
    const values = sortedSets.get(key) || [];
    const limitIndex = command.findIndex((value) => String(value).toUpperCase() === "LIMIT");
    const start = limitIndex >= 0 ? Number(command[limitIndex + 1] || 0) : Number(command[2] || 0);
    const stop = limitIndex >= 0 ? start + Number(command[limitIndex + 2] || 0) : Number(command[3] || -1) + 1;
    return { result: values.slice(start, stop) };
  }
  if (name === "HGETALL") return { result: hashes.get(key) ?? [] };
  if (name === "LRANGE") return { result: lists.get(key) ?? [] };
  if (name === "SMEMBERS") return { result: sets.get(key) ?? [] };
  return { result: null };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== "http://admin-list-redis.test") return originalFetch(input, init);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(init.body || "[]"));
    return Response.json(commands.map(commandResult));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return Response.json(commandResult(command));
};

const utils = await import("../app/api/_utils.js");
const visitorsRoute = await import("../app/api/admin/visitors/route.js");
const abandonedRoute = await import("../app/api/admin/abandoned/route.js");
const activityRoute = await import("../app/api/admin/user-activity/route.js");

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

function resetStore() {
  sortedSets.clear();
  hashes.clear();
  lists.clear();
  sets.clear();
  failCommand = "";
  failKey = "";
}

test.after(() => { globalThis.fetch = originalFetch; });

test("visitor list skips one missing hash and backfills the requested page", async () => {
  resetStore();
  const ids = ["deadbeef00000001", "abcdef0100000001", "abcdef0100000002"];
  sortedSets.set("lm:visit:index", ids);
  hashes.set(`lm:visit:v:${ids[1]}`, { ip: "203.0.113.1", firstSeen: "1786032000000", lastSeen: "1786032100000" });
  hashes.set(`lm:visit:v:${ids[2]}`, { ip: "203.0.113.2", firstSeen: "1786032200000", lastSeen: "1786032300000" });
  const response = await visitorsRoute.GET(adminRequest("/api/admin/visitors?offset=0&limit=2"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows.map((row) => row.id), ids.slice(1));
  assert.equal(body.total, 2);
  assert.equal(body.hasMore, false);
});

test("visitor list reports no next page when every indexed record is corrupt", async () => {
  resetStore();
  sortedSets.set("lm:visit:index", ["deadbeef00000011", "deadbeef00000012", "deadbeef00000013"]);
  const response = await visitorsRoute.GET(adminRequest("/api/admin/visitors?offset=0&limit=2"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows, []);
  assert.equal(body.total, 0);
  assert.equal(body.hasMore, false);
});

test("visitor list treats a Redis command error as 503 instead of empty visitors", async () => {
  resetStore();
  const id = "abcdef0200000001";
  sortedSets.set("lm:visit:index", [id]);
  failCommand = "HGETALL";
  const response = await visitorsRoute.GET(adminRequest("/api/admin/visitors?limit=1"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "visitor_store_unavailable" });
});

test("abandoned-cart list skips one corrupt cart and backfills the requested page", async () => {
  resetStore();
  const ids = ["aa000001", "aa000002", "aa000003"];
  sortedSets.set("lm:cart:index", ids);
  hashes.set(`lm:cart:v:${ids[0]}`, { email: "broken@example.com" });
  hashes.set(`lm:cart:v:${ids[1]}`, { ts: "1786032400000", email: "one@example.com", services: "netflix" });
  hashes.set(`lm:cart:v:${ids[2]}`, { ts: "1786032500000", email: "two@example.com", services: "spotify" });
  const response = await abandonedRoute.GET(adminRequest("/api/admin/abandoned?offset=0&limit=2"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows.map((row) => row.id), ids.slice(1));
  assert.equal(body.total, 2);
  assert.equal(body.hasMore, false);
});

test("abandoned-cart page of one bad plus fifty valid records is complete without a phantom next page", async () => {
  resetStore();
  const badId = "ab000000";
  const validIds = Array.from({ length: 50 }, (_, index) => `ac${String(index).padStart(6, "0")}`);
  sortedSets.set("lm:cart:index", [badId, ...validIds]);
  validIds.forEach((id, index) => hashes.set(`lm:cart:v:${id}`, {
    ts: String(1786033000000 + index),
    email: `cart-${index}@example.com`,
    services: "netflix",
  }));
  const response = await abandonedRoute.GET(adminRequest("/api/admin/abandoned?offset=0&limit=50"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.rows.length, 50);
  assert.equal(body.total, 50);
  assert.equal(body.hasMore, false);
});

test("abandoned-cart list treats an index command error as 503", async () => {
  resetStore();
  failCommand = "ZCARD";
  const response = await abandonedRoute.GET(adminRequest("/api/admin/abandoned?limit=2"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "abandoned_store_unavailable" });
});

test("user activity scans past twenty stale device records to retain a valid device", async () => {
  resetStore();
  const email = "activity@example.com";
  hashes.set(`lm:uact:${email}`, {});
  lists.set(`lm:uact:${email}:pages`, []);
  lists.set(`lm:uact:${email}:events`, []);
  sets.set(`lm:uact:${email}:ips`, []);
  const stale = Array.from({ length: 20 }, (_, index) => `aa${String(index).padStart(14, "0")}`);
  const validId = "bbbbbbbbbbbbbbbb";
  sets.set(`lm:visit:email:${email}`, [...stale, validId]);
  hashes.set(`lm:visit:v:${validId}`, { email, ip: "198.51.100.20", count: "1" });
  lists.set(`lm:visit:v:${validId}:pages`, [JSON.stringify({ site: "main", path: "/shop", ts: 1786032600000 })]);
  lists.set(`lm:visit:v:${validId}:events`, [JSON.stringify({ name: "service_view", slug: "netflix", ts: 1786032600000 })]);
  const response = await activityRoute.GET(adminRequest(`/api/admin/user-activity?email=${encodeURIComponent(email)}`));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.found, true);
  assert.equal(body.devices, 1);
  assert.deepEqual(body.servicesViewed, ["netflix"]);
});

test("user activity treats a page-list command error as 503", async () => {
  resetStore();
  const email = "broken-activity@example.com";
  failCommand = "LRANGE";
  failKey = `lm:uact:${email}:pages`;
  const response = await activityRoute.GET(adminRequest(`/api/admin/user-activity?email=${encodeURIComponent(email)}`));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "user_activity_store_unavailable" });
});

test("user activity skips invalid times and normalizes invalid or fractional counts", async () => {
  resetStore();
  const email = "legacy-activity@example.com";
  hashes.set(`lm:uact:${email}`, { count: "9007199254740993" });
  lists.set(`lm:uact:${email}:pages`, [
    JSON.stringify({ site: "main", path: "/shop", ts: "2026-08-09T08:00:00.000Z" }),
    JSON.stringify({ site: "main", path: "/checkout", ts: "not-a-time" }),
  ]);
  lists.set(`lm:uact:${email}:events`, []);
  sets.set(`lm:uact:${email}:ips`, []);
  const fractionalId = "cccccccccccccccc";
  sets.set(`lm:visit:email:${email}`, [fractionalId]);
  hashes.set(`lm:visit:v:${fractionalId}`, { email, count: "1.5" });
  lists.set(`lm:visit:v:${fractionalId}:pages`, []);
  lists.set(`lm:visit:v:${fractionalId}:events`, []);
  const response = await activityRoute.GET(adminRequest(`/api/admin/user-activity?email=${encodeURIComponent(email)}`));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.totalPages, 1);
  assert.equal(body.pages.length, 1);
  assert.equal(body.pages[0].ts, Date.parse("2026-08-09T08:00:00.000Z"));
  assert.equal(body.devices, 0);
});
