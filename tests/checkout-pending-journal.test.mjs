import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKOUT_PENDING_LEGACY_KEY,
  checkoutPendingStorageKey,
  clearCheckoutPendingJournal,
  readCheckoutPendingJournals,
  withCheckoutSubmissionCoordination,
  writeCheckoutPendingJournal,
} from "../app/lib/checkout-pending-journal.js";
import { createPendingIdempotencyRecord } from "../app/lib/idempotency.js";

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function pending(now, email = "buyer@example.com") {
  return createPendingIdempotencyRecord(null, "checkout-order", {
    email,
    expectedAccountEmail: "",
    paymentMethod: "balance",
    paymentQuoteToken: "",
    items: [{ service: "ai", plan: "gpt-pro" }],
  }, {
    identity: { accountEmail: "", accountLifecycleId: "" },
    metadata: { cart: ["ai"] },
    now,
  });
}

test("per-operation checkout journals never overwrite another unresolved order", () => {
  const storage = new MemoryStorage();
  const first = pending(1_000, "first@example.com");
  const second = pending(2_000, "second@example.com");

  writeCheckoutPendingJournal(storage, first);
  assert.throws(
    () => writeCheckoutPendingJournal(storage, second),
    /checkout_pending_operation_exists/,
  );

  const snapshot = readCheckoutPendingJournals(storage);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].record.idempotencyRequest.key, first.idempotencyRequest.key);
  assert.equal(storage.getItem(checkoutPendingStorageKey(second.idempotencyRequest.key)), null);
});

test("rewriting the same operation preserves its first durable exact journal", () => {
  const storage = new MemoryStorage();
  const first = pending(2_500, "first@example.com");
  writeCheckoutPendingJournal(storage, first);
  const storageKey = checkoutPendingStorageKey(first.idempotencyRequest.key);
  const durableRaw = storage.getItem(storageKey);
  const alteredMetadata = { ...first, cart: ["spotify"] };

  const result = writeCheckoutPendingJournal(storage, alteredMetadata);
  assert.equal(storage.getItem(storageKey), durableRaw);
  assert.deepEqual(result.record.cart, ["ai"]);
});

test("multiple independently written operations remain visible and force ambiguous recovery", () => {
  const first = pending(3_000, "first@example.com");
  const second = pending(4_000, "second@example.com");
  const storage = new MemoryStorage([
    [checkoutPendingStorageKey(first.idempotencyRequest.key), JSON.stringify(first)],
    [checkoutPendingStorageKey(second.idempotencyRequest.key), JSON.stringify(second)],
  ]);

  const snapshot = readCheckoutPendingJournals(storage);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.records.length, 2);
  assert.deepEqual(
    new Set(snapshot.records.map((entry) => entry.record.idempotencyRequest.key)),
    new Set([first.idempotencyRequest.key, second.idempotencyRequest.key]),
  );
  assert.equal(storage.length, 2);
});

test("legacy v1 is deduplicated with its v2 copy and cleared only by exact operation", () => {
  const record = pending(5_000);
  const storage = new MemoryStorage([[CHECKOUT_PENDING_LEGACY_KEY, JSON.stringify(record)]]);

  const legacy = readCheckoutPendingJournals(storage);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.records.length, 1);
  assert.equal(legacy.records[0].storageKey, CHECKOUT_PENDING_LEGACY_KEY);

  writeCheckoutPendingJournal(storage, record);
  assert.notEqual(storage.getItem(CHECKOUT_PENDING_LEGACY_KEY), null);
  assert.notEqual(storage.getItem(checkoutPendingStorageKey(record.idempotencyRequest.key)), null);
  assert.equal(readCheckoutPendingJournals(storage).records.length, 1);

  assert.equal(clearCheckoutPendingJournal(storage, "some-other-operation"), true);
  assert.notEqual(storage.getItem(CHECKOUT_PENDING_LEGACY_KEY), null);
  assert.equal(clearCheckoutPendingJournal(storage, record.idempotencyRequest.key), true);
  assert.equal(storage.getItem(CHECKOUT_PENDING_LEGACY_KEY), null);
  assert.equal(storage.getItem(checkoutPendingStorageKey(record.idempotencyRequest.key)), null);
});

test("corrupt and mismatched storage entries fail closed without deletion", () => {
  const record = pending(6_000);
  const corruptKey = checkoutPendingStorageKey(record.idempotencyRequest.key);
  const storage = new MemoryStorage([[corruptKey, "{partially-written"]]);

  const corrupt = readCheckoutPendingJournals(storage);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.errors[0].error, "checkout_journal_invalid_json");
  assert.equal(storage.getItem(corruptKey), "{partially-written");
  assert.throws(() => writeCheckoutPendingJournal(storage, pending(7_000)), /checkout_journal_ambiguous/);
  assert.equal(clearCheckoutPendingJournal(storage, record.idempotencyRequest.key), false);
  assert.equal(storage.getItem(corruptKey), "{partially-written");

  const wrongKey = checkoutPendingStorageKey("wrong-operation");
  const mismatched = new MemoryStorage([[wrongKey, JSON.stringify(record)]]);
  const mismatchSnapshot = readCheckoutPendingJournals(mismatched);
  assert.equal(mismatchSnapshot.ok, false);
  assert.equal(mismatchSnapshot.errors[0].error, "checkout_journal_storage_key_mismatch");
  assert.notEqual(mismatched.getItem(wrongKey), null);
});

test("pre-lifecycle checkout journals fail closed instead of attaching to a re-registered email", () => {
  const storage = new MemoryStorage();
  const legacy = createPendingIdempotencyRecord(null, "checkout-order", {
    email: "buyer@example.com",
    expectedAccountEmail: "buyer@example.com",
    paymentMethod: "balance",
    items: [{ service: "ai", plan: "gpt-pro" }],
  }, { identity: { accountEmail: "buyer@example.com" }, now: 1_000 });
  const key = checkoutPendingStorageKey(legacy.idempotencyRequest.key);
  const raw = JSON.stringify(legacy);
  storage.setItem(key, raw);

  const restored = readCheckoutPendingJournals(storage);
  assert.equal(restored.ok, false);
  assert.equal(restored.records.length, 0);
  assert.equal(restored.errors[0].error, "checkout_journal_lifecycle_missing");
  assert.equal(storage.getItem(key), raw, "ambiguous legacy journal must be preserved");
});

test("terminal cleanup removes only the matching operation when several exist", () => {
  const first = pending(8_000, "first@example.com");
  const second = pending(9_000, "second@example.com");
  const firstKey = checkoutPendingStorageKey(first.idempotencyRequest.key);
  const secondKey = checkoutPendingStorageKey(second.idempotencyRequest.key);
  const storage = new MemoryStorage([
    [firstKey, JSON.stringify(first)],
    [secondKey, JSON.stringify(second)],
  ]);

  assert.equal(clearCheckoutPendingJournal(storage, first.idempotencyRequest.key), true);
  assert.equal(storage.getItem(firstKey), null);
  assert.notEqual(storage.getItem(secondKey), null);
  assert.equal(readCheckoutPendingJournals(storage).records.length, 1);
});

function fallbackEnvironment(tokens = ["tab-a", "tab-b", "tab-c"]) {
  let tokenIndex = 0;
  return {
    localStorage: new MemoryStorage(),
    crypto: { randomUUID: () => tokens[tokenIndex++] || `tab-${tokenIndex}` },
    setTimeout,
  };
}

test("Web Locks is the primary origin-wide checkout coordinator", async () => {
  const calls = [];
  const environment = {
    navigator: {
      locks: {
        request(name, options, callback) {
          calls.push({ name, options });
          return callback({ name });
        },
      },
    },
  };
  const result = await withCheckoutSubmissionCoordination(() => "sent", environment);
  assert.equal(result, "sent");
  assert.deepEqual(calls, [{ name: "liumeiti:checkout-submit:v2", options: { mode: "exclusive", ifAvailable: true } }]);
});

test("localStorage bakery fallback lets exactly one simultaneous tab submit", async () => {
  const environment = fallbackEnvironment(["tab-a", "tab-b"]);
  let active = 0;
  let maxActive = 0;
  const submit = async (name) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return name;
  };
  const attempts = await Promise.allSettled([
    withCheckoutSubmissionCoordination(() => submit("a"), environment, { pollMs: 2, maxWaitMs: 100 }),
    withCheckoutSubmissionCoordination(() => submit("b"), environment, { pollMs: 2, maxWaitMs: 100 }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.match(String(attempts.find((attempt) => attempt.status === "rejected")?.reason?.message), /checkout_cross_tab_submission_active/);
  assert.equal(maxActive, 1);
  assert.equal(environment.localStorage.length, 0);
});

test("Web Locks rejects an already active tab instead of queuing a duplicate", async () => {
  let sent = false;
  const environment = {
    navigator: {
      locks: {
        request(name, options, callback) {
          assert.equal(options.ifAvailable, true);
          return callback(null);
        },
      },
    },
  };
  await assert.rejects(
    withCheckoutSubmissionCoordination(() => { sent = true; }, environment),
    /checkout_cross_tab_submission_active/,
  );
  assert.equal(sent, false);
});

test("localStorage fallback rejects a late tab instead of bypassing an active owner", async () => {
  const environment = fallbackEnvironment(["tab-a", "tab-b"]);
  let releaseOwner;
  const ownerBlock = new Promise((resolve) => { releaseOwner = resolve; });
  let ownerStarted;
  const started = new Promise((resolve) => { ownerStarted = resolve; });
  const first = withCheckoutSubmissionCoordination(async () => {
    ownerStarted();
    await ownerBlock;
  }, environment, { pollMs: 2, maxWaitMs: 100 });
  await started;

  await assert.rejects(
    withCheckoutSubmissionCoordination(() => "must-not-send", environment, { pollMs: 2, maxWaitMs: 10 }),
    /checkout_cross_tab_submission_active/,
  );
  releaseOwner();
  await first;
});

test("browser without Web Locks or usable localStorage fails closed", async () => {
  let sent = false;
  await assert.rejects(
    withCheckoutSubmissionCoordination(() => { sent = true; }, {}),
    /checkout_cross_tab_coordination_unavailable/,
  );
  assert.equal(sent, false);

  const blockedEnvironment = {};
  Object.defineProperty(blockedEnvironment, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  await assert.rejects(
    withCheckoutSubmissionCoordination(() => { sent = true; }, blockedEnvironment),
    /checkout_cross_tab_coordination_unavailable/,
  );
  assert.equal(sent, false);
});

test("localStorage fallback preserves callback errors and terminal metadata", async () => {
  const environment = fallbackEnvironment(["tab-a"]);
  const original = new Error("operation_identity_changed");
  original.code = "operation_identity_changed";
  original.status = 409;
  original.terminal = false;

  await assert.rejects(
    withCheckoutSubmissionCoordination(() => { throw original; }, environment),
    (error) => error === original
      && error.code === "operation_identity_changed"
      && error.status === 409
      && error.terminal === false,
  );
  assert.equal(environment.localStorage.length, 0);
});

test("fallback clears a known stale pre-journal claim but retains one protecting a pending order", async () => {
  const staleKey = "liumeiti:checkout-submit-lock:v1:stale-tab";
  const staleValue = JSON.stringify({ token: "stale-tab", choosing: false, number: 1, createdAt: 1 });
  const environment = fallbackEnvironment(["new-tab"]);
  environment.localStorage.setItem(staleKey, staleValue);
  assert.equal(
    await withCheckoutSubmissionCoordination(() => "sent", environment, { staleMs: 10, maxWaitMs: 20 }),
    "sent",
  );
  assert.equal(environment.localStorage.getItem(staleKey), null);

  const protectedEnvironment = fallbackEnvironment(["blocked-tab"]);
  protectedEnvironment.localStorage.setItem(staleKey, staleValue);
  const record = pending(10_000);
  protectedEnvironment.localStorage.setItem(
    checkoutPendingStorageKey(record.idempotencyRequest.key),
    JSON.stringify(record),
  );
  let sent = false;
  await assert.rejects(
    withCheckoutSubmissionCoordination(() => { sent = true; }, protectedEnvironment, {
      pollMs: 1,
      maxWaitMs: 5,
      staleMs: 10,
    }),
    /checkout_cross_tab_submission_active/,
  );
  assert.equal(sent, false);
  assert.equal(protectedEnvironment.localStorage.getItem(staleKey), staleValue);
  assert.equal(readCheckoutPendingJournals(protectedEnvironment.localStorage).records.length, 1);
});

test("persisted lock metadata cannot redirect stale cleanup to another storage key", async () => {
  const environment = fallbackEnvironment(["new-tab"]);
  const lockKey = "liumeiti:checkout-submit-lock:v1:stale-tab";
  const victimKey = "unrelated:must-survive";
  environment.localStorage.setItem(victimKey, "preserved");
  environment.localStorage.setItem(lockKey, JSON.stringify({
    token: "stale-tab",
    choosing: false,
    number: 1,
    createdAt: 1,
    storageKey: victimKey,
    raw: "preserved",
  }));

  assert.equal(await withCheckoutSubmissionCoordination(
    () => "sent",
    environment,
    { staleMs: 10 },
  ), "sent");
  assert.equal(environment.localStorage.getItem(lockKey), null);
  assert.equal(environment.localStorage.getItem(victimKey), "preserved");
});

test("stale cleanup retains claims protecting money, redeem, resend, and quote journals", async () => {
  const journalEntries = [
    ["liumeiti:idempotency:money:transfer", "pending-money"],
    ["liumeiti:idempotency:balance-redeem", "pending-redeem"],
    ["liumeiti:admin-mutation:balance:buyer@example.com:v1", "pending-admin"],
    ["lm:idempotency:spotify-resend:LM1", "pending-resend"],
    ["liumeiti:quote-order-pending:v1", JSON.stringify({ completed: false })],
    ["liumeiti:quote-order-pending:v1", "{corrupt"],
  ];
  for (const [journalKey, journalValue] of journalEntries) {
    const environment = fallbackEnvironment([`blocked-${journalKey}`]);
    const staleKey = "liumeiti:checkout-submit-lock:v1:stale-tab";
    const staleValue = JSON.stringify({ token: "stale-tab", choosing: false, number: 1, createdAt: 1 });
    environment.localStorage.setItem(staleKey, staleValue);
    environment.localStorage.setItem(journalKey, journalValue);
    let sent = false;
    await assert.rejects(
      withCheckoutSubmissionCoordination(() => { sent = true; }, environment, { staleMs: 10 }),
      /checkout_cross_tab_submission_active/,
    );
    assert.equal(sent, false);
    assert.equal(environment.localStorage.getItem(staleKey), staleValue);
  }

  const completedQuote = fallbackEnvironment(["after-completed-quote"]);
  const staleKey = "liumeiti:checkout-submit-lock:v1:stale-tab";
  completedQuote.localStorage.setItem(staleKey, JSON.stringify({
    token: "stale-tab", choosing: false, number: 1, createdAt: 1,
  }));
  const completedRecord = createPendingIdempotencyRecord(null, "quote-order", {
    email: "buyer@example.com",
    platformUrl: "https://example.com/item",
  }, { identity: { accountEmail: "", accountLifecycleId: "" }, now: 1_000 });
  completedQuote.localStorage.setItem("liumeiti:quote-order-pending:v1", JSON.stringify({
    ...completedRecord,
    completed: true,
    result: { orderId: "LM-COMPLETE" },
  }));
  assert.equal(await withCheckoutSubmissionCoordination(
    () => "sent",
    completedQuote,
    { staleMs: 10 },
  ), "sent");
});
