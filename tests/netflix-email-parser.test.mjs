import test from "node:test";
import assert from "node:assert/strict";
import { parseNetflixEmail, netflixParserInternals } from "../app/api/netflix-code/_parser.js";

function mime({ from = "Netflix <info@account.netflix.com>", to = "member@example.com", subject = "Netflix", text = "", html = "", extraHeaders = [] }) {
  const boundary = "----maoyang-netflix-test";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...extraHeaders,
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
    html || `<html><body>${text}</body></html>`,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function outlookForwardedEml({ account, code }) {
  const digits = String(code).split("").map((digit) => `<span>${digit}</span>`).join("<span>&nbsp;</span>");
  const original = [
    "From: Netflix <info@account.netflix.com>",
    `To: ${account}`,
    "Subject: Netflix: Your sign-in code",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<html lang="en"><body><h1>Enter this code to sign in</h1><p>${digits}</p><p>Enter the code above on your device to sign in to Netflix.</p></body></html>`,
  ].join("\r\n");
  const encoded = Buffer.from(original).toString("base64").match(/.{1,76}/g).join("\r\n");
  const boundary = "----outlook-forwarded-message";
  return [
    `From: ${account}`,
    "To: netflix@codes.liumeiti.vip",
    "Subject: Fwd: Netflix: Your sign-in code",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Forwarded message",
    "Return-Path: <010101abcdef@us-west-2.amazonses.com>",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="Netflix message.eml"',
    'Content-Disposition: attachment; filename="Netflix message.eml"',
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function outlookInlineCurrentWithQuotedOldEml({ account, oldCode, includeCurrentFrom = true }) {
  const oldOriginal = [
    "From: Netflix <info@account.netflix.com>",
    `To: ${account}`,
    "Subject: Netflix: Your old sign-in code",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Enter this code to sign in to Netflix: ${oldCode}.`,
  ].join("\r\n");
  const encoded = Buffer.from(oldOriginal).toString("base64").match(/.{1,76}/g).join("\r\n");
  const boundary = "----outlook-inline-current-with-old-eml";
  return [
    `From: ${account}`,
    "To: netflix@codes.liumeiti.vip",
    "Subject: Fwd: Netflix: New sign-in request",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    ...(includeCurrentFrom ? [
      "From: Netflix <info@account.netflix.com>",
      `To: ${account}`,
      "Subject: Netflix: New sign-in request",
    ] : []),
    "Netflix could not display a supported sign-in code in this message.",
    "Quoted earlier Netflix message:",
    `--${boundary}`,
    'Content-Type: message/rfc822; name="old-netflix.eml"',
    'Content-Disposition: attachment; filename="old-netflix.eml"',
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

test("parses a direct four-digit Netflix sign-in code for an external account", async () => {
  const parsed = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: "Use this login code to sign in to Netflix: 4827. It expires in 15 minutes.",
  }));
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "4827");
  assert.deepEqual(parsed.accountEmails, ["member@example.com"]);
});

test("derives the same delivery fingerprint only from a Netflix SRC footer UUID", async () => {
  const uuid = "f73ec386-ca05-4d35-9317-dce0338b88c3";
  const first = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: `Use this login code to sign in to Netflix: 4827.\nSRC: netflix_email_${uuid}_en`,
  }));
  const forwardedCopy = await parseNetflixEmail(mime({
    subject: "Fwd: Your Netflix sign-in code",
    text: `Forwarded by an inbox rule.\nUse this login code to sign in to Netflix: 4827.\nSRC: wrapped_${uuid}_copy`,
    extraHeaders: ["X-Forwarded-By: test-provider"],
  }));
  assert.match(first.deliveryFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(forwardedCopy.deliveryFingerprint, first.deliveryFingerprint);

  const unrelatedUuid = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: `Use this login code to sign in to Netflix: 7314.\nRequest-ID: ${uuid}`,
  }));
  assert.equal(unrelatedUuid.deliveryFingerprint, "");
});

test("uses the first SRC UUID when quoted mail contains two Netflix SRC footers", async () => {
  const currentUuid = "f73ec386-ca05-4d35-9317-dce0338b88c3";
  const quotedUuid = "aebc4b04-b480-42f1-b3a0-37bbe5d7ba6e";
  const currentOnly = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: `Use this login code to sign in to Netflix: 4827.\nSRC: current_${currentUuid}_en`,
  }));
  const withQuotedHistory = await parseNetflixEmail(mime({
    subject: "Fwd: Your Netflix sign-in code",
    text: [
      "Use this login code to sign in to Netflix: 4827.",
      `SRC: current_${currentUuid}_en`,
      "Quoted earlier Netflix message:",
      `SRC: older_${quotedUuid}_en`,
    ].join("\n"),
  }));

  assert.match(currentOnly.deliveryFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(withQuotedHistory.deliveryFingerprint, currentOnly.deliveryFingerprint);
});

test("does not treat an SRC that exists only in quoted history as the current request", async () => {
  const quotedUuid = "f73ec386-ca05-4d35-9317-dce0338b88c3";
  const parsed = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: [
      "Netflix could not display a supported sign-in code in this message.",
      "Quoted earlier Netflix message:",
      `SRC: previous_${quotedUuid}_en`,
    ].join("\n"),
  }));

  assert.equal(parsed.accepted, false);
  assert.equal(parsed.deliveryFingerprint, "");
});

test("does not replay a code from a quoted old EML when the current inline request cannot be parsed", async () => {
  const account = "member-current@example.com";
  const parsed = await parseNetflixEmail(outlookInlineCurrentWithQuotedOldEml({ account, oldCode: "4827" }), {
    from: account,
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "supported_content_not_found");
  assert.equal(parsed.value, undefined);
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("does not replay an attached old EML when the outer current business content has no From header", async () => {
  const account = "member-no-current-header@example.com";
  const parsed = await parseNetflixEmail(outlookInlineCurrentWithQuotedOldEml({
    account,
    oldCode: "4827",
    includeCurrentFrom: false,
  }), {
    from: account,
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, false);
  assert.equal(parsed.value, undefined);
});

test("parses an HTML-only flattened Outlook forward with CSS and an entity-encoded Netflix sender", async () => {
  const account = "html-forward@example.com";
  const parsed = await parseNetflixEmail(mime({
    from: account,
    to: "netflix@codes.liumeiti.vip",
    subject: "Fwd: Your Netflix sign-in code",
    text: "",
    html: [
      "<html><head><style>",
      "body { color: #111; }",
      ".code { letter-spacing: .2em; }",
      "</style></head><body>",
      "<p>Forwarded message</p>",
      "<p>From: Netflix &lt;info@account.netflix.com&gt;</p>",
      `<p>To: ${account}</p>`,
      "<p>Enter this code to sign in to Netflix:</p>",
      '<p class="code">7314</p>',
      "</body></html>",
    ].join("\n"),
  }), {
    from: account,
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "7314");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("captures the original Date from a flattened Netflix forward for request ordering", async () => {
  const receivedAt = "2026-08-01T08:02:00.000Z";
  const parsed = await parseNetflixEmail(mime({
    from: "forwarding-account@example.com",
    to: "netflix@codes.liumeiti.vip",
    subject: "Fwd: Your Netflix sign-in code",
    text: [
      "Forwarded message",
      "From: Netflix <info@account.netflix.com>",
      "Date: Sat, 1 Aug 2026 08:00:00 +0000",
      "To: forwarding-account@example.com",
      "Enter this code to sign in to Netflix: 7314.",
    ].join("\n"),
  }), {
    from: "forwarding-account@example.com",
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
    receivedAt,
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.requestSentAt, "2026-08-01T08:00:00.000Z");
});

test("does not index an account address found only in quoted historical content", async () => {
  const currentAccount = "current-account@example.com";
  const historicalAccount = "historical-account@example.com";
  const parsed = await parseNetflixEmail(mime({
    to: currentAccount,
    subject: "Your Netflix sign-in code",
    text: [
      "Use this login code to sign in to Netflix: 7314.",
      "Quoted earlier Netflix message:",
      `This message was mailed to ${historicalAccount} by Netflix as part of your Netflix membership.`,
    ].join("\n"),
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.value, "7314");
  assert.deepEqual(parsed.accountEmails, [currentAccount]);
});

test("derives shared original-message evidence when one forwarded copy loses its SRC footer", async () => {
  const uuid = "f73ec386-ca05-4d35-9317-dce0338b88c3";
  const body = "Use this login code to sign in to Netflix: 4827. It expires in 15 minutes.";
  const withSrc = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: `${body}\nSRC: netflix_email_${uuid}_en`,
  }));
  const withoutSrc = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: body,
  }));

  assert.match(withSrc.deliveryFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(withoutSrc.deliveryFingerprint, "");
  const shared = withSrc.requestEvidence.filter((value) => withoutSrc.requestEvidence.includes(value));
  assert.ok(shared.some((value) => value.startsWith("content-sha256:")));
});

test("preserves the complete Netflix travel verify URL from the Traditional Chinese template", async () => {
  const expected = "https://www.netflix.com/account/travel/verify?token=ANHP9mtXT1FUDR57mCB9262dhhIEz25Ia-3lCLb5WFU&flow=travel_verification&locale=zh-TW";
  const parsed = await parseNetflixEmail(mime({
    subject: "你的暫時存取碼",
    text: "你的暫時存取碼已由 member@codes.liumeiti.vip 於新裝置提出申請。請選擇取得存取碼。",
    html: `<html lang="zh-TW"><body><p>你的暫時存取碼已提出申請</p><a href="${expected.replaceAll("&", "&amp;")}">取得存取碼</a></body></html>`,
  }));
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "link");
  assert.equal(parsed.value, expected);
  assert.equal(parsed.language, "zh-TW");
});

test("accepts an exact relative travel verify path and resolves it to Netflix", async () => {
  const parsed = await parseNetflixEmail(mime({
    subject: "Your temporary access code",
    text: "Get your code to sign in.",
    html: '<html lang="en"><body><a href="/account/travel/verify?token=long-safe-token_123">Get code</a></body></html>',
  }));
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "link");
  assert.equal(parsed.value, "https://www.netflix.com/account/travel/verify?token=long-safe-token_123");
});

test("does not return a travel link that exists only in quoted HTML history", async () => {
  const oldLink = "https://www.netflix.com/account/travel/verify?token=old-request-token&locale=en-US";
  const parsed = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in request",
    text: "Netflix could not display a supported action in this message.",
    html: `<html><body><p>Netflix could not display a supported action in this message.</p><p>Quoted earlier Netflix message:</p><a href="${oldLink}">Get code</a></body></html>`,
  }));
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.value, undefined);
});

test("does not return a household link that exists only in quoted HTML history", async () => {
  const oldLink = "https://www.netflix.com/account/update-primary-location?nftoken=old-household-token&operation=update";
  const parsed = await parseNetflixEmail(mime({
    subject: "Netflix household request",
    text: "Netflix could not display a supported action in this message.",
    html: `<html><body><p>Netflix could not display a supported action in this message.</p><p>Quoted previous Netflix mail:</p><a href="${oldLink}">Confirm household</a></body></html>`,
  }));
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.value, undefined);
});

test("rejects six-digit codes and non-login account actions", async () => {
  const sixDigits = await parseNetflixEmail(mime({
    subject: "Netflix verification code",
    text: "Your verification code is 123456.",
  }));
  assert.equal(sixDigits.accepted, false);
  assert.equal(sixDigits.reason, "six_digit_rejected");

  const reset = await parseNetflixEmail(mime({
    subject: "Reset your Netflix password",
    text: "Reset password",
    html: '<a href="https://www.netflix.com/password?token=secret">Get code</a>',
  }));
  assert.equal(reset.accepted, false);
  assert.equal(reset.reason, "supported_content_not_found");
});

test("rejects lookalike domains and similar Netflix paths", async () => {
  assert.equal(netflixParserInternals.trustedNetflixUrl("https://netflix.com.evil.example/account/travel/verify?token=x"), null);
  const parsed = await parseNetflixEmail(mime({
    subject: "Your temporary access code",
    text: "Get your code",
    html: '<a href="https://www.netflix.com/account/travel/verify-reset?token=x">Get code</a>',
  }));
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "supported_content_not_found");
});

test("recognizes a forwarded multilingual Netflix message", async () => {
  const parsed = await parseNetflixEmail(mime({
    from: "Mailbox forwarder <forwarder@example.com>",
    to: "netflix@codes.liumeiti.vip",
    subject: "Fwd: Código de inicio de sesión de Netflix",
    text: [
      "From: Netflix <info@account.netflix.com>",
      "To: cuenta.netflix@example.es",
      "Tu código de inicio de sesión de Netflix es 7314.",
    ].join("\n"),
  }));
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "7314");
  assert.ok(parsed.accountEmails.includes("cuenta.netflix@example.es"));
});

test("indexes the original Netflix account from an Outlook-forwarded membership footer", async () => {
  const account = "customer@example.es";
  const parsed = await parseNetflixEmail(mime({
    from: "Netflix <info@account.netflix.com>",
    to: "netflix@codes.liumeiti.vip",
    subject: "Netflix: Your sign-in code",
    text: [
      "Enter this code to sign in",
      "8653",
      "Enter the code above on your device to sign in to Netflix. This code will expire in 15 minutes.",
      `This message was mailed to ${account} by Netflix as part of your Netflix membership.`,
    ].join("\n"),
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "8653");
  assert.ok(parsed.accountEmails.includes(account));
  assert.ok(!parsed.accountEmails.includes("netflix@codes.liumeiti.vip"));
});

test("matches the real Outlook Netflix template and original-recipient header", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const parsed = await parseNetflixEmail(mime({
    to: "netflix@codes.liumeiti.vip",
    subject: "Netflix: Your sign-in code",
    extraHeaders: [`X-Original-To: ${account}`],
    text: [
      "Enter this code to sign in",
      "3322",
      "Enter the code above on your device to sign in to Netflix.",
      "This code will expire in 15 minutes.",
    ].join("\n"),
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "3322");
  assert.ok(parsed.accountEmails.includes(account));
  assert.ok(!parsed.accountEmails.includes("netflix@codes.liumeiti.vip"));
});

test("does not mistake the Netflix SRC reference for a six-digit security code", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const parsed = await parseNetflixEmail(mime({
    to: "netflix@codes.liumeiti.vip",
    subject: "Netflix: Your sign-in code",
    text: [
      "Enter this code to sign in",
      "3322",
      "Enter the code above on your device to sign in to Netflix.",
      "This code will expire in 15 minutes.",
      `This message was mailed to ${account} by Netflix as part of your Netflix membership.`,
      "SRC: 653956AC_aebc4b04-b480-42f1-b3a0-37bbe5d7ba6e_en_ES_EVO",
    ].join("\n"),
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "3322");
  assert.ok(parsed.accountEmails.includes(account));
});

test("matches Outlook forwarding headers and ignores unrelated six-digit tracking values", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const parsed = await parseNetflixEmail(mime({
    to: "netflix@codes.liumeiti.vip",
    subject: "Netflix: Your sign-in code",
    extraHeaders: [
      `X-To: ${account}`,
      `X-MS-Exchange-Inbox-Rules-Loop: ${account}`,
      `Resent-From: <${account}>`,
    ],
    text: [
      "Enter this code to sign in",
      "3322",
      "Enter the code above on your device to sign in to Netflix.",
      "This code will expire in 15 minutes.",
      "Internal forwarding reference 653956",
    ].join("\n"),
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "3322");
  assert.ok(parsed.accountEmails.includes(account));
  assert.ok(!parsed.accountEmails.some((email) => email.endsWith("@codes.liumeiti.vip")));
});

test("retains the original account when rejecting a six-digit message", async () => {
  const account = "member@gmail.com";
  const parsed = await parseNetflixEmail(mime({
    to: "netflix@codes.liumeiti.vip",
    subject: "Netflix verification code",
    extraHeaders: [`X-Original-To: ${account}`],
    text: "Your verification code is 123456.",
  }), {
    from: "info@account.netflix.com",
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "six_digit_rejected");
  assert.ok(parsed.accountEmails.includes(account));
  assert.ok(parsed.receivedAt);
});

test("parses an Outlook forwarded EML attachment with visually separated digits", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const parsed = await parseNetflixEmail(outlookForwardedEml({ account, code: "8653" }), {
    from: account,
    to: "netflix@codes.liumeiti.vip",
    inboxAddress: "netflix@codes.liumeiti.vip",
  });

  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "8653");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("does not truncate a visually separated six-digit code into four digits", async () => {
  const parsed = await parseNetflixEmail(mime({
    subject: "Netflix verification code",
    text: "Enter this code to sign in: 1 2 3 4 5 6",
  }));

  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "six_digit_rejected");
});
