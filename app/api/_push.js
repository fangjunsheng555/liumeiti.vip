import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import webpush from "web-push";

import { clean, redisCmd, validEmail } from "./_utils.js";
import { readUserAuthState, validAccountLifecycleId } from "./_auth-session.js";
import { appendBusinessTraceEvent } from "./_observability.js";

const SUBSCRIPTIONS_HASH = "lm:push:subscriptions:v1";
const ACCOUNT_SUBSCRIPTIONS_HASH = "lm:push:account-subscriptions:v1";
const PREFERENCES_HASH = "lm:push:preferences:v1";
const EVENTS_HASH = "lm:push:events:v1";
const OUTBOX_KEY = "lm:push:outbox:v1";
const DELIVERIES_HASH = "lm:push:deliveries:v1";
const ENQUEUE_RECOVERY_HASH = "lm:push:enqueue-recovery:v1";
const ENQUEUE_RECOVERY_INDEX = "lm:push:enqueue-recovery-index:v1";
const STOCK_WATCHES_HASH = "lm:push:stock-watches:v1";
const ACCOUNT_WATCHES_HASH = "lm:push:account-watches:v1";
const DISPATCH_LOCK_KEY = "lm:push:dispatch-lock:v1";
const SUBSCRIPTION_CLEANUP_CURSOR_KEY = "lm:push:cleanup-cursor:v1";
const PROVIDER_ALERTS_HASH = "lm:push:provider-alerts:v1";
const PROVIDER_ALERTS_INDEX = "lm:push:provider-alerts-index:v1";
const DELIVERY_TRACE_MARKER_PREFIX = "lm:push:delivery-trace:v1:";

const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 12;
const MAX_WATCHES_PER_ACCOUNT = 80;
const SUBSCRIPTION_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_EVENT_ATTEMPTS = 12;
const WEB_PUSH_TIMEOUT_MS = 10_000;
const DISPATCH_LOCK_TTL_SECONDS = 55;
const DEFAULT_DISPATCH_BUDGET_MS = 40_000;
const DELIVERY_TRACE_TTL_SECONDS = 180 * 24 * 60 * 60;
const PROVIDER_ALERT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const BUILTIN_PUSH_ENDPOINT_HOSTS = Object.freeze([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  ".notify.windows.com",
]);

const REFRESH_DISPATCH_LOCK_SCRIPT = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
return redis.call('EXPIRE',KEYS[1],ARGV[2])`;

const DEFAULT_PREFERENCES = Object.freeze({
  enabled: true,
  orders: true,
  afterSales: true,
  renewals: true,
  stock: true,
  locale: "zh",
});

const BIND_SUBSCRIPTION_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local function decode(value)
  if not value then return {} end
  local ok, parsed=pcall(cjson.decode,value)
  if not ok or type(parsed)~='table' then return nil end
  return parsed
end
local function remove(list, value)
  local out={}
  for _,item in ipairs(list) do if tostring(item)~=value then table.insert(out,item) end end
  return out
end
local function contains(list, value)
  for _,item in ipairs(list) do if tostring(item)==value then return true end end
  return false
end
local priorRaw=redis.call('HGET',KEYS[1],ARGV[1])
local prior=decode(priorRaw)
if not prior or (priorRaw and (tostring(prior.subscriptionId or '')~=ARGV[1] or tostring(prior.accountTarget or '')=='')) then return 'corrupt' end
local oldTarget=tostring(prior.accountTarget or '')
local newTarget=ARGV[2]
local newList=decode(redis.call('HGET',KEYS[2],newTarget))
if not newList or not islist(newList) then return 'corrupt' end
if not contains(newList,ARGV[1]) and #newList>=tonumber(ARGV[4]) then return 'limit' end
if oldTarget~='' and oldTarget~=newTarget then
  local oldList=decode(redis.call('HGET',KEYS[2],oldTarget))
  if not oldList or not islist(oldList) then return 'corrupt' end
  oldList=remove(oldList,ARGV[1])
  if #oldList==0 then redis.call('HDEL',KEYS[2],oldTarget)
  else redis.call('HSET',KEYS[2],oldTarget,cjson.encode(oldList)) end
end
if not contains(newList,ARGV[1]) then table.insert(newList,ARGV[1]) end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3])
redis.call('HSET',KEYS[2],newTarget,cjson.encode(newList))
redis.call('HSET',KEYS[3],newTarget,ARGV[5])
return priorRaw and 'updated' or 'created'`;

const REMOVE_SUBSCRIPTION_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local function decode(value)
  if not value then return {} end
  local ok, parsed=pcall(cjson.decode,value)
  if not ok or type(parsed)~='table' then return nil end
  return parsed
end
local function remove(list, value)
  local out={}
  for _,item in ipairs(list) do if tostring(item)~=value then table.insert(out,item) end end
  return out
end
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw then
  if ARGV[2]=='' then return 0 end
  local missingList=decode(redis.call('HGET',KEYS[2],ARGV[2]))
  if not missingList or not islist(missingList) then return -2 end
  missingList=remove(missingList,ARGV[1])
  if #missingList==0 then redis.call('HDEL',KEYS[2],ARGV[2])
  else redis.call('HSET',KEYS[2],ARGV[2],cjson.encode(missingList)) end
  return 0
end
local record=decode(raw)
if not record or tostring(record.subscriptionId or '')~=ARGV[1] or tostring(record.accountTarget or '')=='' then return -2 end
local target=tostring(record.accountTarget or '')
if ARGV[2]~='' and target~=ARGV[2] then return -1 end
local list=nil
if target~='' then
  list=decode(redis.call('HGET',KEYS[2],target))
  if not list or not islist(list) then return -2 end
  list=remove(list,ARGV[1])
end
redis.call('HDEL',KEYS[1],ARGV[1])
if target~='' then
  if #list==0 then redis.call('HDEL',KEYS[2],target)
  else redis.call('HSET',KEYS[2],target,cjson.encode(list)) end
end
return 1`;

const REMOVE_ALL_SUBSCRIPTIONS_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local raw=redis.call('HGET',KEYS[2],ARGV[1])
if not raw then return 0 end
local ok,list=pcall(cjson.decode,raw)
if not ok or not islist(list) then return -2 end
for _,id in ipairs(list) do
  local recordRaw=redis.call('HGET',KEYS[1],tostring(id))
  if recordRaw then
    local recordOk,record=pcall(cjson.decode,recordRaw)
    if not recordOk or type(record)~='table' or tostring(record.subscriptionId or '')~=tostring(id) or tostring(record.accountTarget or '')~=ARGV[1] then return -2 end
  end
end
for _,id in ipairs(list) do redis.call('HDEL',KEYS[1],tostring(id)) end
redis.call('HDEL',KEYS[2],ARGV[1])
return #list`;

const ENQUEUE_EVENT_SCRIPT = `
local prior=redis.call('HGET',KEYS[1],ARGV[1])
if prior then
  local ok,decoded=pcall(cjson.decode,prior)
  if not ok or type(decoded)~='table' then return 'corrupt' end
  if tostring(decoded.requestHash or '')~='' and tostring(decoded.requestHash)~=ARGV[2] then return 'conflict' end
  redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1])
  return 'exists'
end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3])
redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1])
return 'queued'`;

const SAVE_ENQUEUE_RECOVERY_SCRIPT = `
local prior=redis.call('HGET',KEYS[1],ARGV[1])
if prior then
  local ok,decoded=pcall(cjson.decode,prior)
  if not ok or type(decoded)~='table' then return 'corrupt' end
  if tostring(decoded.requestHash or '')~=ARGV[2] then return 'conflict' end
end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3])
redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1])
return prior and 'updated' or 'saved'`;

const REMOVE_ENQUEUE_RECOVERY_SCRIPT = `
redis.call('HDEL',KEYS[1],ARGV[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return 1`;

const STOCK_WATCH_ADD_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local function decode(value)
  if not value then return {} end
  local ok,parsed=pcall(cjson.decode,value)
  if not ok or type(parsed)~='table' then return nil end
  return parsed
end
local function contains(list,value)
  for _,item in ipairs(list) do if tostring(item)==value then return true end end
  return false
end
local stock=redis.call('GET',KEYS[1])
if not stock then return 'available' end
local count=tonumber(stock)
if not count or count<0 or count~=math.floor(count) then return 'invalid_stock' end
if count>0 then return 'available' end
local targets=decode(redis.call('HGET',KEYS[2],ARGV[1]))
local products=decode(redis.call('HGET',KEYS[3],ARGV[2]))
if not targets or not products or not islist(targets) or not islist(products) then return 'corrupt' end
if not contains(products,ARGV[1]) and #products>=tonumber(ARGV[3]) then return 'limit' end
if not contains(targets,ARGV[2]) then table.insert(targets,ARGV[2]) end
if not contains(products,ARGV[1]) then table.insert(products,ARGV[1]) end
redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(targets))
redis.call('HSET',KEYS[3],ARGV[2],cjson.encode(products))
return 'watching'`;

const STOCK_WATCH_REMOVE_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local function decode(value)
  if not value then return {} end
  local ok,parsed=pcall(cjson.decode,value)
  if not ok or type(parsed)~='table' then return nil end
  return parsed
end
local function remove(list,value)
  local out={}
  for _,item in ipairs(list) do if tostring(item)~=value then table.insert(out,item) end end
  return out
end
local targets=decode(redis.call('HGET',KEYS[1],ARGV[1]))
local products=decode(redis.call('HGET',KEYS[2],ARGV[2]))
if not targets or not products or not islist(targets) or not islist(products) then return 'corrupt' end
targets=remove(targets,ARGV[2])
products=remove(products,ARGV[1])
if #targets==0 then redis.call('HDEL',KEYS[1],ARGV[1]) else redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(targets)) end
if #products==0 then redis.call('HDEL',KEYS[2],ARGV[2]) else redis.call('HSET',KEYS[2],ARGV[2],cjson.encode(products)) end
return 1`;

const SET_STOCK_AND_ENQUEUE_SCRIPT = `
local priorEvent=nil
if ARGV[2]~='' then
  priorEvent=redis.call('HGET',KEYS[2],ARGV[2])
  if priorEvent then
    local eventOk,event=pcall(cjson.decode,priorEvent)
    if not eventOk or type(event)~='table' then return 'push_event_corrupt' end
    if tostring(event.requestHash or '')~=ARGV[3] then return 'push_event_conflict' end
  end
end
local raw=redis.call('GET',KEYS[1])
local before=nil
if raw then
  before=tonumber(raw)
  if not before or before<0 or before~=math.floor(before) then return 'invalid_stock' end
end
local after=nil
if ARGV[1]=='unlimited' then redis.call('DEL',KEYS[1])
else
  after=tonumber(ARGV[1])
  if not after or after<0 or after~=math.floor(after) then return 'invalid_value' end
  redis.call('SET',KEYS[1],tostring(after))
end
local restocked=(before~=nil and before==0 and (after==nil or after>0))
local queued=false
if restocked and ARGV[2]~='' then
  if not priorEvent then
    redis.call('HSET',KEYS[2],ARGV[2],ARGV[4])
    queued=true
  end
  redis.call('ZADD',KEYS[3],ARGV[5],ARGV[2])
end
return cjson.encode({ok=true,before=before or -1,after=after or -1,restocked=restocked,queued=queued})`;

const SAVE_SUCCESSFUL_DELIVERY_SCRIPT = `
redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
redis.call('HSET',KEYS[2],ARGV[3],ARGV[4])
return 1`;

const RESCHEDULE_EVENT_SCRIPT = `
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw then return 'missing' end
local ok,current=pcall(cjson.decode,raw)
if not ok or type(current)~='table' then return 'corrupt' end
if tostring(current.requestHash or '')~=ARGV[2] then return 'conflict' end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3])
redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1])
return 'rescheduled'`;

const PERSIST_DELIVERY_FIELDS_SCRIPT = `
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw then return 'missing' end
local ok,current=pcall(cjson.decode,raw)
if not ok or type(current)~='table' then return 'corrupt' end
if tostring(current.requestHash or '')~=ARGV[2] then return 'conflict' end
local seen={}
local merged={}
if type(current.deliveryFields)=='table' then
  for _,field in ipairs(current.deliveryFields) do
    local value=tostring(field)
    if value~='' and not seen[value] then seen[value]=true table.insert(merged,value) end
  end
end
local incomingOk,incoming=pcall(cjson.decode,ARGV[3])
if not incomingOk or type(incoming)~='table' then return 'invalid_fields' end
for _,field in ipairs(incoming) do
  local value=tostring(field)
  if value~='' and not seen[value] then seen[value]=true table.insert(merged,value) end
end
current.deliveryFields=merged
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(current))
return 'saved'`;

const FINALIZE_EVENT_SCRIPT = `
local function islist(value)
  if type(value)~='table' then return false end
  local length=#value
  local count=0
  for key,_ in pairs(value) do
    if type(key)~='number' or key<1 or key~=math.floor(key) or key>length then return false end
    count=count+1
  end
  return count==length
end
local function decode(value)
  if not value then return {} end
  local ok,parsed=pcall(cjson.decode,value)
  if not ok or type(parsed)~='table' then return nil end
  return parsed
end
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if raw then
  local ok,current=pcall(cjson.decode,raw)
  if not ok or type(current)~='table' then return 'corrupt' end
  if tostring(current.requestHash or '')~=ARGV[2] then return 'conflict' end
end
local deliveryCount=tonumber(ARGV[4]) or 0
local productKey=''
local stockTargets={}
local accountProducts={}
if ARGV[3]=='1' and ARGV[5+deliveryCount]~='' then
  productKey=ARGV[5+deliveryCount]
  stockTargets=decode(redis.call('HGET',KEYS[4],productKey))
  if not stockTargets or not islist(stockTargets) then return 'corrupt' end
  for _,target in ipairs(stockTargets) do
    local targetText=tostring(target)
    local products=decode(redis.call('HGET',KEYS[5],targetText))
    if not products or not islist(products) then return 'corrupt' end
    accountProducts[targetText]=products
  end
end
redis.call('HDEL',KEYS[1],ARGV[1])
redis.call('ZREM',KEYS[2],ARGV[1])
for index=1,deliveryCount do redis.call('HDEL',KEYS[3],ARGV[4+index]) end
if productKey~='' then
  for _,target in ipairs(stockTargets) do
    local products=accountProducts[tostring(target)]
    local kept={}
    for _,product in ipairs(products) do
      if tostring(product)~=productKey then table.insert(kept,product) end
    end
    if #kept==0 then redis.call('HDEL',KEYS[5],tostring(target))
    else redis.call('HSET',KEYS[5],tostring(target),cjson.encode(kept)) end
  end
  redis.call('HDEL',KEYS[4],productKey)
end
return 'finalized'`;

const SAVE_PROVIDER_ALERT_SCRIPT = `
redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1])
return 1`;

const CLEANUP_PROVIDER_ALERTS_SCRIPT = `
local ids=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,ARGV[2])
for _,id in ipairs(ids) do
  redis.call('HDEL',KEYS[1],id)
  redis.call('ZREM',KEYS[2],id)
end
return #ids`;

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function readHashField(key, field) {
  const result = await redisCmd(["HMGET", key, field]);
  if (!Array.isArray(result) || result.length !== 1) {
    return { ok: false, error: "storage_unavailable", exists: false, value: null };
  }
  return { ok: true, exists: result[0] != null, value: result[0] ?? null };
}

async function readStringField(key) {
  const result = await redisCmd(["MGET", key]);
  if (!Array.isArray(result) || result.length !== 1) {
    return { ok: false, error: "storage_unavailable", exists: false, value: null };
  }
  return { ok: true, exists: result[0] != null, value: result[0] ?? null };
}

function parsedListField(field, limit) {
  if (!field?.ok) return { ok: false, error: "storage_unavailable", values: [] };
  if (!field.exists) return { ok: true, values: [] };
  const parsed = parseJson(field.value, null);
  if (!Array.isArray(parsed)) return { ok: false, error: "storage_unavailable", values: [] };
  if (parsed.length > limit || parsed.some((value) => typeof value !== "string" || !value || clean(value, 160) !== value)) {
    return { ok: false, error: "storage_unavailable", values: [] };
  }
  const values = uniqueStrings(parsed, limit);
  return values.length === parsed.length
    ? { ok: true, values }
    : { ok: false, error: "storage_unavailable", values: [] };
}

function redisNumber(value) {
  if (value == null || typeof value === "object" || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueStrings(value, limit = 100) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 160)).filter(Boolean))].slice(0, limit);
}

function sha(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function secretValue(name) {
  return String(process.env[name] || "").trim();
}

function encryptionKey() {
  const secret = secretValue("PUSH_SUBSCRIPTION_ENCRYPTION_KEY");
  return secret.length >= 32 ? createHash("sha256").update(secret).digest() : null;
}

function accountHmacSecret() {
  const secret = secretValue("PUSH_ACCOUNT_HMAC_SECRET");
  return secret.length >= 32 ? secret : "";
}

function validVapidKeyPair(publicKey, privateKey) {
  if (!validBase64Url(publicKey, 65) || !validBase64Url(privateKey, 32)) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey, "base64url"));
  } catch { return false; }
}

function encrypted(value) {
  const key = encryptionKey();
  if (!key) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypted(value) {
  const key = encryptionKey();
  const parts = String(value || "").split(".");
  if (!key || parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch { return null; }
}

function normalizedEmail(value) {
  return clean(value, 254).toLowerCase().trim();
}

export function pushServerConfiguration() {
  const publicKey = secretValue("WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = secretValue("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = secretValue("WEB_PUSH_VAPID_SUBJECT") || "mailto:info@liumeiti.vip";
  const enabled = /^(1|true|yes|on)$/i.test(secretValue("PUSH_ENABLED"));
  const validSubject = /^mailto:[^\s@]+@[^\s@]+$/i.test(subject) || (() => {
    try { return new URL(subject).protocol === "https:"; } catch { return false; }
  })();
  return {
    enabled,
    configured: Boolean(
      enabled
      && validVapidKeyPair(publicKey, privateKey)
      && validSubject
      && encryptionKey()
      && accountHmacSecret()
    ),
    publicKey,
    subject,
  };
}

export function pushAccountTarget(emailValue, lifecycleValue) {
  const email = normalizedEmail(emailValue);
  const lifecycle = clean(lifecycleValue, 80).toLowerCase();
  const secret = accountHmacSecret();
  if (!secret || !validEmail(email) || !validAccountLifecycleId(lifecycle)) return "";
  return createHmac("sha256", secret).update(`${email}\0${lifecycle}`).digest("hex");
}

export function normalizePushPreferences(value, fallback = DEFAULT_PREFERENCES) {
  const source = value && typeof value === "object" ? value : {};
  const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_PREFERENCES;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : base.enabled !== false,
    orders: typeof source.orders === "boolean" ? source.orders : base.orders !== false,
    afterSales: typeof source.afterSales === "boolean" ? source.afterSales : base.afterSales !== false,
    renewals: typeof source.renewals === "boolean" ? source.renewals : base.renewals !== false,
    stock: typeof source.stock === "boolean" ? source.stock : base.stock !== false,
    locale: source.locale === "en" ? "en" : (base.locale === "en" ? "en" : "zh"),
  };
}

function validBase64Url(value, exactBytes) {
  const input = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length > 300) return false;
  try { return Buffer.from(input, "base64url").length === exactBytes; } catch { return false; }
}

function allowedPushEndpoint(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (
    url.protocol !== "https:"
    || (url.port && url.port !== "443")
    || url.username
    || url.password
    || url.hash
    || url.href.length > 2400
  ) return null;
  const configured = secretValue("WEB_PUSH_ALLOWED_HOSTS").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  // Custom hosts extend the browser-provider allowlist. Replacing the built-in
  // entries would silently disable Chrome, Firefox, Safari or Windows Push as
  // soon as an operator added one private gateway.
  const allowed = [...new Set([...BUILTIN_PUSH_ENDPOINT_HOSTS, ...configured])];
  const host = url.hostname.toLowerCase();
  const accepted = allowed.some((item) => item.startsWith(".") ? host.endsWith(item) : host === item);
  return accepted ? url.toString() : null;
}

export function normalizePushSubscription(input) {
  const source = input && typeof input === "object" ? input : {};
  const endpoint = allowedPushEndpoint(source.endpoint);
  const p256dh = source.keys?.p256dh;
  const auth = source.keys?.auth;
  if (!endpoint || !validBase64Url(p256dh, 65) || !validBase64Url(auth, 16)) return null;
  const expirationTime = source.expirationTime == null ? null : Number(source.expirationTime);
  if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime <= Date.now())) return null;
  return { endpoint, expirationTime, keys: { p256dh: String(p256dh), auth: String(auth) } };
}

export function pushSubscriptionId(endpoint) {
  const value = String(endpoint || "");
  return value ? sha(value) : "";
}

async function readPreferences(target) {
  const field = await readHashField(PREFERENCES_HASH, target);
  if (!field.ok) return { ok: false, error: "storage_unavailable", preferences: null };
  if (!field.exists) return { ok: true, exists: false, preferences: normalizePushPreferences(DEFAULT_PREFERENCES) };
  const value = parseJson(field.value, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "storage_unavailable", preferences: null };
  }
  return { ok: true, exists: true, preferences: normalizePushPreferences(value) };
}

async function writePreferences(target, preferences) {
  return redisNumber(await redisCmd(["HSET", PREFERENCES_HASH, target, JSON.stringify(preferences)])) != null;
}

export async function getPushAccountState(auth) {
  const config = pushServerConfiguration();
  const target = pushAccountTarget(auth?.email, auth?.accountLifecycleId);
  if (!target) return { ok: false, error: "push_identity_unavailable" };
  const [idsField, preferenceState, watchesField] = await Promise.all([
    readHashField(ACCOUNT_SUBSCRIPTIONS_HASH, target),
    readPreferences(target),
    readHashField(ACCOUNT_WATCHES_HASH, target),
  ]);
  const idsState = parsedListField(idsField, MAX_SUBSCRIPTIONS_PER_ACCOUNT);
  const watchesState = parsedListField(watchesField, MAX_WATCHES_PER_ACCOUNT);
  if (!idsState.ok || !preferenceState.ok || !watchesState.ok) {
    return { ok: false, status: 503, error: "storage_unavailable" };
  }
  const subscriptionIds = idsState.values;
  const lifecycle = clean(auth?.accountLifecycleId, 80).toLowerCase();
  const authVersion = Number(auth?.authVersion || 0);
  const records = await Promise.all(subscriptionIds.map((id) => readSubscriptionRecord(id)));
  if (records.some((state) => !state.ok)) {
    return { ok: false, status: 503, error: "storage_unavailable" };
  }
  if (records.some((state) => (
    !state.record
    || state.record.accountTarget !== target
    || pushAccountTarget(auth?.email, state.record.accountLifecycleId) !== target
  ))) {
    return { ok: false, status: 503, error: "storage_unavailable" };
  }
  const validSubscriptionIds = subscriptionIds.filter((id, index) => {
    const record = records[index].record;
    return record
      && record.subscriptionId === id
      && record.accountTarget === target
      && record.accountLifecycleId === lifecycle
      && Number(record.authVersion) === authVersion
      && record.vapidKeyId === sha(config.publicKey).slice(0, 16);
  });
  return {
    ok: true,
    enabled: config.enabled,
    configured: config.configured,
    publicKey: config.publicKey,
    preferences: preferenceState.preferences,
    subscriptionIds,
    validSubscriptionIds,
    stockWatches: watchesState.values,
  };
}

export async function bindPushSubscription(auth, input, options = {}) {
  const config = pushServerConfiguration();
  if (!config.enabled) return { ok: false, error: "push_disabled" };
  if (!config.configured) return { ok: false, error: "push_not_configured" };
  const subscription = normalizePushSubscription(input);
  if (!subscription) return { ok: false, error: "invalid_subscription" };
  const email = normalizedEmail(auth?.email);
  const lifecycle = clean(auth?.accountLifecycleId, 80).toLowerCase();
  const authVersion = Number(auth?.authVersion || 0);
  const target = pushAccountTarget(email, lifecycle);
  if (!target || !Number.isSafeInteger(authVersion) || authVersion <= 0) return { ok: false, error: "push_identity_unavailable" };
  const preferenceState = await readPreferences(target);
  if (!preferenceState.ok) return { ok: false, error: "storage_unavailable" };
  const currentPreferences = preferenceState.preferences;
  const locale = options.locale === "en" ? "en" : options.locale === "zh" ? "zh" : currentPreferences.locale;
  const id = pushSubscriptionId(subscription.endpoint);
  const now = new Date();
  const sealed = encrypted({ email, subscription });
  if (!sealed) return { ok: false, error: "push_not_configured" };
  const record = {
    version: 1,
    subscriptionId: id,
    accountTarget: target,
    accountLifecycleId: lifecycle,
    authVersion,
    encryptedSubscription: sealed,
    vapidKeyId: sha(config.publicKey).slice(0, 16),
    locale,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    lastSuccessAt: "",
    failureCount: 0,
  };
  const preferences = normalizePushPreferences(options.preferences || {}, { ...currentPreferences, locale: record.locale });
  const result = await redisCmd([
    "EVAL", BIND_SUBSCRIPTION_SCRIPT, "3",
    SUBSCRIPTIONS_HASH, ACCOUNT_SUBSCRIPTIONS_HASH, PREFERENCES_HASH,
    id, target, JSON.stringify(record), String(MAX_SUBSCRIPTIONS_PER_ACCOUNT), JSON.stringify(preferences),
  ]);
  if (result === "limit") return { ok: false, error: "subscription_limit" };
  if (!['created', 'updated'].includes(result)) return { ok: false, error: "storage_unavailable" };
  return { ok: true, subscriptionId: id, preferences, created: result === "created" };
}

export async function updatePushPreferences(auth, input) {
  const target = pushAccountTarget(auth?.email, auth?.accountLifecycleId);
  if (!target) return { ok: false, error: "push_identity_unavailable" };
  const current = await readPreferences(target);
  if (!current.ok) return { ok: false, error: "storage_unavailable" };
  const preferences = normalizePushPreferences(input, current.preferences);
  return await writePreferences(target, preferences)
    ? { ok: true, preferences }
    : { ok: false, error: "storage_unavailable" };
}

async function removeSubscriptionById(id, expectedTarget = "") {
  const raw = await redisCmd([
    "EVAL", REMOVE_SUBSCRIPTION_SCRIPT, "2",
    SUBSCRIPTIONS_HASH, ACCOUNT_SUBSCRIPTIONS_HASH,
    clean(id, 80), clean(expectedTarget, 80),
  ]);
  if (raw == null) return { ok: false, error: "storage_unavailable", removed: false };
  const result = redisNumber(raw);
  if (result == null) return { ok: false, error: "storage_unavailable", removed: false };
  if (result === -1) return { ok: false, error: "subscription_owner_changed", removed: false };
  if (result === 0 || result === 1) return { ok: true, removed: result === 1 };
  return { ok: false, error: "storage_unavailable", removed: false };
}

export async function removePushSubscription(auth, { endpoint = "", allDevices = false } = {}) {
  const target = pushAccountTarget(auth?.email, auth?.accountLifecycleId);
  if (!target) return { ok: false, error: "push_identity_unavailable" };
  if (allDevices) {
    const raw = await redisCmd([
      "EVAL", REMOVE_ALL_SUBSCRIPTIONS_SCRIPT, "2",
      SUBSCRIPTIONS_HASH, ACCOUNT_SUBSCRIPTIONS_HASH, target,
    ]);
    if (raw == null) return { ok: false, error: "storage_unavailable" };
    const count = redisNumber(raw);
    if (count == null) return { ok: false, error: "storage_unavailable" };
    return Number.isFinite(count) && count >= 0
      ? { ok: true, removed: count }
      : { ok: false, error: "storage_unavailable" };
  }
  const id = pushSubscriptionId(endpoint);
  if (!id) return { ok: false, error: "subscription_required" };
  const removed = await removeSubscriptionById(id, target);
  return removed.ok
    ? { ok: true, removed: removed.removed ? 1 : 0 }
    : { ok: false, error: removed.error };
}

function safeProductPart(value) {
  return clean(value, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export function pushStockProductKey(serviceValue, planValue) {
  const service = safeProductPart(serviceValue);
  const plan = safeProductPart(planValue);
  return service && plan ? `${service}:${plan}` : "";
}

export async function addStockWatch(auth, serviceValue, planValue) {
  const target = pushAccountTarget(auth?.email, auth?.accountLifecycleId);
  const productKey = pushStockProductKey(serviceValue, planValue);
  if (!target || !productKey) return { ok: false, error: "invalid_stock_watch" };
  const ids = await accountSubscriptionIds(target);
  if (!ids.ok) return { ok: false, error: "storage_unavailable" };
  if (!ids.ids.length) return { ok: false, error: "push_subscription_required" };
  const [service, plan] = productKey.split(":");
  const result = await redisCmd([
    "EVAL", STOCK_WATCH_ADD_SCRIPT, "3",
    `liumeiti:stock:${service}:${plan}`, STOCK_WATCHES_HASH, ACCOUNT_WATCHES_HASH,
    productKey, target, String(MAX_WATCHES_PER_ACCOUNT),
  ]);
  if (result == null) return { ok: false, error: "storage_unavailable" };
  if (result === "available") return { ok: true, available: true, watching: false, productKey };
  if (result === "watching") return { ok: true, available: false, watching: true, productKey };
  return { ok: false, error: result === "limit" ? "stock_watch_limit" : "stock_unavailable" };
}

export async function removeStockWatch(auth, serviceValue, planValue) {
  const target = pushAccountTarget(auth?.email, auth?.accountLifecycleId);
  const productKey = pushStockProductKey(serviceValue, planValue);
  if (!target || !productKey) return { ok: false, error: "invalid_stock_watch" };
  const result = await redisCmd([
    "EVAL", STOCK_WATCH_REMOVE_SCRIPT, "2",
    STOCK_WATCHES_HASH, ACCOUNT_WATCHES_HASH, productKey, target,
  ]);
  return redisNumber(result) === 1
    ? { ok: true, watching: false, productKey }
    : { ok: false, error: "storage_unavailable" };
}

function safeNotificationPath(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.length > 1000) return "";
  let url;
  try { url = new URL(text, "https://www.liumeiti.vip"); } catch { return ""; }
  return ["/account", "/shop", "/service-center", "/checkout"].some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + "/"))
    ? url.pathname + url.search + url.hash
    : "";
}

function eventField(sourceId) {
  return `pe_${sha(sourceId).slice(0, 48)}`;
}

function preparedEvent(record) {
  const eventId = eventField(record.sourceId);
  const event = { ...record, eventId };
  delete event.sourceId;
  // Delivery timestamps are generated at the call site and may differ by a
  // millisecond across concurrent retries. Hash only semantic event fields so
  // one business operation remains idempotent without masking payload drift.
  const semantic = { ...event };
  delete semantic.createdAt;
  delete semantic.expiresAt;
  delete semantic.attempts;
  delete semantic.nextAttemptAt;
  delete semantic.lastError;
  event.requestHash = sha(JSON.stringify(semantic));
  return event;
}

async function rememberEnqueueFailure(record, error) {
  const sourceId = clean(record?.sourceId, 500);
  if (!sourceId) return false;
  const recoveryId = `pr_${sha(sourceId).slice(0, 48)}`;
  const priorField = await readHashField(ENQUEUE_RECOVERY_HASH, recoveryId);
  if (!priorField.ok) return false;
  const prior = priorField.exists ? parseJson(priorField.value, null) : null;
  if (priorField.exists && !prior) return false;
  const attempts = Math.max(0, Number(prior?.attempts || 0)) + 1;
  const retryAt = Date.now() + retryDelayMs(attempts);
  const requestHash = preparedEvent(record).requestHash;
  const recovery = {
    version: 1,
    recoveryId,
    requestHash,
    record,
    error: clean(error || "push_enqueue_failed", 180),
    attempts,
    firstFailedAt: prior?.firstFailedAt || new Date().toISOString(),
    lastFailedAt: new Date().toISOString(),
    retryAt: new Date(retryAt).toISOString(),
  };
  const stored = await redisCmd([
    "EVAL", SAVE_ENQUEUE_RECOVERY_SCRIPT, "2", ENQUEUE_RECOVERY_HASH, ENQUEUE_RECOVERY_INDEX,
    recoveryId, requestHash, JSON.stringify(recovery), String(retryAt),
  ]);
  return ["saved", "updated"].includes(stored);
}

async function removeEnqueueRecovery(recoveryId) {
  return redisNumber(await redisCmd([
    "EVAL", REMOVE_ENQUEUE_RECOVERY_SCRIPT, "2", ENQUEUE_RECOVERY_HASH, ENQUEUE_RECOVERY_INDEX,
    clean(recoveryId, 80),
  ])) === 1;
}

async function enqueueEvent(record, options = {}) {
  const config = pushServerConfiguration();
  if (!config.enabled) return { ok: true, queued: false, skipped: true, reason: "push_disabled" };
  const event = preparedEvent(record);
  const { eventId } = event;
  const result = await redisCmd([
    "EVAL", ENQUEUE_EVENT_SCRIPT, "2", EVENTS_HASH, OUTBOX_KEY,
    eventId, event.requestHash, JSON.stringify(event), String(Date.now()),
  ]);
  if (result === "conflict") {
    const recoveryRecorded = options.rememberFailure !== false
      ? await rememberEnqueueFailure(record, "push_event_conflict")
      : false;
    return { ok: false, error: "push_event_conflict", recoveryRecorded };
  }
  if (!["queued", "exists"].includes(result)) {
    const recoveryRecorded = options.rememberFailure !== false
      ? await rememberEnqueueFailure(record, "storage_unavailable")
      : false;
    return { ok: false, error: "storage_unavailable", recoveryRecorded };
  }
  return { ok: true, queued: true, idempotent: result === "exists", eventId };
}

const ORDER_EVENT_TYPES = new Set([
  "order.awaiting_quote",
  "order.pending_payment",
  "order.received",
  "order.completed",
  "order.invalid",
  "order.quote_expired",
  "order.credentials_updated",
  "order.payment_confirmed",
]);

export async function enqueueOrderPushEvent(order, typeValue, operationValue, options = {}) {
  const type = String(typeValue || "").replace(/^status_/, "order.").replace(/^order_/, "order.");
  const normalizedType = type.includes(".") ? type : `order.${type}`;
  if (!ORDER_EVENT_TYPES.has(normalizedType)) return { ok: false, error: "invalid_push_event" };
  const email = normalizedEmail(order?.userEmail);
  const lifecycle = clean(order?.accountLifecycleId, 80).toLowerCase();
  const target = pushAccountTarget(email, lifecycle);
  if (!target) return validEmail(email) && validAccountLifecycleId(lifecycle)
    ? { ok: false, error: "push_not_configured" }
    : { ok: true, queued: false, skipped: true, reason: "guest_order" };
  const orderId = clean(order?.orderId, 80).replace(/\s+/g, "").toUpperCase();
  const operationId = clean(operationValue || `${normalizedType}:${order?.revision || 0}`, 200);
  const route = safeNotificationPath(options.route || `/account?order=${encodeURIComponent(orderId)}`);
  if (!orderId || !operationId || !route) return { ok: false, error: "invalid_push_event" };
  return enqueueEvent({
    version: 1,
    sourceId: `${normalizedType}:${orderId}:${operationId}`,
    type: normalizedType,
    category: "orders",
    audience: "account",
    accountTarget: target,
    accountLifecycleId: lifecycle,
    entityId: orderId,
    businessTraceId: clean(order?.businessTraceId, 40),
    route,
    locale: order?.locale === "en" ? "en" : "zh",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (options.ttlMs || 7 * 24 * 60 * 60 * 1000)).toISOString(),
    attempts: 0,
  });
}

export async function enqueueAfterSalesCompletedPush(ticket, order, operationValue) {
  const email = normalizedEmail(order?.userEmail);
  const lifecycle = clean(order?.accountLifecycleId, 80).toLowerCase();
  const target = pushAccountTarget(email, lifecycle);
  if (!target) return validEmail(email) && validAccountLifecycleId(lifecycle)
    ? { ok: false, error: "push_not_configured" }
    : { ok: true, queued: false, skipped: true, reason: "guest_order" };
  const ticketId = clean(ticket?.ticketId, 100).replace(/\s+/g, "").toUpperCase();
  const orderId = clean(ticket?.orderId || order?.orderId, 80).replace(/\s+/g, "").toUpperCase();
  const operationId = clean(operationValue, 160);
  if (!ticketId || !orderId || !operationId) return { ok: false, error: "invalid_push_event" };
  return enqueueEvent({
    version: 1,
    sourceId: `after-sales.completed:${ticketId}:${operationId}`,
    type: "after_sales.completed",
    category: "afterSales",
    audience: "account",
    accountTarget: target,
    accountLifecycleId: lifecycle,
    entityId: ticketId,
    relatedOrderId: orderId,
    businessTraceId: clean(order?.businessTraceId, 40),
    route: `/account?order=${encodeURIComponent(orderId)}&ticket=${encodeURIComponent(ticketId)}`,
    locale: ticket?.locale === "en" ? "en" : "zh",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    attempts: 0,
  });
}

export async function enqueueRenewalPushEvent(order, summary, renewPath) {
  const email = normalizedEmail(order?.userEmail);
  const lifecycle = clean(order?.accountLifecycleId, 80).toLowerCase();
  const target = pushAccountTarget(email, lifecycle);
  if (!target) return validEmail(email) && validAccountLifecycleId(lifecycle)
    ? { ok: false, error: "push_not_configured" }
    : { ok: true, queued: false, skipped: true, reason: "guest_order" };
  const orderId = clean(order?.orderId, 80).replace(/\s+/g, "").toUpperCase();
  const expiresAtValue = new Date(summary?.expiresAt || 0);
  const expiresAt = Number.isFinite(expiresAtValue.getTime()) ? expiresAtValue.toISOString() : "";
  const route = safeNotificationPath(renewPath);
  if (!orderId || !route || !expiresAt) return { ok: false, error: "invalid_push_event" };
  return enqueueEvent({
    version: 1,
    sourceId: `renewal.due:${orderId}:${expiresAt}`,
    type: "renewal.due",
    category: "renewals",
    audience: "account",
    accountTarget: target,
    accountLifecycleId: lifecycle,
    entityId: orderId,
    businessTraceId: clean(order?.businessTraceId, 40),
    route,
    locale: order?.locale === "en" ? "en" : "zh",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    attempts: 0,
  });
}

function stockEventRecord(serviceValue, planValue, operationValue, options = {}) {
  const productKey = pushStockProductKey(serviceValue, planValue);
  const operationId = clean(operationValue, 200);
  if (!productKey || !operationId) return null;
  const [service, plan] = productKey.split(":");
  const sourceId = `stock.restocked:${productKey}:${operationId}`;
  return {
    version: 1,
    sourceId,
    type: "stock.restocked",
    category: "stock",
    audience: "stock",
    productKey,
    entityId: productKey,
    serviceLabelZh: clean(options.serviceLabelZh, 80),
    serviceLabelEn: clean(options.serviceLabelEn, 80),
    planLabelZh: clean(options.planLabelZh, 80),
    planLabelEn: clean(options.planLabelEn, 80),
    route: `/shop?service=${encodeURIComponent(service)}&plan=${encodeURIComponent(plan)}`,
    locale: "zh",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    attempts: 0,
  };
}

export async function enqueueRestockPushEvent(service, plan, operationId, options = {}) {
  const event = stockEventRecord(service, plan, operationId, options);
  if (!event) return { ok: false, error: "invalid_push_event" };
  return enqueueEvent(event);
}

export async function setStockAndMaybeEnqueueRestock(serviceValue, planValue, value, operationId, options = {}) {
  const service = safeProductPart(serviceValue);
  const plan = safeProductPart(planValue);
  if (!service || !plan) return { ok: false, error: "invalid_stock" };
  const unlimited = value === "" || value == null;
  const count = unlimited ? null : Number(value);
  if (!unlimited && (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)) return { ok: false, error: "invalid_value" };
  const config = pushServerConfiguration();
  const eventRecord = config.enabled ? stockEventRecord(service, plan, operationId, options) : null;
  const event = eventRecord ? preparedEvent(eventRecord) : null;
  const resultRaw = await redisCmd([
    "EVAL", SET_STOCK_AND_ENQUEUE_SCRIPT, "3",
    `liumeiti:stock:${service}:${plan}`, EVENTS_HASH, OUTBOX_KEY,
    unlimited ? "unlimited" : String(count), event?.eventId || "", event?.requestHash || "", event ? JSON.stringify(event) : "", String(Date.now()),
  ]);
  const result = parseJson(resultRaw, null);
  if (!result?.ok) return { ok: false, error: resultRaw || "storage_unavailable" };
  return {
    ok: true,
    before: result.before === -1 ? null : Number(result.before),
    after: result.after === -1 ? null : Number(result.after),
    restocked: Boolean(result.restocked),
    eventQueued: Boolean(result.queued),
  };
}

function notificationCopy(event, locale) {
  const en = locale === "en";
  const labels = {
    "order.awaiting_quote": ["订单正在报价", "Order quote in progress", "我们正在为您准备订单报价。", "We are preparing a quote for your order."],
    "order.pending_payment": ["报价已完成", "Your quote is ready", "订单报价已准备好，请查看并完成付款。", "Your order quote is ready. Review it and complete payment."],
    "order.received": ["订单状态已更新", "Order status updated", "订单已进入处理流程。", "Your order is now being processed."],
    "order.completed": ["订单已完成", "Order completed", "服务已经准备完成，点击登录查看详情。", "Your service is ready. Sign in to view the details."],
    "order.invalid": ["订单状态需要关注", "Order needs attention", "订单状态已更新，点击查看处理结果。", "Your order status changed. Open it to review the result."],
    "order.quote_expired": ["订单报价已失效", "Order quote expired", "该订单报价已过期，如仍需要请重新确认。", "This order quote expired. Open it if you still need the service."],
    "order.credentials_updated": ["服务资料已更新", "Service details updated", "订单内的服务资料已有更新，点击登录查看。", "Service details in your order were updated. Sign in to view them."],
    "order.payment_confirmed": ["付款已确认", "Payment confirmed", "订单付款已经确认，正在进入处理流程。", "Your payment was confirmed and the order is being processed."],
    "after_sales.completed": ["售后处理已有结果", "After-sales update", "您的售后工单已经处理完成，点击登录查看。", "Your after-sales ticket has been completed. Sign in to view it."],
    "renewal.due": ["服务即将到期", "Service expiring soon", "您有一项服务即将到期，可点击查看续费。", "One of your services is expiring soon. Open it to renew."],
    "stock.restocked": ["订阅商品已到货", "A watched item is back", "您订阅的规格已经恢复库存，库存可能有限。", "A plan you watch is available again. Stock may be limited."],
  }[event.type] || ["账户通知", "Account notification", "账户内有一项新进展。", "There is a new update in your account."];
  if (event.type === "stock.restocked") {
    const service = en ? (event.serviceLabelEn || event.serviceLabelZh) : (event.serviceLabelZh || event.serviceLabelEn);
    const plan = en ? (event.planLabelEn || event.planLabelZh) : (event.planLabelZh || event.planLabelEn);
    const item = [service, plan].filter(Boolean).join(" · ");
    if (item) labels[en ? 3 : 2] = en ? `${item} is available again. Stock may be limited.` : `${item} 已恢复库存，库存可能有限。`;
  }
  return { title: en ? labels[1] : labels[0], body: en ? labels[3] : labels[2] };
}

function payloadForEvent(event, locale) {
  const copy = notificationCopy(event, locale);
  return {
    version: 1,
    eventId: event.eventId,
    category: event.category,
    title: copy.title,
    body: copy.body,
    url: safeNotificationPath(event.route) || "/account",
    tag: `${event.category}:${clean(event.entityId, 100)}`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    createdAt: event.createdAt,
  };
}

async function defaultSendNotification(subscription, payload, options) {
  const config = pushServerConfiguration();
  webpush.setVapidDetails(config.subject, config.publicKey, secretValue("WEB_PUSH_VAPID_PRIVATE_KEY"));
  return webpush.sendNotification(subscription, payload, { ...options, timeout: WEB_PUSH_TIMEOUT_MS });
}

function retryDelayMs(attempts, retryAfter = 0) {
  const fromHeader = Number(retryAfter) * 1000;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.min(6 * 60 * 60 * 1000, fromHeader);
  return Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** Math.min(8, Math.max(0, attempts))));
}

function deliveryField(eventId, subscriptionId) {
  return `${eventId}|${subscriptionId}`;
}

async function saveDelivery(eventId, subscriptionId, record) {
  return redisNumber(await redisCmd(["HSET", DELIVERIES_HASH, deliveryField(eventId, subscriptionId), JSON.stringify(record)])) != null;
}

async function saveSuccessfulDelivery(eventId, subscriptionId, delivery, subscriptionRecord) {
  return Number(await redisCmd([
    "EVAL", SAVE_SUCCESSFUL_DELIVERY_SCRIPT, "2", DELIVERIES_HASH, SUBSCRIPTIONS_HASH,
    deliveryField(eventId, subscriptionId), JSON.stringify(delivery), subscriptionId, JSON.stringify(subscriptionRecord),
  ])) === 1;
}

async function recordProviderAlert(event, subscriptionId, statusCode, error) {
  const at = new Date();
  const alertId = `pa_${sha(`${event?.eventId || "unknown"}\0${subscriptionId}\0${statusCode}`).slice(0, 48)}`;
  const record = {
    version: 1,
    alertId,
    eventId: clean(event?.eventId, 80),
    eventType: clean(event?.type, 80),
    subscriptionId: clean(subscriptionId, 80),
    statusCode: Number(statusCode || 0),
    error: clean(error || "push_provider_rejected", 180),
    at: at.toISOString(),
  };
  return Number(await redisCmd([
    "EVAL", SAVE_PROVIDER_ALERT_SCRIPT, "2", PROVIDER_ALERTS_HASH, PROVIDER_ALERTS_INDEX,
    alertId, JSON.stringify(record), String(at.getTime()),
  ])) === 1;
}

function validStoredSubscriptionRecord(record, id) {
  return Boolean(
    record
    && typeof record === "object"
    && !Array.isArray(record)
    && Number(record.version) === 1
    && record.subscriptionId === id
    && /^[a-f0-9]{64}$/.test(String(record.accountTarget || ""))
    && validAccountLifecycleId(String(record.accountLifecycleId || ""))
    && Number.isSafeInteger(Number(record.authVersion))
    && Number(record.authVersion) > 0
    && /^[a-f0-9]{16}$/.test(String(record.vapidKeyId || ""))
    && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(record.encryptedSubscription || ""))
  );
}

async function readSubscriptionRecord(id) {
  const field = await readHashField(SUBSCRIPTIONS_HASH, id);
  if (!field.ok) return { ok: false, error: "storage_unavailable", exists: false, record: null };
  if (!field.exists) return { ok: true, exists: false, record: null };
  const record = parseJson(field.value, null);
  return validStoredSubscriptionRecord(record, id)
    ? { ok: true, exists: true, record }
    : { ok: false, error: "push_subscription_record_corrupt", exists: true, record: null };
}

async function accountSubscriptionIds(target) {
  const state = parsedListField(await readHashField(ACCOUNT_SUBSCRIPTIONS_HASH, target), MAX_SUBSCRIPTIONS_PER_ACCOUNT);
  return state.ok
    ? { ok: true, ids: state.values }
    : { ok: false, error: "storage_unavailable", ids: [] };
}

async function targetsForEvent(event) {
  if (event.audience === "account") return { ok: true, targets: event.accountTarget ? [event.accountTarget] : [] };
  if (event.audience !== "stock" || !event.productKey) return { ok: true, targets: [] };
  const [service, plan] = String(event.productKey).split(":");
  const stock = await readStringField(`liumeiti:stock:${service}:${plan}`);
  if (!stock.ok) return { ok: false, error: "storage_unavailable", targets: [] };
  if (stock.exists && (!Number.isFinite(Number(stock.value)) || Number(stock.value) <= 0)) {
    return { ok: true, targets: [], stockUnavailable: true };
  }
  const watches = parsedListField(await readHashField(STOCK_WATCHES_HASH, event.productKey), 5000);
  return watches.ok
    ? { ok: true, targets: watches.values, stockUnavailable: false }
    : { ok: false, error: "storage_unavailable", targets: [] };
}

function pushTraceOrderId(event) {
  if (event?.category === "afterSales") return clean(event.relatedOrderId, 80).replace(/\s+/g, "").toUpperCase();
  if (["orders", "renewals"].includes(event?.category)) return clean(event.entityId, 80).replace(/\s+/g, "").toUpperCase();
  return "";
}

function safePushTraceErrorCode(value) {
  return clean(value, 100).toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
}

async function recordPushDeliveryTrace(event, phase, details = {}) {
  const orderId = pushTraceOrderId(event);
  const eventId = clean(event?.eventId, 80);
  const safePhase = phase === "retry" ? "retry" : "final";
  if (!orderId || !eventId) return false;
  try {
    // At most one retry trace and one final trace are emitted per Push event.
    // The operationId stays the eventId, while this durable marker prevents a
    // worker retry or overlapping recovery run from flooding the trace list.
    const claimed = await redisCmd([
      "SET", `${DELIVERY_TRACE_MARKER_PREFIX}${eventId}:${safePhase}`,
      "1", "NX", "EX", String(DELIVERY_TRACE_TTL_SECONDS),
    ]);
    if (claimed !== "OK") return false;
    const outcome = ["ok", "error", "uncertain", "retry", "skipped"].includes(details.outcome)
      ? details.outcome
      : (safePhase === "retry" ? "retry" : "ok");
    await appendBusinessTraceEvent(orderId, {
      businessTraceId: clean(event.businessTraceId, 40),
      stage: "push_delivery",
      component: "push",
      outcome,
      operationId: eventId,
      errorCode: safePushTraceErrorCode(details.errorCode),
    });
    return true;
  } catch {
    return false;
  }
}

async function finalizeEvent(event, deliveryFields = [], traceDetails = null, { clearStockWatches = true } = {}) {
  const safeFields = uniqueStrings(deliveryFields, MAX_SUBSCRIPTIONS_PER_ACCOUNT * 5000);
  const shouldClearStock = clearStockWatches && event.audience === "stock" && event.productKey;
  const result = await redisCmd([
    "EVAL", FINALIZE_EVENT_SCRIPT, "5",
    EVENTS_HASH, OUTBOX_KEY, DELIVERIES_HASH, STOCK_WATCHES_HASH, ACCOUNT_WATCHES_HASH,
    event.eventId, clean(event.requestHash, 80), shouldClearStock ? "1" : "0", String(safeFields.length),
    ...safeFields, shouldClearStock ? clean(event.productKey, 100) : "",
  ]);
  if (result !== "finalized") return { ok: false, error: "storage_unavailable" };
  if (traceDetails) await recordPushDeliveryTrace(event, "final", traceDetails);
  return { ok: true };
}

async function rescheduleEvent(event, error = "push_delivery_failed", retryAfter = 0, traceErrorCode = "push_delivery_retry") {
  const attempts = Math.max(0, Number(event.attempts || 0)) + 1;
  if (attempts >= MAX_EVENT_ATTEMPTS || new Date(event.expiresAt || 0).getTime() <= Date.now()) {
    const finalized = await finalizeEvent(event, [], { outcome: "error", errorCode: traceErrorCode || "push_delivery_exhausted" });
    return finalized.ok
      ? { ok: true, terminal: true, attempts }
      : { ok: false, terminal: false, pending: true, attempts, error: "storage_unavailable" };
  }
  const nextAttemptAt = Date.now() + retryDelayMs(attempts, retryAfter);
  const updated = { ...event, attempts, lastError: clean(error, 180), nextAttemptAt: new Date(nextAttemptAt).toISOString() };
  const result = await redisCmd([
    "EVAL", RESCHEDULE_EVENT_SCRIPT, "2", EVENTS_HASH, OUTBOX_KEY,
    event.eventId, clean(event.requestHash, 80), JSON.stringify(updated), String(nextAttemptAt),
  ]);
  if (result !== "rescheduled") return { ok: false, terminal: false, pending: true, attempts, error: "storage_unavailable" };
  await recordPushDeliveryTrace(event, "retry", { outcome: "retry", errorCode: traceErrorCode });
  return { ok: true, terminal: false, attempts, nextAttemptAt };
}

async function persistDeliveryFields(event, deliveryFields) {
  const safeFields = uniqueStrings(deliveryFields, MAX_SUBSCRIPTIONS_PER_ACCOUNT * 5000);
  if (!event?.eventId || !safeFields.length) return { ok: true };
  const result = await redisCmd([
    "EVAL", PERSIST_DELIVERY_FIELDS_SCRIPT, "1", EVENTS_HASH,
    event.eventId, clean(event.requestHash, 80), JSON.stringify(safeFields),
  ]);
  return result === "saved" ? { ok: true } : { ok: false, error: "storage_unavailable" };
}

async function stoppedDispatch(event, deliveryFields, leaseState, sent, removed) {
  const persisted = await persistDeliveryFields(event, deliveryFields);
  return {
    ok: false,
    pending: true,
    stopped: true,
    stopReason: leaseState.reason,
    ...(persisted.ok ? {} : { error: "storage_unavailable" }),
    sent,
    removed,
    retried: 0,
  };
}

async function dispatchEvent(event, sendNotification, lease) {
  if (!event?.eventId || new Date(event.expiresAt || 0).getTime() <= Date.now()) {
    const finalized = event?.eventId
      ? await finalizeEvent(event, [], { outcome: "skipped", errorCode: "push_event_expired" })
      : { ok: true };
    return finalized.ok
      ? { ok: true, expired: true, sent: 0, removed: 0, retried: 0 }
      : { ok: false, pending: true, error: "storage_unavailable", sent: 0, removed: 0, retried: 1 };
  }
  const targetState = await targetsForEvent(event);
  if (!targetState.ok) {
    const scheduled = await rescheduleEvent(event, targetState.error, 0, "push_target_store_unavailable");
    return { ok: false, pending: true, error: "storage_unavailable", rescheduled: scheduled.ok, sent: 0, removed: 0, retried: 1 };
  }
  const targets = targetState.targets;
  if (!targets.length) {
    // A restock can disappear before dispatch. Keep the one-shot watches so a
    // later real 0 -> available edge can notify them.
    if (event.audience === "stock" && targetState.stockUnavailable) {
      const finalized = await finalizeEvent(event, [], null, { clearStockWatches: false });
      return finalized.ok
        ? { ok: true, suppressed: true, sent: 0, removed: 0, retried: 0 }
        : { ok: false, pending: true, error: "storage_unavailable", sent: 0, removed: 0, retried: 1 };
    }
    const finalized = await finalizeEvent(event, [], { outcome: "skipped", errorCode: "push_no_targets" });
    return finalized.ok
      ? { ok: true, noTargets: true, sent: 0, removed: 0, retried: 0 }
      : { ok: false, pending: true, error: "storage_unavailable", sent: 0, removed: 0, retried: 1 };
  }

  let sent = 0;
  let removed = 0;
  let retry = false;
  let retryAfter = 0;
  let lastError = "";
  let lastErrorCode = "";
  let gone = 0;
  let terminal = 0;
  let uncertain = 0;
  const activeVapidKeyId = sha(pushServerConfiguration().publicKey).slice(0, 16);
  const touchedDeliveryFields = uniqueStrings(event.deliveryFields || [], MAX_SUBSCRIPTIONS_PER_ACCOUNT * 5000);
  for (const target of targets) {
    const targetLeaseState = await lease.check();
    if (!targetLeaseState.ok) {
      return stoppedDispatch(event, touchedDeliveryFields, targetLeaseState, sent, removed);
    }
    const preferenceState = await readPreferences(target);
    if (!preferenceState.ok) {
      retry = true;
      lastError = "push_preferences_store_unavailable";
      lastErrorCode = "push_preferences_store_unavailable";
      continue;
    }
    const preferences = preferenceState.preferences;
    if (!preferences.enabled || preferences[event.category] === false) continue;
    const idsState = await accountSubscriptionIds(target);
    if (!idsState.ok) {
      retry = true;
      lastError = "push_subscription_index_unavailable";
      lastErrorCode = "push_subscription_index_store_unavailable";
      continue;
    }
    let authState = null;
    let authEmail = "";
    for (const id of idsState.ids) {
      const leaseState = await lease.check();
      if (!leaseState.ok) {
        return stoppedDispatch(event, touchedDeliveryFields, leaseState, sent, removed);
      }
      const field = deliveryField(event.eventId, id);
      if (!touchedDeliveryFields.includes(field)) touchedDeliveryFields.push(field);
      const deliveryState = await readHashField(DELIVERIES_HASH, field);
      if (!deliveryState.ok) {
        retry = true;
        lastError = "push_delivery_store_unavailable";
        lastErrorCode = "push_delivery_store_unavailable";
        continue;
      }
      const prior = deliveryState.exists ? parseJson(deliveryState.value, null) : null;
      if (deliveryState.exists && !prior) {
        retry = true;
        lastError = "push_delivery_record_corrupt";
        lastErrorCode = "push_delivery_store_unavailable";
        continue;
      }
      if (["sent", "gone", "skipped", "terminal", "uncertain"].includes(prior?.status)) continue;
      if (prior?.status === "sending") {
        uncertain += 1;
        lastErrorCode = "push_delivery_uncertain";
        continue;
      }
      const subscriptionState = await readSubscriptionRecord(id);
      if (!subscriptionState.ok) {
        retry = true;
        lastError = "push_subscription_store_unavailable";
        lastErrorCode = "push_subscription_store_unavailable";
        continue;
      }
      const record = subscriptionState.record;
      if (!record) {
        const removedState = await removeSubscriptionById(id, target);
        const saved = await saveDelivery(event.eventId, id, {
          status: "gone",
          at: new Date().toISOString(),
          reason: "subscription_record_missing",
        });
        if (!removedState.ok || !saved) {
          retry = true;
          lastError = "push_missing_subscription_commit_failed";
          lastErrorCode = "push_storage_unavailable";
        } else gone += 1;
        continue;
      }
      if (record.accountTarget !== target) {
        retry = true;
        lastError = "push_subscription_owner_mismatch";
        lastErrorCode = "push_subscription_store_unavailable";
        continue;
      }
      if (record.vapidKeyId !== activeVapidKeyId) {
        const removedState = await removeSubscriptionById(id, target);
        const saved = await saveDelivery(event.eventId, id, {
          status: "gone",
          at: new Date().toISOString(),
          reason: "vapid_key_rotated",
        });
        if (!removedState.ok || !saved) {
          retry = true;
          lastError = "push_vapid_rotation_commit_failed";
          lastErrorCode = "push_storage_unavailable";
        } else {
          removed += removedState.removed ? 1 : 0;
          gone += 1;
        }
        continue;
      }
      const secret = decrypted(record.encryptedSubscription);
      const subscription = normalizePushSubscription(secret?.subscription);
      const email = normalizedEmail(secret?.email);
      const sealedIdentityMatches = Boolean(
        subscription
        && validEmail(email)
        && pushSubscriptionId(subscription.endpoint) === id
        && pushAccountTarget(email, record.accountLifecycleId) === record.accountTarget
      );
      if (!sealedIdentityMatches) {
        const removedState = await removeSubscriptionById(id, target);
        const saved = await saveDelivery(event.eventId, id, { status: "gone", at: new Date().toISOString(), reason: "invalid_record" });
        if (!removedState.ok || !saved) {
          retry = true;
          lastError = "push_terminal_commit_failed";
          lastErrorCode = "push_storage_unavailable";
          continue;
        }
        removed += 1;
        gone += 1;
        continue;
      }
      if (!authState || authEmail !== email) {
        authEmail = email;
        authState = await readUserAuthState(email);
      }
      if (!authState?.ok) {
        if (authState?.status === 503) {
          retry = true;
          lastError = authState.error || "auth_store_unavailable";
          lastErrorCode = "push_auth_store_unavailable";
          continue;
        }
        const removedState = await removeSubscriptionById(id, target);
        if (!removedState.ok) {
          retry = true;
          lastError = removedState.error;
          lastErrorCode = "push_storage_unavailable";
        } else {
          removed += removedState.removed ? 1 : 0;
          gone += 1;
        }
        continue;
      }
      if (
        authState.user?.banned
        || authState.accountLifecycleId !== record.accountLifecycleId
        || Number(authState.authVersion) !== Number(record.authVersion)
      ) {
        const removedState = await removeSubscriptionById(id, target);
        const saved = await saveDelivery(event.eventId, id, { status: "gone", at: new Date().toISOString(), reason: "account_state_changed" });
        if (!removedState.ok || !saved) {
          retry = true;
          lastError = "push_terminal_commit_failed";
          lastErrorCode = "push_storage_unavailable";
        } else {
          removed += removedState.removed ? 1 : 0;
          gone += 1;
        }
        continue;
      }
      const sendingSaved = await saveDelivery(event.eventId, id, {
        status: "sending",
        at: new Date().toISOString(),
        attempt: Math.max(0, Number(event.attempts || 0)) + 1,
      });
      if (!sendingSaved) {
        retry = true;
        lastError = "push_delivery_claim_failed";
        lastErrorCode = "push_delivery_store_unavailable";
        continue;
      }
      try {
        await sendNotification(subscription, JSON.stringify(payloadForEvent(event, preferences.locale || record.locale)), {
          TTL: Math.max(60, Math.floor((new Date(event.expiresAt).getTime() - Date.now()) / 1000)),
          urgency: ["order.completed", "order.payment_confirmed", "after_sales.completed"].includes(event.type) ? "high" : "normal",
          topic: event.eventId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
        });
        const successAt = new Date().toISOString();
        record.lastSuccessAt = successAt;
        record.lastSeenAt = successAt;
        record.failureCount = 0;
        const committed = await saveSuccessfulDelivery(
          event.eventId,
          id,
          { status: "sent", at: successAt },
          record,
        );
        sent += 1;
        if (!committed) {
          retry = true;
          lastError = "push_success_commit_failed";
          lastErrorCode = "push_delivery_uncertain";
        }
      } catch (error) {
        const statusCode = Number(error?.statusCode || error?.status || 0);
        lastError = clean(error?.message || `push_http_${statusCode || 0}`, 180);
        lastErrorCode = statusCode ? `push_http_${statusCode}` : "push_provider_unavailable";
        if ([404, 410].includes(statusCode)) {
          const removedState = await removeSubscriptionById(id, target);
          const saved = await saveDelivery(event.eventId, id, { status: "gone", at: new Date().toISOString(), statusCode });
          if (!removedState.ok || !saved) {
            retry = true;
            lastErrorCode = "push_storage_unavailable";
          } else {
            removed += removedState.removed ? 1 : 0;
            gone += 1;
          }
        } else if (statusCode === 400) {
          const saved = await saveDelivery(event.eventId, id, { status: "terminal", at: new Date().toISOString(), statusCode, error: lastError });
          const alerted = saved ? await recordProviderAlert(event, id, statusCode, lastError) : false;
          if (!saved || !alerted) {
            retry = true;
            lastErrorCode = "push_storage_unavailable";
          } else terminal += 1;
        } else if (statusCode === 429 || statusCode >= 500 || statusCode === 0 || [401, 403].includes(statusCode)) {
          retry = true;
          const header = error?.headers?.["retry-after"] || error?.headers?.get?.("retry-after") || 0;
          retryAfter = Math.max(retryAfter, Number(header) || 0);
          const saved = await saveDelivery(event.eventId, id, { status: "retryable", at: new Date().toISOString(), statusCode, error: lastError });
          const alerted = saved && [401, 403].includes(statusCode)
            ? await recordProviderAlert(event, id, statusCode, lastError)
            : true;
          if (!saved || !alerted) {
            lastError = "push_retry_commit_failed";
            lastErrorCode = "push_storage_unavailable";
          }
        } else {
          if (await saveDelivery(event.eventId, id, { status: "terminal", at: new Date().toISOString(), statusCode, error: lastError })) {
            terminal += 1;
          } else {
            retry = true;
            lastErrorCode = "push_storage_unavailable";
          }
        }
      }
    }
  }
  if (retry) {
    const pendingEvent = { ...event, deliveryFields: touchedDeliveryFields };
    const scheduled = await rescheduleEvent(pendingEvent, lastError, retryAfter, lastErrorCode || "push_delivery_retry");
    const storageFailure = /(?:store|storage|commit|uncertain)/.test(lastErrorCode);
    return {
      ok: false,
      pending: true,
      sent,
      removed,
      retried: 1,
      rescheduled: scheduled.ok,
      error: scheduled.error || (storageFailure ? "storage_unavailable" : lastError),
    };
  }
  const traceDetails = terminal > 0
    ? { outcome: "error", errorCode: lastErrorCode || "push_provider_terminal" }
    : uncertain > 0
      ? { outcome: "uncertain", errorCode: "push_delivery_uncertain" }
      : sent > 0
      ? { outcome: "ok", errorCode: "" }
      : gone > 0
        ? { outcome: "skipped", errorCode: "push_subscription_gone" }
        : { outcome: "skipped", errorCode: "push_no_eligible_subscription" };
  const finalized = await finalizeEvent(event, touchedDeliveryFields, traceDetails);
  return finalized.ok
    ? { ok: true, sent, removed, retried: 0 }
    : { ok: false, pending: true, sent, removed, retried: 1, error: "storage_unavailable" };
}

async function refreshDispatchLock(token) {
  const result = await redisCmd([
    "EVAL", REFRESH_DISPATCH_LOCK_SCRIPT, "1",
    DISPATCH_LOCK_KEY, token, String(DISPATCH_LOCK_TTL_SECONDS),
  ]);
  const numeric = redisNumber(result);
  if (numeric == null) return { ok: false, reason: "storage_unavailable" };
  return numeric === 1 ? { ok: true } : { ok: false, reason: "lock_lost" };
}

async function acquireDispatchLock(token) {
  const claimed = await redisCmd(["SET", DISPATCH_LOCK_KEY, token, "NX", "EX", String(DISPATCH_LOCK_TTL_SECONDS)]);
  if (claimed === "OK") return { ok: true, acquired: true };
  if (claimed != null) return { ok: false, error: "storage_unavailable", acquired: false };
  const current = await readStringField(DISPATCH_LOCK_KEY);
  if (!current.ok || !current.exists) return { ok: false, error: "storage_unavailable", acquired: false };
  return { ok: true, acquired: false, locked: true };
}

export async function dispatchPushOutbox({
  now = Date.now(),
  limit = 20,
  timeBudgetMs = DEFAULT_DISPATCH_BUDGET_MS,
  sendNotification = defaultSendNotification,
  clock = Date.now,
} = {}) {
  const config = pushServerConfiguration();
  if (!config.enabled) return { ok: true, disabled: true, scanned: 0, sent: 0, removed: 0, retried: 0 };
  if (!config.configured) return { ok: false, error: "push_not_configured", scanned: 0, sent: 0, removed: 0, retried: 0 };
  const lockToken = randomBytes(16).toString("hex");
  const lock = await acquireDispatchLock(lockToken);
  if (!lock.ok) return { ok: false, error: "storage_unavailable", scanned: 0, sent: 0, removed: 0, retried: 0 };
  if (!lock.acquired) return { ok: true, locked: true, scanned: 0, sent: 0, removed: 0, retried: 0 };
  const currentTime = typeof clock === "function" ? clock : Date.now;
  const startedAt = currentTime();
  const safeBudgetMs = Math.max(5_000, Math.min(45_000, Number(timeBudgetMs) || DEFAULT_DISPATCH_BUDGET_MS));
  const deadline = startedAt + safeBudgetMs;
  const lease = {
    async check() {
      if (currentTime() >= deadline) return { ok: false, reason: "time_budget" };
      return refreshDispatchLock(lockToken);
    },
  };
  try {
    const ids = await redisCmd([
      "ZRANGEBYSCORE", OUTBOX_KEY, "-inf", String(Number(now) || Date.now()),
      "LIMIT", "0", String(Math.max(1, Math.min(50, Number(limit) || 20))),
    ]);
    if (!Array.isArray(ids)) return { ok: false, error: "storage_unavailable", scanned: 0, sent: 0, removed: 0, retried: 0 };
    const summary = { ok: true, scanned: ids.length, sent: 0, removed: 0, retried: 0, failed: 0 };
    for (const id of ids) {
      const leaseState = await lease.check();
      if (!leaseState.ok) {
        summary.stopped = true;
        summary.stopReason = leaseState.reason;
        break;
      }
      const eventFieldState = await readHashField(EVENTS_HASH, clean(id, 80));
      if (!eventFieldState.ok) {
        summary.failed += 1;
        summary.error = "storage_unavailable";
        continue;
      }
      const event = eventFieldState.exists ? parseJson(eventFieldState.value, null) : null;
      if (!eventFieldState.exists) {
        if (redisNumber(await redisCmd(["ZREM", OUTBOX_KEY, clean(id, 80)])) == null) {
          summary.failed += 1;
          summary.error = "storage_unavailable";
        }
        continue;
      }
      if (!event) {
        summary.failed += 1;
        summary.error = "push_event_corrupt";
        continue;
      }
      const result = await dispatchEvent(event, sendNotification, lease);
      summary.sent += Number(result.sent || 0);
      summary.removed += Number(result.removed || 0);
      summary.retried += Number(result.retried || 0);
      if (result.error === "storage_unavailable") {
        summary.failed += 1;
        summary.error = "storage_unavailable";
      }
      if (result.stopped) {
        summary.stopped = true;
        summary.stopReason = result.stopReason;
        break;
      }
      if (!result.ok && !result.pending) summary.failed += 1;
    }
    summary.ok = summary.failed === 0 && !["lock_lost", "storage_unavailable"].includes(summary.stopReason);
    if (summary.stopReason === "storage_unavailable") summary.error = "storage_unavailable";
    return summary;
  } finally {
    await redisCmd([
      "EVAL", "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      "1", DISPATCH_LOCK_KEY, lockToken,
    ]);
  }
}

export async function recoverPushEnqueueFailures({
  now = Date.now(),
  limit = 100,
  timeBudgetMs = 5_000,
  clock = Date.now,
} = {}) {
  const currentTime = typeof clock === "function" ? clock : Date.now;
  const deadlineAt = currentTime() + Math.max(250, Math.min(10_000, Number(timeBudgetMs) || 5_000));
  const ids = await redisCmd([
    "ZRANGEBYSCORE", ENQUEUE_RECOVERY_INDEX, "-inf", String(Number(now) || Date.now()),
    "LIMIT", "0", String(Math.max(1, Math.min(500, Number(limit) || 100))),
  ]);
  if (!Array.isArray(ids)) return { ok: false, error: "storage_unavailable", scanned: 0, recovered: 0, pending: 0 };
  let recovered = 0;
  let expired = 0;
  let pending = 0;
  let failed = 0;
  let scanned = 0;
  let stopped = false;
  for (const rawId of ids) {
    if (currentTime() >= deadlineAt) {
      stopped = true;
      break;
    }
    scanned += 1;
    const recoveryId = clean(rawId, 80);
    const recoveryField = await readHashField(ENQUEUE_RECOVERY_HASH, recoveryId);
    if (!recoveryField.ok) {
      failed += 1;
      continue;
    }
    const recovery = recoveryField.exists ? parseJson(recoveryField.value, null) : null;
    if (recoveryField.exists && !recovery) {
      failed += 1;
      continue;
    }
    if (!recovery?.record?.sourceId) {
      if (!await removeEnqueueRecovery(recoveryId)) failed += 1;
      continue;
    }
    const expiresAt = new Date(recovery.record.expiresAt || 0).getTime();
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Number(now)) {
      if (!await removeEnqueueRecovery(recoveryId)) failed += 1;
      else expired += 1;
      continue;
    }
    const result = await enqueueEvent(recovery.record, { rememberFailure: false });
    if (result.ok) {
      if (!await removeEnqueueRecovery(recoveryId)) failed += 1;
      else recovered += 1;
      continue;
    }
    const attempts = Math.max(0, Number(recovery.attempts || 0)) + 1;
    const retryAt = Date.now() + retryDelayMs(attempts);
    const updated = {
      ...recovery,
      requestHash: recovery.requestHash || preparedEvent(recovery.record).requestHash,
      attempts,
      error: clean(result.error || "push_enqueue_failed", 180),
      lastFailedAt: new Date().toISOString(),
      retryAt: new Date(retryAt).toISOString(),
    };
    const saved = await redisCmd([
      "EVAL", SAVE_ENQUEUE_RECOVERY_SCRIPT, "2", ENQUEUE_RECOVERY_HASH, ENQUEUE_RECOVERY_INDEX,
      recoveryId, updated.requestHash, JSON.stringify(updated), String(retryAt),
    ]);
    if (!["saved", "updated"].includes(saved)) failed += 1;
    else pending += 1;
  }
  return {
    ok: pending === 0 && failed === 0,
    scanned,
    recovered,
    expired,
    pending,
    failed,
    stopped,
    ...(stopped ? { stopReason: "time_budget" } : {}),
    ...(failed ? { error: "storage_unavailable" } : {}),
  };
}

export async function cleanupExpiredPushSubscriptions({
  now = Date.now(),
  limit = 200,
  timeBudgetMs = 5_000,
  clock = Date.now,
} = {}) {
  const currentTime = typeof clock === "function" ? clock : Date.now;
  const deadlineAt = currentTime() + Math.max(250, Math.min(10_000, Number(timeBudgetMs) || 5_000));
  const cursorState = await readStringField(SUBSCRIPTION_CLEANUP_CURSOR_KEY);
  if (!cursorState.ok) return { ok: false, error: "storage_unavailable", scanned: 0, removed: 0 };
  const startCursor = clean(cursorState.value, 40) || "0";
  const result = await redisCmd(["HSCAN", SUBSCRIPTIONS_HASH, startCursor, "COUNT", String(Math.max(1, Math.min(1000, Number(limit) || 200)))]);
  if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
    return { ok: false, error: "storage_unavailable", scanned: 0, removed: 0, startCursor, nextCursor: startCursor };
  }
  const nextCursor = clean(result[0], 40) || "0";
  const pairs = result[1];
  if (pairs.length % 2 !== 0) {
    return { ok: false, error: "storage_unavailable", scanned: 0, removed: 0, startCursor, nextCursor: startCursor };
  }
  let removed = 0;
  let failed = 0;
  let scanned = 0;
  let stopped = false;
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    if (currentTime() >= deadlineAt) {
      stopped = true;
      break;
    }
    scanned += 1;
    const id = clean(pairs[index], 80);
    const record = parseJson(pairs[index + 1], null);
    const activityAt = [record?.createdAt, record?.lastSeenAt, record?.lastSuccessAt]
      .map((value) => new Date(value || 0).getTime())
      .filter((value) => Number.isFinite(value) && value > 0);
    const seenAt = activityAt.length ? Math.max(...activityAt) : 0;
    if (!record || !Number.isFinite(seenAt) || Number(now) - seenAt > SUBSCRIPTION_IDLE_MS) {
      const state = await removeSubscriptionById(id, record?.accountTarget || "");
      if (state.ok && state.removed) removed += 1;
      else if (!state.ok) failed += 1;
    }
  }
  const savedCursor = stopped ? startCursor : nextCursor;
  const cursorSaved = await redisCmd(["SET", SUBSCRIPTION_CLEANUP_CURSOR_KEY, savedCursor]) === "OK";
  return {
    ok: cursorSaved && failed === 0,
    ...(!cursorSaved || failed ? { error: "storage_unavailable" } : {}),
    scanned,
    removed,
    failed,
    startCursor,
    nextCursor,
    savedCursor,
    stopped,
    ...(stopped ? { stopReason: "time_budget" } : {}),
  };
}

export async function cleanupExpiredPushProviderAlerts({ now = Date.now(), limit = 200 } = {}) {
  const cutoff = Math.max(0, Number(now) || Date.now()) - PROVIDER_ALERT_RETENTION_MS;
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const result = await redisCmd([
    "EVAL", CLEANUP_PROVIDER_ALERTS_SCRIPT, "2", PROVIDER_ALERTS_HASH, PROVIDER_ALERTS_INDEX,
    String(cutoff), String(safeLimit),
  ]);
  const count = redisNumber(result);
  if (count == null) {
    return { ok: false, error: "storage_unavailable", scanned: 0, removed: 0 };
  }
  const removed = count;
  return { ok: true, scanned: removed, removed, cutoffAt: new Date(cutoff).toISOString() };
}

export async function readPushQueueStats() {
  const providerAlertCutoff = Date.now() - PROVIDER_ALERT_RETENTION_MS;
  const values = await Promise.all([
    redisCmd(["HLEN", SUBSCRIPTIONS_HASH]),
    redisCmd(["ZCARD", OUTBOX_KEY]),
    redisCmd(["HLEN", EVENTS_HASH]),
    redisCmd(["ZCARD", ENQUEUE_RECOVERY_INDEX]),
    redisCmd(["ZCOUNT", PROVIDER_ALERTS_INDEX, String(providerAlertCutoff), "+inf"]),
  ]);
  const counts = values.map(redisNumber);
  if (counts.some((value) => value == null)) {
    return { ok: false, error: "push_queue_stats_unavailable" };
  }
  const [subscriptions, queued, events, enqueueRecovery, providerAlerts] = counts;
  return {
    ok: true,
    subscriptions,
    queued,
    events,
    enqueueRecovery,
    providerAlerts,
  };
}

export const pushInternals = {
  SUBSCRIPTIONS_HASH,
  ACCOUNT_SUBSCRIPTIONS_HASH,
  PREFERENCES_HASH,
  EVENTS_HASH,
  OUTBOX_KEY,
  DELIVERIES_HASH,
  ENQUEUE_RECOVERY_HASH,
  ENQUEUE_RECOVERY_INDEX,
  SUBSCRIPTION_CLEANUP_CURSOR_KEY,
  PROVIDER_ALERTS_HASH,
  PROVIDER_ALERTS_INDEX,
  PROVIDER_ALERT_RETENTION_MS,
  STOCK_WATCHES_HASH,
  ACCOUNT_WATCHES_HASH,
  notificationCopy,
  payloadForEvent,
  encrypted,
  decrypted,
  safeNotificationPath,
};
