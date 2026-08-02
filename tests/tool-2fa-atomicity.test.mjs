import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { tool2faInternals } = await import("../app/api/tool/2fa/route.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function realRedis(container) {
  return (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
}

function parsed(value) {
  return JSON.parse(value);
}

test("2FA scripts bind auth version, account lifecycle, revision CAS, and tombstones", () => {
  for (const script of [tool2faInternals.READ_SCRIPT, tool2faInternals.WRITE_SCRIPT, tool2faInternals.DELETE_SCRIPT]) {
    assert.match(script, /session_state_changed/);
    assert.match(script, /account_lifecycle_changed/);
    assert.match(script, /KEYS\[4\]/);
  }
  assert.match(tool2faInternals.WRITE_SCRIPT, /revision_conflict/);
  assert.match(tool2faInternals.DELETE_SCRIPT, /deleted=true/);
  assert.doesNotMatch(tool2faInternals.DELETE_SCRIPT, /redis\.call\('DEL',KEYS\[1\]\)/);
});

test("real Redis retires unowned legacy 2FA data and rejects stale PUT after delete", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-tool2fa-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const run = realRedis(container);
    const email = "user@example.com";
    const dataKey = tool2faInternals.tool2faKey(email);
    const userKey = `liumeiti:users:${email}`;
    const versionKey = `lm:user:authver:${email}`;
    const lifecycleKey = `lm:user:lifecycle:${email}`;
    const lifecycleA = "a".repeat(32);
    const lifecycleB = "b".repeat(32);
    run(["SET", userKey, JSON.stringify({ email, banned: false })]);
    run(["SET", versionKey, "1"]);
    run(["SET", lifecycleKey, lifecycleB]);

    run(["SET", dataKey, JSON.stringify({ rev: 1, enc: "legacy-secret-ciphertext" })]);
    const legacyRead = parsed(run([
      "EVAL", tool2faInternals.READ_SCRIPT, "4", dataKey, userKey, versionKey, lifecycleKey, "1", lifecycleB,
    ]));
    const retiredLegacy = parsed(legacyRead.raw);
    assert.equal(retiredLegacy.deleted, true);
    assert.equal(retiredLegacy.accountLifecycleId, lifecycleB);
    assert.equal(Object.hasOwn(retiredLegacy, "enc"), false);

    run(["SET", dataKey, JSON.stringify({ rev: 3, accountLifecycleId: lifecycleA, enc: "old-owner-secret" })]);
    const mismatchedRead = parsed(run([
      "EVAL", tool2faInternals.READ_SCRIPT, "4", dataKey, userKey, versionKey, lifecycleKey, "1", lifecycleB,
    ]));
    const retiredMismatch = parsed(mismatchedRead.raw);
    assert.equal(retiredMismatch.deleted, true);
    assert.equal(retiredMismatch.rev, 4);
    assert.equal(Object.hasOwn(retiredMismatch, "enc"), false);

    const next = JSON.stringify({ rev: 5, accountLifecycleId: lifecycleB, enc: "new-owner-secret" });
    const written = parsed(run([
      "EVAL", tool2faInternals.WRITE_SCRIPT, "4", dataKey, userKey, versionKey, lifecycleKey,
      "4", next, "1", lifecycleB,
    ]));
    assert.equal(written.ok, true);

    const deleted = parsed(run([
      "EVAL", tool2faInternals.DELETE_SCRIPT, "4", dataKey, userKey, versionKey, lifecycleKey, "1", lifecycleB,
    ]));
    assert.equal(deleted.deleted, true);
    const delayedPut = parsed(run([
      "EVAL", tool2faInternals.WRITE_SCRIPT, "4", dataKey, userKey, versionKey, lifecycleKey,
      "5", JSON.stringify({ rev: 6, accountLifecycleId: lifecycleB, enc: "stale-secret" }), "1", lifecycleB,
    ]));
    assert.equal(delayedPut.error, "revision_conflict");
    const finalRecord = parsed(run(["GET", dataKey]));
    assert.equal(finalRecord.deleted, true);
    assert.equal(Object.hasOwn(finalRecord, "enc"), false);
  } finally {
    docker(["rm", "-f", container]);
  }
});
