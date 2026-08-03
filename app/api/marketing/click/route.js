import { resolveMarketingClick } from "../../_mail-preferences.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";

async function handler(request) {
  const token = String(new URL(request.url).searchParams.get("token") || "");
  const result = await resolveMarketingClick(token);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error || "invalid_link" }, {
      status: 400,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: result.destination,
      "set-cookie": result.cookie,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export const GET = withApiTelemetry("marketing_click", handler);
