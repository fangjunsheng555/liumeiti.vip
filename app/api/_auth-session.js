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
    return user && typeof user === "object" ? user : null;
  } catch (error) {
    return null;
  }
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

async function ensureLegacyUserDeadline() {
  const hasExplicitConfiguration = Boolean(
    String(process.env.LEGACY_USER_SESSION_UNTIL || "").trim()
    || String(process.env.LEGACY_USER_SESSION_DEPLOYED_AT || "").trim(),
  );
  if (hasExplicitConfiguration) {
    // Both supported settings are absolute deployment configuration. Unlike
    // the previous `now + 14 days` fallback, their value cannot be extended by
    // a user's first visit or by a cold start. LEGACY_USER_SESSION_UNTIL takes
    // precedence so operators can publish one auditable migration deadline.
    return configuredLegacyUserDeadline();
  }

  // A deployment may pre-initialize this key before serving traffic. Runtime
  // authentication only reads it: a legacy user's first request must never be
  // able to start (or restart) the migration window.
  return finiteTimestamp(await redisCmd(["GET", LEGACY_USER_DEADLINE_KEY]));
}

const READ_SESSION_ISSUANCE_STATE_SCRIPT = `
-- READ_SESSION_ISSUANCE_STATE_V2
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
if keytype(KEYS[1])~='string' then return cjson.encode({ok=false,error='user_not_found'}) end
local emailSetType=keytype(KEYS[3])
if emailSetType~='none' and emailSetType~='set' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local lifecycleType=keytype(KEYS[4])
if lifecycleType~='none' and lifecycleType~='string' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local raw=redis.call('GET',KEYS[1])
local decoded,user=pcall(cjson.decode,raw)
if not decoded or type(user)~='table' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
if user.banned==true then return cjson.encode({ok=false,error='account_banned'}) end
local versionType=keytype(KEYS[2])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local current=1
if versionType=='string' then
  local versionRaw=redis.call('GET',KEYS[2])
  if not string.match(versionRaw or '','^%d+$') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
  current=tonumber(versionRaw)
end
if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
  return cjson.encode({ok=false,error='auth_record_invalid'})
end
local expected=tonumber(ARGV[1] or '0')
if not expected or expected<0 or expected~=math.floor(expected) then
  return cjson.encode({ok=false,error='invalid_auth_version'})
end
if expected>0 and current~=expected then return cjson.encode({ok=false,error='session_state_changed'}) end
local lifecycle=redis.call('GET',KEYS[4])
if lifecycle then
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then
    return cjson.encode({ok=false,error='auth_record_invalid'})
  end
else
  lifecycle=ARGV[3]
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then
    return cjson.encode({ok=false,error='invalid_lifecycle_candidate'})
  end
  redis.call('SET',KEYS[4],lifecycle)
end
if versionType=='none' then redis.call('SET',KEYS[2],tostring(current)) end
redis.call('SADD',KEYS[3],ARGV[2])
return cjson.encode({ok=true,authVersion=current,accountLifecycleId=lifecycle})`;

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

const RESET_PASSWORD_AND_REVOKE_SCRIPT = `
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
if keytype(KEYS[3])~='string' or redis.call('GET',KEYS[3])~=ARGV[3] then
  return cjson.encode({ok=false,error='code_invalid_or_expired'})
end
if keytype(KEYS[1])~='string' then return cjson.encode({ok=false,error='user_not_found'}) end
local versionType=keytype(KEYS[2])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local raw=redis.call('GET',KEYS[1])
local decoded,user=pcall(cjson.decode,raw)
if not decoded or type(user)~='table' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local current=1
if versionType=='string' then
  local versionRaw=redis.call('GET',KEYS[2])
  if not string.match(versionRaw or '','^%d+$') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
  current=tonumber(versionRaw)
end
if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
  return cjson.encode({ok=false,error='auth_record_invalid'})
end
if ARGV[1]=='' or ARGV[2]=='' then return cjson.encode({ok=false,error='invalid_password_update'}) end
user.passwordHash=ARGV[1]
user.passwordResetAt=ARGV[2]
local encoded=cjson.encode(user)
if string.find(raw,'"coupons"%s*:%s*%[%s*%]') then
  encoded=string.gsub(encoded,'"coupons":{}','"coupons":[]',1)
end
local nextVersion=current+1
redis.call('SET',KEYS[1],encoded)
redis.call('SET',KEYS[2],tostring(nextVersion))
redis.call('DEL',KEYS[3])
return cjson.encode({ok=true,authVersion=nextVersion})`;

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
  const result = await redisEvalAtomic(
    RESET_PASSWORD_AND_REVOKE_SCRIPT,
    [userRecordKey(email), authVersionKey(email), RESET_CODE_PREFIX + email],
    [hash, timestamp, code],
  );
  return result.ok ? { ...result.value, email } : result;
}

const SET_BAN_STATE_AND_REVOKE_SCRIPT = `
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
if keytype(KEYS[1])~='string' then return cjson.encode({ok=false,error='user_not_found'}) end
local versionType=keytype(KEYS[2])
if versionType~='none' and versionType~='string' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local raw=redis.call('GET',KEYS[1])
local decoded,user=pcall(cjson.decode,raw)
if not decoded or type(user)~='table' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local target=ARGV[1]=='1'
if (user.banned==true)==target then
  local unchangedVersion=versionType=='string' and tonumber(redis.call('GET',KEYS[2])) or 1
  if not unchangedVersion or unchangedVersion<1 or unchangedVersion~=math.floor(unchangedVersion) then
    return cjson.encode({ok=false,error='auth_record_invalid'})
  end
  return cjson.encode({ok=true,changed=false,authVersion=unchangedVersion,banned=target})
end
local current=1
if versionType=='string' then
  local versionRaw=redis.call('GET',KEYS[2])
  if not string.match(versionRaw or '','^%d+$') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
  current=tonumber(versionRaw)
end
if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
  return cjson.encode({ok=false,error='auth_record_invalid'})
end
user.banned=target
if target then
  user.bannedAt=ARGV[2]
  user.bannedByStaffId=tonumber(ARGV[3])
  user.unbannedByStaffId=nil
else
  user.bannedAt=cjson.null
  user.bannedByStaffId=cjson.null
  user.unbannedByStaffId=tonumber(ARGV[3])
end
local encoded=cjson.encode(user)
if string.find(raw,'"coupons"%s*:%s*%[%s*%]') then
  encoded=string.gsub(encoded,'"coupons":{}','"coupons":[]',1)
end
local nextVersion=current+1
redis.call('SET',KEYS[1],encoded)
redis.call('SET',KEYS[2],tostring(nextVersion))
return cjson.encode({ok=true,changed=true,authVersion=nextVersion,banned=target})`;

export async function setUserBanStateAndRevokeSessions(emailValue, banned, actor = null, now = new Date()) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) return { ok: false, error: "invalid_email" };
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return { ok: false, error: "invalid_ban_update" };
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, error: keyspaceError };
  const staffId = positiveInteger(actor?.staffId) || 1;
  const result = await redisEvalAtomic(
    SET_BAN_STATE_AND_REVOKE_SCRIPT,
    [userRecordKey(email), authVersionKey(email)],
    [banned ? "1" : "0", date.toISOString(), staffId],
  );
  return result.ok ? { ...result.value, email } : result;
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
-- READ_USER_AUTH_STATE_V2
local function keytype(key)
  local result=redis.call('TYPE',key)
  if type(result)=='table' then return result.ok end
  return result
end
if keytype(KEYS[1])~='string' then return cjson.encode({ok=false,error='session_revoked'}) end
local versionType=keytype(KEYS[2]); local balanceType=keytype(KEYS[3]); local lifecycleType=keytype(KEYS[4])
if (versionType~='none' and versionType~='string')
  or (balanceType~='none' and balanceType~='string')
  or (lifecycleType~='none' and lifecycleType~='string') then
  return cjson.encode({ok=false,error='auth_record_invalid'})
end
local userRaw=redis.call('GET',KEYS[1])
local decoded,user=pcall(cjson.decode,userRaw)
if not decoded or type(user)~='table' then return cjson.encode({ok=false,error='auth_record_invalid'}) end
local current=1
if versionType=='string' then
  local versionRaw=redis.call('GET',KEYS[2])
  if not string.match(versionRaw or '','^%d+$') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
  current=tonumber(versionRaw)
end
if not current or current<1 or current~=math.floor(current) or current>9007199254740990 then
  return cjson.encode({ok=false,error='auth_record_invalid'})
end
local balanceRaw=redis.call('GET',KEYS[3])
if balanceRaw then
  if not string.match(balanceRaw,'^-?%d+$') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
  local balance=tonumber(balanceRaw)
  if not balance or balance~=math.floor(balance) or balance < -9007199254740991 or balance > 9007199254740991 then
    return cjson.encode({ok=false,error='auth_record_invalid'})
  end
end
local lifecycle=redis.call('GET',KEYS[4])
if lifecycle then
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then return cjson.encode({ok=false,error='auth_record_invalid'}) end
else
  lifecycle=ARGV[1]
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then return cjson.encode({ok=false,error='invalid_lifecycle_candidate'}) end
  redis.call('SET',KEYS[4],lifecycle)
end
if versionType=='none' then redis.call('SET',KEYS[2],tostring(current)) end
return cjson.encode({ok=true,userRaw=userRaw,authVersion=current,accountLifecycleId=lifecycle,balanceCents=balanceRaw})`;

export async function readUserAuthState(email) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) return { ok: false, status: 401, error: "session_revoked" };
  const keyspaceError = unsupportedAtomicKeyspaceError();
  if (keyspaceError) return { ok: false, status: 503, error: keyspaceError };
  const result = await redisEvalAtomic(
    READ_USER_AUTH_STATE_SCRIPT,
    [userRecordKey(normalized), authVersionKey(normalized), balanceCentsKey(normalized), accountLifecycleKey(normalized)],
    [newAccountLifecycleId()],
  );
  if (!result.ok) return { ok: false, status: 503, error: result.error || "auth_store_unavailable" };
  const state = result.value;
  if (!state?.ok) {
    return state?.error === "session_revoked"
      ? { ok: false, status: 401, error: "session_revoked" }
      : { ok: false, status: 503, error: state?.error || "auth_record_invalid" };
  }
  const user = parseUserRecord(state.userRaw);
  if (!user) return { ok: false, status: 503, error: "auth_record_invalid" };
  if (state.balanceCents != null) {
    const rawBalance = String(state.balanceCents);
    if (!/^-?\d+$/.test(rawBalance)) return { ok: false, status: 503, error: "auth_record_invalid" };
    const cents = Number(rawBalance);
    if (!Number.isSafeInteger(cents)) return { ok: false, status: 503, error: "auth_record_invalid" };
    user.balance = cents / 100;
  }
  const authVersion = positiveInteger(state.authVersion);
  if (!authVersion || authVersion > 9007199254740990) {
    return { ok: false, status: 503, error: "auth_record_invalid" };
  }
  const accountLifecycleId = String(state.accountLifecycleId || "");
  if (!validAccountLifecycleId(accountLifecycleId)) {
    return { ok: false, status: 503, error: "auth_record_invalid" };
  }
  return { ok: true, user, authVersion, accountLifecycleId };
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
    const deadline = await ensureLegacyUserDeadline();
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
