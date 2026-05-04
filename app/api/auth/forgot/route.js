import {
  validEmail, getUser, setResetCode, sendSimpleEmail,
} from "../../_utils.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";

function generateCode() {
  // 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!validEmail(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const user = await getUser(email);
  // For security, return the same response whether or not the email is registered
  // (don't leak which emails are users). But still attempt to send if registered.
  if (user) {
    const code = generateCode();
    await setResetCode(email, code, 600);
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
      <tr><td style="padding:24px 32px;background:linear-gradient(135deg,#0f172a 0%,#0f766e 100%);color:#fff;">
        <div style="font-size:17px;font-weight:800;letter-spacing:-0.02em;">${BRAND_NAME}</div>
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.7);margin-top:2px;">Password Reset</div>
      </td></tr>
      <tr><td style="padding:30px 32px 14px;">
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:900;color:#0f172a;letter-spacing:-0.02em;">找回密码验证码</h2>
        <p style="margin:0 0 18px;font-size:13.5px;color:#475569;line-height:1.7;">您正在重置 ${BRAND_NAME} 账号密码。请在 10 分钟内输入下方验证码完成重置。如果不是您本人操作,请忽略此邮件。</p>
        <div style="margin:0 auto;padding:18px 24px;border-radius:14px;background:#f0fdfa;border:1px solid #a7f3d0;text-align:center;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">验证码</div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:900;color:#134e4a;letter-spacing:0.18em;">${code}</div>
          <div style="font-size:11px;color:#0f766e;margin-top:6px;">有效期 10 分钟</div>
        </div>
      </td></tr>
      <tr><td style="padding:14px 32px 28px;">
        <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.6;">本邮件由系统自动发送,请勿直接回复。如非本人操作,请忽略。</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    const text = `${BRAND_NAME} 密码重置\n\n验证码: ${code}\n有效期 10 分钟\n\n如非本人操作,请忽略此邮件。`;
    // Important: await the send so Vercel serverless doesn't kill the
    // function before the SMTP transaction finishes. Fire-and-forget
    // was causing emails to never reach iCloud's queue.
    const result = await sendSimpleEmail({
      to: email,
      subject: `${BRAND_NAME} · 密码重置验证码 ${code}`,
      text, html,
    });
    if (!result.ok) {
      console.error("[forgot] email failed:", result);
    }
  }

  return Response.json({ ok: true, sent: true });
}
