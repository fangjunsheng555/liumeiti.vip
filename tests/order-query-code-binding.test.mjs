import test from "node:test";
import assert from "node:assert/strict";
import { canonicalOrderQuery } from "../app/lib/order-query-identity.js";

// The order-lookup code lives under a key built from a normalized query. These
// tests pin the record stored under that key to the same normalization, so a
// customer who recases an order number — or pastes one that wrapped across two
// lines in their confirmation email — is not told their code expired.

const URLBASE = "http://order-query.redis.test";
const strings = new Map();
const lists = new Map();

const ORDER = {
  orderId: "LM7D4E5F6A7B8C9D0E1F",
  email: "Buyer@Example.com",
  status: "completed",
  createdAt: "2026-08-01T00:00:00.000Z",
  netflixDeliveryMode: "self_service",
  items: [{ service: "netflix", label: "Netflix", plan: "profile", cycle: "monthly", amount: 30, staffAccount: "nf@outlook.com" }],
  finalAmount: 30,
  paymentMethod: "alipay",
};
lists.set("liumeiti:orders", [JSON.stringify(ORDER)]);

function runCommand(parts) {
  const op = String(parts[0]).toUpperCase();
  const key = parts[1];
  switch (op) {
    case "PING": return "PONG";
    case "TYPE": return strings.has(key) ? "string" : lists.has(key) ? "list" : "none";
    case "GET": return strings.has(key) ? strings.get(key) : null;
    case "SET": strings.set(key, parts[2]); return "OK";
    case "DEL": return strings.delete(key) ? 1 : 0;
    case "INCR": { const n = Number(strings.get(key) || 0) + 1; strings.set(key, String(n)); return n; }
    case "EXPIRE": return 1;
    case "TTL": return 600;
    case "LRANGE": return lists.get(key) || [];
    case "LLEN": return (lists.get(key) || []).length;
    case "EXISTS": return strings.has(key) ? 1 : 0;
    case "ZRANGE": case "ZREVRANGE": case "SMEMBERS": return [];
    case "MGET": return parts.slice(1).map((k) => (strings.has(k) ? strings.get(k) : null));
    case "EVAL": {
      const script = parts[1];
      const numKeys = Number(parts[2]);
      const keys = parts.slice(3, 3 + numKeys);
      const args = parts.slice(3 + numKeys);
      if (script.includes("identityLimit")) {
        return JSON.stringify({ ok: true, identityCount: 1, ipCount: 1, identityTtl: 600, ipTtl: 600, repaired: 0 });
      }
      if (script.includes("record.code")) {
        const raw = strings.get(keys[0]);
        if (!raw) return "missing";
        const record = JSON.parse(raw);
        if (String(record.email) !== args[0] || String(record.code) !== args[2]) return "invalid";
        const storedQuery = String(record.query ?? "");
        if (storedQuery !== args[1] && storedQuery !== args[3]) return "invalid";
        strings.delete(keys[0]);
        return "matched";
      }
      return null;
    }
    default: return null;
  }
}

const originalFetch = globalThis.fetch;
process.env.KV_REST_API_URL = URLBASE;
process.env.KV_REST_API_TOKEN = "order-query-test-token";
process.env.AUTH_SECRET = "auth-secret-value-for-order-query-tests-32chars";
globalThis.fetch = async (input, init = {}) => {
  const href = typeof input === "string" ? input : String(input?.url || input);
  if (!href.startsWith(URLBASE)) return originalFetch(input, init);
  const url = new URL(href);
  if (init.method === "POST" && url.pathname === "/pipeline") {
    const commands = JSON.parse(init.body);
    return Response.json(commands.map((command) => ({ result: runCommand(command) })));
  }
  const parts = url.pathname.split("/").slice(1).filter(Boolean).map(decodeURIComponent);
  return Response.json({ result: runCommand(parts) });
};

const { POST } = await import("../app/api/order-query/route.js");

function request(body) {
  return new Request("https://www.liumeiti.vip/api/order-query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

function storedCodeRecord() {
  const entry = [...strings.entries()].find(([key]) => key.startsWith("liumeiti:order-query-code:"));
  return entry ? { key: entry[0], record: JSON.parse(entry[1]) } : null;
}

// Requesting a code sends mail, which the test transport cannot do; the record
// is written before that attempt, which is all these tests read.
async function issueCode(query) {
  strings.clear();
  await POST(request({ query, code: "" }));
  const stored = storedCodeRecord();
  assert.ok(stored, `no code was stored for ${JSON.stringify(query)}`);
  return stored;
}

async function verify(query, code) {
  const response = await POST(request({ query, code }));
  return { status: response.status, data: await response.json() };
}

test("an order number verifies however the customer capitalized it", async () => {
  const { record } = await issueCode(ORDER.orderId.toLowerCase());
  const result = await verify(ORDER.orderId, record.code);
  assert.equal(result.data.ok, true, `expected the code to verify, got ${result.data.error}`);
  assert.equal(result.data.orders.length, 1);
});

test("an order number pasted across two lines still verifies once trimmed", async () => {
  const wrapped = `${ORDER.orderId.slice(0, 10)}\r\n${ORDER.orderId.slice(10)}`;
  const { record } = await issueCode(wrapped);
  const result = await verify(ORDER.orderId, record.code);
  assert.equal(result.data.ok, true, `expected the code to verify, got ${result.data.error}`);
});

test("an order email verifies however it was capitalized", async () => {
  const { record } = await issueCode(ORDER.email.toUpperCase());
  const result = await verify(ORDER.email.toLowerCase(), record.code);
  assert.equal(result.data.ok, true, `expected the code to verify, got ${result.data.error}`);
});

test("the stored record carries the canonical query, never the raw keystrokes", async () => {
  const { record } = await issueCode(`  ${ORDER.orderId.toLowerCase()}  `);
  assert.equal(record.query, canonicalOrderQuery(ORDER.orderId));
});

test("a wrong code is still refused", async () => {
  await issueCode(ORDER.orderId);
  const result = await verify(ORDER.orderId, "000000");
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error, "code_invalid_or_expired");
});

test("a code is single use", async () => {
  const { record } = await issueCode(ORDER.orderId);
  assert.equal((await verify(ORDER.orderId, record.code)).data.ok, true);
  const replay = await verify(ORDER.orderId, record.code);
  assert.equal(replay.data.ok, false);
  assert.equal(replay.data.error, "code_invalid_or_expired");
});

test("a code issued for one lookup cannot verify a different one", async () => {
  const { key, record } = await issueCode(ORDER.orderId);
  // Same order, addressed by email: a distinct lookup with its own key, so the
  // order number's code must not open it.
  const result = await verify(ORDER.email, record.code);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error, "code_invalid_or_expired");
  assert.ok(strings.has(key), "the untouched lookup's code must survive");
});

test("a code issued before this deploy still verifies", async () => {
  // Records written by the previous release hold the raw query string.
  const { key, record } = await issueCode(ORDER.orderId);
  strings.set(key, JSON.stringify({ ...record, query: ORDER.orderId }));
  const result = await verify(ORDER.orderId, record.code);
  assert.equal(result.data.ok, true, `expected the legacy record to verify, got ${result.data.error}`);
});
