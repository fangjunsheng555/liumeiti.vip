import { adminPermissionProfile, adminSessionFromRequest, clean } from "../../../_utils.js";
import { getSettings } from "../../../_settings.js";
import { buildMarketingArgs, marketingContentHash, marketingOfferSnapshotHash } from "../marketing-data.js";
import {
  MARKETING_MAIL_SUBJECT,
  MARKETING_MAIL_TEMPLATE_ID,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "../marketing-template.js";
import {
  MARKETING_MAIL_V7_SUBJECT,
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
  let marketingArgs;
  try {
    marketingArgs = await buildMarketingArgs(brandName, siteDomain, siteUrl, { requireLiveCatalog: isV7 });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message === "marketing_catalog_empty" ? "marketing_catalog_empty" : "marketing_catalog_unavailable",
    }, { status: 503 });
  }
  const args = { ...marketingArgs, offer: validated.offer };
  const supplied = String(body.html || "");
  // V7 is deliberately catalog-backed: accepting caller HTML here would let a
  // stale or external admin client reintroduce invented prices and promo copy.
  // Keep custom HTML compatibility only for the legacy template.
  const sanitized = !isV7 && supplied ? sanitizeMarketingMailHtml(supplied) : "";
  const html = sanitized || (isV7 ? buildMarketingMailV7Html(args) : buildMarketingMailHtml(args));
  const builtText = isV7 ? buildMarketingMailV7Text(args) : buildMarketingMailText(args);
  const text = sanitized ? (htmlToText(sanitized) || builtText) : builtText;
  const templateId = isV7 ? MARKETING_MAIL_V7_TEMPLATE_ID : MARKETING_MAIL_TEMPLATE_ID;
  const defaultSubject = isV7 ? MARKETING_MAIL_V7_SUBJECT : MARKETING_MAIL_SUBJECT;
  const subjectBase = clean(body.subject || defaultSubject, 120) || defaultSubject;
  const subject = subjectBase.includes(brandName) ? subjectBase : `${brandName} · ${subjectBase}`;
  const contentHash = marketingContentHash({ templateId, subject, html, text });
  const offerSnapshotHash = marketingOfferSnapshotHash(validated.offer);
  return Response.json({
    ok: true,
    template: templateId,
    subject: subjectBase,
    html,
    text,
    contentHash,
    offerSnapshotHash,
    sanitized: Boolean(!isV7 && supplied && supplied !== sanitized),
    customHtmlIgnored: Boolean(isV7 && supplied),
    offer: validated.offer,
  }, { headers: { "cache-control": "no-store" } });
}
