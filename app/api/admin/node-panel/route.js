// Node panel reachability probe for staff. Read-only: it calls the panel's
// /ping, which still requires the token, so a success proves the panel answers,
// its external API is switched on, and the token in the site settings is the
// one it accepts. Nothing is created or modified.
import { adminSessionFromRequest, isRootAdminSession } from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { recordHealthStatus } from "../../_health.js";
import { checkNodePanel, describeNodePanelCheck, nodePanelConfigFromSettings } from "../../_node-panel.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  // The probe reveals whether the token works, so it stays with the role that
  // can edit it.
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const config = nodePanelConfigFromSettings(await getSettings());
  const result = await checkNodePanel({ config });
  // A manual probe is as good a health sample as the scheduled one, so record
  // it too: staff testing after a token change immediately clears the alert.
  await recordHealthStatus("node_panel", {
    status: result.status === "ok" ? "ok" : result.status === "disabled" ? "disabled" : "error",
    summary: describeNodePanelCheck(result),
    error: result.ok ? "" : String(result.error || "panel_check_failed"),
    metrics: { latencyMs: Number(result.latencyMs || 0) },
  });
  return Response.json({
    ok: result.ok,
    status: result.status,
    error: result.ok ? "" : result.error || "panel_check_failed",
    message: describeNodePanelCheck(result),
    latencyMs: result.latencyMs,
    version: result.version || "",
    role: result.role || "",
    apiBase: config.base,
    enabled: config.enabled,
    // `configured` already means "enabled and a token is present"; deriving it
    // here keeps the token itself out of this file's response entirely.
    configured: config.configured,
  }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApiTelemetry("admin_node_panel_check", handler);
