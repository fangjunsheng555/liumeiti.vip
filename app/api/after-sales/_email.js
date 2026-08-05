import { getOrderById, sendSimpleEmail } from "../_utils.js";
import { getSettings } from "../_settings.js";
import { buildEmailBrandHeader } from "../email-brand.js";
import { supportHtml, supportText } from "../../lib/settings-defaults.js";
import { stripNetflixCredentialSecrets } from "../../lib/netflix-delivery.js";

const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function multiline(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function normalizedService(value) {
  return String(value || "").trim().toLowerCase();
}

function orderCredentialItems(order) {
  if (Array.isArray(order?.items) && order.items.length) {
    return order.items.map((item, index) => ({
      ...item,
      service: normalizedService(item?.service)
        || (index === 0 ? normalizedService(order?.service) : ""),
      label: item?.label || (index === 0 ? order?.serviceLabel || "" : ""),
      account: item?.account || (index === 0 ? order?.account || "" : ""),
      password: item?.password || (index === 0 ? order?.password || "" : ""),
      staffAccount: item?.staffAccount || (index === 0 ? order?.staffAccount || "" : ""),
      staffPassword: item?.staffPassword || (index === 0 ? order?.staffPassword || "" : ""),
    }));
  }
  return order ? [{
    service: normalizedService(order.service),
    label: order.serviceLabel || "",
    account: order.account || "",
    password: order.password || "",
    staffAccount: order.staffAccount || "",
    staffPassword: order.staffPassword || "",
  }] : [];
}

function historicalNetflixTicketSecrets(ticket, orderItems) {
  const items = Array.isArray(ticket?.items) ? ticket.items : [];
  const secrets = [];
  items.forEach((item, arrayIndex) => {
    const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
    const service = normalizedService(item?.service)
      || normalizedService(orderItems[index]?.service)
      || (index === 0 ? normalizedService(ticket?.service) : "");
    const label = String(item?.label || orderItems[index]?.label || "").toLowerCase();
    if (service !== "netflix" && !label.includes("netflix")) return;
    for (const candidate of [
      item?.password,
      item?.staffPassword,
      item?.submittedPassword,
      item?.currentPassword,
    ]) {
      const secret = String(candidate || "").trim();
      if (secret) secrets.push(secret);
    }
  });
  return Array.from(new Set(secrets));
}

function stripLinesContainingSecrets(value, secrets) {
  const text = String(value || "");
  if (!text || !secrets.length) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !secrets.some((secret) => line.includes(secret)))
    .join("\n")
    .trim();
}

async function ticketWithCurrentOrderCredentials(ticket) {
  const order = await getOrderById(ticket?.orderId);
  if (!order) return null;
  const orderItems = orderCredentialItems(order);
  const currentOrderNote = stripNetflixCredentialSecrets(order, ticket?.staffNote);
  const staffNote = order.netflixDeliveryMode === "self_service"
    ? stripLinesContainingSecrets(
        currentOrderNote,
        historicalNetflixTicketSecrets(ticket, orderItems),
      )
    : currentOrderNote;
  return {
    ...ticket,
    staffNote,
    items: (Array.isArray(ticket?.items) ? ticket.items : []).map((item, arrayIndex) => {
      const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
      const current = orderItems[index];
      const ticketService = normalizedService(item?.service);
      const currentService = normalizedService(current?.service);
      const service = ticketService || currentService;
      const credentialManaged = Boolean(
        item?.credentialManaged
        || ["spotify", "ai", "netflix", "disney", "max"].includes(service),
      );
      if (!current || !credentialManaged) {
        return {
          ...item,
          service,
          credentialManaged: false,
          account: "",
          password: "",
          staffAccount: "",
          staffPassword: "",
          netflixSelfService: false,
        };
      }
      // Item indexes are the durable identity used by after-sales tickets. If
      // an order's service layout changed, omit credentials instead of sending
      // a different service's account or password under the old label.
      if (ticketService && currentService && ticketService !== currentService) {
        return {
          ...item,
          service: ticketService,
          credentialManaged: false,
          account: "",
          password: "",
          staffAccount: "",
          staffPassword: "",
          netflixSelfService: false,
        };
      }
      const netflixSelfService = service === "netflix" && order.netflixDeliveryMode === "self_service";
      return {
        ...item,
        service,
        credentialManaged: true,
        account: String(current.staffAccount || current.account || ""),
        password: netflixSelfService ? "" : String(current.staffPassword || current.password || ""),
        netflixSelfService,
      };
    }),
  };
}

export async function sendAfterSalesEmail(ticket, kind = "received", { idempotencyKey = "" } = {}) {
  const completed = kind === "completed";
  if (completed) {
    const currentTicket = await ticketWithCurrentOrderCredentials(ticket);
    if (!currentTicket) {
      return { ok: false, retryable: true, error: "order_credentials_unavailable" };
    }
    ticket = currentTicket;
  }
  const settings = await getSettings();
  const locale = ticket?.locale === "en" ? "en" : "zh";
  const en = locale === "en";
  const L = (zh, english) => (en ? english : zh);
  const brandName = (en ? settings.brand.nameEn : settings.brand.name) || "冒央会社";
  const support = supportText(settings.support, locale);
  const supportLinks = supportHtml(settings.support, locale);
  const title = completed ? L("售后工单已处理完成", "Your after-sales ticket is complete") : L("您的售后工单已收到", "We received your after-sales ticket");
  const description = completed
    ? L(`订单 ${ticket.orderId} 的售后工单已处理完成。点击下方按钮可查看处理结果。`, `The after-sales ticket for order ${ticket.orderId} is complete. Use the button below to view the result.`)
    : L(`我们已收到订单 ${ticket.orderId} 的售后申请，将尽快核查处理。点击下方按钮可查看工单进度。`, `We received your after-sales request for order ${ticket.orderId}. We will review it shortly; use the button below to track progress.`);
  const detailUrl = `${SITE_URL}/service-center?order=${encodeURIComponent(ticket.orderId)}#order-query`;
  const accent = completed ? "#047857" : "#0f766e";
  const noteBlock = completed && ticket.staffNote
    ? `<tr><td style="padding:0 32px 18px;"><div style="padding:15px 17px;border-radius:12px;background:#f0fdfa;border:1px solid #99f6e4;"><div style="font-size:11px;font-weight:800;color:#0f766e;margin-bottom:7px;">${L("客服处理备注", "Support note")}</div><div style="font-size:13px;line-height:1.75;color:#334155;">${multiline(ticket.staffNote)}</div></div></td></tr>`
    : "";
  const credentialItems = completed
    ? (Array.isArray(ticket.items) ? ticket.items : []).filter((item) => (
      item.credentialManaged === true && item.account && (item.password || item.netflixSelfService)
    ))
    : [];
  const credentialBlock = credentialItems.length
    ? `<tr><td style="padding:0 32px 18px;"><div style="padding-top:16px;border-top:1px solid #e2e8f0;"><div style="font-size:11px;font-weight:800;color:#0f766e;margin-bottom:10px;">${L("最新服务账号", "Latest service credentials")}</div>${credentialItems.map((item) => `<div style="margin-bottom:12px;"><div style="margin-bottom:6px;font-size:12px;font-weight:800;color:#334155;">${escapeHtml(item.label || ticket.serviceLabel)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:9px;"><tr><td style="padding:9px 11px;color:#64748b;font-size:11px;${item.password ? "border-bottom:1px solid #e2e8f0;" : ""}">${item.netflixSelfService ? L("Netflix 登录邮箱", "Netflix sign-in email") : L("账号", "Account")}</td><td align="right" style="padding:9px 11px;font-size:12px;font-weight:800;${item.password ? "border-bottom:1px solid #e2e8f0;" : ""}word-break:break-all;">${escapeHtml(item.account)}</td></tr>${item.password ? `<tr><td style="padding:9px 11px;color:#64748b;font-size:11px;">${L("密码", "Password")}</td><td align="right" style="padding:9px 11px;font-size:12px;font-weight:800;word-break:break-all;">${escapeHtml(item.password)}</td></tr>` : ""}</table></div>`).join("")}<div style="font-size:10.5px;line-height:1.6;color:#94a3b8;">${L("以上信息已同步至订单详情，请妥善保管。", "These details are now synced to your order. Please keep them secure.")}</div></div></td></tr>`
    : "";
  const html = `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,.06);">
        ${buildEmailBrandHeader({ brandName, siteDomain: SITE_DOMAIN, label: L("售后服务", "After-sales support") })}
        <tr><td style="padding:30px 32px 18px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${accent};margin-bottom:9px;">${completed ? L("处理完成", "Completed") : L("待处理", "Pending")}</div>
          <h1 style="margin:0 0 10px;font-size:22px;line-height:1.35;color:#0f172a;">${title}</h1>
          <p style="margin:0;font-size:13.5px;line-height:1.8;color:#475569;">${escapeHtml(description)}</p>
        </td></tr>
        <tr><td style="padding:0 32px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <tr><td style="padding:12px 15px;color:#64748b;font-size:12px;border-bottom:1px solid #e2e8f0;">${L("工单编号", "Ticket")}</td><td align="right" style="padding:12px 15px;font-size:12px;font-weight:800;border-bottom:1px solid #e2e8f0;">${escapeHtml(ticket.ticketId)}</td></tr>
            <tr><td style="padding:12px 15px;color:#64748b;font-size:12px;border-bottom:1px solid #e2e8f0;">${L("关联订单", "Order")}</td><td align="right" style="padding:12px 15px;font-size:12px;font-weight:800;border-bottom:1px solid #e2e8f0;">${escapeHtml(ticket.orderId)}</td></tr>
            <tr><td style="padding:12px 15px;color:#64748b;font-size:12px;">${L("服务内容", "Service")}</td><td align="right" style="padding:12px 15px;font-size:12px;font-weight:800;">${escapeHtml(ticket.serviceLabel)}</td></tr>
          </table>
        </td></tr>
        ${noteBlock}
        ${credentialBlock}
        <tr><td style="padding:0 32px 28px;">
          <a href="${escapeHtml(detailUrl)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#0f766e;color:#fff;text-decoration:none;font-size:13px;font-weight:800;">${L("查看订单与售后", "View order & after-sales")}</a>
          <p style="margin:18px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.7;">${supportLinks}<br>${L("本邮件由系统自动发送，请勿直接回复。", "This email was sent automatically. Please do not reply directly.")}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const noteText = completed && ticket.staffNote ? `\n${L("客服处理备注", "Support note")}: ${ticket.staffNote}\n` : "";
  const credentialText = credentialItems.length
    ? `\n${L("最新服务账号", "Latest service credentials")}\n${credentialItems.map((item) => `${item.label || ticket.serviceLabel}\n${item.netflixSelfService ? L("Netflix 登录邮箱", "Netflix sign-in email") : L("账号", "Account")}: ${item.account}${item.password ? `\n${L("密码", "Password")}: ${item.password}` : ""}`).join("\n\n")}\n`
    : "";
  const text = `${brandName}\n\n${title}\n${description}\n\n${L("工单编号", "Ticket")}: ${ticket.ticketId}\n${L("关联订单", "Order")}: ${ticket.orderId}\n${L("服务内容", "Service")}: ${ticket.serviceLabel}${noteText}${credentialText}\n${detailUrl}\n\n${support}`;
  return sendSimpleEmail({
    to: ticket.email,
    category: "after_sales",
    relatedType: "order",
    relatedId: ticket.orderId,
    subject: `${title} · ${ticket.ticketId} · ${brandName}`,
    text,
    html,
    fromName: brandName,
    support: settings.support,
    locale,
    idempotencyKey,
  });
}
