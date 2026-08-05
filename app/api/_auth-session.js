import { randomBytes } from "node:crypto";

import {
  USERS_KEY,
  clearCookieValue,
  getCookieFromRequest,
  redisCmd,
  signSession,
  validEmail,
  verifySession,
} from "./_utils.js";
import { accountLifecycleKey, balanceCentsKey, redisEvalAtomic } from "./_money.js";
import {
  REDIS_ATOMIC_CLUSTER_MODE,
  redisAtomicKeyspaceMode,
} from "./_redis-atomic-keyspace.js";

export const USER_SESSION_TYPE = "user-session";
export const TOKEN_ISSUER = "liumeiti-auth";
export const USER_SESSION_AUDIENCE = "web-user";
export const USER_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 60 * 1000;
const AUTH_VERSION_PREFIX = "lm:user:authver:";
const USER_EMAIL_SET_KEY = "liumeiti:users:emails";
const LEGACY_USER_DEADLINE_KEY = "lm:auth:legacy-user-until:v2";
const RESET_CODE_PREFIX = "liumeiti:reset:";

const AFTER_SALES_SPEC = {
  type: "after-sales-order",
  audience: "after-sales",
  ttlMs: 24 * 60 * 60 * 1000,
};

const NETFLIX_CODE_SPEC = {
  type: "netflix-code-session",
  audience: "netflix-code",
  ttlMs: 15 * 60 * 1000,
};

export const NETFLIX_ORDER_VERIFICATION_COOKIE = "lm_netflix_order_verify";
export const NETFLIX_ORDER_VERIFICATION_TTL_SECONDS = 15 * 60;

const NETFLIX_ORDER_VERIFICATION_SPEC = {
  type: "netflix-order-verification",
  audience: "netflix-code-authorize",
  ttlMs: NETFLIX_ORDER_VERIFICATION_TTL_SECONDS * 1000,
};

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedNetflixVerificationOrderIds(values, requireCanonical = false) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) return null;
  const normalized = [];
  for (const value of values) {
    if (typeof value !== "string") return null;
    const orderId = value.trim().replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9_-]{1,80}$/.test(orderId)) return null;
    if (requireCanonical && value !== orderId) return null;
    if (!normalized.includes(orderId)) normalized.push(orderId);
  }
  return normalized.length === values.length ? normalized : null;
}

export function validAccountLifecycleId(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ""));
}

function newAccountLifecycleId() {
  return randomBytes(16).toString("hex");
}

function authVersionKey(email) {
  return AUTH_VERSION_PREFIX + normalizeEmail(email);
}

function userRecordKey(email) {
  return USERS_KEY + ":" + normalizeEmail(email);
}

function parseUserRecord(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const user = JSON.parse(raw);
    return user && typeof user === "object" && !Array.isArray(user) ? user : null;
  } catch (error) {
    return null;
  }
}

function jsonStringEnd(raw, start) {
  if (raw[start] !== '"') return -1;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") {
      index += 1;
      continue;
    }
    if (raw[index] === '"') return index + 1;
  }
  return -1;
}

function jsonValueEnd(raw, start) {
  if (raw[start] === '"') return jsonStringEnd(raw, start);
  if (raw[start] === "{" || raw[start] === "[") {
    const stack = [raw[start]];
    for (let index = start + 1; index < raw.length; index += 1) {
      if (raw[index] === '"') {
        index = jsonStringEnd(raw, index) - 1;
        if (index < 0) return -1;
        continue;
      }
      if (raw[index] === "{" || raw[index] === "[") stack.push(raw[index]);
      else if (raw[index] === "}" || raw[index] === "]") {
        const expected = raw[index] === "}" ? "{" : "[";
        if (stack.pop() !== expected) return -1;
        if (stack.length === 0) return index + 1;
      }
    }
    return -1;
  }
  let end = start;
  while (end < raw.length && raw[end] !== "," && raw[end] !== "}") end += 1;
  while (end > start && /\s/.test(raw[end - 1])) end -= 1;
  return end;
}

// Change only explicitly named top-level fields while retaining every other
// byte of the historical profile. In particular, this avoids a Lua cjson
// decode/encode round-trip that converts [] to {} and rounds large numbers.
function patchTopLevelJsonFields(raw, updates) {
  const parsed = parseUserRecord(raw);
  if (!parsed) return "";

  const replacements = new Map(Object.entries(updates || {}).map(([key, value]) => [key, JSON.stringify(value)]));
  if (!replacements.size || Array.from(replacements.values()).some((value) => value === undefined)) return "";
  const found = new Set();
  const edits = [];
  const skipWhitespace = (position) => {
    let next = position;
    while (next < raw.length && /\s/.test(raw[next])) next += 1;
    return next;
  };

  let index = skipWhitespace(0);
  if (raw[index] !== "{") return "";
  index = skipWhitespace(index + 1);
  let closingBrace = -1;
  let propertyCount = 0;
  while (index < raw.length) {
    if (raw[index] === "}") {
      closingBrace = index;
      break;
    }
    const keyEnd = jsonStringEnd(raw, index);
    if (keyEnd < 0) return "";
    let key;
    try { key = JSON.parse(raw.slice(index, keyEnd)); } catch { return ""; }
    index = skipWhitespace(keyEnd);
    if (raw[index] !== ":") return "";
    const valueStart = skipWhitespace(index + 1);
    const valueEnd = jsonValueEnd(raw, valueStart);
    if (valueEnd < 0) return "";
    propertyCount += 1;
    if (replacements.has(key)) {
      edits.push({ start: valueStart, end: valueEnd, value: replacements.get(key) });
      found.add(key);
    }
    index = skipWhitespace(valueEnd);
    if (raw[index] === ",") {
      index = skipWhitespace(index + 1);
      continue;
    }
    if (raw[index] === "}") {
      closingBrace = index;
      break;
    }
    return "";
  }
  if (closingBrace < 0 || skipWhitespace(closingBrace + 1) !== raw.length) return "";

  const missing = Array.from(replacements.entries()).filter(([key]) => !found.has(key));
  if (missing.length) {
    const fields = missing.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",");
    edits.push({
      start: closingBrace,
      end: closingBrace,
      value: `${propertyCount ? "," : ""}${fields}`,
    });
  }

  let next = raw;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  }
  return parseUserRecord(next) ? next : "";
}

function patchUserPasswordFields(raw, passwordHash, passwordResetAt) {
  return patchTopLevelJsonFields(raw, { passwordHash, passwordResetAt });
}

function strictLifetime(claim, maxTtlMs, now) {
  const issuedAt = finiteTimestamp(claim?.iat);
  const expiresAt = finiteTimestamp(claim?.exp);
  if (!issuedAt || !expiresAt) return false;
  if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= now) return false;
  return expiresAt > issuedAt && expiresAt - issuedAt <= maxTtlMs + CLOCK_SKEW_MS;
}

function legacyLifetime(claim, maxTtlMs, now) {
  const expiresAt = finiteTimestamp(claim?.exp);
  return Boolean(expiresAt && expiresAt > now && expiresAt - now <= maxTtlMs + CLOCK_SKEW_MS);
}

function signCapability(spec, payload, ttlMs = spec.ttlMs, now = Date.now()) {
  const lifetime = Math.max(1, Math.min(Number(ttlMs) || spec.ttlMs, spec.ttlMs));
  return signSession({
    ...payload,
    v: 2,
    typ: spec.type,
    iss: TOKEN_ISSUER,
    aud: spec.audience,
    iat: now,
    exp: now + lifetime,
    jti: randomBytes(12).toString("base64url"),
  });
}

function verifyCapability(token, spec, now = Date.now()) {
  const claim = verifySession(token);
  if (!claim || typeof claim !== "object") return null;

  if (claim.v === 2 || claim.typ || claim.iss || claim.aud) {
    if (claim.v !== 2 || claim.typ !== spec.type) return null;
    if (claim.iss !== TOKEN_ISSUER || claim.aud !== spec.audience) return null;
    if (typeof claim.jti !== "string" || claim.jti.length < 12 || claim.jti.length > 120) return null;
    if (!strictLifetime(claim, spec.ttlMs, now)) return null;
    return claim;
  }

  // Rolling-deploy compatibility for already-issued purpose tokens. Their
  // exact type and original maximum lifetime remain mandatory, so they can
  // never enter the legacy user-session path.
  if (claim.type !== spec.type || !legacyLifetime(claim, spec.ttlMs, now)) return null;
  return claim;
}

export function signAfterSalesToken(payload, ttlMs = AFTER_SALES_SPEC.ttlMs, now = Date.now()) {
  return signCapability(AFTER_SALES_SPEC, payload, ttlMs, now);
}

export function verifyAfterSalesToken(token, now = Date.now()) {
  return verifyCapability(token, AFTER_SALES_SPEC, now);
}

export function signNetflixCodeSession(payload, ttlMs = NETFLIX_CODE_SPEC.ttlMs, now = Date.now()) {
  return signCapability(NETFLIX_CODE_SPEC, payload, ttlMs, now);
}

export function verifyNetflixCodeSession(token, now = Date.now()) {
  return verifyCapability(token, NETFLIX_CODE_SPEC, now);
}

export function signNetflixOrderVerification(payload, ttlMs = NETFLIX_ORDER_VERIFICATION_SPEC.ttlMs, now = Date.now()) {
  const email = normalizeEmail(payload?.email);
  const orderIds = normalizedNetflixVerificationOrderIds(payload?.orderIds);
  if (!validEmail(email) || !orderIds) return "";
  return signCapability(NETFLIX_ORDER_VERIFICATION_SPEC, { email, orderIds }, ttlMs, now);
}

export function verifyNetflixOrderVerification(token, now = Date.now()) {
  const claim = verifyCapability(token, NETFLIX_ORDER_VERIFICATION_SPEC, now);
  // This capability is new and has no rolling-deploy legacy tokens to honor.
  // Requiring the v2 envelope prevents a same-secret legacy purpose token from
  // being accepted without its issuer/audience checks.
  if (!claim || claim.v !== 2 || claim.typ !== NETFLIX_ORDER_VERIFICATION_SPEC.type) return null;
  const email = normalizeEmail(claim.email);
  const orderIds = normalizedNetflixVerificationOrderIds(claim.orderIds, true);
  if (!validEmail(email) || claim.email !== email || !orderIds) return null;
  return { ...claim, email, orderIds };
}

export function netflixOrderVerificationFromRequest(request, now = Date.now()) {
  try {
    const token = getCookieFromRequest(request, NETFLIX_ORDER_VERIFICATION_COOKIE);
    return verifyNetflixOrderVerification(token, now);
  } catch {
    // A malformed percent-encoded Cookie must behave like a missing capability,
    // never turn a public authorization request into a 500 response.
    return null;
  }
}

export function signUserSessionForVersion(emailValue, authVersion, now = Date.now()) {
  const email = normalizeEmail(emailValue);
  const version = positiveInteger(authVersion);
  if (!validEmail(email) || !version) return "";
  return signSession({
    v: 2,
    typ: USER_SESSION_TYPE,
    iss: TOKEN_ISSUER,
    aud: USER_SESSION_AUDIENCE,
    sub: email,
    // Kept during the rolling migration because old route handlers read
    // session.email. The strict verifier requires it to match sub exactly.
    email,
    sv: version,
    iat: now,
    exp: now + USER_SESSION_TTL_MS,
    jti: randomBytes(12).toString("base64url"),
  });
}

export function verifyUserSessionCapability(token, now = Date.now()) {
  const claim = verifySession(token);
  if (!claim || claim.v !== 2 || claim.typ !== USER_SESSION_TYPE) return null;
  if (claim.iss !== TOKEN_ISSUER || claim.aud !== USER_SESSION_AUDIENCE) return null;
  if (typeof claim.jti !== "string" || claim.jti.length < 12 || claim.jti.length > 120) return null;
  if (!strictLifetime(claim, USER_SESSION_TTL_MS, now)) return null;
  const subject = normalizeEmail(claim.sub);
  if (!validEmail(subject) || normalizeEmail(claim.email) !== subject) return null;
  const authVersion = positiveInteger(claim.sv);
  if (!authVersion) return null;
  return { ...claim, sub: subject, email: subject, sv: authVersion };
}

function verifyLegacyUserSession(token, now = Date.now()) {
  const claim = verifySession(token);
  if (!claim || typeof claim !== "object") return null;
  if (claim.type || claim.typ || claim.role || claim.iss || claim.aud || claim.sv) return null;
  const email = normalizeEmail(claim.email);
  if (!validEmail(email) || !legacyLifetime(claim, USER_SESSION_TTL_MS, now)) return null;
  return { ...claim, email };
}

function absoluteTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function configuredLegacyUserDeadline(env = process.env) {
  const absoluteUntil = String(env?.LEGACY_USER_SESSION_UNTIL || "").trim();
  if (absoluteUntil) return absoluteTimestamp(absoluteUntil);

  const deployedAtRaw = String(env?.LEGACY_USER_SESSION_DEPLOYED_AT || "").trim();
  if (!deployedAtRaw) return 0;
  const deployedAt = absoluteTimestamp(deployedAtRaw);
  if (!deployedAt || !Number.isSafeInteger(deployedAt + USER_SESSION_TTL_MS)) return 0;
  return deployedAt + USER_SESSION_TTL_MS;
}

async function ensureLegacyUserDeadline(now = Date.now()) {
  const hasExplicitConfiguration = Boolean(
    String(process.env.LEGACY_USER_SESSION_UNTIL || "").trim()
    || String(process.env.LEGACY_USER_SESSION_DEPLOYED_AT || "").trim(),
  );
  if (hasExplicitConfiguration) {
    // Both supported settings are absolute deployment configuration. Unlike
    // the previous `now + 14 days` fallback, their value cannot be extended by
    // a user's first visit or by a cold start. LEGACY_USER_SESSION_UNTIL takes
    // precedence so operators can publish one auditable migration deadline.
    // A malformed rollout value must not turn into a 503 loop. Treat it as an
    // expired migration window so the browser can clear the legacy cookie and
    // the user can immediately sign in again with a typed session.
    return configuredLegacyUserDeadline() || -1;
  }

  const raw = await redisCmd(["GET", LEGACY_USER_DEADLINE_KEY]);
  if (raw != null) return absoluteTimestamp(raw) || -1;

  // Older deployments did not always seed the rollout anchor. Initializing it
  // with NX keeps every instance on one deadline and avoids locking all active
  // legacy users behind a 503. A legacy token is independently capped at the
  // same 14-day lifetime, so this recovery cannot extend that token itself.
  const candidate = finiteTimestamp(now) + USER_SESSION_TTL_MS;
  if (!Number.isSafeInteger(candidate)) return -1;
  const initialized = await redisCmd(["SET", LEGACY_USER_DEADLINE_KEY, String(candidate), "NX"]);
  if (initialized === "OK") return candidate;

  // SET returning null can mean either an NX race or an unavailable Redis
  // transport. One read distinguishes a winner from a real outage.
  const racedRaw = await redisCmd(["GET", LEGACY_USER_DEADLINE_KEY]);
  return racedRaw == null ? 0 : (absoluteTimestamp(racedRaw) || -1);
}

const READ_SESSION_ISSUANCE_STATE_SCRIPT = `
-- READ_SESSION_ISSUANCE_STATE_V3
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
local function validversion(raw)
  if not raw or not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<1 or value~=math.floor(value) or value>9007199254740990 then return nil end
  return value
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='user_not_found'}) end
local emailSetType=keytype(KEYS[3])
local emailSetWritable=emailSetType=='none' or emailSetType=='set'
local lifecycleType=keytype(KEYS[4])
if lifecycleType~='none' and lifecycleType~='string' then
  redis.call('DEL',KEYS[4])
  lifecycleType='none'
end
local raw=redis.call('GET',KEYS[1])
local decoded,user=pcall(cjson.decode,raw)
if not decoded or type(user)~='table' then return encode({ok=false,error='account_record_invalid'}) end
if user.banned==true then return encode({ok=false,error='account_banned'}) end
local versionType=keytype(KEYS[2])
local current=1
if versionType=='string' then
  current=validversion(redis.call('GET',KEYS[2]))
end
if not current then current=1 end
if versionType~='string' or not validversion(redis.call('GET',KEYS[2])) then
  if versionType~='none' then redis.call('DEL',KEYS[2]) end
  redis.call('SET',KEYS[2],'1')
  versionType='string'
end
local expected=tonumber(ARGV[1] or '0')
if not expected or expected<0 or expected~=math.floor(expected) then
  return encode({ok=false,error='invalid_auth_version'})
end
if expected>0 and current~=expected then return encode({ok=false,error='session_state_changed'}) end
local lifecycle=redis.call('GET',KEYS[4])
if lifecycle then
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then
    redis.call('DEL',KEYS[4])
    lifecycle=nil
  end
end
if not lifecycle then
  lifecycle=ARGV[3]
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then
    return encode({ok=false,error='invalid_lifecycle_candidate'})
  end
  redis.call('SET',KEYS[4],lifecycle)
end
if emailSetWritable then redis.call('SADD',KEYS[3],ARGV[2]) end
return encode({ok=true,authVersion=current,accountLifecycleId=lifecycle,emailIndexRepairRequired=not emailSetWritable})`;

function unsupportedAtomicKeyspaceError() {
  const mode = redisAtomicKeyspaceMode();
  if (mode === "legacy") return "";
  return mode === REDIS_ATOMIC_CLUSTER_MODE
    ? "redis_cluster_keyspace_not_supported"
    : "invalid_redis_keyspace_mode";
}

async function readSessionIssuanceState(email, expectedAuthVersion = 0) {
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, error: keyspaceError };
  const expected = Number(expectedAuthVersion || 0);
  if (!Number.isSafeInteger(expected) || expected < 0) return { ok: false, error: "invalid_auth_version" };
  const result = await redisEvalAtomic(
    READ_SESSION_ISSUANCE_STATE_SCRIPT,
    [userRecordKey(email), authVersionKey(email), USER_EMAIL_SET_KEY, accountLifecycleKey(email)],
    [expected, email, newAccountLifecycleId()],
  );
  if (result.ok && result.value?.emailIndexRepairRequired) {
    console.warn("[auth] user email index has an incompatible Redis type; session issuance continued");
  }
  return result.ok ? result.value : result;
}

export async function ensureUserAuthVersion(emailValue) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) return { ok: false, error: "invalid_email" };
  const state = await readSessionIssuanceState(email);
  return state.ok ? { ...state, email } : state;
}

export async function createUserSession(emailValue, now = Date.now(), expectedAuthVersion = 0) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) return { ok: false, error: "invalid_email" };
  const state = await readSessionIssuanceState(email, expectedAuthVersion);
  if (!state.ok) return state;
  const token = signUserSessionForVersion(email, state.authVersion, now);
  return token
    ? { ...state, email, token }
    : { ok: false, error: "session_sign_failed" };
}

const READ_PASSWORD_RESET_PROFILE_SCRIPT = `
-- READ_PASSWORD_RESET_PROFILE_V1
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
if keytype(KEYS[2])~='string' or redis.call('GET',KEYS[2])~=ARGV[1] then
  return encode({ok=false,error='code_invalid_or_expired'})
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='user_not_found'}) end
return encode({ok=true,userRaw=redis.call('GET',KEYS[1])})`;

const RESET_PASSWORD_AND_REVOKE_SCRIPT = `
-- RESET_PASSWORD_AND_REVOKE_V2
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
local function validversion(raw)
  if not raw or not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<1 or value~=math.floor(value) or value>=9007199254740990 then return nil end
  return value
end
if keytype(KEYS[3])~='string' or redis.call('GET',KEYS[3])~=ARGV[3] then
  return encode({ok=false,error='code_invalid_or_expired'})
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='user_not_found'}) end
if redis.call('GET',KEYS[1])~=ARGV[4] then return encode({ok=false,error='account_state_changed'}) end
local versionType=keytype(KEYS[2])
local current=1
if versionType=='string' then
  current=validversion(redis.call('GET',KEYS[2]))
end
if not current then current=1 end
if versionType~='string' or not validversion(redis.call('GET',KEYS[2])) then
  if versionType~='none' then redis.call('DEL',KEYS[2]) end
  redis.call('SET',KEYS[2],'1')
end
if ARGV[1]=='' or ARGV[2]=='' or ARGV[5]=='' then return encode({ok=false,error='invalid_password_update'}) end
local nextVersion=current+1
redis.call('SET',KEYS[1],ARGV[5])
redis.call('SET',KEYS[2],tostring(nextVersion))
redis.call('DEL',KEYS[3])
return encode({ok=true,authVersion=nextVersion})`;

export async function resetPasswordAndRevokeSessions(emailValue, passwordHash, resetCode, resetAt = new Date().toISOString()) {
  const email = normalizeEmail(emailValue);
  const hash = String(passwordHash || "");
  const code = String(resetCode || "").trim();
  const timestamp = String(resetAt || "");
  if (!validEmail(email) || !hash || hash.length > 500 || !/^\d{6}$/.test(code) || !finiteTimestamp(Date.parse(timestamp))) {
    return { ok: false, error: "invalid_password_update" };
  }
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, error: keyspaceError };
  const keys = [userRecordKey(email), authVersionKey(email), RESET_CODE_PREFIX + email];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prepared = await redisEvalAtomic(
      READ_PASSWORD_RESET_PROFILE_SCRIPT,
      [keys[0], keys[2]],
      [code],
    );
    if (!prepared.ok) return prepared;
    if (!prepared.value?.ok) return prepared.value || { ok: false, error: "invalid_storage_response" };
    const raw = String(prepared.value.userRaw || "");
    const nextRaw = patchUserPasswordFields(raw, hash, timestamp);
    if (!nextRaw) return { ok: false, error: "account_record_invalid" };
    const committed = await redisEvalAtomic(
      RESET_PASSWORD_AND_REVOKE_SCRIPT,
      keys,
      [hash, timestamp, code, raw, nextRaw],
    );
    if (!committed.ok) return committed;
    if (committed.value?.error === "account_state_changed") continue;
    return committed.value?.ok ? { ...committed.value, email } : committed.value;
  }
  return { ok: false, error: "account_state_changed" };
}

const READ_BAN_PROFILE_SCRIPT = `
-- READ_BAN_PROFILE_V1
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='user_not_found'}) end
return encode({ok=true,userRaw=redis.call('GET',KEYS[1])})`;

const SET_BAN_STATE_AND_REVOKE_SCRIPT = `
-- SET_BAN_STATE_AND_REVOKE_V2
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
local function validversion(raw)
  if not raw or not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<1 or value~=math.floor(value) or value>=9007199254740990 then return nil end
  return value
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='user_not_found'}) end
if redis.call('GET',KEYS[1])~=ARGV[2] then return encode({ok=false,error='account_state_changed'}) end
local versionType=keytype(KEYS[2])
local current=1
if versionType=='string' then
  current=validversion(redis.call('GET',KEYS[2]))
end
if not current then current=1 end
if versionType~='string' or not validversion(redis.call('GET',KEYS[2])) then
  if versionType~='none' then redis.call('DEL',KEYS[2]) end
  redis.call('SET',KEYS[2],'1')
end
local target=ARGV[1]=='1'
if ARGV[4]~='1' then
  return encode({ok=true,changed=false,authVersion=current,banned=target})
end
if ARGV[3]=='' then return encode({ok=false,error='invalid_ban_update'}) end
local nextVersion=current+1
redis.call('SET',KEYS[1],ARGV[3])
redis.call('SET',KEYS[2],tostring(nextVersion))
return encode({ok=true,changed=true,authVersion=nextVersion,banned=target})`;

export async function setUserBanStateAndRevokeSessions(emailValue, banned, actor = null, now = new Date()) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) return { ok: false, error: "invalid_email" };
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return { ok: false, error: "invalid_ban_update" };
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, error: keyspaceError };
  const staffId = positiveInteger(actor?.staffId) || 1;
  const keys = [userRecordKey(email), authVersionKey(email)];
  const target = Boolean(banned);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prepared = await redisEvalAtomic(READ_BAN_PROFILE_SCRIPT, [keys[0]], []);
    if (!prepared.ok) return prepared;
    if (!prepared.value?.ok) return prepared.value || { ok: false, error: "invalid_storage_response" };
    const raw = String(prepared.value.userRaw || "");
    const user = parseUserRecord(raw);
    if (!user) return { ok: false, error: "account_record_invalid" };
    const changed = (user.banned === true) !== target;
    const nextRaw = changed
      ? patchTopLevelJsonFields(raw, {
          banned: target,
          bannedAt: target ? date.toISOString() : null,
          bannedByStaffId: target ? staffId : null,
          unbannedByStaffId: target ? null : staffId,
        })
      : raw;
    if (!nextRaw) return { ok: false, error: "account_record_invalid" };
    const committed = await redisEvalAtomic(
      SET_BAN_STATE_AND_REVOKE_SCRIPT,
      keys,
      [target ? "1" : "0", raw, nextRaw, changed ? "1" : "0"],
    );
    if (!committed.ok) return committed;
    if (committed.value?.error === "account_state_changed") continue;
    return committed.value?.ok ? { ...committed.value, email } : committed.value;
  }
  return { ok: false, error: "account_state_changed" };
}

export async function revokeUserSessions(emailValue) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) return { ok: false, error: "invalid_email" };
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, error: keyspaceError };
  // Existing accounts predate the version key and are logically version 1.
  // One Lua command guarantees their first revocation becomes version 2.
  const script = "if redis.call('EXISTS',KEYS[1])==1 then return redis.call('INCR',KEYS[1]) else redis.call('SET',KEYS[1],'2') return 2 end";
  const version = positiveInteger(await redisCmd(["EVAL", script, "1", authVersionKey(email)]));
  return version
    ? { ok: true, email, authVersion: version }
    : { ok: false, error: "auth_store_unavailable" };
}

const READ_USER_AUTH_STATE_SCRIPT = `
-- READ_USER_AUTH_STATE_V3
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
local function validversion(raw)
  if not raw or not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<1 or value~=math.floor(value) or value>9007199254740990 then return nil end
  return value
end
local function validbalance(raw)
  if not raw or not string.match(raw,'^-?%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value~=math.floor(value) or value < -9007199254740991 or value > 9007199254740991 then return nil end
  return value
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='session_revoked'}) end
local versionType=keytype(KEYS[2]); local balanceType=keytype(KEYS[3]); local lifecycleType=keytype(KEYS[4])
local userRaw=redis.call('GET',KEYS[1])
local current=1
if versionType=='string' then
  current=validversion(redis.call('GET',KEYS[2]))
end
local authVersionRepaired=false
if not current then current=1 end
if versionType~='string' or not validversion(redis.call('GET',KEYS[2])) then
  if versionType~='none' then redis.call('DEL',KEYS[2]) end
  redis.call('SET',KEYS[2],'1')
  authVersionRepaired=true
end
local balanceRaw=nil
local balanceRepaired=false
if balanceType=='string' then
  local candidate=redis.call('GET',KEYS[3])
  if validbalance(candidate) then
    balanceRaw=candidate
  else
    redis.call('DEL',KEYS[3])
    balanceRepaired=true
  end
elseif balanceType~='none' then
  redis.call('DEL',KEYS[3])
  balanceRepaired=true
end
local lifecycle=nil
local lifecycleRepaired=false
if lifecycleType=='string' then lifecycle=redis.call('GET',KEYS[4]) end
if lifecycle and (#lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]')) then
  redis.call('DEL',KEYS[4])
  lifecycle=nil
  lifecycleRepaired=true
elseif lifecycleType~='none' and lifecycleType~='string' then
  redis.call('DEL',KEYS[4])
  lifecycleRepaired=true
end
if not lifecycle then
  lifecycle=ARGV[1]
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then return encode({ok=false,error='invalid_lifecycle_candidate'}) end
  redis.call('SET',KEYS[4],lifecycle)
  lifecycleRepaired=true
end
return encode({ok=true,userRaw=userRaw,authVersion=current,accountLifecycleId=lifecycle,balanceCents=balanceRaw,
  repairedAuthVersion=authVersionRepaired,repairedBalance=balanceRepaired,repairedLifecycle=lifecycleRepaired})`;

const FORCE_REPAIR_USER_AUTH_STATE_SCRIPT = `
-- FORCE_REPAIR_USER_AUTH_STATE_V1
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
local function encode(value)
  local ok,result=pcall(cjson.encode,value)
  if ok then return result end
  return '{"ok":false,"error":"response_encode_failed"}'
end
local function validversion(raw)
  if not raw or not string.match(raw,'^%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value<1 or value~=math.floor(value) or value>9007199254740990 then return nil end
  return value
end
local function validbalance(raw)
  if not raw or not string.match(raw,'^-?%d+$') then return nil end
  local value=tonumber(raw)
  if not value or value~=math.floor(value) or value < -9007199254740991 or value > 9007199254740991 then return nil end
  return value
end
if keytype(KEYS[1])~='string' then return encode({ok=false,error='session_revoked'}) end
local versionType=keytype(KEYS[2])
local current=versionType=='string' and validversion(redis.call('GET',KEYS[2])) or nil
if not current then
  if versionType~='none' then redis.call('DEL',KEYS[2]) end
  redis.call('SET',KEYS[2],'1')
  current=1
end
local balanceType=keytype(KEYS[3])
local balanceRaw=nil
if balanceType=='string' then
  local candidate=redis.call('GET',KEYS[3])
  if validbalance(candidate) then balanceRaw=candidate else redis.call('DEL',KEYS[3]) end
elseif balanceType~='none' then
  redis.call('DEL',KEYS[3])
end
local lifecycleType=keytype(KEYS[4])
local lifecycle=lifecycleType=='string' and redis.call('GET',KEYS[4]) or nil
if not lifecycle or #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then
  if lifecycleType~='none' then redis.call('DEL',KEYS[4]) end
  lifecycle=ARGV[1]
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then return encode({ok=false,error='invalid_lifecycle_candidate'}) end
  redis.call('SET',KEYS[4],lifecycle)
end
return encode({ok=true,userRaw=redis.call('GET',KEYS[1]),authVersion=current,
  accountLifecycleId=lifecycle,balanceCents=balanceRaw})`;

function normalizedUserAuthState(state) {
  const user = parseUserRecord(state?.userRaw);
  if (!user) return { ok: false, error: "account_record_invalid" };

  let balanceValid = true;
  if (state.balanceCents != null) {
    const rawBalance = String(state.balanceCents);
    const cents = /^-?\d+$/.test(rawBalance) ? Number(rawBalance) : Number.NaN;
    if (Number.isSafeInteger(cents)) user.balance = cents / 100;
    else balanceValid = false;
  }
  const authVersion = positiveInteger(state.authVersion);
  const versionValid = Boolean(authVersion && authVersion <= 9007199254740990);
  const accountLifecycleId = String(state.accountLifecycleId || "");
  const lifecycleValid = validAccountLifecycleId(accountLifecycleId);
  if (!balanceValid || !versionValid || !lifecycleValid) {
    return {
      ok: false,
      error: "auth_state_invalid",
      invalid: {
        balance: !balanceValid,
        authVersion: !versionValid,
        lifecycle: !lifecycleValid,
      },
    };
  }
  return { ok: true, user, authVersion, accountLifecycleId };
}

function userAuthStorageFailure(result) {
  const error = result?.error || "auth_store_unavailable";
  return {
    ok: false,
    status: error === "storage_unavailable" || error === "auth_store_unavailable" ? 503 : 500,
    error,
  };
}

export async function readUserAuthState(email) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) return { ok: false, status: 401, error: "session_revoked" };
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) {
    return {
      ok: false,
      status: keyspaceError === "redis_cluster_keyspace_not_supported" ? 503 : 500,
      error: keyspaceError,
    };
  }
  const keys = [
    userRecordKey(normalized),
    authVersionKey(normalized),
    balanceCentsKey(normalized),
    accountLifecycleKey(normalized),
  ];
  const read = () => redisEvalAtomic(READ_USER_AUTH_STATE_SCRIPT, keys, [newAccountLifecycleId()]);
  const stateError = (state) => state?.error === "session_revoked"
    ? { ok: false, status: 401, error: "session_revoked" }
    : { ok: false, status: 409, error: state?.error || "auth_state_invalid" };

  let result = await read();
  if (!result.ok) return userAuthStorageFailure(result);
  if (!result.value?.ok) return stateError(result.value);
  let normalizedState = normalizedUserAuthState(result.value);
  if (normalizedState.ok) return normalizedState;
  if (normalizedState.error === "account_record_invalid") {
    return { ok: false, status: 409, error: normalizedState.error };
  }

  // A rolling deployment, proxy cache, or defensive test double can still
  // surface an old/malformed payload even though V3 repairs the keys in Lua.
  // Re-read once, then perform one explicit canonical repair so a historical
  // representation can never strand an otherwise valid profile in a 5xx.
  result = await read();
  if (!result.ok) return userAuthStorageFailure(result);
  if (!result.value?.ok) return stateError(result.value);
  normalizedState = normalizedUserAuthState(result.value);
  if (normalizedState.ok) return normalizedState;
  if (normalizedState.error === "account_record_invalid") {
    return { ok: false, status: 409, error: normalizedState.error };
  }

  const repaired = await redisEvalAtomic(
    FORCE_REPAIR_USER_AUTH_STATE_SCRIPT,
    keys,
    [newAccountLifecycleId()],
  );
  if (!repaired.ok) return userAuthStorageFailure(repaired);
  if (!repaired.value?.ok) return stateError(repaired.value);
  const repairedState = normalizedUserAuthState(repaired.value);
  return repairedState.ok
    ? repairedState
    : { ok: false, status: 409, error: repairedState.error || "auth_state_invalid" };
}

export async function authenticateUserRequest(request, options = {}) {
  const now = finiteTimestamp(options.now) || Date.now();
  const token = getCookieFromRequest(request, "lm_user");
  if (!token) return { ok: false, status: 401, error: "not_logged_in" };

  const typed = verifyUserSessionCapability(token, now);
  const legacy = typed ? null : verifyLegacyUserSession(token, now);
  const claim = typed || legacy;
  if (!claim) return { ok: false, status: 401, error: "invalid_session" };

  const email = normalizeEmail(claim.email || claim.sub);
  const state = await readUserAuthState(email);
  if (!state.ok) return state;
  if (state.user.banned) return { ok: false, status: 403, error: "account_banned" };

  if (typed) {
    if (positiveInteger(typed.sv) !== state.authVersion) {
      return { ok: false, status: 401, error: "session_revoked" };
    }
  } else {
    if (state.authVersion !== 1) {
      return { ok: false, status: 401, error: "session_revoked" };
    }
    const deadline = await ensureLegacyUserDeadline(now);
    if (!deadline) return { ok: false, status: 503, error: "auth_store_unavailable" };
    if (now >= deadline) return { ok: false, status: 401, error: "legacy_session_expired" };
  }

  return {
    ok: true,
    email,
    user: state.user,
    authVersion: state.authVersion,
    accountLifecycleId: state.accountLifecycleId,
    claims: claim,
    legacy: Boolean(legacy),
  };
}

export function refreshedUserSessionToken(auth, now = Date.now()) {
  if (!auth?.ok) return "";
  return signUserSessionForVersion(auth.email, auth.authVersion, now);
}

export function userAuthErrorResponse(auth) {
  const status = Number(auth?.status) || 401;
  const error = auth?.error || "not_logged_in";
  if (error === "legacy_session_expired") {
    return Response.json({
      ok: false,
      error,
      message: "登录状态已过期，请重新登录",
    }, {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": clearCookieValue("lm_user"),
      },
    });
  }
  return Response.json({ ok: false, error }, { status });
}

/**
 * Bind a journaled, authenticated browser mutation to the account that
 * created its exact idempotency record. Cookies are shared by every tab, so a
 * later sign-in in tab B must not make tab A's unresolved money operation run
 * against B. Call this after authentication and before any operation lookup,
 * rate-limit mutation, or business side effect.
 */
export function verifyExpectedUserOperationAccount(request, authenticatedEmail, authenticatedLifecycleId = "") {
  const headers = request?.headers;
  const supplied = Boolean(headers?.has?.("x-operation-expected-account"));
  const expected = normalizeEmail(headers?.get?.("x-operation-expected-account"));
  const actual = normalizeEmail(authenticatedEmail);
  if (!supplied || !validEmail(expected)) {
    return { ok: false, status: 400, error: "operation_identity_required" };
  }
  if (!validEmail(actual) || expected !== actual) {
    return { ok: false, status: 409, error: "operation_identity_changed" };
  }
  const lifecycleSupplied = Boolean(headers?.has?.("x-operation-expected-lifecycle"));
  const expectedLifecycle = String(headers?.get?.("x-operation-expected-lifecycle") || "").trim().toLowerCase();
  const actualLifecycle = String(authenticatedLifecycleId || "").trim().toLowerCase();
  if (!lifecycleSupplied || !validAccountLifecycleId(expectedLifecycle)) {
    return { ok: false, status: 400, error: "operation_lifecycle_required" };
  }
  if (!validAccountLifecycleId(actualLifecycle) || expectedLifecycle !== actualLifecycle) {
    return { ok: false, status: 409, error: "operation_lifecycle_changed" };
  }
  return { ok: true, email: actual, accountLifecycleId: actualLifecycle };
}

export function userOperationAccountErrorResponse(result, { en = false } = {}) {
  const known = new Set([
    "operation_identity_changed",
    "operation_identity_required",
    "operation_lifecycle_changed",
    "operation_lifecycle_required",
  ]);
  const error = known.has(result?.error) ? result.error : "operation_identity_required";
  const message = error === "operation_identity_changed"
    ? (en
        ? "The signed-in account changed. Return to the original account to recover this operation."
        : "登录账户已变化,请切回原账户恢复该操作")
    : error === "operation_lifecycle_changed"
      ? (en
          ? "This operation belongs to an earlier account lifecycle and cannot be submitted from the current account."
          : "该操作属于此前的账户生命周期，不能在当前账户中提交")
    : error === "operation_lifecycle_required"
      ? (en
          ? "The saved operation lacks an account lifecycle binding. It has been preserved but cannot be submitted automatically."
          : "已保存的操作缺少账户生命周期绑定，记录已保留但不能自动提交")
    : (en
        ? "The operation account binding is missing. Refresh the page and retry the preserved request."
        : "操作缺少账户绑定,请刷新页面后重试已保留的请求");
  return Response.json({ ok: false, error, message }, { status: Number(result?.status) || 400 });
}
