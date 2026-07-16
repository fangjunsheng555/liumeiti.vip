import { applyResendWebhookEvent, verifyResendWebhookSignature } from "../../_mail-delivery.js";
import { recordHealthStatus } from "../../_health.js";

export const runtime = "nodejs";

export async function POST(request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  const payload = await request.text();
  const id = request.headers.get("svix-id") || "";
  const timestamp = request.headers.get("svix-timestamp") || "";
  const signature = request.headers.get("svix-signature") || "";
  if (!verifyResendWebhookSignature({ payload, id, timestamp, signature, secret })) {
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }
  let event;
  try { event = JSON.parse(payload); } catch (e) {
    return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }
  const result = await applyResendWebhookEvent(event, id);
  if (!result.ok) {
    await recordHealthStatus("resend_webhook", {
      status: "error",
      summary: "Resend 投递回执处理失败",
      error: result.error || "webhook_processing_failed",
      metrics: { event: event.type || "unknown" },
    }).catch(() => {});
    return Response.json(result, { status: 500 });
  }
  await recordHealthStatus("resend_webhook", {
    status: "ok",
    summary: "最近一条投递回执已接收",
    metrics: { event: event.type || "unknown", duplicate: Boolean(result.duplicate) },
  }).catch(() => {});
  return Response.json({ ok: true, duplicate: Boolean(result.duplicate), ignored: Boolean(result.ignored) });
}
