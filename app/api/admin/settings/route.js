// Root-only site settings. Public readers remain fail-open, while this admin
// route reports storage failures and protects concurrent edits with a revision.
import {
  adminSessionFromRequest,
  isRootAdminSession,
  adminActorFromRequest,
  pushAdminActionLog,
} from "../../_utils.js";
import { getAdminSettingsStateStrict, saveSettings, SETTINGS_DEFAULTS } from "../../_settings.js";
import { validateSettingsSubmission } from "../../../lib/settings-defaults.js";

export const runtime = "nodejs";

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const { settings, currentVersion } = await getAdminSettingsStateStrict();
    return Response.json({ ok: true, defaults: SETTINGS_DEFAULTS, settings, currentVersion });
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "settings_store_unavailable"),
    }, { status: 503 });
  }
}

export async function PUT(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({
      ok: false,
      error: "invalid_request",
      fieldErrors: { settings: "请求内容不是有效的 JSON" },
    }, { status: 400 });
  }
  const validated = validateSettingsSubmission(body?.settings);
  if (!validated.ok) {
    return Response.json({
      ok: false,
      error: "invalid_settings",
      fieldErrors: validated.fieldErrors,
    }, { status: 400 });
  }
  if (!Number.isSafeInteger(body?.baseVersion) || body.baseVersion < 0) {
    return Response.json({
      ok: false,
      error: "invalid_base_version",
      fieldErrors: { baseVersion: "请刷新设置后重试" },
    }, { status: 400 });
  }

  const saved = await saveSettings(validated.settings, { expectedVersion: body.baseVersion });
  if (saved.conflict) {
    return Response.json({
      ok: false,
      error: "version_conflict",
      currentVersion: saved.currentVersion,
    }, { status: 409 });
  }
  if (!saved.ok) {
    return Response.json({ ok: false, error: saved.error || "settings_store_unavailable" }, { status: 503 });
  }

  // The settings document is already committed. Audit logging is secondary
  // and must never turn that successful primary operation into a failure.
  try {
    await pushAdminActionLog({
      action: "settings_update",
      actor: adminActorFromRequest(request),
      target: "site-settings",
      detail: { version: saved.currentVersion },
    });
  } catch {}
  return Response.json({
    ok: true,
    settings: validated.settings,
    currentVersion: saved.currentVersion,
  });
}
