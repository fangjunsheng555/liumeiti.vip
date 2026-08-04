import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.AUTH_SECRET = "withdrawal-archive-test-secret-at-least-32-chars";
process.env.KV_REST_API_URL = "http://withdrawal.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");
const withdrawalRoute = await import(`../app/api/admin/withdrawals/route.js?withdrawal-archive=${Date.now()}`);

const LIST_KEY = "liumeiti:withdrawals";
const RECORD_PREFIX = "liumeiti:withdrawal:";
const ACTION_LOG_KEY = "liumeiti:admin:action-log";

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") return structuredClone(value);
  return value;
}

class WithdrawalRedisMock {
  constructor(entries = [], fault = "") {
    this.values = new Map(entries.map(([key, value]) => [key, cloneValue(value)]));
    this.commands = [];
    this.evalCalls = 0;
    this.fault = fault;
  }

  snapshot() {
    return JSON.stringify(Array.from(this.values.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, cloneValue(value)]));
  }

  command(command) {
    this.commands.push(command.map(String));
    const [name, ...args] = command;
    if (name === "GET") return this.values.get(args[0]) ?? null;
    if (name === "LRANGE") {
      const list = this.values.get(args[0]);
      if (!Array.isArray(list)) return [];
      const start = Number(args[1]);
      const requestedStop = Number(args[2]);
      const stop = requestedStop < 0 ? list.length + requestedStop : requestedStop;
      return stop < start ? [] : list.slice(start, stop + 1);
    }
    if (name === "LPUSH") {
      const list = Array.isArray(this.values.get(args[0])) ? [...this.values.get(args[0])] : [];
      for (const value of args.slice(1)) list.unshift(value);
      this.values.set(args[0], list);
      return list.length;
    }
    if (name === "LTRIM") {
      const list = Array.isArray(this.values.get(args[0])) ? this.values.get(args[0]) : [];
      const start = Number(args[1]);
      const requestedStop = Number(args[2]);
      const stop = requestedStop < 0 ? list.length + requestedStop : requestedStop;
      this.values.set(args[0], stop < start ? [] : list.slice(start, stop + 1));
      return "OK";
    }
    throw new Error(`unhandled Redis command ${name}`);
  }

  evalArchive(command) {
    this.evalCalls += 1;
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    const [operationKey, listKey, auditKey, ...recordKeys] = keys;
    const [requestHash, archivedAt, rawActor, rawIds, rawResult, rawOperation, rawAudit] = args;
    const existingOperation = this.values.get(operationKey);
    if (typeof existingOperation === "string") {
      let record;
      try { record = JSON.parse(existingOperation); } catch (error) { return { ok: false, error: "storage_failed" }; }
      if (record.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
      try {
        return {
          ...JSON.parse(record.retryResultJson || record.resultJson),
          idempotent: true,
          recovered: true,
        };
      } catch (error) { return { ok: false, error: "storage_failed" }; }
    }

    let ids;
    let result;
    let operation;
    let audit;
    try {
      ids = JSON.parse(rawIds);
      result = JSON.parse(rawResult);
      operation = JSON.parse(rawOperation);
      audit = JSON.parse(rawAudit);
    } catch (error) { return { ok: false, error: "storage_failed" }; }
    if (!Array.isArray(ids) || ids.length !== recordKeys.length || operation.requestHash !== requestHash) {
      return { ok: false, error: "storage_failed" };
    }
    const list = this.values.get(listKey);

    let actor;
    try { actor = JSON.parse(rawActor); } catch (error) { return { ok: false, error: "storage_failed" }; }
    const replacements = [];
    const archived = [];
    for (let index = 0; index < recordKeys.length; index += 1) {
      const id = ids[index];
      const raw = this.values.get(recordKeys[index]);
      if (raw == null) return { ok: false, error: "withdrawal_not_found", id };
      if (typeof raw !== "string") return { ok: false, error: "storage_failed", id };
      let withdrawal;
      try { withdrawal = JSON.parse(raw); } catch (error) { return { ok: false, error: "storage_failed", id }; }
      if (withdrawal.archived === true) {
        archived.push(id);
        continue;
      }
      if (withdrawal.status !== "success" && withdrawal.status !== "failed") {
        return { ok: false, error: "withdrawal_active", id, status: withdrawal.status || "" };
      }
      replacements.push([recordKeys[index], JSON.stringify({
        ...withdrawal,
        archived: true,
        archivedAt,
        actor,
        revision: Number(withdrawal.revision || 0) + 1,
      })]);
    }

    if (archived.length === ids.length) {
      this.values.set(operationKey, rawOperation);
      return { ...result, idempotent: true, recovered: true };
    }
    if (archived.length > 0) return { ok: false, error: "withdrawal_already_archived", id: archived[0] };
    if (!Array.isArray(list)) {
      return { ok: false, error: this.values.has(listKey) ? "storage_failed" : "withdrawal_not_indexed", id: ids[0] };
    }
    for (const id of ids) {
      if (!list.includes(id)) return { ok: false, error: "withdrawal_not_indexed", id };
    }

    // Commit only after every target passed validation, mirroring the Lua
    // preflight + MSET + LREM + durable operation transaction.
    const draft = new Map(Array.from(this.values.entries()).map(([key, value]) => [key, cloneValue(value)]));
    for (const [key, value] of replacements) draft.set(key, value);
    draft.set(listKey, list.filter((id) => !ids.includes(id)));
    const auditList = Array.isArray(draft.get(auditKey)) ? [...draft.get(auditKey)] : [];
    auditList.unshift(JSON.stringify(audit));
    draft.set(auditKey, auditList.slice(0, 500));
    draft.set(operationKey, rawOperation);
    this.values = draft;
    return result;
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      this.commands.push(...commands.map((command) => command.map(String)));
      if (commands[0]?.[0] === "EVAL") {
        if (this.fault === "http") return new Response("unavailable", { status: 503 });
        if (this.fault === "row") return Response.json([{ error: "ERR injected" }]);
        const result = this.evalArchive(commands[0]);
        if (this.fault === "drop_after_commit") return new Response("gateway timeout", { status: 504 });
        return Response.json([{ result: JSON.stringify(result) }]);
      }
      return Response.json(commands.map((command) => ({ result: this.command(command) })));
    }
    const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
    return Response.json({ result: this.command(command) });
  };
}

function record(id, status, extra = {}) {
  return [RECORD_PREFIX + id, JSON.stringify({
    id,
    status,
    amount: 12.34,
    userEmail: `${id.toLowerCase()}@example.com`,
    ...extra,
  })];
}

async function withRedis(redis, callback) {
  const originalFetch = global.fetch;
  global.fetch = redis.fetch;
  try { return await callback(); } finally { global.fetch = originalFetch; }
}

test("listWithdrawals reads the complete active index", async () => {
  const ids = Array.from({ length: 503 }, (_, index) => `WD${String(index + 1).padStart(4, "0")}`);
  const redis = new WithdrawalRedisMock([
    [LIST_KEY, ids],
    ...ids.map((id) => record(id, "pending")),
  ]);

  await withRedis(redis, async () => {
    const withdrawals = await utils.listWithdrawals();
    assert.equal(withdrawals.length, 503);
    const range = redis.commands.find((command) => command[0] === "LRANGE");
    assert.deepEqual(range, ["LRANGE", LIST_KEY, "0", "-1"]);
  });
});

test("pending and processing withdrawals cannot be archived", async (t) => {
  for (const status of ["pending", "processing"]) {
    await t.test(status, async () => {
      const id = `WD-${status.toUpperCase()}`;
      const redis = new WithdrawalRedisMock([[LIST_KEY, [id]], record(id, status)]);
      const before = redis.snapshot();
      await withRedis(redis, async () => {
        const result = await utils.deleteWithdrawals([id], { staffId: 7, staffUsername: "finance" });
        assert.deepEqual(result, { ok: false, error: "withdrawal_active", id, status });
      });
      assert.equal(redis.snapshot(), before);
      assert.equal(redis.evalCalls, 1);
    });
  }
});

test("success and failed withdrawals are atomically archived without deleting records", async () => {
  const redis = new WithdrawalRedisMock([
    [LIST_KEY, ["WD-SUCCESS", "WD-FAILED", "WD-PENDING"]],
    record("WD-SUCCESS", "success", { reviewNote: "paid", metadata: { channel: "alipay" } }),
    record("WD-FAILED", "failed", { reviewNote: "rejected" }),
    record("WD-PENDING", "pending"),
  ]);

  await withRedis(redis, async () => {
    const result = await utils.deleteWithdrawals(
      ["WD-SUCCESS", "WD-FAILED"],
      { staffId: 9, staffUsername: "owner" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.archivedCount, 2);
    assert.deepEqual(result.archivedIds, ["WD-FAILED", "WD-SUCCESS"]);
  });

  assert.deepEqual(redis.values.get(LIST_KEY), ["WD-PENDING"]);
  const success = JSON.parse(redis.values.get(RECORD_PREFIX + "WD-SUCCESS"));
  const failed = JSON.parse(redis.values.get(RECORD_PREFIX + "WD-FAILED"));
  for (const withdrawal of [success, failed]) {
    assert.equal(withdrawal.archived, true);
    assert.match(withdrawal.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(withdrawal.actor, { staffId: 9, staffUsername: "owner" });
  }
  assert.equal(success.reviewNote, "paid");
  assert.deepEqual(success.metadata, { channel: "alipay" });
  assert.equal(failed.reviewNote, "rejected");
  assert.equal(redis.evalCalls, 1);
  assert.equal(redis.commands.some((command) => command[0] === "DEL" || command[0] === "RPUSH"), false);
  const evalCommand = redis.commands.find((command) => command[0] === "EVAL");
  assert.match(evalCommand[1], /redis\.call\('MSET'/);
  assert.match(evalCommand[1], /redis\.call\('LREM'/);
  assert.doesNotMatch(evalCommand[1], /redis\.call\('DEL'/);
  assert.ok(evalCommand[1].indexOf("status ~= 'success'") < evalCommand[1].indexOf("redis.call('MSET'"));
  assert.ok(evalCommand[1].indexOf("not indexed[id]") < evalCommand[1].indexOf("redis.call('MSET'"));
});

test("archive recovers the permanent result when the commit response is lost", async () => {
  const redis = new WithdrawalRedisMock([
    [LIST_KEY, ["WD-LOST"]],
    record("WD-LOST", "success", { revision: 4 }),
  ], "drop_after_commit");

  await withRedis(redis, async () => {
    const result = await utils.deleteWithdrawals(
      ["WD-LOST"],
      { staffId: 11, staffUsername: "finance" },
      { operationId: "archive-lost-response-001" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.recovered, true);
    assert.deepEqual(result.archivedIds, ["WD-LOST"]);
  });

  assert.deepEqual(redis.values.get(LIST_KEY), []);
  const archived = JSON.parse(redis.values.get(RECORD_PREFIX + "WD-LOST"));
  assert.equal(archived.archived, true);
  assert.equal(archived.revision, 5);
  assert.equal(redis.evalCalls, 1);
  assert.ok(Array.from(redis.values.keys()).some((key) => key.startsWith("liumeiti:admin:operation:withdrawal-archive:")));
});

test("archive idempotency survives staff changes and still binds key to payload", async () => {
  const redis = new WithdrawalRedisMock([
    [LIST_KEY, ["WD-RETRY", "WD-OTHER"]],
    record("WD-RETRY", "failed"),
    record("WD-OTHER", "success"),
  ]);

  await withRedis(redis, async () => {
    const options = { operationId: "archive-stable-retry-001" };
    const firstActor = { staffId: 11, staffUsername: "owner-a" };
    const retryActor = { staffId: 12, staffUsername: "owner-b" };
    const first = await utils.deleteWithdrawals(["WD-RETRY"], firstActor, options);
    const storedAfterFirst = redis.snapshot();
    const second = await utils.deleteWithdrawals(["WD-RETRY"], retryActor, options);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.recovered, true);
    assert.equal(redis.snapshot(), storedAfterFirst);

    const conflict = await utils.deleteWithdrawals(["WD-OTHER"], retryActor, options);
    assert.deepEqual(conflict, { ok: false, error: "idempotency_conflict", id: "", status: "" });
    assert.equal(JSON.parse(redis.values.get(RECORD_PREFIX + "WD-OTHER")).archived, undefined);

    const differentKey = await utils.deleteWithdrawals(
      ["WD-OTHER"],
      retryActor,
      { operationId: "archive-stable-retry-002" },
    );
    assert.equal(differentKey.ok, true);
    assert.deepEqual(JSON.parse(redis.values.get(RECORD_PREFIX + "WD-RETRY")).actor, firstActor);
    assert.deepEqual(JSON.parse(redis.values.get(RECORD_PREFIX + "WD-OTHER")).actor, retryActor);
  });
  assert.equal(redis.evalCalls, 2, "durable retries resolve before rereading or mutating business records");
  assert.equal(Array.from(redis.values.keys())
    .filter((key) => key.startsWith("liumeiti:admin:operation:withdrawal-archive:"))
    .length, 2);
});

test("mixed batches and storage failures leave the complete batch unchanged", async (t) => {
  await t.test("terminal plus active", async () => {
    const redis = new WithdrawalRedisMock([
      [LIST_KEY, ["WD-DONE", "WD-ACTIVE"]],
      record("WD-DONE", "success"),
      record("WD-ACTIVE", "pending"),
    ]);
    const before = redis.snapshot();
    await withRedis(redis, async () => {
      const result = await utils.deleteWithdrawals(["WD-DONE", "WD-ACTIVE"], { staffId: 1, staffUsername: "root" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "withdrawal_active");
      assert.equal(result.id, "WD-ACTIVE");
    });
    assert.equal(redis.snapshot(), before);
    assert.equal(redis.evalCalls, 1);
  });

  for (const fault of ["http", "row"]) {
    await t.test(`${fault} storage failure`, async () => {
      const redis = new WithdrawalRedisMock([
        [LIST_KEY, ["WD-DONE"]],
        record("WD-DONE", "success"),
      ], fault);
      const before = redis.snapshot();
      await withRedis(redis, async () => {
        const result = await utils.deleteWithdrawals(["WD-DONE"], { staffId: 1, staffUsername: "root" });
        assert.deepEqual(result, { ok: false, error: "storage_failed" });
      });
      assert.equal(redis.snapshot(), before);
    });
  }

  await t.test("missing record", async () => {
    const redis = new WithdrawalRedisMock([
      [LIST_KEY, ["WD-DONE", "WD-MISSING"]],
      record("WD-DONE", "success"),
    ]);
    const before = redis.snapshot();
    await withRedis(redis, async () => {
      const result = await utils.deleteWithdrawals(["WD-DONE", "WD-MISSING"], { staffId: 1, staffUsername: "root" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "withdrawal_not_found");
      assert.equal(result.id, "WD-MISSING");
    });
    assert.equal(redis.snapshot(), before);
  });

  await t.test("malformed record", async () => {
    const redis = new WithdrawalRedisMock([
      [LIST_KEY, ["WD-DONE", "WD-BROKEN"]],
      record("WD-DONE", "success"),
      [RECORD_PREFIX + "WD-BROKEN", "{not-json"],
    ]);
    const before = redis.snapshot();
    await withRedis(redis, async () => {
      const result = await utils.deleteWithdrawals(["WD-DONE", "WD-BROKEN"], { staffId: 1, staffUsername: "root" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "storage_failed");
      assert.equal(result.id, "WD-BROKEN");
    });
    assert.equal(redis.snapshot(), before);
  });
});

test("admin DELETE requires an idempotency key before archive storage", async () => {
  const token = utils.signSession({ role: "admin", staffId: 1, staffUsername: "root", exp: Date.now() + 60_000 });
  const response = await withdrawalRoute.DELETE(new Request("http://site.test/api/admin/withdrawals", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: ["WD-ACTIVE"] }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "idempotency_key_required" });
});

test("admin DELETE maps an active withdrawal conflict to HTTP 409", async () => {
  const redis = new WithdrawalRedisMock([
    [LIST_KEY, ["WD-ACTIVE"]],
    record("WD-ACTIVE", "pending"),
  ]);
  const before = redis.snapshot();
  await withRedis(redis, async () => {
    const token = utils.signSession({ role: "admin", staffId: 1, staffUsername: "root", exp: Date.now() + 60_000 });
    const response = await withdrawalRoute.DELETE(new Request("http://site.test/api/admin/withdrawals", {
      method: "DELETE",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(token)}`,
        "content-type": "application/json",
        "idempotency-key": "withdrawal-archive-active-test-0001",
      },
      body: JSON.stringify({ ids: ["WD-ACTIVE"] }),
    }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "withdrawal_active",
      id: "WD-ACTIVE",
      withdrawalStatus: "pending",
    });
  });
  assert.equal(redis.snapshot(), before);
});

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options });
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

test("real Redis executes durable withdrawal archive and target-state retry", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-withdrawal-archive-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedisFetch(container);
    const missing = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-MISSING"],
      { staffId: 10, staffUsername: "owner-preflight" },
      { operationId: "withdrawal-real-missing-001" },
    ));
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "withdrawal_not_found");

    const activeRaw = record("WD-REAL-ACTIVE", "pending", { revision: 1 })[1];
    redis.run(["RPUSH", LIST_KEY, "WD-REAL-ACTIVE"]);
    redis.run(["SET", RECORD_PREFIX + "WD-REAL-ACTIVE", activeRaw]);
    const active = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-ACTIVE"],
      { staffId: 10, staffUsername: "owner-preflight" },
      { operationId: "withdrawal-real-active-001" },
    ));
    assert.equal(active.ok, false);
    assert.equal(active.error, "withdrawal_active");
    assert.equal(redis.run(["GET", RECORD_PREFIX + "WD-REAL-ACTIVE"]), activeRaw);
    redis.run(["LREM", LIST_KEY, "0", "WD-REAL-ACTIVE"]);
    redis.run(["DEL", RECORD_PREFIX + "WD-REAL-ACTIVE"]);

    redis.run(["RPUSH", LIST_KEY, "WD-REAL-A", "WD-REAL-B", "WD-REAL-C"]);
    const losslessWithdrawalRaw = record("WD-REAL-A", "success", { revision: 2, legacyRows: [], legacyNull: null })[1]
      .replace(/}$/, ',"legacyHuge":123456789012345678901234567890}');
    redis.run(["SET", RECORD_PREFIX + "WD-REAL-A", losslessWithdrawalRaw]);
    redis.run(["SET", RECORD_PREFIX + "WD-REAL-B", record("WD-REAL-B", "failed", { revision: 8 })[1]]);
    redis.run(["SET", RECORD_PREFIX + "WD-REAL-C", record("WD-REAL-C", "success", { revision: 4 })[1]]);

    const options = { operationId: "withdrawal-real-archive-001" };
    const firstActor = { staffId: 11, staffUsername: "owner-a" };
    const retryActor = { staffId: 12, staffUsername: "owner-b" };
    const first = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-B", "WD-REAL-A"],
      firstActor,
      options,
    ));
    assert.equal(first.ok, true);
    assert.deepEqual(first.archivedIds, ["WD-REAL-A", "WD-REAL-B"]);
    assert.deepEqual(redis.run(["LRANGE", LIST_KEY, "0", "-1"]), ["WD-REAL-C"]);
    const archivedLosslessRaw = redis.run(["GET", RECORD_PREFIX + "WD-REAL-A"]);
    assert.equal(JSON.parse(archivedLosslessRaw).revision, 3);
    assert.match(archivedLosslessRaw, /"legacyRows":\[\]/);
    assert.match(archivedLosslessRaw, /"legacyNull":null/);
    assert.match(archivedLosslessRaw, /"legacyHuge":123456789012345678901234567890/);
    assert.equal(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-B"])).revision, 9);
    assert.deepEqual(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-A"])).actor, firstActor);
    const operationKeys = redis.run(["KEYS", "liumeiti:admin:operation:withdrawal-archive:*"]);
    assert.equal(operationKeys.length, 1);
    assert.equal(redis.run(["TTL", operationKeys[0]]), -1);

    const retry = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-A", "WD-REAL-B"],
      retryActor,
      options,
    ));
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    assert.equal(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-A"])).revision, 3);
    assert.equal(redis.run(["LLEN", ACTION_LOG_KEY]), 1);
    assert.equal(JSON.parse(redis.run(["LINDEX", ACTION_LOG_KEY, "0"])).staffId, firstActor.staffId);

    const conflict = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-C"],
      retryActor,
      options,
    ));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "idempotency_conflict");
    assert.equal(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-C"])).archived, undefined);

    const differentKey = await withRedis({ fetch: redis.fetch }, () => utils.deleteWithdrawals(
      ["WD-REAL-C"],
      retryActor,
      { operationId: "withdrawal-real-archive-002" },
    ));
    assert.equal(differentKey.ok, true);
    assert.equal(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-C"])).revision, 5);
    assert.deepEqual(JSON.parse(redis.run(["GET", RECORD_PREFIX + "WD-REAL-C"])).actor, retryActor);
    assert.deepEqual(redis.run(["LRANGE", LIST_KEY, "0", "-1"]), []);
    assert.equal(redis.run(["KEYS", "liumeiti:admin:operation:withdrawal-archive:*"]).length, 2);
  } finally {
    docker(["rm", "-f", container]);
  }
});
