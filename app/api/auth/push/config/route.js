import { pushServerConfiguration } from "../../../_push.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = pushServerConfiguration();
  return Response.json({
    ok: true,
    enabled: config.enabled,
    configured: config.configured,
    publicKey: config.configured ? config.publicKey : "",
  }, { headers: { "cache-control": "no-store" } });
}
