// Email diagnostic endpoint.
// Usage: POST /api/test-email { "to": "your@email.com" }

import { buildEmailBrandHeader } from "../email-brand.js";
import { adminSessionFromRequest, isRootAdminSession, sendSimpleEmail, validEmail } from "../_utils.js";

function emailDiagnosticEnabled() {
  return process.env.NODE_ENV !== "production"
    || process.env.ENABLE_EMAIL_TEST === "true"
    || process.env.ENABLE_SMTP_TEST === "true";
}

function maskedEnv() {
  return {
    RESEND_API_KEY: process.env.RESEND_API_KEY ? "***set***" : null,
    MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_FROM || null,
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || process.env.BRAND_NAME || null,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER || "resend",
    BREVO_FALLBACK: process.env.FALLBACK_SMTP_HOST && process.env.FALLBACK_SMTP_USER && process.env.FALLBACK_SMTP_PASS ? "***set***" : null,
  };
}

export async function POST(request) {
  if (!emailDiagnosticEnabled()) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const to = String(body.to || "").trim().toLowerCase();
  const env = maskedEnv();
  if (!validEmail(to)) {
    return Response.json({ ok: false, stage: "request", message: "Provide a valid recipient email.", env }, { status: 400 });
  }
  if (!process.env.RESEND_API_KEY && !env.BREVO_FALLBACK) {
    return Response.json({
      ok: false,
      stage: "env",
      message: "Resend 与 Brevo 发信通道均未完整配置。",
      env,
    }, { status: 500 });
  }

  const brand = process.env.MAIL_FROM_NAME || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const now = new Date().toISOString();
  const provider = String(process.env.EMAIL_PROVIDER || "resend").toLowerCase() === "smtp" ? "Brevo" : "Resend";
  const subject = `${brand} · ${provider} 测试`;
  const text = `这是一封 ${provider} 测试邮件。\n\n如果你收到了它，说明全站发信通道正常。\n\n${now}`;
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #dbe7ef;box-shadow:0 12px 34px rgba(15,23,42,.08);">
        ${buildEmailBrandHeader({ brandName: brand, siteDomain, label: provider + " Test" })}
        <tr><td style="padding:26px 26px 10px;">
          <h2 style="margin:0 0 10px;font-size:21px;font-weight:900;color:#0f172a;letter-spacing:-0.03em;">${brand} · ${provider} 测试</h2>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.75;color:#334155;">这是一封发信通道测试邮件。</p>
          <p style="margin:0;font-size:14px;line-height:1.75;color:#334155;">如果你收到了它，说明全站发信通道正常。</p>
          <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">${now}</p>
        </td></tr>
        <tr><td style="padding:12px 26px 26px;">
          <div style="border-top:1px solid #e2e8f0;padding-top:12px;font-size:12px;color:#64748b;">${siteDomain}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const result = await sendSimpleEmail({ to, subject, text, html, category: "test", fromName: brand });
  if (!result.ok) {
    return Response.json({
      ok: false,
      stage: "send",
      provider: result.provider || provider,
      message: "Email send failed.",
      error: result.reason || result.error || result.code || "send_failed",
      env,
    }, { status: 502 });
  }
  return Response.json({
    ok: true,
    stage: "sent",
    provider: result.provider || provider,
    message: `测试邮件已发送到 ${to}，请检查收件箱和垃圾邮件。`,
    messageId: result.messageId,
    env,
  });
}

export async function GET() {
  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}
