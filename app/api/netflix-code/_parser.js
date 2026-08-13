import PostalMime from "postal-mime";
import { createHash } from "node:crypto";

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
  // Strip real markup before decoding entities. Decoding first turns a
  // visible forwarded address such as `Netflix &lt;info@netflix.com&gt;`
  // into an apparent HTML tag and silently removes the trusted sender.
  return decodeEntities(String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|td|th|tr|table|thead|tbody|tfoot|li|ul|ol|h[1-6]|blockquote|section|article|header|footer|main)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
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

const QUOTED_HISTORY_BOUNDARY = /^\s*(?:quoted\s+(?:earlier|previous|original)\b.*(?:message|mail)|-{2,}\s*original\s+message\s*-{2,}|on\s+.+\s+wrote|(?:begin\s+)?forwarded\s+message)\s*:?\s*$/i;

function quotedHistoryBoundaryOffset(value, { structuredNetflix = false } = {}) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  let meaningfulLines = 0;
  let netflixHeaderBlocks = 0;
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const netflixFromHeader = /^\s*from\s*[:：].+@[a-z0-9.-]*netflix\.com\b/i.test(line);
    if (netflixFromHeader) {
      netflixHeaderBlocks += 1;
      // A structured Netflix MIME body starts with current content. A later
      // From: Netflix block therefore begins quoted history. For flattened
      // forwards the first such block identifies the current original; only a
      // second block is historical.
      if ((structuredNetflix && meaningfulLines > 0) || netflixHeaderBlocks > 1) return offset;
    }
    if (QUOTED_HISTORY_BOUNDARY.test(trimmed)) {
      // In a flattened forward the first "Forwarded message" line is merely
      // the wrapper before the current Netflix content. Once current content
      // has started, the same marker safely denotes an older quoted message.
      if (structuredNetflix || meaningfulLines > 1 || netflixHeaderBlocks > 0) return offset;
      offset += line.length + 1;
      continue;
    }
    if (trimmed && !FORWARD_HEADER_LINE.test(trimmed)) meaningfulLines += 1;
    offset += line.length + 1;
  }
  return -1;
}

function withoutQuotedHistory(value, options = {}) {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  const boundary = quotedHistoryBoundaryOffset(source, options);
  return (boundary >= 0 ? source.slice(0, boundary) : source).trim();
}

function withoutQuotedHtml(value, options = {}) {
  const source = String(value || "");
  // CSS, scripts and comments are not visible mail content. Mask them with
  // equal-length whitespace (preserving line breaks) so they cannot inflate
  // meaningful-line counts or contain fake quote markers, while all source
  // offsets still point at the original HTML.
  const masked = source.replace(
    /<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (segment) => segment.replace(/[^\r\n]/g, " "),
  );
  const quotedContainer = /<(?:blockquote\b|(?:div|section)\b[^>]*(?:class|id)=["'][^"']*(?:gmail_quote|protonmail_quote|yahoo_quoted|moz-cite-prefix|divrplyfwdmsg|appendonsend)[^"']*["'])/i.exec(masked);
  const containerBoundary = quotedContainer?.index ?? -1;
  const candidate = containerBoundary >= 0 ? source.slice(0, containerBoundary) : source;
  const candidateMasked = containerBoundary >= 0 ? masked.slice(0, containerBoundary) : masked;
  // Project block tags to newlines and all remaining markup to equal-length
  // spaces. This preserves source offsets while letting the same text boundary
  // detector protect hrefs that appear in an ordinary HTML paragraph after a
  // quoted-history marker.
  const projected = candidateMasked
    .replace(/<(?:br\b[^>]*|\/(?:p|div|section|article|header|footer|li|tr|table|h[1-6])\s*)>/gi, (tag) => `\n${" ".repeat(Math.max(0, tag.length - 1))}`)
    .replace(/<[^>]+>/g, (tag) => " ".repeat(tag.length));
  const textualBoundary = quotedHistoryBoundaryOffset(projected, options);
  const boundary = textualBoundary >= 0 ? textualBoundary : candidate.length;
  return candidate.slice(0, boundary);
}

function contentForNetflixMessage(message, structuredNetflix) {
  const html = withoutQuotedHtml(message?.html || "", { structuredNetflix });
  const text = withoutQuotedHistory(message?.text || htmlToText(html), { structuredNetflix });
  const htmlText = withoutQuotedHistory(htmlToText(html), { structuredNetflix });
  return { message, structuredNetflix, html, text, htmlText };
}

function currentNetflixContent(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const root = rows[0] || {};
  const rootStructuredNetflix = addressValues(root?.from).some(isNetflixAddress);
  const rootContent = contentForNetflixMessage(root, rootStructuredNetflix);
  // Outlook may flatten the current Netflix original into the outer body and
  // attach an older quoted .eml. If the current, quote-trimmed outer segment
  // contains a Netflix From header, it is authoritative; blindly preferring a
  // structured nested message would replay the old attachment's code/link.
  const flattenedRootIsCurrent = forwardedHeaderAddresses([rootContent.text, rootContent.htmlText]
    .filter(Boolean)
    .join("\n"))
    .some(isNetflixAddress);
  if (rootStructuredNetflix || flattenedRootIsCurrent) return rootContent;

  const nested = rows.slice(1).find((entry) => addressValues(entry?.from).some(isNetflixAddress));
  if (!nested) return rootContent;

  // A nested EML is authoritative only when the outer body is a transport
  // wrapper. If the outer body contains any business content, choosing a
  // nested Netflix message could replay an older attached code/link.
  const outerBusinessLines = [rootContent.text, rootContent.htmlText]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !QUOTED_HISTORY_BOUNDARY.test(line))
    .filter((line) => !FORWARD_HEADER_LINE.test(line))
    .filter((line) => !/^(?:return-path|received|delivered-to|message-id|mime-version|content-type|content-transfer-encoding|x-[a-z0-9-]+)\s*:/i.test(line));
  return outerBusinessLines.length ? rootContent : contentForNetflixMessage(nested, true);
}

function canonicalNetflixMessageBody(value) {
  const source = String(value || "")
    // Forwarding wrappers add these presentation headers independently for
    // each copy. They are transport noise, not part of the Netflix request.
    .replace(/^\s*(?:from|to|cc|bcc|date|sent|subject|reply-to)\s*[:：].*$/gim, " ")
    .replace(/^\s*(?:-{2,}\s*)?(?:begin\s+)?forwarded message(?:\s*-{2,})?\s*$/gim, " ")
    // One Outlook forwarding path may omit the visible SRC footer entirely.
    // The SRC UUID is already retained as separate strong evidence below, so
    // remove its whole line from the content identity before hashing.
    .replace(/^\s*src\s*[:：].*$/gim, " ");
  const normalized = normalizeSearchText(source);
  return normalized.length >= 32 && normalized.includes("netflix") ? normalized : "";
}

const ORIGINAL_MESSAGE_ID_HEADER_KEYS = [
  "x-ms-exchange-parent-message-id",
  "x-microsoft-original-message-id",
  "in-reply-to",
  "references",
];
const MAX_REQUEST_EVIDENCE = 32;

function normalizedMessageIds(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return [];
  const canonical = (item) => {
    const inner = String(item || "").trim().replace(/^<|>$/g, "").trim();
    return inner && inner.length <= 498 && inner.includes("@") ? `<${inner}>` : "";
  };
  // A few Exchange paths omit angle brackets around a single Message-ID.
  // Parse bracketed and bare values in one ordered pass because a folded
  // References chain can legitimately mix both forms.
  return unique(Array.from(normalized.matchAll(/<[^<>\r\n]{1,498}>|[^\s,<>\r\n]{1,498}@[^\s,<>\r\n]{1,498}/g), (match) => canonical(match[0]))
    .filter(Boolean));
}

function messageHeaderValues(message, key) {
  const wanted = String(key || "").toLowerCase();
  return (Array.isArray(message?.headers) ? message.headers : [])
    .filter((header) => String(header?.key || header?.originalKey || "").trim().toLowerCase() === wanted)
    .map((header) => header?.value);
}

function messageIdsForHeader(message, key) {
  return unique(messageHeaderValues(message, key).flatMap(normalizedMessageIds));
}

// References is a thread chain, not the identity of the current request. Keep
// every value as auxiliary evidence below, but persist one separate current
// identity so an old thread member cannot claim a newer code. RFC References
// places the immediate parent last; Exchange's dedicated original-id headers
// are stronger and take precedence when present.
function netflixRequestIdentity(current) {
  const message = current?.message;
  let identities = [];
  if (current?.structuredNetflix) {
    identities = normalizedMessageIds(message?.messageId);
  } else {
    const strongCandidates = [];
    for (const key of [
      "x-ms-exchange-parent-message-id",
      "x-microsoft-original-message-id",
    ]) {
      strongCandidates.push(...messageIdsForHeader(message, key));
    }
    identities = unique(strongCandidates);
    if (identities.length > 1) return { evidence: [], ambiguous: true };
    // In-Reply-To and References describe a conversation and can legitimately
    // retain an older thread root. They identify the current request only when
    // Exchange did not preserve either dedicated original-message header.
    if (!identities.length) {
      const weakCandidates = [];
      const inReplyTo = messageIdsForHeader(message, "in-reply-to");
      const references = messageIdsForHeader(message, "references");
      if (inReplyTo.length) weakCandidates.push(inReplyTo.at(-1));
      if (references.length) weakCandidates.push(references.at(-1));
      identities = unique(weakCandidates);
      if (identities.length > 1) return { evidence: [], ambiguous: true };
    }
  }
  return {
    evidence: identities.map((messageId) => `message-id:${messageId}`),
    ambiguous: false,
  };
}

// Correlating a rejected copy with an older accepted copy is safe only when
// both carry positive evidence from the same original Netflix message. Keep a
// set because Outlook may preserve the original Message-ID in one wrapper and
// only the canonical original body in another. Exchange identity headers are
// collected for flattened and structured messages alike: an inbox-rule copy
// is normally not structured as Netflix mail, but its parent/references value
// is the original Message-ID carried by the settings-forward copy. These
// values exist only in memory; _store HMACs them before persistence.
function netflixRequestEvidence(current) {
  const evidence = new Set();
  const message = current?.message;
  const addMessageIds = (value) => {
    for (const messageId of normalizedMessageIds(value)) {
      evidence.add(`message-id:${messageId}`);
    }
  };
  addMessageIds(message?.messageId);
  for (const key of ORIGINAL_MESSAGE_ID_HEADER_KEYS) {
    for (const value of messageHeaderValues(message, key)) addMessageIds(value);
  }
  const body = canonicalNetflixMessageBody(current?.text || current?.htmlText || "");
  if (body) {
    evidence.add(`content-sha256:${createHash("sha256").update(body).digest("hex")}`);
  }
  return Array.from(evidence).slice(0, MAX_REQUEST_EVIDENCE);
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

const NETFLIX_SRC_UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Forwarding providers commonly assign a new RFC Message-ID to each copy, but
// Netflix repeats one delivery UUID in its visible `SRC:` footer. Only that
// source-scoped identifier is strong enough to correlate two differently
// wrapped copies. An arbitrary UUID elsewhere in a forwarded message is not a
// delivery identity. Quoted forwarding chains may contain older SRC footers,
// so the first UUID in the first visible SRC line is the current message.
function netflixDeliveryFingerprint(values) {
  for (const value of (Array.isArray(values) ? values : [values])) {
    const source = decodeEntities(String(value || ""));
    for (const match of source.matchAll(/\bsrc\s*:\s*([^\r\n]{0,512})/gi)) {
      NETFLIX_SRC_UUID_PATTERN.lastIndex = 0;
      const uuid = NETFLIX_SRC_UUID_PATTERN.exec(String(match[1] || ""))?.[0]?.toLowerCase() || "";
      if (uuid) {
        return createHash("sha256")
          .update(`netflix-src-v1\0${uuid}`)
          .digest("hex");
      }
    }
  }
  return "";
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
    // Netflix's plain-text alternative wraps every URL in square brackets
    // (`获取代码\n[https://www.netflix.com/account/travel/verify?...]`). A
    // trailing bracket is punctuation, not part of the link: leaving it in
    // makes the text copy of a link differ from the identical HTML anchor.
    url: decodeEntities(match[0]).replace(/[\])},.;]+$/, ""),
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
    const token = String(link.params.get("nftoken") || link.params.get("token") || "");
    if (phraseMatch || token) matches.push({ url: link.url, token });
  }
  if (!matches.length) return "";

  // One delivery carries the same link twice: once as an HTML anchor and once
  // in the plain-text alternative, and the two copies routinely differ in
  // punctuation and tracking parameters. The signed token is the request's
  // identity, so compare on that. Only two genuinely different tokens mean two
  // requests arrived together, and then neither may be returned.
  const tokens = unique(matches.map((match) => match.token).filter(Boolean));
  if (tokens.length > 1) return "";
  // Prefer the HTML anchor: collectNetflixLinks lists anchors before text
  // links, and the anchor href is the copy Netflix rendered for the button.
  if (tokens.length === 1) return matches.find((match) => match.token === tokens[0]).url;

  const distinct = unique(matches.map((match) => match.url));
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

function portableExplicitTimestamp(value) {
  const dateText = String(value || "").trim();
  const numericTimezone = /(?:^|\s)([+-])(\d{2}):?(\d{2})(?:\s*\([^)]+\))?\s*$/.exec(dateText);
  if (numericTimezone && (Number(numericTimezone[2]) > 23 || Number(numericTimezone[3]) > 59 || (numericTimezone[1] === "-" && numericTimezone[2] === "00" && numericTimezone[3] === "00"))) return 0;
  const hasExplicitTimezone = Boolean(numericTimezone) || /(?:(?:^|[\s(])(?:ut|utc|gmt|[ecmp][sd]t|jst|kst|aest|aedt)(?=$|[\s)+-])|(?:^|\s)z$|t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z(?:$|\s))/i.test(dateText);
  if (!hasExplicitTimezone) return 0;
  const timestamp = new Date(dateText).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function forwardedNetflixSentAt(text) {
  let insideNetflixHeaders = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:from|de|von|da|发件人|寄件者|差出人)\s*[:：]/i.test(line)) {
      insideNetflixHeaders = emailsIn(line).some(isNetflixAddress);
      continue;
    }
    if (!insideNetflixHeaders) continue;
    const match = /^(?:date|sent|datum|gesendet|fecha|enviado|enviada|envoyé|envoye|data|inviato|verzonden|wysłano|wyslano|日期|发送时间|寄件日期|送信日時)\s*[:：]\s*(.+)$/i.exec(line);
    if (!match) continue;
    const timestamp = portableExplicitTimestamp(match[1]);
    if (timestamp) return timestamp;
  }
  return 0;
}

function normalizedNetflixRequestSentAt(current, currentPlain, receivedAt) {
  const received = new Date(receivedAt || Date.now()).getTime();
  const structured = current?.structuredNetflix
    ? messageHeaderValues(current.message, "date").map(portableExplicitTimestamp).find(Boolean) || 0
    : 0;
  const candidate = Number.isFinite(structured) && structured > 0
    ? structured
    : forwardedNetflixSentAt(currentPlain);
  // A forwarded sign-in email is useful for only minutes, but allow generous
  // provider delay while rejecting a malformed/future body date that could
  // otherwise pin an old request above every subsequent code.
  if (!Number.isFinite(candidate) || candidate <= 0
    || candidate < received - 7 * 24 * 60 * 60 * 1000
    || candidate > received + 10 * 60 * 1000) return "";
  return new Date(candidate).toISOString();
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

  const current = currentNetflixContent(messages);
  const currentSubject = String(current.message?.subject || messages[0]?.subject || "Netflix");
  const currentPlain = [current.text, current.htmlText].filter(Boolean).join("\n");
  const text = normalizeDigits(`${currentSubject}\n${currentPlain}`).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  // Every identity signal that can originate in the MIME body must be bound
  // to the same current message segment as the returned code/link. Otherwise
  // a quoted historical .eml or membership footer could lend its account to a
  // newer request and expose one customer's code to another customer's order.
  const structuredFrom = addressValues(current.message?.from);
  const structuredRecipients = [
    ...addressValues(current.message?.to),
    ...addressValues(current.message?.cc),
    ...addressValues(current.message?.bcc),
    ...addressValues(current.message?.replyTo),
  ];
  const forwarded = forwardedHeaderAddresses(currentPlain);
  const originalRecipients = originalRecipientHeaders(raw);
  // Outlook and other providers may flatten an automatically forwarded email
  // and leave the original Netflix account only in the membership footer.
  const bodyAddresses = emailsIn(currentPlain);
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
  const netflixSender = unique([
    ...structuredFrom,
    ...forwarded,
    ...envelopeFromAddresses,
    ...emailsIn(currentPlain.slice(0, 3000)),
  ]).find(isNetflixAddress) || "";
  // Carry enough context for the operational log. A delivery that is refused
  // here still has to be explainable in the admin panel, otherwise "no mail
  // arrived" and "mail arrived but was refused" look identical to staff.
  const refusedReceivedAt = new Date(envelope.receivedAt || Date.now()).toISOString();
  const refusedContext = {
    receivedAt: refusedReceivedAt,
    // A refused delivery carries no usable result, but the stored record still
    // has to satisfy the same shape as every other event so one of them can
    // never make the whole log unreadable.
    expiresAt: new Date(new Date(refusedReceivedAt).getTime() + 15 * 60 * 1000).toISOString(),
    subject: currentSubject.slice(0, 240),
  };
  if (!netflixSender) return { accepted: false, reason: "untrusted_sender", ...refusedContext };

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
  if (!accountEmails.length) {
    return { accepted: false, reason: "account_email_missing", ...refusedContext, sender: netflixSender };
  }

  // Line-structured text for digit extraction. Sections are separated by a
  // blank line, which breaks digit-run merging across message parts.
  const codeText = normalizeDigits(withoutTrackingIdentifiers(withoutUrls(decodeEntities([[currentSubject, current.text].filter(Boolean).join("\n"), current.htmlText]
    .filter(Boolean)
    .join("\n\n")))))
    .normalize("NFKC");
  const language = detectLanguage(text, current.html);
  const receivedAt = new Date(envelope.receivedAt || Date.now()).toISOString();
  const expiresAt = new Date(new Date(receivedAt).getTime() + 15 * 60 * 1000).toISOString();
  const requestIdentity = netflixRequestIdentity(current);
  const deliveryFingerprint = netflixDeliveryFingerprint(current.text)
    || (!/\bsrc\s*:/i.test(String(current.message?.text || "")) ? netflixDeliveryFingerprint(current.htmlText) : "");
  const requestSentAt = normalizedNetflixRequestSentAt(current, currentPlain, receivedAt);
  const base = {
    accepted: true,
    accountEmails,
    sender: netflixSender,
    subject: currentSubject.slice(0, 240),
    language,
    receivedAt,
    requestSentAt,
    requestSentAtPortable: Boolean(requestSentAt),
    expiresAt,
    // Both alternatives were quote-trimmed above: prefer text SRC, then use a
    // current HTML SRC only when the text alternative has none.
    deliveryFingerprint,
    deliveryFingerprintFromCurrent: Boolean(deliveryFingerprint),
    requestPrimaryEvidence: requestIdentity.evidence,
    requestIdentityAmbiguous: requestIdentity.ambiguous,
    requestEvidence: netflixRequestEvidence(current),
  };

  const runs = extractDigitRuns(codeText).filter((run) => !FORWARD_HEADER_LINE.test(run.line || ""));
  // A four-digit run that is both a plausible year and surrounded by date
  // wording (`发送时间: 2026年8月13日`, `13 Aug 2026`) is a forwarding
  // timestamp, not a sign-in code — some clients flatten their forward header
  // into a line that no longer starts with a header label, so FORWARD_HEADER_LINE
  // alone does not catch it. Both signals are required together: Netflix prints
  // the real code in a standalone block, so a genuine code that happens to read
  // like a year still survives. Filtering here rather than only as a tie-break
  // between competing candidates is what stops a lone forwarded year from being
  // returned as "the code" and hiding the access link the email actually carries.
  const fourDigitRuns = runs.filter((run) => run.value.length === 4
    && !(isYearLike(run.value) && dateLikeRun(codeText, run)));
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
  const subjectText = normalizeSearchText(currentSubject);
  const subjectIsLoginCode = hintPhrases.some((phrase) => subjectText.includes(normalizeSearchText(phrase)));
  const subjectCodes = unique(fourDigitRuns.map((run) => run.value));
  if (subjectIsLoginCode && subjectCodes.length === 1) {
    return { ...base, kind: "code", value: subjectCodes[0], template: `${language}:login-code` };
  }

  const links = collectNetflixLinks(current.html, current.text);
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
  netflixDeliveryFingerprint,
};
