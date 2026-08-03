import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  pushAdminActionLog,
  validEmail,
} from "../../../_utils.js";
import {
  clearMailSuppression,
  listMailSuppressions,
  suppressMailAddress,
} from "../../../_mail-preferences.js";

export const runtime = "nodejs";

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && adminPermissionProfile(session).canSendMail ? session : null;
}

export async function GET(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const limit = Math.min(500, Number(new URL(request.url).searchParams.get("limit") || 200));
  const result = await listMailSuppressions({ limit });
  if (!result.ok) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  return Response.json({ ok: true, suppressions: result.suppressions }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  const scope = ["marketing", "optional", "all"].includes(body.scope) ? body.scope : "marketing";
  const result = await suppressMailAddress({ email, scope, reason: clean(body.reason || "admin_manual", 120), source: "admin" });
  if (!result.ok) return Response.json(result, { status: 503 });
  const actor = adminActorFromSession(session);
  await pushAdminActionLog({ action: "mail_suppression_add", actor, target: `mail:${email}`, detail: { scope, reason: body.reason || "admin_manual" } });
  return Response.json({ ok: true, contact: result.contact });
}

export async function DELETE(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  const result = await clearMailSuppression({ email, source: "admin", reason: clean(body.reason || "manual_clear", 120) });
  if (!result.ok) return Response.json(result, { status: result.error === "contact_not_found" ? 404 : 503 });
  const actor = adminActorFromSession(session);
  await pushAdminActionLog({ action: "mail_suppression_clear", actor, target: `mail:${email}`, detail: { reason: body.reason || "manual_clear" } });
  return Response.json({ ok: true, contact: result.contact });
}
