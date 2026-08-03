import {
  getMailPreferencesByToken,
  updateMailPreferencesByToken,
} from "../../_mail-preferences.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

function resultStatus(result) {
  if (result?.ok) return 200;
  if (["storage_unavailable", "storage_failed"].includes(result?.error)) return 503;
  return result?.error === "contact_not_found" ? 404 : 400;
}

function tokenFrom(request, body = {}) {
  return String(new URL(request.url).searchParams.get("token") || body.token || "").trim();
}

function publicResult(result) {
  if (!result?.ok) return result;
  const contact = result.contact;
  return contact ? {
    ok: true,
    maskedEmail: contact.email.replace(/^(.{1,2}).*(@.*)$/, "$1***$2"),
    locale: contact.locale,
    preferences: contact.preferences,
    suppression: contact.suppression,
  } : result;
}

async function getHandler(request) {
  const result = await getMailPreferencesByToken(tokenFrom(request));
  return Response.json(result, { status: resultStatus(result), headers });
}

async function update(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const token = tokenFrom(request, body);
  if (!token) return Response.json({ ok: false, error: "token_required" }, { status: 400, headers });
  const result = await updateMailPreferencesByToken(token, body.preferences || {}, "preferences_page");
  return Response.json(publicResult(result), { status: resultStatus(result), headers });
}

export const GET = withApiTelemetry("mail_preferences", getHandler);
export const PATCH = withApiTelemetry("mail_preferences", update);
export const POST = PATCH;
