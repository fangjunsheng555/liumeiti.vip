// 后台站点设置(仅超级管理员)。读默认+覆盖+合并;写覆盖到 Redis。
import { adminSessionFromRequest, isRootAdminSession, adminActorFromRequest, pushAdminActionLog } from "../../_utils.js";
import { getSettings, getSettingsOverrides, saveSettings, SETTINGS_DEFAULTS } from "../../_settings.js";

export const runtime = "nodejs";

function gate(request) {
  const s = adminSessionFromRequest(request);
  return s && isRootAdminSession(s) ? s : null;
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const overrides = await getSettingsOverrides();
  const settings = await getSettings(overrides);
  return Response.json({ ok: true, defaults: SETTINGS_DEFAULTS, settings });
}

export async function PUT(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  // body.settings = 完整合并结构(面板提交);saveSettings 会再 merge 一次做白名单校验。
  const ok = await saveSettings(body.settings);
  if (!ok) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  const actor = adminActorFromRequest(request);
  await pushAdminActionLog({ action: "settings_update", actor, target: "site-settings" });
  const settings = await getSettings();
  return Response.json({ ok: true, settings });
}
