import {
  adminPermissionProfile,
  adminSessionFromRequest,
  getAllOrdersStrict,
} from "../../../../../_utils.js";
import {
  getMarketingCampaignCountersBatch,
  readMarketingCampaign,
} from "../../../../../_marketing-campaign-queue.js";
import { isRecognizedSale, orderValueBreakdown } from "../../../../insights/metrics.js";
import { withApiTelemetry } from "../../../../../_observability.js";

export const runtime = "nodejs";

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

async function handler(request, { params }) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { campaignId } = await params;
  let campaignRead;
  let counterBatch;
  let orders;
  try {
    [campaignRead, counterBatch, orders] = await Promise.all([
      readMarketingCampaign(campaignId),
      getMarketingCampaignCountersBatch([campaignId]),
      getAllOrdersStrict(),
    ]);
  } catch {
    return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  }
  if (!campaignRead.ok || !counterBatch.ok) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  const campaign = campaignRead.campaign;
  if (!campaign) return Response.json({ ok: false, error: "campaign_not_found" }, { status: 404 });
  const counters = counterBatch.byId[campaign.id] || {};
  const attributed = orders.filter((order) => order?.marketingAttribution?.campaignId === campaign.id);
  const sales = attributed.filter(isRecognizedSale);
  const values = sales.map(orderValueBreakdown);
  const revenue = round2(values.reduce((sum, value) => sum + value.gross, 0));
  const directRevenue = round2(values.reduce((sum, value) => sum + value.direct, 0));
  const delivered = Number(counters.delivered || 0);
  const uniqueClicks = Number(counters.uniqueClicks || 0);
  return Response.json({
    ok: true,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      subject: campaign.subject,
      scheduledAt: campaign.scheduledAt,
      templateId: campaign.templateId,
    },
    counters,
    attribution: {
      model: "last_email_click_30d",
      orderCount: attributed.length,
      saleCount: sales.length,
      revenue,
      directRevenue,
      conversionRate: uniqueClicks ? Math.round((sales.length / uniqueClicks) * 10000) / 100 : 0,
      clickThroughRate: delivered ? Math.round((uniqueClicks / delivered) * 10000) / 100 : 0,
      ...(permissions.canViewOrders ? { orderIds: sales.slice(0, 100).map((order) => order.orderId) } : {}),
    },
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_marketing_campaign", handler);
