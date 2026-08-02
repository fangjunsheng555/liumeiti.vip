import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  checkRateLimit,
  formatBeijingTime,
  rateLimitResponse,
  redisCmd,
} from "../../_utils.js";
import { authenticateUserRequest, userAuthErrorResponse } from "../../_auth-session.js";

export const runtime = "nodejs";

const MAX_BLOB = 256 * 1024;

function tool2faKey(email) {
  return "liumeiti:tool:2fa:" + String(email).toLowerCase().trim();
}

function dataKey() {
  const raw = process.env.TOOL_DATA_KEY || "";
  if (raw.length < 16) return null;
  return createHash("sha256").update(raw).digest();
}

function encryptAtRest(plaintext) {
  const key = dataKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return "v1:" + iv.toString("base64") + ":" + cipher.getAuthTag().toString("base64") + ":" + ciphertext.toString("base64");
}

function decryptAtRest(payload) {
  const key = dataKey();
  if (!key || !payload) return null;
  try {
    const [version, iv, tag, ciphertext] = String(payload).split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function parseReply(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const READ_SCRIPT = `
local function keytype(key)
  local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok end; return value
end
if keytype(KEYS[2])~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local userDecoded,user=pcall(cjson.decode,redis.call('GET',KEYS[2]))
if not userDecoded or type(user)~='table' or user.banned==true then return cjson.encode({ok=false,error='session_state_changed'}) end
local versionType=keytype(KEYS[3])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local currentVersion=versionType=='string' and tonumber(redis.call('GET',KEYS[3])) or 1
local expectedVersion=tonumber(ARGV[1])
if not currentVersion or currentVersion~=math.floor(currentVersion) or not expectedVersion or currentVersion~=expectedVersion then
  return cjson.encode({ok=false,error='session_state_changed'})
end
if keytype(KEYS[4])~='string' then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local currentLifecycle=redis.call('GET',KEYS[4])
if type(ARGV[2])~='string' or currentLifecycle~=ARGV[2] then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local kind=redis.call('TYPE',KEYS[1]); if type(kind)=='table' then kind=kind.ok end
if kind=='none' then return cjson.encode({ok=true,exists=false}) end
if kind~='string' then return cjson.encode({ok=false,error='record_invalid'}) end
local raw=redis.call('GET',KEYS[1])
local decoded,value=pcall(cjson.decode,raw)
if not decoded or type(value)~='table' or (value.deleted~=true and type(value.enc)~='string') then
  return cjson.encode({ok=false,error='record_invalid'})
end
local rev=tonumber(value.rev)
if not rev or rev<1 or rev~=math.floor(rev) or rev>9007199254740990 then
  return cjson.encode({ok=false,error='record_invalid'})
end
local envelopeLifecycle=value.accountLifecycleId
if type(envelopeLifecycle)~='string' then
  local tombstone=cjson.encode({deleted=true,rev=rev+1,accountLifecycleId=currentLifecycle})
  redis.call('SET',KEYS[1],tombstone)
  return cjson.encode({ok=true,exists=true,raw=tombstone,retired=true})
elseif envelopeLifecycle~=currentLifecycle then
  local tombstone=cjson.encode({deleted=true,rev=rev+1,accountLifecycleId=currentLifecycle})
  redis.call('SET',KEYS[1],tombstone)
  return cjson.encode({ok=true,exists=true,raw=tombstone,retired=true})
end
return cjson.encode({ok=true,exists=true,raw=raw})`;

const WRITE_SCRIPT = `
local function keytype(key)
  local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok end; return value
end
if keytype(KEYS[2])~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local userDecoded,user=pcall(cjson.decode,redis.call('GET',KEYS[2]))
if not userDecoded or type(user)~='table' then return cjson.encode({ok=false,error='session_state_changed'}) end
if user.banned==true then return cjson.encode({ok=false,error='account_banned'}) end
local versionType=keytype(KEYS[3])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local currentVersion=1
if versionType=='string' then currentVersion=tonumber(redis.call('GET',KEYS[3])) end
local expectedVersion=tonumber(ARGV[3])
if not currentVersion or currentVersion~=math.floor(currentVersion) or not expectedVersion or currentVersion~=expectedVersion then
  return cjson.encode({ok=false,error='session_state_changed'})
end
if keytype(KEYS[4])~='string' then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local currentLifecycle=redis.call('GET',KEYS[4])
if type(ARGV[4])~='string' or currentLifecycle~=ARGV[4] then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local kind=redis.call('TYPE',KEYS[1]); if type(kind)=='table' then kind=kind.ok end
if kind~='none' and kind~='string' then return cjson.encode({ok=false,error='record_invalid'}) end
local current=0
  if kind=='string' then
  local raw=redis.call('GET',KEYS[1])
  local decoded,value=pcall(cjson.decode,raw)
  if not decoded or type(value)~='table' then return cjson.encode({ok=false,error='record_invalid'}) end
  current=tonumber(value.rev)
  if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
    return cjson.encode({ok=false,error='record_invalid'})
  end
  local envelopeLifecycle=value.accountLifecycleId
  if type(envelopeLifecycle)~='string' or envelopeLifecycle~=currentLifecycle then
    return cjson.encode({ok=false,error='lifecycle_conflict'})
  end
end
local expected=tonumber(ARGV[1])
if not expected or expected<0 or expected~=math.floor(expected) or expected>9007199254740990 then
  return cjson.encode({ok=false,error='invalid_revision'})
end
if current~=expected then return cjson.encode({ok=false,error='revision_conflict',currentRev=current}) end
local decoded,nextValue=pcall(cjson.decode,ARGV[2])
if not decoded or type(nextValue)~='table' or tonumber(nextValue.rev)~=current+1 or nextValue.accountLifecycleId~=currentLifecycle or type(nextValue.enc)~='string' then
  return cjson.encode({ok=false,error='record_invalid'})
end
redis.call('SET',KEYS[1],ARGV[2])
return cjson.encode({ok=true,rev=current+1})`;

const DELETE_SCRIPT = `
local function keytype(key)
  local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok end; return value
end
if keytype(KEYS[2])~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local userDecoded,user=pcall(cjson.decode,redis.call('GET',KEYS[2]))
if not userDecoded or type(user)~='table' then return cjson.encode({ok=false,error='session_state_changed'}) end
if user.banned==true then return cjson.encode({ok=false,error='account_banned'}) end
local versionType=keytype(KEYS[3])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local currentVersion=versionType=='string' and tonumber(redis.call('GET',KEYS[3])) or 1
local expectedVersion=tonumber(ARGV[1])
if not currentVersion or currentVersion~=math.floor(currentVersion) or not expectedVersion or currentVersion~=expectedVersion then
  return cjson.encode({ok=false,error='session_state_changed'})
end
if keytype(KEYS[4])~='string' then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local currentLifecycle=redis.call('GET',KEYS[4])
if type(ARGV[2])~='string' or currentLifecycle~=ARGV[2] then return cjson.encode({ok=false,error='account_lifecycle_changed'}) end
local kind=keytype(KEYS[1])
if kind=='none' then
  redis.call('SET',KEYS[1],cjson.encode({deleted=true,rev=1,accountLifecycleId=currentLifecycle}))
  return cjson.encode({ok=true,deleted=false,rev=1})
end
if kind~='string' then return cjson.encode({ok=false,error='record_invalid'}) end
local decoded,value=pcall(cjson.decode,redis.call('GET',KEYS[1]))
if not decoded or type(value)~='table' then return cjson.encode({ok=false,error='record_invalid'}) end
local rev=tonumber(value.rev)
if not rev or rev<1 or rev~=math.floor(rev) or rev>9007199254740990 then return cjson.encode({ok=false,error='record_invalid'}) end
if value.deleted==true and value.accountLifecycleId==currentLifecycle then return cjson.encode({ok=true,deleted=false,rev=rev}) end
local nextRev=rev+1
redis.call('SET',KEYS[1],cjson.encode({deleted=true,rev=nextRev,accountLifecycleId=currentLifecycle}))
return cjson.encode({ok=true,deleted=true,rev=nextRev})`;

async function readEnvelopeForAuth(auth) {
  const reply = parseReply(await redisCmd([
    "EVAL",
    READ_SCRIPT,
    "4",
    tool2faKey(auth.email),
    "liumeiti:users:" + auth.email,
    "lm:user:authver:" + auth.email,
    "lm:user:lifecycle:" + auth.email,
    String(auth.authVersion),
    String(auth.accountLifecycleId || ""),
  ]));
  if (!reply?.ok) return { ok: false, error: reply?.error || "storage_unavailable" };
  if (!reply.exists) return { ok: true, envelope: null };
  try {
    const envelope = JSON.parse(reply.raw);
    return { ok: true, envelope };
  } catch {
    return { ok: false, error: "record_invalid" };
  }
}

export async function GET(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const state = await readEnvelopeForAuth(auth);
  if (!state.ok) {
    const status = state.error === "session_state_changed" || state.error === "account_lifecycle_changed" ? 409 : 503;
    return Response.json({ ok: false, error: state.error }, { status });
  }
  if (!state.envelope) return Response.json({ ok: true, data: null, rev: 0, updatedAt: null });
  if (state.envelope.deleted === true) {
    return Response.json({ ok: true, data: null, rev: state.envelope.rev, updatedAt: null });
  }
  const data = decryptAtRest(state.envelope.enc);
  if (data === null) return Response.json({ ok: false, error: "decrypt_failed" }, { status: 500 });
  return Response.json({
    ok: true,
    data,
    rev: state.envelope.rev,
    updatedAt: state.envelope.updatedAt || null,
  });
}

export async function PUT(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const guard = await checkRateLimit(request, {
    namespace: "tool:2fa:put",
    limit: 60,
    windowSec: 10 * 60,
    identity: auth.email,
  });
  if (!guard.ok) return rateLimitResponse(guard);

  let body = {};
  try { body = await request.json(); } catch {}
  const expectedRev = Number(body.rev);
  if (!Number.isSafeInteger(expectedRev) || expectedRev < 0) {
    return Response.json({ ok: false, error: "invalid_revision" }, { status: 400 });
  }
  const data = typeof body.data === "string" ? body.data : JSON.stringify(body.data ?? "");
  if (Buffer.byteLength(data, "utf8") > MAX_BLOB) {
    return Response.json({ ok: false, error: "too_large" }, { status: 413 });
  }
  const encrypted = encryptAtRest(data);
  if (!encrypted) return Response.json({ ok: false, error: "server_key_missing" }, { status: 500 });

  const now = new Date();
  const envelope = {
    rev: expectedRev + 1,
    accountLifecycleId: auth.accountLifecycleId,
    updatedAt: now.toISOString(),
    updatedAtBeijing: formatBeijingTime(now),
    enc: encrypted,
  };
  const reply = parseReply(await redisCmd([
    "EVAL",
    WRITE_SCRIPT,
    "4",
    tool2faKey(auth.email),
    "liumeiti:users:" + auth.email,
    "lm:user:authver:" + auth.email,
    "lm:user:lifecycle:" + auth.email,
    String(expectedRev),
    JSON.stringify(envelope),
    String(auth.authVersion),
    String(auth.accountLifecycleId || ""),
  ]));
  if (!reply) return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503 });
  if (!reply.ok) {
    const status = reply.error === "revision_conflict" || reply.error === "lifecycle_conflict"
      || reply.error === "session_state_changed" || reply.error === "account_lifecycle_changed" ? 409
      : reply.error === "invalid_revision" ? 400 : 503;
    return Response.json({ ok: false, error: reply.error, currentRev: reply.currentRev }, { status });
  }
  return Response.json({ ok: true, rev: reply.rev, updatedAt: envelope.updatedAt });
}

export async function DELETE(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const reply = parseReply(await redisCmd([
    "EVAL",
    DELETE_SCRIPT,
    "4",
    tool2faKey(auth.email),
    "liumeiti:users:" + auth.email,
    "lm:user:authver:" + auth.email,
    "lm:user:lifecycle:" + auth.email,
    String(auth.authVersion),
    String(auth.accountLifecycleId || ""),
  ]));
  if (!reply?.ok) {
    const error = reply?.error || "storage_unavailable";
    const status = error === "session_state_changed" || error === "account_lifecycle_changed" ? 409 : 503;
    return Response.json({ ok: false, error }, { status });
  }
  return Response.json({ ok: true, deleted: Boolean(reply.deleted), rev: reply.rev });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export const tool2faInternals = { READ_SCRIPT, WRITE_SCRIPT, DELETE_SCRIPT, tool2faKey };
