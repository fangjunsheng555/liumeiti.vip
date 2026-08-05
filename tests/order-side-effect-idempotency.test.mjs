import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { executeDurableOperationEval } from "./helpers/durable-operation-redis-mock.mjs";

process.env.KV_REST_API_URL = "http://durable-operation.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
let dropNextCompletionResponse = false;
let failNextStateRead = false;
let corruptNextCompletionResult;

function executeEval(command) {
  const script = String(command[1] || "");
  const keyCount = Number(command[2] || 0);
  const keys = command.slice(3, 3 + keyCount);
  const args = command.slice(3 + keyCount);
  const key = keys[0];
  if (script.includes("durable_claim_v2_lossless")) {
    if (key !== `liumeiti:durable-operation:v1:${args[1]}`) return ["error", "invalid_operation_record"];
    const existing = values.get(key);
    if (existing) {
      const record = JSON.parse(existing);
      if (record.operationId !== args[1]) return ["error", "operation_record_corrupt"];
      if (record.requestHash !== args[0]) return ["error", "idempotency_conflict"];
      return ["ok", record.state, existing, "0"];
    }
    values.set(key, args[4]);
    return ["ok", "started", args[4], "1"];
  }
  if (script.includes("durable_plan_v2_lossless")) {
    if (key !== `liumeiti:durable-operation:v1:${args[1]}`) return ["error", "invalid_operation_record"];
    const record = JSON.parse(values.get(key) || "null");
    if (!record) return ["error", "operation_record_missing"];
    if (record.operationId !== args[1]) return ["error", "operation_record_corrupt"];
    if (record.requestHash !== args[0]) return ["error", "idempotency_conflict"];
    if (record.plan !== undefined) return ["planned", values.get(key), "0"];
    if (values.get(key) !== args[2]) return ["stale", values.get(key)];
    values.set(key, args[3]);
    return ["planned", args[3], "1"];
  }
  if (script.includes("durable_complete_v2_lossless")) {
    if (key !== `liumeiti:durable-operation:v1:${args[2]}`) return ["error", "invalid_operation_record"];
    const record = JSON.parse(values.get(key) || "null");
    if (!record) return ["error", "operation_record_missing"];
    if (record.operationId !== args[2]) return ["error", "operation_record_corrupt"];
    if (record.requestHash !== args[0]) return ["error", "idempotency_conflict"];
    if (record.state === "done") return ["done", values.get(key), "1"];
    if (values.get(key) !== args[1]) return ["stale", values.get(key)];
    values.set(key, args[3]);
    return ["done", args[3], "0"];
  }
  throw new Error("unexpected Lua script");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://durable-operation.redis.test") return originalFetch(input, init);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(init.body || "[]"));
    if (failNextStateRead && commands.some((command) => String(command?.[0] || "").toUpperCase() === "GET")) {
      failNextStateRead = false;
      return Response.json({ error: "simulated state read outage" }, { status: 503 });
    }
    const rows = commands.map((command) => {
      const name = String(command?.[0] || "").toUpperCase();
      if (name === "GET") return { result: values.get(command[1]) ?? null };
      if (name === "PING") return { result: "PONG" };
      return { result: executeEval(command) };
    });
    if (dropNextCompletionResponse && corruptNextCompletionResult !== undefined
      && commands.some((command) => String(command?.[1] || "").includes("durable_complete_v2_lossless"))) {
      const completion = commands.find((command) => String(command?.[1] || "").includes("durable_complete_v2_lossless"));
      const storageKey = completion[3];
      const record = JSON.parse(values.get(storageKey));
      record.result = corruptNextCompletionResult;
      values.set(storageKey, JSON.stringify(record));
      corruptNextCompletionResult = undefined;
    }
    if (dropNextCompletionResponse
      && commands.some((command) => String(command?.[1] || "").includes("durable_complete_v2_lossless"))) {
      dropNextCompletionResponse = false;
      // Redis ran and committed the script, but the REST response disappeared.
      return Response.json({ error: "simulated lost response" }, { status: 503 });
    }
    return Response.json(rows);
  }
  const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (command[0]?.toUpperCase() === "GET") {
    return Response.json({ result: values.get(command[1]) ?? null });
  }
  throw new Error("unexpected durable operation command");
};

const durable = await import("../app/api/_durable-operation.js");
const utils = await import("../app/api/_utils.js");

test.after(() => { globalThis.fetch = originalFetch; });

test("lossless root-field replacement handles nesting and rejects ambiguous or unencodable input", () => {
  const raw = ' { "escaped\\\"key":{"text":"} , [ still text","rows":[]}, "nullable":null, "huge":123456789012345678901234567890 }\n';
  const next = utils.replaceTopLevelJsonFields(raw, { nullable: { ok: true }, added: [] });
  assert.match(next, /"escaped\\\"key":\{"text":"} , \[ still text","rows":\[\]\}/);
  assert.match(next, /"huge":123456789012345678901234567890/);
  assert.match(next, /"nullable":\{"ok":true\}/);
  assert.match(next, /"added":\[\]/);
  assert.equal(utils.replaceTopLevelJsonFields('{"a":1,"a":2}', { a: 3 }), null);
  const circular = {};
  circular.self = circular;
  assert.equal(utils.replaceTopLevelJsonFields('{"a":1}', { a: circular }), null);
});

test("a durable operation survives a lost response and permanently rejects key reuse", async () => {
  values.clear();
  const input = {
    scope: "admin-order-delete",
    principal: "LMORDER1:1",
    idempotencyKey: "delete-operation-0001",
    requestHash: "a".repeat(64),
  };
  const first = await durable.claimDurableOperation(input);
  assert.equal(first.ok, true);
  assert.equal(first.isNew, true);
  assert.equal(first.state, "started");
  assert.equal(durable.durableOperationId(input), first.operationId);

  // Model a worker crash or a dropped HTTP response: the exact retry resumes
  // the same permanent operation instead of minting another effect identity.
  const retryBeforeCompletion = await durable.claimDurableOperation(input);
  assert.equal(retryBeforeCompletion.operationId, first.operationId);
  assert.equal(retryBeforeCompletion.isNew, false);
  assert.equal(retryBeforeCompletion.state, "started");

  const planned = await durable.ensureDurableOperationPlan(retryBeforeCompletion, {
    recipients: [{ email: "first@example.com", orderIds: ["LMORDER1"] }],
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.created, true);
  const immutablePlan = await durable.ensureDurableOperationPlan(retryBeforeCompletion, {
    recipients: [{ email: "changed@example.com", orderIds: ["LMORDER2"] }],
  });
  assert.equal(immutablePlan.created, false);
  assert.equal(immutablePlan.plan.recipients[0].email, "first@example.com");

  dropNextCompletionResponse = true;
  const completed = await durable.completeDurableOperation(retryBeforeCompletion, {
    ok: true,
    deleted: "LMORDER1",
    archived: true,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.recovered, true);

  const lostResponseRetry = await durable.claimDurableOperation(input);
  assert.equal(lostResponseRetry.state, "done");
  assert.deepEqual(lostResponseRetry.record.result, {
    ok: true,
    deleted: "LMORDER1",
    archived: true,
  });

  const conflict = await durable.claimDurableOperation({ ...input, requestHash: "b".repeat(64) });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "idempotency_conflict");
});

test("a record stored under operation A can never replay operation B with the same request hash", async () => {
  values.clear();
  const input = {
    scope: "cross-operation-identity",
    principal: "same-principal",
    idempotencyKey: "operation-a",
    requestHash: "3".repeat(64),
  };
  const operationId = durable.durableOperationId(input);
  const storageKey = `liumeiti:durable-operation:v1:${operationId}`;
  const wrongOperationId = "b".repeat(64);
  const poisonedRaw = JSON.stringify({
    version: 1,
    state: "done",
    operationId: wrongOperationId,
    requestHash: input.requestHash,
    plan: { recipients: ["wrong@example.com"] },
    result: { ok: true, delivered: true },
  });
  values.set(storageKey, poisonedRaw);

  const claim = await durable.claimDurableOperation(input);
  assert.equal(claim.ok, false);
  assert.equal(claim.error, "operation_record_corrupt");
  assert.equal(claim.record, undefined);

  const canonicalHandle = {
    storageKey,
    operationId,
    requestHash: input.requestHash,
    record: { operationId, requestHash: input.requestHash },
  };
  const planned = await durable.ensureDurableOperationPlan(canonicalHandle, { recipients: ["right@example.com"] });
  assert.equal(planned.ok, false);
  assert.equal(planned.error, "operation_record_corrupt");
  assert.equal(planned.plan, undefined);
  const completed = await durable.completeDurableOperation(canonicalHandle, { ok: true, delivered: false });
  assert.equal(completed.ok, false);
  assert.equal(completed.error, "operation_record_corrupt");
  assert.equal(completed.result, undefined);
  assert.equal(values.get(storageKey), poisonedRaw, "identity rejection must not mutate the foreign record");

  const forgedHandle = { ...canonicalHandle, operationId: wrongOperationId };
  assert.equal((await durable.ensureDurableOperationPlan(forgedHandle, { recipients: [] })).error, "invalid_operation");
  assert.equal((await durable.completeDurableOperation(forgedHandle, { ok: true })).error, "invalid_operation");
  const forgedRecord = { ...canonicalHandle, record: { operationId: wrongOperationId, requestHash: input.requestHash } };
  assert.equal((await durable.ensureDurableOperationPlan(forgedRecord, { recipients: [] })).error, "invalid_operation");
  assert.equal((await durable.completeDurableOperation(forgedRecord, { ok: true })).error, "invalid_operation");
  assert.equal(values.get(storageKey), poisonedRaw);
});

test("durable CAS updates preserve legacy JSON tokens and reject unencodable values before writes", async () => {
  values.clear();
  const input = {
    scope: "lossless-durable",
    principal: "legacy-user",
    idempotencyKey: "lossless-operation-0001",
    requestHash: "c".repeat(64),
  };
  const operationId = durable.durableOperationId(input);
  const storageKey = `liumeiti:durable-operation:v1:${operationId}`;
  const legacyRaw = `{ "version":1, "state":"started", "operationId":"${operationId}", "requestHash":"${input.requestHash}", "createdAt":"2026-01-01T00:00:00.000Z", "empty":[], "nullable":null, "legacyHuge":123456789012345678901234567890, "nested":{"rows":[]} }`;
  values.set(storageKey, legacyRaw);

  const operation = await durable.claimDurableOperation(input);
  assert.equal(operation.ok, true);
  const circular = {};
  circular.self = circular;
  const rejected = await durable.ensureDurableOperationPlan(operation, circular);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "invalid_operation_plan");
  assert.equal(values.get(storageKey), legacyRaw);

  const planned = await durable.ensureDurableOperationPlan(operation, { recipients: [] });
  assert.equal(planned.ok, true);
  const completed = await durable.completeDurableOperation(operation, { ok: true, value: null });
  assert.equal(completed.ok, true);
  const stored = values.get(storageKey);
  assert.match(stored, /"empty":\[\]/);
  assert.match(stored, /"nullable":null/);
  assert.match(stored, /"legacyHuge":123456789012345678901234567890/);
  assert.match(stored, /"nested":\{"rows":\[\]\}/);
  assert.match(stored, /"state":"done"/);
});

test("durable reads distinguish a missing journal from a Redis outage and preserve an explicit null plan", async () => {
  values.clear();
  const missing = {
    storageKey: "liumeiti:durable-operation:v1:" + "d".repeat(64),
    operationId: "d".repeat(64),
    requestHash: "e".repeat(64),
    record: { requestHash: "e".repeat(64) },
  };
  assert.equal((await durable.completeDurableOperation(missing, { ok: true })).error, "operation_record_missing");
  assert.equal((await durable.ensureDurableOperationPlan(missing, { recipients: [] })).error, "operation_record_missing");

  failNextStateRead = true;
  assert.equal((await durable.completeDurableOperation(missing, { ok: true })).error, "storage_unavailable");
  failNextStateRead = true;
  assert.equal((await durable.ensureDurableOperationPlan(missing, { recipients: [] })).error, "storage_unavailable");

  const input = {
    scope: "legacy-null-plan",
    principal: "legacy-user",
    idempotencyKey: "legacy-null-plan-0001",
    requestHash: "f".repeat(64),
  };
  const operationId = durable.durableOperationId(input);
  values.set(`liumeiti:durable-operation:v1:${operationId}`, JSON.stringify({
    version: 1,
    state: "started",
    operationId,
    requestHash: input.requestHash,
    createdAt: "2026-01-01T00:00:00.000Z",
    plan: null,
  }));
  const operation = await durable.claimDurableOperation(input);
  const existing = await durable.ensureDurableOperationPlan(operation, { recipients: ["must-not-replace-null"] });
  assert.equal(existing.ok, true);
  assert.equal(existing.created, false);
  assert.equal(existing.plan, null);
});

test("durable completion rejects arrays and payload objects without a boolean outcome", async () => {
  const operation = {
    storageKey: "liumeiti:durable-operation:v1:" + "7".repeat(64),
    operationId: "7".repeat(64),
    requestHash: "8".repeat(64),
    record: { requestHash: "8".repeat(64) },
  };
  assert.equal((await durable.completeDurableOperation(operation, [])).error, "invalid_operation");
  assert.equal((await durable.completeDurableOperation(operation, {})).error, "invalid_operation");
});

test("lost completion responses never recover noncanonical result objects as success", async () => {
  for (const [index, corruptResult] of [{}, { ok: "true" }].entries()) {
    values.clear();
    const input = {
      scope: "invalid-recovery-result",
      principal: "legacy-user",
      idempotencyKey: `invalid-recovery-result-${index}`,
      requestHash: "6".repeat(64),
    };
    const operation = await durable.claimDurableOperation(input);
    dropNextCompletionResponse = true;
    corruptNextCompletionResult = corruptResult;
    const completed = await durable.completeDurableOperation(operation, { ok: true });
    assert.equal(completed.ok, false);
    assert.equal(completed.error, "storage_unavailable");
  }
});

test("convergence E rejects five non-object or non-boolean outcomes after a lost completion response", async (t) => {
  const cases = [
    ["empty array", []],
    ["nonempty array", [{ ok: true }]],
    ["null", null],
    ["null outcome", { ok: null }],
    ["numeric outcome", { ok: 0 }],
  ];
  for (const [name, corruptResult] of cases) {
    await t.test(name, async () => {
      values.clear();
      const input = {
        scope: "convergence-invalid-recovery-result",
        principal: "legacy-user",
        idempotencyKey: `convergence-invalid-recovery-${name.replaceAll(" ", "-")}`,
        requestHash: "5".repeat(64),
      };
      const operation = await durable.claimDurableOperation(input);
      dropNextCompletionResponse = true;
      corruptNextCompletionResult = corruptResult;
      const completed = await durable.completeDurableOperation(operation, { ok: true });
      assert.equal(completed.ok, false);
      assert.equal(completed.error, "storage_unavailable");
    });
  }
});

test("convergence F recovers five canonical edge-shaped results after a lost completion response", async (t) => {
  const cases = [
    ["explicit business failure", { ok: false, partial: true, error: "external_rejected" }],
    ["nested empty arrays", { ok: true, matrix: [[], []] }],
    ["nested empty object and null", { ok: true, meta: { empty: {}, missing: null } }],
    ["negative float and large number", { ok: true, delta: -12.5, sequence: 9007199254740992 }],
    ["localized and empty strings", { ok: true, language: "日本語 / Français", note: "" }],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async () => {
      values.clear();
      const input = {
        scope: "convergence-valid-recovery-result",
        principal: "legacy-user",
        idempotencyKey: `convergence-valid-recovery-${name.replaceAll(" ", "-")}`,
        requestHash: "4".repeat(64),
      };
      const operation = await durable.claimDurableOperation(input);
      dropNextCompletionResponse = true;
      const completed = await durable.completeDurableOperation(operation, result);
      assert.equal(completed.ok, true);
      assert.equal(completed.recovered, true);
      assert.deepEqual(completed.result, result);
    });
  }
});

test("the shared Redis double treats an explicit null plan exactly like Redis cjson", () => {
  const storageKey = "liumeiti:durable-operation:v1:" + "1".repeat(64);
  const raw = JSON.stringify({ state: "started", operationId: "1".repeat(64), requestHash: "2".repeat(64), plan: null });
  const storage = new Map([[storageKey, raw]]);
  const indexes = new Map();
  const result = executeDurableOperationEval([
    "EVAL",
    "-- durable_plan_v2_lossless",
    "1",
    storageKey,
    "2".repeat(64),
    "1".repeat(64),
    raw,
    JSON.stringify({ state: "started", operationId: "1".repeat(64), requestHash: "2".repeat(64), plan: { changed: true } }),
  ], {
    values: storage,
    sortedSet(key) {
      if (!indexes.has(key)) indexes.set(key, new Map());
      return indexes.get(key);
    },
  });
  assert.equal(result.handled, true);
  assert.deepEqual(result.result, ["planned", raw, "0"]);
  assert.equal(storage.get(storageKey), raw);
});

test("order mutation routes require stable keys and preserve per-effect recovery evidence", async () => {
  const [single, batch, quote, password, timeline, utils] = await Promise.all([
    readFile(new URL("../app/api/admin/orders/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/orders/batch/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/quote-orders/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/order-password-update/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_order-timeline.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_utils.js", import.meta.url), "utf8"),
  ]);

  for (const source of [single, batch, quote, password]) {
    assert.match(source, /requiredIdempotencyKey\(request\)/);
    assert.match(source, /claimDurableOperation/);
    assert.match(source, /completeDurableOperation/);
  }
  assert.match(single, /archiveOperationId: operation\.operationId/);
  assert.match(single, /const operationPrincipal = canonicalOrderId/);
  assert.doesNotMatch(single, /principal: `\$\{canonicalOrderId\}:\$\{Number\(actor\.staffId/);
  assert.match(batch, /archiveOperationId: itemOperationId/);
  assert.match(batch, /batch_operation_in_progress/);
  assert.match(batch, /principal: "orders"/);
  assert.match(quote, /paymentSubmissionRequestHash/);
  assert.match(quote, /payment_method_conflict/);
  assert.match(quote, /usdt_rate_unavailable/);
  assert.match(password, /passwordCorrectionResolvedTokenHash/);
  assert.match(password, /delete item\.passwordCorrectionTokenHash/);
  assert.match(password, /deliverOnce\([\s\S]*spotify-password-updated:/);
  assert.match(timeline, /APPEND_ONCE_SCRIPT/);
  assert.match(utils, /PUSH_ADMIN_ACTION_ONCE_SCRIPT/);
});

test("clients replay persisted bodies and cryptographically bind the quote bearer token", async () => {
  const [admin, quoteClient, spotifyClient] = await Promise.all([
    readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ProxyQuotePayment.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SpotifyPasswordUpdate.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /prepareAdminMutation\("order-assignment"/);
  assert.match(admin, /prepareAdminMutation\("order-batch"/);
  assert.match(admin, /prepareAdminMutation\("order-delete"/);
  assert.ok((admin.match(/body: JSON\.stringify\(pending\.payload\)/g) || []).length >= 9);

  assert.match(quoteClient, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(quoteClient, /identity: \{ orderId:[^}]*tokenHash \}/);
  assert.match(quoteClient, /body: JSON\.stringify\(\{ token, \.\.\.pending\.payload \}\)/);
  assert.match(quoteClient, /clearSinglePendingOperation\(window\.localStorage, storageKey, operation\.key\)/);

  assert.match(spotifyClient, /createPendingIdempotencyRecord/);
  assert.match(spotifyClient, /body: JSON\.stringify\(pending\.payload\)/);
  assert.match(spotifyClient, /"Idempotency-Key": operation\.key/);
  assert.match(spotifyClient, /if \(data\.resolved\)/);
});

test("after-sales mail effects have durable plans, outboxes and exact client journals", async () => {
  const [completion, reference, store, keeper, afterSalesClient, referenceClient, mail] = await Promise.all([
    readFile(new URL("../app/api/admin/after-sales/[ticketId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/after-sales/notify-by-reference/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/after-sales/_store.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_keeper.js", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AfterSalesPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/ReferenceNoticeDialog.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/after-sales/_email.js", import.meta.url), "utf8"),
  ]);
  for (const source of [completion, reference]) {
    assert.match(source, /requiredIdempotencyKey\(request\)/);
    assert.match(source, /claimDurableOperation/);
    assert.match(source, /completeDurableOperation/);
    assert.match(source, /deliverOnce/);
  }
  assert.match(reference, /ensureDurableOperationPlan/);
  assert.match(reference, /principal: reference/);
  assert.match(completion, /principal: ticketId/);
  assert.doesNotMatch(reference, /principal:[^\n]*staffId/);
  assert.doesNotMatch(completion, /principal:[^\n]*staffId/);
  assert.match(reference, /orders: sortedOrders\.map\(referenceNoticeOrderSnapshot\)/);
  assert.match(reference, /idempotencyKey: stableId/);
  assert.match(reference, /reference_notice_retryable/);
  assert.match(completion, /completion_email_retryable/);
  assert.match(completion, /markAfterSalesCompletionEffectsDone/);
  assert.match(store, /CREATE_TICKET_SCRIPT/);
  assert.match(store, /COMPLETE_TICKET_SCRIPT/);
  assert.match(store, /afterSalesCredentialSyncOperations/);
  assert.match(keeper, /afterSalesCompletionOutboxTick/);
  assert.match(mail, /idempotencyKey/);
  for (const source of [afterSalesClient, referenceClient]) {
    assert.match(source, /prepareAdminMutationJournal/);
    assert.match(source, /withCheckoutSubmissionCoordination/);
    assert.match(source, /"Idempotency-Key"/);
    assert.match(source, /clearAdminMutationJournal/);
  }
});
