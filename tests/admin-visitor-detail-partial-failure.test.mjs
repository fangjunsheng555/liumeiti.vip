import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "visitor-detail-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://visitor-redis.test";
process.env.KV_REST_API_TOKEN = "visitor-test-token";

const originalFetch = globalThis.fetch;
let visitorHash = {};
let pageRows = [];
let pipelineFailure = null;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== "http://visitor-redis.test") return originalFetch(input);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(init.body || "[]"));
    return Response.json(commands.map((command) => {
      const name = String(command[0] || "").toUpperCase();
      if (pipelineFailure === name) return { error: `forced_${name.toLowerCase()}_failure` };
      if (name === "PING") return { result: "PONG" };
      if (name === "HGETALL") return { result: visitorHash };
      if (name === "LRANGE") return { result: pageRows };
      return { result: null };
    }));
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (String(command[0] || "").toUpperCase() === "HGETALL") {
    return Response.json({ result: visitorHash });
  }
  if (String(command[0] || "").toUpperCase() === "LRANGE") {
    return Response.json({ result: pageRows });
  }
  return Response.json({ result: null });
};

const utils = await import("../app/api/_utils.js");
const visitorDetailRoute = await import("../app/api/admin/visitors/[id]/route.js");

test.after(() => { globalThis.fetch = originalFetch; });

test("visitor detail skips isolated malformed page records and preserves valid history", async () => {
  const visitorId = "abcdef0123456789abcdef0123456789";
  visitorHash = {
    ip: "203.0.113.25",
    ua: "partial-failure-browser",
    email: "visitor@example.com",
    count: "6",
    firstSeen: "1786032000000",
    lastSeen: "1786032300000",
  };
  pageRows = [
    JSON.stringify({ site: "main", path: "/shop", ts: 1786032000000 }),
    { site: "tool", path: "/dashboard", ts: "1786032060000" },
    "{not-json",
    { site: ["main"], path: "/account", ts: 1786032120000 },
    { site: "main", path: { value: "/checkout" }, ts: 1786032180000 },
    { site: "main", path: "/netflix-code", ts: "not-a-timestamp" },
  ];
  pipelineFailure = null;
  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    exp: Date.now() + 60_000,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0] || "") === "[visitors] skipped unreadable page records") warnings.push(args);
    else originalWarn(...args);
  };
  try {
    const response = await visitorDetailRoute.GET(
      new Request(`https://www.liumeiti.vip/api/admin/visitors/${visitorId}`, {
        headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
      }),
      { params: Promise.resolve({ id: visitorId }) },
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.visitor.id, visitorId);
    assert.equal(body.visitor.email, "visitor@example.com");
    assert.deepEqual(body.pages.map(({ site, path, ts }) => ({ site, path, ts })), [
      { site: "main", path: "/shop", ts: 1786032000000 },
      { site: "tool", path: "/dashboard", ts: 1786032060000 },
    ]);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0][1], { visitorId, skipped: 4 });
  } finally {
    console.warn = originalWarn;
  }
});

test("visitor detail returns 503 when the page-list transport shape is invalid", async () => {
  const visitorId = "1234567890abcdef1234567890abcdef";
  visitorHash = { ip: "198.51.100.12", lastSeen: "1786032400000" };
  pageRows = { malformed: true };
  pipelineFailure = null;
  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    exp: Date.now() + 60_000,
  });
  const response = await visitorDetailRoute.GET(
    new Request(`https://www.liumeiti.vip/api/admin/visitors/${visitorId}`, {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }),
    { params: Promise.resolve({ id: visitorId }) },
  );
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.deepEqual(body, { ok: false, error: "visitor_store_unavailable" });
});

test("visitor detail returns 503 rather than false 404 when HGETALL has a command error", async () => {
  const visitorId = "fedcba0987654321fedcba0987654321";
  visitorHash = {};
  pageRows = [];
  pipelineFailure = "HGETALL";
  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    exp: Date.now() + 60_000,
  });
  try {
    const response = await visitorDetailRoute.GET(
      new Request(`https://www.liumeiti.vip/api/admin/visitors/${visitorId}`, {
        headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
      }),
      { params: Promise.resolve({ id: visitorId }) },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "visitor_store_unavailable" });
  } finally {
    pipelineFailure = null;
  }
});
