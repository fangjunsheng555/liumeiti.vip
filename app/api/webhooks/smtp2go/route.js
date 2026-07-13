import {
  applySmtp2goWebhookEvent,
  verifySmtp2goWebhookAuthorization,
} from "../../_mail-delivery.js";

export const runtime = "nodejs";

async function readEvent(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const payload = await request.text();
  if (!payload) return null;
  if (contentType.includes("application/json")) {
    try { return JSON.parse(payload); } catch (error) { return null; }
  }
  return Object.fromEntries(new URLSearchParams(payload).entries());
}

export async function POST(request) {
  const secret = process.env.SMTP2GO_WEBHOOK_TOKEN;
  if (!secret) return Response.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  if (!verifySmtp2goWebhookAuthorization(request.headers.get("authorization"), secret)) {
    return Response.json({ ok: false, error: "invalid_authorization" }, { status: 401 });
  }
  const event = await readEvent(request);
  if (!event) return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  const result = await applySmtp2goWebhookEvent(event);
  if (!result.ok) return Response.json(result, { status: 500 });
  return Response.json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    ignored: Boolean(result.ignored),
  });
}
