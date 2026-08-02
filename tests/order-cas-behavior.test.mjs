import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { executeOrderCasEval } from "./helpers/order-cas-redis-mock.mjs";

process.env.KV_REST_API_URL = "http://redis.order-cas.test";
process.env.KV_REST_API_TOKEN = "test-token";

function collection(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

class OrderRedisMock {
  constructor() {
    this.values = new Map();
    this.lists = new Map();
    this.hashes = new Map();
    this.sortedSets = new Map();
    this.sets = new Map();
    this.evalCalls = [];
  }

  execute(command) {
    const [rawName, ...args] = command;
    const name = String(rawName || "").toUpperCase();
    if (name === "GET") return this.values.get(args[0]) ?? null;
    if (name === "SET") {
      const [key, value, ...options] = args;
      if (options.map(String).includes("NX") && this.values.has(key)) return null;
      this.values.set(key, String(value));
      return "OK";
    }
    if (name === "DEL") {
      let removed = 0;
      for (const key of args) {
        if (this.values.delete(key)) removed += 1;
        if (this.lists.delete(key)) removed += 1;
        if (this.hashes.delete(key)) removed += 1;
        if (this.sortedSets.delete(key)) removed += 1;
        if (this.sets.delete(key)) removed += 1;
      }
      return removed;
    }
    if (name === "LRANGE") {
      const list = collection(this.lists, args[0], () => []);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      return list.slice(start, stop < 0 ? undefined : stop + 1);
    }
    if (name === "LINDEX") return collection(this.lists, args[0], () => [])[Number(args[1])] ?? null;
    if (name === "SADD") {
      const target = collection(this.sets, args[0], () => new Set());
      let added = 0;
      for (const member of args.slice(1)) {
        if (!target.has(member)) added += 1;
        target.add(member);
      }
      return added;
    }
    if (name === "SMEMBERS") return Array.from(collection(this.sets, args[0], () => new Set()));
    if (name === "EVAL") {
      this.evalCalls.push(command);
      const cas = executeOrderCasEval(command, this);
      if (cas.handled) return cas.result;
      const script = String(args[0] || "");
      const keyCount = Number(args[1] || 0);
      const keys = args.slice(2, 2 + keyCount);
      const argv = args.slice(2 + keyCount);
      if (script.includes("local added=redis.call('SADD',KEYS[1],ARGV[1])")) {
        const target = collection(this.sets, keys[0], () => new Set());
        const added = target.has(argv[0]) ? 0 : 1;
        target.add(argv[0]);
        if (added) collection(this.lists, keys[1], () => []).push(argv[0]);
        return JSON.stringify({ ok: true, added });
      }
      if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]")) {
        if (this.values.get(keys[0]) !== argv[0]) return 0;
        this.values.delete(keys[0]);
        return 1;
      }
      throw new Error("unhandled EVAL script");
    }
    throw new Error(`unhandled command ${name}`);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({ result: this.execute(command) })));
    }
    const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return Response.json({ result: this.execute(command) });
  };
}

test("strict order CAS rejects a pre-bumped stale snapshot and keeps indexes unique", async (t) => {
  const redis = new OrderRedisMock();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = redis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const utils = await import(`../app/api/_utils.js?order-cas=${Date.now()}`);

  const orderId = "LMCAS0001";
  const recordKey = `liumeiti:orders:record:${orderId}`;
  const original = {
    orderId,
    revision: 5,
    status: "received",
    email: "buyer@example.com",
    createdAt: "2026-08-01T00:00:00.000Z",
    items: [],
  };
  redis.values.set(recordKey, JSON.stringify(original));
  redis.lists.set("liumeiti:orders:index", [orderId]);

  const snapshotA = structuredClone(original);
  const snapshotB = structuredClone(original);
  snapshotB.marker = "writer-b";
  assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, snapshotB, { expectedRevision: 5 }), true);
  assert.equal(snapshotB.revision, 6, "the successful caller receives the committed revision");

  snapshotA.revision = 6;
  snapshotA.marker = "stale-writer-a";
  assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, snapshotA, { expectedRevision: 5 }), false);
  assert.equal(JSON.parse(redis.values.get(recordKey)).marker, "writer-b");

  snapshotB.marker = "save-seven";
  assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, snapshotB, { expectedRevision: 6 }), true);
  assert.equal(snapshotB.revision, 7);
  snapshotB.marker = "save-eight";
  assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, snapshotB, { expectedRevision: 7 }), true);
  assert.equal(snapshotB.revision, 8);
  assert.equal(JSON.parse(redis.values.get(recordKey)).revision, 8);

  const missingExpected = structuredClone(snapshotB);
  missingExpected.marker = "must-not-save";
  assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, missingExpected), false);

  const newOrder = {
    orderId: "LMCAS0002",
    revision: 99,
    status: "received",
    createdAt: "2026-08-02T00:00:00.000Z",
    items: [],
  };
  assert.equal(await utils.setOrderAt({ orderId: newOrder.orderId, legacyIndex: null }, newOrder), true);
  assert.equal(newOrder.revision, 1, "new records always start at revision 1");
  newOrder.status = "completed";
  assert.equal(await utils.setOrderAt(
    { orderId: newOrder.orderId, legacyIndex: null },
    newOrder,
    { expectedRevision: 1 },
  ), true);
  assert.equal(newOrder.revision, 2);

  const index = redis.lists.get("liumeiti:orders:index");
  assert.equal(index.filter((id) => id === orderId).length, 1);
  assert.equal(index.filter((id) => id === newOrder.orderId).length, 1);
  assert.deepEqual(
    new Set(index),
    redis.sets.get("liumeiti:orders:index:members"),
    "the LIST and its O(1) membership SET stay aligned",
  );

  const casScript = redis.evalCalls.map((call) => String(call[1])).find((script) => script.includes("No command below can fail"));
  assert.ok(casScript);
  assert.doesNotMatch(casScript, /LPOS',KEYS\[2\]/);
  assert.match(casScript, /SADD',KEYS\[16\]/);
  assert.match(casScript, /'list','set'\}/);
});

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

function realRedisFetch(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

test("real Redis accepts the strict CAS Lua and preserves one primary index member", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker-backed Lua verification" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-order-cas-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedisFetch(container);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = redis.fetch;
    try {
      const utils = await import(`../app/api/_utils.js?order-cas-real=${Date.now()}`);
      const orderId = "LMCASREAL1";
      const recordKey = `liumeiti:orders:record:${orderId}`;
      const original = {
        orderId,
        revision: 5,
        status: "received",
        email: "real@example.com",
        createdAt: "2026-08-01T00:00:00.000Z",
        items: [],
      };
      redis.run(["SET", recordKey, JSON.stringify(original)]);
      redis.run(["RPUSH", "liumeiti:orders:index", orderId]);
      const writerB = { ...original, marker: "writer-b" };
      const staleA = { ...original, revision: 6, marker: "stale-a" };
      assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, writerB, { expectedRevision: 5 }), true);
      assert.equal(writerB.revision, 6);
      assert.equal(await utils.setOrderAt({ orderId, legacyIndex: null }, staleA, { expectedRevision: 5 }), false);
      assert.equal(JSON.parse(redis.run(["GET", recordKey])).marker, "writer-b");
      assert.equal(redis.run(["LRANGE", "liumeiti:orders:index", "0", "-1"]).filter((id) => id === orderId).length, 1);
      assert.equal(redis.run(["SISMEMBER", "liumeiti:orders:index:members", orderId]), 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    docker(["rm", "-f", container]);
  }
});
