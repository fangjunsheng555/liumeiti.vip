import { buildEmailBrandHeader } from "../../email-brand.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function statusLabel(status, en) {
  const labels = en
    ? { awaiting_quote: "Awaiting quote", pending_payment: "Awaiting payment", quote_expired: "Quote expired", received: "Order received", completed: "Completed", invalid: "Invalid" }
    : { awaiting_quote: "等待报价", pending_payment: "等待付款", quote_expired: "报价已失效", received: "订单已收到", completed: "订单已完成", invalid: "订单无效" };
  return labels[status] || status || "--";
}

function orderAmount(order) {
  if (order?.paidCurrency === "USDT") return `${Number(order.paidAmount || order.finalUsdt || 0)} USDT`;
  return `¥${Number(order?.paidAmount || order?.finalAmount || 0).toFixed(2)}`;
}

function itemLines(order) {
  const items = Array.isArray(order?.items) && order.items.length ? order.items : [{ label: order?.serviceLabel || "" }];
  return items.map((item) => [item.label || item.service || "--", item.cycle || "", Number(item.amount || 0)]);
}

export function buildReferenceNotificationEmail({ orders, timelines, subject, message, brandName, siteDomain, locale = "zh" }) {
  const en = locale === "en";
  const L = (zh, english) => en ? english : zh;
  const safeSubject = subject || L("客服通知", "Customer service notice");
  const orderRows = orders.map((order) => {
    const items = itemLines(order);
    const timeline = Array.isArray(timelines?.[order.orderId]) ? timelines[order.orderId] : [];
    const detailsUrl = `https://${siteDomain}/service-center?order=${encodeURIComponent(order.orderId)}#order-query`;
    return `
      <tr><td style="padding:22px 0;border-top:1px solid #e2e8f0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-size:13px;color:#64748b;">${L("订单号", "Order")}</td><td align="right" style="font:700 12px ui-monospace,Menlo,monospace;color:#0f172a;">${esc(order.orderId)}</td></tr>
          <tr><td style="padding-top:8px;font-size:13px;color:#64748b;">${L("状态", "Status")}</td><td align="right" style="padding-top:8px;font-size:13px;font-weight:700;color:#0f766e;">${esc(statusLabel(order.status, en))}</td></tr>
          <tr><td style="padding-top:8px;font-size:13px;color:#64748b;">${L("金额", "Amount")}</td><td align="right" style="padding-top:8px;font-size:13px;font-weight:800;color:#0f172a;">${esc(orderAmount(order))}</td></tr>
        </table>
        <div style="margin-top:13px;padding:11px 0;border-top:1px dashed #dbe4ef;border-bottom:1px dashed #dbe4ef;">
          ${items.map(([label, cycle, amount]) => `<div style="margin:3px 0;font-size:13px;line-height:1.55;color:#334155;"><b style="color:#0f172a;">${esc(label)}</b>${cycle ? ` · ${esc(cycle)}` : ""}${amount ? ` · ¥${amount.toFixed(2)}` : ""}</div>`).join("")}
        </div>
        ${timeline.length ? `<div style="margin-top:13px;"><div style="margin-bottom:7px;font-size:12px;font-weight:800;color:#0f172a;">${L("订单进度", "Order timeline")}</div>${timeline.slice(0, 8).map((event) => `<div style="margin:5px 0;font-size:12px;line-height:1.55;color:#64748b;"><span style="display:inline-block;width:112px;color:#94a3b8;">${esc(String(event.createdAtBeijing || "").replace(" 北京时间 (UTC+8)", ""))}</span>${esc(en ? event.summaryEn : event.summaryZh)}</div>`).join("")}</div>` : ""}
        <div style="margin-top:15px;"><a href="${esc(detailsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none;font-size:12px;font-weight:800;">${L("查看订单", "View order")}</a></div>
      </td></tr>`;
  }).join("");

  const html = `<!doctype html><html lang="${en ? "en" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#f4f7f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:24px 12px;background:#f4f7f9;"><tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#fff;border:1px solid #e2e8f0;">
        ${buildEmailBrandHeader({ brandName, siteDomain, label: L("客服通知", "Customer Service") })}
        <tr><td style="padding:28px 30px 8px;"><h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;">${esc(safeSubject)}</h1><p style="margin:0;font-size:14px;line-height:1.8;color:#475569;white-space:pre-line;">${esc(message)}</p></td></tr>
        <tr><td style="padding:4px 30px 28px;">${orderRows}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = [safeSubject, "", message, "", ...orders.flatMap((order) => [
    `${L("订单号", "Order")}: ${order.orderId}`,
    `${L("状态", "Status")}: ${statusLabel(order.status, en)}`,
    `${L("服务", "Service")}: ${itemLines(order).map(([label]) => label).join(" / ")}`,
    `${L("金额", "Amount")}: ${orderAmount(order)}`,
    `${L("查看订单", "View order")}: https://${siteDomain}/service-center?order=${encodeURIComponent(order.orderId)}#order-query`,
    "",
  ])].join("\n");
  return { subject: safeSubject, html, text };
}
