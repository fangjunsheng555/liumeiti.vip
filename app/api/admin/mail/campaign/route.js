import { createHash } from "node:crypto";
import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  pushAdminActionLog,
  pushAdminMailLog,
  sendSimpleEmail,
  validEmail,
} from "../../../_utils.js";
import { getSettings } from "../../../_settings.js";
import { buildMarketingArgs } from "../marketing-data.js";
import {
  MARKETING_MAIL_PREVIEW,
  MARKETING_MAIL_SUBJECT,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "../marketing-template.js";

const MAX_RECIPIENTS_PER_REQUEST = 5;
const MIN_SCHEDULE_AHEAD_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function recipientsFrom(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，;\n\r]+/);
  return Array.from(new Set(source.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));
}

function safeCampaignId(value) {
  return clean(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

function recipientKey(campaignId, email, scheduledAt) {
  const digest = createHash("sha256").update(`${campaignId}:${email}:${scheduledAt}`).digest("hex").slice(0, 32);
  return `campaign/${campaignId}/${digest}`;
}

function cleanHtml(value) {
  return String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim().slice(0, 120000);
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

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendMail) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const recipients = recipientsFrom(body.recipients);
  const invalid = recipients.filter((email) => !validEmail(email));
  if (!recipients.length || invalid.length) {
    return Response.json({ ok: false, error: "invalid_email", invalid }, { status: 400 });
  }
  if (recipients.length > MAX_RECIPIENTS_PER_REQUEST) {
    return Response.json({ ok: false, error: "too_many_recipients", limit: MAX_RECIPIENTS_PER_REQUEST }, { status: 400 });
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
  const subjectBase = clean(body.subject || MARKETING_MAIL_SUBJECT, 120) || MARKETING_MAIL_SUBJECT;
  const subject = subjectBase.includes(brandName) ? subjectBase : `${brandName} · ${subjectBase}`;
  const customHtml = cleanHtml(body.html);
  const html = customHtml || buildMarketingMailHtml(marketingArgs);
  const text = customHtml ? (htmlToText(customHtml) || buildMarketingMailText(marketingArgs)) : buildMarketingMailText(marketingArgs);
  const actor = adminActorFromSession(session);
  const results = [];

  for (let index = 0; index < recipients.length; index += 1) {
    const to = recipients[index];
    const result = await sendSimpleEmail({
      to,
      subject,
      html,
      text,
      fromName: brandName,
      marketing: true,
      category: "marketing",
      relatedType: "scheduled_campaign",
      relatedId: campaignId,
      scheduledAt,
      idempotencyKey: recipientKey(campaignId, to, scheduledAt),
      support: settings.support,
    });
    const reason = result?.ok ? "" : clean(result?.reason || result?.error || result?.code || "schedule_failed", 180);
    await pushAdminMailLog({
      to,
      subject,
      content: `${MARKETING_MAIL_PREVIEW}（计划发送：${scheduledAt}）`,
      preview: MARKETING_MAIL_PREVIEW,
      ok: Boolean(result?.ok),
      reason,
      messageId: result?.messageId || "",
      scheduledAt,
      staffId: actor.staffId,
      staffUsername: actor.staffUsername,
    });
    results.push({ to, ok: Boolean(result?.ok), reason, messageId: result?.messageId || "", scheduledAt });
    if (index < recipients.length - 1) await new Promise((resolve) => setTimeout(resolve, 260));
  }

  const scheduledCount = results.filter((item) => item.ok).length;
  await pushAdminActionLog({
    action: "marketing_campaign_schedule",
    actor,
    target: `campaign:${campaignId}`,
    detail: { campaignId, scheduledAt, requested: recipients.length, scheduledCount, failedCount: recipients.length - scheduledCount },
  });
  return Response.json({
    ok: scheduledCount === recipients.length,
    campaignId,
    scheduledAt,
    scheduledCount,
    failedCount: recipients.length - scheduledCount,
    results,
  }, { status: scheduledCount ? 200 : 502 });
}
