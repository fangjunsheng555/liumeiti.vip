import { authenticateUserRequest, userAuthErrorResponse } from "../../_auth-session.js";
import { ensureMailContact, updateMailPreferences } from "../../_mail-preferences.js";
import { getCookieFromRequest } from "../../_utils.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";
const privacyHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function privateResponse(response) {
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function trustedLocale(request, body = {}) {
  const cookie = getCookieFromRequest(request, "locale");
  if (cookie === "en" || cookie === "zh") return cookie;
  return body.locale === "en" || body.locale === "zh" ? body.locale : "";
}

async function getHandler(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return privateResponse(userAuthErrorResponse(auth));
  const contact = await ensureMailContact(auth.email, { source: "account", locale: trustedLocale(request) });
  if (!contact) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503, headers: privacyHeaders });
  return Response.json({ ok: true, email: auth.email, preferences: contact.preferences, suppression: contact.suppression }, { headers: privacyHeaders });
}

async function patchHandler(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return privateResponse(userAuthErrorResponse(auth));
  let body = {};
  try { body = await request.json(); } catch {}
  const result = await updateMailPreferences({ email: auth.email, preferences: body.preferences || {}, source: "account", locale: trustedLocale(request, body) });
  if (!result.ok) return Response.json(result, { status: 503, headers: privacyHeaders });
  return Response.json({ ok: true, email: auth.email, preferences: result.contact.preferences, suppression: result.contact.suppression }, { headers: privacyHeaders });
}

export const GET = withApiTelemetry("mail_preferences", getHandler);
export const PATCH = withApiTelemetry("mail_preferences", patchHandler);
