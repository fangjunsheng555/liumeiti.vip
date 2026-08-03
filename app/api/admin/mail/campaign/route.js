import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  pushAdminActionLog,
  validEmail,
} from "../../../_utils.js";
import { enqueueMarketingCampaign } from "../../../_marketing-campaign-queue.js";
import { JOB_POLICIES, MAINTENANCE_SCHEDULER } from "../../../_job-runner.js";
import { getSettings } from "../../../_settings.js";
import { withApiTelemetry } from "../../../_observability.js";
import { buildMarketingArgs } from "../marketing-data.js";
import { buildMailAudience } from "../audience-data.js";
import {
  MARKETING_MAIL_PREVIEW,
  MARKETING_MAIL_SUBJECT,
  MARKETING_MAIL_TEMPLATE_ID,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "../marketing-template.js";
import {
  MARKETING_MAIL_V7_PREVIEW,
  MARKETING_MAIL_V7_SUBJECT,
  MARKETING_MAIL_V7_TEMPLATE_ID,
  buildMarketingMailV7Html,
  buildMarketingMailV7Text,
  sanitizeMarketingMailHtml,
  validateMarketingOffer,
} from "../marketing-template-v7.js";

const MAX_RECIPIENTS_PER_REQUEST = 5;
const MAX_SEGMENT_RECIPIENTS = 500;
const MIN_SCHEDULE_AHEAD_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function recipientsFrom(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，;\n\r]+/);
  return Array.from(new Set(source.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));
}

function safeCampaignId(value) {
  return clean(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

function cleanHtml(value) {
  return sanitizeMarketingMailHtml(value);
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>|<\/table>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000);
}

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendMail) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const hasSegment = Object.prototype.hasOwnProperty.call(body, "segment") && body.segment && typeof body.segment === "object";
  let audience = null;
  let recipients = recipientsFrom(body.recipients);
  if (hasSegment) {
    const requestedLimit = body.maxRecipients == null || body.maxRecipients === "" ? MAX_SEGMENT_RECIPIENTS : Number(body.maxRecipients);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_SEGMENT_RECIPIENTS) {
      return Response.json({ ok: false, error: "invalid_recipient_limit" }, { status: 400 });
    }
    try {
      audience = await buildMailAudience({
        definition: body.segment,
        includeEmails: true,
        maxRecipients: requestedLimit,
      });
    } catch (error) {
      return Response.json({ ok: false, error: error?.message || "audience_unavailable" }, { status: error?.status === 400 ? 400 : 503 });
    }
    recipients = audience.emails || [];
  }
  const invalid = recipients.filter((email) => !validEmail(email));
  if (!recipients.length || invalid.length) {
    return Response.json({ ok: false, error: "invalid_email", invalid }, { status: 400 });
  }
  const recipientLimit = hasSegment ? MAX_SEGMENT_RECIPIENTS : MAX_RECIPIENTS_PER_REQUEST;
  if (recipients.length > recipientLimit) {
    return Response.json({ ok: false, error: "too_many_recipients", limit: recipientLimit }, { status: 400 });
  }

  const campaignId = safeCampaignId(body.campaignId);
  if (!campaignId) return Response.json({ ok: false, error: "campaign_id_required" }, { status: 400 });
  const scheduled = new Date(body.scheduledAt || "");
  const scheduledMs = scheduled.getTime();
  const now = Date.now();
  if (!Number.isFinite(scheduledMs) || scheduledMs < now + MIN_SCHEDULE_AHEAD_MS || scheduledMs > now + MAX_SCHEDULE_AHEAD_MS) {
    return Response.json({ ok: false, error: "invalid_schedule" }, { status: 400 });
  }
  const scheduledAt = scheduled.toISOString();

  const settings = await getSettings();
  const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
  const marketingArgs = await buildMarketingArgs(brandName, siteDomain, siteUrl);
  const isV7 = body.template === MARKETING_MAIL_V7_TEMPLATE_ID;
  const templateId = isV7 ? MARKETING_MAIL_V7_TEMPLATE_ID : MARKETING_MAIL_TEMPLATE_ID;
  const offerValidation = isV7 ? validateMarketingOffer(body.offer || {}) : { ok: true, offer: null };
  if (!offerValidation.ok) return Response.json({ ok: false, error: offerValidation.error }, { status: 400 });
  const offerEndsAtMs = offerValidation.offer?.endsAt ? Date.parse(offerValidation.offer.endsAt) : 0;
  if (offerEndsAtMs && offerEndsAtMs <= scheduledMs) {
    return Response.json({ ok: false, error: "offer_ends_before_schedule" }, { status: 400 });
  }
  const preview = isV7 ? MARKETING_MAIL_V7_PREVIEW : MARKETING_MAIL_PREVIEW;
  const defaultSubject = isV7 ? MARKETING_MAIL_V7_SUBJECT : MARKETING_MAIL_SUBJECT;
  const subjectBase = clean(body.subject || defaultSubject, 120) || defaultSubject;
  const subject = subjectBase.includes(brandName) ? subjectBase : `${brandName} · ${subjectBase}`;
  const customHtml = cleanHtml(body.html);
  const templateArgs = { ...marketingArgs, offer: offerValidation.offer };
  const builtHtml = isV7 ? buildMarketingMailV7Html(templateArgs) : buildMarketingMailHtml(templateArgs);
  const builtText = isV7 ? buildMarketingMailV7Text(templateArgs) : buildMarketingMailText(templateArgs);
  const html = customHtml || builtHtml;
  const text = customHtml ? (htmlToText(customHtml) || builtText) : builtText;
  const actor = adminActorFromSession(session);
  const queued = await enqueueMarketingCampaign({
    campaignId,
    recipients,
    scheduledAt,
    subject,
    html,
    text,
    preview,
    brandName,
    support: settings.support,
    actor,
    name: clean(body.name || subjectBase, 120),
    templateId,
    templateVersion: isV7 ? 7 : 6,
    locale: body.locale === "en" ? "en" : "zh",
    segmentDefinition: audience?.definition || null,
    audienceSnapshot: audience?.snapshot || {
      generatedAt: new Date().toISOString(),
      candidateCount: recipients.length,
      matchedCount: recipients.length,
      eligibleCount: recipients.length,
      selectedCount: recipients.length,
      suppressedCount: 0,
      source: "manual",
    },
    offerSnapshot: offerValidation.offer,
    productSnapshot: marketingArgs.products || [],
  });
  const scheduledCount = Number(queued.queuedCount || 0);
  const suppressedCount = Number(queued.suppressedCount || 0);
  const failedCount = Number(queued.failedCount || 0);
  if (!queued.ok && queued.error === "campaign_conflict") {
    return Response.json({ ok: false, error: "campaign_conflict", campaignId }, { status: 409 });
  }
  if (!queued.ok && queued.error === "storage_failed") {
    return Response.json({ ok: false, error: "storage_failed", campaignId }, { status: 503 });
  }
  await pushAdminActionLog({
    action: "marketing_campaign_schedule",
    actor,
    target: `campaign:${campaignId}`,
    detail: { campaignId, scheduledAt, requested: recipients.length, scheduledCount, suppressedCount, failedCount, templateId, queue: true },
  });
  return Response.json({
    ok: queued.ok && failedCount === 0,
    campaignId,
    scheduledAt,
    scheduledCount,
    suppressedCount,
    failedCount,
    audience: audience ? { definition: audience.definition, snapshot: audience.snapshot, sample: audience.sample } : null,
    queued: true,
    scheduler: {
      mode: MAINTENANCE_SCHEDULER.mode,
      cadenceMs: JOB_POLICIES.marketing_dispatch.cadenceMs,
      dispatchRule: "next_scheduler_sweep",
      maxExpectedDelayMs: JOB_POLICIES.marketing_dispatch.cadenceMs,
    },
    results: queued.results || [],
  }, { status: scheduledCount || suppressedCount ? 200 : 502 });
}

export const POST = withApiTelemetry("admin_marketing_campaign", handler);
