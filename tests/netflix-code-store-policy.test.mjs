import test from "node:test";
import assert from "node:assert/strict";
import {
  findLatestNetflixMailState,
  latestAcceptedNetflixRecords,
  latestNetflixSiblingCluster,
  markNetflixCodeResultReturned,
  recordNetflixCodeAccess,
  storeNetflixMailEvent,
} from "../app/api/netflix-code/_store.js";
import { netflixMailStateErrorResponse } from "../app/api/netflix-code/route.js";

const DELIVERY_A = "a".repeat(64);
const DELIVERY_B = "b".repeat(64);
const DELIVERY_C = "c".repeat(64);
const REQUEST_A = "1".repeat(64);
const REQUEST_B = "2".repeat(64);
const BASE = Date.parse("2026-08-01T08:00:00.000Z");

function mail({
  at = BASE,
  accepted,
  id,
  // Absence is the least favorable production shape: no SRC and no shared
  // request identity. Tests that model preserved evidence opt in explicitly.
  fingerprint = "",
  fingerprintFromCurrent = false,
  requestFingerprint = "",
  primaryFingerprint = "",
  requestIdentityAmbiguous = false,
  code = "",
  sequence = 0,
  requestSentAt = "",
  requestSentAtPortable = false,
}) {
  return {
    receivedAt: at,
    record: {
      accepted,
      eventId: id,
      deliveryFingerprint: fingerprint,
      deliveryFingerprintFromCurrent: fingerprintFromCurrent,
      requestFingerprints: Array.isArray(requestFingerprint)
        ? requestFingerprint
        : requestFingerprint ? [requestFingerprint] : [],
      requestPrimaryFingerprints: Array.isArray(primaryFingerprint)
        ? primaryFingerprint
        : primaryFingerprint ? [primaryFingerprint] : [],
      requestIdentityAmbiguous,
      arrivalSequence: sequence,
      requestSentAt,
      requestSentAtPortable,
      value: code,
    },
  };
}

function selected(records, options = {}) {
  return latestAcceptedNetflixRecords(records, undefined, options).map((entry) => entry.record);
}

test("only the inbox-rule copy arrives and parses: returns its code", () => {
  assert.equal(selected([
    mail({ accepted: true, id: "rule-forward", code: "4827" }),
  ])[0]?.value, "4827");
});

test("only the settings auto-forward copy arrives and parses: returns its code", () => {
  assert.equal(selected([
    mail({ accepted: true, id: "settings-forward", code: "7314" }),
  ])[0]?.value, "7314");
});

test("both copies arrive and parse: returns the latest copy", () => {
  const result = selected([
    mail({ at: BASE - 40_000, accepted: true, id: "first-copy", requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: true, id: "second-copy", requestFingerprint: REQUEST_A, code: "4827" }),
  ]);
  assert.deepEqual(result.map((record) => record.eventId), ["second-copy"]);
  assert.equal(result[0]?.value, "4827");
});

test("one copy parses and one fails at 0-120 seconds: returns the successful copy in either arrival order", async (t) => {
  for (const gap of [0, 60_000, 120_000]) {
    await t.test(`failure arrives ${gap} ms after success`, () => {
      const result = selected([
        mail({ at: BASE - gap, accepted: true, id: `success-${gap}`, requestFingerprint: REQUEST_A, code: "4827" }),
        mail({ accepted: false, id: `failure-${gap}`, requestFingerprint: REQUEST_A }),
      ]);
      assert.equal(result[0]?.value, "4827");
    });
    await t.test(`success arrives ${gap} ms after failure`, () => {
      const result = selected([
        mail({ at: BASE - gap, accepted: false, id: `failure-first-${gap}`, requestFingerprint: REQUEST_A }),
        mail({ accepted: true, id: `success-last-${gap}`, requestFingerprint: REQUEST_A, code: "7314" }),
      ]);
      assert.equal(result[0]?.value, "7314");
    });
  }
});

test("the successful copy has no SRC fingerprint: still returns its code", () => {
  const result = selected([
    mail({ at: BASE - 70_000, accepted: true, id: "success-without-src", fingerprint: "", requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "failed-with-src", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A }),
  ]);
  assert.equal(result[0]?.value, "4827");
});

test("the failed copy has no SRC fingerprint: still returns the successful code", () => {
  const result = selected([
    mail({ at: BASE - 70_000, accepted: true, id: "success-with-src", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "failed-without-src", fingerprint: "", requestFingerprint: REQUEST_A }),
  ]);
  assert.equal(result[0]?.value, "4827");
});

test("a successful historical record without a fingerprint remains readable", () => {
  const result = selected([
    mail({ accepted: true, id: "legacy-success", fingerprint: "", code: "4827" }),
  ]);
  assert.equal(result[0]?.value, "4827");
});

test("when both copies fail to parse, no result is selected", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 10_000, accepted: false, id: "rule-failure", requestFingerprint: REQUEST_A }),
    mail({ accepted: false, id: "settings-failure", requestFingerprint: REQUEST_A }),
  ]), []);
});

test("different requested code emails always return the latest parsed code", () => {
  const result = selected([
    mail({ at: BASE - 10_000, accepted: true, id: "old-code", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: true, id: "new-code", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, code: "7314" }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("a delayed duplicate of the old request cannot overtake a newer requested code", () => {
  const result = selected([
    mail({ at: BASE - 20_000, accepted: true, id: "request-a-first", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827", sequence: 40 }),
    mail({ at: BASE - 10_000, accepted: true, id: "request-b", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, code: "7314", sequence: 41 }),
    mail({ at: BASE, accepted: true, id: "request-a-delayed-copy", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827", sequence: 42 }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("original Netflix sent time keeps a delayed old copy behind the newer request", () => {
  const requestASentAt = new Date(BASE - 30_000).toISOString();
  const requestBSentAt = new Date(BASE - 15_000).toISOString();
  const result = selected([
    mail({ at: BASE - 20_000, accepted: true, id: "dated-a-first", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, requestSentAt: requestASentAt, requestSentAtPortable: true, code: "4827" }),
    mail({ at: BASE - 10_000, accepted: true, id: "dated-b", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, requestSentAt: requestBSentAt, requestSentAtPortable: true, code: "7314" }),
    mail({ at: BASE, accepted: true, id: "dated-a-delayed", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, requestSentAt: requestASentAt, requestSentAtPortable: true, code: "4827" }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("different requests with the same trusted send time fail closed", () => {
  const sameSentAt = new Date(BASE - 60_000).toISOString();
  const result = selected([
    mail({ at: BASE - 20_000, accepted: true, id: "same-date-a-first", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, requestSentAt: sameSentAt, requestSentAtPortable: true, code: "4827", sequence: 40 }),
    mail({ at: BASE - 10_000, accepted: true, id: "same-date-b", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, requestSentAt: sameSentAt, requestSentAtPortable: true, code: "7314", sequence: 41 }),
    mail({ at: BASE, accepted: true, id: "same-date-a-delayed", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, requestSentAt: sameSentAt, requestSentAtPortable: true, code: "4827", sequence: 42 }),
  ]);
  assert.deepEqual(result, []);
});

test("transitive evidence alone cannot authorize an accepted-code fallback", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  assert.deepEqual(selected([
    mail({ at: BASE - 20_000, accepted: true, id: "bridge-success", requestFingerprint: requestY, code: "7314" }),
    mail({ at: BASE - 10_000, accepted: false, id: "bridge-both", requestFingerprint: [requestX, requestY] }),
    mail({ at: BASE, accepted: false, id: "bridge-latest", requestFingerprint: requestX }),
  ]), []);
});

test("a fingerprint-less evidence bridge cannot merge two different SRC requests", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  assert.deepEqual(selected([
    mail({ at: BASE - 20_000, accepted: true, id: "old-success", fingerprint: DELIVERY_A, requestFingerprint: requestX, code: "4827" }),
    mail({ at: BASE - 10_000, accepted: false, id: "identity-bridge", fingerprint: "", requestFingerprint: [requestX, requestY] }),
    mail({ at: BASE, accepted: false, id: "new-failure", fingerprint: DELIVERY_B, requestFingerprint: requestY }),
  ]), []);
});

test("a quoted old SRC plus a transitive identity bridge never replays the old code", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  const rows = [
    mail({ at: BASE - 20_000, accepted: true, id: "old-success", fingerprint: DELIVERY_A, requestFingerprint: requestX, code: "4827" }),
    mail({ at: BASE - 10_000, accepted: false, id: "thread-bridge", fingerprint: "", requestFingerprint: [requestX, requestY] }),
    mail({ at: BASE, accepted: false, id: "new-failure-quoting-old-src", fingerprint: DELIVERY_A, requestFingerprint: requestY }),
  ];
  const permutations = [
    [rows[0], rows[1], rows[2]],
    [rows[0], rows[2], rows[1]],
    [rows[1], rows[0], rows[2]],
    [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]],
    [rows[2], rows[1], rows[0]],
  ];
  for (const input of permutations) assert.deepEqual(selected(input), []);
});

test("same-millisecond transitive bridge cannot invent a newer current-SRC direction", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  const oldAccepted = mail({
    accepted: true,
    id: "same-ms-old-accepted",
    fingerprint: DELIVERY_A,
    fingerprintFromCurrent: true,
    requestFingerprint: requestY,
    code: "4827",
  });
  const bridge = mail({
    accepted: false,
    id: "same-ms-bridge",
    requestFingerprint: [requestX, requestY],
  });
  const latestFailed = mail({
    accepted: false,
    id: "same-ms-latest-failed",
    fingerprint: DELIVERY_A,
    fingerprintFromCurrent: true,
    requestFingerprint: requestX,
  });
  assert.deepEqual(selected([oldAccepted, bridge, latestFailed]), []);
  assert.deepEqual(selected([latestFailed, bridge, oldAccepted]), []);
});

test("current primary identity prevents an old References thread member from demoting the newest accepted code", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  const requestZ = "5".repeat(64);
  const rows = [
    mail({ at: BASE - 10 * 60_000, accepted: true, id: "old-thread-code", requestFingerprint: requestX, primaryFingerprint: requestX, code: "1111" }),
    mail({ at: BASE - 5 * 60_000, accepted: true, id: "middle-code", requestFingerprint: requestZ, primaryFingerprint: requestZ, code: "2222" }),
    mail({ at: BASE, accepted: true, id: "new-thread-code", requestFingerprint: [requestX, requestY], primaryFingerprint: requestY, code: "3333" }),
  ];
  const permutations = [
    [rows[0], rows[1], rows[2]],
    [rows[0], rows[2], rows[1]],
    [rows[1], rows[0], rows[2]],
    [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]],
    [rows[2], rows[1], rows[0]],
  ];
  for (const input of permutations) assert.deepEqual(selected(input).map((record) => record.value), ["3333"]);
});

test("a new primary identity matches a legacy record only through that exact identity", () => {
  const requestX = "3".repeat(64);
  const requestY = "4".repeat(64);
  assert.deepEqual(selected([
    mail({ at: BASE - 60_000, accepted: true, id: "legacy-success", requestFingerprint: requestX, code: "4827" }),
    mail({ at: BASE, accepted: false, id: "new-failure", requestFingerprint: [requestX, requestY], primaryFingerprint: requestX }),
  ]).map((record) => record.value), ["4827"]);
  assert.deepEqual(selected([
    mail({ at: BASE - 60_000, accepted: true, id: "legacy-other-request", requestFingerprint: requestY, code: "7314" }),
    mail({ at: BASE, accepted: false, id: "new-failure", requestFingerprint: [requestX, requestY], primaryFingerprint: requestX }),
  ]), []);
});

test("different explicit primary identities override shared auxiliary thread evidence", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 30_000, accepted: true, id: "old-success", requestFingerprint: REQUEST_A, primaryFingerprint: REQUEST_A, code: "4827" }),
    mail({ at: BASE, accepted: false, id: "new-failure", requestFingerprint: REQUEST_A, primaryFingerprint: REQUEST_B }),
  ]), []);
});

test("an ambiguous current identity cannot claim an older accepted code", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 30_000, accepted: true, id: "old-success", requestFingerprint: REQUEST_A, primaryFingerprint: REQUEST_A, code: "4827" }),
    mail({ at: BASE, accepted: false, id: "conflicting-rule-copy", requestFingerprint: [REQUEST_A, REQUEST_B], requestIdentityAmbiguous: true }),
  ]), []);
});

test("different accepted codes with the same millisecond timestamp use the distributed arrival sequence", () => {
  const result = selected([
    mail({ accepted: true, id: "new-code", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, code: "7314", sequence: 42 }),
    mail({ accepted: true, id: "old-code", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827", sequence: 41 }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("an unknown-time competitor fails closed through the 120-second ambiguity boundary", () => {
  for (const gap of [10_000, 119_999, 120_000]) {
    assert.deepEqual(selected([
      mail({ at: BASE - gap, accepted: true, id: `trusted-request-${gap}`, fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, primaryFingerprint: REQUEST_B, requestSentAt: new Date(BASE - gap - 1_000).toISOString(), requestSentAtPortable: true, code: "7314" }),
      mail({ at: BASE, accepted: true, id: `unknown-time-competitor-${gap}`, fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, primaryFingerprint: REQUEST_A, code: "4827" }),
    ]), []);
  }
});

test("an unknown-time rule-only request remains usable beyond the duplicate-delivery window", () => {
  const result = selected([
    mail({ at: BASE - 120_001, accepted: true, id: "previous-request", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, primaryFingerprint: REQUEST_A, requestSentAt: new Date(BASE - 120_001).toISOString(), requestSentAtPortable: true, code: "4827" }),
    mail({ at: BASE, accepted: true, id: "rule-only-current-request", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B, primaryFingerprint: REQUEST_B, code: "7314" }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("indistinguishable same-millisecond legacy requests fail closed instead of guessing", () => {
  const rows = [
    mail({ accepted: true, id: "legacy-a", fingerprint: DELIVERY_A, code: "4827" }),
    mail({ accepted: true, id: "legacy-b", fingerprint: DELIVERY_B, code: "7314" }),
  ];
  assert.deepEqual(selected(rows), []);
  assert.deepEqual(selected([...rows].reverse()), []);
});

test("same-millisecond success and failure preserve any-success behavior regardless of array order", () => {
  const result = selected([
    mail({ accepted: true, id: "successful-copy", fingerprint: "", requestFingerprint: REQUEST_A, code: "4827", sequence: 41 }),
    mail({ accepted: false, id: "failed-copy", fingerprint: "", requestFingerprint: REQUEST_A, sequence: 42 }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["4827"]);
});

test("a newer failed email with a different fingerprint never falls back to the old code", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 10_000, accepted: true, id: "old-code", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "new-unparsed-mail", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_B }),
  ]), []);
});

test("different present SRC fingerprints override a coincidentally matching content identity", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 10_000, accepted: true, id: "old-code", fingerprint: DELIVERY_A, requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "new-unparsed-mail", fingerprint: DELIVERY_B, requestFingerprint: REQUEST_A }),
  ]), []);
});

test("a newer failed email quoting only the previous SRC can never replay the old code", () => {
  assert.deepEqual(selected([
    mail({
      at: BASE - 10_000,
      accepted: true,
      id: "old-code-with-src",
      fingerprint: DELIVERY_A,
      requestFingerprint: REQUEST_A,
      code: "4827",
    }),
    mail({
      accepted: false,
      id: "new-failed-mail-quoting-old-src",
      fingerprint: DELIVERY_A,
      requestFingerprint: REQUEST_B,
    }),
  ]), []);
});

test("a current matching SRC can claim a pre-deployment accepted record within 120 seconds", () => {
  const result = selected([
    mail({
      at: BASE - 60_000,
      accepted: true,
      id: "legacy-accepted-without-current-marker",
      fingerprint: DELIVERY_A,
      code: "4827",
    }),
    mail({
      accepted: false,
      id: "new-current-src-copy",
      fingerprint: DELIVERY_A,
      fingerprintFromCurrent: true,
      sequence: 2,
    }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["4827"]);
});

test("a legacy host-derived requestSentAt is ignored without the portable marker", () => {
  const result = selected([
    mail({
      at: BASE - 60_000,
      accepted: true,
      id: "legacy-poisoned-time",
      fingerprint: DELIVERY_A,
      requestSentAt: "2099-01-01T00:00:00.000Z",
      code: "4827",
    }),
    mail({
      accepted: true,
      id: "current-request",
      fingerprint: DELIVERY_B,
      code: "7314",
    }),
  ]);
  assert.deepEqual(result.map((record) => record.value), ["7314"]);
});

test("portable requestSentAt is revalidated against receivedAt before ordering", async (t) => {
  const cases = [
    ["future", "2099-01-01T00:00:00.000Z"],
    ["older-than-seven-days", new Date(BASE - 60_000 - 7 * 24 * 60 * 60_000 - 1).toISOString()],
    ["invalid", "not-a-date"],
    ["null", null],
    ["empty", ""],
  ];
  for (const [label, requestSentAt] of cases) {
    await t.test(label, () => {
      const result = selected([
        mail({
          at: BASE - 60_000,
          accepted: true,
          id: `invalid-portable-${label}`,
          fingerprint: DELIVERY_A,
          requestSentAt,
          requestSentAtPortable: true,
          code: "4827",
        }),
        mail({
          accepted: true,
          id: `current-after-${label}`,
          fingerprint: DELIVERY_B,
          code: "7314",
        }),
      ]);
      assert.deepEqual(result.map((record) => record.value), ["7314"]);
    });
  }
});

test("different same-millisecond accepted requests fail closed when either sequence is missing", () => {
  const complete = mail({ accepted: true, id: "complete-sequence", fingerprint: DELIVERY_A, code: "4827", sequence: 200 });
  const missing = mail({ accepted: true, id: "missing-sequence", fingerprint: DELIVERY_B, code: "7314", sequence: 0 });
  assert.deepEqual(selected([complete, missing]), []);
  assert.deepEqual(selected([missing, complete]), []);
});

test("three same-millisecond requests fail closed in all orders when any sequence is missing", () => {
  const rows = [
    mail({ accepted: true, id: "sequence-2", fingerprint: DELIVERY_A, code: "4827", sequence: 2 }),
    mail({ accepted: true, id: "sequence-1", fingerprint: DELIVERY_B, code: "7314", sequence: 1 }),
    mail({ accepted: true, id: "sequence-missing", fingerprint: DELIVERY_C, code: "2468", sequence: 0 }),
  ];
  const permutations = [
    [rows[0], rows[1], rows[2]],
    [rows[0], rows[2], rows[1]],
    [rows[1], rows[0], rows[2]],
    [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]],
    [rows[2], rows[1], rows[0]],
  ];
  for (const input of permutations) assert.deepEqual(selected(input), []);
});

test("an unreturned old code is never guessed behind a newer fingerprint-less failed request", () => {
  assert.deepEqual(selected([
    mail({
      at: BASE - 10_000,
      accepted: true,
      id: "old-code-not-yet-returned",
      fingerprint: "",
      requestFingerprint: "",
      code: "4827",
    }),
    mail({
      accepted: false,
      id: "new-failed-request-without-src",
      fingerprint: "",
      requestFingerprint: "",
    }),
  ]), []);
});

test("a newer failed fingerprint-less email never replays a code already returned to this order", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 10_000, accepted: true, id: "NM000000000000000000000001", fingerprint: "", requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "NM000000000000000000000002", fingerprint: "", requestFingerprint: REQUEST_A }),
  ], {
    excludeFallbackEventIds: ["NM000000000000000000000001"],
  }), []);
});

test("the current newest accepted event remains readable after it was returned", () => {
  const result = selected([
    mail({ accepted: true, id: "NM000000000000000000000001", fingerprint: "", code: "4827" }),
  ], {
    excludeFallbackEventIds: ["NM000000000000000000000001"],
  });
  assert.equal(result[0]?.value, "4827");
});

test("accepted fallback is limited to the 120-second duplicate-delivery window", () => {
  assert.deepEqual(selected([
    mail({ at: BASE - 120_001, accepted: true, id: "stale-code", requestFingerprint: REQUEST_A, code: "4827" }),
    mail({ accepted: false, id: "new-email", requestFingerprint: REQUEST_A }),
  ]), []);
});

test("rejected sibling acknowledgement still requires the same fingerprint", () => {
  const cluster = latestNetflixSiblingCluster([
    mail({ at: BASE - 8_000, accepted: false, id: "same-delivery", fingerprint: DELIVERY_A }),
    mail({ accepted: false, id: "new-delivery", fingerprint: DELIVERY_B }),
  ]);
  assert.deepEqual(cluster.map((entry) => entry.record.eventId), ["new-delivery"]);
});

test("Netflix mail reads distinguish a healthy empty inbox from Redis failures", async (t) => {
  const previous = {
    kvUrl: process.env.KV_REST_API_URL,
    kvToken: process.env.KV_REST_API_TOKEN,
    upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
    upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.KV_REST_API_URL = "https://redis.netflix-read-safety.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  t.after(() => {
    for (const [name, value] of [
      ["KV_REST_API_URL", previous.kvUrl],
      ["KV_REST_API_TOKEN", previous.kvToken],
      ["UPSTASH_REDIS_REST_URL", previous.upstashUrl],
      ["UPSTASH_REDIS_REST_TOKEN", previous.upstashToken],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = previous.fetch;
  });

  const account = "strict-read@example.com";
  const healthyPipeline = (commands) => commands.map((command) => ({
    result: command[0] === "PING" ? "PONG" : [],
  }));

  let activeWindowQuery = [];
  globalThis.fetch = async (_url, init = {}) => {
    const commands = JSON.parse(init.body || "[]");
    activeWindowQuery = commands.find((command) => command[0] === "ZREVRANGEBYSCORE") || activeWindowQuery;
    return Response.json(healthyPipeline(commands));
  };
  assert.deepEqual(await findLatestNetflixMailState(account), { state: "pending" });
  assert.equal(activeWindowQuery.includes("LIMIT"), false,
    "request selection must read the complete active window before clustering");

  globalThis.fetch = async () => new Response("", { status: 503 });
  const httpFailure = await findLatestNetflixMailState(account);
  assert.deepEqual(httpFailure, { state: "error", error: "storage_unavailable" });
  const routeResponse = netflixMailStateErrorResponse(httpFailure);
  assert.equal(routeResponse.status, 503);
  assert.deepEqual(await routeResponse.json(), { ok: false, error: "storage_unavailable" });

  globalThis.fetch = async () => new Response("{not-json", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(await findLatestNetflixMailState(account), {
    state: "error",
    error: "storage_unavailable",
  });

  const eventId = "NM000000000000000000000099";
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls += 1;
    const commands = JSON.parse(init.body || "[]");
    if (calls === 1) {
      return Response.json(commands.map((command) => ({
        result: command[0] === "PING" ? "PONG" : [eventId],
      })));
    }
    return new Response("", { status: 503 });
  };
  assert.deepEqual(await findLatestNetflixMailState(account), {
    state: "error",
    error: "storage_unavailable",
  });

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  assert.deepEqual(await findLatestNetflixMailState(account), {
    state: "error",
    error: "storage_unavailable",
  });
});

test("persisted return evidence blocks an old-code fallback only after a newer failed mail arrives", async (t) => {
  const previous = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    encryption: process.env.NETFLIX_CODE_ENCRYPTION_KEY,
    fetch: globalThis.fetch,
  };
  process.env.KV_REST_API_URL = "https://redis.netflix-policy.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.NETFLIX_CODE_ENCRYPTION_KEY = "netflix-policy-test-encryption-key-2026";

  const strings = new Map();
  const sortedSets = new Map();
  let failSafetyMarkerWrite = false;
  let loseSafetyMarkerResponse = false;
  let failReturnedEvidenceLookup = false;
  const sortedSet = (key) => {
    if (!sortedSets.has(key)) sortedSets.set(key, new Map());
    return sortedSets.get(key);
  };
  const execute = (command) => {
    const [name, ...args] = command.map(String);
    if (name === "EVAL" && args[0].includes("validtype(KEYS[1])") && args[1] === "2") {
      if (failSafetyMarkerWrite) return 0;
      strings.set(args[2], "1");
      strings.set(args[3], "1");
      return loseSafetyMarkerResponse ? null : 1;
    }
    if (name === "EVAL" && args[1] === "3" && args[0].includes("existingScore=redis.call('ZSCORE'")) {
      const [, , dedupeKey, recordKey, indexKey, id, raw, score] = args;
      const existing = strings.get(recordKey);
      if (!existing) strings.set(recordKey, raw);
      const priorScore = sortedSet(indexKey).get(id);
      sortedSet(indexKey).set(id, priorScore ?? Number(score));
      strings.set(dedupeKey, id);
      return existing ? 0 : 1;
    }
    if (name === "SET") {
      const [key, value] = args;
      if (failSafetyMarkerWrite && key.includes("netflix-code:returned-event-global:v1:")) return null;
      const nx = args.includes("NX");
      if (nx && strings.has(key)) return null;
      strings.set(key, value);
      return "OK";
    }
    if (name === "GET") return strings.get(args[0]) ?? null;
    if (name === "INCR") {
      const next = Number(strings.get(args[0]) || 0) + 1;
      strings.set(args[0], String(next));
      return next;
    }
    if (name === "DEL") return strings.delete(args[0]) ? 1 : 0;
    if (name === "ZADD") {
      sortedSet(args[0]).set(args[2], Number(args[1]));
      return 1;
    }
    if (name === "ZSCORE") return sortedSet(args[0]).has(args[1]) ? String(sortedSet(args[0]).get(args[1])) : null;
    if (name === "ZREMRANGEBYSCORE") return 0;
    if (name === "PING") return "PONG";
    if (name === "ZREVRANGEBYSCORE") {
      const [key, rawMax, rawMin] = args;
      const max = rawMax === "+inf" ? Infinity : Number(rawMax);
      const min = rawMin === "-inf" ? -Infinity : Number(rawMin);
      const limitAt = args.indexOf("LIMIT");
      const offset = limitAt >= 0 ? Number(args[limitAt + 1]) : 0;
      const count = limitAt >= 0 ? Number(args[limitAt + 2]) : Infinity;
      return [...sortedSet(key).entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((left, right) => right[1] - left[1])
        .slice(offset, offset + count)
        .map(([member]) => member);
    }
    throw new Error(`unsupported Redis command: ${name}`);
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/pipeline")) {
      const commands = JSON.parse(init.body || "[]");
      if (failReturnedEvidenceLookup && commands.some((command) => String(command?.[1] || "").includes("netflix-code:returned-event-global:v1:"))) {
        return new Response("", { status: 503 });
      }
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    const parts = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return Response.json({ result: execute(parts) });
  };

  t.after(() => {
    if (previous.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previous.url;
    if (previous.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previous.token;
    if (previous.encryption === undefined) delete process.env.NETFLIX_CODE_ENCRYPTION_KEY;
    else process.env.NETFLIX_CODE_ENCRYPTION_KEY = previous.encryption;
    globalThis.fetch = previous.fetch;
  });

  const now = Date.now();
  const account = "netflix-member@example.com";
  const accepted = await storeNetflixMailEvent({
    accepted: true,
    kind: "code",
    value: "4827",
    accountEmails: [account],
    sender: "info@account.netflix.com",
    subject: "Netflix: Your sign-in code",
    receivedAt: new Date(now - 10_000).toISOString(),
    expiresAt: new Date(now + 14 * 60_000).toISOString(),
    deliveryFingerprint: DELIVERY_A,
    deliveryFingerprintFromCurrent: true,
    requestSentAt: new Date(now - 15_000).toISOString(),
    requestSentAtPortable: true,
    requestEvidence: ["message-id:<same-original-netflix-request@example.com>"],
  }, { messageId: "old-code", digest: "old-code" });
  assert.equal(accepted.ok, true);
  const firstStoredRecord = JSON.parse(strings.get(`liumeiti:netflix-mail:event:${accepted.eventId}`));
  assert.equal(firstStoredRecord.deliveryFingerprintFromCurrent, true);
  assert.equal(firstStoredRecord.requestSentAtPortable, true);
  const acceptedRetry = await storeNetflixMailEvent({
    accepted: true,
    kind: "code",
    value: "4827",
    accountEmails: [account],
    sender: "info@account.netflix.com",
    subject: "Netflix: Your sign-in code",
    receivedAt: new Date(now - 10_000).toISOString(),
    expiresAt: new Date(now + 14 * 60_000).toISOString(),
    deliveryFingerprint: DELIVERY_A,
    deliveryFingerprintFromCurrent: true,
    requestSentAt: new Date(now - 15_000).toISOString(),
    requestSentAtPortable: true,
    requestEvidence: ["message-id:<same-original-netflix-request@example.com>"],
  }, { messageId: "old-code", digest: "old-code" });
  const retryStoredRecord = JSON.parse(strings.get(`liumeiti:netflix-mail:event:${accepted.eventId}`));
  assert.equal(acceptedRetry.eventId, accepted.eventId);
  assert.equal(retryStoredRecord.arrivalSequence, firstStoredRecord.arrivalSequence,
    "webhook retries must retain their original arrival tiebreaker");
  assert.equal(await markNetflixCodeResultReturned("", accepted.eventId), false, "invalid order ids cannot create a safety marker");
  failSafetyMarkerWrite = true;
  assert.equal(await markNetflixCodeResultReturned("LM-NETFLIX-SAFETY", accepted.eventId), false,
    "a failed Redis write must not be reported as a persisted safety marker");
  assert.equal([...strings.keys()].some((key) => key.includes("netflix-code:returned-event")), false,
    "the two safety markers must fail atomically");
  failSafetyMarkerWrite = false;
  loseSafetyMarkerResponse = true;
  assert.equal(await markNetflixCodeResultReturned("LM-NETFLIX-AMBIGUOUS", accepted.eventId), true,
    "an ambiguous REST response must recover both atomically committed markers");
  loseSafetyMarkerResponse = false;
  assert.equal(await recordNetflixCodeAccess({
    orderId: "LM-NETFLIX-SAFETY",
    accountEmail: account,
    eventId: accepted.eventId,
    outcome: "code_returned",
  }), true);
  const rejected = await storeNetflixMailEvent({
    accepted: false,
    reason: "supported_content_not_found",
    accountEmails: [account],
    sender: "info@account.netflix.com",
    subject: "Netflix: Your sign-in code",
    receivedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    deliveryFingerprint: "",
    requestEvidence: ["message-id:<same-original-netflix-request@example.com>"],
  }, { messageId: "new-unparsed-code", digest: "new-unparsed-code" });
  assert.equal(rejected.ok, true);

  const unscoped = await findLatestNetflixMailState(account, { since: now - 60_000 });
  assert.equal(unscoped.state, "result", "the any-success delivery policy is unchanged without prior-return evidence");
  assert.equal(unscoped.result.value, "4827");

  failReturnedEvidenceLookup = true;
  const conservativeOnLookupFailure = await findLatestNetflixMailState(account, {
    since: now - 60_000,
    orderId: "LM-NETFLIX-SAFETY",
  });
  assert.deepEqual(conservativeOnLookupFailure, { state: "error", error: "storage_unavailable" },
    "a marker lookup outage must be surfaced instead of guessed around");
  failReturnedEvidenceLookup = false;

  const otherOrderScoped = await findLatestNetflixMailState(account, {
    since: now - 60_000,
    orderId: "LM-NETFLIX-OTHER-ORDER",
  });
  assert.equal(otherOrderScoped.state, "rejected",
    "global return evidence prevents old-code fallback through another order sharing the account");

  // Simulate an event returned before the explicit marker migration. The
  // historical access-dedupe evidence must provide the same protection for
  // the original order even after both marker formats are absent.
  for (const key of strings.keys()) {
    if (key.includes("netflix-code:returned-event:v1:") || key.includes("netflix-code:returned-event-global:v1:")) strings.delete(key);
  }

  const orderScoped = await findLatestNetflixMailState(account, {
    since: now - 60_000,
    orderId: "LM-NETFLIX-SAFETY",
  });
  assert.notEqual(orderScoped.state, "result");
  assert.equal(orderScoped.state, "rejected");
  assert.equal(orderScoped.eventId, rejected.eventId);
});
