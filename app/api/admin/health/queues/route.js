import { adminSessionFromRequest, isRootAdminSession } from "../../../_utils.js";
import { readLatestQueueSnapshots, sampleOperationalQueues, withApiTelemetry } from "../../../_observability.js";

export const runtime = "nodejs";

async function handler(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  let queues;
  try {
    queues = await readLatestQueueSnapshots();
    if (url.searchParams.get("refresh") === "1" || queues.every((queue) => !queue.checkedAt)) {
      queues = await sampleOperationalQueues();
    }
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "operational_queue_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ ok: true, queues }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", handler);
