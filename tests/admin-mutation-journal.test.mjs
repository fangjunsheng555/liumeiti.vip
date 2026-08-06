import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  adminMutationExactStorageKey,
  adminMutationSlotKey,
  clearAdminMutationJournal,
  prepareAdminMutationJournal,
  readAdminMutationJournals,
} from "../app/lib/admin-mutation-journal.js";
import {
  createPendingIdempotencyRecord,
  nextIdempotencyRequest,
} from "../app/lib/idempotency.js";

class SharedStorage {
  constructor() {
    this.values = new Map();
  }

  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

const scope = "balance";
const target = "buyer@example.com";
const payloadA = { email: target, amount: 100, reason: "manual credit" };
const payloadB = { email: target, amount: 50, reason: "second credit" };

function exactRecord(payload, now) {
  return createPendingIdempotencyRecord(null, `admin-${scope}`, payload, {
    identity: { scope, target },
    now,
  });
}

test("two tabs replay one exact unresolved admin mutation instead of minting a second key", () => {
  const storage = new SharedStorage();
  const tabA = prepareAdminMutationJournal(storage, scope, target, payloadA);
  const tabB = prepareAdminMutationJournal(storage, scope, target, { reason: "manual credit", amount: 100, email: target });

  assert.equal(tabB.record.idempotencyRequest.key, tabA.record.idempotencyRequest.key);
  assert.deepEqual(tabB.record.payload, payloadA);
  assert.equal(readAdminMutationJournals(storage, scope, target, payloadA).records.length, 1);
});

test("editing the payload while an operation is unresolved fails closed and preserves the original", () => {
  const storage = new SharedStorage();
  const pending = prepareAdminMutationJournal(storage, scope, target, payloadA);
  const exactKey = pending.operationStorageKey;
  const before = storage.getItem(exactKey);

  assert.throws(
    () => prepareAdminMutationJournal(storage, scope, target, payloadB),
    /admin_mutation_pending_payload_changed/,
  );
  assert.equal(storage.getItem(exactKey), before);
  assert.deepEqual(JSON.parse(before).payload, payloadA);
});

test("tab A completion removes only A while tab B's lost-response journal remains recoverable", () => {
  const storage = new SharedStorage();
  const slotKey = adminMutationSlotKey(scope, target);
  const recordA = exactRecord(payloadA, 1_000);
  const recordB = exactRecord(payloadB, 2_000);
  const keyA = recordA.idempotencyRequest.key;
  const keyB = recordB.idempotencyRequest.key;

  // Model two browser tabs that raced far enough for both HTTP requests to be
  // in flight before either observed the other's storage event. Per-operation
  // storage must retain B if A later receives its terminal response while B's
  // response is lost.
  storage.setItem(adminMutationExactStorageKey(slotKey, keyA), JSON.stringify(recordA));
  storage.setItem(adminMutationExactStorageKey(slotKey, keyB), JSON.stringify(recordB));
  storage.setItem(slotKey, JSON.stringify(recordB)); // rolling legacy tab B

  assert.equal(clearAdminMutationJournal(storage, slotKey, keyA), true);
  assert.equal(storage.getItem(adminMutationExactStorageKey(slotKey, keyA)), null);
  assert.notEqual(storage.getItem(adminMutationExactStorageKey(slotKey, keyB)), null);
  assert.notEqual(storage.getItem(slotKey), null);

  const recovered = readAdminMutationJournals(storage, scope, target, payloadB);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.records[0].record.idempotencyRequest.key, keyB);
  assert.deepEqual(recovered.records[0].record.payload, payloadB);
});

test("a matching legacy key-only journal migrates without changing its server idempotency key", () => {
  const storage = new SharedStorage();
  const slotKey = adminMutationSlotKey(scope, target);
  const legacy = nextIdempotencyRequest(null, `admin-${scope}`, payloadA, 3_000);
  storage.setItem(slotKey, JSON.stringify(legacy));

  const migrated = prepareAdminMutationJournal(storage, scope, target, payloadA);
  assert.equal(migrated.record.idempotencyRequest.key, legacy.key);
  assert.deepEqual(migrated.record.payload, payloadA);
  assert.notEqual(storage.getItem(migrated.operationStorageKey), null);

  assert.equal(clearAdminMutationJournal(storage, slotKey, legacy.key), true);
  assert.equal(storage.getItem(slotKey), null);
  assert.equal(storage.getItem(migrated.operationStorageKey), null);
});

test("a legacy key-only journal with a different fingerprint is retained and blocks submission", () => {
  const storage = new SharedStorage();
  const slotKey = adminMutationSlotKey(scope, target);
  const legacy = nextIdempotencyRequest(null, `admin-${scope}`, payloadA, 4_000);
  const serialized = JSON.stringify(legacy);
  storage.setItem(slotKey, serialized);

  assert.throws(
    () => prepareAdminMutationJournal(storage, scope, target, payloadB),
    /admin_mutation_legacy_payload_mismatch/,
  );
  assert.equal(storage.getItem(slotKey), serialized);
  assert.equal(storage.length, 1);
});

test("an exact journal read failure cannot fall through to a fresh operation", () => {
  const storage = new SharedStorage();
  const pending = prepareAdminMutationJournal(storage, scope, target, payloadA);
  const originalGet = storage.getItem.bind(storage);
  storage.getItem = (key) => {
    if (key === pending.operationStorageKey) throw new Error("disk unavailable");
    return originalGet(key);
  };

  assert.throws(
    () => prepareAdminMutationJournal(storage, scope, target, payloadA),
    /admin_mutation_journal_read_failed/,
  );
});

test("admin callers send the persisted exact body and compare-clear only the proven key", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(source, /prepareAdminMutationJournal\(window\.localStorage, scope, target, payload\)/);
  assert.match(source, /readAdminMutationJournals\(window\.localStorage, "order", orderId\)/);
  assert.match(source, /pending\.operation\.key/);
  assert.match(source, /body: JSON\.stringify\(pending\.payload\)/);
  assert.match(source, /确认上次操作/);
  assert.match(source, /clearAdminMutationJournal\(window\.localStorage, storageKey, operation\.key\)/);
  // Nine UI mutations, one explicit unresolved-order replay and one exact
  // replay used to resume a mutation whose primary write already committed.
  assert.equal((source.match(/body: JSON\.stringify\(pending\.payload\)/g) || []).length, 11);
  assert.equal((source.match(/clearTerminalAdminMutation\(pending, (?:res|response), data\)/g) || []).length, 12);
  assert.equal((source.match(/await withAdminMutationCoordination\(async \(\) => \{/g) || []).length, 11);
  assert.match(source, /return withCheckoutSubmissionCoordination\(callback\)/);
  assert.doesNotMatch(source, /clearIdempotencyRequest\(window\.localStorage, storageKey\)/);
});
