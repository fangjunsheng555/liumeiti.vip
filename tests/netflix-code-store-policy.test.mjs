import test from "node:test";
import assert from "node:assert/strict";
import { latestAcceptedNetflixRecords, latestNetflixSiblingCluster } from "../app/api/netflix-code/_store.js";

const DELIVERY_A = "a".repeat(64);
const DELIVERY_B = "b".repeat(64);

test("keeps accepted and rejected copies from the same forwarded delivery together", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const cluster = latestNetflixSiblingCluster([
    { receivedAt: base - 8_000, record: { accepted: true, eventId: "accepted-copy", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: false, eventId: "flattened-copy", deliveryFingerprint: DELIVERY_A } },
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["flattened-copy", "accepted-copy"]);
});

test("does not return an older accepted code for a newer unrelated email", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const cluster = latestNetflixSiblingCluster([
    { receivedAt: base - 8_000, record: { accepted: true, eventId: "old-code", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: false, eventId: "new-email", deliveryFingerprint: DELIVERY_B } },
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["new-email"]);
});

test("does not merge fingerprint-less messages based on time and account alone", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const cluster = latestNetflixSiblingCluster([
    { receivedAt: base - 2_000, record: { accepted: false, eventId: "legacy-copy-a" } },
    { receivedAt: base, record: { accepted: false, eventId: "legacy-copy-b" } },
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["legacy-copy-b"]);
});

test("prefers an accepted dual-delivery copy over a later rejected copy", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 70_000, record: { accepted: true, eventId: "rule-forward-copy", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: false, eventId: "flattened-auto-forward", deliveryFingerprint: DELIVERY_A } },
  ]);
  assert.deepEqual(accepted.map((entry) => entry.record.eventId), ["rule-forward-copy"]);
});

test("never returns an older accepted code for a newer delivery with a different fingerprint", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 10_000, record: { accepted: true, eventId: "code-4827", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: false, eventId: "new-unparsed-mail", deliveryFingerprint: DELIVERY_B } },
  ]);
  assert.deepEqual(accepted, []);
});

test("never returns an older accepted code when either delivery fingerprint is missing", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 10_000, record: { accepted: true, eventId: "legacy-code" } },
    { receivedAt: base, record: { accepted: false, eventId: "new-unparsed-mail" } },
  ]);
  assert.deepEqual(accepted, []);
});

test("returns the newest accepted copy first when both deliveries parse", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 40_000, record: { accepted: true, eventId: "first-copy", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: true, eventId: "second-copy", deliveryFingerprint: DELIVERY_A } },
  ]);
  assert.deepEqual(accepted.map((entry) => entry.record.eventId), ["second-copy", "first-copy"]);
});

test("ignores an accepted record older than the dual-delivery window", () => {
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  const accepted = latestAcceptedNetflixRecords([
    { receivedAt: base - 180_000, record: { accepted: true, eventId: "stale-code", deliveryFingerprint: DELIVERY_A } },
    { receivedAt: base, record: { accepted: false, eventId: "new-email", deliveryFingerprint: DELIVERY_A } },
  ]);
  assert.deepEqual(accepted, []);
});
