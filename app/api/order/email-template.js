import { buildEmailBrandHeader } from "../email-brand.js";
import { localizeOrderItemLabel, localizeCycle } from "../../lib/order-i18n.js";
import { supportContactHtml } from "../support-links.js";
import { supportHtml } from "../../lib/settings-defaults.js";

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

export function buildOrderEmailHtml({ order, brandName, siteDomain, siteUrl, supportContact, support, usdtRate, locale, usdtDiscountLabel = "9 折" }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const isUsdt = order.paymentMethod === "usdt";
  const isRedeem = order.paymentMethod === "redeem";
  const rawItems = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : [{
        label: order.serviceLabel || "订单",
        cycle: order.cycle || "1年",
        amount: order.finalAmount || 0,
        account: order.account,
        password: order.password,
        service: order.service,
        plan: order.plan || order.rocketPlan,
      }];
  const items = rawItems.map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label || L("订单", "Order"), locale),
    cycle: localizeCycle(it.cycle || "1年", locale),
  }));
  const itemCount = items.length;
  const isCart = itemCount > 1;

  const orderQueryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;

  // Render items rows
  const itemsRows = items.map((it, idx) => {
    const accountRow = it.account
      ? `<div style="margin-top:6px;font-size:12px;color:#475569;line-height:1.65;">
          <span style="color:#94a3b8;">${it.service === "rocket" ? L("用户名", "Username") : L("账号", "Account")}:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:600;">${escapeHtml(it.account)}</span>
        </div>`
      : "";
    const passwordRow = it.password
      ? `<div style="font-size:12px;color:#475569;line-height:1.65;">
          <span style="color:#94a3b8;">${L("密码", "Password")}:</span>
          <span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;font-weight:600;">${escapeHtml(it.password)}</span>
        </div>`
      : "";
    const subRows = it.subscriptionLinks
      ? `<div style="margin-top:8px;padding:10px 12px;background:#f0fdfa;border-radius:10px;border:1px solid #a7f3d0;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#0f766e;margin-bottom:6px;">${L("订阅链接", "Subscription links")}</div>
          <div style="margin-bottom:6px;">
            <div style="font-size:11px;color:#0f766e;font-weight:700;">${L("Shadowrocket 订阅", "Shadowrocket")}</div>
            <a href="${escapeHtml(it.subscriptionLinks.shadowrocket)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#134e4a;word-break:break-all;text-decoration:underline;">${escapeHtml(it.subscriptionLinks.shadowrocket)}</a>
          </div>
          <div>
            <div style="font-size:11px;color:#0f766e;font-weight:700;">${L("Clash 订阅", "Clash")}</div>
            <a href="${escapeHtml(it.subscriptionLinks.clash)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#134e4a;word-break:break-all;text-decoration:underline;">${escapeHtml(it.subscriptionLinks.clash)}</a>
          </div>
        </div>`
      : "";
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:${idx === items.length - 1 ? "0" : "1px solid #f1f5f9"};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:top;">
                <div style="color:#0f172a;font-size:14.5px;font-weight:800;letter-spacing:-0.01em;">
                  ${escapeHtml(it.label)}
                  <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#f0fdfa;color:#0f766e;font-size:10.5px;font-weight:700;">${escapeHtml(it.cycle || L("1年", "1 yr"))}</span>
                </div>
                ${accountRow}
                ${passwordRow}
                ${subRows}
              </td>
              <td style="vertical-align:top;text-align:right;color:#0f172a;font-size:14px;font-weight:700;white-space:nowrap;">
                ${formatMoney(it.amount)}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }).join("");

  // Paid value display
  const paidValue = isRedeem
    ? L("服务兑换码", "Service code")
    : isUsdt
    ? `${order.paidAmount || order.finalUsdt} <span style="font-size:18px;color:#0f766e;font-weight:800;">USDT</span>`
    : formatMoney(order.paidAmount || order.finalAmount);
  const paidNote = isRedeem
    ? L("已通过服务兑换码免支付兑换", "Redeemed with a service code — no payment")
    : isUsdt
    ? L(`已通过 USDT-TRC20 网络支付(已享 ${usdtDiscountLabel})`, `Paid via USDT-TRC20 (${usdtDiscountLabel} applied)`)
    : L("已通过支付宝担保支付", "Paid via Alipay escrow");

  return `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-CN"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L("订单确认", "Order confirmation")} - ${escapeHtml(brandName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${L("请点击查阅邮件内容", "Open to view your order")} · ${escapeHtml(brandName)} · ${L("实付", "Paid")} ${isRedeem ? L("服务兑换码", "Service code") : isUsdt ? (order.paidAmount + " USDT") : ("¥" + order.finalAmount)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:20px;box-shadow:0 8px 32px rgba(15,23,42,0.06);overflow:hidden;">
          <!-- Header -->
          ${buildEmailBrandHeader({ brandName, siteDomain, label: L("订单确认", "Order Confirmation") })}

          <!-- Success badge -->
          <tr>
            <td style="padding:32px 32px 12px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:50%;background:linear-gradient(135deg,#d1fae5,#a7f3d0);margin-bottom:14px;">
                <span style="font-size:32px;color:#047857;">✓</span>
              </div>
              <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;letter-spacing:-0.03em;color:#0f172a;">${L("订单已收到", "Order received")}</h1>
              <p style="margin:0;color:#64748b;font-size:13.5px;line-height:1.6;">${en ? `We'll process your order <strong style="color:#0f172a;">within 10 minutes</strong><br>Please keep your email and contact reachable` : `我们将在 <strong style="color:#0f172a;">10 分钟内</strong> 处理您的订单<br>请保持邮箱及联系方式畅通`}</p>
            </td>
          </tr>

          <!-- Order ID + paid -->
          <tr>
            <td style="padding:18px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${L("订单号(点击查询)", "Order ID (tap to track)")}</div>
                    <a href="${escapeHtml(orderQueryUrl)}" style="display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:#0f766e;margin-top:2px;letter-spacing:-0.01em;text-decoration:underline;">${escapeHtml(order.orderId)}</a>
                  </td>
                  <td style="padding:14px 16px;text-align:right;border-left:1px solid #e2e8f0;">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${L("实付金额", "Amount paid")}</div>
                    <div style="font-size:20px;font-weight:900;color:#134e4a;margin-top:2px;letter-spacing:-0.02em;">${paidValue}</div>
                  </td>
                </tr>
              </table>
              <div style="margin-top:8px;font-size:11.5px;color:#0f766e;font-weight:600;text-align:center;">${escapeHtml(paidNote)}</div>
            </td>
          </tr>

          <!-- Items -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${isCart ? L(`订单明细 · ${itemCount} 件`, `Order items · ${itemCount}`) : L("订单明细", "Order items")}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${itemsRows}
              </table>
            </td>
          </tr>

          <!-- Price summary -->
          <tr>
            <td style="padding:18px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;">
                ${isCart ? `
                <tr>
                  <td style="padding:10px 16px 4px;color:#64748b;font-size:13px;">${L("商品总价", "Subtotal")}</td>
                  <td style="padding:10px 16px 4px;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${formatMoney(order.subtotal)}</td>
                </tr>` : ""}
                ${isCart && order.discountRate > 0 ? `
                <tr>
                  <td style="padding:4px 16px;color:#d97706;font-size:13px;">${en ? "Bundle discount" : "组合优惠 · " + escapeHtml(order.discountLabel || "")}</td>
                  <td style="padding:4px 16px;color:#d97706;font-size:13px;font-weight:600;text-align:right;">−${formatMoney(order.subtotal - (order.bundleFinalAmount || order.finalAmount))}</td>
                </tr>` : ""}
                ${isRedeem ? `
                <tr>
                  <td style="padding:4px 16px;color:#0f766e;font-size:13px;">${L("服务兑换码抵扣", "Service code applied")}</td>
                  <td style="padding:4px 16px;color:#0f766e;font-size:13px;font-weight:700;text-align:right;">−${formatMoney(order.bundleFinalAmount || order.subtotal)}</td>
                </tr>` : ""}
                ${isUsdt ? `
                <tr>
                  <td style="padding:4px 16px;color:#64748b;font-size:13px;">${L("折后人民币", "Discounted CNY")}</td>
                  <td style="padding:4px 16px;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${formatMoney(order.finalAmount)}</td>
                </tr>
                <tr>
                  <td style="padding:4px 16px;color:#64748b;font-size:13px;">${L(`USDT ${usdtDiscountLabel} ÷`, `USDT ${usdtDiscountLabel} ÷`)} ${usdtRate || 6.85}</td>
                  <td style="padding:4px 16px;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">→ ${order.paidAmount} USDT</td>
                </tr>` : ""}
                <tr>
                  <td style="padding:10px 16px 12px;border-top:1px dashed #cbd5e1;color:#0f172a;font-size:14px;font-weight:800;">${isUsdt ? L("实付(USDT)", "Paid (USDT)") : L("实付总额", "Total paid")}</td>
                  <td style="padding:10px 16px 12px;border-top:1px dashed #cbd5e1;color:#134e4a;font-size:18px;font-weight:900;text-align:right;letter-spacing:-0.02em;">${paidValue}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Contact info recap -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">${L("您填写的联系方式", "Your contact details")}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:13px;width:80px;">${L("邮箱", "Email")}</td>
                  <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(order.email || "")}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:13px;">${L("联系方式", "Contact")}</td>
                  <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(order.contact || "")}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Next steps -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #a7f3d0;">
                <tr><td style="padding:16px 18px;">
                  <div style="font-size:13px;font-weight:800;color:#0f766e;margin-bottom:8px;">${L("接下来:", "What happens next:")}</div>
                  <ol style="margin:0;padding-left:18px;color:#134e4a;font-size:13px;line-height:1.85;">
                    <li>${L("我们将在 10 分钟内处理订单", "We'll process your order within 10 minutes")}</li>
                    <li>${L("必要时将通过邮箱/联系方式联系您", "If needed, we'll reach you by email or your contact")}</li>
                    <li>${en ? `Once it's set up you'll get another email — you can also tap the order ID or visit <a href="${escapeHtml(siteUrl || "https://" + siteDomain)}" style="color:#0f766e;font-weight:700;">${escapeHtml(siteDomain)}</a> to track it` : `开通完成后您将再次收到邮件，也可点击订单号或访问 <a href="${escapeHtml(siteUrl || "https://" + siteDomain)}" style="color:#0f766e;font-weight:700;">${escapeHtml(siteDomain)}</a> 查询订单`}</li>
                  </ol>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">${L("需要帮助?", "Need help?")}</div>
              <p style="margin:0;font-size:13px;line-height:1.75;color:#475569;">${support ? supportHtml(support, locale) : supportContactHtml(locale)}</p>
              <p style="margin:8px 0 0;font-size:12.5px;color:#94a3b8;">${L("客服在线时间:北京时间 09:00 – 23:00 · 真人值守", "Support hours: 9:00 – 23:00 Beijing time · staffed by real people")}</p>
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
              <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;line-height:1.6;">${L("本邮件由系统自动发送,请勿直接回复，订单时间:", "This email was sent automatically — please don't reply. Order time: ")}${escapeHtml(order.createdAtBeijing || "")}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildOrderEmailText({ order, brandName, siteDomain, siteUrl, usdtRate, locale }) {
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const isUsdt = order.paymentMethod === "usdt";
  const isRedeem = order.paymentMethod === "redeem";
  const rawItems = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : [{ label: order.serviceLabel || "订单", cycle: order.cycle || "1年", amount: order.finalAmount || 0, account: order.account, password: order.password, service: order.service, plan: order.plan || order.rocketPlan }];
  const items = rawItems.map((it) => ({
    ...it,
    label: localizeOrderItemLabel(it.service, it.plan || it.rocketPlan, it.label || L("订单", "Order"), locale),
    cycle: localizeCycle(it.cycle || "1年", locale),
  }));
  const isCart = items.length > 1;
  const queryUrl = `${siteUrl || "https://" + (siteDomain || "")}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const lines = [
    `${brandName} - ${L("订单确认", "Order confirmation")}`,
    `===========================`,
    `${L("订单号", "Order ID")}: ${order.orderId}`,
    `${L("查询", "Track")}: ${queryUrl}`,
    `${L("时间", "Time")}: ${order.createdAtBeijing || ""}`,
    ``,
    `${L(`订单明细 (${items.length} 件):`, `Order items (${items.length}):`)}`,
  ];
  items.forEach((it) => {
    lines.push(`  · ${it.label} (${it.cycle || L("1年", "1 yr")}) ¥${it.amount}`);
    if (it.account) lines.push(`      ${it.service === "rocket" ? L("用户名", "Username") : L("账号", "Account")}: ${it.account}`);
    if (it.password) lines.push(`      ${L("密码", "Password")}: ${it.password}`);
    if (it.subscriptionLinks) {
      lines.push(`      Shadowrocket: ${it.subscriptionLinks.shadowrocket}`);
      lines.push(`      Clash: ${it.subscriptionLinks.clash}`);
    }
  });
  if (isCart) {
    lines.push(``, `${L("商品总价", "Subtotal")}: ¥${order.subtotal}`);
    if (order.discountRate > 0) {
      lines.push(`${en ? "Bundle discount" : "组合优惠 " + order.discountLabel}: −¥${order.subtotal - (order.bundleFinalAmount || order.finalAmount)}`);
    }
  }
  if (isRedeem) {
    lines.push(`${L("服务兑换码", "Service code")}: ${order.redeemCode || ""}`);
    lines.push(`${L("实付", "Paid")}: ${L("服务兑换码免支付", "Service code — no payment")}`);
  } else if (isUsdt) {
    lines.push(`${L("折后人民币", "Discounted CNY")}: ¥${order.finalAmount}`);
    lines.push(`${L("实付", "Paid")}: ${order.paidAmount} USDT (× 0.9 ÷ ${usdtRate || 6.85})`);
  } else {
    lines.push(`${L("实付", "Paid")}: ¥${order.finalAmount}`);
  }
  lines.push(``, L("我们将在 10 分钟内处理您的订单", "We'll process your order within 10 minutes"), `${L("查询订单请访问", "Track your order at")}: ${queryUrl}`);
  return lines.join("\n");
}
