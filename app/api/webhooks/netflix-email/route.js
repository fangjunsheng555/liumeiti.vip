import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redisCmd, redisPipeline } from "../../_utils.js";
import { parseNetflixEmail } from "../../netflix-code/_parser.js";
import { storeNetflixMailEvent, verifyNetflixMailEvent } from "../../netflix-code/_store.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const PROCESSING_TTL_SECONDS = 5 * 60;
const COMMITTED_TTL_SECONDS = 24 * 60 * 60;

const REPLACE_MARKER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;

const RELEASE_MARKER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function signatureFor(secret, timestamp, digest) {
  return createHmac("sha256", secret).update(`${timestamp}\n${digest}`).digest("base64url");
}

function pipelineRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

function pipelineValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
    ? entry.result
    : entry;
}

async function readReplayMarker(key) {
  const response = await redisPipeline([["GET", key], ["PING"]]);
  const rows = pipelineRows(response);
  if (rows.length !== 2 || rows.some((entry) => entry?.error)
    || String(pipelineValue(rows[1]) || "").toUpperCase() !== "PONG") {
    return { ok: false, error: "storage_unavailable" };
  }
  return { ok: true, raw: pipelineValue(rows[0]) };
}

function parseReplayMarker(raw) {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function replaceReplayMarker(key, expectedRaw, nextRaw, ttlSeconds) {
  const changed = await redisCmd([
    "EVAL",
    REPLACE_MARKER_SCRIPT,
    "1",
    key,
    expectedRaw,
    nextRaw,
    String(ttlSeconds),
  ]);
  if (Number(changed) === 1) return true;
  // Covers a committed Redis mutation followed by a lost HTTP response.
  const current = await readReplayMarker(key);
  return current.ok && current.raw === nextRaw;
}

async function claimReplayMarker(key, digest) {
  const processingRaw = JSON.stringify({
    version: 1,
    state: "processing",
    digest,
    token: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await redisCmd([
      "SET", key, processingRaw, "NX", "EX", String(PROCESSING_TTL_SECONDS),
    ]);
    if (created === "OK") return { ok: true, processingRaw };

    const current = await readReplayMarker(key);
    if (!current.ok) return current;
    if (current.raw === processingRaw) return { ok: true, processingRaw };
    if (current.raw == null) continue;

    const marker = parseReplayMarker(current.raw);
    if (marker?.state === "committed") {
      if (marker.digest !== digest || !marker.eventId) {
        return { ok: false, error: "replay_marker_invalid" };
      }
      const verified = await verifyNetflixMailEvent(marker.eventId, digest);
      if (!verified.ok) return verified;
      if (verified.exists && verified.matches) return { ok: true, duplicate: true };
      if (verified.exists) return { ok: false, error: "replay_event_mismatch" };
      // A committed marker without its event is not a successful replay. Take
      // ownership and rebuild the deterministic event instead.
    } else if (marker?.state === "ignored" && marker.digest === digest) {
      return { ok: true, duplicate: true, ignored: true, reason: marker.reason || "ignored" };
    } else if (marker?.state === "processing") {
      if (marker.digest !== digest) return { ok: false, error: "replay_marker_invalid" };
      // Event IDs and arrival sequences are deterministic for a delivery, so
      // concurrent authenticated retries may safely share the active claim.
      // This avoids two workers repeatedly stealing the marker from each other.
      return { ok: true, processingRaw: current.raw };
    }

    if (await replaceReplayMarker(key, current.raw, processingRaw, PROCESSING_TTL_SECONDS)) {
      return { ok: true, processingRaw };
    }
  }
  return { ok: false, error: "ingest_busy" };
}

async function commitReplayMarker(key, processingRaw, marker) {
  const committedRaw = JSON.stringify(marker);
  return replaceReplayMarker(key, processingRaw, committedRaw, COMMITTED_TTL_SECONDS);
}

async function releaseReplayMarker(key, processingRaw) {
  await redisCmd(["EVAL", RELEASE_MARKER_SCRIPT, "1", key, processingRaw]);
}

async function postHandler(request) {
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
  let claim = await claimReplayMarker(replayKey, digest);
  if (!claim.ok) return Response.json({ ok: false, error: claim.error || "storage_unavailable" }, { status: 503 });
  if (claim.duplicate) {
    return Response.json({ ok: true, duplicate: true, ...(claim.ignored ? { ignored: true, reason: claim.reason } : {}) }, { status: 202 });
  }

  const parsed = await parseNetflixEmail(raw, {
    from: request.headers.get("x-email-envelope-from") || "",
    to: request.headers.get("x-email-envelope-to") || "",
    inboxAddress: process.env.NETFLIX_INBOX_ADDRESS || "netflix@codes.liumeiti.vip",
    receivedAt: new Date(timestampNumber).toISOString(),
  });
  // The catch-all address may receive unrelated mail. Ignore untrusted traffic
  // instead of filling the operational log with encrypted spam records.
  if (!parsed.accepted && ["untrusted_sender", "account_email_missing"].includes(parsed.reason)) {
    const committed = await commitReplayMarker(replayKey, claim.processingRaw, {
      version: 1,
      state: "ignored",
      digest,
      reason: parsed.reason,
      committedAt: new Date().toISOString(),
    });
    if (!committed) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
    return Response.json({ ok: true, ignored: true, reason: parsed.reason }, { status: 202 });
  }
  const messageId = request.headers.get("x-email-message-id") || "";
  const stored = await storeNetflixMailEvent(parsed, { messageId, digest });
  if (!stored.ok) {
    await releaseReplayMarker(replayKey, claim.processingRaw);
    return Response.json({ ok: false, error: stored.error || "storage_failed" }, { status: 503 });
  }
  let committed = await commitReplayMarker(replayKey, claim.processingRaw, {
    version: 1,
    state: "committed",
    digest,
    eventId: stored.eventId,
    committedAt: new Date().toISOString(),
  });
  if (!committed) {
    // Another retry may have taken over while this request was storing. Reclaim
    // once; a committed winner is accepted only after durable-event validation.
    claim = await claimReplayMarker(replayKey, digest);
    if (claim.duplicate) committed = true;
    else if (claim.ok) {
      committed = await commitReplayMarker(replayKey, claim.processingRaw, {
        version: 1,
        state: "committed",
        digest,
        eventId: stored.eventId,
        committedAt: new Date().toISOString(),
      });
    }
  }
  if (!committed) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  return Response.json({
    ok: true,
    eventId: stored.eventId,
    accepted: stored.accepted,
    kind: stored.kind,
    reason: stored.reason,
  }, { status: 202 });
}

async function getHandler() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const POST = withApiTelemetry("netflix_mail_ingest", postHandler);
export const GET = withApiTelemetry("netflix_mail_ingest", getHandler);
