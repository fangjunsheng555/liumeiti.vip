import PostalMime from "postal-mime";

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const MAX_NESTED_MESSAGES = 6;

const LANGUAGE_RULES = [
  { code: "zh-CN", hints: ["登录代码", "登录验证码", "临时代码", "临时访问代码", "验证码", "获取代码", "获取验证码"], link: ["获取代码", "获取验证码", "获取访问代码", "查看代码", "取得登录代码"] },
  { code: "zh-TW", hints: ["登入碼", "登入驗證碼", "暫時代碼", "暫時存取碼", "暫時驗證碼", "驗證碼", "取得代碼", "取得驗證碼", "取得存取碼"], link: ["取得存取碼", "取得代碼", "取得驗證碼", "查看代碼", "取得登入碼"] },
  { code: "ja", hints: ["ログインコード", "認証コード", "一時コード", "確認コード"], link: ["コードを取得", "ログインコードを取得", "コードを表示"] },
  { code: "ko", hints: ["로그인 코드", "인증 코드", "임시 코드", "확인 코드"], link: ["코드 받기", "로그인 코드 받기", "코드 확인"] },
  { code: "es", hints: ["código de inicio de sesión", "código de acceso", "código temporal", "código de verificación"], link: ["obtener código", "ver código", "recibir código"] },
  { code: "pt", hints: ["código de login", "código de acesso", "código temporário", "código de verificação"], link: ["obter código", "ver código", "receber código"] },
  { code: "fr", hints: ["code de connexion", "code d’accès", "code temporaire", "code de vérification"], link: ["obtenir le code", "afficher le code", "recevoir le code"] },
  { code: "de", hints: ["anmeldecode", "login-code", "temporärer code", "bestätigungscode"], link: ["code abrufen", "code anzeigen", "code erhalten"] },
  { code: "it", hints: ["codice di accesso", "codice temporaneo", "codice di verifica"], link: ["ottieni codice", "visualizza codice", "ricevi codice"] },
  { code: "nl", hints: ["inlogcode", "tijdelijke code", "verificatiecode"], link: ["code ophalen", "code bekijken", "code ontvangen"] },
  { code: "pl", hints: ["kod logowania", "kod dostępu", "kod tymczasowy", "kod weryfikacyjny"], link: ["pobierz kod", "wyświetl kod", "otrzymaj kod"] },
  { code: "tr", hints: ["giriş kodu", "geçici kod", "doğrulama kodu"], link: ["kodu al", "kodu görüntüle"] },
  { code: "id", hints: ["kode masuk", "kode login", "kode sementara", "kode verifikasi"], link: ["dapatkan kode", "lihat kode"] },
  { code: "th", hints: ["รหัสเข้าสู่ระบบ", "รหัสชั่วคราว", "รหัสยืนยัน"], link: ["รับรหัส", "ดูรหัส"] },
  { code: "ar", hints: ["رمز تسجيل الدخول", "الرمز المؤقت", "رمز التحقق"], link: ["الحصول على الرمز", "عرض الرمز"] },
  { code: "ru", hints: ["код для входа", "временный код", "код подтверждения"], link: ["получить код", "показать код"] },
  { code: "vi", hints: ["mã đăng nhập", "mã tạm thời", "mã xác minh"], link: ["nhận mã", "xem mã"] },
  { code: "hu", hints: ["bejelentkezési kód", "ideiglenes kód", "ellenőrző kód"], link: ["kód lekérése", "kód megtekintése"] },
  { code: "en", hints: ["login code", "sign-in code", "sign in code", "access code", "temporary code", "verification code", "enter this code to sign in", "enter the code above"], link: ["get code", "get your code", "view code", "receive code", "get temporary code"] },
];

// Netflix localizes templates into more languages than the phrase list above.
// A short "code" word stem close to the digits is language-agnostic evidence
// that the digits are the sign-in code and not a reference number.
const CODE_WORD_STEMS = [
  "code", "código", "codigo", "codice", "kod", "kode", "kód", "koodi",
  "код", "κωδικ", "קוד", "رمز", "कोड",
  "コード", "코드", "验证码", "登录代码", "代码", "驗證碼", "登入碼", "代碼",
  "mã", "รหัส",
];

// Display-only hints so household-update emails keep a useful language label.
const HOUSEHOLD_HINTS = {
  "zh-CN": ["同户设备", "是的，是我本人"],
  "zh-TW": ["同戶裝置", "是的，是我"],
  en: ["netflix household", "yes, this was me", "update your netflix household"],
  es: ["hogar con netflix", "sí, la envié yo"],
  pt: ["residência netflix", "sim, fui eu"],
  fr: ["foyer netflix", "oui, c'était moi"],
  de: ["netflix-haushalt", "ja, ich war das"],
  it: ["nucleo domestico", "sì, sono stato io"],
  ja: ["netflix世帯", "はい、私です"],
  ko: ["넷플릭스 이용 가구", "네, 본인이 맞습니다"],
};

const SENSITIVE_CONTEXT = [
  "password reset", "reset password", "change password", "email change", "change email",
  "payment method", "billing", "subscription change", "cancel membership", "profile transfer",
  "重置密码", "更改密码", "修改密码", "更改邮箱", "修改邮箱", "付款方式", "账单", "取消会员",
  "重設密碼", "更改密碼", "變更電子郵件", "付款方式", "帳單",
  "パスワードをリセット", "メールアドレスを変更", "支払い方法",
  "비밀번호 재설정", "이메일 변경", "결제 수단",
];

const SENSITIVE_PATH = /(password|reset|email-change|change-email|payment|billing|cancel|profile-transfer|manage-plan)/i;

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(zwnj|zwj|shy|thinsp|ensp|emsp|hairsp|zerowidthspace);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => {
      const code = Number.parseInt(value, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#(\d+);/g, (_, value) => {
      const code = Number.parseInt(value, 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    });
}

function normalizeSearchText(value) {
  return normalizeDigits(decodeEntities(value))
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Keep newlines only at real block boundaries so digits from neighbouring
// blocks (the code and the "15 minutes" expiry, footer years, dates) can never
// merge into one run. Source-formatting newlines inside the HTML are noise.
function htmlToText(value) {
  return decodeEntities(value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|td|th|tr|table|thead|tbody|tfoot|li|ul|ol|h[1-6]|blockquote|section|article|header|footer|main)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function addressValues(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const row of rows) {
    if (row?.address) out.push(String(row.address).toLowerCase());
    if (Array.isArray(row?.group)) out.push(...addressValues(row.group));
  }
  return out;
}

function emailsIn(value) {
  return (String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map((email) => email.toLowerCase());
}

function isNetflixAddress(email) {
  const domain = String(email || "").split("@")[1] || "";
  return domain === "netflix.com" || domain.endsWith(".netflix.com");
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function parseMessages(raw) {
  const root = await PostalMime.parse(raw, { attachmentEncoding: "arrayBuffer" });
  const messages = [root];
  const queue = [...(root.attachments || [])];
  while (queue.length && messages.length < MAX_NESTED_MESSAGES) {
    const attachment = queue.shift();
    if (!attachment?.content) continue;
    const mimeType = String(attachment.mimeType || "").toLowerCase();
    const filename = String(attachment.filename || "").toLowerCase();
    const bytes = Buffer.from(attachment.content);
    const headerPreview = bytes.subarray(0, Math.min(bytes.length, 16 * 1024)).toString("utf8");
    const looksLikeMessage = /^message\/(rfc822|global)/i.test(mimeType)
      || filename.endsWith(".eml")
      || (/^(?:from|to|subject|mime-version|content-type):/im.test(headerPreview)
        && /\r?\n\r?\n/.test(headerPreview));
    if (!looksLikeMessage) continue;
    try {
      const nested = await PostalMime.parse(bytes, { attachmentEncoding: "arrayBuffer" });
      messages.push(nested);
      queue.push(...(nested.attachments || []));
    } catch {}
  }
  return messages;
}

function detectLanguage(text, html) {
  const lower = normalizeSearchText(text);
  let best = { code: "en", score: 0 };
  for (const rule of LANGUAGE_RULES) {
    const phrases = [...rule.hints, ...rule.link, ...(HOUSEHOLD_HINTS[rule.code] || [])];
    const score = phrases.reduce((sum, phrase) => sum + (lower.includes(normalizeSearchText(phrase)) ? 1 : 0), 0);
    if (score > best.score) best = { code: rule.code, score };
  }
  if (best.score > 0) return best.code;

  const langs = Array.from(String(html || "").matchAll(/<html[^>]+lang=["']?([^"'\s>]+)/gi))
    .map((match) => String(match[1] || "").toLowerCase())
    .reverse();
  for (const lang of langs) {
    if (lang.startsWith("zh-tw") || lang.startsWith("zh-hk") || lang.startsWith("zh-hant")) return "zh-TW";
    if (lang.startsWith("zh")) return "zh-CN";
    const languageMatch = LANGUAGE_RULES.find((rule) => lang.startsWith(rule.code.toLowerCase().split("-")[0]));
    if (languageMatch) return languageMatch.code;
  }
  return "en";
}

function hasNearbyPhrase(text, index, phrases, distance = 190) {
  const start = Math.max(0, index - distance);
  const end = Math.min(text.length, index + distance);
  const window = normalizeSearchText(text.slice(start, end));
  return phrases.some((phrase) => window.includes(normalizeSearchText(phrase)));
}

// Separators Netflix templates place between visually spaced code digits.
const INLINE_SEPARATOR = "[ \\t\\u00a0\\u00ad\\u2000-\\u200f\\u202f\\u205f\\u2060\\u3000\\ufeff]";
const DIGIT_GROUP_PATTERN = new RegExp(`\\d(?:${INLINE_SEPARATOR}{0,4}\\d)*`, "g");
const DIGIT_ONLY_LINE_PATTERN = new RegExp(`^(?:\\d|${INLINE_SEPARATOR})+$`);

// Lines that are forwarded/quoted mail headers (From/Sent/Date/Subject in the
// languages of common mail clients). Digits on these lines are dates or ids,
// never the sign-in code.
const FORWARD_HEADER_LINE = new RegExp(
  "^\\s*(?:"
  + "(?:from|to|cc|bcc|date|sent|subject|reply-to|de|da|para|an|von|gesendet|datum|betreff|enviado|enviada|fecha|asunto|envoyé|envoye|objet|inviato|oggetto|data|verzonden|aan|onderwerp|od|do|wysłano|wyslano|temat|от|кому|отправлено|дата|тема|보낸 사람|받는 사람|날짜|제목)\\b[^:：\\n]{0,16}"
  + "|(?:发件人|收件人|抄送|日期|发送时间|主题|寄件者|收件者|寄件日期|主旨|差出人|宛先|送信日時|件名)[^:：\\n]{0,4}"
  + ")\\s*[:：]", "i");

// Date/time wording immediately around a digit run. Used only to break ties
// between multiple candidates, so an approximate month list is safe.
const DATE_CONTEXT_PATTERN = new RegExp(
  "[年月日]|\\bgmt\\b|\\butc\\b|\\d{1,2}[:]\\d{2}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}"
  + "|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec|ene|abr|ago|dic|janv|févr|avr|mai|juin|juil|août|déc|mär|okt|dez|gen|mag|giu|lug|set|ott|mrt|mei|sty|lut|kwi|maj|cze|lip|sie|wrz|paź|lis|gru|oca|şub|nis|haz|tem|ağu|eyl|eki|kas|ara|янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)[a-zà-ÿ]*\\.?\\b",
  "i");

function boundedLineGroups(line, lineStart) {
  const groups = [];
  for (const match of line.matchAll(DIGIT_GROUP_PATTERN)) {
    const previous = line[match.index - 1] || "";
    const next = line[match.index + match[0].length] || "";
    if (/[A-Za-z0-9]/.test(previous) || /[A-Za-z0-9]/.test(next)) continue;
    groups.push({ value: match[0].replace(/\D/g, ""), index: lineStart + match.index, line });
  }
  return groups;
}

// Digit runs, extracted per line. Consecutive lines that contain nothing but
// digits are joined so flattened forwards with one digit (or digit pair) per
// line still form one code. Runs never cross a line with any other content.
function extractDigitRuns(text) {
  const runs = [];
  let pending = null;
  let offset = 0;
  const flush = () => {
    if (pending) runs.push(pending);
    pending = null;
  };
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    const groups = boundedLineGroups(line, offset);
    if (trimmed && DIGIT_ONLY_LINE_PATTERN.test(trimmed) && groups.length === 1) {
      if (pending) pending.value += groups[0].value;
      else pending = { ...groups[0] };
    } else {
      flush();
      runs.push(...groups);
    }
    offset += line.length + 1;
  }
  flush();
  return runs;
}

function withoutUrls(text) {
  return String(text || "")
    .replace(/https:\/\/[^\s<>"']+/gi, " ")
    .replace(/\/account\/travel\/verify\?[^\s<>"']+/gi, " ");
}

// Netflix repeats its delivery UUID in visible footer metadata (for example
// `SRC: ..._f73ec386-ca05-4d35-9317-dce0338b88c3_...`). A numeric UUID block
// such as `9317` is not a sign-in code, even when the footer is close to the
// localized "code" copy in a compact or forwarded message.
function withoutTrackingIdentifiers(text) {
  return String(text || "").replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    " ",
  );
}

function anchorLinks(html) {
  const links = [];
  const source = String(html || "");
  for (const match of source.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const index = match.index || 0;
    links.push({
      url: decodeEntities(match[2]),
      context: htmlToText(source.slice(Math.max(0, index - 240), Math.min(source.length, index + match[0].length + 240))),
      anchor: htmlToText(match[3]),
    });
  }
  return links;
}

function textLinks(text) {
  const source = String(text || "");
  return Array.from(source.matchAll(/https:\/\/[^\s<>"']+/gi)).map((match) => ({
    url: decodeEntities(match[0]).replace(/[),.;]+$/, ""),
    context: source.slice(Math.max(0, (match.index || 0) - 220), Math.min(source.length, (match.index || 0) + match[0].length + 220)),
    anchor: "",
  }));
}

function trustedNetflixUrl(value) {
  try {
    let raw = decodeEntities(value).trim();
    let url = raw.startsWith("/")
      ? new URL(raw, "https://www.netflix.com")
      : new URL(raw);
    const redirectHost = url.hostname.toLowerCase();
    if (redirectHost === "safelinks.protection.outlook.com" || redirectHost.endsWith(".safelinks.protection.outlook.com")) {
      raw = String(url.searchParams.get("url") || "").trim();
      if (!raw) return null;
      url = new URL(raw);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "netflix.com" || host.endsWith(".netflix.com"))) return null;
    if (url.username || url.password || SENSITIVE_PATH.test(url.pathname)) return null;
    return url.toString();
  } catch { return null; }
}

function collectNetflixLinks(html, text) {
  const links = unique([...anchorLinks(html), ...textLinks(text)].map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
  const out = [];
  for (const link of links) {
    const url = trustedNetflixUrl(link.url);
    if (!url) continue;
    const parsed = new URL(url);
    out.push({
      ...link,
      url,
      path: parsed.pathname.replace(/\/+$/, "").toLowerCase(),
      params: parsed.searchParams,
    });
  }
  return out;
}

// The travel-verify link is identified by its exact path plus either a signed
// token or localized "get code" wording, so unlisted languages still work.
function travelVerifyLink(links) {
  const matches = [];
  for (const link of links) {
    if (link.path !== "/account/travel/verify") continue;
    const context = normalizeSearchText(`${link.anchor} ${link.context}`);
    if (SENSITIVE_CONTEXT.some((phrase) => context.includes(normalizeSearchText(phrase)))) continue;
    const phraseMatch = LANGUAGE_RULES.some((rule) => rule.link.some((phrase) => context.includes(normalizeSearchText(phrase))));
    const hasToken = link.params.has("token") || link.params.has("nftoken");
    if (phraseMatch || hasToken) matches.push(link.url);
  }
  const distinct = unique(matches);
  return distinct.length === 1 ? distinct[0] : "";
}

// Household-update ("update primary location") confirmation emails carry one
// signed CTA link. The path plus nftoken identify it in every language, so no
// anchor-text matching is needed.
function householdUpdateLink(links) {
  const matches = links.filter((link) => link.path === "/account/update-primary-location" && link.params.has("nftoken"));
  if (!matches.length) return "";
  const preferred = matches.find((link) => String(link.params.get("lkid") || "").toUpperCase().includes("UPDATE_HOUSEHOLD"))
    || matches.find((link) => String(link.params.get("operation") || "").toLowerCase() === "update")
    || matches[0];
  return preferred.url;
}

function forwardedHeaderAddresses(text) {
  const lines = String(text || "").split(/\r?\n/);
  const labels = /^(from|to|de|para|von|an|da|a|发件人|寄件者|收件人|收件者|差出人|宛先|보낸 사람|받는 사람|от|кому)\s*:/i;
  return lines.filter((line) => labels.test(line.trim())).flatMap(emailsIn);
}

function originalRecipientHeaders(raw) {
  let source = "";
  try {
    source = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  } catch { return []; }
  const headerBlock = source.split(/\r?\n\r?\n/, 1)[0]
    .replace(/\r?\n[ \t]+/g, " ");
  const labels = /^(to|cc|bcc|delivered-to|x-to|x-original-to|x-originally-to|x-original-recipient|x-forwarded-to|x-envelope-to|resent-to|resent-from|original-recipient|x-ms-exchange-inbox-rules-loop|x-ms-exchange-organization-originalto)\s*:/i;
  return headerBlock.split(/\r?\n/)
    .filter((line) => labels.test(line.trim()))
    .flatMap(emailsIn);
}

function isInfrastructureAddress(email) {
  const value = String(email || "").toLowerCase();
  const [local, domain = ""] = value.split("@");
  return !local || !domain
    || domain === "amazonses.com"
    || domain.endsWith(".amazonses.com")
    || domain === "cloudflare.net"
    || domain.endsWith(".cloudflare.net")
    || ["mailer-daemon", "postmaster", "no-reply", "noreply"].includes(local);
}

function isYearLike(value) {
  const number = Number(value);
  return number >= 1990 && number <= 2099;
}

function dateLikeRun(codeText, run) {
  const start = Math.max(0, run.index - 26);
  const end = Math.min(codeText.length, run.index + run.value.length + 30);
  const before = codeText.slice(start, run.index);
  const after = codeText.slice(run.index + run.value.length, end);
  return DATE_CONTEXT_PATTERN.test(before) || DATE_CONTEXT_PATTERN.test(after);
}

export async function parseNetflixEmail(raw, envelope = {}) {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : Number(raw?.byteLength || raw?.length || 0);
  if (!bytes || bytes > MAX_RAW_BYTES) return { accepted: false, reason: "invalid_size" };
  let messages;
  try { messages = await parseMessages(raw); } catch { return { accepted: false, reason: "mime_parse_failed" }; }

  const subjects = messages.map((message) => message.subject || "").filter(Boolean);
  const html = messages.map((message) => message.html || "").filter(Boolean).join("\n");
  const plain = messages.map((message) => message.text || htmlToText(message.html || "")).filter(Boolean).join("\n");
  const text = normalizeDigits(`${subjects.join("\n")}\n${plain}\n${htmlToText(html)}`).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  const structuredFrom = messages.flatMap((message) => addressValues(message.from));
  const structuredRecipients = messages.flatMap((message) => [
    ...addressValues(message.to), ...addressValues(message.cc), ...addressValues(message.bcc), ...addressValues(message.replyTo),
  ]);
  const forwarded = forwardedHeaderAddresses(plain);
  const originalRecipients = originalRecipientHeaders(raw);
  // Outlook and other providers may flatten an automatically forwarded email
  // and leave the original Netflix account only in the membership footer.
  const bodyAddresses = [...emailsIn(plain), ...emailsIn(htmlToText(html))];
  const envelopeFromAddresses = emailsIn(envelope.from);
  const envelopeAddresses = [...envelopeFromAddresses, ...emailsIn(envelope.to), ...emailsIn(envelope.inboxAddress)];
  const routingRecipients = new Set([...emailsIn(envelope.to), ...emailsIn(envelope.inboxAddress)]);
  const allAddresses = unique([
    ...structuredFrom,
    ...structuredRecipients,
    ...forwarded,
    ...originalRecipients,
    ...bodyAddresses,
    ...envelopeAddresses,
  ]);
  const netflixSender = unique([...structuredFrom, ...forwarded, ...emailsIn(plain.slice(0, 3000))]).find(isNetflixAddress) || "";
  if (!netflixSender) return { accepted: false, reason: "untrusted_sender" };

  // The dedicated codes subdomain is only an inbound route. Never index one of
  // its aliases as a Netflix account when a forwarding provider omits the SMTP
  // envelope recipient from the webhook headers.
  let accountEmails = allAddresses.filter((email) => {
    const domain = String(email || "").split("@")[1] || "";
    return !isNetflixAddress(email)
      && !isInfrastructureAddress(email)
      && !routingRecipients.has(email)
      && domain !== "codes.liumeiti.vip"
      && !domain.endsWith(".codes.liumeiti.vip");
  });
  const forwardingAccount = envelopeFromAddresses.find((email) => !isNetflixAddress(email) && !isInfrastructureAddress(email));
  if (!envelopeFromAddresses.some(isNetflixAddress) && forwardingAccount) {
    accountEmails = accountEmails.includes(forwardingAccount) ? [forwardingAccount] : [];
  }
  if (!accountEmails.length) return { accepted: false, reason: "account_email_missing" };

  // Line-structured text for digit extraction. Sections are separated by a
  // blank line, which breaks digit-run merging across message parts.
  const codeText = normalizeDigits(withoutTrackingIdentifiers(withoutUrls(decodeEntities([subjects.join("\n"), plain, htmlToText(html)]
    .filter(Boolean)
    .join("\n\n")))))
    .normalize("NFKC");
  const language = detectLanguage(text, html);
  const receivedAt = new Date(envelope.receivedAt || Date.now()).toISOString();
  const expiresAt = new Date(new Date(receivedAt).getTime() + 15 * 60 * 1000).toISOString();
  const base = {
    accepted: true,
    accountEmails,
    sender: netflixSender,
    subject: String(subjects[0] || "Netflix").slice(0, 240),
    language,
    receivedAt,
    expiresAt,
  };

  const runs = extractDigitRuns(codeText).filter((run) => !FORWARD_HEADER_LINE.test(run.line || ""));
  const fourDigitRuns = runs.filter((run) => run.value.length === 4);
  const hasSixDigitToken = runs.some((run) => run.value.length === 6);
  const hintPhrases = LANGUAGE_RULES.flatMap((rule) => rule.hints);
  const candidates = fourDigitRuns.filter((run) => hasNearbyPhrase(codeText, run.index, CODE_WORD_STEMS, 300)
    || hasNearbyPhrase(codeText, run.index, hintPhrases, 420));

  let values = unique(candidates.map((run) => run.value));
  if (values.length > 1) {
    // Deterministic tie-breaks for real-world noise: forwarded dates and
    // copyright years also sit near "code" wording. Never drop every value.
    const runsFor = (value) => candidates.filter((run) => run.value === value);
    const nonDate = values.filter((value) => !runsFor(value).every((run) => dateLikeRun(codeText, run)));
    if (nonDate.length) values = nonDate;
    if (values.length > 1) {
      const nonYear = values.filter((value) => !isYearLike(value));
      if (nonYear.length) values = nonYear;
    }
  }
  if (values.length === 1) return { ...base, kind: "code", value: values[0], template: `${language}:login-code` };
  if (values.length > 1) return { ...base, accepted: false, reason: "ambiguous_code", value: undefined };

  // A trusted Netflix sign-in subject plus one unique four-digit value is a
  // safe fallback for forwarded HTML whose layout inserts large spacer blocks.
  const subjectText = normalizeSearchText(subjects.join(" "));
  const subjectIsLoginCode = hintPhrases.some((phrase) => subjectText.includes(normalizeSearchText(phrase)));
  const subjectCodes = unique(fourDigitRuns.map((run) => run.value));
  if (subjectIsLoginCode && subjectCodes.length === 1) {
    return { ...base, kind: "code", value: subjectCodes[0], template: `${language}:login-code` };
  }

  const links = collectNetflixLinks(html, plain);
  const travelLink = travelVerifyLink(links);
  if (travelLink) return { ...base, kind: "link", value: travelLink, template: `${language}:temporary-code-link` };

  const householdLink = householdUpdateLink(links);
  if (householdLink) return { ...base, kind: "household", value: householdLink, template: `${language}:update-primary-location` };

  if (SENSITIVE_CONTEXT.some((phrase) => lower.includes(phrase.toLowerCase())) && hasSixDigitToken) {
    return { ...base, accepted: false, reason: "sensitive_six_digit", value: undefined };
  }
  if (hasSixDigitToken) {
    return { ...base, accepted: false, reason: "six_digit_rejected", value: undefined };
  }
  return { ...base, accepted: false, reason: "supported_content_not_found", value: undefined };
}

function containsSixDigitToken(text) {
  const normalized = normalizeDigits(decodeEntities(String(text || ""))).normalize("NFKC");
  return extractDigitRuns(normalized).some((run) => run.value.length === 6);
}

export const netflixParserInternals = {
  normalizeDigits,
  trustedNetflixUrl,
  containsSixDigitToken,
  extractDigitRuns,
};
