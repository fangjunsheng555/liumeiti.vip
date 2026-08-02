import { randomBytes } from "node:crypto";

import { clean, redisCmd, redisPipeline } from "../_utils.js";

const KEY = "lm:tool:quota";
const MAX_OVERRIDES = 2000;
const MAX_REQUESTS = 1000;
const MAX_CAS_ATTEMPTS = 12;

export const UNLIMITED = "unlimited";

export const AI_USE_CHAT_ALL = "lm:ai:use:chat:all";
export const AI_USE_IMG_ALL = "lm:ai:use:img:all";

function beijingDayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

export function aiUseDayKey(type) {
  return (type === "image" ? "lm:ai:use:img:d:" : "lm:ai:use:chat:d:") + beijingDayStr();
}

export async function recordAiUsage(type, email) {
  if (!email || (type !== "chat" && type !== "image")) return;
  const allKey = type === "image" ? AI_USE_IMG_ALL : AI_USE_CHAT_ALL;
  const dKey = aiUseDayKey(type);
  try {
    await redisPipeline([
      ["ZINCRBY", allKey, "1", email],
      ["ZINCRBY", dKey, "1", email],
      ["EXPIRE", dKey, "259200"],
    ]);
  } catch {}
}

function safeQuotaData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.overrides != null && !Array.isArray(value.overrides)) return null;
  if (value.requests != null && !Array.isArray(value.requests)) return null;
  return {
    overrides: Array.isArray(value.overrides) ? value.overrides.slice(-MAX_OVERRIDES) : [],
    requests: Array.isArray(value.requests) ? value.requests.slice(-MAX_REQUESTS) : [],
  };
}

function parseScriptReply(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Redis GET returning null cannot distinguish an absent key from a transport
// failure through the legacy helper. This wrapper always returns a JSON reply
// when Redis actually executed the command, including for an absent key.
const READ_QUOTA_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if raw then return cjson.encode({ok=true,exists=true,raw=raw}) end
return cjson.encode({ok=true,exists=false})`;

const CAS_QUOTA_SCRIPT = `
local current=redis.call('GET',KEYS[1])
if ARGV[1]=='0' then
  if current then return cjson.encode({ok=false,error='conflict'}) end
elseif not current or current~=ARGV[2] then
  return cjson.encode({ok=false,error='conflict'})
end
redis.call('SET',KEYS[1],ARGV[3])
return cjson.encode({ok=true})`;

const CAS_USER_QUOTA_SCRIPT = `
local function kind(key)
  local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok end; return value
end
if kind(KEYS[2])~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local decoded,user=pcall(cjson.decode,redis.call('GET',KEYS[2]))
if not decoded or type(user)~='table' or user.banned==true then return cjson.encode({ok=false,error='session_state_changed'}) end
local versionType=kind(KEYS[3])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='session_state_changed'}) end
local currentVersion=versionType=='string' and tonumber(redis.call('GET',KEYS[3])) or 1
local expectedVersion=tonumber(ARGV[4])
if not currentVersion or currentVersion~=math.floor(currentVersion) or not expectedVersion or currentVersion~=expectedVersion then
  return cjson.encode({ok=false,error='session_state_changed'})
end
local current=redis.call('GET',KEYS[1])
if ARGV[1]=='0' then
  if current then return cjson.encode({ok=false,error='conflict'}) end
elseif not current or current~=ARGV[2] then
  return cjson.encode({ok=false,error='conflict'})
end
redis.call('SET',KEYS[1],ARGV[3])
return cjson.encode({ok=true})`;

async function readQuotaSnapshot() {
  const reply = parseScriptReply(await redisCmd(["EVAL", READ_QUOTA_SCRIPT, "1", KEY]));
  if (!reply?.ok) return { ok: false, error: "quota_store_unavailable" };
  if (!reply.exists) return { ok: true, exists: false, raw: "", data: { overrides: [], requests: [] } };
  if (typeof reply.raw !== "string") return { ok: false, error: "quota_record_invalid" };
  let parsed;
  try { parsed = JSON.parse(reply.raw); } catch { return { ok: false, error: "quota_record_invalid" }; }
  const data = safeQuotaData(parsed);
  return data
    ? { ok: true, exists: true, raw: reply.raw, data }
    : { ok: false, error: "quota_record_invalid" };
}

export async function readQuotaState() {
  const snapshot = await readQuotaSnapshot();
  return snapshot.ok
    ? { ok: true, data: snapshot.data }
    : { ok: false, error: snapshot.error || "quota_store_unavailable" };
}

// Kept for callers that only need a read. Storage failures are explicit rather
// than being converted to an empty global object that a later writer could
// persist over real overrides and approvals.
export async function readQuota() {
  return readQuotaState();
}

async function mutateQuota(mutator, options = {}) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = await readQuotaSnapshot();
    if (!snapshot.ok) return snapshot;
    const working = {
      overrides: snapshot.data.overrides.map((entry) => ({ ...entry })),
      requests: snapshot.data.requests.map((entry) => ({ ...entry })),
    };
    const mutation = mutator(working);
    if (!mutation?.ok) return mutation || { ok: false, error: "quota_mutation_invalid" };
    if (mutation.noWrite) return mutation;
    const next = safeQuotaData(working);
    if (!next) return { ok: false, error: "quota_mutation_invalid" };
    const nextRaw = JSON.stringify(next);
    const principal = options.principal;
    const guarded = principal?.email && Number.isSafeInteger(Number(principal.authVersion));
    const command = guarded
      ? [
          "EVAL", CAS_USER_QUOTA_SCRIPT, "3",
          KEY,
          "liumeiti:users:" + principal.email,
          "lm:user:authver:" + principal.email,
          snapshot.exists ? "1" : "0",
          snapshot.exists ? snapshot.raw : "-",
          nextRaw,
          String(principal.authVersion),
        ]
      : [
          "EVAL", CAS_QUOTA_SCRIPT, "1", KEY,
          snapshot.exists ? "1" : "0",
          snapshot.exists ? snapshot.raw : "-",
          nextRaw,
        ];
    const reply = parseScriptReply(await redisCmd(command));
    if (!reply) return { ok: false, error: "quota_store_unavailable" };
    if (reply.ok) return { ...mutation, data: next };
    if (reply.error === "session_state_changed") return { ok: false, error: reply.error };
    if (reply.error !== "conflict") return { ok: false, error: "quota_store_unavailable" };
  }
  return { ok: false, error: "quota_write_conflict" };
}

function sameId(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function upsertOverride(overrides, override) {
  const index = overrides.findIndex((entry) => entry?.type === override.type && entry?.email === override.email);
  if (index >= 0) overrides[index] = override;
  else overrides.push(override);
}

export async function createQuotaRequest({ email, type, requested, reason = "", authVersion = 0, now = Date.now(), id = "" }) {
  const requestId = clean(id, 80) || ("QR" + randomBytes(12).toString("hex").toUpperCase());
  return mutateQuota((data) => {
    const existing = data.requests.find((entry) => entry?.email === email && entry?.type === type && entry?.status === "pending");
    if (existing) return { ok: false, error: "pending_exists", request: existing };
    const request = {
      id: requestId,
      email,
      type,
      requested,
      reason,
      status: "pending",
      createdAt: now,
    };
    data.requests.push(request);
    data.requests = data.requests.slice(-MAX_REQUESTS);
    return { ok: true, request };
  }, { principal: { email, authVersion: Number(authVersion) } });
}

export async function decideQuotaRequest({ id, status, decidedBy, override = null, now = Date.now() }) {
  return mutateQuota((data) => {
    const request = data.requests.find((entry) => entry && sameId(entry.id, id));
    if (!request) return { ok: false, error: "not_found" };
    if (request.status !== "pending") {
      return request.status === status
        ? { ok: true, idempotent: true, request, noWrite: true }
        : { ok: false, error: "request_already_decided" };
    }
    request.status = status;
    request.decidedAt = now;
    request.decidedBy = decidedBy;
    if (status === "approved" && override) upsertOverride(data.overrides, override);
    return { ok: true, request };
  });
}

export async function setQuotaOverride(override) {
  return mutateQuota((data) => {
    upsertOverride(data.overrides, override);
    data.overrides = data.overrides.slice(-MAX_OVERRIDES);
    return { ok: true, override };
  });
}

export async function cancelQuotaOverride(type, email) {
  return mutateQuota((data) => {
    const before = data.overrides.length;
    data.overrides = data.overrides.filter((entry) => !(entry?.type === type && entry?.email === email));
    return { ok: true, removed: before - data.overrides.length };
  });
}

export async function cancelQuotaRequest(id) {
  return mutateQuota((data) => {
    const before = data.requests.length;
    data.requests = data.requests.filter((entry) => !(entry && sameId(entry.id, id)));
    return { ok: true, removed: before - data.requests.length };
  });
}

export async function getOverrideState(type, email) {
  const state = await readQuotaState();
  if (!state.ok) return state;
  return {
    ok: true,
    override: state.data.overrides.find((entry) => entry?.type === type && entry?.email === email) || null,
  };
}

export async function getOverride(type, email) {
  const state = await getOverrideState(type, email);
  return state.ok ? state.override : null;
}

export const quotaInternals = {
  KEY,
  READ_QUOTA_SCRIPT,
  CAS_QUOTA_SCRIPT,
  CAS_USER_QUOTA_SCRIPT,
};
