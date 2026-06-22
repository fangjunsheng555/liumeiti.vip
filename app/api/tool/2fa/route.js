// Tool Maoyang — 2FA cloud sync (server-side encrypted at rest).
// Identity is the shared liumeiti.vip account (lm_user session cookie).
// Data lives in the same Upstash Redis under liumeiti:tool:2fa:<email>.
//
// Security model (chosen by site owner): the client sends the plaintext 2FA
// payload over HTTPS; the server encrypts it AT REST with TOOL_DATA_KEY before
// storing, and decrypts on read. So a raw DB dump alone cannot reveal seeds.
// Sync is strictly opt-in on the 2FA page (default off).
//
// This file is purely additive — it imports existing helpers and edits nothing.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import {
  redisCmd, redisPipeline,
  verifySession, getCookieFromRequest, validEmail,
  checkRateLimit, rateLimitResponse, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs"; // needs node:crypto

const MAX_BLOB = 256 * 1024; // 256 KB cap per account

function tool2faKey(email) {
  return "liumeiti:tool:2fa:" + String(email).toLowerCase().trim();
}

// Derive a 32-byte key from TOOL_DATA_KEY (accepts any reasonably-strong string).
function dataKey() {
  const raw = process.env.TOOL_DATA_KEY || "";
  if (!raw || raw.length < 16) return null;
  return createHash("sha256").update(raw).digest();
}

function encryptAtRest(plaintext) {
  const key = dataKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return "v1:" + iv.toString("base64") + ":" + tag.toString("base64") + ":" + ct.toString("base64");
}

function decryptAtRest(payload) {
  const key = dataKey();
  if (!key || !payload) return null;
  try {
    const [v, ivb, tagb, ctb] = String(payload).split(":");
    if (v !== "v1" || !ivb || !tagb || !ctb) return null;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64"));
    d.setAuthTag(Buffer.from(tagb, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctb, "base64")), d.final()]).toString("utf8");
  } catch (e) { return null; }
}

function authedEmail(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !validEmail(session.email)) return null;
  return String(session.email).toLowerCase();
}

async function readEnvelope(email) {
  const raw = await redisCmd(["GET", tool2faKey(email)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function writeEnvelope(email, env) {
  const result = await redisPipeline([["SET", tool2faKey(email), JSON.stringify(env)]]);
  if (!result) return false;
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.result) ? result.result : []);
  return rows.length > 0 && !rows[0]?.error;
}

// GET — return the user's decrypted 2FA payload (plaintext over HTTPS) + rev.
export async function GET(request) {
  const email = authedEmail(request);
  if (!email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  const env = await readEnvelope(email);
  if (!env || !env.enc) return Response.json({ ok: true, data: null, rev: 0, updatedAt: null });
  const data = decryptAtRest(env.enc);
  if (data === null) return Response.json({ ok: false, error: "decrypt_failed" }, { status: 500 });
  return Response.json({ ok: true, data, rev: Number(env.rev) || 0, updatedAt: env.updatedAt || null });
}

// PUT — store the user's 2FA payload (encrypted at rest). Body: { data: string|object, rev?: number }.
export async function PUT(request) {
  const email = authedEmail(request);
  if (!email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });

  const guard = await checkRateLimit(request, {
    namespace: "tool:2fa:put", limit: 60, windowSec: 10 * 60, identity: email,
  });
  if (!guard.ok) return rateLimitResponse(guard);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const data = typeof body.data === "string" ? body.data : JSON.stringify(body.data ?? "");
  if (data.length > MAX_BLOB) return Response.json({ ok: false, error: "too_large" }, { status: 413 });

  const enc = encryptAtRest(data);
  if (!enc) return Response.json({ ok: false, error: "server_key_missing" }, { status: 500 });

  const now = new Date();
  const rev = (Number(body.rev) || 0) + 1;
  const env = { rev, updatedAt: now.toISOString(), updatedAtBeijing: formatBeijingTime(now), enc };
  const ok = await writeEnvelope(email, env);
  if (!ok) return Response.json({ ok: false, error: "storage_failed" }, { status: 500 });
  return Response.json({ ok: true, rev, updatedAt: env.updatedAt });
}

// DELETE — remove the user's cloud copy (e.g. when they turn sync off and choose to wipe).
export async function DELETE(request) {
  const email = authedEmail(request);
  if (!email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  await redisCmd(["DEL", tool2faKey(email)]);
  return Response.json({ ok: true });
}

// OPTIONS preflight is answered by middleware.js (CORS); keep a no-op fallback.
export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
