import { adminPermissionProfile, adminSessionFromRequest, clean } from "../../../_utils.js";
import { getSettings } from "../../../_settings.js";
import { buildMarketingArgs } from "../marketing-data.js";
import { buildMarketingMailHtml, buildMarketingMailText } from "../marketing-template.js";
import {
  MARKETING_MAIL_V7_TEMPLATE_ID,
  buildMarketingMailV7Html,
  buildMarketingMailV7Text,
  sanitizeMarketingMailHtml,
  validateMarketingOffer,
} from "../marketing-template-v7.js";

export const runtime = "nodejs";

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
    .slice(0, 8000);
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch {}
  const isV7 = body.template === MARKETING_MAIL_V7_TEMPLATE_ID;
  const validated = isV7 ? validateMarketingOffer(body.offer || {}) : { ok: true, offer: null };
  if (!validated.ok) return Response.json({ ok: false, error: validated.error }, { status: 400 });
  const settings = await getSettings();
  const brandName = settings.brand.name || process.env.BRAND_NAME || "冒央会社";
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || "https://www.liumeiti.vip";
  const args = { ...(await buildMarketingArgs(brandName, siteDomain, siteUrl)), offer: validated.offer };
  const supplied = String(body.html || "");
  const sanitized = supplied ? sanitizeMarketingMailHtml(supplied) : "";
  const html = sanitized || (isV7 ? buildMarketingMailV7Html(args) : buildMarketingMailHtml(args));
  const builtText = isV7 ? buildMarketingMailV7Text(args) : buildMarketingMailText(args);
  const text = sanitized ? (htmlToText(sanitized) || builtText) : builtText;
  return Response.json({
    ok: true,
    template: isV7 ? MARKETING_MAIL_V7_TEMPLATE_ID : "service_selection_edm_v6",
    subject: clean(body.subject, 120),
    html,
    text,
    sanitized: Boolean(supplied && supplied !== sanitized),
    offer: validated.offer,
  }, { headers: { "cache-control": "no-store" } });
}
