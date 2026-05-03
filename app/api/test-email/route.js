// SMTP diagnostic endpoint
// Usage: curl -X POST http://localhost:3000/api/test-email -H "content-type: application/json" -d '{"to":"your@email.com"}'

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {}
  const to = String(body.to || "").trim();

  const env = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS ? "***set***" : null,
    SMTP_FROM: process.env.SMTP_FROM,
    BRAND_NAME: process.env.BRAND_NAME,
  };

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return Response.json({
      ok: false,
      stage: "env",
      message: "SMTP env vars missing. Restart the dev server after editing .env.local",
      env,
    }, { status: 500 });
  }

  if (!to) {
    return Response.json({
      ok: false,
      stage: "request",
      message: "Provide a recipient: { to: 'you@example.com' }",
      env,
    }, { status: 400 });
  }

  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch (e) {
    return Response.json({ ok: false, stage: "import", error: e.message, env }, { status: 500 });
  }

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: false,
  });

  // Step 1: verify connection + auth
  try {
    await transporter.verify();
  } catch (e) {
    return Response.json({
      ok: false,
      stage: "verify",
      message: "SMTP connection or auth failed. Check SMTP_USER/SMTP_PASS (must be app-specific password from appleid.apple.com).",
      error: e.message,
      code: e.code,
      response: e.response,
      env,
    }, { status: 502 });
  }

  // Step 2: send test message
  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const brand = process.env.BRAND_NAME || "冒央会社";
    const info = await transporter.sendMail({
      from: `"${brand}" <${from}>`,
      to,
      subject: `${brand} · SMTP 测试`,
      text: `这是一封 SMTP 测试邮件。\n\n如果你收到了它,说明 SMTP 配置正常。\n\n${new Date().toISOString()}`,
      html: `<div style="font-family:sans-serif;padding:24px"><h2>${brand} · SMTP 测试</h2><p>这是一封 SMTP 测试邮件。</p><p>如果你收到了它,说明 SMTP 配置正常。</p><p style="color:#888;font-size:12px">${new Date().toISOString()}</p></div>`,
    });
    return Response.json({
      ok: true,
      stage: "sent",
      message: `测试邮件已发到 ${to},请检查收件箱(也看垃圾邮件)`,
      messageId: info.messageId,
      response: info.response,
      env,
    });
  } catch (e) {
    return Response.json({
      ok: false,
      stage: "sendMail",
      message: "Verification passed but sendMail failed.",
      error: e.message,
      code: e.code,
      response: e.response,
      env,
    }, { status: 502 });
  }
}
