import { buildEmailBrandHeader } from "../email-brand.js";
import { supportContactHtml, supportContactText } from "../support-links.js";
import { supportHtml, supportText } from "../../lib/settings-defaults.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function copyFor(kind, locale, order) {
  const en = locale === "en";
  const L = (zh, english) => (en ? english : zh);
  if (kind === "quote") {
    return {
      label: L("代付报价", "Proxy Pay Quote"),
      title: L("报价已完成", "Your quote is ready"),
      lead: L("请核对报价，并通过专属链接完成付款。", "Review the quote and use your secure link to pay."),
      subject: L(`代付报价 ${order.orderId} · ${money(order.quoteAmount)}`, `Proxy Pay quote ${order.orderId} · ${money(order.quoteAmount)}`),
      button: L("查看报价并付款", "Review quote & pay"),
    };
  }
  if (kind === "payment_received") {
    return {
      label: L("付款确认", "Payment Confirmation"),
      title: L("付款信息已提交", "Payment submitted"),
      lead: L("工作人员正在核对款项，确认后将开始处理代付。", "Our team is verifying the payment and will process the request once confirmed."),
      subject: L(`代付订单 ${order.orderId} 已收到付款信息`, `Payment submitted for ${order.orderId}`),
      button: L("查询订单", "Track order"),
    };
  }
  if (kind === "completed") {
    return {
      label: L("代付完成", "Proxy Pay Complete"),
      title: L("代付已完成", "Proxy payment completed"),
      lead: L("您的代付订单已处理完成。", "Your proxy-payment order has been completed."),
      subject: L(`代付订单 ${order.orderId} 已完成`, `Proxy Pay order ${order.orderId} completed`),
      button: L("查看订单", "View order"),
    };
  }
  if (kind === "invalid") {
    return {
      label: L("申请状态", "Request Status"),
      title: L("本次申请无法处理", "This request can't be processed"),
      lead: L("请在订单详情中查看客服备注，或联系在线客服确认其他方案。", "Check the support note in your order, or contact support for another option."),
      subject: L(`代付申请 ${order.orderId} 无法处理`, `Proxy Pay request ${order.orderId} can't be processed`),
      button: L("查看订单", "View order"),
    };
  }
  return {
    label: L("代付申请", "Proxy Pay Request"),
    title: L("申请已收到", "Request received"),
    lead: L("工作人员将核验平台与商品，无需现在付款。报价会发送至此邮箱。", "We will verify the platform and item. No payment is due now; the quote will be emailed here."),
    subject: L(`代付申请 ${order.orderId} 已收到`, `Proxy Pay request ${order.orderId} received`),
    button: L("查询订单", "Track order"),
  };
}

export function buildProxyOrderEmail({ kind = "application", order, paymentUrl = "", brandName, siteDomain, siteUrl, locale = "zh", support = null }) {
  const en = locale === "en";
  const L = (zh, english) => (en ? english : zh);
  const copy = copyFor(kind, locale, order);
  // 客服联系方式优先用站点设置(后台可改、全站一致);未传时回退旧 env 模块。
  const supportLineHtml = support ? supportHtml(support, locale) : supportContactHtml(locale);
  const supportLineText = support ? supportText(support, locale) : supportContactText(locale);
  const queryUrl = `${siteUrl || `https://${siteDomain}`}/service-center?order=${encodeURIComponent(order.orderId)}`;
  const actionUrl = kind === "quote" && paymentUrl ? paymentUrl : queryUrl;
  const productImage = `${siteUrl || `https://${siteDomain}`}/products/proxy-pay.jpg`;
  const quoteRow = Number(order.quoteAmount || 0) > 0
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">${L("报价金额", "Quote")}</td><td style="padding:8px 0;text-align:right;color:#0f172a;font-size:18px;font-weight:900;">${money(order.quoteAmount)}</td></tr>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-CN"}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(copy.lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.06);">
        ${buildEmailBrandHeader({ brandName, siteDomain, label: copy.label })}
        <tr><td style="padding:30px 30px 12px;text-align:center;">
          <img src="${escapeHtml(productImage)}" width="76" height="76" alt="${L("全球代付", "Global Proxy Pay")}" style="display:block;width:76px;height:76px;border-radius:18px;margin:0 auto 16px;border:1px solid #e2e8f0;" />
          <h1 style="margin:0 0 8px;font-size:24px;line-height:1.25;font-weight:900;letter-spacing:-.02em;">${escapeHtml(copy.title)}</h1>
          <p style="margin:0;color:#64748b;font-size:14px;line-height:1.7;">${escapeHtml(copy.lead)}</p>
        </td></tr>
        <tr><td style="padding:18px 30px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:8px 16px;">
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;">${L("订单号", "Order ID")}</td><td style="padding:8px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:800;">${escapeHtml(order.orderId)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;">${L("网站 / 平台", "Website / platform")}</td><td style="padding:8px 0;text-align:right;font-size:13px;font-weight:700;word-break:break-all;">${escapeHtml(order.platformUrl)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;">${L("商品标价", "Listed price")}</td><td style="padding:8px 0;text-align:right;font-size:13px;font-weight:700;">${escapeHtml(order.productPrice)}</td></tr>
            ${quoteRow}
          </table>
        </td></tr>
        <tr><td style="padding:22px 30px 6px;text-align:center;">
          <a href="${escapeHtml(actionUrl)}" style="display:block;background:#0f766e;color:#fff;text-decoration:none;font-size:14px;font-weight:800;padding:14px 20px;border-radius:12px;">${escapeHtml(copy.button)}</a>
          ${kind === "quote" ? `<p style="margin:10px 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">${L("付款链接 7 天内有效，请勿转发。", "The payment link is valid for 7 days. Do not forward it.")}</p>` : ""}
        </td></tr>
        <tr><td style="padding:22px 30px 28px;color:#64748b;font-size:12px;line-height:1.8;text-align:center;border-top:1px solid #eef2f7;">${supportLineHtml}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    copy.title,
    copy.lead,
    `${L("订单号", "Order ID")}: ${order.orderId}`,
    `${L("网站 / 平台", "Website / platform")}: ${order.platformUrl}`,
    `${L("商品标价", "Listed price")}: ${order.productPrice}`,
    Number(order.quoteAmount || 0) > 0 ? `${L("报价金额", "Quote")}: ${money(order.quoteAmount)}` : "",
    `${copy.button}: ${actionUrl}`,
    supportLineText,
  ].filter(Boolean).join("\n");

  return { subject: `${copy.subject} · ${brandName}`, html, text };
}
