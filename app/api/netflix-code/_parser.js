import PostalMime from "postal-mime";

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const MAX_NESTED_MESSAGES = 3;

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
  { code: "en", hints: ["login code", "sign-in code", "sign in code", "access code", "temporary code", "verification code"], link: ["get code", "get your code", "view code", "receive code", "get temporary code"] },
];

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
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(value) {
  return decodeEntities(String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
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
    if (!/^message\/rfc822/i.test(attachment?.mimeType || "") || !attachment?.content) continue;
    try {
      const nested = await PostalMime.parse(attachment.content, { attachmentEncoding: "arrayBuffer" });
      messages.push(nested);
      queue.push(...(nested.attachments || []));
    } catch {}
  }
  return messages;
}

function detectLanguage(text, html) {
  const lang = String(html || "").match(/<html[^>]+lang=["']?([^"'\s>]+)/i)?.[1]?.toLowerCase() || "";
  if (lang.startsWith("zh-tw") || lang.startsWith("zh-hk") || lang.startsWith("zh-hant")) return "zh-TW";
  if (lang.startsWith("zh")) return "zh-CN";
  const languageMatch = LANGUAGE_RULES.find((rule) => lang.startsWith(rule.code.toLowerCase().split("-")[0]));
  if (languageMatch) return languageMatch.code;
  const lower = text.toLowerCase();
  let best = { code: "en", score: 0 };
  for (const rule of LANGUAGE_RULES) {
    const score = [...rule.hints, ...rule.link].reduce((sum, phrase) => sum + (lower.includes(phrase.toLowerCase()) ? 1 : 0), 0);
    if (score > best.score) best = { code: rule.code, score };
  }
  return best.code;
}

function hasNearbyPhrase(text, index, phrases, distance = 190) {
  const start = Math.max(0, index - distance);
  const end = Math.min(text.length, index + distance);
  const window = text.slice(start, end).toLowerCase();
  return phrases.some((phrase) => window.includes(phrase.toLowerCase()));
}

function codeCandidates(text) {
  const values = [];
  const normalized = normalizeDigits(text);
  for (const match of normalized.matchAll(/(?<![A-Za-z0-9])(\d{4})(?![A-Za-z0-9])/g)) {
    if (Number(match[1]) >= 1900 && Number(match[1]) <= 2100) continue;
    values.push({ value: match[1], index: match.index || 0 });
  }
  return values;
}

function containsSixDigitToken(text) {
  return /(?<![A-Za-z0-9])\d{6}(?![A-Za-z0-9])/.test(normalizeDigits(text));
}

function withoutUrls(text) {
  return String(text || "")
    .replace(/https:\/\/[^\s<>"']+/gi, " ")
    .replace(/\/account\/travel\/verify\?[^\s<>"']+/gi, " ");
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
    const raw = String(value || "").trim();
    const url = raw.startsWith("/")
      ? new URL(raw, "https://www.netflix.com")
      : new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "netflix.com" || host.endsWith(".netflix.com"))) return null;
    if (url.username || url.password || SENSITIVE_PATH.test(url.pathname)) return null;
    return url.toString();
  } catch { return null; }
}

function safeConfirmationLink(html, text) {
  const links = unique([...anchorLinks(html), ...textLinks(text)].map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
  const matches = [];
  for (const link of links) {
    const url = trustedNetflixUrl(link.url);
    if (!url) continue;
    const path = new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
    if (path !== "/account/travel/verify") continue;
    const context = `${link.anchor} ${link.context}`.toLowerCase();
    const phraseMatch = LANGUAGE_RULES.some((rule) => rule.link.some((phrase) => context.includes(phrase.toLowerCase())));
    const sensitive = SENSITIVE_CONTEXT.some((phrase) => context.includes(phrase.toLowerCase()));
    if (phraseMatch && !sensitive) matches.push(url);
  }
  return unique(matches).length === 1 ? unique(matches)[0] : "";
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
  const envelopeAddresses = [...emailsIn(envelope.from), ...emailsIn(envelope.to), ...emailsIn(envelope.inboxAddress)];
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
  const accountEmails = allAddresses.filter((email) => {
    const domain = String(email || "").split("@")[1] || "";
    return !isNetflixAddress(email)
      && !routingRecipients.has(email)
      && domain !== "codes.liumeiti.vip"
      && !domain.endsWith(".codes.liumeiti.vip");
  });
  if (!accountEmails.length) return { accepted: false, reason: "account_email_missing" };
  const codeSearchText = withoutUrls(text);
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
    preview: plain.replace(/\s+/g, " ").trim().slice(0, 240),
  };

  // A flattened Outlook forward can contain unrelated six-digit tracking
  // references in the footer. Prefer one unambiguous four-digit value that is
  // adjacent to Netflix sign-in wording; six-digit values are never returned.
  const phrases = LANGUAGE_RULES.flatMap((rule) => rule.hints);
  const candidates = codeCandidates(codeSearchText).filter((candidate) => hasNearbyPhrase(codeSearchText, candidate.index, phrases));
  const codes = unique(candidates.map((candidate) => candidate.value));
  if (codes.length === 1) return { ...base, kind: "code", value: codes[0], template: `${language}:login-code` };
  if (codes.length > 1) return { ...base, accepted: false, reason: "ambiguous_code", value: undefined };

  const link = safeConfirmationLink(html, plain);
  if (link) return { ...base, kind: "link", value: link, template: `${language}:temporary-code-link` };

  if (SENSITIVE_CONTEXT.some((phrase) => lower.includes(phrase.toLowerCase())) && containsSixDigitToken(codeSearchText)) {
    return { ...base, accepted: false, reason: "sensitive_six_digit", value: undefined };
  }
  if (containsSixDigitToken(codeSearchText)) {
    return { ...base, accepted: false, reason: "six_digit_rejected", value: undefined };
  }
  return { ...base, accepted: false, reason: "supported_content_not_found", value: undefined };
}

export const netflixParserInternals = {
  normalizeDigits,
  trustedNetflixUrl,
  containsSixDigitToken,
};
