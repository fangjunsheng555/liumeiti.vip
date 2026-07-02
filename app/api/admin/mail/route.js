import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile,
  clean, validEmail, sendSimpleEmail, pushAdminMailLog, getAdminMailLog,
  deleteAdminMailLogEntries, pushAdminActionLog,
} from "../../_utils.js";
import { buildCustomerMailHtml, buildCustomerMailText } from "./template.js";

function cleanMailBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 3000);
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

  const recipients = parseMailRecipients(body.to);
  const subject = clean(body.subject || "客服服务通知", 120) || "客服服务通知";
  const content = cleanMailBody(body.content);
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
  if (!content) return Response.json({ ok: false, error: "content_required" }, { status: 400 });

  // 品牌以站点设置为准
  const { getSettings } = await import("../../_settings.js");
  const settings = await getSettings();
  const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
  const mailSubject = subject.includes(brandName) ? subject : `${brandName} · ${subject}`;
  const html = buildCustomerMailHtml({
    subject,
    content,
    brandName,
    siteDomain,
    siteUrl,
    staffId: actor.staffId,
  });
  const text = buildCustomerMailText({
    subject,
    content,
    brandName,
    siteDomain,
    siteUrl,
    staffId: actor.staffId,
  });

  const results = [];
  const logs = [];
  for (const to of recipients) {
    const result = await sendSimpleEmail({
      to,
      subject: mailSubject,
      text,
      html,
      fromName: `${brandName}客服`,
    });
    const reason = result.ok ? "" : (result.reason || result.error || result.code || "send_failed");
    const log = await pushAdminMailLog({
      to,
      subject: mailSubject,
      content,
      preview: content,
      ok: result.ok,
      reason,
      messageId: result.messageId || "",
      staffId: actor.staffId,
      staffUsername: actor.staffUsername,
    });
    if (log) logs.push(log);
    results.push({
      to,
      ok: result.ok,
      reason,
      messageId: result.messageId || "",
      logId: log?.id || "",
    });
  }

  const sentCount = results.filter((item) => item.ok).length;
  const failedCount = results.length - sentCount;
  await pushAdminActionLog({
    action: "customer_mail_send",
    actor,
    target: recipients.length === 1 ? "mail:" + recipients[0] : "mail-batch:" + recipients.length,
    detail: {
      ok: sentCount > 0,
      subject: mailSubject,
      recipients,
      sentCount,
      failedCount,
      logIds: logs.map((item) => item.id),
    },
  });

  if (sentCount === 0) {
    return Response.json({
      ok: false,
      error: "send_failed",
      detail: results[0]?.reason || "",
      logs,
      results,
      sentCount,
      failedCount,
    }, { status: 502 });
  }
  return Response.json({
    ok: true,
    log: logs[0] || null,
    logs,
    results,
    sentCount,
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
