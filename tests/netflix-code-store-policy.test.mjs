import test from "node:test";
import assert from "node:assert/strict";
import { latestAcceptedNetflixRecords, latestNetflixSiblingCluster } from "../app/api/netflix-code/_store.js";

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

test("prefers an accepted dual-delivery copy over a later rejected copy", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 70_000, record: { accepted: true, eventId: "rule-forward-copy" } },
    { receivedAt: base, record: { accepted: false, eventId: "flattened-auto-forward" } },
  ]);
  assert.deepEqual(accepted.map((entry) => entry.record.eventId), ["rule-forward-copy"]);
});

test("returns the newest accepted copy first when both deliveries parse", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 40_000, record: { accepted: true, eventId: "first-copy" } },
    { receivedAt: base, record: { accepted: true, eventId: "second-copy" } },
  ]);
  assert.deepEqual(accepted.map((entry) => entry.record.eventId), ["second-copy", "first-copy"]);
});

test("ignores an accepted record older than the dual-delivery window", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 180_000, record: { accepted: true, eventId: "stale-code" } },
    { receivedAt: base, record: { accepted: false, eventId: "new-email" } },
  ]);
  assert.deepEqual(accepted, []);
});
