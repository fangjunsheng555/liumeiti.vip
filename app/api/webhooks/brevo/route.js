import { applyBrevoWebhookEvent, verifyBrevoWebhookToken } from "../../_mail-delivery.js";
import { recordHealthStatus } from "../../_health.js";

export const runtime = "nodejs";

export async function POST(request) {
  const secret = process.env.BREVO_WEBHOOK_TOKEN;
  if (!secret) return Response.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") || request.headers.get("authorization") || "";
  if (!verifyBrevoWebhookToken(supplied, secret)) {
    return Response.json({ ok: false, error: "invalid_authorization" }, { status: 401 });
  }
  let event;
  try { event = await request.json(); } catch (error) {
    return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }
  const result = await applyBrevoWebhookEvent(event);
  if (!result.ok) {
    await recordHealthStatus("brevo_webhook", {
      status: "error",
      summary: "Brevo 投递回执处理失败",
      error: result.error || "webhook_processing_failed",
      metrics: { event: event?.event || event?.msg_status || "unknown" },
    }).catch(() => {});
    return Response.json(result, { status: 500 });
  }
  await recordHealthStatus("brevo_webhook", {
    status: "ok",
    summary: "最近一条 Brevo 投递回执已接收",
    metrics: { event: event?.event || event?.msg_status || "unknown", duplicate: Boolean(result.duplicate) },
  }).catch(() => {});
  return Response.json({ ok: true, duplicate: Boolean(result.duplicate), ignored: Boolean(result.ignored) });
}
