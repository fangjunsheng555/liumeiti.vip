import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { parseNetflixEmail } from "../app/api/netflix-code/_parser.js";
import { latestAcceptedNetflixRecords } from "../app/api/netflix-code/_store.js";

const ACCOUNT = "dual-forward-member@outlook.com";
const INBOX = "netflix@codes.liumeiti.vip";
const ORIGINAL_A = "<netflix-request-a@mailer.netflix.com>";
const ORIGINAL_B = "<netflix-request-b@mailer.netflix.com>";
const ORIGINAL_C = "<netflix-request-c@mailer.netflix.com>";
const SRC_A = "f73ec386-ca05-4d35-9317-dce0338b88c3";
const SRC_B = "aebc4b04-b480-42f1-b3a0-37bbe5d7ba6e";
const SRC_C = "ec079668-e012-4d28-9120-513997c277f4";
const BASE = Date.parse("2026-08-04T04:30:00.000Z");
const TEST_EVIDENCE_KEY = "netflix-dual-forward-e2e-encryption-key";

function alternativeMime({ headers, text, html }) {
  const boundary = "----netflix-dual-forward-e2e";
  return [
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function netflixBody({ code, src, parses }) {
  const text = parses
    ? `Enter this code to sign in to Netflix: ${code}. It expires in 15 minutes.`
    : "Netflix could not display a supported sign-in code in this message.";
  return src ? `${text}\nSRC: netflix_email_${src}_en` : text;
}

// Settings auto-forward preserves the original Netflix MIME identity.
function settingsForward({ code, messageId, src, parses }) {
  const body = netflixBody({ code, src, parses });
  return alternativeMime({
    headers: [
      "From: Netflix <info@account.netflix.com>",
      `To: ${ACCOUNT}`,
      "Subject: Netflix: Your sign-in code",
      `Message-ID: ${messageId}`,
      "Date: Tue, 4 Aug 2026 04:22:00 +0000",
    ],
    text: body,
    html: `<html lang="en"><body><p>${body.replaceAll("\n", "</p><p>")}</p></body></html>`,
  });
}

// Inbox rules create a new Exchange wrapper but retain the original identity
// in parent/reply headers. The forwarded body intentionally has no Sent/Date
// line, matching the real failure where time parsing cannot bridge the copies.
function ruleForward({
  code,
  originalMessageId,
  microsoftOriginalMessageId,
  inReplyTo,
  wrapperMessageId,
  referenceIds,
  src,
  parses,
}) {
  const body = [
    "Forwarded message",
    "From: Netflix <info@account.netflix.com>",
    `To: ${ACCOUNT}`,
    "Subject: Netflix: Your sign-in code",
    netflixBody({ code, src, parses }),
  ].join("\n");
  return alternativeMime({
    headers: [
      `From: ${ACCOUNT}`,
      `To: ${INBOX}`,
      "Subject: Fwd: Netflix: Your sign-in code",
      `Message-ID: ${wrapperMessageId}`,
      `X-MS-Exchange-Parent-Message-Id: ${originalMessageId}`,
      `References: ${referenceIds.join(" ")}`,
      `In-Reply-To: ${inReplyTo}`,
      `X-Microsoft-Original-Message-Id: ${microsoftOriginalMessageId}`,
      "Date: Tue, 4 Aug 2026 04:22:30 +0000",
    ],
    text: body,
    html: `<html lang="en"><body><p>${body.replaceAll("\n", "</p><p>")}</p></body></html>`,
  });
}

function protectedRequestFingerprints(parsed) {
  const key = createHash("sha256").update(TEST_EVIDENCE_KEY).digest();
  return Array.from(new Set((parsed.requestEvidence || []).map((evidence) => createHmac("sha256", key)
    .update(`netflix-request-evidence-v1\0${evidence}`)
    .digest("hex")))).slice(0, 32);
}

function protectedPrimaryRequestFingerprints(parsed) {
  const key = createHash("sha256").update(TEST_EVIDENCE_KEY).digest();
  return Array.from(new Set((parsed.requestPrimaryEvidence || []).map((evidence) => createHmac("sha256", key)
    .update(`netflix-request-evidence-v1\0${evidence}`)
    .digest("hex")))).slice(0, 4);
}

// Mirror the record shape written by storeNetflixMailEvent without mocking
// Redis. This keeps the test on the real parser -> protected identity ->
// selection path rather than hand-authoring a favorable request fingerprint.
async function parsedRecord(raw, { receivedAt, eventId, sequence, envelopeFrom }) {
  const receivedIso = new Date(receivedAt).toISOString();
  const parsed = await parseNetflixEmail(raw, {
    from: envelopeFrom,
    to: INBOX,
    inboxAddress: INBOX,
    receivedAt: receivedIso,
  });
  return {
    parsed,
    entry: {
      receivedAt,
      record: {
        accepted: parsed.accepted,
        eventId,
        deliveryFingerprint: parsed.deliveryFingerprint,
        requestIdentityAmbiguous: parsed.requestIdentityAmbiguous === true,
        requestPrimaryFingerprints: protectedPrimaryRequestFingerprints(parsed),
        requestFingerprints: protectedRequestFingerprints(parsed),
        requestSentAt: parsed.requestSentAt || "",
        receivedAt: parsed.receivedAt,
        arrivalSequence: sequence,
        kind: parsed.kind || "",
        value: parsed.value || "",
      },
    },
  };
}

function selectedRecord(rows) {
  return latestAcceptedNetflixRecords(rows.map((row) => row.entry))[0]?.record || null;
}

function selectedValue(rows) {
  return selectedRecord(rows)?.value || "";
}

const SETTINGS_A = Object.freeze({ code: "4827", messageId: ORIGINAL_A, src: SRC_A, parses: true });
const RULE_A = Object.freeze({
  code: "4827",
  originalMessageId: ORIGINAL_A,
  microsoftOriginalMessageId: ORIGINAL_A,
  inReplyTo: ORIGINAL_A,
  wrapperMessageId: "<outlook-rule-copy@outlook.com>",
  referenceIds: ["<older-thread@outlook.com>", ORIGINAL_A],
  src: SRC_A,
  parses: true,
});

test("dual forward E2E: either successful path, or both paths, returns the code", async (t) => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "settings-success",
    sequence: 1,
    envelopeFrom: "info@account.netflix.com",
  });
  const rule = await parsedRecord(ruleForward(RULE_A), {
    receivedAt: BASE + 5_000,
    eventId: "rule-success",
    sequence: 2,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(settings.parsed.accepted, true);
  assert.equal(rule.parsed.accepted, true);
  await t.test("settings copy only", () => assert.equal(selectedValue([settings]), "4827"));
  await t.test("rule copy only", () => assert.equal(selectedValue([rule]), "4827"));
  await t.test("both successful copies", () => {
    assert.equal(selectedRecord([settings, rule])?.eventId, "rule-success");
    assert.equal(selectedValue([settings, rule]), "4827");
  });
});

test("dual forward E2E: an unparsed rule copy with no quoted time still yields the parsed settings copy", async (t) => {
  for (const gap of [0, 60_000]) {
    await t.test(`${gap / 1000}-second delivery gap`, async () => {
      const settings = await parsedRecord(settingsForward(SETTINGS_A), {
        receivedAt: BASE,
        eventId: `settings-${gap}`,
        sequence: 10,
        envelopeFrom: "info@account.netflix.com",
      });
      const failedRule = await parsedRecord(ruleForward({ ...RULE_A, parses: false }), {
        receivedAt: BASE + gap,
        eventId: `rule-failed-${gap}`,
        sequence: 11,
        envelopeFrom: ACCOUNT,
      });

      assert.equal(failedRule.parsed.accepted, false);
      assert.equal(failedRule.parsed.requestSentAt, "", "the wrapper has no portable quoted original time");
      assert.ok(settings.parsed.requestEvidence.some((value) => failedRule.parsed.requestEvidence.includes(value)),
        "the Exchange parent/References header must bridge to the original Message-ID");
      assert.equal(selectedValue([settings, failedRule]), "4827");
    });
  }

  await t.test("failure arrives 60 seconds before success", async () => {
    const failedRule = await parsedRecord(ruleForward({ ...RULE_A, parses: false }), {
      receivedAt: BASE,
      eventId: "rule-failed-first",
      sequence: 12,
      envelopeFrom: ACCOUNT,
    });
    const settings = await parsedRecord(settingsForward(SETTINGS_A), {
      receivedAt: BASE + 60_000,
      eventId: "settings-success-last",
      sequence: 13,
      envelopeFrom: "info@account.netflix.com",
    });

    assert.equal(failedRule.parsed.accepted, false);
    assert.equal(selectedRecord([failedRule, settings])?.eventId, "settings-success-last");
    assert.equal(selectedValue([failedRule, settings]), "4827");
  });
});

test("dual forward E2E: a failed rule copy without an SRC footer still yields the parsed settings copy", async () => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "settings-with-src",
    sequence: 20,
    envelopeFrom: "info@account.netflix.com",
  });
  const failedRule = await parsedRecord(ruleForward({ ...RULE_A, parses: false, src: "" }), {
    receivedAt: BASE + 30_000,
    eventId: "rule-failed-without-src",
    sequence: 21,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(failedRule.parsed.deliveryFingerprint, "");
  assert.equal(selectedValue([settings, failedRule]), "4827");
});

test("dual forward E2E: two unparsed copies do not return a result", async () => {
  const settings = await parsedRecord(settingsForward({ ...SETTINGS_A, parses: false }), {
    receivedAt: BASE,
    eventId: "settings-failed",
    sequence: 30,
    envelopeFrom: "info@account.netflix.com",
  });
  const rule = await parsedRecord(ruleForward({ ...RULE_A, parses: false }), {
    receivedAt: BASE + 5_000,
    eventId: "rule-failed",
    sequence: 31,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(settings.parsed.accepted, false);
  assert.equal(rule.parsed.accepted, false);
  assert.equal(selectedValue([settings, rule]), "");
});

test("dual forward E2E: a new failed request never replays a ten-minute-old code", async () => {
  const oldSettings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE - 10 * 60_000,
    eventId: "old-settings-success",
    sequence: 40,
    envelopeFrom: "info@account.netflix.com",
  });
  const newFailedRule = await parsedRecord(ruleForward({
    code: "7314",
    originalMessageId: ORIGINAL_B,
    microsoftOriginalMessageId: ORIGINAL_B,
    inReplyTo: ORIGINAL_B,
    wrapperMessageId: "<new-outlook-rule-copy@outlook.com>",
    referenceIds: [ORIGINAL_A, ORIGINAL_B],
    src: SRC_B,
    parses: false,
  }), {
    receivedAt: BASE,
    eventId: "new-rule-failed",
    sequence: 41,
    envelopeFrom: ACCOUNT,
  });

  assert.notEqual(oldSettings.parsed.deliveryFingerprint, newFailedRule.parsed.deliveryFingerprint);
  assert.equal(selectedValue([oldSettings, newFailedRule]), "");
});

test("dual forward E2E: an old References member cannot demote the newest accepted code", async () => {
  const oldSettings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE - 10 * 60_000,
    eventId: "old-thread-code",
    sequence: 50,
    envelopeFrom: "info@account.netflix.com",
  });
  const middleSettings = await parsedRecord(settingsForward({
    code: "2222",
    messageId: ORIGINAL_C,
    src: SRC_C,
    parses: true,
  }), {
    receivedAt: BASE - 5 * 60_000,
    eventId: "middle-code",
    sequence: 51,
    envelopeFrom: "info@account.netflix.com",
  });
  const newestRule = await parsedRecord(ruleForward({
    code: "3333",
    originalMessageId: ORIGINAL_B,
    microsoftOriginalMessageId: ORIGINAL_B,
    inReplyTo: ORIGINAL_B,
    wrapperMessageId: "<newest-outlook-rule-copy@outlook.com>",
    referenceIds: [ORIGINAL_A, ORIGINAL_B],
    src: "",
    parses: true,
  }), {
    receivedAt: BASE,
    eventId: "newest-thread-code",
    sequence: 52,
    envelopeFrom: ACCOUNT,
  });

  assert.deepEqual(oldSettings.parsed.requestPrimaryEvidence, [`message-id:${ORIGINAL_A}`]);
  assert.deepEqual(newestRule.parsed.requestPrimaryEvidence, [`message-id:${ORIGINAL_B}`]);
  assert.ok(newestRule.parsed.requestEvidence.includes(`message-id:${ORIGINAL_A}`),
    "the old thread member remains auxiliary evidence and must not become the current identity");
  assert.equal(selectedValue([oldSettings, middleSettings, newestRule]), "3333");
});

test("dual forward E2E: conflicting Exchange identity headers cannot replay an older code", async () => {
  const oldSettings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE - 30_000,
    eventId: "old-success-before-conflict",
    sequence: 60,
    envelopeFrom: "info@account.netflix.com",
  });
  const conflictingRule = await parsedRecord(ruleForward({
    code: "7314",
    originalMessageId: ORIGINAL_A,
    microsoftOriginalMessageId: ORIGINAL_B,
    inReplyTo: ORIGINAL_B,
    wrapperMessageId: "<conflicting-outlook-rule-copy@outlook.com>",
    referenceIds: [ORIGINAL_A, ORIGINAL_B],
    src: "",
    parses: false,
  }), {
    receivedAt: BASE,
    eventId: "conflicting-rule-copy",
    sequence: 61,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(conflictingRule.parsed.requestIdentityAmbiguous, true);
  assert.deepEqual(conflictingRule.parsed.requestPrimaryEvidence, []);
  assert.equal(selectedValue([oldSettings, conflictingRule]), "");
});
