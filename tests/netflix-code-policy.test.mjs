import test from "node:test";
import assert from "node:assert/strict";
import {
  REJECTED_SIBLING_GRACE_MS,
  REJECTED_SIBLING_POLL_ALLOWANCE_MS,
  shouldAwaitAcceptedSibling,
} from "../app/api/netflix-code/_policy.js";
import { NETFLIX_DUAL_DELIVERY_WINDOW_MS } from "../app/api/netflix-code/_store.js";

test("a newly rejected forwarded copy keeps polling for an accepted sibling", () => {
  const now = Date.parse("2026-08-01T06:00:00.000Z");
  assert.equal(shouldAwaitAcceptedSibling({
    state: "rejected",
    receivedAt: new Date(now - 8_000).toISOString(),
  }, now), true);
});

test("rejected copies at 119 and 120 seconds still wait for a successful forwarding sibling", () => {
  const now = Date.parse("2026-08-01T06:00:00.000Z");
  for (const age of [119_000, 120_000]) {
    assert.equal(shouldAwaitAcceptedSibling({
      state: "rejected",
      receivedAt: new Date(now - age).toISOString(),
    }, now), true, `${age} ms must remain pending`);
  }
});

test("a rejected copy becomes unrecognized only after the delivery window and polling allowance", () => {
  const now = Date.parse("2026-08-01T06:00:00.000Z");
  assert.equal(REJECTED_SIBLING_GRACE_MS, NETFLIX_DUAL_DELIVERY_WINDOW_MS + REJECTED_SIBLING_POLL_ALLOWANCE_MS);
  assert.ok(REJECTED_SIBLING_POLL_ALLOWANCE_MS >= 6_000);
  assert.equal(shouldAwaitAcceptedSibling({
    state: "rejected",
    receivedAt: new Date(now - (REJECTED_SIBLING_GRACE_MS - 1)).toISOString(),
  }, now), true);
  assert.equal(shouldAwaitAcceptedSibling({
    state: "rejected",
    receivedAt: new Date(now - REJECTED_SIBLING_GRACE_MS).toISOString(),
  }, now), false);
  assert.equal(shouldAwaitAcceptedSibling({ state: "pending" }, now), false);
});
