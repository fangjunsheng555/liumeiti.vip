function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  return "¥" + Number(value || 0).toFixed(0);
}

export function buildOrderEmailHtml({ order, cartContext, brandName, siteDomain, supportContact }) {
  const isUsdt = order.paymentMethod === "usdt";
  const isCart = cartContext && cartContext.count > 1;
  const items = cartContext?.items || [{
    title: order.serviceLabel,
    cycle: order.cycle,
    amount: order.finalAmount,
  }];
  const accountSection = order.account
    ? `
        <tr>
          <td style="padding:8px 0;color:#64748b;font-size:13px;">${order.service === "rocket" ? "用户名" : "账号"}</td>
          <td style="padding:8px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${escapeHtml(order.account)}</td>
        </tr>`
    : "";
  const passwordSection = order.password
    ? `
        <tr>
          <td style="padding:8px 0;color:#64748b;font-size:13px;">密码</td>
          <td style="padding:8px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right;font-family:monospace;">${escapeHtml(order.password)}</td>
        </tr>`
    : "";
  const itemsRows = items
    .map(
      (it) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:14px;font-weight:600;">
            ${escapeHtml(it.title)}
            <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#f0fdfa;color:#0f766e;font-size:11px;font-weight:700;">${escapeHtml(it.cycle || "1年")}</span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:14px;font-weight:700;text-align:right;">${formatMoney(it.amount)}</td>
        </tr>`
    )
    .join("");

  const subtotalRow = isCart
    ? `
      <tr>
        <td style="padding:10px 0 4px;color:#64748b;font-size:13px;">商品总价</td>
        <td style="padding:10px 0 4px;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${formatMoney(cartContext.subtotal)}</td>
      </tr>`
    : "";
  const discountRow = isCart && cartContext.discountRate > 0
    ? `
      <tr>
        <td style="padding:4px 0;color:#d97706;font-size:13px;">组合优惠 · ${escapeHtml(cartContext.discountLabel || "")}</td>
        <td style="padding:4px 0;color:#d97706;font-size:13px;font-weight:600;text-align:right;">−${formatMoney(cartContext.subtotal - cartContext.finalCny)}</td>
      </tr>`
    : "";

  const finalCny = isCart ? cartContext.finalCny : order.finalAmount;
  const finalUsdt = isCart ? cartContext.finalUsdt : null;
  const paidValue = isUsdt && finalUsdt
    ? `${finalUsdt} <span style="font-size:18px;color:#0f766e;">USDT</span>`
    : formatMoney(finalCny);

  const paidNote = isUsdt
    ? `已通过 USDT-TRC20 网络支付(已享 9 折)`
    : `已通过支付宝担保支付`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>订单确认 - ${escapeHtml(brandName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(brandName)} 订单 ${escapeHtml(order.orderId)} · 实付 ${escapeHtml(typeof paidValue === "string" ? paidValue : finalCny)} · 客服将在 30 分钟内为您开通</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px;background:linear-gradient(135deg,#0f172a 0%,#0f766e 100%);">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">${escapeHtml(brandName)}</td>
                  <td style="text-align:right;color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;">Order Confirmation</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Success badge -->
          <tr>
            <td style="padding:32px 32px 12px;text-align:center;">
              <div style="display:inline-grid;place-items:center;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#d1fae5,#a7f3d0);margin-bottom:14px;">
                <span style="font-size:32px;line-height:1;color:#047857;">✓</span>
              </div>
              <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">订单已收到</h1>
              <p style="margin:0;color:#64748b;font-size:13.5px;line-height:1.6;">客服将在 <strong style="color:#0f172a;">30 分钟内</strong> 处理您的订单<br>请保持邮箱及联系方式畅通。</p>
            </td>
          </tr>

          <!-- Order ID + paid -->
          <tr>
            <td style="padding:18px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">订单号</div>
                    <div style="font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700;color:#0f172a;margin-top:2px;letter-spacing:-0.01em;">${escapeHtml(order.orderId)}</div>
                  </td>
                  <td style="padding:14px 16px;text-align:right;border-left:1px solid #e2e8f0;">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">实付金额</div>
                    <div style="font-size:18px;font-weight:900;color:#134e4a;margin-top:2px;letter-spacing:-0.02em;">${paidValue}</div>
                  </td>
                </tr>
              </table>
              <div style="margin-top:8px;font-size:11.5px;color:#0f766e;font-weight:600;text-align:center;">${escapeHtml(paidNote)}</div>
            </td>
          </tr>

          <!-- Items -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${isCart ? `订单明细 · ${cartContext.count} 件` : "订单明细"}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${itemsRows}
                ${subtotalRow}
                ${discountRow}
                <tr>
                  <td style="padding:12px 0 0;color:#0f172a;font-size:14px;font-weight:800;">${isUsdt ? "实付(USDT)" : "实付总额"}</td>
                  <td style="padding:12px 0 0;color:#134e4a;font-size:20px;font-weight:900;text-align:right;letter-spacing:-0.02em;">${paidValue}</td>
                </tr>
              </table>
            </td>
          </tr>

          ${(order.account || order.password) ? `
          <!-- Account info -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${order.service === "rocket" ? "订阅信息" : "账号信息"}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;">
                <tr><td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${accountSection}
                    ${passwordSection}
                  </table>
                </td></tr>
              </table>
            </td>
          </tr>` : ""}

          <!-- Contact info recap -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">您填写的联系方式</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:8px 0;color:#64748b;font-size:13px;">邮箱</td>
                  <td style="padding:8px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${escapeHtml(order.email || "")}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#64748b;font-size:13px;">联系方式</td>
                  <td style="padding:8px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${escapeHtml(order.contact || "")}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Next steps -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;">
                <tr><td style="padding:16px 18px;">
                  <div style="font-size:13px;font-weight:800;color:#0f766e;margin-bottom:8px;">接下来:</div>
                  <ol style="margin:0;padding-left:18px;color:#134e4a;font-size:13px;line-height:1.85;">
                    <li>客服将在 30 分钟内核对您的订单</li>
                    <li>核对成功后通过您填写的联系方式开通服务</li>
                    <li>开通后可凭此邮箱随时在 ${escapeHtml(siteDomain)} 查询订单</li>
                  </ol>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">需要帮助?</div>
              <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${escapeHtml(supportContact || "请通过 QQ / WhatsApp / Telegram 联系在线客服")}</p>
              <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">客服在线时间:北京时间 09:00 – 23:00 · 真人值守</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 32px 32px;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="color:#0f172a;font-size:13px;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(brandName)}</td>
                  <td style="text-align:right;color:#94a3b8;font-size:11.5px;">${escapeHtml(siteDomain)}</td>
                </tr>
              </table>
              <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">本邮件由系统自动发送,请勿直接回复。订单时间:${escapeHtml(order.createdAtBeijing || "")}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildOrderEmailText({ order, cartContext, brandName, siteDomain }) {
  const isCart = cartContext && cartContext.count > 1;
  const isUsdt = order.paymentMethod === "usdt";
  const items = cartContext?.items || [{ title: order.serviceLabel, cycle: order.cycle, amount: order.finalAmount }];
  const lines = [
    `${brandName} - 订单确认`,
    `===========================`,
    `订单号: ${order.orderId}`,
    `时间: ${order.createdAtBeijing || ""}`,
    ``,
    `订单明细 (${items.length} 件):`,
  ];
  items.forEach((it) => {
    lines.push(`  · ${it.title} (${it.cycle || "1年"}) ¥${it.amount}`);
  });
  if (isCart && cartContext.discountRate > 0) {
    lines.push(`  组合优惠 ${cartContext.discountLabel}: −¥${cartContext.subtotal - cartContext.finalCny}`);
  }
  if (isUsdt && cartContext?.finalUsdt) {
    lines.push(`实付: ${cartContext.finalUsdt} USDT (TRC20, 已9折)`);
  } else {
    lines.push(`实付: ¥${cartContext ? cartContext.finalCny : order.finalAmount}`);
  }
  if (order.account) lines.push(`${order.service === "rocket" ? "用户名" : "账号"}: ${order.account}`);
  if (order.password) lines.push(`密码: ${order.password}`);
  lines.push(``, `客服将在 30 分钟内处理您的订单。`, `如需查询订单请访问 ${siteDomain}`);
  return lines.join("\n");
}
