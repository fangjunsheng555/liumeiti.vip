import assert from "node:assert/strict";
import test from "node:test";

process.env.KV_REST_API_URL = "http://backup.redis.test";
process.env.KV_REST_API_TOKEN = "backup-token";

const store = new Map([
  ["liumeiti:string", { type: "string", value: "hello", ttl: -1 }],
  ["liumeiti:list", { type: "list", value: ["a", "b"], ttl: 60000 }],
  ["liumeiti:set", { type: "set", value: ["beta", "alpha"], ttl: -1 }],
  ["liumeiti:hash", { type: "hash", value: { email: "user@example.com", balance: "8.88" }, ttl: -1 }],
  ["liumeiti:zset", { type: "zset", value: [["second", "2"], ["first", "1"]], ttl: -1 }],
]);
const originalFetch = globalThis.fetch;
let pipelineOverride = null;

function ensure(key, type, fallback) {
  if (!store.has(key)) store.set(key, { type, value: fallback, ttl: -1 });
  return store.get(key);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName).toUpperCase();
  if (name === "SCAN") return ["0", Array.from(store.keys())];
  if (name === "TYPE") return store.get(args[0])?.type || "none";
  if (name === "PTTL") return store.get(args[0])?.ttl ?? -2;
  if (name === "PING") return "PONG";
  if (name === "GET") return store.get(args[0])?.value ?? null;
  if (name === "SET") { store.set(args[0], { type: "string", value: String(args[1]), ttl: -1 }); return "OK"; }
  if (name === "DEL") { let count = 0; args.forEach((key) => { if (store.delete(key)) count += 1; }); return count; }
  if (name === "PEXPIRE") { const item = store.get(args[0]); if (item) item.ttl = Number(args[1]); return item ? 1 : 0; }
  if (name === "LRANGE") return [...(store.get(args[0])?.value || [])];
  if (name === "RPUSH") { const item = ensure(args[0], "list", []); item.value.push(...args.slice(1).map(String)); return item.value.length; }
  if (name === "SMEMBERS") return [...(store.get(args[0])?.value || [])];
  if (name === "SADD") { const item = ensure(args[0], "set", []); item.value = Array.from(new Set([...item.value, ...args.slice(1).map(String)])); return item.value.length; }
  if (name === "HGETALL") return { ...(store.get(args[0])?.value || {}) };
  if (name === "HSET") {
    const item = ensure(args[0], "hash", {});
    for (let index = 1; index + 1 < args.length; index += 2) item.value[String(args[index])] = String(args[index + 1]);
    return 1;
  }
  if (name === "ZRANGE") return (store.get(args[0])?.value || []).flatMap(([member, score]) => [member, score]);
  if (name === "XRANGE") return [...(store.get(args[0])?.value || [])];
  if (name === "ZADD") {
    const item = ensure(args[0], "zset", []);
    for (let index = 1; index + 1 < args.length; index += 2) {
      const score = String(args[index]);
      const member = String(args[index + 1]);
      item.value = item.value.filter(([existing]) => existing !== member);
      item.value.push([member, score]);
    }
    return 1;
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://backup.redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      if (pipelineOverride) {
        const overridden = pipelineOverride(commands);
        if (overridden !== undefined) return Response.json(overridden);
      }
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
  }
  return originalFetch(input, options);
};

const backup = await import("../app/api/_backup.js");

test("complete backup captures every supported Redis type and preserves TTL", async () => {
  const snapshot = await backup.createCompleteBackup();
  assert.equal(snapshot.keyCount, 5);
  assert.deepEqual(snapshot.typeCounts, { hash: 1, list: 1, set: 1, string: 1, zset: 1 });
  assert.equal(snapshot.entries.find((entry) => entry.key === "liumeiti:list").pttl, 60000);
  assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);
});

test("restore drill recreates and verifies every captured key then removes temporary keys", async () => {
  const snapshot = await backup.createCompleteBackup();
  const result = await backup.runRestoreDrill(snapshot);
  assert.deepEqual(result, { ok: true, verified: 5, total: 5, mismatches: [] });
  assert.equal(Array.from(store.keys()).some((key) => key.startsWith("lm:restore-drill:")), false);
});

test("large backups are split with a manifest and all entries retained", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({ key: `k:${index}`, type: "string", pttl: -1, value: "x".repeat(300) }));
  const snapshot = { site: "liumeiti.vip", version: 2, format: "redis-logical-snapshot", generatedAt: new Date().toISOString(), generatedAtBeijing: "now", keyCount: entries.length, checksum: "abc", entries };
  const files = backup.buildBackupFiles(snapshot, 900);
  assert.ok(files.length > 2);
  const retained = files.slice(1).reduce((sum, file) => sum + file.entries, 0);
  assert.equal(retained, entries.length);
  assert.match(files[0].name, /manifest/);
});

test("a malformed business stream row aborts the complete backup instead of silently dropping data", async () => {
  const key = "liumeiti:business-events";
  try {
    for (const malformed of [
      7,
      ["1754700000001-0", ["event"]],
      { id: "", fields: { event: "order_paid" } },
      { id: "1754700000002-0", fields: {} },
    ]) {
      store.set(key, {
        type: "stream",
        ttl: -1,
        value: [
          ["1754700000000-0", ["event", "order_paid", "orderId", "LM-BACKUP-STREAM-1"]],
          malformed,
        ],
      });
      await assert.rejects(
        backup.createCompleteBackup(),
        (error) => error?.code === "backup_stream_record_invalid",
      );
    }
  } finally {
    store.delete(key);
  }
});

test("backup rejects command errors in metadata and value pipelines", async () => {
  for (const targetCommand of ["TYPE", "GET"]) {
    pipelineOverride = (commands) => commands.map((command) => (
      String(command[0]).toUpperCase() === targetCommand
        ? { error: `WRONGTYPE injected ${targetCommand}` }
        : { result: execute(command) }
    ));
    await assert.rejects(
      backup.createCompleteBackup(),
      (error) => error?.message === (targetCommand === "TYPE" ? "backup_metadata_incomplete" : "backup_values_incomplete"),
    );
  }
  pipelineOverride = (commands) => ({ result: commands.map((command) => ({ result: execute(command) })) });
  await assert.rejects(backup.createCompleteBackup(), /backup_metadata_incomplete/);
  pipelineOverride = null;
});

test("backup rejects malformed successful collection responses instead of publishing a complete snapshot", async () => {
  const malformedByCommand = [
    ["HGETALL", ["field-without-value"]],
    ["HGETALL", {}],
    ["LRANGE", { 0: "not-an-array" }],
    ["SMEMBERS", ["valid", { unexpected: true }]],
    ["ZRANGE", ["member-without-score"]],
    ["ZRANGE", [{ member: "member", score: "not-a-number" }]],
  ];
  try {
    for (const [targetCommand, malformed] of malformedByCommand) {
      pipelineOverride = (commands) => commands.map((command) => (
        String(command[0]).toUpperCase() === targetCommand
          ? { result: malformed }
          : { result: execute(command) }
      ));
      await assert.rejects(
        backup.createCompleteBackup(),
        (error) => error?.code === "backup_value_shape_invalid",
      );
    }
  } finally {
    pipelineOverride = null;
  }
});

test("backup rejects malformed TYPE and PTTL metadata returned by successful commands", async () => {
  try {
    for (const [targetCommand, malformed] of [["TYPE", {}], ["PTTL", "12.5"], ["PTTL", -3]]) {
      pipelineOverride = (commands) => commands.map((command) => (
        String(command[0]).toUpperCase() === targetCommand
          ? { result: malformed }
          : { result: execute(command) }
      ));
      await assert.rejects(backup.createCompleteBackup(), /backup_metadata_incomplete/);
    }
  } finally {
    pipelineOverride = null;
  }
});

test("restore drill rejects write and verification command errors", async () => {
  const snapshot = await backup.createCompleteBackup();
  for (const targetCommand of ["SET", "GET"]) {
    pipelineOverride = (commands) => commands.map((command) => (
      String(command[0]).toUpperCase() === targetCommand
        ? { error: `ERR injected ${targetCommand}` }
        : { result: execute(command) }
    ));
    await assert.rejects(
      backup.runRestoreDrill(snapshot),
      (error) => error?.message === (targetCommand === "SET" ? "restore_write_failed" : "restore_verify_read_failed"),
    );
    for (const key of Array.from(store.keys())) {
      if (key.startsWith("lm:restore-drill:")) store.delete(key);
    }
  }
  pipelineOverride = null;
});
