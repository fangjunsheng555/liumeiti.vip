import assert from "node:assert/strict";
import test from "node:test";

process.env.KV_REST_API_URL = "http://catalog.redis.test";
process.env.KV_REST_API_TOKEN = "catalog-token";

const values = new Map();
const versions = new Map();
const originalFetch = globalThis.fetch;

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName).toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "SET") { values.set(args[0], args[1]); return "OK"; }
  if (name === "ZADD") { versions.set(args[2], Number(args[1])); return 1; }
  if (name === "ZREVRANGE") return [...versions.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
  if (name === "EVAL") {
    const keyCount = Number(args[1]);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (keyCount === 3) {
      if (values.has(keys[0])) return values.get(keys[0]);
      values.set(keys[1], argv[0]);
      versions.set(argv[2], Number(argv[1]));
      values.set(keys[0], argv[2]);
      return argv[2];
    }
    const current = values.get(keys[0]) || "";
    if (current !== argv[0]) return ["CONFLICT", current];
    values.set(keys[1], argv[1]);
    values.set(keys[2], argv[2]);
    versions.set(argv[4], Number(argv[3]));
    values.set(keys[0], argv[4]);
    return ["OK", argv[4]];
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://catalog.redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
  }
  return originalFetch(input, options);
};

const catalogVersions = await import("../app/api/_catalog-versions.js");

test("catalog version commit is atomic and rejects a stale editor", async () => {
  const initial = { products: { spotify: { plans: { member: { amount: 128 } } } } };
  const baseline = await catalogVersions.ensureCatalogBaseline(initial, { staffId: 1, staffUsername: "admin" });
  assert.match(baseline, /^CV/);

  const next = { products: { spotify: { plans: { member: { amount: 138 } } } } };
  const committed = await catalogVersions.commitCatalogVersion({
    overrides: next,
    previousOverrides: initial,
    expectedVersion: baseline,
    actor: { staffId: 1, staffUsername: "admin" },
  });
  assert.equal(committed.ok, true);
  assert.notEqual(committed.currentVersion, baseline);
  assert.equal(JSON.parse(values.get("lm:catalog:overrides")).products.spotify.plans.member.amount, 138);

  const stale = await catalogVersions.commitCatalogVersion({
    overrides: initial,
    previousOverrides: next,
    expectedVersion: baseline,
    actor: { staffId: 2, staffUsername: "other" },
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.currentVersion, committed.currentVersion);
  assert.equal(JSON.parse(values.get("lm:catalog:overrides")).products.spotify.plans.member.amount, 138);
});
