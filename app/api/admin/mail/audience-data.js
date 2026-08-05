import { createHash } from "node:crypto";
import { getAllOrdersStrict, listAllUserEmailsStrict, validEmail } from "../../_utils.js";
import { getMailSendDecisionsBatch } from "../../_mail-preferences.js";
import { isRecognizedSale, orderValueBreakdown } from "../insights/metrics.js";
import { orderExpirySummary } from "../../../lib/order-expiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 5000;
const MAX_MANUAL_RECIPIENTS = 2000;

export function mailAudienceSnapshotHash(emails) {
  const selected = Array.from(new Set((Array.isArray(emails) ? emails : [])
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(validEmail))).sort();
  return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}

function emailsOf(order) {
  return Array.from(new Set([order?.userEmail, order?.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(validEmail)));
}

function uniqueStrings(value, allowed = null) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(rows.map((item) => String(item || "").trim().toLowerCase()).filter((item) => item && (!allowed || allowed.has(item)))));
}

export function normalizeManualMailRecipients(value) {
  const rows = Array.isArray(value) ? value : String(value || "").split(/[,，;\n\r]+/);
  const seen = new Set();
  const emails = [];
  let invalidCount = 0;
  for (const row of rows.slice(0, MAX_MANUAL_RECIPIENTS + 1)) {
    const email = String(row || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (!validEmail(email)) {
      invalidCount += 1;
      continue;
    }
    emails.push(email);
  }
  return {
    emails: emails.slice(0, MAX_MANUAL_RECIPIENTS),
    invalidCount: invalidCount + Math.max(0, emails.length - MAX_MANUAL_RECIPIENTS),
    truncated: rows.length > MAX_MANUAL_RECIPIENTS,
  };
}

function segmentError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 400;
  return error;
}

function segmentNumber(value, name, { integer = false, nonnegative = true } = {}) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || (nonnegative && number < 0)) {
    throw segmentError(`invalid_segment_${name}`);
  }
  return number;
}

function segmentDate(value, name) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!Number.isFinite(Date.parse(raw))) throw segmentError(`invalid_segment_${name}`);
  return raw.slice(0, 40);
}

function isoTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function reliableLocale(value) {
  return value === "en" || value === "zh" ? value : "";
}

function serviceKeysOf(order) {
  if (Array.isArray(order?.items) && order.items.length) {
    return order.items
      .map((item) => String(item?.service || item?.key || "").trim().toLowerCase())
      .filter(Boolean);
  }
  // Historical orders predate `items`. Prefer their top-level service key;
  // records from an even older shape may only retain the selected plan.
  const legacy = String(order?.service || order?.plan || order?.rocketPlan || "").trim().toLowerCase();
  return legacy ? [legacy] : [];
}

export function normalizeMailSegmentDefinition(value = {}) {
  const sourceSet = new Set(["registered", "customer", "order_contact", "manual"]);
  const localeSet = new Set(["zh", "en", "unknown"]);
  const hasSources = Object.hasOwn(value, "sources");
  const rawSources = Array.isArray(value.sources) ? value.sources : value.sources ? [value.sources] : [];
  const sources = uniqueStrings(rawSources, sourceSet);
  if (hasSources && (!rawSources.length || sources.length !== rawSources.length)) throw segmentError("invalid_segment_sources");
  const hasLocales = Object.hasOwn(value, "locales") || Object.hasOwn(value, "locale");
  const rawLocaleValue = Object.hasOwn(value, "locales") ? value.locales : value.locale;
  const rawLocales = Array.isArray(rawLocaleValue) ? rawLocaleValue : rawLocaleValue ? [rawLocaleValue] : [];
  const locales = uniqueStrings(rawLocales, localeSet);
  if (hasLocales && locales.length !== rawLocales.length) throw segmentError("invalid_segment_locales");
  const lastPurchaseWithinDays = segmentNumber(value.lastPurchaseWithinDays, "last_purchase_days");
  const lastPurchaseAfter = segmentDate(value.lastPurchaseAfter, "last_purchase_after");
  const lastPurchaseBefore = segmentDate(value.lastPurchaseBefore, "last_purchase_before");
  const minSpend = segmentNumber(value.minSpend, "min_spend");
  const maxSpend = segmentNumber(value.maxSpend, "max_spend");
  const minOrders = segmentNumber(value.minOrders, "min_orders", { integer: true });
  const maxOrders = segmentNumber(value.maxOrders, "max_orders", { integer: true });
  const expiryFromDays = segmentNumber(value.expiryFromDays, "expiry_from_days", { nonnegative: false });
  const expiryWithinDays = segmentNumber(value.expiryWithinDays, "expiry_within_days", { nonnegative: false });
  if (minSpend != null && maxSpend != null && minSpend > maxSpend) throw segmentError("invalid_segment_spend_range");
  if (minOrders != null && maxOrders != null && minOrders > maxOrders) throw segmentError("invalid_segment_order_range");
  if (lastPurchaseAfter && lastPurchaseBefore && Date.parse(lastPurchaseAfter) > Date.parse(lastPurchaseBefore)) {
    throw segmentError("invalid_segment_purchase_range");
  }
  if (expiryFromDays != null && expiryWithinDays != null && expiryFromDays > expiryWithinDays) {
    throw segmentError("invalid_segment_expiry_range");
  }
  return {
    sources: hasSources ? sources : ["registered", "customer"],
    locales,
    serviceKeys: uniqueStrings(value.serviceKeys).slice(0, 20),
    lastPurchaseWithinDays,
    lastPurchaseAfter,
    lastPurchaseBefore,
    minSpend,
    maxSpend,
    minOrders,
    maxOrders,
    expiryFromDays,
    expiryWithinDays,
    requireMarketingAllowed: value.requireMarketingAllowed !== false,
  };
}

function profileFor(map, email) {
  if (!map.has(email)) {
    map.set(email, {
      email,
      sources: new Set(),
      services: new Set(),
      locales: new Set(),
      orderCount: 0,
      lifetimeSpend: 0,
      lastPurchaseAt: "",
      lastPurchaseMs: 0,
      orderLocaleMs: 0,
      expiryDays: [],
    });
  }
  return map.get(email);
}

function matchesSegment(profile, definition, now) {
  if (!definition.sources.some((source) => profile.sources.has(source))) return false;
  if (definition.locales.length && !definition.locales.some((locale) => profile.locales.has(locale))) return false;
  if (definition.serviceKeys.length && !definition.serviceKeys.some((key) => profile.services.has(key))) return false;

  const needsPurchase = definition.lastPurchaseWithinDays != null
    || definition.lastPurchaseAfter
    || definition.lastPurchaseBefore
    || definition.minSpend != null
    || definition.maxSpend != null
    || definition.minOrders != null
    || definition.maxOrders != null
    || definition.expiryFromDays != null
    || definition.expiryWithinDays != null;
  if (needsPurchase && profile.orderCount < 1) return false;

  if (definition.lastPurchaseWithinDays != null) {
    const cutoff = now - Math.max(0, definition.lastPurchaseWithinDays) * DAY_MS;
    if (!profile.lastPurchaseMs || profile.lastPurchaseMs < cutoff) return false;
  }
  const after = isoTime(definition.lastPurchaseAfter);
  const before = isoTime(definition.lastPurchaseBefore);
  if (after && profile.lastPurchaseMs < after) return false;
  if (before && profile.lastPurchaseMs > before + DAY_MS - 1) return false;
  if (definition.minSpend != null && profile.lifetimeSpend < definition.minSpend) return false;
  if (definition.maxSpend != null && profile.lifetimeSpend > definition.maxSpend) return false;
  if (definition.minOrders != null && profile.orderCount < definition.minOrders) return false;
  if (definition.maxOrders != null && profile.orderCount > definition.maxOrders) return false;
  if (definition.expiryFromDays != null || definition.expiryWithinDays != null) {
    const lower = definition.expiryFromDays == null ? Number.NEGATIVE_INFINITY : definition.expiryFromDays;
    const upper = definition.expiryWithinDays == null ? Number.POSITIVE_INFINITY : definition.expiryWithinDays;
    if (!profile.expiryDays.some((days) => days >= lower && days <= upper)) return false;
  }
  return true;
}

function maskedEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "***";
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

export async function buildMailAudience({ definition = {}, manualEmails = [], includeEmails = false, maxRecipients = 500, now = Date.now() } = {}) {
  const segment = normalizeMailSegmentDefinition(definition);
  const manual = normalizeManualMailRecipients(manualEmails);
  const [registeredEmails, orders] = await Promise.all([listAllUserEmailsStrict(), getAllOrdersStrict()]);
  const profiles = new Map();
  let sourceTruncated = registeredEmails.length > MAX_CANDIDATES;

  for (const email of manual.emails) {
    const profile = profileFor(profiles, email);
    profile.sources.add("manual");
  }

  for (const raw of registeredEmails.slice(0, MAX_CANDIDATES)) {
    const email = String(raw || "").trim().toLowerCase();
    if (!validEmail(email)) continue;
    if (!profiles.has(email) && profiles.size >= MAX_CANDIDATES) {
      sourceTruncated = true;
      continue;
    }
    const profile = profileFor(profiles, email);
    profile.sources.add("registered");
  }

  for (const order of orders) {
    const orderEmails = emailsOf(order);
    if (!orderEmails.length) continue;
    const orderMs = isoTime(order.completedAt || order.createdAt);
    const locale = reliableLocale(order.locale);
    const services = serviceKeysOf(order);
    const recognizedSale = isRecognizedSale(order);
    const gross = recognizedSale ? orderValueBreakdown(order).gross : 0;
    const expiryDays = recognizedSale
      ? (orderExpirySummary(order, now)?.items || []).map((item) => Number(item.daysLeft)).filter(Number.isFinite)
      : [];
    for (const email of orderEmails) {
      if (!profiles.has(email) && profiles.size >= MAX_CANDIDATES) {
        sourceTruncated = true;
        continue;
      }
      const profile = profileFor(profiles, email);
      profile.sources.add("order_contact");
      if (locale && orderMs >= profile.orderLocaleMs) {
        profile.locales.clear();
        profile.locales.add(locale);
        profile.orderLocaleMs = orderMs;
      }
      services.forEach((service) => profile.services.add(service));
      if (!recognizedSale) continue;
      profile.sources.add("customer");
      profile.orderCount += 1;
      profile.lifetimeSpend = round2(profile.lifetimeSpend + gross);
      if (orderMs > profile.lastPurchaseMs) {
        profile.lastPurchaseMs = orderMs;
        profile.lastPurchaseAt = new Date(orderMs).toISOString();
      }
      if (expiryDays.length) profile.expiryDays.push(...expiryDays);
    }
  }

  const candidates = Array.from(profiles.values());
  // The mail contact locale is an explicit account preference and therefore
  // outranks an older order locale. Fetch the same batched contact snapshot
  // used for suppression before applying locale filters; otherwise a legacy
  // order without `locale` can never enter its user's chosen language segment.
  const policy = await getMailSendDecisionsBatch({
    emails: candidates.map((profile) => profile.email),
    purpose: "marketing",
    category: "marketing",
    marketing: true,
  });
  if (!policy.ok && segment.requireMarketingAllowed) throw new Error(policy.error || "mail_policy_unavailable");
  if (policy.ok) {
    if (segment.requireMarketingAllowed && candidates.some((profile) => {
      const decision = policy.decisions.get(profile.email);
      return !decision || decision.retryable || decision.policyUnavailable || decision.reason === "mail_policy_unavailable";
    })) {
      throw new Error("mail_policy_unavailable");
    }
    for (const profile of candidates) {
      const contactLocale = reliableLocale(policy.decisions.get(profile.email)?.contact?.locale);
      if (!contactLocale) continue;
      profile.locales.clear();
      profile.locales.add(contactLocale);
    }
  }

  for (const profile of profiles.values()) {
    if (!profile.locales.size) profile.locales.add("unknown");
  }

  const matching = candidates
    .filter((profile) => (
      (segment.sources.includes("manual") && profile.sources.has("manual"))
      || matchesSegment(profile, segment, now)
    ))
    .sort((left, right) => Number(right.sources.has("manual")) - Number(left.sources.has("manual"))
      || right.lastPurchaseMs - left.lastPurchaseMs || left.email.localeCompare(right.email));

  const eligible = [];
  const excluded = [];
  matching.forEach((profile) => {
    const decision = segment.requireMarketingAllowed
      ? policy.decisions.get(profile.email)
      : { allowed: true };
    if (decision?.allowed) eligible.push(profile);
    else excluded.push({ email: profile.email, reason: decision?.reason || "suppressed" });
  });

  const limit = Math.max(1, Math.min(2000, Number(maxRecipients || 500)));
  const selected = eligible.slice(0, limit);
  const snapshotHash = mailAudienceSnapshotHash(selected.map((profile) => profile.email));
  const sample = selected.slice(0, 20).map((profile) => ({
    email: maskedEmail(profile.email),
    sources: Array.from(profile.sources),
    locale: profile.locales.has("en") ? "en" : profile.locales.has("zh") ? "zh" : "unknown",
    services: Array.from(profile.services),
    orderCount: profile.orderCount,
    lifetimeSpend: profile.lifetimeSpend,
    lastPurchaseAt: profile.lastPurchaseAt,
    nearestExpiryDays: profile.expiryDays.length ? Math.min(...profile.expiryDays) : null,
  }));

  return {
    definition: segment,
    snapshotHash,
    snapshot: {
      generatedAt: new Date(now).toISOString(),
      candidateCount: profiles.size,
      matchedCount: matching.length,
      eligibleCount: eligible.length,
      selectedCount: selected.length,
      suppressedCount: excluded.length,
      truncated: sourceTruncated || eligible.length > selected.length,
      sourceTruncated,
      manualCandidateCount: manual.emails.length,
      invalidManualCount: manual.invalidCount,
      manualTruncated: manual.truncated,
    },
    sample,
    excluded: excluded.slice(0, 20).map((item) => ({ ...item, email: maskedEmail(item.email) })),
    ...(includeEmails ? { emails: selected.map((profile) => profile.email) } : {}),
  };
}
