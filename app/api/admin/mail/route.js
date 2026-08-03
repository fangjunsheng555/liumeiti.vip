import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile,
  clean, validEmail, sendSimpleEmail, pushAdminMailLog, getAdminMailLog,
  deleteAdminMailLogEntries, pushAdminActionLog,
} from "../../_utils.js";
import { buildCustomerMailHtml, buildCustomerMailText } from "./template.js";
import {
  MARKETING_MAIL_PREVIEW,
  MARKETING_MAIL_SUBJECT,
  MARKETING_MAIL_TEMPLATE_ID,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "./marketing-template.js";
import { buildMarketingArgs } from "./marketing-data.js";
import {
  MARKETING_MAIL_V7_PREVIEW,
  MARKETING_MAIL_V7_SUBJECT,
  MARKETING_MAIL_V7_TEMPLATE_ID,
  buildMarketingMailV7Html,
  buildMarketingMailV7Text,
  sanitizeMarketingMailHtml,
  validateMarketingOffer,
} from "./marketing-template-v7.js";

function cleanMailBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 3000);
}

function cleanMailHtml(value) {
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 5000);
}

const MAX_MAIL_RECIPIENTS = 20;

function parseMailRecipients(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[,，;\n\r]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((email) => email && !seen.has(email) && seen.add(email));
}

function currentStaffPayload(session) {
  const permissions = adminPermissionProfile(session);
  return {
    id: Number(session.staffId || 1),
    username: session.staffUsername || "admin",
    root: isRootAdminSession(session),
    role: permissions.role,
    permissions,
  };
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const requestedTemplate = url.searchParams.get("template");
  if ([MARKETING_MAIL_TEMPLATE_ID, MARKETING_MAIL_V7_TEMPLATE_ID].includes(requestedTemplate)) {
    if (!adminPermissionProfile(session).canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { getSettings } = await import("../../_settings.js");
    const settings = await getSettings();
    const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
    const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
    const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
    const marketingArgs = await buildMarketingArgs(brandName, siteDomain, siteUrl);
    const isV7 = requestedTemplate === MARKETING_MAIL_V7_TEMPLATE_ID;
    return Response.json({
      ok: true,
      template: requestedTemplate,
      subject: isV7 ? MARKETING_MAIL_V7_SUBJECT : MARKETING_MAIL_SUBJECT,
      preview: isV7 ? MARKETING_MAIL_V7_PREVIEW : MARKETING_MAIL_PREVIEW,
      html: isV7 ? buildMarketingMailV7Html(marketingArgs) : buildMarketingMailHtml(marketingArgs),
      text: isV7 ? buildMarketingMailV7Text(marketingArgs) : buildMarketingMailText(marketingArgs),
    });
  }
  const logs = await getAdminMailLog();
  return Response.json({ ok: true, logs, currentStaff: currentStaffPayload(session) });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromSession(session);
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const template = [MARKETING_MAIL_TEMPLATE_ID, MARKETING_MAIL_V7_TEMPLATE_ID].includes(body.template)
    ? body.template
    : "customer";
  const isMarketingMail = template !== "customer";
  const isMarketingV7 = template === MARKETING_MAIL_V7_TEMPLATE_ID;
  const offerValidation = isMarketingV7 ? validateMarketingOffer(body.offer || {}) : { ok: true, offer: null };
  if (!offerValidation.ok) return Response.json({ ok: false, error: offerValidation.error }, { status: 400 });
  const recipients = parseMailRecipients(body.to);
  const defaultSubject = isMarketingMail ? (isMarketingV7 ? MARKETING_MAIL_V7_SUBJECT : MARKETING_MAIL_SUBJECT) : "客服服务通知";
  const subject = clean(body.subject || defaultSubject, 120) || defaultSubject;
  const content = cleanMailBody(body.content);
  const customHtml = isMarketingMail ? cleanMailHtml(body.html) : "";
  const invalidRecipients = recipients.filter((email) => !validEmail(email));
  if (recipients.length === 0 || invalidRecipients.length > 0) {
    return Response.json({
      ok: false,
      error: "invalid_email",
      detail: invalidRecipients.join(", "),
    }, { status: 400 });
  }
  if (recipients.length > MAX_MAIL_RECIPIENTS) {
    return Response.json({
      ok: false,
      error: "too_many_recipients",
      limit: MAX_MAIL_RECIPIENTS,
    }, { status: 400 });
  }
  if (!isMarketingMail && !content) return Response.json({ ok: false, error: "content_required" }, { status: 400 });

  // 品牌以站点设置为准
  const { getSettings } = await import("../../_settings.js");
  const settings = await getSettings();
  const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
  const mailSubject = subject.includes(brandName) ? subject : `${brandName} · ${subject}`;
  const marketingArgs = isMarketingMail ? await buildMarketingArgs(brandName, siteDomain, siteUrl) : null;
  const html = isMarketingMail
    ? (customHtml || (isMarketingV7
        ? buildMarketingMailV7Html({ ...marketingArgs, offer: offerValidation.offer })
        : buildMarketingMailHtml(marketingArgs)))
    : buildCustomerMailHtml({
        subject,
        content,
        brandName,
        siteDomain,
        siteUrl,
        staffId: actor.staffId,
      });
  const text = isMarketingMail
    ? (customHtml
        ? (htmlToText(customHtml) || (isMarketingV7 ? buildMarketingMailV7Text({ ...marketingArgs, offer: offerValidation.offer }) : buildMarketingMailText(marketingArgs)))
        : (isMarketingV7 ? buildMarketingMailV7Text({ ...marketingArgs, offer: offerValidation.offer }) : buildMarketingMailText(marketingArgs)))
    : buildCustomerMailText({
        subject,
        content,
        brandName,
        siteDomain,
        siteUrl,
        staffId: actor.staffId,
      });
  const marketingPreview = isMarketingV7 ? MARKETING_MAIL_V7_PREVIEW : MARKETING_MAIL_PREVIEW;
  const logContent = isMarketingMail ? (customHtml ? `${marketingPreview}（自定义 HTML）` : marketingPreview) : content;
  const campaignId = isMarketingMail
    ? (clean(body.campaignId, 80).replace(/[^A-Za-z0-9_-]/g, "") || `MCADHOC${Date.now().toString(36).toUpperCase()}`)
    : "";

  const results = [];
  const logs = [];
  for (const to of recipients) {
    const result = await sendSimpleEmail({
      to,
      subject: mailSubject,
      text,
      html,
      category: isMarketingMail ? "marketing" : "support",
      relatedType: "admin_mail",
      relatedId: campaignId,
      campaignId,
      fromName: `${brandName}客服`,
      marketing: isMarketingMail,
      support: settings.support,
      siteUrl,
      locale: body.locale === "en" ? "en" : "zh",
    });
    const reason = result.ok ? "" : (result.reason || result.error || result.code || "send_failed");
    const log = await pushAdminMailLog({
      to,
      subject: mailSubject,
      content: logContent,
      preview: logContent,
      ok: result.ok,
      reason,
      messageId: result.messageId || "",
      staffId: actor.staffId,
      staffUsername: actor.staffUsername,
      category: isMarketingMail ? "marketing" : "support",
      relatedType: "admin_mail",
      relatedId: campaignId,
      campaignId,
      template,
    });
    if (log) logs.push(log);
    results.push({
      to,
      ok: result.ok,
      suppressed: Boolean(result.suppressed),
      reason,
      messageId: result.messageId || "",
      logId: log?.id || "",
    });
  }

  const sentCount = results.filter((item) => item.ok).length;
  const suppressedCount = results.filter((item) => item.suppressed).length;
  const failedCount = results.length - sentCount - suppressedCount;
  await pushAdminActionLog({
    action: "customer_mail_send",
    actor,
    target: recipients.length === 1 ? "mail:" + recipients[0] : "mail-batch:" + recipients.length,
    detail: {
      ok: sentCount > 0,
      subject: mailSubject,
      template,
      recipients,
      sentCount,
      suppressedCount,
      failedCount,
      logIds: logs.map((item) => item.id),
    },
  });

  if (sentCount === 0 && failedCount > 0) {
    return Response.json({
      ok: false,
      error: "send_failed",
      detail: results[0]?.reason || "",
      logs,
      results,
      sentCount,
      suppressedCount,
      failedCount,
    }, { status: 502 });
  }
  return Response.json({
    ok: true,
    log: logs[0] || null,
    logs,
    results,
    sentCount,
    suppressedCount,
    failedCount,
    messageId: results.find((item) => item.messageId)?.messageId || "",
  });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteAdminMailLogEntries(ids, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
  return Response.json(result);
}
