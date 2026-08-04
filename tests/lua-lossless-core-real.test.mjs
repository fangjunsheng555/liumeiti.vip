import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.KV_REST_API_URL = "http://lua-lossless.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const durable = await import("../app/api/_durable-operation.js");
const push = await import("../app/api/_push.js");
const afterSales = await import("../app/api/after-sales/_store.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

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
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

test("real Redis lossless CAS preserves legacy JSON tokens for durable operations and Push events", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-lua-lossless-${process.pid}-${Date.now()}`;
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
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    const input = {
      scope: "real-lossless",
      principal: "legacy-user",
      idempotencyKey: "real-lossless-operation-001",
      requestHash: "9".repeat(64),
    };
    const coordinates = durable.durableOperationInternals.operationCoordinates(
      input.scope,
      input.principal,
      input.idempotencyKey,
    );
    const durableRaw = `{ "version":1, "state":"started", "operationId":"${coordinates.operationId}", "requestHash":"${input.requestHash}", "createdAt":"2026-01-01T00:00:00.000Z", "legacyRows":[], "legacyNull":null, "legacyHuge":123456789012345678901234567890 }`;
    redis.run(["SET", coordinates.storageKey, durableRaw]);
    const operation = await durable.claimDurableOperation(input);
    assert.equal(operation.ok, true);
    assert.equal((await durable.ensureDurableOperationPlan(operation, { recipients: [] })).ok, true);
    assert.equal((await durable.completeDurableOperation(operation, { ok: true, value: null })).ok, true);
    const completedRaw = redis.run(["GET", coordinates.storageKey]);
    assert.match(completedRaw, /"legacyRows":\[\]/);
    assert.match(completedRaw, /"legacyNull":null/);
    assert.match(completedRaw, /"legacyHuge":123456789012345678901234567890/);

    const canonicalResultShapes = [
      { ok: false, error: "external_rejected" },
      { ok: true, items: [] },
      { ok: true, meta: { value: null, rows: [] } },
      { ok: true, count: 0, enabled: false },
      { ok: true, label: "订单✅", identifier: "123456789012345678901234567890" },
    ];
    for (const [index, result] of canonicalResultShapes.entries()) {
      const candidateInput = { ...input, idempotencyKey: `real-lossless-canonical-result-${index}` };
      const candidate = await durable.claimDurableOperation(candidateInput);
      assert.equal(candidate.ok, true);
      assert.equal(candidate.state, "started");
      const completion = await durable.completeDurableOperation(candidate, result);
      assert.equal(completion.ok, true);
      const retry = await durable.claimDurableOperation(candidateInput);
      assert.equal(retry.state, "done");
      assert.deepEqual(retry.record.result, result);
      assert.equal(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, candidate.operationId]), null);
    }

    const mismatchedInput = { ...input, idempotencyKey: "real-lossless-operation-wrong-id" };
    const mismatched = durable.durableOperationInternals.operationCoordinates(
      mismatchedInput.scope,
      mismatchedInput.principal,
      mismatchedInput.idempotencyKey,
    );
    const wrongOperationId = "f".repeat(64);
    const mismatchedRaw = JSON.stringify({
      version: 1,
      state: "done",
      operationId: wrongOperationId,
      requestHash: mismatchedInput.requestHash,
      startedAtMs: Date.now(),
      plan: { recipients: ["wrong@example.com"] },
      result: { ok: true, delivered: true },
    });
    redis.run(["SET", mismatched.storageKey, mismatchedRaw]);
    const sentinelScore = Date.now() - 1_000;
    redis.run(["ZADD", durable.durableOperationInternals.OPERATION_STARTED_INDEX, sentinelScore, mismatched.operationId]);
    const mismatchedClaim = await durable.claimDurableOperation(mismatchedInput);
    assert.equal(mismatchedClaim.ok, false);
    assert.equal(mismatchedClaim.error, "operation_record_corrupt");
    assert.equal(mismatchedClaim.record, undefined);
    const canonicalHandle = {
      ...mismatched,
      requestHash: mismatchedInput.requestHash,
      record: { operationId: mismatched.operationId, requestHash: mismatchedInput.requestHash },
    };
    const mismatchedPlan = await durable.ensureDurableOperationPlan(canonicalHandle, { recipients: ["right@example.com"] });
    assert.equal(mismatchedPlan.ok, false);
    assert.equal(mismatchedPlan.error, "operation_record_corrupt");
    assert.equal(mismatchedPlan.plan, undefined);
    const mismatchedComplete = await durable.completeDurableOperation(canonicalHandle, { ok: true, delivered: false });
    assert.equal(mismatchedComplete.ok, false);
    assert.equal(mismatchedComplete.error, "operation_record_corrupt");
    assert.equal(mismatchedComplete.result, undefined);
    assert.equal(redis.run(["GET", mismatched.storageKey]), mismatchedRaw);
    assert.equal(Number(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, mismatched.operationId])), sentinelScore);

    const legacyInput = { ...input, idempotencyKey: "real-lossless-legacy-no-state" };
    const legacy = durable.durableOperationInternals.operationCoordinates(
      legacyInput.scope, legacyInput.principal, legacyInput.idempotencyKey,
    );
    redis.run(["SET", legacy.storageKey, JSON.stringify({
      version: 1,
      operationId: legacy.operationId,
      requestHash: legacyInput.requestHash,
      startedAtMs: Date.now(),
    })]);
    const legacyClaim = await durable.claimDurableOperation(legacyInput);
    assert.equal(legacyClaim.ok, true);
    assert.equal(legacyClaim.state, "started");

    const unknownInput = { ...input, idempotencyKey: "real-lossless-unknown-state" };
    const unknown = durable.durableOperationInternals.operationCoordinates(
      unknownInput.scope, unknownInput.principal, unknownInput.idempotencyKey,
    );
    const unknownRaw = JSON.stringify({
      version: 1,
      state: "completed",
      operationId: unknown.operationId,
      requestHash: unknownInput.requestHash,
      startedAtMs: Date.now(),
    });
    redis.run(["SET", unknown.storageKey, unknownRaw]);
    const unknownClaim = await durable.claimDurableOperation(unknownInput);
    assert.equal(unknownClaim.ok, false);
    assert.equal(unknownClaim.error, "operation_record_corrupt");
    assert.equal(redis.run(["GET", unknown.storageKey]), unknownRaw);
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, unknown.operationId]), null);
    const unknownComplete = await durable.completeDurableOperation({
      ...unknown,
      record: JSON.parse(unknownRaw),
    }, { ok: true });
    assert.equal(unknownComplete.ok, false);
    assert.equal(unknownComplete.error, "operation_record_corrupt");
    assert.equal(redis.run(["GET", unknown.storageKey]), unknownRaw);
    const unknownPlan = await durable.ensureDurableOperationPlan({
      ...unknown,
      record: JSON.parse(unknownRaw),
    }, { recipients: ["must-not-run@example.com"] });
    assert.equal(unknownPlan.ok, false);
    assert.equal(unknownPlan.error, "operation_record_corrupt");
    assert.equal(redis.run(["GET", unknown.storageKey]), unknownRaw);

    const corruptInput = { ...input, idempotencyKey: "real-lossless-corrupt-record" };
    const corrupt = durable.durableOperationInternals.operationCoordinates(
      corruptInput.scope, corruptInput.principal, corruptInput.idempotencyKey,
    );
    redis.run(["SET", corrupt.storageKey, "{"]);
    const corruptClaim = await durable.claimDurableOperation(corruptInput);
    assert.equal(corruptClaim.ok, false);
    assert.equal(corruptClaim.error, "operation_record_corrupt");
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, corrupt.operationId]), null);

    const incompleteDoneInput = { ...input, idempotencyKey: "real-lossless-incomplete-done" };
    const incompleteDone = durable.durableOperationInternals.operationCoordinates(
      incompleteDoneInput.scope, incompleteDoneInput.principal, incompleteDoneInput.idempotencyKey,
    );
    redis.run(["SET", incompleteDone.storageKey, JSON.stringify({
      state: "done",
      operationId: incompleteDone.operationId,
      requestHash: incompleteDoneInput.requestHash,
    })]);
    const incompleteDoneClaim = await durable.claimDurableOperation(incompleteDoneInput);
    assert.equal(incompleteDoneClaim.ok, false);
    assert.equal(incompleteDoneClaim.error, "operation_record_corrupt");

    const invalidDoneCases = [
      ["empty-array", []],
      ["nonempty-array", [{ ok: true }]],
      ["null", null],
      ["number", 0],
      ["string", ""],
      ["nonboolean-outcome", { ok: "true" }],
    ].map(([name, result]) => {
      const candidateInput = { ...input, idempotencyKey: `real-lossless-invalid-done-${name}` };
      const candidate = durable.durableOperationInternals.operationCoordinates(
        candidateInput.scope, candidateInput.principal, candidateInput.idempotencyKey,
      );
      redis.run(["SET", candidate.storageKey, JSON.stringify({
        state: "done",
        operationId: candidate.operationId,
        requestHash: candidateInput.requestHash,
        result,
      })]);
      return { candidate, candidateInput };
    });
    for (const { candidate, candidateInput } of invalidDoneCases) {
      const claim = await durable.claimDurableOperation(candidateInput);
      assert.equal(claim.ok, false);
      assert.equal(claim.error, "operation_record_corrupt");
      assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, candidate.operationId]), null);
    }

    const canonicalDoneInput = { ...input, idempotencyKey: "real-lossless-canonical-done" };
    const canonicalDone = durable.durableOperationInternals.operationCoordinates(
      canonicalDoneInput.scope, canonicalDoneInput.principal, canonicalDoneInput.idempotencyKey,
    );
    redis.run(["SET", canonicalDone.storageKey, JSON.stringify({
      state: "done",
      operationId: canonicalDone.operationId,
      requestHash: canonicalDoneInput.requestHash,
      result: { ok: true },
    })]);
    for (const operationId of [mismatched.operationId, unknown.operationId, corrupt.operationId, incompleteDone.operationId, canonicalDone.operationId, ...invalidDoneCases.map(({ candidate }) => candidate.operationId)]) {
      redis.run(["ZREM", durable.durableOperationInternals.OPERATION_STARTED_INDEX, operationId]);
    }
    redis.run(["DEL", durable.durableOperationInternals.OPERATION_BACKFILL_CURSOR]);
    let backfill;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      backfill = await durable.backfillDurableOperationStartedIndex({ count: 500 });
      assert.equal(backfill.ok, true);
      if (backfill.done) break;
    }
    assert.equal(backfill?.done, true);
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, mismatched.operationId]), null);
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, unknown.operationId]), null);
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, corrupt.operationId]), null);
    assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, incompleteDone.operationId]), null);
    for (const { candidate } of invalidDoneCases) {
      assert.notEqual(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, candidate.operationId]), null);
    }
    assert.equal(redis.run(["ZSCORE", durable.durableOperationInternals.OPERATION_STARTED_INDEX, canonicalDone.operationId]), null);

    const eventId = "push_real_lossless_1";
    const requestHash = "8".repeat(64);
    const eventRaw = `{ "eventId":"${eventId}", "requestHash":"${requestHash}", "deliveryFields":[], "legacyRows":[], "legacyNull":null, "legacyHuge":123456789012345678901234567890 }`;
    redis.run(["HSET", push.pushInternals.EVENTS_HASH, eventId, eventRaw]);
    const persisted = await push.pushInternals.persistDeliveryFields({ eventId, requestHash }, ["delivery:real"]);
    assert.equal(persisted.ok, true);
    const storedEventRaw = redis.run(["HGET", push.pushInternals.EVENTS_HASH, eventId]);
    assert.match(storedEventRaw, /"deliveryFields":\["delivery:real"\]/);
    assert.match(storedEventRaw, /"legacyRows":\[\]/);
    assert.match(storedEventRaw, /"legacyNull":null/);
    assert.match(storedEventRaw, /"legacyHuge":123456789012345678901234567890/);

    const sentinelTicketId = "AS-SENTINEL-OPERATION";
    const sentinelOperationId = "__lm_after_sales_missing__";
    const sentinelCreated = await afterSales.createAfterSalesTicket({
      ticketId: sentinelTicketId,
      orderId: "ORDER-SENTINEL-OPERATION",
      status: "pending",
      createdAt: new Date().toISOString(),
      items: [],
    });
    assert.equal(sentinelCreated.ok, true);
    const sentinelCompleted = await afterSales.completeAfterSalesTicket(sentinelTicketId, {
      operationId: sentinelOperationId,
      requestHash: "7".repeat(64),
      items: [],
    }, { staffId: 1, staffUsername: "admin" });
    assert.equal(sentinelCompleted.ok, true);
    assert.equal(sentinelCompleted.ticket.completionOperationId, sentinelOperationId);
    assert.notEqual(redis.run(["ZSCORE", "liumeiti:after-sales:completion-outbox", sentinelTicketId]), null);
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
