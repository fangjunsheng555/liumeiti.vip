import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { redisCmd } from "../../_utils.js";
import { parseNetflixEmail } from "../../netflix-code/_parser.js";
import { storeNetflixMailEvent } from "../../netflix-code/_store.js";

export const runtime = "nodejs";

const MAX_RAW_BYTES = 5 * 1024 * 1024;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function signatureFor(secret, timestamp, digest) {
  return createHmac("sha256", secret).update(`${timestamp}\n${digest}`).digest("base64url");
}

export async function POST(request) {
  const secret = String(process.env.NETFLIX_EMAIL_INGEST_SECRET || "");
  if (secret.length < 32) return Response.json({ ok: false, error: "ingest_not_configured" }, { status: 503 });
  const timestamp = String(request.headers.get("x-email-timestamp") || "");
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > 5 * 60 * 1000) {
    return Response.json({ ok: false, error: "request_expired" }, { status: 401 });
  }
  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (declaredSize > MAX_RAW_BYTES) return Response.json({ ok: false, error: "message_too_large" }, { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (!raw.length || raw.length > MAX_RAW_BYTES) return Response.json({ ok: false, error: "invalid_message_size" }, { status: 413 });
  const digest = createHash("sha256").update(raw).digest("hex");
  const signature = String(request.headers.get("x-email-signature") || "").replace(/^v1=/, "");
  if (!safeEqual(signature, signatureFor(secret, timestamp, digest))) {
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const replayKey = `liumeiti:netflix-mail:ingest:${digest}`;
  const first = await redisCmd(["SET", replayKey, "1", "NX", "EX", "86400"]);
  if (first !== "OK") return Response.json({ ok: true, duplicate: true }, { status: 202 });

  const parsed = await parseNetflixEmail(raw, {
    from: request.headers.get("x-email-envelope-from") || "",
    to: request.headers.get("x-email-envelope-to") || "",
    inboxAddress: process.env.NETFLIX_INBOX_ADDRESS || "netflix@codes.liumeiti.vip",
    receivedAt: new Date(timestampNumber).toISOString(),
  });
  // The catch-all address may receive unrelated mail. Ignore untrusted traffic
  // instead of filling the operational log with encrypted spam records.
  if (!parsed.accepted && ["untrusted_sender", "account_email_missing"].includes(parsed.reason)) {
    return Response.json({ ok: true, ignored: true, reason: parsed.reason }, { status: 202 });
  }
  const messageId = request.headers.get("x-email-message-id") || "";
  const stored = await storeNetflixMailEvent(parsed, { messageId, digest });
  if (!stored.ok) {
    await redisCmd(["DEL", replayKey]);
    return Response.json({ ok: false, error: stored.error || "storage_failed" }, { status: 503 });
  }
  return Response.json({
    ok: true,
    eventId: stored.eventId,
    accepted: stored.accepted,
    kind: stored.kind,
    reason: stored.reason,
  }, { status: 202 });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
