import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
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

function currentStaffPayload(session) {
  return {
    id: Number(session.staffId || 1),
    username: session.staffUsername || "admin",
    root: isRootAdminSession(session),
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
  const actor = adminActorFromSession(session);
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const to = String(body.to || "").trim().toLowerCase();
  const subject = clean(body.subject || "客服服务通知", 120) || "客服服务通知";
  const content = cleanMailBody(body.content);
  if (!validEmail(to)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  if (!content) return Response.json({ ok: false, error: "content_required" }, { status: 400 });

  const brandName = process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://liumeiti.vip";
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

  const result = await sendSimpleEmail({
    to,
    subject: mailSubject,
    text,
    html,
    fromName: "冒央会社客服人员",
  });
  const log = await pushAdminMailLog({
    to,
    subject: mailSubject,
    content,
    preview: content,
    ok: result.ok,
    reason: result.ok ? "" : (result.reason || result.error || result.code || "send_failed"),
    messageId: result.messageId || "",
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
  });
  await pushAdminActionLog({
    action: "customer_mail_send",
    actor,
    target: "mail:" + to,
    detail: { ok: result.ok, subject: mailSubject, logId: log?.id || "" },
  });

  if (!result.ok) {
    return Response.json({
      ok: false,
      error: result.reason || "send_failed",
      detail: result.error || result.code || "",
      log,
    }, { status: 502 });
  }
  return Response.json({ ok: true, log, messageId: result.messageId || "" });
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
