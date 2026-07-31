import test from "node:test";
import assert from "node:assert/strict";
import {
  REJECTED_SIBLING_GRACE_MS,
  shouldAwaitAcceptedSibling,
} from "../app/api/netflix-code/_policy.js";

test("a newly rejected forwarded copy keeps polling for an accepted sibling", () => {
  const now = Date.parse("2026-08-01T06:00:00.000Z");
  assert.equal(shouldAwaitAcceptedSibling({
    state: "rejected",
    receivedAt: new Date(now - 8_000).toISOString(),
  }, now), true);
});

test("a rejected copy becomes a clear error after the sibling grace period", () => {
  const now = Date.parse("2026-08-01T06:00:00.000Z");
  assert.equal(shouldAwaitAcceptedSibling({
    state: "rejected",
    receivedAt: new Date(now - REJECTED_SIBLING_GRACE_MS).toISOString(),
  }, now), false);
  assert.equal(shouldAwaitAcceptedSibling({ state: "pending" }, now), false);
});
