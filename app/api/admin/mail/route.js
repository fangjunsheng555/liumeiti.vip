import {
  adminSessionFromRequest, adminActorFromSession, isRootAdminSession,
  adminPermissionProfile,
  clean, validEmail, sendSimpleEmail, pushAdminMailLog, getAdminMailLog,
  deleteAdminMailLogEntries, pushAdminActionLog,
} from "../../_utils.js";
import { buildCustomerMailHtml, buildCustomerMailText } from "./template.js";
import {
  MARKETING_MAIL_PREVIEW,
  MARKETING_MAIL_SUBJECT,
  MARKETING_MAIL_TEMPLATE_ID,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "./marketing-template.js";

// 营销邮件的服务清单:价格取合并目录(后台改价即时同步),客服取站点设置。
async function buildMarketingArgs(brandName, siteDomain, siteUrl) {
  const origin = String(siteUrl || "https://www.liumeiti.vip").replace(/\/$/, "");
  const base = { brandName, siteDomain, siteUrl };
  try {
    const [{ getMergedCatalog }, { getSettings }] = await Promise.all([
      import("../../_catalog.js"),
      import("../../_settings.js"),
    ]);
    const [catalog, settings] = await Promise.all([getMergedCatalog(), getSettings()]);
    const byKey = {};
    for (const p of catalog) byKey[p.key] = p;
    const priceOf = (key, fb) => (byKey[key] && byKey[key].active !== false && byKey[key].priceText) || fb;
    const parseYuan = (t) => { const m = String(t || "").match(/¥\s*(\d+)/); return m ? Number(m[1]) : Infinity; };
    const streamMin = Math.min(parseYuan(priceOf("netflix")), parseYuan(priceOf("disney")), parseYuan(priceOf("max")));
    const streamPrice = Number.isFinite(streamMin) ? `¥${streamMin}/年起` : "¥108/年起";
    const products = [
      { name: "Spotify", subtitle: "欧美日高价区多规格订阅", price: priceOf("spotify", "¥128/年起"), href: origin + "/services/spotify", icon: "spotify.jpg" },
      { name: "4K 影音会员", subtitle: "Netflix · Disney+ · HBO Max", price: streamPrice, href: origin + "/shop", icon: "streaming-4k-edm-v2.jpg" },
      { name: "AI 会员", subtitle: "ChatGPT · Claude 官方会员", price: priceOf("ai", "¥198/三个月起"), href: origin + "/services/ai", icon: "ai.jpg" },
      { name: "机场节点", subtitle: "稳定高速科学上网节点", price: priceOf("rocket", "¥128/年起"), href: origin + "/services/airport-node", icon: "rocket.jpg" },
    ].filter((p) => p.name !== "4K 影音会员" || streamMin !== Infinity || true);
    return { ...base, products, support: settings.support };
  } catch (e) {
    return base;
  }
}

function cleanMailBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 3000);
}

function cleanMailHtml(value) {
  return String(value || "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 120000);
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>|<\/table>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 5000);
}

const MAX_MAIL_RECIPIENTS = 20;

function parseMailRecipients(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[,，;\n\r]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((email) => email && !seen.has(email) && seen.add(email));
}

function currentStaffPayload(session) {
  const permissions = adminPermissionProfile(session);
  return {
    id: Number(session.staffId || 1),
    username: session.staffUsername || "admin",
    root: isRootAdminSession(session),
    role: permissions.role,
    permissions,
  };
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  if (url.searchParams.get("template") === MARKETING_MAIL_TEMPLATE_ID) {
    if (!adminPermissionProfile(session).canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { getSettings } = await import("../../_settings.js");
    const settings = await getSettings();
    const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
    const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
    const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
    const marketingArgs = await buildMarketingArgs(brandName, siteDomain, siteUrl);
    return Response.json({
      ok: true,
      template: MARKETING_MAIL_TEMPLATE_ID,
      subject: MARKETING_MAIL_SUBJECT,
      preview: MARKETING_MAIL_PREVIEW,
      html: buildMarketingMailHtml(marketingArgs),
      text: buildMarketingMailText(marketingArgs),
    });
  }
  const logs = await getAdminMailLog();
  return Response.json({ ok: true, logs, currentStaff: currentStaffPayload(session) });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromSession(session);
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const template = body.template === MARKETING_MAIL_TEMPLATE_ID ? MARKETING_MAIL_TEMPLATE_ID : "customer";
  const isMarketingMail = template === MARKETING_MAIL_TEMPLATE_ID;
  const recipients = parseMailRecipients(body.to);
  const defaultSubject = isMarketingMail ? MARKETING_MAIL_SUBJECT : "客服服务通知";
  const subject = clean(body.subject || defaultSubject, 120) || defaultSubject;
  const content = cleanMailBody(body.content);
  const customHtml = isMarketingMail ? cleanMailHtml(body.html) : "";
  const invalidRecipients = recipients.filter((email) => !validEmail(email));
  if (recipients.length === 0 || invalidRecipients.length > 0) {
    return Response.json({
      ok: false,
      error: "invalid_email",
      detail: invalidRecipients.join(", "),
    }, { status: 400 });
  }
  if (recipients.length > MAX_MAIL_RECIPIENTS) {
    return Response.json({
      ok: false,
      error: "too_many_recipients",
      limit: MAX_MAIL_RECIPIENTS,
    }, { status: 400 });
  }
  if (!isMarketingMail && !content) return Response.json({ ok: false, error: "content_required" }, { status: 400 });

  // 品牌以站点设置为准
  const { getSettings } = await import("../../_settings.js");
  const settings = await getSettings();
  const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
  const mailSubject = subject.includes(brandName) ? subject : `${brandName} · ${subject}`;
  const marketingArgs = isMarketingMail ? await buildMarketingArgs(brandName, siteDomain, siteUrl) : null;
  const html = isMarketingMail
    ? (customHtml || buildMarketingMailHtml(marketingArgs))
    : buildCustomerMailHtml({
        subject,
        content,
        brandName,
        siteDomain,
        siteUrl,
        staffId: actor.staffId,
      });
  const text = isMarketingMail
    ? (customHtml ? (htmlToText(customHtml) || buildMarketingMailText(marketingArgs)) : buildMarketingMailText(marketingArgs))
    : buildCustomerMailText({
        subject,
        content,
        brandName,
        siteDomain,
        siteUrl,
        staffId: actor.staffId,
      });
  const logContent = isMarketingMail ? (customHtml ? `${MARKETING_MAIL_PREVIEW}（自定义 HTML）` : MARKETING_MAIL_PREVIEW) : content;

  const results = [];
  const logs = [];
  for (const to of recipients) {
    const result = await sendSimpleEmail({
      to,
      subject: mailSubject,
      text,
      html,
      category: isMarketingMail ? "marketing" : "support",
      relatedType: "admin_mail",
      fromName: `${brandName}客服`,
      marketing: isMarketingMail,
      support: settings.support,
    });
    const reason = result.ok ? "" : (result.reason || result.error || result.code || "send_failed");
    const log = await pushAdminMailLog({
      to,
      subject: mailSubject,
      content: logContent,
      preview: logContent,
      ok: result.ok,
      reason,
      messageId: result.messageId || "",
      staffId: actor.staffId,
      staffUsername: actor.staffUsername,
    });
    if (log) logs.push(log);
    results.push({
      to,
      ok: result.ok,
      reason,
      messageId: result.messageId || "",
      logId: log?.id || "",
    });
  }

  const sentCount = results.filter((item) => item.ok).length;
  const failedCount = results.length - sentCount;
  await pushAdminActionLog({
    action: "customer_mail_send",
    actor,
    target: recipients.length === 1 ? "mail:" + recipients[0] : "mail-batch:" + recipients.length,
    detail: {
      ok: sentCount > 0,
      subject: mailSubject,
      template,
      recipients,
      sentCount,
      failedCount,
      logIds: logs.map((item) => item.id),
    },
  });

  if (sentCount === 0) {
    return Response.json({
      ok: false,
      error: "send_failed",
      detail: results[0]?.reason || "",
      logs,
      results,
      sentCount,
      failedCount,
    }, { status: 502 });
  }
  return Response.json({
    ok: true,
    log: logs[0] || null,
    logs,
    results,
    sentCount,
    failedCount,
    messageId: results.find((item) => item.messageId)?.messageId || "",
  });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteAdminMailLogEntries(ids, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
  return Response.json(result);
}
