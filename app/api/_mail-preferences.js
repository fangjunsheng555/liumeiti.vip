import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { clean, formatBeijingTime, redisCmd, redisPipeline, validEmail } from "./_utils.js";

const CONTACT_PREFIX = "lm:mail:contact:";
const CONTACT_INDEX_KEY = "lm:mail:contacts";
const PREFERENCE_EVENT_PREFIX = "lm:mail:preference-events:";
const SUPPRESSED_MARKETING_KEY = "lm:mail:suppressed:marketing";
const SUPPRESSED_OPTIONAL_KEY = "lm:mail:suppressed:optional";
const SUPPRESSED_ALL_KEY = "lm:mail:suppressed:all";
const CLICK_EVENT_PREFIX = "lm:mail:marketing:click:";
const UNIQUE_CLICK_PREFIX = "lm:mail:marketing:unique-click:";
const TOKEN_VERSION = 1;
const PREFERENCE_TOKEN_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
const CLICK_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const ATTRIBUTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PREFERENCE_EVENTS = 100;
const MARKETING_FOOTER_MARKER = "LM_MARKETING_PREFERENCES_V1";
const MARKETING_FOOTER_SLOT = "<!-- LM_MARKETING_PREFERENCES_SLOT_V1 -->";

const SCOPE_PRIORITY = { none: 0, marketing: 1, optional: 2, all: 3 };

function normalizeEmail(value) {
  const email = clean(value, 254).toLowerCase();
  return validEmail(email) ? email : "";
}

function mailSecret() {
  const dedicated = String(process.env.MAIL_PREFERENCES_SECRET || "");
  if (dedicated || process.env.NODE_ENV === "production") return dedicated;
  // Local/test compatibility is explicit and never used by production.
  return String(process.env.AUTH_SECRET || process.env.SESSION_SECRET || "");
}

export function mailContactId(value) {
  const email = normalizeEmail(value);
  if (!email) return "";
  const secret = mailSecret();
  // Never fall back to an enumerable plain hash. Deployments must configure a
  // secret before marketing mail can create contacts or signed opt-out links.
  if (!secret) return "";
  return createHmac("sha256", secret).update(`mail-contact\n${email}`).digest("hex").slice(0, 40);
}

function contactKey(contactId) {
  return CONTACT_PREFIX + clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase();
}

function preferenceEventKey(contactId) {
  return PREFERENCE_EVENT_PREFIX + clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase();
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function pipelineEntryHasError(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (Object.hasOwn(entry, "error") && entry.error != null) return true;
  return Object.hasOwn(entry, "result")
    && entry.result
    && typeof entry.result === "object"
    && Object.hasOwn(entry.result, "error")
    && entry.result.error != null;
}

function checkedPipelineRows(response, expectedLength) {
  const entries = Array.isArray(response?.result) ? response.result : response;
  if (!Array.isArray(entries) || entries.length !== expectedLength || entries.some(pipelineEntryHasError)) return null;
  return entries.map((entry) => (entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry));
}

function normalizedPreferences(value = {}) {
  const marketing = ["granted", "denied", "unknown", "legacy_allowed"].includes(value.marketing)
    ? value.marketing
    : "unknown";
  return {
    marketing,
    orderUpdates: value.orderUpdates !== false,
    renewal: value.renewal !== false,
    serviceNotices: value.serviceNotices !== false,
  };
}

function normalizedSuppression(value = {}) {
  const scope = Object.hasOwn(SCOPE_PRIORITY, value.scope) ? value.scope : "none";
  return {
    scope,
    reason: clean(value.reason, 120),
    source: clean(value.source, 60),
    provider: clean(value.provider, 40),
    eventId: clean(value.eventId, 180),
    createdAt: clean(value.createdAt, 80),
    createdAtBeijing: clean(value.createdAtBeijing, 100),
  };
}

function normalizedContact(record, email = "") {
  const normalized = normalizeEmail(record?.email || email);
  const contactId = clean(record?.contactId, 64) || mailContactId(normalized);
  return {
    contactId,
    email: normalized,
    sources: Array.from(new Set((Array.isArray(record?.sources) ? record.sources : [])
      .map((item) => clean(item, 40).toLowerCase())
      .filter(Boolean))),
    locale: record?.locale === "en" ? "en" : record?.locale === "zh" ? "zh" : "unknown",
    preferences: normalizedPreferences(record?.preferences),
    consent: record?.consent && typeof record.consent === "object" ? record.consent : {},
    suppression: normalizedSuppression(record?.suppression),
    softBounce: record?.softBounce && typeof record.softBounce === "object" ? record.softBounce : {},
    cooldown: record?.cooldown && typeof record.cooldown === "object" ? record.cooldown : {},
    revision: Math.max(0, Number(record?.revision || 0)),
    createdAt: clean(record?.createdAt, 80),
    updatedAt: clean(record?.updatedAt, 80),
  };
}

const CONTACT_CAS_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
local current=0
if raw then
  local ok,doc=pcall(cjson.decode,raw)
  if not ok then return -2 end
  current=tonumber(doc.revision or 0)
end
if current~=tonumber(ARGV[1]) then return 0 end
-- Update the secondary index before the contact record. Redis scripts are
-- atomic with respect to other clients, but a runtime command error does not
-- roll back commands that already ran. Keeping SET last ensures an index type
-- error cannot commit the mutation and then make the caller replay it.
redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4])
redis.call('SET',KEYS[1],ARGV[2])
return 1
`;

async function saveContact(contact, expectedRevision) {
  if (!contact?.contactId || !contact?.email) return false;
  const saved = await redisCmd([
    "EVAL", CONTACT_CAS_SCRIPT, "2", contactKey(contact.contactId), CONTACT_INDEX_KEY,
    String(Math.max(0, Number(expectedRevision || 0))), JSON.stringify(contact),
    String(Date.now()), contact.contactId,
  ]);
  return Number(saved) === 1;
}

async function mutateContact({ email = "", contactId = "", source = "", locale = "" } = {}, mutation = (contact) => contact) {
  const normalizedEmail = normalizeEmail(email);
  const resolvedId = clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase() || mailContactId(normalizedEmail);
  if (!resolvedId) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await getMailContactById(resolvedId);
    if (!existing && !normalizedEmail) return null;
    const now = new Date();
    const base = normalizedContact(existing || {
      contactId: resolvedId,
      email: normalizedEmail,
      createdAt: now.toISOString(),
    }, normalizedEmail);
    if (!base.email) return null;
    if (source && !base.sources.includes(clean(source, 40).toLowerCase())) base.sources.push(clean(source, 40).toLowerCase());
    if (locale === "en" || locale === "zh") base.locale = locale;
    const expectedRevision = Math.max(0, Number(existing?.revision || 0));
    const mutated = await mutation(base, existing);
    if (mutated === false) return null;
    const next = normalizedContact(mutated || base, base.email);
    next.revision = expectedRevision + 1;
    next.createdAt = existing?.createdAt || next.createdAt || now.toISOString();
    next.updatedAt = now.toISOString();
    if (await saveContact(next, expectedRevision)) return next;
  }
  return null;
}

async function appendPreferenceEvent(contactId, event) {
  const item = {
    id: clean(event?.id, 180) || randomBytes(12).toString("hex"),
    type: clean(event?.type, 80),
    scope: clean(event?.scope, 30),
    reason: clean(event?.reason, 160),
    source: clean(event?.source, 60),
    provider: clean(event?.provider, 40),
    campaignId: clean(event?.campaignId, 80),
    createdAt: event?.createdAt || new Date().toISOString(),
    createdAtBeijing: event?.createdAtBeijing || formatBeijingTime(event?.createdAt || new Date()),
  };
  await redisPipeline([
    ["LPUSH", preferenceEventKey(contactId), JSON.stringify(item)],
    ["LTRIM", preferenceEventKey(contactId), "0", String(MAX_PREFERENCE_EVENTS - 1)],
  ]);
  return item;
}

export async function getMailContactById(contactId) {
  const safeId = clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!safeId) return null;
  const record = parseJson(await redisCmd(["GET", contactKey(safeId)]));
  return record ? normalizedContact(record) : null;
}

async function readMailContactByIdStrict(contactId) {
  const safeId = clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!safeId) return { ok: true, contact: null };
  const commands = [["GET", contactKey(safeId)], ["PING"]];
  const rows = checkedPipelineRows(await redisPipeline(commands), commands.length);
  if (!rows || rows[1] !== "PONG") return { ok: false, error: "storage_unavailable", contact: null };
  if (rows[0] == null) return { ok: true, contact: null };
  const parsed = parseJson(rows[0]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "storage_unavailable", contact: null };
  }
  return { ok: true, contact: normalizedContact(parsed) };
}

export async function getMailContact(email) {
  const normalized = normalizeEmail(email);
  return normalized ? getMailContactById(mailContactId(normalized)) : null;
}

export async function ensureMailContact(email, { source = "", locale = "" } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const contactId = mailContactId(normalized);
  if (!contactId) return null;
  const existing = await getMailContactById(contactId);
  const wantedSource = clean(source, 40).toLowerCase();
  if (existing
      && (!wantedSource || existing.sources.includes(wantedSource))
      && (!locale || existing.locale === locale)) {
    const indexed = await redisCmd(["ZADD", CONTACT_INDEX_KEY, String(Date.now()), existing.contactId]);
    return indexed == null ? null : existing;
  }
  return mutateContact({ email: normalized, contactId, source, locale });
}

export function mailPurpose({ purpose = "", category = "", marketing = false } = {}) {
  const explicit = clean(purpose, 30).toLowerCase();
  if (["critical", "transactional", "lifecycle", "marketing"].includes(explicit)) return explicit;
  if (marketing || clean(category, 40).toLowerCase() === "marketing") return "marketing";
  const value = clean(category, 40).toLowerCase();
  if (["verification", "password_update", "security"].includes(value)) return "critical";
  if (["renewal", "service_incident", "abandoned"].includes(value)) return "lifecycle";
  return "transactional";
}

function suppressionBlocks(scope, purpose) {
  if (scope === "all") return true;
  if (scope === "optional") return purpose === "marketing" || purpose === "lifecycle";
  return scope === "marketing" && purpose === "marketing";
}

const OPTIONAL_ORDER_CATEGORIES = new Set(["order", "order_update", "quote", "after_sales"]);

function decisionForContact(contact, { resolvedPurpose, normalizedCategory }) {
  const cooldownUntil = Date.parse(contact.cooldown?.until || "");
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now() && ["marketing", "lifecycle"].includes(resolvedPurpose)) {
    return { allowed: false, retryable: true, reason: "soft_bounce_cooldown", purpose: resolvedPurpose, contact };
  }
  const suppression = normalizedSuppression(contact.suppression);
  if (suppressionBlocks(suppression.scope, resolvedPurpose)) {
    return { allowed: false, reason: suppression.reason || `suppressed_${suppression.scope}`, purpose: resolvedPurpose, contact };
  }
  if (resolvedPurpose === "marketing" && contact.preferences.marketing === "denied") {
    return { allowed: false, reason: "marketing_unsubscribed", purpose: resolvedPurpose, contact };
  }
  if (resolvedPurpose === "lifecycle") {
    if (normalizedCategory === "renewal" && contact.preferences.renewal === false) {
      return { allowed: false, reason: "renewal_disabled", purpose: resolvedPurpose, contact };
    }
    if (normalizedCategory === "service_incident" && contact.preferences.serviceNotices === false) {
      return { allowed: false, reason: "service_notices_disabled", purpose: resolvedPurpose, contact };
    }
  }
  if (resolvedPurpose === "transactional" && contact.preferences.orderUpdates === false && OPTIONAL_ORDER_CATEGORIES.has(normalizedCategory)) {
    return { allowed: false, reason: "order_updates_disabled", purpose: resolvedPurpose, contact };
  }
  return { allowed: true, reason: "", purpose: resolvedPurpose, contact };
}

export async function getMailSendDecisionsBatch({ emails, purpose = "", category = "", marketing = false } = {}) {
  const normalizedEmails = Array.from(new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean))).slice(0, 5000);
  const resolvedPurpose = mailPurpose({ purpose, category, marketing });
  const normalizedCategory = clean(category, 40).toLowerCase();
  if (!normalizedEmails.length) return { ok: true, decisions: new Map() };
  const ids = normalizedEmails.map(mailContactId);
  if (ids.some((id) => !id)) return { ok: false, error: "mail_policy_unavailable", decisions: new Map() };
  const commands = [...ids.map((id) => ["GET", contactKey(id)]), ["PING"]];
  const rows = checkedPipelineRows(await redisPipeline(commands), commands.length);
  if (!rows || rows.at(-1) !== "PONG") {
    return { ok: false, error: "mail_policy_unavailable", decisions: new Map() };
  }
  const decisions = new Map();
  for (let index = 0; index < normalizedEmails.length; index += 1) {
    const email = normalizedEmails[index];
    const raw = rows[index];
    const parsed = raw == null ? null : parseJson(raw);
    if (raw != null && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      return { ok: false, error: "mail_policy_unavailable", decisions: new Map() };
    }
    const contact = parsed ? normalizedContact(parsed, email) : null;
    decisions.set(email, contact
      ? decisionForContact(contact, { resolvedPurpose, normalizedCategory })
      : { allowed: true, reason: "", purpose: resolvedPurpose, contact: null, defaultPolicy: true });
  }
  return { ok: true, decisions };
}

export async function getMailSendDecision({ email, purpose = "", category = "", marketing = false } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { allowed: false, reason: "invalid_email", purpose: mailPurpose({ purpose, category, marketing }) };
  const resolvedPurpose = mailPurpose({ purpose, category, marketing });
  const normalizedCategory = clean(category, 40).toLowerCase();
  const optionalPolicy = resolvedPurpose === "marketing"
    || resolvedPurpose === "lifecycle"
    || (resolvedPurpose === "transactional" && OPTIONAL_ORDER_CATEGORIES.has(normalizedCategory));
  let contact = await getMailContact(normalized);
  if (!contact && optionalPolicy) {
    contact = await ensureMailContact(normalized, { source: "send_policy" });
  }
  if (!contact && optionalPolicy) {
    return { allowed: false, retryable: true, policyUnavailable: true, reason: "mail_policy_unavailable", purpose: resolvedPurpose, contact: null };
  }
  if (!contact) return { allowed: true, reason: "", purpose: resolvedPurpose, contact: null };
  return decisionForContact(contact, { resolvedPurpose, normalizedCategory });
}

function strongerScope(left, right) {
  return (SCOPE_PRIORITY[right] || 0) > (SCOPE_PRIORITY[left] || 0) ? right : left;
}

async function updateSuppressionIndexes(contactId, scope) {
  const commands = [
    ["SREM", SUPPRESSED_MARKETING_KEY, contactId],
    ["SREM", SUPPRESSED_OPTIONAL_KEY, contactId],
    ["SREM", SUPPRESSED_ALL_KEY, contactId],
    ...(scope === "marketing" ? [["SADD", SUPPRESSED_MARKETING_KEY, contactId]] : []),
    ...(scope === "optional" ? [["SADD", SUPPRESSED_OPTIONAL_KEY, contactId]] : []),
    ...(scope === "all" ? [["SADD", SUPPRESSED_ALL_KEY, contactId]] : []),
  ];
  const rows = checkedPipelineRows(await redisPipeline(commands), commands.length);
  return Array.isArray(rows) && rows.every((entry) => entry != null);
}

export async function suppressMailAddress({ email, contactId = "", scope = "marketing", reason = "manual", source = "system", provider = "", eventId = "", campaignId = "" } = {}) {
  const requestedScope = Object.hasOwn(SCOPE_PRIORITY, scope) ? scope : "marketing";
  const contact = await mutateContact({ email, contactId, source }, (current) => {
    const currentScope = current.suppression?.scope || "none";
    // A weaker policy event must never replace the reason/provider attached to
    // a hard bounce or provider-level suppression.
    if ((SCOPE_PRIORITY[requestedScope] || 0) < (SCOPE_PRIORITY[currentScope] || 0)) return current;
    const now = new Date();
    current.suppression = {
      scope: strongerScope(currentScope, requestedScope),
      reason: clean(reason, 120),
      source: clean(source, 60),
      provider: clean(provider, 40),
      eventId: clean(eventId, 180),
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
    };
    return current;
  });
  if (!contact) return { ok: false, error: "contact_not_found" };
  if (!await updateSuppressionIndexes(contact.contactId, contact.suppression?.scope || "none")) {
    return { ok: false, error: "storage_failed" };
  }
  await appendPreferenceEvent(contact.contactId, {
    id: eventId,
    type: "suppression.added",
    scope: contact.suppression?.scope || requestedScope,
    reason,
    source,
    provider,
    campaignId,
  });
  return { ok: true, contact };
}

export async function clearMailSuppression({ email, contactId = "", source = "admin", reason = "manual_clear" } = {}) {
  let previous = null;
  const contact = await mutateContact({ email, contactId }, (current, existing) => {
    if (!existing) return false;
    previous = current.suppression;
    current.suppression = normalizedSuppression({ scope: "none" });
    return current;
  });
  if (!contact) return { ok: false, error: "contact_not_found" };
  if (!await updateSuppressionIndexes(contact.contactId, "none")) return { ok: false, error: "storage_failed" };
  await appendPreferenceEvent(contact.contactId, {
    type: "suppression.cleared",
    scope: previous?.scope || "none",
    reason,
    source,
  });
  return { ok: true, contact };
}

export async function updateMailPreferences({ email, contactId = "", preferences = {}, source = "preferences", campaignId = "", locale = "" } = {}) {
  const contact = await mutateContact({ email, contactId, source, locale }, (current) => {
    const next = { ...current.preferences };
    if (["granted", "denied"].includes(preferences.marketing)) next.marketing = preferences.marketing;
    for (const key of ["orderUpdates", "renewal", "serviceNotices"]) {
      if (typeof preferences[key] === "boolean") next[key] = preferences[key];
    }
    current.preferences = normalizedPreferences(next);
    const now = new Date();
    if (preferences.marketing === "granted") {
      current.consent = {
        ...(current.consent || {}),
        marketing: { status: "granted", source: clean(source, 60), at: now.toISOString(), atBeijing: formatBeijingTime(now) },
      };
    } else if (preferences.marketing === "denied") {
      current.consent = {
        ...(current.consent || {}),
        marketing: { status: "denied", source: clean(source, 60), at: now.toISOString(), atBeijing: formatBeijingTime(now) },
      };
    }
    if (preferences.marketing === "denied") {
      const currentScope = current.suppression?.scope || "none";
      if ((SCOPE_PRIORITY[currentScope] || 0) <= SCOPE_PRIORITY.marketing) {
        current.suppression = {
          scope: "marketing",
          reason: "marketing_unsubscribed",
          source: clean(source, 60),
          provider: "",
          eventId: "",
          createdAt: now.toISOString(),
          createdAtBeijing: formatBeijingTime(now),
        };
      }
    } else if (preferences.marketing === "granted"
        && current.suppression?.scope === "marketing"
        && current.suppression?.reason === "marketing_unsubscribed") {
      current.suppression = normalizedSuppression({ scope: "none" });
    }
    return current;
  });
  if (!contact) return { ok: false, error: "contact_not_found" };
  if (!await updateSuppressionIndexes(contact.contactId, contact.suppression?.scope || "none")) {
    return { ok: false, error: "storage_failed" };
  }
  await appendPreferenceEvent(contact.contactId, {
    type: "preferences.updated",
    scope: preferences.marketing || "",
    reason: preferences.marketing === "denied" ? "marketing_unsubscribed" : "",
    source,
    campaignId,
  });
  return { ok: true, contact };
}

function signToken(payload) {
  const secret = mailSecret();
  if (!secret) return "";
  const data = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...payload })).toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifyToken(token, expectedKind = "") {
  const secret = mailSecret();
  const [data, signature] = String(token || "").split(".");
  if (!secret || !data || !signature) return null;
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.v !== TOKEN_VERSION || (expectedKind && payload.k !== expectedKind)) return null;
    if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function normalizedOrigin(value = "") {
  const fallback = process.env.SITE_URL || "https://www.liumeiti.vip";
  try { return new URL(value || fallback).origin; } catch { return "https://www.liumeiti.vip"; }
}

export async function createMailPreferenceToken(email, { campaignId = "" } = {}) {
  const contact = await ensureMailContact(email, { source: "mail" });
  if (!contact) return "";
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    k: "preferences",
    cid: contact.contactId,
    cmp: clean(campaignId, 80),
    iat: now,
    exp: now + PREFERENCE_TOKEN_TTL_SECONDS,
  });
}

export async function mailPreferenceLinks(email, { campaignId = "", siteUrl = "" } = {}) {
  const token = await createMailPreferenceToken(email, { campaignId });
  const origin = normalizedOrigin(siteUrl);
  if (!token) return { token: "", preferencesUrl: "", unsubscribeUrl: "", oneClickUrl: "" };
  const encoded = encodeURIComponent(token);
  return {
    token,
    preferencesUrl: `${origin}/email/preferences?token=${encoded}`,
    unsubscribeUrl: `${origin}/email/unsubscribe?token=${encoded}`,
    oneClickUrl: `${origin}/api/email/unsubscribe?token=${encoded}`,
  };
}

export async function getMailPreferencesByToken(token) {
  const payload = verifyToken(token, "preferences");
  if (!payload?.cid) return { ok: false, error: "invalid_token" };
  const read = await readMailContactByIdStrict(payload.cid);
  if (!read.ok) return { ok: false, error: "storage_unavailable", retryable: true };
  const contact = read.contact;
  if (!contact) return { ok: false, error: "contact_not_found" };
  return {
    ok: true,
    contactId: contact.contactId,
    campaignId: clean(payload.cmp, 80),
    maskedEmail: contact.email.replace(/^(.{1,2}).*(@.*)$/, "$1***$2"),
    locale: contact.locale,
    preferences: contact.preferences,
    suppression: contact.suppression,
  };
}

export async function updateMailPreferencesByToken(token, preferences, source = "preferences_page") {
  const payload = verifyToken(token, "preferences");
  if (!payload?.cid) return { ok: false, error: "invalid_token" };
  const read = await readMailContactByIdStrict(payload.cid);
  if (!read.ok) return { ok: false, error: "storage_unavailable", retryable: true };
  if (!read.contact) return { ok: false, error: "contact_not_found" };
  const result = await updateMailPreferences({
    contactId: payload.cid,
    preferences,
    source,
    campaignId: clean(payload.cmp, 80),
  });
  return !result.ok && result.error === "contact_not_found"
    ? { ok: false, error: "storage_unavailable", retryable: true }
    : result;
}

export async function unsubscribeMailToken(token, source = "rfc8058") {
  const payload = verifyToken(token, "preferences");
  if (!payload?.cid) return { ok: false, error: "invalid_token" };
  const read = await readMailContactByIdStrict(payload.cid);
  if (!read.ok) return { ok: false, error: "storage_unavailable", retryable: true };
  if (!read.contact) return { ok: false, error: "contact_not_found" };
  const result = await updateMailPreferences({
    contactId: payload.cid,
    preferences: { marketing: "denied" },
    source,
    campaignId: clean(payload.cmp, 80),
  });
  if (!result.ok && result.error === "contact_not_found") {
    return { ok: false, error: "storage_unavailable", retryable: true };
  }
  if (result.ok && payload.cmp) {
    try {
      const { recordMarketingCampaignMetric } = await import("./_marketing-campaign-queue.js");
      await recordMarketingCampaignMetric(payload.cmp, "unsubscribed", `unsubscribe:${payload.cid}`);
    } catch {}
  }
  return result;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendHtmlBeforeBody(html, addition) {
  const source = String(html || "");
  const index = source.toLowerCase().lastIndexOf("</body>");
  return index >= 0 ? `${source.slice(0, index)}${addition}${source.slice(index)}` : `${source}${addition}`;
}

function targetPath(raw, origin, campaignId) {
  const decoded = String(raw || "").replace(/&amp;/g, "&").trim();
  if (!decoded || /^(?:mailto:|tel:|javascript:|#)/i.test(decoded)) return "";
  try {
    const url = new URL(decoded, origin);
    if (url.origin !== origin) return "";
    if (/^\/api\/email\//.test(url.pathname) || url.pathname === "/email/preferences") return "";
    if (campaignId) {
      if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "email");
      if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", "marketing");
      if (!url.searchParams.has("utm_campaign")) url.searchParams.set("utm_campaign", campaignId);
    }
    return `${url.pathname}${url.search}${url.hash}`.slice(0, 800);
  } catch { return ""; }
}

export function createMarketingClickToken({ campaignId, contactId, target } = {}) {
  const safeCampaignId = clean(campaignId, 80).replace(/[^A-Za-z0-9_-]/g, "");
  const safeContactId = clean(contactId, 64).replace(/[^a-f0-9]/gi, "").toLowerCase();
  const safeTarget = clean(target, 800);
  if (!safeCampaignId || !safeContactId || !safeTarget.startsWith("/")) return "";
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    k: "click",
    cmp: safeCampaignId,
    cid: safeContactId,
    clk: randomBytes(12).toString("hex"),
    dst: safeTarget,
    iat: now,
    exp: now + CLICK_TOKEN_TTL_SECONDS,
  });
}

function rewriteMarketingLinks(html, { campaignId, contactId, siteUrl }) {
  const origin = normalizedOrigin(siteUrl);
  return String(html || "").replace(/href\s*=\s*(["'])([^"']+)\1/gi, (full, quote, href) => {
    const path = targetPath(href, origin, campaignId);
    if (!path) return full;
    const token = createMarketingClickToken({ campaignId, contactId, target: path });
    if (!token) return full;
    return `href=${quote}${origin}/api/marketing/click?token=${encodeURIComponent(token)}${quote}`;
  });
}

export async function prepareMarketingEmail(args = {}) {
  const email = normalizeEmail(Array.isArray(args.to) ? args.to[0] : args.to);
  if (!email) return { ...args };
  const en = args.locale === "en";
  const footerCopy = en ? {
    preferences: "Manage email preferences",
    unsubscribe: "Unsubscribe from marketing",
    notice: "Unsubscribing only affects marketing. Order and account-security messages are unchanged.",
  } : {
    preferences: "管理邮件偏好",
    unsubscribe: "退订营销邮件",
    notice: "退订只影响营销资讯，订单与账户安全通知不受影响。",
  };
  const campaignId = clean(args.campaignId || args.relatedId || "adhoc", 80).replace(/[^A-Za-z0-9_-]/g, "") || "adhoc";
  const siteUrl = normalizedOrigin(args.siteUrl);
  const contact = await ensureMailContact(email, { source: "marketing", locale: args.locale });
  if (!contact?.contactId) throw new Error("mail_policy_unavailable");
  const links = await mailPreferenceLinks(email, { campaignId, siteUrl });
  if (!links.token || !links.oneClickUrl || !links.preferencesUrl) throw new Error("mail_policy_unavailable");
  let html = rewriteMarketingLinks(args.html, { campaignId, contactId: contact?.contactId || "", siteUrl });
  if (html && links.preferencesUrl && !html.includes(MARKETING_FOOTER_MARKER)) {
    const footer = `<!-- ${MARKETING_FOOTER_MARKER} --><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td align="center" style="padding:13px 4px 4px;color:#7b8799;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;font-size:11px;line-height:1.7;"><a href="${escapeHtml(links.preferencesUrl)}" style="color:#53647f;text-decoration:underline;">${footerCopy.preferences}</a><span style="padding:0 8px;color:#cbd5e1;">|</span><a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#53647f;text-decoration:underline;">${footerCopy.unsubscribe}</a><br />${footerCopy.notice}</td></tr></table>`;
    if (html.includes(MARKETING_FOOTER_SLOT)) {
      html = html.replace(MARKETING_FOOTER_SLOT, footer);
    } else {
      html = appendHtmlBeforeBody(html, `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#f8fafc;"><tr><td align="center" style="padding:0 10px 20px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#f8fafc;"><tr><td>${footer}</td></tr></table></td></tr></table>`);
    }
  }
  let text = String(args.text || "");
  if (links.preferencesUrl && !text.includes(links.preferencesUrl)) {
    text += `${text ? "\n\n" : ""}${footerCopy.preferences}: ${links.preferencesUrl}\n${footerCopy.unsubscribe}: ${links.unsubscribeUrl}`;
  }
  return {
    ...args,
    html,
    text,
    campaignId,
    preferenceToken: links.token,
    preferencesUrl: links.preferencesUrl,
    unsubscribeUrl: links.unsubscribeUrl,
    oneClickUnsubscribeUrl: links.oneClickUrl,
  };
}

function isSoftBounce(eventType, reason) {
  const type = clean(eventType, 100).toLowerCase();
  const detail = clean(reason, 300).toLowerCase();
  if (type.includes("soft_bounce") || type.includes("deferred") || type.includes("delivery_delayed")) return true;
  return /(?:mailbox full|temporar|try again|rate limit|4\d\d|4\.\d\.\d)/i.test(detail);
}

export async function applyMailFeedback({ email, status = "", eventType = "", reason = "", provider = "", eventId = "", campaignId = "" } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: true, ignored: true };
  const state = clean(status, 30).toLowerCase();
  if (state === "complained") {
    // A recipient complaint is an explicit provider/user signal to stop all
    // delivery to this address. Continuing even transactional mail harms
    // sender reputation and contradicts the requested automatic block.
    return suppressMailAddress({ email: normalized, scope: "all", reason: "recipient_complaint", source: "webhook", provider, eventId, campaignId });
  }
  if (state === "suppressed") {
    return suppressMailAddress({ email: normalized, scope: "all", reason: "provider_suppressed", source: "webhook", provider, eventId, campaignId });
  }
  if (state === "bounced" && !isSoftBounce(eventType, reason)) {
    return suppressMailAddress({ email: normalized, scope: "all", reason: "hard_bounce", source: "webhook", provider, eventId, campaignId });
  }
  if (state === "bounced" || state === "delayed") {
    const contact = await mutateContact({ email: normalized, source: "webhook" }, (current) => {
      const now = new Date();
      const previousAt = new Date(current.softBounce?.lastAt || 0).getTime();
      const withinWindow = Number.isFinite(previousAt) && Date.now() - previousAt <= 7 * 24 * 60 * 60 * 1000;
      const count = withinWindow ? Number(current.softBounce?.count || 0) + 1 : 1;
      current.softBounce = {
        count,
        lastAt: now.toISOString(),
        reason: clean(reason, 200),
        provider: clean(provider, 40),
      };
      if (count >= 3) {
        current.cooldown = {
          until: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          reason: "soft_bounce_cooldown",
          source: "webhook",
          provider: clean(provider, 40),
        };
      }
      return current;
    });
    if (!contact) return { ok: false, error: "contact_not_found" };
    return { ok: true, contact, soft: true, cooldown: Boolean(contact.cooldown?.until) };
  }
  if (state === "delivered") {
    const contact = await getMailContact(normalized);
    if (contact && (contact.softBounce?.count || contact.cooldown?.until)) {
      const cleared = await mutateContact({ email: normalized, contactId: contact.contactId }, (current) => {
        current.softBounce = {};
        current.cooldown = {};
        return current;
      });
      if (!cleared) return { ok: false, error: "storage_failed" };
    }
  }
  return { ok: true, ignored: true };
}

export async function resolveMarketingClick(token) {
  const payload = verifyToken(token, "click");
  if (!payload?.cmp || !payload?.cid || !String(payload.dst || "").startsWith("/")) {
    return { ok: false, error: "invalid_token" };
  }
  const origin = normalizedOrigin();
  let destination;
  try {
    const url = new URL(payload.dst, origin);
    if (url.origin !== origin) return { ok: false, error: "invalid_target" };
    destination = url.toString();
  } catch { return { ok: false, error: "invalid_target" }; }
  const clickKey = CLICK_EVENT_PREFIX + clean(payload.clk, 80);
  const first = await redisCmd(["SET", clickKey, new Date().toISOString(), "NX", "EX", String(CLICK_TOKEN_TTL_SECONDS)]);
  const uniqueFingerprint = createHash("sha256").update(`${payload.cmp}\n${payload.cid}`).digest("hex");
  const unique = await redisCmd(["SET", UNIQUE_CLICK_PREFIX + uniqueFingerprint, new Date().toISOString(), "NX", "EX", String(CLICK_TOKEN_TTL_SECONDS)]);
  try {
    const { recordMarketingCampaignMetric } = await import("./_marketing-campaign-queue.js");
    await recordMarketingCampaignMetric(payload.cmp, "linkHits", "");
    if (unique === "OK") await recordMarketingCampaignMetric(payload.cmp, "uniqueClicks", `recipient:${payload.cid}`);
  } catch {}
  const now = Math.floor(Date.now() / 1000);
  const attributionToken = signToken({
    k: "attribution",
    cmp: clean(payload.cmp, 80),
    cid: clean(payload.cid, 64),
    clk: clean(payload.clk, 80),
    clickedAt: new Date().toISOString(),
    iat: now,
    exp: now + ATTRIBUTION_TTL_SECONDS,
  });
  return {
    ok: true,
    destination,
    attributionToken,
    firstLinkClick: first === "OK",
    uniqueRecipientClick: unique === "OK",
    cookie: `lm_mkt=${encodeURIComponent(attributionToken)}; Max-Age=${ATTRIBUTION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  };
}

function cookieValue(request, name) {
  const cookie = String(request?.headers?.get?.("cookie") || "");
  const row = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!row) return "";
  try { return decodeURIComponent(row.slice(name.length + 1)); } catch { return ""; }
}

export function marketingAttributionFromRequest(request) {
  const payload = verifyToken(cookieValue(request, "lm_mkt"), "attribution");
  if (!payload?.cmp || !payload?.clk) return null;
  return {
    campaignId: clean(payload.cmp, 80),
    clickId: clean(payload.clk, 80),
    contactId: clean(payload.cid, 64),
    source: "email",
    model: "last_email_click_30d",
    clickedAt: clean(payload.clickedAt, 80),
    attributedAt: new Date().toISOString(),
  };
}

export async function listMailSuppressions({ limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 200)));
  const indexCommands = [
    ["ZREVRANGE", CONTACT_INDEX_KEY, "0", String(Math.max(safeLimit * 3, safeLimit) - 1)],
    ["SMEMBERS", SUPPRESSED_ALL_KEY],
    ["SMEMBERS", SUPPRESSED_OPTIONAL_KEY],
    ["SMEMBERS", SUPPRESSED_MARKETING_KEY],
    ["PING"],
  ];
  const indexRows = checkedPipelineRows(await redisPipeline(indexCommands), indexCommands.length);
  if (!indexRows || indexRows[4] !== "PONG" || indexRows.slice(0, 4).some((row) => !Array.isArray(row))) {
    return { ok: false, error: "mail_policy_unavailable", suppressions: [] };
  }
  const [indexed, allIds, optionalIds, marketingIds] = indexRows;
  const ids = Array.from(new Set([
    ...allIds,
    ...optionalIds,
    ...marketingIds,
    ...indexed,
  ])).slice(0, safeLimit * 3);
  if (!ids.length) return { ok: true, suppressions: [] };
  const detailCommands = [...ids.map((id) => ["GET", contactKey(id)]), ["PING"]];
  const detailRows = checkedPipelineRows(await redisPipeline(detailCommands), detailCommands.length);
  if (!detailRows || detailRows.at(-1) !== "PONG") {
    return { ok: false, error: "mail_policy_unavailable", suppressions: [] };
  }
  const parsedRows = detailRows.slice(0, -1).map((entry) => (entry == null ? null : parseJson(entry)));
  if (parsedRows.some((entry, index) => detailRows[index] != null && (!entry || typeof entry !== "object" || Array.isArray(entry)))) {
    return { ok: false, error: "mail_policy_unavailable", suppressions: [] };
  }
  const suppressions = parsedRows
    .filter(Boolean)
    .map((entry) => normalizedContact(entry))
    .filter((entry) => entry.suppression?.scope && entry.suppression.scope !== "none")
    .sort((a, b) => String(b.suppression?.createdAt || "").localeCompare(String(a.suppression?.createdAt || "")))
    .slice(0, safeLimit);
  return { ok: true, suppressions };
}

export const mailPreferenceInternals = {
  MARKETING_FOOTER_MARKER,
  contactKey,
  isSoftBounce,
  mailSecret,
  normalizeEmail,
  suppressionBlocks,
  verifyToken,
};
