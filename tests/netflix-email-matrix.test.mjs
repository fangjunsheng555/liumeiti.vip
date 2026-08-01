import test from "node:test";
import assert from "node:assert/strict";
import { parseNetflixEmail } from "../app/api/netflix-code/_parser.js";

const INBOX = "netflix@codes.liumeiti.vip";

function htmlMime({
  account = "member@example.com",
  from = "Netflix <info@account.netflix.com>",
  subject = "Netflix",
  lang = "en",
  body = "",
  encoding = "8bit",
  headers = [],
}) {
  const html = `<html lang="${lang}"><body>${body}</body></html>`;
  const content = encoding === "base64"
    ? Buffer.from(html).toString("base64").match(/.{1,76}/g).join("\r\n")
    : html;
  return [
    `From: ${from}`,
    `To: ${account}`,
    `Subject: ${subject}`,
    ...headers,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    "",
    content,
    "",
  ].join("\r\n");
}

function quotedPrintable(value) {
  return Array.from(Buffer.from(String(value || "")))
    .map((byte) => (byte === 0x0a ? "\n" : byte === 0x0d ? "\r" : byte >= 33 && byte <= 126 && byte !== 61 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
}

function textMime({ account = "member@example.com", subject, body, encoding = "8bit" }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  return [
    "From: Netflix <info@account.netflix.com>",
    `To: ${account}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    "",
    encoding === "quoted-printable" ? quotedPrintable(body) : body,
    "",
  ].join("\r\n");
}

function outlookForward({ account, subject, lang, body, attachmentType = "message/rfc822" }) {
  const original = htmlMime({ account, subject, lang, body });
  const boundary = "----outlook-netflix-forward";
  return [
    `From: ${account}`,
    `To: ${INBOX}`,
    `Subject: Fwd: ${subject}`,
    `X-MS-Exchange-Inbox-Rules-Loop: ${account}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Forwarded message",
    `--${boundary}`,
    `Content-Type: ${attachmentType}; name="Netflix.eml"`,
    "Content-Disposition: attachment; filename=Netflix.eml",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(original).toString("base64").match(/.{1,76}/g).join("\r\n"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

const languageCases = [
  ["en", "Netflix: Your sign-in code", "Enter this code to sign in", "This code will expire in 15 minutes."],
  ["es", "Netflix: Tu código de inicio de sesión", "Introduce este código de inicio de sesión", "Este código caduca en 15 minutos."],
  ["pl", "Netflix: Twój kod logowania", "Wprowadź ten kod logowania", "Kod wygaśnie za 15 minut."],
  ["zh-CN", "Netflix 登录验证码", "输入此登录验证码", "验证码将在 15 分钟后失效。"],
  ["zh-TW", "Netflix 登入驗證碼", "輸入此登入驗證碼", "此驗證碼將於 15 分鐘後失效。"],
  ["ja", "Netflix ログインコード", "このログインコードを入力してください", "コードは 15 分後に期限切れになります。"],
  ["ko", "Netflix 로그인 코드", "이 로그인 코드를 입력하세요", "코드는 15분 후에 만료됩니다."],
  ["fr", "Netflix : votre code de connexion", "Saisissez ce code de connexion", "Ce code expire dans 15 minutes."],
  ["de", "Netflix: Dein Anmeldecode", "Gib diesen Anmeldecode ein", "Dieser Code läuft in 15 Minuten ab."],
  ["it", "Netflix: il tuo codice di accesso", "Inserisci questo codice di accesso", "Il codice scade tra 15 minuti."],
  ["pt", "Netflix: seu código de acesso", "Insira este código de acesso", "Este código expira em 15 minutos."],
  ["nl", "Netflix: je inlogcode", "Voer deze inlogcode in", "Deze code verloopt over 15 minuten."],
  ["tr", "Netflix: giriş kodun", "Bu giriş kodunu gir", "Bu kodun süresi 15 dakika içinde dolar."],
  ["id", "Netflix: kode masuk Anda", "Masukkan kode masuk ini", "Kode ini akan kedaluwarsa dalam 15 menit."],
  ["ru", "Netflix: код для входа", "Введите этот код для входа", "Срок действия кода истечет через 15 минут."],
  ["vi", "Netflix: mã đăng nhập", "Nhập mã đăng nhập này", "Mã này sẽ hết hạn sau 15 phút."],
  ["th", "Netflix: รหัสเข้าสู่ระบบ", "ป้อนรหัสเข้าสู่ระบบนี้", "รหัสจะหมดอายุใน 15 นาที"],
  ["ar", "Netflix: رمز تسجيل الدخول", "أدخل رمز تسجيل الدخول هذا", "ستنتهي صلاحية الرمز خلال 15 دقيقة"],
  ["hu", "Netflix bejelentkezési kód", "Írd be ezt a bejelentkezési kódot", "A kód 15 perc múlva lejár."],
];

for (const [lang, subject, lead, tail] of languageCases) {
  test(`parses the ${lang} Netflix four-digit template`, async () => {
    const parsed = await parseNetflixEmail(htmlMime({
      subject,
      lang,
      body: `<h1>${lead}</h1><p><strong>4<span>8</span></strong><span>2</span><b>7</b></p><p>${tail}</p>`,
    }), { from: "info@account.netflix.com", to: INBOX });
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.kind, "code");
    assert.equal(parsed.value, "4827");
  });
}

test("parses the real English layout when HTML splits the code into two groups", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const parsed = await parseNetflixEmail(outlookForward({
    account,
    subject: "Netflix: Your sign-in code",
    lang: "en",
    body: [
      "<h1>Enter this code to sign in</h1>",
      "<p><span>86</span><!-- Outlook separator --><span>&#8202;</span><span>53</span></p>",
      "<p>Enter the code above on your device to sign in to Netflix. This code will expire in 15 minutes.</p>",
      `<p>This message was mailed to <a href="https://www.netflix.com/browse">${account}</a> by Netflix as part of your Netflix membership.</p>`,
      "<p>SRC: 653956AC_aebc4b04-b480-42f1-b3a0-37bbe5d7ba6e_en_ES_EVO</p>",
    ].join(""),
  }), { from: account, to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "8653");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("parses a quoted-printable Polish plain-text delivery", async () => {
  const parsed = await parseNetflixEmail(textMime({
    subject: "Netflix: Twój kod logowania",
    body: "Wprowadź ten kod logowania\r\n71 09\r\nKod wygaśnie za 15 minut.",
    encoding: "quoted-printable",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "7109");
  assert.equal(parsed.language, "pl");
});

test("parses a flattened Outlook English forward with one digit per line", async () => {
  const account = "juandavidsandoval1@outlook.es";
  const raw = textMime({
    account: INBOX,
    subject: "Fwd: Netflix: Your sign-in code",
    body: [
      "From: Netflix <info@account.netflix.com>",
      `To: ${account}`,
      "Enter this code to sign in",
      "8\r\n6\r\n5\r\n3",
      "Enter the code above on your device to sign in to Netflix.",
      "This code will expire in 15 minutes.",
    ].join("\r\n"),
  });
  const parsed = await parseNetflixEmail(raw, { from: account, to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "8653");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("parses a base64 English Netflix HTML body", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix: Your sign-in code",
    encoding: "base64",
    body: "<h1>Enter this code to sign in</h1><p>7&nbsp;3<span>1</span>4</p><p>This code expires in 15 minutes.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.value, "7314");
});

test("accepts a valid sign-in code that looks like a calendar year", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix: Your sign-in code",
    body: "<h1>Enter this code to sign in</h1><p>2026</p><p>This code expires in 15 minutes.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.value, "2026");
});

test("normalizes Outlook Unicode hyphens and named zero-width entities", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix: Your sign‑in code",
    body: "<h1>Enter this code to sign<span> -in</span></h1><p>8&zwnj;6&zwnj;5&zwnj;3</p><p>Expires in 15 minutes.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.value, "8653");
});

test("parses a Hungarian Netflix template through explicit localized wording", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix bejelentkezési kód",
    lang: "hu",
    body: "<h1>Írd be ezt a kódot</h1><p><span>24</span> <span>68</span></p><p>A kód 15 perc múlva lejár.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "2468");
});

test("unwraps only an Outlook Safe Links URL that resolves to the exact Netflix travel path", async () => {
  const netflixUrl = "https://www.netflix.com/account/travel/verify?token=long-safe-token_123&locale=en-US";
  const safeLink = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(netflixUrl)}&data=tracking`;
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Your temporary access code",
    body: `<p>Get your temporary code.</p><a href="${safeLink.replaceAll("&", "&amp;")}">Get your code</a>`,
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.kind, "link");
  assert.equal(parsed.value, netflixUrl);
});

test("parses a message/global Outlook attachment", async () => {
  const parsed = await parseNetflixEmail(outlookForward({
    account: "member@example.jp",
    subject: "Netflix ログインコード",
    lang: "ja",
    body: "<h1>ログインコードを入力</h1><p><span>31</span> <span>46</span></p><p>15 分後に期限切れになります。</p>",
    attachmentType: "message/global",
  }), { from: "member@example.jp", to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.value, "3146");
  assert.deepEqual(parsed.accountEmails, ["member@example.jp"]);
});

test("does not accept a four-digit number from a Netflix newsletter", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "What to watch on Netflix",
    body: "<h1>New this week</h1><p>Use reference 4827 when sharing this newsletter.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "supported_content_not_found");
});

test("does not accept a newsletter merely because it mentions 15 minutes", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix weekly picks",
    body: "<h1>New this week</h1><p>Reference 4827 unlocks a 15 minute preview in this newsletter.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "supported_content_not_found");
});

test("uses the forwarding mailbox as the only account identity", async () => {
  const account = "member.forwarder@outlook.es";
  const parsed = await parseNetflixEmail(outlookForward({
    account,
    subject: "Netflix: Your sign-in code",
    lang: "en",
    body: [
      "<h1>Enter this code to sign in</h1>",
      "<p><span>33</span><span>22</span></p>",
      "<p>This code will expire in 15 minutes.</p>",
      "<p>Unrelated footer address: victim@example.com</p>",
    ].join(""),
  }), { from: account, to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.value, "3322");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("rejects a Safe Links lookalike that is not an Outlook protection host", async () => {
  const netflixUrl = "https://www.netflix.com/account/travel/verify?token=valid-looking-token";
  const unsafe = `https://safelinks.protection.outlook.com.attacker.example/?url=${encodeURIComponent(netflixUrl)}`;
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Your temporary access code",
    body: `<p>Get your temporary code.</p><a href="${unsafe.replaceAll("&", "&amp;")}">Get your code</a>`,
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "supported_content_not_found");
});

test("rejects visually grouped six-digit account-security codes", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix verification code",
    body: "<p>Reset password</p><p><span>12</span> <span>34</span> <span>56</span></p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, false);
  assert.ok(["sensitive_six_digit", "six_digit_rejected"].includes(parsed.reason));
});

test("ignores forwarded header dates when extracting the sign-in code", async () => {
  const parsed = await parseNetflixEmail(textMime({
    account: INBOX,
    subject: "Fwd: Netflix: Tu código de inicio de sesión",
    body: [
      "---------- Forwarded message ---------",
      "De: Netflix <info@account.netflix.com>",
      "Fecha: 01/08/2026",
      "Para: cliente@example.es",
      "Asunto: Netflix: Tu código de inicio de sesión",
      "",
      "Introduce este código de inicio de sesión",
      "8653",
      "Este código caduca en 15 minutos.",
    ].join("\r\n"),
  }), { from: "cliente@example.es", to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "8653");
});

test("ignores a Gmail-style inline date line next to the code", async () => {
  const parsed = await parseNetflixEmail(textMime({
    account: INBOX,
    subject: "Fwd: Netflix 登录验证码",
    body: [
      "Netflix <info@account.netflix.com> 于2026年8月1日周五 上午11:04写道：",
      "输入此登录验证码",
      "7 3 1 4",
      "验证码将在 15 分钟后失效。",
      "此消息由 Netflix 发送至 member@example.com。",
    ].join("\r\n"),
  }), { from: "member@example.com", to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "7314");
});

test("parses a template in a language without dedicated phrase rules", async () => {
  const parsed = await parseNetflixEmail(textMime({
    subject: "Netflix: přihlašovací kód",
    body: "Zadejte tento přihlašovací kód\r\n4827\r\nPlatnost kódu vyprší za 15 minut.",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "code");
  assert.equal(parsed.value, "4827");
});

const householdUrl = "https://www.netflix.com/account/update-primary-location?nftoken=Bgi8u-vcAxLDAaSVJcQO&g=ed904980-22a5-42c4-bc09-1964cb91bbdd&lnktrk=EVO&operation=update&lkid=UPDATE_HOUSEHOLD_REQUESTED_OTP_CTA";

function householdBody(cta, heading, footer) {
  return [
    `<h1>${heading}</h1>`,
    "<p>polly 于7月12日，上午11:25 GMT+2在 Apple TV 上发出请求</p>",
    '<p><a href="https://www.netflix.com/password?g=ed904980&lkid=URL_PASSWORD&nftoken=zz">更改密码</a></p>',
    `<p><a href="${householdUrl.replaceAll("&", "&amp;")}">${cta}</a></p>`,
    "<p>*链接将于 15 分钟后失效。</p>",
    '<p><a href="https://www.netflix.com/ManageAccountAccess?g=ed904980&nftoken=yy">注销您无法识别的所有设备</a></p>',
    `<p>${footer}</p>`,
    "<p>SRC: 6317B35C_ed904980-22a5-42c4-bc09-1964cb91bbdd_zh-CN_ES_EVO</p>",
  ].join("");
}

test("recognizes the Chinese household-update email and returns only the signed CTA link", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    account: "spotifytokyo@hotmail.com",
    subject: "重要提示：如何更新 Netflix 同户设备",
    lang: "zh-CN",
    body: householdBody("是的，是我本人", "是您请求更新 Netflix 同户设备吗？", "此消息由 Netflix 发送至 spotifytokyo@hotmail.com。"),
  }), { from: "info@account.netflix.com", to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "household");
  assert.equal(new URL(parsed.value).pathname, "/account/update-primary-location");
  assert.ok(new URL(parsed.value).searchParams.get("nftoken"));
  assert.equal(parsed.language, "zh-CN");
  assert.ok(parsed.accountEmails.includes("spotifytokyo@hotmail.com"));
});

test("recognizes a forwarded household-update email in an unlisted language", async () => {
  const account = "member.forwarder@outlook.es";
  const parsed = await parseNetflixEmail(outlookForward({
    account,
    subject: "Vigtigt: Sådan opdaterer du din Netflix-husstand",
    lang: "da",
    body: householdBody("Ja, det var mig", "Har du anmodet om at opdatere din Netflix-husstand?", `Denne meddelelse blev sendt til ${account}.`),
  }), { from: account, to: INBOX, inboxAddress: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "household");
  assert.equal(new URL(parsed.value).pathname, "/account/update-primary-location");
  assert.deepEqual(parsed.accountEmails, [account]);
});

test("does not treat a household email as a travel-verify link or a code", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Update your Netflix Household",
    lang: "en",
    body: householdBody("Yes, This Was Me", "Did you request to update your Netflix Household?", "This message was mailed to member@example.com."),
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "household");
  assert.notEqual(parsed.kind, "code");
});

test("rejects an ambiguous Netflix message containing two different four-digit codes", async () => {
  const parsed = await parseNetflixEmail(htmlMime({
    subject: "Netflix: Your sign-in code",
    body: "<p>Enter this code to sign in: 4827</p><p>Previous sign-in code: 7314</p><p>Expires in 15 minutes.</p>",
  }), { from: "info@account.netflix.com", to: INBOX });
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.reason, "ambiguous_code");
});
