import {
  adminSessionFromRequest, adminActorFromSession,
  getRedeemCodePublic, sendSimpleEmail,
  pushAdminMailLog, pushAdminActionLog,
  validEmail, clean, adminPermissionProfile,
} from "../../../../_utils.js";
import {
  buildRedeemEmailHtml,
  buildRedeemEmailText,
  buildRedeemEmailSubject,
} from "../../redeem-email-template.js";

export async function POST(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendRedeemCodes) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromSession(session);

  const { code } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const to = String(body.email || "").trim().toLowerCase();
  if (!validEmail(to)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });

  const info = await getRedeemCodePublic(code);
  if (!info.ok) return Response.json({ ok: false, error: "code_not_found" }, { status: 404 });
  if (info.status !== "active") return Response.json({ ok: false, error: "code_unavailable" }, { status: 400 });

  const brandName = process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || `https://${siteDomain}`;
  const supportContact = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +1 4315093334 / Telegram @MaoyangSupport 联系在线客服";
  const redeemUrl = `${siteUrl.replace(/\/+$/, "")}/?redeem=${encodeURIComponent(info.code)}#redeem`;

  const subject = buildRedeemEmailSubject({
    code: info.code,
    type: info.type,
    services: info.services,
    amount: info.amount,
    brandName,
  });
  const html = buildRedeemEmailHtml({
    code: info.code,
    type: info.type,
    services: info.services,
    amount: info.amount,
    brandName,
    siteDomain,
    siteUrl,
    redeemUrl,
    supportContact,
  });
  const text = buildRedeemEmailText({
    code: info.code,
    type: info.type,
    services: info.services,
    amount: info.amount,
    brandName,
    siteUrl,
    redeemUrl,
  });

  const result = await sendSimpleEmail({
    to, subject, text, html, fromName: brandName,
  });

  const previewLine = info.type === "service"
    ? `服务码 ${info.code}：${(info.services || []).map((s) => s.label).join(" + ")}`
    : `余额码 ${info.code}：¥${Number(info.amount || 0).toFixed(2)}`;
  const log = await pushAdminMailLog({
    to, subject,
    content: previewLine + "\n（兑换链接：" + redeemUrl + "）",
    preview: previewLine,
    ok: result.ok,
    reason: result.ok ? "" : (result.reason || result.error || result.code || "send_failed"),
    messageId: result.messageId || "",
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
  });
  await pushAdminActionLog({
    action: "redeem_code_send_email",
    actor,
    target: "redeem-code:" + clean(info.code, 80),
    detail: { ok: result.ok, to, type: info.type, logId: log?.id || "" },
  });

  if (!result.ok) {
    return Response.json({
      ok: false,
      error: result.reason || "send_failed",
      detail: result.error || result.code || "",
    }, { status: 502 });
  }
  return Response.json({ ok: true, messageId: result.messageId || "", to });
}
