function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) { return "¥" + Number(value || 0).toFixed(0); }

export function buildCompletionEmailHtml({ order, brandName, siteDomain, siteUrl, supportContact }) {
  const items = Array.isArray(order.items) ? order.items : [];
  const isUsdt = order.paymentMethod === "usdt";
  const orderQueryUrl = `${siteUrl || "https://" + (siteDomain || "")}/?order=${encodeURIComponent(order.orderId)}`;

  const itemsRows = items.map((it, idx) => {
    // Use staff-filled credentials if present, otherwise buyer's
    const account = it.staffAccount || it.account;
    const password = it.staffPassword || it.password;
    const accountRow = account
      ? `<div style="margin-top:6px;font-size:12.5px;color:#475569;line-height:1.7;">
          <span style="color:#94a3b8;">${it.service === "rocket" ? "用户名" : "账号"}:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:700;background:#f8fafc;padding:1px 6px;border-radius:4px;">${escapeHtml(account)}</span>
        </div>`
      : "";
    const passwordRow = password
      ? `<div style="font-size:12.5px;color:#475569;line-height:1.7;">
          <span style="color:#94a3b8;">密码:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:700;background:#f8fafc;padding:1px 6px;border-radius:4px;">${escapeHtml(password)}</span>
        </div>`
      : "";
    const subRows = it.subscriptionLinks
      ? `<div style="margin-top:10px;padding:11px 13px;background:#f0fdfa;border-radius:10px;border:1px solid #a7f3d0;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">订阅链接</div>
          <div style="margin-bottom:6px;">
            <div style="font-size:11px;color:#0f766e;font-weight:700;">Shadowrocket</div>
            <a href="${escapeHtml(it.subscriptionLinks.shadowrocket)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#134e4a;word-break:break-all;text-decoration:underline;">${escapeHtml(it.subscriptionLinks.shadowrocket)}</a>
          </div>
          <div>
            <div style="font-size:11px;color:#0f766e;font-weight:700;">Clash</div>
            <a href="${escapeHtml(it.subscriptionLinks.clash)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#134e4a;word-break:break-all;text-decoration:underline;">${escapeHtml(it.subscriptionLinks.clash)}</a>
          </div>
        </div>`
      : "";
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:${idx === items.length - 1 ? "0" : "1px solid #f1f5f9"};">
          <div style="color:#0f172a;font-size:14.5px;font-weight:800;letter-spacing:-0.01em;">
            ${escapeHtml(it.label)}
            <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#f0fdfa;color:#0f766e;font-size:10.5px;font-weight:700;">${escapeHtml(it.cycle || "1年")}</span>
          </div>
          ${accountRow}
          ${passwordRow}
          ${subRows}
        </td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订单已开通 - ${escapeHtml(brandName)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(brandName)} 订单 ${escapeHtml(order.orderId)} 已开通,账号信息已就绪</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
        <tr><td style="padding:28px 32px 20px;background:linear-gradient(135deg,#047857 0%,#0f766e 100%);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">${escapeHtml(brandName)}</td>
              <td style="text-align:right;color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;">Order Completed</td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:32px 32px 12px;text-align:center;">
          <div style="display:inline-block;width:72px;height:72px;line-height:72px;border-radius:50%;background:linear-gradient(135deg,#d1fae5,#a7f3d0);margin-bottom:16px;">
            <span style="font-size:36px;color:#047857;">🎉</span>
          </div>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">订单已开通</h1>
          <p style="margin:0;color:#64748b;font-size:14px;line-height:1.6;">您的服务已就绪,请查收下方账号信息<br>有任何问题随时联系在线客服。</p>
        </td></tr>

        <tr><td style="padding:18px 32px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#f0fdf4;border:1px solid #bbf7d0;">
            <tr>
              <td style="padding:14px 16px;">
                <div style="font-size:11px;color:#15803d;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">订单号(点击查询)</div>
                <a href="${escapeHtml(orderQueryUrl)}" style="display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:#15803d;margin-top:2px;letter-spacing:-0.01em;text-decoration:underline;">${escapeHtml(order.orderId)}</a>
              </td>
              <td style="padding:14px 16px;text-align:right;border-left:1px solid #bbf7d0;">
                <div style="font-size:11px;color:#15803d;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">订单状态</div>
                <div style="font-size:15px;font-weight:900;color:#047857;margin-top:2px;letter-spacing:-0.01em;">✓ 已完成</div>
              </td>
            </tr>
          </table>
          <div style="margin-top:8px;font-size:11.5px;color:#15803d;font-weight:600;text-align:center;">完成时间:${escapeHtml(order.completedAtBeijing || "")}</div>
        </td></tr>

        <tr><td style="padding:24px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${items.length > 1 ? `账号信息 · ${items.length} 件` : "账号信息"}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${itemsRows}</table>
        </td></tr>

        ${order.staffNotes ? `
        <tr><td style="padding:18px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">客服备注</div>
          <div style="padding:13px 16px;border-radius:12px;background:#fef3c7;border:1px solid #fcd34d;color:#92400e;font-size:13px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(order.staffNotes)}</div>
        </td></tr>` : ""}

        <tr><td style="padding:24px 32px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;">
            <tr><td style="padding:16px 18px;">
              <div style="font-size:13px;font-weight:800;color:#0f766e;margin-bottom:8px;">使用提示:</div>
              <ul style="margin:0;padding-left:18px;color:#134e4a;font-size:13px;line-height:1.85;">
                <li>请妥善保存账号信息,避免泄露</li>
                <li>使用过程中如出现异常,请及时联系客服</li>
                <li>本订单全程售后保障，再次感谢您选择冒央会社！</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 32px 0;">
          <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">需要帮助?</div>
          <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${escapeHtml(supportContact || "")}</p>
          <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">客服在线时间:北京时间 09:00 – 23:00 · 真人值守</p>
        </td></tr>

        <tr><td style="padding:28px 32px 32px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="color:#0f172a;font-size:13px;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(brandName)}</td>
              <td style="text-align:right;color:#94a3b8;font-size:11.5px;">${escapeHtml(siteDomain)}</td>
            </tr>
          </table>
          <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">本邮件由系统自动发送,请勿直接回复。</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function buildCompletionEmailText({ order, brandName, siteDomain, siteUrl }) {
  const items = Array.isArray(order.items) ? order.items : [];
  const queryUrl = `${siteUrl || "https://" + (siteDomain || "")}/?order=${encodeURIComponent(order.orderId)}`;
  const lines = [
    `${brandName} - 订单已开通 🎉`,
    `===========================`,
    `订单号: ${order.orderId}`,
    `状态: ✓ 已完成`,
    `完成时间: ${order.completedAtBeijing || ""}`,
    `查询: ${queryUrl}`,
    ``,
    `账号信息:`,
  ];
  items.forEach((it) => {
    const account = it.staffAccount || it.account;
    const password = it.staffPassword || it.password;
    lines.push(`  · ${it.label} (${it.cycle || "1年"})`);
    if (account) lines.push(`      ${it.service === "rocket" ? "用户名" : "账号"}: ${account}`);
    if (password) lines.push(`      密码: ${password}`);
    if (it.subscriptionLinks) {
      lines.push(`      Shadowrocket: ${it.subscriptionLinks.shadowrocket}`);
      lines.push(`      Clash: ${it.subscriptionLinks.clash}`);
    }
  });
  if (order.staffNotes) {
    lines.push(``, `客服备注:`, order.staffNotes);
  }
  lines.push(``, `如有问题请联系在线客服。`, `查询订单: ${queryUrl}`);
  return lines.join("\n");
}
