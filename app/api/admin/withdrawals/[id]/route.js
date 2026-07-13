import {
  adminSessionFromRequest, adminActorFromSession, adminPermissionProfile,
  getWithdrawalDetail, updateWithdrawalStatus, clean, sendSimpleEmail,
} from "../../../_utils.js";
import { buildEmailBrandHeader } from "../../../email-brand.js";
import { getSettings } from "../../../_settings.js";
import { supportHtml, supportText } from "../../../../lib/settings-defaults.js";

const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";

// 审核结果邮件(仅状态真正变为 提现成功/审核失败 时发;发送失败静默,不影响审核操作)。
async function sendWithdrawalResultEmail(withdrawal) {
  try {
    const to = String(withdrawal?.userEmail || "").trim();
    if (!to) return null;
    const settings = await getSettings();
    const brandName = settings.brand.name || "冒央会社";
    const support = supportText(settings.support, "zh");
    const supportLinks = supportHtml(settings.support, "zh");
    const okStatus = withdrawal.status === "success";
    const amount = Number(withdrawal.amount || 0).toFixed(2);
    const title = okStatus ? "提现已完成" : "提现审核未通过";
    const bodyLine = okStatus
      ? `您申请的提现 ¥${amount} 已审核通过并完成转账,请留意支付宝(${withdrawal.alipayAccount || "-"})到账。`
      : `您申请的提现 ¥${amount} 未通过审核,款项已全额退回账户余额,可在「我的账户」查看。${withdrawal.reviewNote ? `原因:${withdrawal.reviewNote}` : ""}`;
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
      ${buildEmailBrandHeader({ brandName, siteDomain: SITE_DOMAIN, label: "提现通知" })}
      <tr><td style="padding:30px 32px 14px;">
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:900;color:${okStatus ? "#047857" : "#b45309"};letter-spacing:-0.02em;">${title}</h2>
        <p style="margin:0 0 18px;font-size:13.5px;color:#475569;line-height:1.8;">${bodyLine}</p>
        <div style="padding:14px 18px;border-radius:12px;background:${okStatus ? "#ecfdf5" : "#fffbeb"};border:1px solid ${okStatus ? "#a7f3d0" : "#fde68a"};font-size:13px;color:#334155;line-height:1.9;">
          金额:<b>¥${amount}</b><br>状态:<b>${withdrawal.statusLabel || ""}</b><br>时间:${withdrawal.updatedAtBeijing || ""}
        </div>
      </td></tr>
      <tr><td style="padding:14px 32px 28px;">
        <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.7;">${supportLinks}<br>本邮件由系统自动发送，请勿直接回复。</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    const text = `${brandName} 提现通知\n\n${title}\n${bodyLine}\n金额: ¥${amount}\n时间: ${withdrawal.updatedAtBeijing || ""}\n\n${support}`;
    return await sendSimpleEmail({
      to,
      category: "withdrawal",
      relatedType: "withdrawal",
      relatedId: withdrawal.id,
      subject: `${okStatus ? "✅" : "⚠️"} ${title} · ¥${amount} · ${brandName}`,
      text, html, fromName: brandName, support: settings.support, locale: "zh",
    });
  } catch (e) { return null; }
}

export async function GET(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const detail = await getWithdrawalDetail(id);
  if (!detail) return Response.json({ ok: false, error: "withdrawal_not_found" }, { status: 404 });
  return Response.json({ ok: true, ...detail });
}

export async function PATCH(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canReviewWithdrawals) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}

  // 记录变更前状态:只在「真正变为 成功/失败」时给用户发结果邮件(重复保存不重发)。
  const before = await getWithdrawalDetail(id);
  const oldStatus = before?.withdrawal?.status || "pending";

  const result = await updateWithdrawalStatus(id, body.status, body.reviewNote, adminActorFromSession(session));
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code }, { status: 400 });
  }

  let notice = null;
  const newStatus = result.withdrawal?.status;
  if ((newStatus === "success" || newStatus === "failed") && newStatus !== oldStatus) {
    notice = await sendWithdrawalResultEmail(result.withdrawal);
  }

  const detail = await getWithdrawalDetail(id);
  return Response.json({ ok: true, ...detail, notice: notice ? { ok: !!notice.ok } : null });
}
