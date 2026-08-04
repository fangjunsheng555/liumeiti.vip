import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.KV_REST_API_URL = "http://money-cluster.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const keyspace = await import("../app/api/_redis-atomic-keyspace.js");
const money = await import("../app/api/_money.js");
const ACCOUNT_LIFECYCLE_ID = "a".repeat(32);

function redisSlot(key) {
  const tag = keyspace.redisHashTag(key);
  const bytes = Buffer.from(tag || String(key));
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)) & 0xffff;
    }
  }
  return crc % 16384;
}

async function withClusterMode(callback) {
  const previous = process.env[keyspace.REDIS_ATOMIC_KEYSPACE_ENV];
  process.env[keyspace.REDIS_ATOMIC_KEYSPACE_ENV] = keyspace.REDIS_ATOMIC_CLUSTER_MODE;
  try {
    return await callback();
  } finally {
    if (previous == null) delete process.env[keyspace.REDIS_ATOMIC_KEYSPACE_ENV];
    else process.env[keyspace.REDIS_ATOMIC_KEYSPACE_ENV] = previous;
  }
}

async function withFetch(fetchImpl, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); } finally { globalThis.fetch = previous; }
}

test("legacy Upstash keyspace remains byte-for-byte compatible by default", () => {
  delete process.env[keyspace.REDIS_ATOMIC_KEYSPACE_ENV];
  const existing = [
    "liumeiti:users:old@example.com",
    "liumeiti:users:old@example.com:balance:cents",
    "liumeiti:orders:record:LMOLD1",
    "liumeiti:redeem-code:OLD1",
    "liumeiti:withdrawal:WDOLD1",
  ];
  assert.deepEqual(keyspace.redisAtomicStorageKeys(existing), existing);
});

test("two distinct valid long account emails never share money or lifecycle keys", () => {
  const first = `${"a".repeat(188)}@example.com`;
  const second = `${first}x`;
  assert.equal(first.length, 200);
  assert.equal(second.length, 201);
  assert.notEqual(money.balanceCentsKey(first), money.balanceCentsKey(second));
  assert.notEqual(money.accountLifecycleKey(first), money.accountLifecycleKey(second));
});

test("cluster-v1 maps arbitrary atomic keys to one explicit Redis hash slot", async () => {
  await withClusterMode(async () => {
    const logical = [
      "liumeiti:users:a@example.com",
      "liumeiti:users:b@example.com:balance:cents",
      "liumeiti:orders:record:LM1",
      "liumeiti:redeem-code:ONCE1",
      "liumeiti:stock:ai:gpt",
      "liumeiti:withdrawals",
      "lm:usdt:confirmed-tx:" + "a".repeat(64),
    ];
    const physical = keyspace.redisAtomicStorageKeys(logical);
    assert.equal(keyspace.redisKeysShareExplicitHashTag(physical), true);
    assert.equal(new Set(physical.map(redisSlot)).size, 1);
    assert.equal(new Set(physical).size, logical.length);
    for (let index = 0; index < physical.length; index += 1) {
      assert.equal(physical[index], keyspace.REDIS_ATOMIC_HASH_TAG + ":" + logical[index]);
    }
  });
});

class CaptureRedis {
  constructor() {
    this.values = new Map([[keyspace.REDIS_ATOMIC_SCHEMA_READY_KEY, keyspace.REDIS_ATOMIC_SCHEMA_READY_VALUE]]);
    this.evalKeys = [];
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => {
        if (command[0] === "EVAL") {
          const count = Number(command[2]);
          this.evalKeys.push(command.slice(3, 3 + count));
          return { result: JSON.stringify({ ok: true }) };
        }
        return { result: null };
      }));
    }
    const [command, ...args] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (command === "GET") return Response.json({ result: this.values.get(args[0]) ?? null });
    throw new Error("unexpected command " + command);
  };
}

test("cluster-v1 is rejected before every money EVAL even when a marker exists", async () => {
  await withClusterMode(async () => {
    const redis = new CaptureRedis();
    const result = await withFetch(redis.fetch, () => money.transferBalanceAtomic(
      "a@example.com", "b@example.com", 1,
      { operationId: "cluster-transfer-01", authVersion: 1, accountLifecycleId: ACCOUNT_LIFECYCLE_ID },
    ));
    assert.equal(result.ok, false);
    assert.equal(result.error, "redis_cluster_keyspace_not_supported");
    assert.equal(redis.evalKeys.length, 0);
  });
});

test("cluster-v1 fails closed before EVAL when no migration marker exists", async () => {
  await withClusterMode(async () => {
    let evalCount = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        evalCount += JSON.parse(String(init.body || "[]")).length;
        return Response.json([]);
      }
      return Response.json({ result: null });
    };
    const result = await withFetch(fetchImpl, () => money.transferBalanceAtomic(
      "a@example.com", "b@example.com", 1,
      { operationId: "cluster-not-ready-01", authVersion: 1, accountLifecycleId: ACCOUNT_LIFECYCLE_ID },
    ));
    assert.equal(result.ok, false);
    assert.equal(result.error, "redis_cluster_keyspace_not_supported");
    assert.equal(evalCount, 0);
  });
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

test("real Redis cluster-v1 guard leaves tagged and legacy balances untouched", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker-backed verification" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-money-cluster-${process.pid}-${Date.now()}`;
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
    await withClusterMode(async () => {
      const physical = money.moneyKeys.redisAtomicStorageKey;
      redis.run(["SET", keyspace.REDIS_ATOMIC_SCHEMA_READY_KEY, keyspace.REDIS_ATOMIC_SCHEMA_READY_VALUE]);
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
        redis.run(["SET", physical(`liumeiti:users:${email}`), JSON.stringify({ email, balance: email === "a@example.com" ? 100 : 0 })]);
        redis.run(["SET", physical(`liumeiti:users:${email}:balance:cents`), email === "a@example.com" ? "10000" : "0"]);
      }
      const result = await withFetch(redis.fetch, () => money.transferBalanceAtomic(
        "a@example.com", "b@example.com", 100,
        { operationId: "cluster-real-01", authVersion: 1, accountLifecycleId: ACCOUNT_LIFECYCLE_ID },
      ));
      assert.equal(result.ok, false);
      assert.equal(result.error, "redis_cluster_keyspace_not_supported");
      assert.equal(redis.run(["GET", physical("liumeiti:users:a@example.com:balance:cents")]), "10000");
      const recipients = ["b@example.com", "c@example.com"].map((email) => Number(
        redis.run(["GET", physical(`liumeiti:users:${email}:balance:cents`)]),
      ));
      assert.deepEqual(recipients, [0, 0]);
      assert.equal(redis.run(["GET", "liumeiti:users:a@example.com:balance:cents"]), null);
      const taggedKeys = redis.run(["KEYS", keyspace.REDIS_ATOMIC_HASH_TAG + ":*"]);
      assert.equal(new Set(taggedKeys.map(redisSlot)).size, 1);
    });
  } finally {
    docker(["rm", "-f", container]);
  }
});
