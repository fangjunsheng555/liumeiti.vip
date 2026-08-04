import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "http://netflix-atomic.redis.test";
process.env.KV_REST_API_TOKEN = "netflix-atomic-token";
process.env.NETFLIX_CODE_ENCRYPTION_KEY = "netflix-atomic-test-encryption-key-2026-long";

const store = await import("../app/api/netflix-code/_store.js");
const docker = (args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

function realRedis(container) {
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
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("Netflix marker and admin deletes remain atomic under ambiguous and WRONGTYPE failures", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async (t) => {
  const container = `lm-netflix-atomic-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    await t.test("a lost marker response recovers only after both keys committed", async () => {
      redis.run(["FLUSHDB"]);
      let dropped = false;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
        if (!dropped && command[0] === "EVAL" && command[2] === "2") {
          dropped = true;
          redis.run(command);
          return Response.json({ result: null });
        }
        return redis.fetch(input, init);
      };
      assert.equal(await store.markNetflixCodeResultReturned("LMATOMICMARKER01", `NM${"A".repeat(24)}`), true);
      assert.equal(redis.run(["DBSIZE"]), 2);
      globalThis.fetch = redis.fetch;
    });

    await t.test("mail deletion preflights every key before deleting the record", async () => {
      redis.run(["FLUSHDB"]);
      const saved = await store.storeNetflixMailEvent({
        accepted: true,
        kind: "code",
        value: "4827",
        accountEmails: ["atomic-netflix@example.com"],
        sender: "info@account.netflix.com",
        subject: "Netflix sign-in code",
        receivedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        deliveryFingerprint: "1".repeat(64),
        deliveryFingerprintFromCurrent: true,
        requestEvidence: ["message-id:<atomic@example.com>"],
      }, { messageId: "atomic-mail", digest: "atomic-mail" });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const recordKey = `liumeiti:netflix-mail:event:${saved.eventId}`;
      const record = JSON.parse(redis.run(["GET", recordKey]));
      const indexKey = "liumeiti:netflix-mail:received";
      redis.run(["DEL", indexKey]);
      redis.run(["SET", indexKey, "wrong-type"]);
      assert.deepEqual(await store.deleteNetflixMailEvents([saved.eventId]), { ok: false, deleted: 0 });
      assert.equal(redis.run(["EXISTS", recordKey]), 1);

      redis.run(["DEL", indexKey]);
      redis.run(["ZADD", indexKey, Date.now(), saved.eventId]);
      const accountKey = `liumeiti:netflix-mail:account:${record.accountHashes[0]}`;
      redis.run(["DEL", accountKey]);
      redis.run(["SET", accountKey, "wrong-type"]);
      assert.deepEqual(await store.deleteNetflixMailEvents([saved.eventId]), { ok: false, deleted: 0 });
      assert.equal(redis.run(["EXISTS", recordKey]), 1);

      redis.run(["DEL", accountKey]);
      redis.run(["ZADD", accountKey, Date.now(), saved.eventId]);
      let droppedDelete = false;
      globalThis.fetch = async (input, init = {}) => {
        const command = new URL(String(input)).pathname.split("/").slice(1).map(decodeURIComponent);
        if (!droppedDelete && command[0] === "EVAL" && command[1].includes("item.accountKeys")) {
          droppedDelete = true;
          redis.run(command);
          return Response.json({ result: null });
        }
        return redis.fetch(input, init);
      };
      assert.deepEqual(await store.deleteNetflixMailEvents([saved.eventId]), { ok: true, deleted: 1 });
      globalThis.fetch = redis.fetch;
      assert.equal(redis.run(["EXISTS", recordKey]), 0);
      assert.deepEqual(await store.deleteNetflixMailEvents([saved.eventId]), { ok: true, deleted: 1 });
    });

    await t.test("access deletion tolerates an expired dedupe key but never partial-deletes on WRONGTYPE", async () => {
      redis.run(["FLUSHDB"]);
      const indexKey = "liumeiti:netflix-code:access-success-index:v1";
      redis.run(["LPUSH", indexKey, "wrong-type"]);
      assert.equal(await store.recordNetflixCodeAccess({
        orderId: "LMATOMICACCESS01", eventId: `NM${"B".repeat(24)}`, outcome: "code_returned",
      }), false);
      assert.deepEqual(redis.run(["KEYS", "liumeiti:netflix-code:access:NA*"]), []);
      assert.deepEqual(redis.run(["KEYS", "liumeiti:netflix-code:access-success-dedupe:*"]), []);
      redis.run(["DEL", indexKey]);

      let dropped = false;
      globalThis.fetch = async (input, init = {}) => {
        const command = new URL(String(input)).pathname.split("/").slice(1).map(decodeURIComponent);
        if (!dropped && command[0] === "EVAL" && command[1].includes("next.orderId")) {
          dropped = true;
          redis.run(command);
          return Response.json({ result: null });
        }
        return redis.fetch(input, init);
      };
      assert.equal(await store.recordNetflixCodeAccess({
        orderId: "LMATOMICACCESS01",
        eventId: `NM${"B".repeat(24)}`,
        outcome: "code_returned",
        userEmail: "buyer@example.com",
        accountEmail: "atomic-netflix@example.com",
      }), true);
      globalThis.fetch = redis.fetch;
      const accessId = String(redis.run(["ZRANGE", indexKey, "0", "0"])[0]);
      const firstScore = redis.run(["ZSCORE", indexKey, accessId]);
      assert.equal(await store.recordNetflixCodeAccess({
        orderId: "LMATOMICACCESS01",
        eventId: `NM${"B".repeat(24)}`,
        outcome: "code_returned",
      }), true);
      assert.equal(redis.run(["ZSCORE", indexKey, accessId]), firstScore, "duplicate access must not look newer in history");
      const records = await store.listAllNetflixCodeAccess();
      assert.equal(records.length, 1);
      const record = records[0];
      const recordKey = `liumeiti:netflix-code:access:${record.id}`;
      redis.run(["DEL", indexKey]);
      redis.run(["LPUSH", indexKey, "wrong-type"]);
      assert.deepEqual(await store.deleteNetflixCodeAccessRecords([record.id]), { ok: false, deleted: 0 });
      assert.equal(redis.run(["EXISTS", recordKey]), 1);
      redis.run(["DEL", indexKey]);
      redis.run(["ZADD", indexKey, Date.now(), record.id]);
      for (const key of redis.run(["KEYS", "liumeiti:netflix-code:access-success-dedupe:*"])) redis.run(["DEL", key]);
      let droppedDelete = false;
      globalThis.fetch = async (input, init = {}) => {
        const command = new URL(String(input)).pathname.split("/").slice(1).map(decodeURIComponent);
        if (!droppedDelete && command[0] === "EVAL" && command[1].includes("local dedupeKey")) {
          droppedDelete = true;
          redis.run(command);
          return Response.json({ result: null });
        }
        return redis.fetch(input, init);
      };
      assert.deepEqual(await store.deleteNetflixCodeAccessRecords([record.id]), { ok: true, deleted: 1 });
      globalThis.fetch = redis.fetch;
      assert.equal(redis.run(["EXISTS", recordKey]), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
