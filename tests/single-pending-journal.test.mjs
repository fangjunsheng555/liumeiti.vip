import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  clearSinglePendingOperation,
  completeSinglePendingOperation,
  prepareSinglePendingOperation,
  readSinglePendingOperation,
} from "../app/lib/single-pending-journal.js";
import { nextIdempotencyRequest } from "../app/lib/idempotency.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

const storageKey = "pending:test";
const scope = "balance-redeem";
const payload = { code: "ABC123" };
const identity = { accountEmail: "buyer@example.com" };
const legacyPayload = { accountEmail: identity.accountEmail, code: payload.code };

test("an exact single-slot operation is durable and reused byte-for-byte", () => {
  const storage = new MemoryStorage();
  const first = prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload });
  const raw = storage.getItem(storageKey);
  const retry = prepareSinglePendingOperation(storage, storageKey, scope, { code: "ABC123" }, { identity, legacyPayload });
  assert.equal(retry.idempotencyRequest.key, first.idempotencyRequest.key);
  assert.equal(storage.getItem(storageKey), raw);
  assert.deepEqual(retry.payload, payload);
});

test("corruption and changed account or body remain on disk and fail closed", () => {
  const storage = new MemoryStorage();
  const first = prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload });
  const raw = storage.getItem(storageKey);
  assert.throws(
    () => prepareSinglePendingOperation(storage, storageKey, scope, { code: "OTHER" }, {
      identity,
      legacyPayload: { ...legacyPayload, code: "OTHER" },
    }),
    /pending_operation_context_changed/,
  );
  assert.throws(
    () => prepareSinglePendingOperation(storage, storageKey, scope, payload, {
      identity: { accountEmail: "other@example.com" },
      legacyPayload: { accountEmail: "other@example.com", code: payload.code },
    }),
    /pending_operation_context_changed/,
  );
  assert.equal(storage.getItem(storageKey), raw);

  storage.setItem(storageKey, "{broken");
  assert.throws(
    () => readSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload }),
    /pending_operation_journal_invalid_json/,
  );
  assert.equal(storage.getItem(storageKey), "{broken");
  assert.ok(first.idempotencyRequest.key);
});

test("a verified legacy key migrates without changing the server operation id", () => {
  const storage = new MemoryStorage();
  const legacy = nextIdempotencyRequest(null, scope, legacyPayload, 1234);
  storage.setItem(storageKey, JSON.stringify(legacy));
  const migrated = prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload });
  assert.equal(migrated.idempotencyRequest.key, legacy.key);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)).payload, payload);
});

test("authenticated journals without a lifecycle stay preserved and cannot dispatch", () => {
  const storage = new MemoryStorage();
  const oldRecord = prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload });
  const raw = storage.getItem(storageKey);
  const currentIdentity = { accountEmail: identity.accountEmail, accountLifecycleId: "a".repeat(32) };
  assert.throws(
    () => readSinglePendingOperation(storage, storageKey, scope, payload, {
      identity: currentIdentity,
      legacyPayload,
      requireAccountLifecycle: true,
    }),
    /pending_operation_lifecycle_missing/,
  );
  assert.equal(storage.getItem(storageKey), raw);
  assert.ok(oldRecord.idempotencyRequest.key);

  const empty = new MemoryStorage();
  assert.throws(
    () => prepareSinglePendingOperation(empty, storageKey, scope, payload, {
      identity,
      legacyPayload,
      requireAccountLifecycle: true,
    }),
    /pending_operation_lifecycle_required/,
  );
  assert.equal(empty.getItem(storageKey), null);
});

test("failed or unverifiable writes prevent dispatch and compare-clear preserves replacements", () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota"); };
  assert.throws(
    () => prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload }),
    /pending_operation_journal_write_failed/,
  );

  const stable = new MemoryStorage();
  const first = prepareSinglePendingOperation(stable, storageKey, scope, payload, { identity, legacyPayload });
  const replacement = { ...first, idempotencyRequest: { ...first.idempotencyRequest, key: "replacement" } };
  stable.setItem(storageKey, JSON.stringify(replacement));
  assert.equal(clearSinglePendingOperation(stable, storageKey, first.idempotencyRequest.key), false);
  assert.notEqual(stable.getItem(storageKey), null);
});

test("completion compare-replace cannot overwrite another unresolved operation", () => {
  const storage = new MemoryStorage();
  const first = prepareSinglePendingOperation(storage, storageKey, scope, payload, { identity, legacyPayload });
  const completed = { ...first, completed: true, result: { orderId: "LM1" } };
  assert.equal(
    completeSinglePendingOperation(storage, storageKey, first.idempotencyRequest.key, completed),
    true,
  );
  assert.equal(JSON.parse(storage.getItem(storageKey)).completed, true);

  const other = {
    ...first,
    idempotencyRequest: { ...first.idempotencyRequest, key: "another-unresolved-operation" },
  };
  storage.setItem(storageKey, JSON.stringify(other));
  assert.equal(
    completeSinglePendingOperation(storage, storageKey, first.idempotencyRequest.key, completed),
    false,
  );
  assert.equal(JSON.parse(storage.getItem(storageKey)).idempotencyRequest.key, "another-unresolved-operation");
});

test("redeem and resend UIs journal the exact HTTP body before dispatch", async () => {
  const [redeem, service] = await Promise.all([
    readFile(new URL("../app/components/RedeemCard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8"),
  ]);
  for (const source of [redeem, service]) {
    assert.match(source, /withCheckoutSubmissionCoordination\(async \(\) => \{/);
    assert.match(source, /prepareSinglePendingOperation\(/);
    assert.match(source, /clearSinglePendingOperation\(/);
    assert.doesNotMatch(source, /readIdempotencyRequest|writeIdempotencyRequest/);
  }
  assert.match(redeem, /body: JSON\.stringify\(pending\.payload\)/);
  assert.equal((service.match(/body: JSON\.stringify\(pending\.payload\)/g) || []).length, 2);
});
