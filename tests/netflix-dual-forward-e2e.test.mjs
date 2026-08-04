import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
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
function settingsForward({ code, messageId, src, parses, dateHeader = "Tue, 4 Aug 2026 04:22:00 +0000" }) {
  const body = netflixBody({ code, src, parses });
  return alternativeMime({
    headers: [
      "From: Netflix <info@account.netflix.com>",
      `To: ${ACCOUNT}`,
      "Subject: Netflix: Your sign-in code",
      `Message-ID: ${messageId}`,
      `Date: ${dateHeader}`,
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
  sentLine = "",
  includeIdentityHeaders = true,
  quotedHistory = "",
}) {
  const body = [
    "Forwarded message",
    "From: Netflix <info@account.netflix.com>",
    `To: ${ACCOUNT}`,
    "Subject: Netflix: Your sign-in code",
    sentLine,
    netflixBody({ code, src, parses }),
    quotedHistory,
  ].filter(Boolean).join("\n");
  const identityHeaders = includeIdentityHeaders ? [
    `X-MS-Exchange-Parent-Message-Id: ${originalMessageId}`,
    `References: ${referenceIds.join(" ")}`,
    `In-Reply-To: ${inReplyTo}`,
    `X-Microsoft-Original-Message-Id: ${microsoftOriginalMessageId}`,
  ] : [];
  return alternativeMime({
    headers: [
      `From: ${ACCOUNT}`,
      `To: ${INBOX}`,
      "Subject: Fwd: Netflix: Your sign-in code",
      `Message-ID: ${wrapperMessageId}`,
      ...identityHeaders,
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
function entryForParsed(parsed, { receivedAt, eventId, sequence }) {
  return {
    receivedAt,
    record: {
      accepted: parsed.accepted,
      eventId,
      deliveryFingerprint: parsed.deliveryFingerprint,
      deliveryFingerprintFromCurrent: parsed.deliveryFingerprintFromCurrent === true,
      requestIdentityAmbiguous: parsed.requestIdentityAmbiguous === true,
      requestPrimaryFingerprints: protectedPrimaryRequestFingerprints(parsed),
      requestFingerprints: protectedRequestFingerprints(parsed),
      requestSentAt: parsed.requestSentAt || "",
      requestSentAtPortable: parsed.requestSentAtPortable === true,
      receivedAt: parsed.receivedAt,
      arrivalSequence: sequence,
      kind: parsed.kind || "",
      value: parsed.value || "",
    },
  };
}

async function parsedRecord(raw, { receivedAt, eventId, sequence, envelopeFrom }) {
  const receivedIso = new Date(receivedAt).toISOString();
  const parsed = await parseNetflixEmail(raw, {
    from: envelopeFrom,
    to: INBOX,
    inboxAddress: INBOX,
    receivedAt: receivedIso,
  });
  return { parsed, entry: entryForParsed(parsed, { receivedAt, eventId, sequence }) };
}

const PARSER_MODULE_URL = new URL("../app/api/netflix-code/_parser.js", import.meta.url).href;

function parseInTimezone(raw, envelope, timezone) {
  const fixture = Buffer.from(JSON.stringify({ raw, envelope })).toString("base64url");
  const source = [
    `import { parseNetflixEmail } from ${JSON.stringify(PARSER_MODULE_URL)};`,
    "const input = JSON.parse(Buffer.from(process.env.NETFLIX_TZ_FIXTURE, 'base64url').toString('utf8'));",
    "const parsed = await parseNetflixEmail(input.raw, input.envelope);",
    "process.stdout.write(JSON.stringify(parsed));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone, NETFLIX_TZ_FIXTURE: fixture },
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr || `timezone parser exited ${child.status}`);
  return JSON.parse(child.stdout);
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

test("dual forward E2E: a current matching SRC bridges headerless copies only through 120 seconds", async (t) => {
  for (const gap of [0, 60_000, 120_000, 120_001]) {
    await t.test(`${gap}ms`, async () => {
      const settings = await parsedRecord(settingsForward(SETTINGS_A), {
        receivedAt: BASE,
        eventId: `src-settings-${gap}`,
        sequence: 100,
        envelopeFrom: "info@account.netflix.com",
      });
      const failedRule = await parsedRecord(ruleForward({
        ...RULE_A,
        wrapperMessageId: `<src-only-rule-${gap}@outlook.com>`,
        includeIdentityHeaders: false,
        parses: false,
      }), {
        receivedAt: BASE + gap,
        eventId: `src-rule-${gap}`,
        sequence: 101,
        envelopeFrom: ACCOUNT,
      });

      const sharedEvidence = settings.parsed.requestEvidence
        .filter((value) => failedRule.parsed.requestEvidence.includes(value));
      assert.deepEqual(sharedEvidence, [], "the fixture must exercise SRC as the only shared identity");
      assert.equal(failedRule.parsed.deliveryFingerprint, settings.parsed.deliveryFingerprint);
      assert.equal(failedRule.parsed.deliveryFingerprintFromCurrent, true);
      const expected = gap <= 120_000 ? "4827" : "";
      assert.equal(selectedValue([settings, failedRule]), expected);
      assert.equal(selectedValue([failedRule, settings]), expected, "selection must not depend on Redis member order");
    });
  }
});

test("dual forward E2E: same-millisecond SRC fallback requires two positive distinct sequences", async (t) => {
  for (const [settingsSequence, ruleSequence, label] of [
    [200, 200, "equal"],
    [0, 201, "older-missing"],
    [200, 0, "newer-missing"],
  ]) {
    await t.test(label, async () => {
      const settings = await parsedRecord(settingsForward(SETTINGS_A), {
        receivedAt: BASE,
        eventId: `sequence-settings-${label}`,
        sequence: settingsSequence,
        envelopeFrom: "info@account.netflix.com",
      });
      const failedRule = await parsedRecord(ruleForward({
        ...RULE_A,
        wrapperMessageId: `<sequence-rule-${label}@outlook.com>`,
        includeIdentityHeaders: false,
        parses: false,
      }), {
        receivedAt: BASE,
        eventId: `sequence-rule-${label}`,
        sequence: ruleSequence,
        envelopeFrom: ACCOUNT,
      });
      assert.equal(selectedValue([settings, failedRule]), "");
    });
  }
});

test("dual forward E2E: a matching SRC found only in quoted history never replays the old code", async () => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "quoted-src-settings",
    sequence: 210,
    envelopeFrom: "info@account.netflix.com",
  });
  const failedRule = await parsedRecord(ruleForward({
    ...RULE_A,
    wrapperMessageId: "<quoted-src-rule@outlook.com>",
    includeIdentityHeaders: false,
    src: "",
    parses: false,
    quotedHistory: `Quoted earlier Netflix message:\nSRC: old_${SRC_A}_en`,
  }), {
    receivedAt: BASE + 30_000,
    eventId: "quoted-src-rule",
    sequence: 211,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(failedRule.parsed.deliveryFingerprint, "");
  assert.equal(failedRule.parsed.deliveryFingerprintFromCurrent, false);
  assert.equal(selectedValue([settings, failedRule]), "");
});

test("dual forward E2E: a current matching SRC wins over a different quoted historical SRC", async () => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "current-and-quoted-settings",
    sequence: 215,
    envelopeFrom: "info@account.netflix.com",
  });
  const failedRule = await parsedRecord(ruleForward({
    ...RULE_A,
    wrapperMessageId: "<current-and-quoted-rule@outlook.com>",
    includeIdentityHeaders: false,
    parses: false,
    quotedHistory: `Quoted earlier Netflix message:\nSRC: old_${SRC_B}_en`,
  }), {
    receivedAt: BASE + 30_000,
    eventId: "current-and-quoted-rule",
    sequence: 216,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(failedRule.parsed.deliveryFingerprint, settings.parsed.deliveryFingerprint);
  assert.equal(failedRule.parsed.deliveryFingerprintFromCurrent, true);
  assert.equal(selectedValue([settings, failedRule]), "4827");
});

test("dual forward E2E: different current SRC values remain a hard rejection", async () => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "different-src-settings",
    sequence: 220,
    envelopeFrom: "info@account.netflix.com",
  });
  const failedRule = await parsedRecord(ruleForward({
    ...RULE_A,
    wrapperMessageId: "<different-src-rule@outlook.com>",
    includeIdentityHeaders: false,
    src: SRC_B,
    parses: false,
  }), {
    receivedAt: BASE + 30_000,
    eventId: "different-src-rule",
    sequence: 221,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(failedRule.parsed.deliveryFingerprintFromCurrent, true);
  assert.notEqual(failedRule.parsed.deliveryFingerprint, settings.parsed.deliveryFingerprint);
  assert.equal(selectedValue([settings, failedRule]), "");
});

test("dual forward E2E: explicit conflicting original identities outrank a matching current SRC", async () => {
  const settings = await parsedRecord(settingsForward(SETTINGS_A), {
    receivedAt: BASE,
    eventId: "primary-conflict-settings",
    sequence: 230,
    envelopeFrom: "info@account.netflix.com",
  });
  const failedRule = await parsedRecord(ruleForward({
    ...RULE_A,
    originalMessageId: ORIGINAL_B,
    microsoftOriginalMessageId: ORIGINAL_B,
    inReplyTo: ORIGINAL_B,
    referenceIds: [ORIGINAL_B],
    wrapperMessageId: "<primary-conflict-rule@outlook.com>",
    parses: false,
  }), {
    receivedAt: BASE + 30_000,
    eventId: "primary-conflict-rule",
    sequence: 231,
    envelopeFrom: ACCOUNT,
  });

  assert.equal(failedRule.parsed.deliveryFingerprint, settings.parsed.deliveryFingerprint);
  assert.notDeepEqual(failedRule.parsed.requestPrimaryEvidence, settings.parsed.requestPrimaryEvidence);
  assert.equal(selectedValue([settings, failedRule]), "");
});

test("dual forward E2E: a delayed failed SRC-only copy of request A never overtakes successful request B", async () => {
  const oldA = await parsedRecord(settingsForward({
    ...SETTINGS_A,
    dateHeader: "Tue, 4 Aug 2026 04:20:00 +0000",
  }), {
    receivedAt: BASE - 20_000,
    eventId: "delayed-src-a-original",
    sequence: 235,
    envelopeFrom: "info@account.netflix.com",
  });
  const currentB = await parsedRecord(settingsForward({
    code: "7314",
    messageId: ORIGINAL_B,
    src: SRC_B,
    parses: true,
    dateHeader: "Tue, 4 Aug 2026 04:21:00 +0000",
  }), {
    receivedAt: BASE - 10_000,
    eventId: "delayed-src-b-current",
    sequence: 236,
    envelopeFrom: "info@account.netflix.com",
  });
  const delayedA = await parsedRecord(ruleForward({
    ...RULE_A,
    wrapperMessageId: "<delayed-src-a-rule@outlook.com>",
    includeIdentityHeaders: false,
    parses: false,
  }), {
    receivedAt: BASE,
    eventId: "delayed-src-a-failure",
    sequence: 237,
    envelopeFrom: ACCOUNT,
  });

  assert.deepEqual(oldA.parsed.requestEvidence.filter((value) => delayedA.parsed.requestEvidence.includes(value)), []);
  const permutations = [
    [oldA, currentB, delayedA],
    [oldA, delayedA, currentB],
    [currentB, oldA, delayedA],
    [currentB, delayedA, oldA],
    [delayedA, oldA, currentB],
    [delayedA, currentB, oldA],
  ];
  for (const rows of permutations) assert.equal(selectedValue(rows), "7314");
});

test("dual forward E2E: every requested localized sent-date label accepts an explicit offset", async (t) => {
  for (const label of ["发送时间", "日期", "寄件日期", "送信日時", "Enviado", "Gesendet", "Envoyé"]) {
    await t.test(label, async () => {
      const row = await parsedRecord(ruleForward({
        ...RULE_A,
        wrapperMessageId: `<localized-${Buffer.from(label).toString("hex")}@outlook.com>`,
        sentLine: `${label}: Tue, 4 Aug 2026 04:22:00 +0000`,
      }), {
        receivedAt: BASE,
        eventId: `localized-${label}`,
        sequence: 240,
        envelopeFrom: ACCOUNT,
      });
      assert.equal(row.parsed.requestSentAt, "2026-08-04T04:22:00.000Z");
      assert.equal(row.parsed.requestSentAtPortable, true);
    });
  }
});

test("dual forward E2E: a standalone Z timezone is portable", async () => {
  const row = await parsedRecord(ruleForward({
    ...RULE_A,
    wrapperMessageId: "<standalone-z@outlook.com>",
    sentLine: "Sent: Tue, 4 Aug 2026 04:22:00 Z",
  }), {
    receivedAt: BASE,
    eventId: "standalone-z",
    sequence: 250,
    envelopeFrom: ACCOUNT,
  });
  assert.equal(row.parsed.requestSentAt, "2026-08-04T04:22:00.000Z");
  assert.equal(row.parsed.requestSentAtPortable, true);
});

test("dual forward E2E: unzoned forwarded time has identical ordering in UTC and Asia/Shanghai", () => {
  const unzonedRaw = ruleForward({
    ...RULE_A,
    wrapperMessageId: "<timezone-unzoned@outlook.com>",
    includeIdentityHeaders: false,
    sentLine: "Sent: Tuesday, August 4, 2026 4:22 AM",
  });
  const explicitRaw = ruleForward({
    ...RULE_A,
    code: "7314",
    src: SRC_B,
    wrapperMessageId: "<timezone-explicit@outlook.com>",
    includeIdentityHeaders: false,
    sentLine: "Sent: Tue, 4 Aug 2026 04:21:00 +0000",
  });
  const results = ["UTC", "Asia/Shanghai"].map((timezone) => {
    const unzoned = parseInTimezone(unzonedRaw, {
      from: ACCOUNT, to: INBOX, inboxAddress: INBOX, receivedAt: new Date(BASE + 60_000).toISOString(),
    }, timezone);
    const explicit = parseInTimezone(explicitRaw, {
      from: ACCOUNT, to: INBOX, inboxAddress: INBOX, receivedAt: new Date(BASE).toISOString(),
    }, timezone);
    const rows = [
      { parsed: explicit, entry: entryForParsed(explicit, { receivedAt: BASE, eventId: "explicit", sequence: 260 }) },
      { parsed: unzoned, entry: entryForParsed(unzoned, { receivedAt: BASE + 60_000, eventId: "unzoned", sequence: 261 }) },
    ];
    return {
      unzonedSentAt: unzoned.requestSentAt,
      unzonedPortable: unzoned.requestSentAtPortable,
      explicitSentAt: explicit.requestSentAt,
      selected: selectedRecord(rows)?.eventId || "",
    };
  });

  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].unzonedSentAt, "");
  assert.equal(results[0].unzonedPortable, false);
  assert.equal(results[0].explicitSentAt, "2026-08-04T04:21:00.000Z");
  assert.equal(results[0].selected, "", "mixed trusted/unknown request times fail closed in both runtimes");
});

test("dual forward E2E: structured MIME Date is also timezone-independent", () => {
  const unzonedRaw = settingsForward({
    ...SETTINGS_A,
    dateHeader: "Tuesday, August 4, 2026 4:22 AM",
  });
  const explicitRaw = settingsForward({ ...SETTINGS_A, dateHeader: "Tue, 4 Aug 2026 04:22:00 +0000" });
  const envelope = {
    from: "info@account.netflix.com",
    to: INBOX,
    inboxAddress: INBOX,
    receivedAt: new Date(BASE).toISOString(),
  };
  const results = ["UTC", "Asia/Shanghai"].map((timezone) => ({
    unzoned: parseInTimezone(unzonedRaw, envelope, timezone),
    explicit: parseInTimezone(explicitRaw, envelope, timezone),
  }));

  for (const result of results) {
    assert.equal(result.unzoned.requestSentAt, "");
    assert.equal(result.unzoned.requestSentAtPortable, false);
    assert.equal(result.explicit.requestSentAt, "2026-08-04T04:22:00.000Z");
    assert.equal(result.explicit.requestSentAtPortable, true);
  }
});
