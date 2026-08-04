import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://redeem-admin.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");

const CODE_PREFIX = "liumeiti:redeem-code:";
const BATCH_PREFIX = "liumeiti:redeem-code-batch:";
const CODE_LIST = "liumeiti:redeem-codes";
const BATCH_LIST = "liumeiti:redeem-code-batches";
const ACTION_LOG = "liumeiti:admin:action-log";
const OP_PREFIX = "liumeiti:admin:operation:redeem-create:";

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options });
}

function realRedis(container) {
  const state = { beforeNextEval: null, dropNextEvalResponse: false };
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    state,
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        const rows = [];
        for (const command of commands) {
          if (command[0] === "EVAL" && state.beforeNextEval) {
            const hook = state.beforeNextEval;
            state.beforeNextEval = null;
            hook(command);
          }
          rows.push({ result: run(command) });
        }
        if (state.dropNextEvalResponse && commands.some((command) => command[0] === "EVAL")) {
          state.dropNextEvalResponse = false;
          return new Response("gateway timeout", { status: 504 });
        }
        return Response.json(rows);
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

class RedeemCreateRedisMock {
  constructor() {
    this.values = new Map();
    this.commitCalls = 0;
    this.auditActors = [];
  }

  evalCreate(command) {
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    const operationKey = keys[0];
    const requestHash = args[0];
    const existingRaw = this.values.get(operationKey);
    if (typeof existingRaw === "string") {
      const existing = JSON.parse(existingRaw);
      if (existing.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
      return JSON.parse(existing.retryResultJson);
    }

    const operation = JSON.parse(args[5]);
    const audit = JSON.parse(args[6]);
    if (operation.requestHash !== requestHash) return { ok: false, error: "storage_failed" };
    this.values.set(operationKey, args[5]);
    this.commitCalls += 1;
    this.auditActors.push({ staffId: audit.staffId, staffUsername: audit.staffUsername });
    return JSON.parse(args[4]);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({
        result: command[0] === "EVAL"
          ? JSON.stringify(this.evalCreate(command))
          : null,
      })));
    }
    const [name, key] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (String(name).toUpperCase() === "GET") return Response.json({ result: this.values.get(key) ?? null });
    throw new Error(`unhandled Redis command ${name}`);
  };
}

async function withFetch(fetchImpl, callback) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  try { return await callback(); } finally { global.fetch = original; }
}

function codeRecord(code, batchId, status = "active") {
  return {
    code,
    batchId,
    batchIndex: 1,
    batchSize: 1,
    type: "balance",
    amount: 10,
    status,
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

test("admin redeem creation requires a stable idempotency key before storage", async () => {
  const result = await utils.createRedeemCodes({ type: "balance", amount: 10 }, { staffId: 1 });
  assert.deepEqual(result, { ok: false, error: "idempotency_key_required" });
});

test("route and UI carry the required persisted Idempotency-Key", async () => {
  const route = await readFile(new URL("../app/api/admin/redeem-codes/route.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(route, /requiredIdempotencyKey\(request\)/);
  assert.match(route, /operationId:\s*idempotency\.key/);
  assert.match(page, /prepareAdminMutation\("redeem-create",\s*"batch",\s*payload\)/);
  assert.match(page, /"Idempotency-Key":\s*pending\.operation\.key/);
  assert.match(page, /completeAdminMutation\(pending\.storageKey,\s*pending\.operation\)/);
});

test("redeem create idempotency survives a staff-session change", async () => {
  const redis = new RedeemCreateRedisMock();
  const input = { type: "balance", amount: 19.9, quantity: 2, remark: "cross staff" };
  const sharedOptions = { operationId: "redeem-cross-staff-unit-001" };
  const firstActor = { staffId: 11, staffUsername: "operator-a" };
  const retryActor = { staffId: 12, staffUsername: "operator-b" };

  await withFetch(redis.fetch, async () => {
    const first = await utils.createRedeemCodes(input, firstActor, sharedOptions);
    const retry = await utils.createRedeemCodes(input, retryActor, sharedOptions);
    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.recovered, true);
    assert.equal(retry.batch.id, first.batch.id);
    assert.deepEqual(retry.codes.map((item) => item.code), first.codes.map((item) => item.code));
    assert.ok(retry.codes.every((item) => item.createdByStaffId === firstActor.staffId));

    const conflict = await utils.createRedeemCodes(
      { ...input, amount: 20.9 },
      retryActor,
      sharedOptions,
    );
    assert.deepEqual(conflict, { ok: false, error: "idempotency_conflict" });

    const differentKey = await utils.createRedeemCodes(input, retryActor, {
      operationId: "redeem-cross-staff-unit-002",
    });
    assert.equal(differentKey.ok, true);
    assert.notEqual(differentKey.batch.id, first.batch.id);
  });

  assert.equal(redis.commitCalls, 2);
  assert.deepEqual(redis.auditActors, [firstActor, retryActor]);
  assert.equal(Array.from(redis.values.keys()).filter((key) => key.startsWith(OP_PREFIX)).length, 2);
});

test("real Redis enforces redeem create idempotency and management CAS", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-redeem-admin-${process.pid}-${Date.now()}`;
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
    const redis = realRedis(container);
    const actor = { staffId: 11, staffUsername: "operator-a" };
    const retryActor = { staffId: 12, staffUsername: "operator-b" };
    const input = { type: "balance", amount: 25.5, quantity: 2, remark: "atomic" };
    const options = { operationId: "redeem-create-stable-001" };

    const first = await withFetch(redis.fetch, () => utils.createRedeemCodes(input, actor, options));
    const crossStaffRetry = await withFetch(redis.fetch, () => utils.createRedeemCodes(input, retryActor, options));
    assert.equal(first.ok, true);
    assert.equal(crossStaffRetry.ok, true);
    assert.equal(crossStaffRetry.idempotent, true);
    assert.equal(crossStaffRetry.recovered, true);
    assert.equal(first.batch.id, crossStaffRetry.batch.id);
    assert.deepEqual(first.codes.map((item) => item.code), crossStaffRetry.codes.map((item) => item.code));
    assert.ok(crossStaffRetry.codes.every((item) => item.createdByStaffId === actor.staffId));
    assert.equal(Array.isArray(first.batch.services), true);
    assert.equal(Array.isArray(crossStaffRetry.batch.services), true);
    assert.equal(redis.run(["LLEN", CODE_LIST]), 2);
    assert.equal(redis.run(["LLEN", BATCH_LIST]), 1);
    assert.equal(redis.run(["KEYS", OP_PREFIX + "*"]).length, 1);
    assert.equal(redis.run(["TTL", redis.run(["KEYS", OP_PREFIX + "*"])[0]]), -1);
    assert.equal(redis.run(["LLEN", ACTION_LOG]), 1);
    assert.equal(JSON.parse(redis.run(["LINDEX", ACTION_LOG, "0"])).staffId, actor.staffId);

    const conflict = await withFetch(redis.fetch, () => utils.createRedeemCodes(
      { ...input, amount: 26 },
      retryActor,
      options,
    ));
    assert.deepEqual(conflict, { ok: false, error: "idempotency_conflict" });
    assert.equal(redis.run(["LLEN", CODE_LIST]), 2);

    const differentKey = await withFetch(redis.fetch, () => utils.createRedeemCodes(
      input,
      retryActor,
      { operationId: "redeem-create-stable-002" },
    ));
    assert.equal(differentKey.ok, true);
    assert.notEqual(differentKey.batch.id, first.batch.id);
    assert.equal(redis.run(["LLEN", CODE_LIST]), 4);
    assert.equal(redis.run(["LLEN", BATCH_LIST]), 2);
    assert.equal(redis.run(["KEYS", OP_PREFIX + "*"]).length, 2);

    const recoveredOptions = { operationId: "redeem-create-response-lost-001" };
    redis.state.dropNextEvalResponse = true;
    const recovered = await withFetch(redis.fetch, () => utils.createRedeemCodes(
      { type: "balance", amount: 8.88, quantity: 1 },
      actor,
      recoveredOptions,
    ));
    assert.equal(recovered.ok, true);
    assert.equal(recovered.idempotent, true);
    assert.equal(recovered.recovered, true);
    assert.equal(Array.isArray(recovered.batch.services), true);
    assert.equal(redis.run(["LLEN", BATCH_LIST]), 3);

    const singleCode = "LMRACEVOID";
    const singleBatch = "RB-RACE-VOID";
    redis.run(["SET", CODE_PREFIX + singleCode, JSON.stringify(codeRecord(singleCode, singleBatch))]);
    redis.run(["LPUSH", CODE_LIST, singleCode]);
    redis.state.beforeNextEval = () => redis.run([
      "SET",
      CODE_PREFIX + singleCode,
      JSON.stringify({ ...codeRecord(singleCode, singleBatch), status: "used", usedBy: "winner@example.com" }),
    ]);
    const voidResult = await withFetch(redis.fetch, () => utils.updateRedeemCodeStatus(singleCode, "void", actor));
    assert.deepEqual(voidResult, { ok: false, error: "code_already_used" });
    const usedAfterVoid = JSON.parse(redis.run(["GET", CODE_PREFIX + singleCode]));
    assert.equal(usedAfterVoid.status, "used");
    assert.equal(usedAfterVoid.usedBy, "winner@example.com");
    const usedDelete = await withFetch(redis.fetch, () => utils.deleteRedeemCode(singleCode, actor));
    assert.deepEqual(usedDelete, { ok: false, error: "code_already_used" });
    assert.equal(redis.run(["EXISTS", CODE_PREFIX + singleCode]), 1);

    const losslessCode = "LMLOSSLESS1";
    const losslessCodeRaw = JSON.stringify({
      ...codeRecord(losslessCode, "RB-LOSSLESS-CODE"),
      legacyRows: [],
      legacyNull: null,
    }).replace(/}$/, ',"legacyHuge":123456789012345678901234567890}');
    redis.run(["SET", CODE_PREFIX + losslessCode, losslessCodeRaw]);
    redis.run(["LPUSH", CODE_LIST, losslessCode]);
    assert.equal((await withFetch(redis.fetch, () => utils.updateRedeemCodeStatus(losslessCode, "void", actor))).ok, true);
    const voidedLosslessCode = redis.run(["GET", CODE_PREFIX + losslessCode]);
    assert.match(voidedLosslessCode, /"legacyRows":\[\]/);
    assert.match(voidedLosslessCode, /"legacyNull":null/);
    assert.match(voidedLosslessCode, /"legacyHuge":123456789012345678901234567890/);

    const losslessBatchId = "RB-LOSSLESS-BATCH";
    const losslessBatchCode = "LMLOSSBATCH1";
    const losslessBatchRaw = JSON.stringify({
      id: losslessBatchId,
      type: "balance",
      amount: 7,
      quantity: 1,
      status: "active",
      codes: [losslessBatchCode],
      legacyRows: [],
      legacyNull: null,
    }).replace(/}$/, ',"legacyHuge":123456789012345678901234567890}');
    const losslessBatchCodeRaw = JSON.stringify({
      ...codeRecord(losslessBatchCode, losslessBatchId),
      legacyRows: [],
      legacyNull: null,
    }).replace(/}$/, ',"legacyHuge":123456789012345678901234567890}');
    redis.run(["SET", BATCH_PREFIX + losslessBatchId, losslessBatchRaw]);
    redis.run(["LPUSH", BATCH_LIST, losslessBatchId]);
    redis.run(["SET", CODE_PREFIX + losslessBatchCode, losslessBatchCodeRaw]);
    redis.run(["LPUSH", CODE_LIST, losslessBatchCode]);
    assert.equal((await withFetch(redis.fetch, () => utils.updateRedeemBatchStatus(losslessBatchId, "void", actor))).ok, true);
    for (const storedRaw of [
      redis.run(["GET", BATCH_PREFIX + losslessBatchId]),
      redis.run(["GET", CODE_PREFIX + losslessBatchCode]),
    ]) {
      assert.match(storedRaw, /"legacyRows":\[\]/);
      assert.match(storedRaw, /"legacyNull":null/);
      assert.match(storedRaw, /"legacyHuge":123456789012345678901234567890/);
    }

    const batchId = "RB-RACE-DELETE";
    const becomesUsed = "LMRACEUSED";
    const remainsActive = "LMRACEACTIVE";
    const batch = {
      id: batchId,
      type: "balance",
      amount: 10,
      quantity: 2,
      status: "active",
      codes: [becomesUsed, remainsActive],
    };
    redis.run(["SET", BATCH_PREFIX + batchId, JSON.stringify(batch)]);
    redis.run(["LPUSH", BATCH_LIST, batchId]);
    redis.run(["SET", CODE_PREFIX + becomesUsed, JSON.stringify(codeRecord(becomesUsed, batchId))]);
    redis.run(["SET", CODE_PREFIX + remainsActive, JSON.stringify(codeRecord(remainsActive, batchId))]);
    redis.run(["LPUSH", CODE_LIST, becomesUsed]);
    redis.run(["LPUSH", CODE_LIST, remainsActive]);
    redis.state.beforeNextEval = () => redis.run([
      "SET",
      CODE_PREFIX + becomesUsed,
      JSON.stringify({ ...codeRecord(becomesUsed, batchId), status: "used", usedBy: "batch-winner@example.com" }),
    ]);
    const deleted = await withFetch(redis.fetch, () => utils.deleteRedeemBatch(batchId, actor));
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.preservedUsed, [becomesUsed]);
    assert.equal(redis.run(["EXISTS", CODE_PREFIX + remainsActive]), 0);
    assert.equal(redis.run(["EXISTS", BATCH_PREFIX + batchId]), 0);
    const preserved = JSON.parse(redis.run(["GET", CODE_PREFIX + becomesUsed]));
    assert.equal(preserved.status, "used");
    assert.equal(preserved.usedBy, "batch-winner@example.com");
    assert.equal(redis.run(["LRANGE", CODE_LIST, "0", "-1"]).includes(becomesUsed), true);
    const deleteAudit = JSON.parse(redis.run(["LINDEX", ACTION_LOG, "0"]));
    assert.equal(deleteAudit.action, "redeem_batch_delete");
    assert.deepEqual(deleteAudit.detail, {
      total: 2,
      changed: 1,
      deleted: 1,
      preservedUsed: 1,
      type: "balance",
      amount: 10,
    });

    const droppedBatchId = "RB-DROP-DELETE";
    const droppedCode = "LMDROPDELETE";
    redis.run(["SET", BATCH_PREFIX + droppedBatchId, JSON.stringify({
      id: droppedBatchId,
      type: "balance",
      amount: 9,
      quantity: 1,
      status: "active",
      codes: [droppedCode],
    })]);
    redis.run(["LPUSH", BATCH_LIST, droppedBatchId]);
    redis.run(["SET", CODE_PREFIX + droppedCode, JSON.stringify(codeRecord(droppedCode, droppedBatchId))]);
    redis.run(["LPUSH", CODE_LIST, droppedCode]);
    redis.state.dropNextEvalResponse = true;
    const recoveredDelete = await withFetch(redis.fetch, () => utils.deleteRedeemBatch(droppedBatchId, actor));
    assert.equal(recoveredDelete.ok, true);
    assert.equal(recoveredDelete.idempotent, true);
    assert.equal(recoveredDelete.recovered, true);
    assert.equal(redis.run(["EXISTS", CODE_PREFIX + droppedCode]), 0);
    assert.equal(redis.run(["EXISTS", BATCH_PREFIX + droppedBatchId]), 0);

    const serviceCreated = await withFetch(redis.fetch, () => utils.createRedeemCodes({
      type: "service",
      quantity: 1,
      services: [{ key: "spotify", plan: "family" }],
    }, actor, { operationId: "redeem-create-lossless-item-001" }));
    assert.equal(serviceCreated.ok, true);
    const createdItem = serviceCreated.codes[0];
    assert.equal(Array.isArray(createdItem.services), true);
    assert.equal(
      redis.run(["GET", CODE_PREFIX + createdItem.code]),
      JSON.stringify(createdItem),
      "Lua stores the exact Node-encoded item instead of decoding and re-encoding its arrays",
    );
  } finally {
    docker(["rm", "-f", container]);
  }
});
