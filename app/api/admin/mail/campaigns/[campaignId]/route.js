import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  pushAdminActionLog,
} from "../../../../_utils.js";
import {
  getMarketingCampaignCountersBatch,
  readMarketingCampaign,
  updateMarketingCampaignStatus,
} from "../../../../_marketing-campaign-queue.js";
import { withApiTelemetry } from "../../../../_observability.js";

export const runtime = "nodejs";

function sessionFor(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return { error: Response.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  if (!adminPermissionProfile(session).canSendMail) return { error: Response.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  return { session };
}

async function getHandler(request, { params }) {
  const gate = sessionFor(request);
  if (gate.error) return gate.error;
  const { campaignId } = await params;
  const [read, counterBatch] = await Promise.all([
    readMarketingCampaign(campaignId),
    getMarketingCampaignCountersBatch([campaignId]),
  ]);
  if (!read.ok || !counterBatch.ok) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  const campaign = read.campaign;
  if (!campaign) return Response.json({ ok: false, error: "campaign_not_found" }, { status: 404 });
  return Response.json({ ok: true, campaign, counters: counterBatch.byId[campaignId] || {} }, { headers: { "cache-control": "no-store" } });
}

async function patchHandler(request, { params }) {
  const gate = sessionFor(request);
  if (gate.error) return gate.error;
  let body = {};
  try { body = await request.json(); } catch {}
  const aliases = { pause: "paused", resume: "scheduled", cancel: "cancelled" };
  const status = aliases[body.action] || body.status;
  if (!["paused", "scheduled", "cancelled"].includes(status)) {
    return Response.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }
  const { campaignId } = await params;
  const actor = adminActorFromSession(gate.session);
  const result = await updateMarketingCampaignStatus(campaignId, status, actor);
  if (!result.ok) {
    const statusCode = result.error === "campaign_not_found" ? 404 : (["invalid_status_transition", "campaign_in_flight"].includes(result.error) ? 409 : 503);
    return Response.json(result, { status: statusCode });
  }
  await pushAdminActionLog({ action: `marketing_campaign_${status}`, actor, target: `campaign:${campaignId}`, detail: { status } });
  return Response.json(result);
}

export const GET = withApiTelemetry("admin_marketing_campaign", getHandler);
export const PATCH = withApiTelemetry("admin_marketing_campaign", patchHandler);
