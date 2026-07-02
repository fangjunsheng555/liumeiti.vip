import {
  validEmail, getUser, setResetCode, sendSimpleEmail,
  checkRateLimit, rateLimitResponse, generateNumericCode, getCookieFromRequest,
} from "../../_utils.js";
import { buildEmailBrandHeader } from "../../email-brand.js";
import { getSettings } from "../../_settings.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";

function generateCode() {
  return generateNumericCode(6);
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const guard = await checkRateLimit(request, {
    namespace: "auth:forgot",
    limit: 4,
    windowSec: 15 * 60,
    identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard, "验证码请求过多，请稍后再试");

  const user = await getUser(email);
  // For security, return the same response whether or not the email is registered
  // (don't leak which emails are users). But still attempt to send if registered.
  const en = getCookieFromRequest(request, "locale") === "en";
  const L = (zh, e) => (en ? e : zh);
  if (user) {
    const code = generateCode();
    await setResetCode(email, code, 600);
    // 品牌名以站点设置为准(与全站显示一致)
    const settings = await getSettings();
    const brandName = (en ? settings.brand.nameEn : settings.brand.name) || BRAND_NAME;
    const html = `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
      ${buildEmailBrandHeader({ brandName, siteDomain: SITE_DOMAIN, label: L("密码重置", "Password Reset") })}
      <tr><td style="padding:30px 32px 14px;">
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:900;color:#0f172a;letter-spacing:-0.02em;">${L("找回密码验证码", "Password reset code")}</h2>
        <p style="margin:0 0 18px;font-size:13.5px;color:#475569;line-height:1.7;">${L(`您正在重置 ${brandName} 账号密码。请在 10 分钟内输入下方验证码完成重置。如果不是您本人操作,请忽略此邮件`, `You're resetting your ${brandName} account password. Enter the code below within 10 minutes to finish. If this wasn't you, please ignore this email.`)}</p>
        <div style="margin:0 auto;padding:18px 24px;border-radius:14px;background:#f0fdfa;border:1px solid #a7f3d0;text-align:center;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">${L("验证码", "Code")}</div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:900;color:#134e4a;letter-spacing:0.18em;">${code}</div>
          <div style="font-size:11px;color:#0f766e;margin-top:6px;">${L("有效期 10 分钟", "Valid for 10 minutes")}</div>
        </div>
      </td></tr>
      <tr><td style="padding:14px 32px 28px;">
        <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.6;">${L("本邮件由系统自动发送,请勿直接回复。如非本人操作,请忽略", "This email was sent automatically — please don't reply. If this wasn't you, ignore it.")}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    const text = L(`${brandName} 密码重置\n\n验证码: ${code}\n有效期 10 分钟\n\n如非本人操作,请忽略此邮件`, `${brandName} password reset\n\nCode: ${code}\nValid for 10 minutes\n\nIf this wasn't you, please ignore this email.`);
    // Important: await the send so Vercel serverless doesn't kill the
    // function before the SMTP transaction finishes. Fire-and-forget
    // was causing emails to never reach iCloud's queue.
    const result = await sendSimpleEmail({
      to: email,
      subject: L(`${brandName} · 密码重置验证码 ${code}`, `${brandName} · Password reset code ${code}`),
      text, html,
    });
    if (!result.ok) {
      console.error("[forgot] email failed:", result);
    }
  }

  return Response.json({ ok: true, sent: true });
}
