import test from "node:test";
import assert from "node:assert/strict";
import { parseNetflixEmail } from "../app/api/netflix-code/_parser.js";

const INBOX = "netflix@codes.liumeiti.vip";
const ACCOUNT = "hasnaaabbassi@outlook.com";
const NL = "\r\n";

// A real temporary-access token: unencoded "/" and "+" inside the query, no
// percent-escaping. Netflix sends it exactly like this.
const TOKEN = "BgiQvuvcAxLCAf5EUre3mTXFFFy9E0oplIIB7/uJUl6YF2Ph3ktDEqjYJyy6Q5VR6+qlfClb6dKW"
  + "fXVPffebRnQNwyYlg/W8mI1jtgWyD4rtKHKh9+1tFrmjBrxvFvGUyODU+4481yj4XJl4ZGFPhnBKYry5TIhkeF/2BN8Z"
  + "+ugkKpw3doEs557fR+kU5W9RqrlcR/eqcpnp+QoGg6MGct1RQBXqX9S8+hgjvg56aIfWizdMAvwUPT/pOYoXE9nmSSEl"
  + "O0XFP0KsDcfYGAYiDgoMbnUNeJeZRpDMTtCv";
const GUID = "22bbf69d-f55e-4050-b389-3896a1ab6e63";
const TRAVEL_URL = `https://www.netflix.com/account/travel/verify?nftoken=${TOKEN}&messageGuid=${GUID}`;

// Netflix's multipart/alternative pair. The plain-text alternative prints the
// URL inside square brackets, the HTML one repeats it as an anchor href with
// entity-escaped ampersands. Both describe the same single delivery.
function travelMail({
  from = "Netflix <info@account.netflix.com>",
  to = ACCOUNT,
  subject = "您的 Netflix 临时访问代码",
  url = TRAVEL_URL,
  textPrefix = [],
  htmlPrefix = "",
} = {}) {
  const boundary = "----=_Part_7043224_1735528292.1786592922851";
  const text = [
    ...textPrefix,
    "您的临时访问代码",
    "",
    "我们收到了下列设备的临时访问代码请求。",
    "",
    "获取代码",
    `[${url}]`,
    "",
    "*链接将于 15 分钟后失效。",
    "",
    `此消息由 Netflix 发送至 [${ACCOUNT}]。`,
    `SRC: 631FD17F_${GUID}_zh-CN_ES_EVO`,
  ].join(NL);
  const html = `<html lang="zh-CN"><body>${htmlPrefix}`
    + "<p>我们收到了下列设备的临时访问代码请求。</p>"
    + `<p><a href="${url.replaceAll("&", "&amp;")}">获取代码</a></p>`
    + "<p>*链接将于 15 分钟后失效。</p>"
    + `<p>SRC: 631FD17F_${GUID}_zh-CN_ES_EVO</p>`
    + "</body></html>";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <010f019ff93c8ce9@us-east-2.amazonses.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join(NL);
}

function parse(raw, from = "info@account.netflix.com") {
  return parseNetflixEmail(raw, {
    from,
    to: INBOX,
    inboxAddress: INBOX,
    receivedAt: "2026-08-13T03:48:45.000Z",
  });
}

test("the plain-text bracket around a link does not make one delivery look like two", async () => {
  const result = await parse(travelMail());
  assert.equal(result.accepted, true);
  assert.equal(result.kind, "link");
  // The user has to click this. It must survive byte for byte: an escaped
  // bracket or a truncated token produces a Netflix page that refuses to
  // issue the temporary code.
  assert.equal(result.value, TRAVEL_URL);
  assert.ok(!result.value.includes("%5D"), "trailing bracket must not be encoded into the URL");
});

test("a forwarded copy whose header collapsed onto one line still returns the link", async () => {
  // Outlook rule-forwards prepend a header block. Some clients flatten it so
  // the line starts with the separator rather than a header label, which is
  // exactly when the forwarded date reaches the code extractor.
  const flattened = "________________________________ 发件人: Netflix <info@account.netflix.com>"
    + " 发送时间: 2026年8月13日 11:48 收件人: netflix@codes.liumeiti.vip"
    + " 主题: 您的 Netflix 临时访问代码";
  const result = await parse(
    travelMail({
      from: ACCOUNT,
      to: INBOX,
      subject: "转发: 您的 Netflix 临时访问代码",
      textPrefix: [flattened, ""],
      htmlPrefix: `<div>${flattened}</div>`,
    }),
    ACCOUNT,
  );
  assert.equal(result.accepted, true, `expected the link, got ${result.reason}`);
  assert.equal(result.kind, "link", `forwarded date must not be returned as a code (${result.value})`);
  assert.equal(result.value, TRAVEL_URL);
});

test("a sign-in code that reads like a year is still a code", async () => {
  // The date guard needs both signals. A standalone 2026 in a login-code
  // email carries no date wording around it and stays a valid code.
  const mail = [
    "From: Netflix <info@account.netflix.com>",
    `To: ${ACCOUNT}`,
    "Subject: Netflix: 你的登录码",
    "Message-ID: <code@amazonses.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "你的登录码",
    "",
    "2026",
    "",
    "请在 15 分钟内输入此代码。",
    `SRC: 6317B35C_${GUID}_zh-CN_ES_EVO`,
    "",
  ].join(NL);
  const result = await parse(mail);
  assert.equal(result.kind, "code");
  assert.equal(result.value, "2026");
});

test("two different temporary-access tokens in one delivery are refused", async () => {
  // Same path, genuinely different signed requests: returning either one could
  // hand a customer the code for somebody else's sign-in attempt.
  const second = `https://www.netflix.com/account/travel/verify?nftoken=OTHER${TOKEN.slice(5)}&messageGuid=${GUID}`;
  const raw = travelMail().replace(
    "<p>*链接将于 15 分钟后失效。</p>",
    `<p><a href="${second.replaceAll("&", "&amp;")}">获取代码</a></p>`,
  );
  const result = await parse(raw);
  assert.notEqual(result.kind, "link");
});
