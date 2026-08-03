import {
  cleanupExpiredPushSubscriptions,
  dispatchPushOutbox,
  readPushQueueStats,
  recoverPushEnqueueFailures,
} from "../../_push.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

async function handler(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const recovery = await recoverPushEnqueueFailures({ limit: 100, timeBudgetMs: 5_000 });
  const dispatch = await dispatchPushOutbox({ limit: 20, timeBudgetMs: 40_000 });
  const cleanup = await cleanupExpiredPushSubscriptions({ limit: 300, timeBudgetMs: 5_000 });
  const stats = await readPushQueueStats();
  const ok = recovery.ok !== false && dispatch.ok !== false && cleanup.ok !== false && stats.ok !== false;
  return Response.json({ ok, recovery, dispatch, cleanup, stats }, {
    status: ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiTelemetry("cron_push", handler);
