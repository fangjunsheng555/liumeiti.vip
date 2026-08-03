import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://durable-operation.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const values = new Map();
let dropNextCompletionResponse = false;

function executeEval(command) {
  const script = String(command[1] || "");
  const keyCount = Number(command[2] || 0);
  const keys = command.slice(3, 3 + keyCount);
  const args = command.slice(3 + keyCount);
  const key = keys[0];
  if (script.includes("state='started'") && script.includes("isNew=true")) {
    const existing = values.get(key);
    if (existing) {
      const record = JSON.parse(existing);
      if (record.requestHash !== args[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
      return JSON.stringify({ ok: true, state: record.state, record, isNew: false });
    }
    const record = {
      version: 1,
      state: "started",
      operationId: args[1],
      requestHash: args[0],
      createdAt: args[2],
    };
    values.set(key, JSON.stringify(record));
    return JSON.stringify({ ok: true, state: "started", record, isNew: true });
  }
  if (script.includes("if record.plan~=nil then") && script.includes("record.plan=plan")) {
    const record = JSON.parse(values.get(key) || "null");
    if (!record) return JSON.stringify({ ok: false, error: "operation_record_missing" });
    if (record.requestHash !== args[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
    if (record.plan !== undefined) return JSON.stringify({ ok: true, record, created: false });
    record.plan = JSON.parse(args[1]);
    record.planCreatedAt = args[2];
    values.set(key, JSON.stringify(record));
    return JSON.stringify({ ok: true, record, created: true });
  }
  if (script.includes("record.state='done'")) {
    const record = JSON.parse(values.get(key) || "null");
    if (!record) return JSON.stringify({ ok: false, error: "operation_record_missing" });
    if (record.requestHash !== args[0]) return JSON.stringify({ ok: false, error: "idempotency_conflict" });
    if (record.state === "done") return JSON.stringify({ ok: true, state: "done", record, idempotent: true });
    record.state = "done";
    record.result = JSON.parse(args[1]);
    record.completedAt = args[2];
    values.set(key, JSON.stringify(record));
    return JSON.stringify({ ok: true, state: "done", record, idempotent: false });
  }
  throw new Error("unexpected Lua script");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://durable-operation.redis.test") return originalFetch(input, init);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(init.body || "[]"));
    const rows = commands.map((command) => ({ result: executeEval(command) }));
    if (dropNextCompletionResponse
      && commands.some((command) => String(command?.[1] || "").includes("record.state='done'"))) {
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

test.after(() => { globalThis.fetch = originalFetch; });

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
  assert.match(reference, /orders: recipientOrders\.map\(referenceNoticeOrderSnapshot\)/);
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
