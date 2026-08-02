import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createPendingIdempotencyRecord,
  restorePendingIdempotencyRecord,
} from "../app/lib/idempotency.js";

test("money journals retain the exact body and account across reloads", () => {
  const pending = createPendingIdempotencyRecord(null, "money-withdraw", {
    amount: 88,
    channel: "alipay",
    account: "original-account",
  }, { identity: { accountEmail: "buyer@example.com", accountLifecycleId: "a".repeat(32) }, now: 1_000 });
  const restored = restorePendingIdempotencyRecord(JSON.parse(JSON.stringify(pending)), "money-withdraw");
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.record.payload, pending.payload);
  assert.equal(restored.record.identity.accountEmail, "buyer@example.com");
  assert.equal(restored.record.identity.accountLifecycleId, "a".repeat(32));
  assert.equal(restored.record.idempotencyRequest.key, pending.idempotencyRequest.key);
});

test("account money actions dispatch persisted payloads and fail closed on journal damage", async () => {
  const source = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");
  assert.match(source, /await withCheckoutSubmissionCoordination\(async \(\) => \{/);
  assert.match(source, /prepareSinglePendingOperation\(/);
  assert.match(source, /readSinglePendingOperation\(/);
  assert.match(source, /body: JSON\.stringify\(exactPayload\)/);
  assert.match(source, /"X-Operation-Expected-Account": String\(pending\.identity\?\.accountEmail/);
  assert.match(source, /"X-Operation-Expected-Lifecycle": String\(pending\.identity\?\.accountLifecycleId/);
  assert.match(source, /requireAccountLifecycle: true/);
  assert.match(source, /moneyRequestRef\.current\[action\]/);
  assert.match(source, /clearSinglePendingOperation\(window\.localStorage, storageKey, operation\.key\)/);
  assert.match(source, /isExplicitTerminalIdempotencyResponse\(res\.status, data\)/);
  assert.doesNotMatch(source, /readIdempotencyRequest|writeIdempotencyRequest|clearIdempotencyRequest/);
});
