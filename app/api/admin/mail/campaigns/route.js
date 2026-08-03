import { adminPermissionProfile, adminSessionFromRequest, getAllOrdersStrict } from "../../../_utils.js";
import { getMarketingCampaignCountersBatch, listMarketingCampaigns } from "../../../_marketing-campaign-queue.js";
import { isRecognizedSale, orderValueBreakdown } from "../../insights/metrics.js";
import { withApiTelemetry } from "../../../_observability.js";

export const runtime = "nodejs";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const limit = Math.min(300, Number(new URL(request.url).searchParams.get("limit") || 100));
  let campaigns = [];
  try {
    campaigns = await listMarketingCampaigns({ limit });
  } catch {
    return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  }
  const includeAttribution = new URL(request.url).searchParams.get("includeAttribution") === "1";
  const attributed = new Map();
  if (includeAttribution) {
    let orders;
    try { orders = await getAllOrdersStrict(); } catch {
      return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
    }
    for (const order of orders) {
      const campaignId = String(order?.marketingAttribution?.campaignId || "");
      if (!campaignId || !isRecognizedSale(order)) continue;
      const current = attributed.get(campaignId) || { saleCount: 0, revenue: 0 };
      current.saleCount += 1;
      current.revenue = Math.round((current.revenue + orderValueBreakdown(order).gross) * 100) / 100;
      attributed.set(campaignId, current);
    }
  }
  const counterBatch = await getMarketingCampaignCountersBatch(campaigns.map((campaign) => campaign.id));
  if (!counterBatch.ok) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  const rows = campaigns.map((campaign) => {
    const counters = counterBatch.byId[campaign.id] || {};
    const sales = attributed.get(campaign.id) || { saleCount: 0, revenue: 0 };
    const clicks = Number(counters.uniqueClicks || 0);
    const delivered = Number(counters.delivered || 0);
    return {
      ...campaign,
      counters,
      ...(includeAttribution ? { attribution: {
        ...sales,
        conversionRate: clicks ? Math.round((sales.saleCount / clicks) * 10000) / 100 : 0,
        clickThroughRate: delivered ? Math.round((clicks / delivered) * 10000) / 100 : 0,
      } } : {}),
    };
  });
  return Response.json({ ok: true, campaigns: rows }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_marketing_campaign", handler);
