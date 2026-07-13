import { dispatchDueMarketingCampaigns } from "../../_marketing-campaign-queue.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await dispatchDueMarketingCampaigns({ limit: 40 });
  return Response.json(result, {
    status: result?.ok === false && !result?.submitted ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
