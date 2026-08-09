import {
  dispatchDueMarketingCampaigns,
  MARKETING_RUNTIME_BATCH_LIMIT,
  normalizeMarketingBudgetResult,
} from "../../_marketing-campaign-queue.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handler(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = normalizeMarketingBudgetResult(await dispatchDueMarketingCampaigns({
    limit: MARKETING_RUNTIME_BATCH_LIMIT,
    deadlineAt: Date.now() + 50_000,
  }));
  return Response.json(result, {
    status: result?.ok === false ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiTelemetry("cron_marketing_campaign", handler);
