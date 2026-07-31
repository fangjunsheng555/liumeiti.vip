import test from "node:test";
import assert from "node:assert/strict";
import { latestNetflixSiblingCluster } from "../app/api/netflix-code/_store.js";

test("keeps accepted and rejected copies from the same forwarded delivery together", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const cluster = latestNetflixSiblingCluster([
    { receivedAt: base - 8_000, record: { accepted: true, eventId: "accepted-copy" } },
    { receivedAt: base, record: { accepted: false, eventId: "flattened-copy" } },
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["flattened-copy", "accepted-copy"]);
});

test("does not return an older accepted code for a newer unrelated email", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const cluster = latestNetflixSiblingCluster([
    { receivedAt: base - 16_000, record: { accepted: true, eventId: "old-code" } },
    { receivedAt: base, record: { accepted: false, eventId: "new-email" } },
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["new-email"]);
});
