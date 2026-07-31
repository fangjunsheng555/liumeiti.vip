import test from "node:test";
import assert from "node:assert/strict";
import { parseNetflixEmail, netflixParserInternals } from "../app/api/netflix-code/_parser.js";

function mime({ from = "Netflix <info@account.netflix.com>", to = "member@codes.liumeiti.vip", subject = "Netflix", text = "", html = "" }) {
  const boundary = "----maoyang-netflix-test";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
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

test("parses a direct four-digit Netflix sign-in code for a subdomain account", async () => {
  const parsed = await parseNetflixEmail(mime({
    subject: "Your Netflix sign-in code",
    text: "Use this login code to sign in to Netflix: 4827. It expires in 15 minutes.",
  }));
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "4827");
  assert.deepEqual(parsed.accountEmails, ["member@codes.liumeiti.vip"]);
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
