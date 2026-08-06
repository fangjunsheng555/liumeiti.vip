import { createHash, randomBytes } from "node:crypto";
import {
  REDIS_ATOMIC_CLUSTER_MODE,
  redisAtomicKeyspaceMode,
  redisAtomicStorageKey,
} from "./_redis-atomic-keyspace.js";

const USERS_KEY = "liumeiti:users";
const USER_EMAIL_SET_KEY = "liumeiti:users:emails";
const ACCOUNT_LIFECYCLE_PREFIX = "lm:user:lifecycle:";
const ADMIN_BALANCE_LOG_KEY = "liumeiti:admin:balance-log";
const WITHDRAWAL_LIST_KEY = "liumeiti:withdrawals";
const MONEY_OPERATION_PREFIX = "liumeiti:money:op:";
const ORDER_RECORD_PREFIX = "liumeiti:orders:record:";
const ORDER_INDEX_KEY = "liumeiti:orders:index";
const ORDER_INDEX_MEMBERSHIP_KEY = ORDER_INDEX_KEY + ":members";
const ORDER_EMAIL_INDEX_PREFIX = "liumeiti:orders:email:";
const ORDER_OVERVIEW_HASH_KEY = "liumeiti:orders:overview";
const ORDER_SUMMARY_INDEX_KEY = "liumeiti:orders:summary-created";
const ORDER_LIST_REVISION_KEY = "liumeiti:orders:list-revision";
const USDT_PENDING_ORDER_INDEX_KEY = "liumeiti:orders:usdt-pending";
const QUOTE_EXPIRY_ORDER_INDEX_KEY = "liumeiti:orders:quote-expiry";
export const USDT_CONFIRM_EFFECT_RECORDS_KEY = "lm:usdt:confirm-effects:records";
export const USDT_CONFIRM_EFFECT_INDEX_KEY = "lm:usdt:confirm-effects:pending";

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/$/, ""), token };
}

function clean(value, limit = 500) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase(); return email.length <= 254 ? email : "";
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function normalizeCode(value) {
  return clean(value, 80).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  const rounded = Math.round(number * 100);
  return Number.isSafeInteger(rounded) ? rounded : Number.NaN;
}

function amountFromCents(value) {
  return Math.round(Number(value || 0)) / 100;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  const beijing = new Date(timestamp + 8 * 60 * 60 * 1000);
  return [beijing.getUTCFullYear(), pad2(beijing.getUTCMonth() + 1), pad2(beijing.getUTCDate())].join("-")
    + " " + [pad2(beijing.getUTCHours()), pad2(beijing.getUTCMinutes()), pad2(beijing.getUTCSeconds())].join(":")
    + " 北京时间 (UTC+8)";
}

function makeId(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + randomBytes(5).toString("hex").toUpperCase();
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function userKey(email) {
  return USERS_KEY + ":" + normalizeEmail(email);
}

export function accountLifecycleKey(email) {
  return ACCOUNT_LIFECYCLE_PREFIX + normalizeEmail(email);
}

export function balanceCentsKey(email) {
  return userKey(email) + ":balance:cents";
}

export function requiredIdempotencyKey(request) {
  const raw = String(request?.headers?.get?.("idempotency-key") || "").trim();
  if (!raw) return { ok: false, error: "idempotency_key_required" };
  if (raw.length < 8 || raw.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
    return { ok: false, error: "invalid_idempotency_key" };
  }
  return { ok: true, key: raw };
}

function transactionKey(email) {
  return userKey(email) + ":tx";
}

function operationKey(scope, operationId) {
  // Idempotency keys are opaque. Replacing punctuation made distinct client
  // keys such as `checkout.1` and `checkout_1` collide. Hash the unmodified
  // scope/key tuple instead; callers add the authenticated principal to the
  // scope where a client supplied key is used.
  return MONEY_OPERATION_PREFIX + sha(String(scope || "") + "\0" + String(operationId || ""));
}

function redeemCodeKey(code) {
  return "liumeiti:redeem-code:" + normalizeCode(code);
}

function withdrawalKey(id) {
  return "liumeiti:withdrawal:" + clean(id, 80);
}

function orderRecordKey(orderId) {
  return ORDER_RECORD_PREFIX + normalizeOrderId(orderId);
}

function orderEmailIndexKey(email) {
  const lower = normalizeEmail(email);
  return validEmail(lower) ? ORDER_EMAIL_INDEX_PREFIX + lower : "";
}

function stockKey(service, plan) {
  return "liumeiti:stock:" + clean(service, 40) + ":" + clean(plan, 40);
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

const LOSSLESS_DELETE = Symbol("lossless-delete");

function parseLosslessJsonTree(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const source = raw;
  const skip = (start) => {
    let index = start;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    return index;
  };
  const stringEnd = (start) => {
    if (source[start] !== '"') return -1;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return index + 1;
    }
    return -1;
  };
  const parseValue = (start) => {
    const valueStart = skip(start);
    const character = source[valueStart];
    if (character === '"') {
      const end = stringEnd(valueStart);
      if (end < 0) return null;
      try { JSON.parse(source.slice(valueStart, end)); } catch { return null; }
      return { type: "scalar", start: valueStart, end };
    }
    if (character === "{") {
      const node = { type: "object", start: valueStart, end: -1, close: -1, properties: new Map(), members: [] };
      let index = skip(valueStart + 1);
      if (source[index] === "}") {
        node.close = index;
        node.end = index + 1;
        return node;
      }
      while (index < source.length) {
        const keyStart = index;
        const keyEnd = stringEnd(keyStart);
        if (keyEnd < 0) return null;
        let key;
        try { key = JSON.parse(source.slice(keyStart, keyEnd)); } catch { return null; }
        if (typeof key !== "string" || node.properties.has(key)) return null;
        index = skip(keyEnd);
        if (source[index] !== ":") return null;
        const value = parseValue(index + 1);
        if (!value) return null;
        const member = { key, keyStart, keyEnd, value };
        node.properties.set(key, member);
        node.members.push(member);
        index = skip(value.end);
        if (source[index] === "}") {
          node.close = index;
          node.end = index + 1;
          return node;
        }
        if (source[index] !== ",") return null;
        index = skip(index + 1);
      }
      return null;
    }
    if (character === "[") {
      const node = { type: "array", start: valueStart, end: -1, close: -1, items: [] };
      let index = skip(valueStart + 1);
      if (source[index] === "]") {
        node.close = index;
        node.end = index + 1;
        return node;
      }
      while (index < source.length) {
        const value = parseValue(index);
        if (!value) return null;
        node.items.push(value);
        index = skip(value.end);
        if (source[index] === "]") {
          node.close = index;
          node.end = index + 1;
          return node;
        }
        if (source[index] !== ",") return null;
        index = skip(index + 1);
      }
      return null;
    }
    let end = valueStart;
    while (end < source.length && !/[\s,}\]]/.test(source[end])) end += 1;
    if (end <= valueStart) return null;
    try { JSON.parse(source.slice(valueStart, end)); } catch { return null; }
    return { type: "scalar", start: valueStart, end };
  };
  const root = parseValue(0);
  if (!root || skip(root.end) !== source.length) return null;
  return root;
}

function losslessJsonPatchBatch(raw, operations) {
  const root = parseLosslessJsonTree(raw);
  if (!root || !Array.isArray(operations)) return null;
  const edits = [];
  const additions = new Map();
  const locate = (path) => {
    let node = root;
    for (const segment of path) {
      if (node.type === "object" && typeof segment === "string") node = node.properties.get(segment)?.value;
      else if (node.type === "array" && Number.isInteger(segment)) node = node.items[segment];
      else return null;
      if (!node) return null;
    }
    return node;
  };
  for (const operation of operations) {
    const path = Array.isArray(operation?.path) ? operation.path : [];
    if (!path.length) return null;
    const parent = locate(path.slice(0, -1));
    const leaf = path.at(-1);
    if (!parent || parent.type !== "object" || typeof leaf !== "string" || !leaf) return null;
    const member = parent.properties.get(leaf);
    if (operation.value === LOSSLESS_DELETE) {
      if (!member) continue;
      const index = parent.members.indexOf(member);
      if (parent.members.length === 1) edits.push({ start: member.keyStart, end: member.value.end, text: "" });
      else if (index < parent.members.length - 1) {
        edits.push({ start: member.keyStart, end: parent.members[index + 1].keyStart, text: "" });
      } else {
        edits.push({ start: parent.members[index - 1].value.end, end: member.value.end, text: "" });
      }
      continue;
    }
    let encoded;
    try { encoded = JSON.stringify(operation.value); } catch { return null; }
    if (encoded === undefined) return null;
    if (member) edits.push({ start: member.value.start, end: member.value.end, text: encoded });
    else {
      const key = `${parent.start}:${parent.end}`;
      if (!additions.has(key)) additions.set(key, { parent, fields: [] });
      const group = additions.get(key);
      if (group.fields.some((item) => item.key === leaf)) return null;
      group.fields.push({ key: leaf, encoded });
    }
  }
  for (const { parent, fields } of additions.values()) {
    edits.push({
      start: parent.close,
      end: parent.close,
      text: `${parent.members.length ? "," : ""}${fields.map(({ key, encoded }) => `${JSON.stringify(key)}:${encoded}`).join(",")}`,
    });
  }
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) return null;
  }
  let next = raw;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return parseLosslessJsonTree(next) ? next : null;
}

function losslessJsonPatch(raw, operations) {
  if (!Array.isArray(operations)) return null;
  if (operations.length === 0) return parseLosslessJsonTree(raw) ? raw : null;
  // Apply one field at a time and reparse between edits. Adjacent removals at
  // the end of an object otherwise calculate overlapping comma ranges from the
  // same stale tree (for example a used coupon's four trailing audit fields).
  // Re-parsing preserves every untouched byte while making each comma boundary
  // reflect the document produced by the previous edit.
  let next = raw;
  for (const operation of operations) {
    next = losslessJsonPatchBatch(next, [operation]);
    if (!next) return null;
  }
  return next;
}

function losslessTopLevelPatch(raw, replacements, removals = []) {
  const operations = Object.entries(replacements || {}).map(([key, value]) => ({ path: [key], value }));
  for (const key of removals) operations.push({ path: [key], value: LOSSLESS_DELETE });
  return losslessJsonPatch(raw, operations);
}

function losslessJsonValue(raw, path) {
  let node = parseLosslessJsonTree(raw);
  if (!node) return null;
  for (const segment of path) {
    if (node.type === "object" && typeof segment === "string") node = node.properties.get(segment)?.value;
    else if (node.type === "array" && Number.isInteger(segment)) node = node.items[segment];
    else return null;
    if (!node) return null;
  }
  return raw.slice(node.start, node.end);
}

export function idempotencyPayloadHash(value) {
  return sha(stableJson(value));
}

export function orderIdForIdempotencyKey(key) {
  return "LM" + sha("order:" + clean(key, 160)).slice(0, 20).toUpperCase();
}

function parseEvalResult(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function redisCommand(command) {
  const config = redisConfig();
  if (!config) return { ok: false, error: "storage_unavailable" };
  try {
    const response = await fetch(config.url + "/" + command.map((part) => encodeURIComponent(String(part))).join("/"), {
      headers: { Authorization: "Bearer " + config.token },
    });
    if (!response.ok) return { ok: false, error: "storage_unavailable", status: response.status };
    const payload = await response.json();
    if (payload?.error) return { ok: false, error: "storage_error", detail: clean(payload.error, 300) };
    return { ok: true, value: payload?.result ?? null };
  } catch (error) {
    return { ok: false, error: "storage_unavailable", detail: clean(error?.message, 200) };
  }
}

// Send EVAL in the JSON body. The surrounding pipeline has one command only;
// atomicity comes from Redis' script execution, not from the non-atomic REST
// pipeline itself. This also avoids putting long scripts and JSON in the URL.
export async function redisEvalAtomic(script, keys = [], args = []) {
  const config = redisConfig();
  if (!config) return { ok: false, error: "storage_unavailable" };
  try {
    const response = await fetch(config.url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
      body: JSON.stringify([["EVAL", script, String(keys.length), ...keys, ...args.map((value) => String(value))]]),
    });
    if (!response.ok) return { ok: false, error: "storage_unavailable", status: response.status };
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.error) return { ok: false, error: "storage_error", detail: clean(row?.error, 300) };
    const parsed = parseEvalResult(row.result);
    return parsed ? { ok: true, value: parsed } : { ok: false, error: "invalid_storage_response" };
  } catch (error) {
    return { ok: false, error: "storage_unavailable", detail: clean(error?.message, 200) };
  }
}

async function prepareMoneyAtomicKeys(keys) {
  const mode = redisAtomicKeyspaceMode();
  if (mode === "invalid") return { ok: false, error: "invalid_redis_keyspace_mode" };
  if (mode !== REDIS_ATOMIC_CLUSTER_MODE) return { ok: true, keys };

  // The rest of the application still reads the historical logical keys and
  // contains additional multi-key scripts. Enabling only the money-key mapper
  // would split one account/order across two databases even after a marker was
  // written. Reject Cluster mode until a versioned, application-wide router
  // and offline migration are shipped together.
  return { ok: false, error: "redis_cluster_keyspace_not_supported" };
}

async function redisEvalMoneyAtomic(script, keys = [], args = []) {
  const prepared = await prepareMoneyAtomicKeys(keys);
  const executed = prepared.ok ? await redisEvalAtomic(script, prepared.keys, args) : prepared;
  return !executed.ok || (executed.value && typeof executed.value === "object" && !Array.isArray(executed.value) && typeof executed.value.ok === "boolean") ? executed : { ok: false, error: "invalid_storage_response" };
}

async function redisMoneyGet(logicalKey) {
  const prepared = await prepareMoneyAtomicKeys([logicalKey]);
  if (!prepared.ok) return prepared;
  return redisCommand(["GET", prepared.keys[0]]);
}

async function recoverOperation(opKey, requestHash) {
  const stored = await redisMoneyGet(opKey);
  if (!stored.ok || !stored.value) return stored.ok ? null : { ok: false, error: stored.error || "storage_unavailable" };
  try {
    const record = JSON.parse(stored.value);
    if (record?.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
    const result = record.result || (typeof record.resultJson === "string" ? JSON.parse(record.resultJson) : null);
    if (!result || typeof result !== "object" || Array.isArray(result) || result.ok !== true) return { ok: false, error: "invalid_operation_record" };
    return { ...result, idempotent: true, recovered: true };
  } catch {
    return { ok: false, error: "invalid_operation_record" };
  }
}

export async function findOrderCreationByIdempotencyKey(operationId, requestHash) {
  const key = clean(operationId, 160);
  const hash = clean(requestHash, 80);
  if (!key || !hash) return { ok: false, error: "invalid_idempotency_key" };
  const stored = await redisMoneyGet(operationKey("order-create", key));
  if (!stored.ok) return stored;
  if (!stored.value) return { ok: true, found: false };
  try {
    const record = JSON.parse(stored.value);
    if (record?.requestHash !== hash) return { ok: false, error: "idempotency_conflict" };
    const result = record.result || (typeof record.resultJson === "string" ? JSON.parse(record.resultJson) : null);
    if (result?.ok !== true || !result?.order || typeof result.order !== "object" || Array.isArray(result.order)
      || normalizeOrderId(result.order.orderId) !== orderIdForIdempotencyKey(key)) return { ok: false, error: "invalid_operation_record" };
    return { ok: true, found: true, ...result, idempotent: true };
  } catch {
    return { ok: false, error: "invalid_operation_record" };
  }
}

async function executeOperation({ script, keys, args, opKey, requestHash }) {
  const executed = await redisEvalMoneyAtomic(script, keys, args);
  if (executed.ok) return executed.value;
  if ([
    "invalid_redis_keyspace_mode",
    "redis_cluster_keyspace_not_supported",
    "redis_cluster_keyspace_not_ready",
    "redis_cluster_crossslot_guard",
  ].includes(executed.error)) return executed;
  // A lost HTTP response is ambiguous: the script may already have committed.
  // Read the operation record before reporting failure or attempting rollback.
  const recovered = await recoverOperation(opKey, requestHash);
  return recovered || { ok: false, error: executed.error || "storage_unavailable", ambiguous: true };
}

export async function getBalanceCentsOverlay(email, fallbackBalance = 0) {
  const lower = normalizeEmail(email);
  if (!validEmail(lower)) return { ok: false, error: "invalid_email" };
  const result = await redisMoneyGet(balanceCentsKey(lower));
  if (!result.ok) return result;
  if (result.value == null) {
    const fallbackCents = cents(fallbackBalance);
    if (!Number.isSafeInteger(fallbackCents)) return { ok: false, error: "invalid_balance_record" };
    return { ok: true, exists: false, cents: fallbackCents, balance: amountFromCents(fallbackCents) };
  }
  const storedCents = Number(result.value);
  if (!Number.isSafeInteger(storedCents)) return { ok: false, error: "invalid_balance_record" };
  return { ok: true, exists: true, cents: storedCents, balance: amountFromCents(storedCents) };
}

const LUA_COMMON = `
local MAX_SAFE_INTEGER=9007199254740991
local function safeinteger(value)
  return type(value)=='number' and value==value and value==math.floor(value)
    and value>=-MAX_SAFE_INTEGER and value<=MAX_SAFE_INTEGER
end
local function safeadd(left,right)
  if not safeinteger(left) or not safeinteger(right) then return nil end
  local result=left+right
  if not safeinteger(result) then return nil end
  return result
end
local function keytype(key)
  local result = redis.call('TYPE', key)
  if type(result) == 'table' then return result.ok end
  return result
end
local function validtype(key, expected)
  local actual = keytype(key)
  return actual == 'none' or actual == expected
end
local function decode(value)
  local ok, result = pcall(cjson.decode, value)
  if not ok or type(result) ~= 'table' then return nil end
  local encodable = pcall(cjson.encode, {value={value={value=result}}})
  if not encodable then return nil end
  return result
end
local function appendobjectfields(raw,fields)
  if type(raw)~='string' or type(fields)~='string' or string.sub(raw,-1)~='}' then return nil end
  local prefix=string.sub(raw,1,-2)
  local separator=#prefix>1 and ',' or ''
  local candidate=prefix..separator..fields..'}'
  if not decode(candidate) then return nil end
  return candidate
end
local function persistedencode(value)
  local ok,encoded=pcall(cjson.encode,value)
  if not ok then return nil end
  return encoded
end
local function encode(value)
  local encoded=persistedencode(value)
  if not encoded then return redis.error_reply('money_json_encode_failed') end
  return encoded
end
local function legacycents(user)
  local value=tonumber(user.balance or 0)
  if not value or value~=value then return nil end
  local result=nil
  if value>=0 then result=math.floor(value*100+0.5) else result=math.ceil(value*100-0.5) end
  if not safeinteger(result) then return nil end
  return result
end
local function readbalance(balanceKey, user)
  local raw = redis.call('GET', balanceKey)
  if not raw then return legacycents(user) end
  local value = tonumber(raw)
  if not safeinteger(value) then return nil end
  return value
end
local function existingop(opKey, requestHash)
  local raw = redis.call('GET', opKey)
  if not raw then return nil end
  local item = decode(raw)
  if not item then return encode({ok=false,error='invalid_operation_record'}) end
  if item.requestHash ~= requestHash then return encode({ok=false,error='idempotency_conflict'}) end
  if type(item.resultJson)=='string' then
    local parsed=decode(item.resultJson)
    if not parsed or parsed.ok~=true or string.sub(item.resultJson,-1)~='}' then return encode({ok=false,error='invalid_operation_record'}) end
    return string.sub(item.resultJson,1,-2)..',"idempotent":true}'
  end
  if type(item.result) ~= 'table' or item.result.ok~=true then return encode({ok=false,error='invalid_operation_record'}) end
  item.result.idempotent = true
  return encode(item.result)
end
local function saveop(opKey, requestHash, result)
  redis.call('SET', opKey, persistedencode({requestHash=requestHash,result=result}))
end
local function saveopjson(opKey, requestHash, resultJson)
  redis.call('SET',opKey,persistedencode({requestHash=requestHash,resultJson=resultJson}))
end
local function pushtrim(key, value, stop)
  redis.call('LPUSH', key, value)
  redis.call('LTRIM', key, '0', tostring(stop))
end
`;

const SAVE_USER_PROFILE_SCRIPT = LUA_COMMON + `
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'string') or not validtype(KEYS[4],'set') or not validtype(KEYS[5],'string') then return encode({ok=false,error='storage_type_error'}) end
local next=decode(ARGV[10]); if not next then return encode({ok=false,error='invalid_user_record'}) end
local currentRaw=redis.call('GET',KEYS[1])
if (ARGV[8]=='1' and currentRaw~=ARGV[9]) or (ARGV[8]=='0' and currentRaw) then return encode({ok=false,error='storage_conflict'}) end
local current=currentRaw and decode(currentRaw) or nil
if currentRaw and not current then return encode({ok=false,error='invalid_user_record'}) end
if ARGV[3]=='1' and currentRaw then return encode({ok=false,error='user_exists'}) end
if ARGV[4]=='1' and not currentRaw then return encode({ok=false,error='user_not_found'}) end
local expectedVersion=tonumber(ARGV[2] or '0')
if not expectedVersion or expectedVersion<0 or expectedVersion~=math.floor(expectedVersion) then return encode({ok=false,error='invalid_auth_version'}) end
local versionRaw=redis.call('GET',KEYS[3])
if versionRaw and not string.match(versionRaw,'^%d+$') then return encode({ok=false,error='invalid_auth_version'}) end
local currentVersion=versionRaw and tonumber(versionRaw) or 1
if not currentVersion or currentVersion<1 or currentVersion~=math.floor(currentVersion) or currentVersion>9007199254740990 then
  return encode({ok=false,error='invalid_auth_version'})
end
if expectedVersion>0 then
  if currentVersion~=expectedVersion then return encode({ok=false,error='session_state_changed'}) end
end
local lifecycleCandidate=ARGV[6]
if #lifecycleCandidate~=32 or string.match(lifecycleCandidate,'[^a-f0-9]') then return encode({ok=false,error='invalid_lifecycle_candidate'}) end
local lifecycle=currentRaw and redis.call('GET',KEYS[5]) or nil
local expectedLifecycle=ARGV[7] or ''
if expectedLifecycle~='' then
  if #expectedLifecycle~=32 or string.match(expectedLifecycle,'[^a-f0-9]') then return encode({ok=false,error='invalid_account_lifecycle'}) end
  if not lifecycle or lifecycle~=expectedLifecycle then return encode({ok=false,error='account_lifecycle_changed'}) end
end
if lifecycle then
  if #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') then return encode({ok=false,error='invalid_account_lifecycle'}) end
else
  lifecycle=lifecycleCandidate
end
-- General profile writers must never overwrite security state from a stale
-- snapshot. Password resets and ban changes use dedicated atomic functions.
if current then
  next.passwordHash=current.passwordHash
  next.passwordResetAt=current.passwordResetAt
  next.banned=current.banned
  next.bannedAt=current.bannedAt
  next.bannedByStaffId=current.bannedByStaffId
  next.unbannedByStaffId=current.unbannedByStaffId
  -- Coupons and referral earnings are changed by dedicated money scripts.
  -- A stale profile/social update must not revive a used coupon or erase a
  -- commission that committed concurrently.
  if current.coupons~=nil then next.coupons=current.coupons end
  if current.referralStats~=nil then next.referralStats=current.referralStats end
end
local rawBalance=redis.call('GET',KEYS[2]); local authoritative=nil
if (ARGV[11]=='1' and rawBalance~=ARGV[12]) or (ARGV[11]=='0' and rawBalance) then return encode({ok=false,error='storage_conflict'}) end
if rawBalance then
  authoritative=tonumber(rawBalance)
  if not safeinteger(authoritative) then return encode({ok=false,error='invalid_balance_record'}) end
else
  authoritative=legacycents(current or next)
  if not authoritative then return encode({ok=false,error='invalid_balance_record'}) end
end
next.balance=authoritative/100
local responseJson=persistedencode({ok=true,balance=authoritative/100,balanceCents=authoritative,authVersion=currentVersion,accountLifecycleId=lifecycle})
if not responseJson then return redis.error_reply('money_json_encode_failed') end
if not rawBalance then redis.call('SET',KEYS[2],tostring(authoritative)) end
-- canonical cents key is authoritative
redis.call('SET',KEYS[1],ARGV[10])
redis.call('SET',KEYS[5],lifecycle)
redis.call('SADD',KEYS[4],ARGV[5])
return responseJson
`;

// Profile writes and balance effects are both Redis scripts. Whichever runs
// last therefore observes the canonical cents value instead of reviving a
// stale balance copied from an earlier profile read.
export async function saveUserPreservingBalanceAtomic(email, user, options = {}) {
  const lower = normalizeEmail(email);
  if (!validEmail(lower) || !user || typeof user !== "object") return { ok: false, error: "invalid_user_record" };
  const expectedAuthVersion = Number(options.expectedAuthVersion || 0);
  if (!Number.isSafeInteger(expectedAuthVersion) || expectedAuthVersion < 0) return { ok: false, error: "invalid_auth_version" };
  const expectedAccountLifecycleId = clean(options.expectedAccountLifecycleId, 80).toLowerCase();
  if (expectedAccountLifecycleId && !/^[a-f0-9]{32}$/.test(expectedAccountLifecycleId)) {
    return { ok: false, error: "invalid_account_lifecycle" };
  }
  const createOnly = options.createOnly === true;
  const updateOnly = options.updateOnly === true;
  if (createOnly && updateOnly) return { ok: false, error: "invalid_write_mode" };
  const lifecycleCandidate = randomBytes(16).toString("hex");
  const protectedFields = new Set([
    "passwordHash", "passwordResetAt", "banned", "bannedAt", "bannedByStaffId", "unbannedByStaffId",
    "coupons", "referralStats", "balance",
  ]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [profileRead, balanceRead] = await Promise.all([
      redisMoneyGet(userKey(lower)), redisMoneyGet(balanceCentsKey(lower)),
    ]);
    if (!profileRead.ok || !balanceRead.ok) return { ok: false, error: profileRead.error || balanceRead.error || "storage_unavailable" };
    if (createOnly && profileRead.value) return { ok: false, error: "user_exists" };
    if (updateOnly && !profileRead.value) return { ok: false, error: "user_not_found" };
    let current = null;
    if (profileRead.value) {
      try { current = JSON.parse(profileRead.value); } catch { return { ok: false, error: "invalid_user_record" }; }
      if (!current || typeof current !== "object" || Array.isArray(current)) return { ok: false, error: "invalid_user_record" };
    }
    let authoritative;
    if (balanceRead.value != null) {
      authoritative = Number(balanceRead.value);
      if (!Number.isSafeInteger(authoritative)) return { ok: false, error: "invalid_balance_record" };
    } else {
      authoritative = cents(current?.balance ?? user.balance ?? 0);
      if (!Number.isSafeInteger(authoritative)) return { ok: false, error: "invalid_balance_record" };
    }
    let nextRaw;
    if (profileRead.value) {
      const replacements = { balance: amountFromCents(authoritative) };
      for (const [key, value] of Object.entries(user)) if (!protectedFields.has(key)) replacements[key] = value;
      nextRaw = losslessTopLevelPatch(profileRead.value, replacements);
    } else {
      nextRaw = losslessTopLevelPatch(JSON.stringify(user), { balance: amountFromCents(authoritative) });
    }
    if (!nextRaw) return { ok: false, error: "invalid_user_record" };
    const result = await redisEvalMoneyAtomic(
      SAVE_USER_PROFILE_SCRIPT,
      [userKey(lower), balanceCentsKey(lower), "lm:user:authver:" + lower, USER_EMAIL_SET_KEY, accountLifecycleKey(lower)],
      [
        JSON.stringify(user), expectedAuthVersion,
        createOnly ? "1" : "0", updateOnly ? "1" : "0", lower,
        lifecycleCandidate, expectedAccountLifecycleId,
        profileRead.value == null ? "0" : "1", profileRead.value || "", nextRaw,
        balanceRead.value == null ? "0" : "1", balanceRead.value || "",
      ],
    );
    const value = result.ok ? result.value : result;
    if (value?.error !== "storage_conflict") return value;
  }
  return { ok: false, error: "storage_conflict" };
}

async function redisMoneyHget(logicalKey, field) {
  const prepared = await prepareMoneyAtomicKeys([logicalKey]);
  if (!prepared.ok) return prepared;
  return redisCommand(["HGET", prepared.keys[0], field]);
}

const TRANSFER_SCRIPT = LUA_COMMON + `
for index,key in ipairs(KEYS) do
  local expected = index <= 7 and 'string' or 'list'
  if not validtype(key, expected) then return encode({ok=false,error='storage_type_error'}) end
end
local fromRaw = redis.call('GET', KEYS[2])
if not fromRaw then return encode({ok=false,error='session_state_changed'}) end
local fromUser = decode(fromRaw); if not fromUser then return encode({ok=false,error='invalid_user_record'}) end
if fromUser.banned then return encode({ok=false,error='account_banned'}) end
local versionRaw=redis.call('GET',KEYS[6])
if versionRaw and not string.match(versionRaw,'^%d+$') then return encode({ok=false,error='invalid_auth_version'}) end
local currentVersion=versionRaw and tonumber(versionRaw) or 1
local expectedVersion=tonumber(ARGV[7] or '0')
if not currentVersion or currentVersion<1 or currentVersion~=math.floor(currentVersion) or currentVersion>9007199254740990 or not expectedVersion or expectedVersion<1 or expectedVersion~=math.floor(expectedVersion) or currentVersion~=expectedVersion then
  return encode({ok=false,error='session_state_changed'})
end
local currentLifecycle=redis.call('GET',KEYS[7])
if not currentLifecycle or currentLifecycle~=ARGV[8] then return encode({ok=false,error='account_lifecycle_changed'}) end
local prior = existingop(KEYS[1], ARGV[1]); if prior then return prior end
local toRaw = redis.call('GET', KEYS[3])
if not toRaw then return encode({ok=false,error='recipient_not_found'}) end
local toUser = decode(toRaw); if not toUser then return encode({ok=false,error='invalid_user_record'}) end
if toUser.banned then return encode({ok=false,error='recipient_unavailable'}) end
local delta=tonumber(ARGV[2]); if not safeinteger(delta) or delta<=0 then return encode({ok=false,error='invalid_amount'}) end
local fromBefore = readbalance(KEYS[4], fromUser); local toBefore = readbalance(KEYS[5], toUser)
if not fromBefore or not toBefore then return encode({ok=false,error='invalid_balance_record'}) end
if fromBefore < delta then return encode({ok=false,error='insufficient_balance',currentBalanceCents=fromBefore}) end
local fromAfter=fromBefore-delta; local toAfter=safeadd(toBefore,delta)
if not safeinteger(fromAfter) or not toAfter then return encode({ok=false,error='balance_out_of_range'}) end
local fromTx = decode(ARGV[3]); local toTx = decode(ARGV[4]); local fromAdmin = decode(ARGV[5]); local toAdmin = decode(ARGV[6])
if not fromTx or not toTx or not fromAdmin or not toAdmin or type(fromTx.transferId)~='string' then return encode({ok=false,error='invalid_ledger_record'}) end
local fromBalanceJson=persistedencode(fromAfter/100); local fromCentsJson=persistedencode(fromAfter)
local toBalanceJson=persistedencode(toAfter/100); local toCentsJson=persistedencode(toAfter)
local fromBeforeJson=persistedencode(fromBefore/100); local fromBeforeCentsJson=persistedencode(fromBefore)
local toBeforeJson=persistedencode(toBefore/100); local toBeforeCentsJson=persistedencode(toBefore)
local transferIdJson=persistedencode(fromTx.transferId)
if not fromBalanceJson or not fromCentsJson or not toBalanceJson or not toCentsJson or not fromBeforeJson or not fromBeforeCentsJson or not toBeforeJson or not toBeforeCentsJson or not transferIdJson then return redis.error_reply('money_json_encode_failed') end
local fromTxJson=appendobjectfields(ARGV[3],'"balanceAfter":'..fromBalanceJson..',"balanceAfterCents":'..fromCentsJson)
local toTxJson=appendobjectfields(ARGV[4],'"balanceAfter":'..toBalanceJson..',"balanceAfterCents":'..toCentsJson)
local fromAdminJson=appendobjectfields(ARGV[5],'"balanceBefore":'..fromBeforeJson..',"balanceBeforeCents":'..fromBeforeCentsJson..',"balanceAfter":'..fromBalanceJson..',"balanceAfterCents":'..fromCentsJson)
local toAdminJson=appendobjectfields(ARGV[6],'"balanceBefore":'..toBeforeJson..',"balanceBeforeCents":'..toBeforeCentsJson..',"balanceAfter":'..toBalanceJson..',"balanceAfterCents":'..toCentsJson)
local resultJson='{"ok":true,"balance":'..fromBalanceJson..',"balanceCents":'..fromCentsJson..',"recipientBalance":'..toBalanceJson..',"recipientBalanceCents":'..toCentsJson..',"transferId":'..transferIdJson..'}'
local operationJson=persistedencode({requestHash=ARGV[1],resultJson=resultJson})
if not fromTxJson or not toTxJson or not fromAdminJson or not toAdminJson or not decode(resultJson) or not operationJson then return redis.error_reply('money_json_encode_failed') end
redis.call('SET', KEYS[4], tostring(fromAfter)); redis.call('SET', KEYS[5], tostring(toAfter))
pushtrim(KEYS[8],fromTxJson,199); pushtrim(KEYS[9],toTxJson,199)
redis.call('LPUSH',KEYS[10],toAdminJson); redis.call('LPUSH',KEYS[10],fromAdminJson); redis.call('LTRIM',KEYS[10],'0','499')
redis.call('SET',KEYS[1],operationJson); return resultJson
`;

export async function transferBalanceAtomic(fromEmail, toEmail, amount, options = {}) {
  const from = normalizeEmail(fromEmail);
  const to = normalizeEmail(toEmail);
  const delta = cents(amount);
  if (!validEmail(from) || !validEmail(to) || from === to) return { ok: false, error: "invalid_recipient" };
  if (!Number.isSafeInteger(delta) || delta <= 0 || delta > 10_000_000) return { ok: false, error: "invalid_amount" };
  const authVersion = Number(options.authVersion);
  const accountLifecycleId = clean(options.accountLifecycleId, 80).toLowerCase();
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) return { ok: false, error: "session_state_changed" };
  if (!/^[a-f0-9]{32}$/.test(accountLifecycleId)) return { ok: false, error: "account_lifecycle_required" };
  const operationId = clean(options.operationId, 160) || makeId("TRQ");
  const transferId = makeId("TR");
  const now = new Date();
  const base = { transferId, createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now) };
  const fromTx = { ...base, id: makeId("TX"), amount: amountFromCents(-delta), amountCents: -delta, reason: "转账给 " + to, source: "transfer" };
  const toTx = { ...base, id: makeId("TX"), amount: amountFromCents(delta), amountCents: delta, reason: "收到 " + from + " 转账", source: "transfer" };
  const requestHash = sha(JSON.stringify({ from, to, delta, accountLifecycleId }));
  const opKey = operationKey("transfer:" + from + ":" + accountLifecycleId, operationId);
  return executeOperation({
    script: TRANSFER_SCRIPT,
    keys: [opKey, userKey(from), userKey(to), balanceCentsKey(from), balanceCentsKey(to), "lm:user:authver:" + from, accountLifecycleKey(from), transactionKey(from), transactionKey(to), ADMIN_BALANCE_LOG_KEY],
    args: [requestHash, delta, JSON.stringify(fromTx), JSON.stringify(toTx), JSON.stringify({ ...fromTx, email: from }), JSON.stringify({ ...toTx, email: to }), authVersion, accountLifecycleId],
    opKey,
    requestHash,
  });
}

const BALANCE_EFFECT_SCRIPT = LUA_COMMON + `
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'string') or not validtype(KEYS[4],'list') or not validtype(KEYS[5],'list') or not validtype(KEYS[6],'string') then return encode({ok=false,error='storage_type_error'}) end
local raw = redis.call('GET', KEYS[2])
if not raw then return encode({ok=false,error='account_lifecycle_changed'}) end
local user = decode(raw); if not user then return encode({ok=false,error='invalid_user_record'}) end
local expectedLifecycle=ARGV[9]
if not expectedLifecycle or #expectedLifecycle~=32 or string.match(expectedLifecycle,'[^a-f0-9]') then
  return encode({ok=false,error='account_lifecycle_required'})
end
local currentLifecycle=redis.call('GET',KEYS[6])
if not currentLifecycle or currentLifecycle~=expectedLifecycle then return encode({ok=false,error='account_lifecycle_changed'}) end
-- Identity must be checked before an old operation record is returned. A
-- deleted/re-registered email must never inherit a prior lifecycle's money.
local prior = existingop(KEYS[1], ARGV[1]); if prior then return prior end
if user.banned==true and ARGV[8]=='1' then
  local result={ok=true,skipped='account_banned',effectId=ARGV[6]}; saveop(KEYS[1],ARGV[1],result); return encode(result)
end
local before = readbalance(KEYS[3], user); if not before then return encode({ok=false,error='invalid_balance_record'}) end
local delta=tonumber(ARGV[2]); if not safeinteger(delta) or delta==0 then return encode({ok=false,error='invalid_amount'}) end
local after=safeadd(before,delta)
if not after then return encode({ok=false,error='balance_out_of_range'}) end
if ARGV[3] ~= '1' and after < 0 then return encode({ok=false,error='insufficient_balance',currentBalanceCents=before}) end
local tx = decode(ARGV[4]); local admin = decode(ARGV[5]); if not tx or not admin then return encode({ok=false,error='invalid_ledger_record'}) end
local referralDelta=tonumber(ARGV[7]) or 0
if not safeinteger(referralDelta) then return encode({ok=false,error='invalid_amount'}) end
local userJson=nil
if referralDelta~=0 then
  if raw~=ARGV[10] then return encode({ok=false,error='storage_conflict'}) end
  if type(user.referralStats)~='table' then user.referralStats={} end
  local total=tonumber(user.referralStats.totalCommission or 0) or 0
  user.referralStats.totalCommission=math.max(0,total+referralDelta/100)
  user.referralStats.lastCommissionAt=tx.createdAt
  userJson=ARGV[11]
  local nextUser=decode(userJson)
  if not nextUser or type(nextUser.referralStats)~='table'
    or tonumber(nextUser.referralStats.totalCommission or -1)~=user.referralStats.totalCommission
    or tostring(nextUser.referralStats.lastCommissionAt or '')~=tostring(tx.createdAt or '') then
    return encode({ok=false,error='invalid_user_record'})
  end
end
local afterJson=persistedencode(after/100); local afterCentsJson=persistedencode(after)
local beforeJson=persistedencode(before/100); local beforeCentsJson=persistedencode(before)
local effectIdJson=persistedencode(ARGV[6])
local txJson=afterJson and afterCentsJson and appendobjectfields(ARGV[4],'"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local adminJson=beforeJson and beforeCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[5],'"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local responseJson=txJson and effectIdJson and '{"ok":true,"balance":'..afterJson..',"balanceCents":'..afterCentsJson..',"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"transaction":'..txJson..',"effectId":'..effectIdJson..'}' or nil
local operationJson=responseJson and persistedencode({requestHash=ARGV[1],resultJson=responseJson}) or nil
if (referralDelta~=0 and not userJson) or not txJson or not adminJson or not responseJson or not decode(responseJson) or not operationJson then
  return redis.error_reply('money_json_encode_failed')
end
if userJson then redis.call('SET',KEYS[2],userJson) end
redis.call('SET', KEYS[3], tostring(after))
pushtrim(KEYS[4], txJson, 199); pushtrim(KEYS[5], adminJson, 499)
redis.call('SET',KEYS[1],operationJson); return responseJson
`;

export async function applyBalanceEffectAtomic({
  email, delta, effectId, operationId = "", reason = "余额变动", source = "system",
  allowNegative = false, orderId = "", withdrawalId = "", redeemCode = "",
  transferId = "", referralLevel = 0, staffId = 0, staffUsername = "", detail = null,
  referralCommissionDelta = 0,
  skipUnavailable = false,
  expectedAccountLifecycleId = "",
  idempotencyReason,
} = {}) {
  const lower = normalizeEmail(email);
  const deltaCents = cents(delta);
  const referralDeltaCents = cents(referralCommissionDelta);
  const stableEffectId = clean(effectId, 180);
  const accountLifecycleId = clean(expectedAccountLifecycleId, 80).toLowerCase();
  if (!validEmail(lower)) return { ok: false, error: "user_not_found" };
  if (!Number.isSafeInteger(deltaCents) || deltaCents === 0 || !Number.isSafeInteger(referralDeltaCents) || !stableEffectId) {
    return { ok: false, error: "invalid_amount" };
  }
  if (!/^[a-f0-9]{32}$/.test(accountLifecycleId)) return { ok: false, error: "account_lifecycle_required" };
  // The persisted transaction may include the first administrator's label,
  // but another authorised employee must be able to recover the same business
  // request. Only the stable reason participates in the idempotency hash.
  const stableReason = clean(idempotencyReason === undefined ? reason : idempotencyReason, 300);
  const requestHash = sha(JSON.stringify({
    lower, deltaCents, stableEffectId, source: clean(source, 60), reason: stableReason,
    orderId: clean(orderId, 80), withdrawalId: clean(withdrawalId, 80), redeemCode: normalizeCode(redeemCode),
    transferId: clean(transferId, 100), referralLevel: Number(referralLevel || 0),
    referralCommissionDeltaCents: referralDeltaCents,
    skipUnavailable: Boolean(skipUnavailable),
    accountLifecycleId,
  }));
  const now = new Date();
  const tx = {
    id: makeId("TX"), amount: amountFromCents(deltaCents), amountCents: deltaCents,
    reason: clean(reason, 300), source: clean(source, 60), effectId: stableEffectId,
    ...(orderId ? { orderId: clean(orderId, 80) } : {}),
    ...(withdrawalId ? { withdrawalId: clean(withdrawalId, 80) } : {}),
    ...(redeemCode ? { redeemCode: normalizeCode(redeemCode) } : {}),
    ...(transferId ? { transferId: clean(transferId, 100) } : {}),
    ...(referralLevel ? { referralLevel: Number(referralLevel) } : {}),
    ...(staffId ? { staffId: Number(staffId), staffUsername: clean(staffUsername, 60) } : {}),
    createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now),
  };
  const admin = { ...tx, email: lower, detail: detail && typeof detail === "object" ? detail : undefined };
  // The semantic effect itself is the idempotency boundary. A caller-supplied
  // request id must never make the same refund/commission payable twice. Keep
  // this key stable across account re-registration: the Lua script validates
  // the requested lifecycle before reading the old operation, while a changed
  // lifecycle remains bound in requestHash and can never execute the effect
  // again under a fresh operation key.
  const opKey = operationKey("effect:" + lower, stableEffectId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let expectedRaw = ""; let nextRaw = "";
    if (referralDeltaCents) {
      const read = await redisMoneyGet(userKey(lower));
      if (!read.ok) return { ok: false, error: read.error };
      if (!read.value) return { ok: false, error: "account_lifecycle_changed" };
      let current;
      try { current = JSON.parse(read.value); } catch { return { ok: false, error: "invalid_user_record" }; }
      const total = Math.max(0, Number(current?.referralStats?.totalCommission || 0) + amountFromCents(referralDeltaCents));
      expectedRaw = read.value;
      nextRaw = current?.referralStats && typeof current.referralStats === "object" && !Array.isArray(current.referralStats)
        ? losslessJsonPatch(read.value, [
          { path: ["referralStats", "totalCommission"], value: total },
          { path: ["referralStats", "lastCommissionAt"], value: tx.createdAt },
        ])
        : losslessTopLevelPatch(read.value, { referralStats: { totalCommission: total, lastCommissionAt: tx.createdAt } });
      if (!nextRaw) return { ok: false, error: "invalid_user_record" };
    }
    const result = await executeOperation({
      script: BALANCE_EFFECT_SCRIPT,
      keys: [opKey, userKey(lower), balanceCentsKey(lower), transactionKey(lower), ADMIN_BALANCE_LOG_KEY, accountLifecycleKey(lower)],
      args: [requestHash, deltaCents, allowNegative ? "1" : "0", JSON.stringify(tx), JSON.stringify(admin), stableEffectId, referralDeltaCents, skipUnavailable ? "1" : "0", accountLifecycleId, expectedRaw, nextRaw],
      opKey,
      requestHash,
    });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const REDEEM_BALANCE_SCRIPT = LUA_COMMON + `
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'string') or not validtype(KEYS[4],'string') or not validtype(KEYS[5],'string') or not validtype(KEYS[6],'string') or not validtype(KEYS[7],'list') or not validtype(KEYS[8],'list') then return encode({ok=false,error='storage_type_error'}) end
local userRaw = redis.call('GET',KEYS[2])
if not userRaw then return encode({ok=false,error='session_state_changed'}) end
local user = decode(userRaw); if not user then return encode({ok=false,error='invalid_storage_record'}) end
if user.banned then return encode({ok=false,error='account_banned'}) end
local versionRaw=redis.call('GET',KEYS[5])
if versionRaw and not string.match(versionRaw,'^%d+$') then return encode({ok=false,error='invalid_auth_version'}) end
local currentVersion=versionRaw and tonumber(versionRaw) or 1
local expectedVersion=tonumber(ARGV[6] or '0')
if not currentVersion or currentVersion<1 or currentVersion~=math.floor(currentVersion) or currentVersion>9007199254740990 or not expectedVersion or expectedVersion<1 or expectedVersion~=math.floor(expectedVersion) or currentVersion~=expectedVersion then
  return encode({ok=false,error='session_state_changed'})
end
local currentLifecycle=redis.call('GET',KEYS[6])
if not currentLifecycle or currentLifecycle~=ARGV[7] then return encode({ok=false,error='account_lifecycle_changed'}) end
local prior = existingop(KEYS[1],ARGV[1]); if prior then return prior end
local codeRaw = redis.call('GET',KEYS[4])
if not codeRaw then return encode({ok=false,error='code_not_found'}) end
if codeRaw~=ARGV[8] then return encode({ok=false,error='storage_conflict'}) end
local code = decode(codeRaw); if not code then return encode({ok=false,error='invalid_storage_record'}) end
if code.status ~= 'active' then return encode({ok=false,error='code_unavailable'}) end
if code.type == 'service' or code.kind == 'service' or (type(code.services)=='table' and #code.services>0) then return encode({ok=false,error='service_code_checkout_required'}) end
local value=tonumber(code.amount or 0); local delta=value and math.floor(value*100+0.5) or nil
if not safeinteger(delta) or delta<=0 then return encode({ok=false,error='invalid_amount'}) end
local before=readbalance(KEYS[3],user); if not before then return encode({ok=false,error='invalid_balance_record'}) end
local after=safeadd(before,delta); if not after then return encode({ok=false,error='balance_out_of_range'}) end
local metadata=decode(ARGV[2]); local tx=decode(ARGV[3]); local admin=decode(ARGV[4]); if not metadata or not tx or not admin then return encode({ok=false,error='invalid_ledger_record'}) end
local amountJson=persistedencode(delta/100); local amountCentsJson=persistedencode(delta)
local beforeJson=persistedencode(before/100); local beforeCentsJson=persistedencode(before)
local afterJson=persistedencode(after/100); local afterCentsJson=persistedencode(after)
local codeJson=persistedencode(code.code or ARGV[5])
local txJson=amountJson and amountCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[3],'"amount":'..amountJson..',"amountCents":'..amountCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local adminJson=amountJson and amountCentsJson and beforeJson and beforeCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[4],'"amount":'..amountJson..',"amountCents":'..amountCentsJson..',"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local nextCode=decode(ARGV[9])
if not nextCode or tostring(nextCode.status or '')~='used' or tostring(nextCode.usedOperationId or '')~=tostring(metadata.usedOperationId or '')
  or not txJson or not adminJson then return encode({ok=false,error='invalid_storage_record'}) end
local resultJson='{"ok":true,"balance":'..afterJson..',"balanceCents":'..afterCentsJson..',"amount":'..amountJson..',"amountCents":'..amountCentsJson..',"code":'..codeJson..'}'
local operationJson=persistedencode({requestHash=ARGV[1],resultJson=resultJson})
if not codeJson or not decode(resultJson) or not operationJson then return redis.error_reply('money_json_encode_failed') end
redis.call('SET',KEYS[3],tostring(after)); redis.call('SET',KEYS[4],ARGV[9])
pushtrim(KEYS[7],txJson,199); pushtrim(KEYS[8],adminJson,499)
redis.call('SET',KEYS[1],operationJson); return resultJson
`;

export async function redeemBalanceCodeAtomic(email, codeValue, meta = {}, options = {}) {
  const lower = normalizeEmail(email);
  const code = normalizeCode(codeValue);
  if (!validEmail(lower)) return { ok: false, error: "user_not_found" };
  if (!code) return { ok: false, error: "code_not_found" };
  const authVersion = Number(options.authVersion);
  const accountLifecycleId = clean(options.accountLifecycleId, 80).toLowerCase();
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) return { ok: false, error: "session_state_changed" };
  if (!/^[a-f0-9]{32}$/.test(accountLifecycleId)) return { ok: false, error: "account_lifecycle_required" };
  const operationId = clean(options.operationId, 160) || makeId("RDQ");
  const requestHash = sha(JSON.stringify({ lower, code, accountLifecycleId }));
  const now = new Date();
  const txId = makeId("TX");
  const usedMeta = {
    usedBy: lower, usedIp: clean(meta.ip, 80), usedUserAgent: clean(meta.userAgent, 500),
    usedAt: now.toISOString(), usedAtBeijing: formatBeijingTime(now), usedOperationId: operationId, redeemTxId: txId,
  };
  const tx = { id: txId, reason: "兑换码充值 " + code, source: "redeem", redeemCode: code, operationId, createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now) };
  const opKey = operationKey("redeem-balance:" + lower + ":" + accountLifecycleId, operationId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await redisMoneyGet(redeemCodeKey(code));
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.value) return { ok: false, error: "code_not_found" };
    const nextRaw = losslessTopLevelPatch(read.value, { ...usedMeta, status: "used" });
    if (!nextRaw) return { ok: false, error: "invalid_storage_record" };
    const result = await executeOperation({
      script: REDEEM_BALANCE_SCRIPT,
      keys: [opKey, userKey(lower), balanceCentsKey(lower), redeemCodeKey(code), "lm:user:authver:" + lower, accountLifecycleKey(lower), transactionKey(lower), ADMIN_BALANCE_LOG_KEY],
      args: [requestHash, JSON.stringify(usedMeta), JSON.stringify(tx), JSON.stringify({ ...tx, email: lower }), code, authVersion, accountLifecycleId, read.value, nextRaw],
      opKey,
      requestHash,
    });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const SERVICE_CODE_SCRIPT = LUA_COMMON + `
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') then return encode({ok=false,error='storage_type_error'}) end
local raw=redis.call('GET',KEYS[2]); if not raw then return encode({ok=false,error='code_not_found'}) end
if raw~=ARGV[3] then return encode({ok=false,error='storage_conflict'}) end
local code=decode(raw); if not code then return encode({ok=false,error='invalid_code_record'}) end
if code.status~='active' then return encode({ok=false,error='code_unavailable'}) end
if code.type~='service' and code.kind~='service' and not (type(code.services)=='table' and #code.services>0) then return encode({ok=false,error='not_service_code'}) end
local metadata=decode(ARGV[2]); if not metadata then return encode({ok=false,error='invalid_metadata'}) end
for key,value in pairs(metadata) do code[key]=value end
code.type='service'; code.status='used'
local nextCode=decode(ARGV[4]); local result=decode(ARGV[5])
if not nextCode or tostring(nextCode.type or '')~='service' or tostring(nextCode.status or '')~='used'
  or tostring(nextCode.usedOrderId or '')~=tostring(metadata.usedOrderId or '') or not result then return encode({ok=false,error='invalid_code_record'}) end
redis.call('SET',KEYS[2],ARGV[4]); saveopjson(KEYS[1],ARGV[1],ARGV[5]); return ARGV[5]
`;

export async function consumeServiceCodeAtomic(codeValue, email, orderId, meta = {}, options = {}) {
  const code = normalizeCode(codeValue);
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!code || !normalizedOrderId) return { ok: false, error: "code_unavailable" };
  const operationId = clean(options.operationId, 160) || makeId("RSQ");
  const requestHash = sha(JSON.stringify({ code, email: normalizeEmail(email), orderId: normalizedOrderId }));
  const now = new Date();
  const metadata = {
    usedBy: clean(email, 200), usedOrderId: normalizedOrderId, usedIp: clean(meta.ip, 80), usedUserAgent: clean(meta.userAgent, 500),
    usedAt: now.toISOString(), usedAtBeijing: formatBeijingTime(now), usedOperationId: operationId,
  };
  const opKey = operationKey("redeem-service:" + code + ":" + normalizedOrderId, operationId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await redisMoneyGet(redeemCodeKey(code));
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.value) return { ok: false, error: "code_not_found" };
    const nextRaw = losslessTopLevelPatch(read.value, { ...metadata, type: "service", status: "used" });
    if (!nextRaw) return { ok: false, error: "invalid_code_record" };
    const resultJson = `{"ok":true,"code":${nextRaw}}`;
    const result = await executeOperation({ script: SERVICE_CODE_SCRIPT, keys: [opKey, redeemCodeKey(code)], args: [requestHash, JSON.stringify(metadata), read.value, nextRaw, resultJson], opKey, requestHash });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const RESTORE_SERVICE_CODE_SCRIPT = LUA_COMMON + `
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') then return encode({ok=false,error='storage_type_error'}) end
local raw=redis.call('GET',KEYS[2]); if not raw then return encode({ok=false,error='code_not_found'}) end
if raw~=ARGV[3] then return encode({ok=false,error='storage_conflict'}) end
local code=decode(raw); if not code then return encode({ok=false,error='invalid_code_record'}) end
if code.status~='used' or tostring(code.usedOrderId or '')~=ARGV[2] then return encode({ok=false,error='code_owner_mismatch'}) end
local nextCode=decode(ARGV[4]); local result=decode(ARGV[5])
if not nextCode or tostring(nextCode.status or '')~='active' or nextCode.usedOrderId~=nil or not result then return encode({ok=false,error='invalid_code_record'}) end
redis.call('SET',KEYS[2],ARGV[4]); saveopjson(KEYS[1],ARGV[1],ARGV[5]); return ARGV[5]
`;

export async function restoreServiceCodeAtomic(codeValue, orderId, options = {}) {
  const code = normalizeCode(codeValue);
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!code || !normalizedOrderId) return { ok: false, error: "code_owner_mismatch" };
  const operationId = clean(options.operationId, 160) || `restore:${code}:${normalizedOrderId}`;
  const requestHash = sha(JSON.stringify({ code, orderId: normalizedOrderId }));
  const opKey = operationKey("restore-service:" + code + ":" + normalizedOrderId, operationId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await redisMoneyGet(redeemCodeKey(code));
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.value) return { ok: false, error: "code_not_found" };
    const nextRaw = losslessTopLevelPatch(read.value, { status: "active" }, ["usedBy", "usedOrderId", "usedIp", "usedUserAgent", "usedAt", "usedAtBeijing", "usedOperationId"]);
    if (!nextRaw) return { ok: false, error: "invalid_code_record" };
    const resultJson = `{"ok":true,"restored":true,"code":${nextRaw}}`;
    const result = await executeOperation({ script: RESTORE_SERVICE_CODE_SCRIPT, keys: [opKey, redeemCodeKey(code)], args: [requestHash, normalizedOrderId, read.value, nextRaw, resultJson], opKey, requestHash });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const TRANSITION_COUPON_SCRIPT = LUA_COMMON + `
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'string') or not validtype(KEYS[4],'string') then return encode({ok=false,error='storage_type_error'}) end
local raw=redis.call('GET',KEYS[2]); if not raw then return encode({ok=false,error='user_not_found'}) end
local user=decode(raw); if not user or type(user.coupons)~='table' then return encode({ok=false,error='coupon_not_found'}) end
local expectedLifecycle=ARGV[7]
if not expectedLifecycle or #expectedLifecycle~=32 or string.match(expectedLifecycle,'[^a-f0-9]') then return encode({ok=false,error='account_lifecycle_required'}) end
local currentLifecycle=redis.call('GET',KEYS[4])
if not currentLifecycle or currentLifecycle~=expectedLifecycle then return encode({ok=false,error='account_lifecycle_changed'}) end
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if raw~=ARGV[8] then return encode({ok=false,error='storage_conflict'}) end
local coupon=nil; for _,item in ipairs(user.coupons) do if tostring(item.id or '')==ARGV[2] then coupon=item; break end end
if not coupon then return encode({ok=false,error='coupon_not_found'}) end
local target=ARGV[4]; local changed=false
if target=='active' then
  if coupon.status=='used' and tostring(coupon.usedOrderId or '')==ARGV[3] then
    coupon.status='active'; coupon.usedOrderId=nil; coupon.discount=nil; coupon.usedAt=nil; coupon.usedAtBeijing=nil; changed=true
  elseif coupon.status~='active' then return encode({ok=false,error='coupon_owner_mismatch'}) end
elseif target=='used' then
  if coupon.status=='active' then
    coupon.status='used'; coupon.usedOrderId=ARGV[3]; coupon.usedAt=ARGV[5]; coupon.usedAtBeijing=ARGV[6]; changed=true
  elseif coupon.status~='used' or tostring(coupon.usedOrderId or '')~=ARGV[3] then return encode({ok=false,error='coupon_unavailable'}) end
else return encode({ok=false,error='invalid_coupon_transition'}) end
local balance=readbalance(KEYS[3],user); if not balance then return encode({ok=false,error='invalid_balance_record'}) end
local nextUser=decode(ARGV[9]); local response=decode(ARGV[10])
if not nextUser or not response or response.changed~=changed then return encode({ok=false,error='invalid_user_record'}) end
redis.call('SET',KEYS[3],tostring(balance)); redis.call('SET',KEYS[2],ARGV[9])
saveopjson(KEYS[1],ARGV[1],ARGV[10]); return ARGV[10]
`;

export async function transitionOrderCouponAtomic(email, couponId, orderId, target, effectId, expectedAccountLifecycleId = "") {
  const lower = normalizeEmail(email);
  const id = clean(couponId, 100);
  const normalizedOrderId = normalizeOrderId(orderId);
  const next = target === "active" ? "active" : target === "used" ? "used" : "";
  const stableEffectId = clean(effectId, 180);
  const accountLifecycleId = clean(expectedAccountLifecycleId, 80).toLowerCase();
  if (!validEmail(lower) || !id || !normalizedOrderId || !next || !stableEffectId) return { ok: false, error: "invalid_coupon_transition" };
  if (!/^[a-f0-9]{32}$/.test(accountLifecycleId)) return { ok: false, error: "account_lifecycle_required" };
  const requestHash = sha(JSON.stringify({ lower, id, normalizedOrderId, next, accountLifecycleId }));
  const opKey = operationKey("coupon-effect:" + lower + ":" + accountLifecycleId + ":" + id, stableEffectId);
  const now = new Date();
  const usedAt = now.toISOString(); const usedAtBeijing = formatBeijingTime(now);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await redisMoneyGet(userKey(lower));
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.value) return { ok: false, error: "user_not_found" };
    let current;
    try { current = JSON.parse(read.value); } catch { return { ok: false, error: "invalid_user_record" }; }
    const index = Array.isArray(current?.coupons) ? current.coupons.findIndex((item) => String(item?.id || "") === id) : -1;
    if (index < 0) return { ok: false, error: "coupon_not_found" };
    const coupon = current.coupons[index];
    let changed = false; const operations = [];
    if (next === "used") {
      if (coupon.status === "active") {
        changed = true;
        operations.push(
          { path: ["coupons", index, "status"], value: "used" },
          { path: ["coupons", index, "usedOrderId"], value: normalizedOrderId },
          { path: ["coupons", index, "usedAt"], value: usedAt },
          { path: ["coupons", index, "usedAtBeijing"], value: usedAtBeijing },
        );
      }
    } else if (coupon.status === "used" && String(coupon.usedOrderId || "") === normalizedOrderId) {
      changed = true;
      operations.push(
        { path: ["coupons", index, "status"], value: "active" },
        ...["usedOrderId", "discount", "usedAt", "usedAtBeijing"].map((field) => ({ path: ["coupons", index, field], value: LOSSLESS_DELETE })),
      );
    }
    const nextRaw = operations.length ? losslessJsonPatch(read.value, operations) : read.value;
    if (!nextRaw) return { ok: false, error: "invalid_user_record" };
    const couponRaw = losslessJsonValue(nextRaw, ["coupons", index]);
    if (!couponRaw) return { ok: false, error: "invalid_user_record" };
    const resultJson = `{"ok":true,"changed":${changed},"coupon":${couponRaw}}`;
    const result = await executeOperation({
      script: TRANSITION_COUPON_SCRIPT,
      keys: [opKey, userKey(lower), balanceCentsKey(lower), accountLifecycleKey(lower)],
      args: [requestHash, id, normalizedOrderId, next, usedAt, usedAtBeijing, accountLifecycleId, read.value, nextRaw, resultJson],
      opKey,
      requestHash,
    });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const ADJUST_STOCK_EFFECT_SCRIPT = LUA_COMMON + `
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') then return encode({ok=false,error='storage_type_error'}) end
local raw=redis.call('GET',KEYS[2]); local delta=tonumber(ARGV[2])
if not delta or delta==0 or delta~=math.floor(delta) then return encode({ok=false,error='invalid_amount'}) end
if not raw then local result={ok=true,unlimited=true,changed=false}; saveop(KEYS[1],ARGV[1],result); return encode(result) end
local before=tonumber(raw); if not before or before~=math.floor(before) or before<0 or before>9007199254740991 then return encode({ok=false,error='invalid_stock_record'}) end
local after=before+delta; if after<0 then return encode({ok=false,error='out_of_stock',remaining=before}) end
if after>9007199254740991 then return encode({ok=false,error='invalid_stock_record'}) end
redis.call('SET',KEYS[2],tostring(after))
local result={ok=true,changed=true,remaining=after,before=before,after=after,changes={{service=ARGV[3],plan=ARGV[4],before=before,after=after,delta=delta}}}
saveop(KEYS[1],ARGV[1],result); return encode(result)
`;

export async function adjustStockEffectAtomic(service, plan, delta, effectId) {
  const product = clean(service, 40);
  const planId = clean(plan, 40);
  const count = Number(delta);
  const stableEffectId = clean(effectId, 180);
  if (!product || !Number.isSafeInteger(count) || count === 0 || !stableEffectId) return { ok: false, error: "invalid_stock_effect" };
  const requestHash = sha(JSON.stringify({ product, planId, count }));
  const opKey = operationKey("stock-effect:" + product + ":" + planId, stableEffectId);
  return executeOperation({
    script: ADJUST_STOCK_EFFECT_SCRIPT,
    keys: [opKey, stockKey(product, planId)],
    args: [requestHash, count, product, planId],
    opKey,
    requestHash,
  });
}

const ADJUST_STOCK_BATCH_EFFECT_SCRIPT = LUA_COMMON + `
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if not validtype(KEYS[1],'string') then return encode({ok=false,error='storage_type_error',keyIndex=1}) end
local specs=decode(ARGV[2]); if not specs then return encode({ok=false,error='invalid_stock_effect'}) end
local changes={}; local limited={}
for _,spec in ipairs(specs) do
  local slot=tonumber(spec.slot); local delta=tonumber(spec.delta); local name=tostring(spec.name or '')
  if not slot or slot<2 or slot>#KEYS or not delta or delta==0 or delta~=math.floor(delta) or name=='' then
    return encode({ok=false,error='invalid_stock_effect'})
  end
  if not validtype(KEYS[slot],'string') then return encode({ok=false,error='storage_type_error',keyIndex=slot}) end
  local raw=redis.call('GET',KEYS[slot])
  if raw then
    local before=tonumber(raw)
    if not before or before~=math.floor(before) or before<0 or before>9007199254740991 then return encode({ok=false,error='invalid_stock_record',name=name}) end
    local after=before+delta
    if after<0 then return encode({ok=false,error='out_of_stock',name=name,remaining=before}) end
    if after>9007199254740991 then return encode({ok=false,error='invalid_stock_record',name=name}) end
    table.insert(changes,{slot=slot,before=before,after=after,delta=delta,name=name,service=tostring(spec.service or ''),plan=tostring(spec.plan or '')}); limited[name]=true
  end
end
for _,change in ipairs(changes) do redis.call('SET',KEYS[change.slot],tostring(change.after)) end
local result={ok=true,changedCount=#changes,limited=limited,changes=changes}; saveop(KEYS[1],ARGV[1],result); return encode(result)
`;

export async function adjustStockBatchEffectAtomic(adjustments, effectId) {
  const stableEffectId = clean(effectId, 180);
  const grouped = new Map();
  for (const item of Array.isArray(adjustments) ? adjustments : []) {
    const product = clean(item?.service, 40);
    const planId = clean(item?.plan, 40);
    const delta = Number(item?.delta);
    if (!product || !Number.isSafeInteger(delta) || delta === 0) return { ok: false, error: "invalid_stock_effect" };
    const name = product + ":" + planId;
    const current = grouped.get(name) || { service: product, plan: planId, delta: 0, name };
    current.delta += delta;
    if (!Number.isSafeInteger(current.delta) || current.delta === 0) return { ok: false, error: "invalid_stock_effect" };
    grouped.set(name, current);
  }
  if (!stableEffectId || grouped.size === 0) return { ok: false, error: "invalid_stock_effect" };
  const keys = [operationKey("stock-batch", stableEffectId)];
  const specs = [];
  for (const item of grouped.values()) {
    keys.push(stockKey(item.service, item.plan));
    specs.push({ ...item, slot: keys.length });
  }
  const requestHash = sha(stableJson(specs.map(({ service, plan, delta, name }) => ({ service, plan, delta, name }))));
  const opKey = keys[0];
  return executeOperation({
    script: ADJUST_STOCK_BATCH_EFFECT_SCRIPT,
    keys,
    args: [requestHash, JSON.stringify(specs)],
    opKey,
    requestHash,
  });
}

const CREATE_WITHDRAWAL_SCRIPT = LUA_COMMON + `
local expected={'string','string','string','string','string','string','list','list','list'}
for index,key in ipairs(KEYS) do if not validtype(key,expected[index]) then return encode({ok=false,error='storage_type_error'}) end end
local raw=redis.call('GET',KEYS[2]); if not raw then return encode({ok=false,error='session_state_changed'}) end
local user=decode(raw); if not user then return encode({ok=false,error='invalid_user_record'}) end
if user.banned then return encode({ok=false,error='account_banned'}) end
local versionRaw=redis.call('GET',KEYS[4])
if versionRaw and not string.match(versionRaw,'^%d+$') then return encode({ok=false,error='invalid_auth_version'}) end
local currentVersion=versionRaw and tonumber(versionRaw) or 1
local expectedVersion=tonumber(ARGV[6] or '0')
if not currentVersion or currentVersion<1 or currentVersion~=math.floor(currentVersion) or currentVersion>9007199254740990 or not expectedVersion or expectedVersion<1 or expectedVersion~=math.floor(expectedVersion) or currentVersion~=expectedVersion then
  return encode({ok=false,error='session_state_changed'})
end
local currentLifecycle=redis.call('GET',KEYS[5])
if not currentLifecycle or currentLifecycle~=ARGV[7] then return encode({ok=false,error='account_lifecycle_changed'}) end
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if redis.call('EXISTS',KEYS[6])==1 then return encode({ok=false,error='withdrawal_exists'}) end
local before=readbalance(KEYS[3],user); local delta=tonumber(ARGV[2]); if not before or not safeinteger(delta) or delta<=0 then return encode({ok=false,error='invalid_amount'}) end
if before<delta then return encode({ok=false,error='insufficient_balance',currentBalanceCents=before}) end
-- withdrawal.username
local after=before-delta; local withdrawal=decode(ARGV[3]); local tx=decode(ARGV[4]); local admin=decode(ARGV[5]); if not withdrawal or not tx or not admin then return encode({ok=false,error='invalid_record'}) end
local usernameJson=persistedencode(tostring(user.username or ''))
local afterJson=persistedencode(after/100); local afterCentsJson=persistedencode(after)
local beforeJson=persistedencode(before/100); local beforeCentsJson=persistedencode(before)
local withdrawalJson=usernameJson and appendobjectfields(ARGV[3],'"username":'..usernameJson) or nil
local txJson=afterJson and afterCentsJson and appendobjectfields(ARGV[4],'"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local adminJson=beforeJson and beforeCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[5],'"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
local resultJson=withdrawalJson and '{"ok":true,"balance":'..afterJson..',"balanceCents":'..afterCentsJson..',"withdrawal":'..withdrawalJson..'}' or nil
local operationJson=resultJson and persistedencode({requestHash=ARGV[1],resultJson=resultJson}) or nil
if not withdrawalJson or not txJson or not adminJson or not resultJson or not decode(resultJson) or not operationJson then return redis.error_reply('money_json_encode_failed') end
redis.call('SET',KEYS[3],tostring(after)); redis.call('SET',KEYS[6],withdrawalJson)
redis.call('LPUSH',KEYS[7],withdrawal.id); pushtrim(KEYS[8],txJson,199); pushtrim(KEYS[9],adminJson,499)
redis.call('SET',KEYS[1],operationJson); return resultJson
`;

export async function createWithdrawalAtomic(email, amount, alipayAccount, realName, options = {}) {
  const lower = normalizeEmail(email);
  const valueCents = cents(amount);
  const alipay = clean(alipayAccount, 160);
  const name = clean(realName, 80);
  if (!validEmail(lower)) return { ok: false, error: "user_not_found" };
  if (!Number.isSafeInteger(valueCents) || valueCents <= 0 || valueCents > 10_000_000 || !alipay || !name) return { ok: false, error: "missing_required_fields" };
  const authVersion = Number(options.authVersion);
  const accountLifecycleId = clean(options.accountLifecycleId, 80).toLowerCase();
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) return { ok: false, error: "session_state_changed" };
  if (!/^[a-f0-9]{32}$/.test(accountLifecycleId)) return { ok: false, error: "account_lifecycle_required" };
  const operationId = clean(options.operationId, 160) || makeId("WDQ");
  const requestHash = sha(JSON.stringify({ lower, valueCents, alipay, name, accountLifecycleId }));
  const withdrawalId = makeId("WD");
  const txId = makeId("TX");
  const now = new Date();
  const withdrawal = {
    id: withdrawalId, userEmail: lower, amount: amountFromCents(valueCents), amountCents: valueCents,
    accountLifecycleId,
    alipayAccount: alipay, realName: name, status: "pending", statusLabel: "待审核", revision: 1, operationId, txId,
    createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now), updatedAt: now.toISOString(), updatedAtBeijing: formatBeijingTime(now),
  };
  const tx = {
    id: txId, amount: amountFromCents(-valueCents), amountCents: -valueCents, reason: "提现申请", source: "withdrawal", withdrawalId,
    status: "pending", statusLabel: "待审核", operationId, createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now),
  };
  const opKey = operationKey("withdraw-create:" + lower + ":" + accountLifecycleId, operationId);
  return executeOperation({
    script: CREATE_WITHDRAWAL_SCRIPT,
    keys: [opKey, userKey(lower), balanceCentsKey(lower), "lm:user:authver:" + lower, accountLifecycleKey(lower), withdrawalKey(withdrawalId), WITHDRAWAL_LIST_KEY, transactionKey(lower), ADMIN_BALANCE_LOG_KEY],
    args: [requestHash, valueCents, JSON.stringify(withdrawal), JSON.stringify(tx), JSON.stringify({ ...tx, email: lower }), authVersion, accountLifecycleId],
    opKey,
    requestHash,
  });
}

const TRANSITION_WITHDRAWAL_SCRIPT = LUA_COMMON + `
local expected={'string','string','string','string','list','list','string'}
for index,key in ipairs(KEYS) do if not validtype(key,expected[index]) then return encode({ok=false,error='storage_type_error'}) end end
local withdrawalRaw=redis.call('GET',KEYS[4]); if not withdrawalRaw then return encode({ok=false,error='withdrawal_not_found'}) end
local withdrawal=decode(withdrawalRaw); if not withdrawal then return encode({ok=false,error='invalid_withdrawal_record'}) end
if withdrawal.archived==true then return encode({ok=false,error='withdrawal_archived',withdrawal=withdrawal}) end
local currentRevision=tonumber(withdrawal.revision or 0) or 0; local expectedRevision=tonumber(ARGV[2]) or -1
local old=tostring(withdrawal.status or 'pending'); local next=tostring(ARGV[3])
local allowed=(old=='pending' and (next=='processing' or next=='success' or next=='failed')) or (old=='processing' and (next=='success' or next=='failed')) or (old=='failed' and (next=='pending' or next=='processing'))
local delta=0; local amount=tonumber(withdrawal.amountCents) or math.floor((tonumber(withdrawal.amount or 0) or 0)*100+0.5)
if old~='failed' and next=='failed' then delta=amount elseif old=='failed' and next~='failed' then delta=-amount end
if delta~=0 then
  if not amount or amount<=0 or amount~=math.floor(amount) or amount>9007199254740991 then return encode({ok=false,error='invalid_withdrawal_record'}) end
  local expectedLifecycle=tostring(withdrawal.accountLifecycleId or '')
  if #expectedLifecycle~=32 or string.match(expectedLifecycle,'[^a-f0-9]') then
    return encode({ok=false,error='account_lifecycle_required',manualReview=true})
  end
  local currentLifecycle=redis.call('GET',KEYS[7])
  if not currentLifecycle or currentLifecycle~=expectedLifecycle then
    return encode({ok=false,error='account_lifecycle_changed',manualReview=true})
  end
end
-- A transition that can move money validates ownership before an earlier
-- idempotent result can be returned to a replacement account.
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if withdrawalRaw~=ARGV[9] then return encode({ok=false,error='storage_conflict'}) end
if expectedRevision>=0 and expectedRevision~=currentRevision then return encode({ok=false,error='stale_revision',currentRevision=currentRevision,withdrawal=withdrawal}) end
local oldJson=persistedencode(old); local nextJson=persistedencode(next)
if not oldJson or not nextJson then return redis.error_reply('money_json_encode_failed') end
if old==next then
  local responseJson='{"ok":true,"changed":false,"from":'..oldJson..',"to":'..nextJson..',"balance":null,"withdrawal":'..withdrawalRaw..'}'
  local operationJson=persistedencode({requestHash=ARGV[1],resultJson=responseJson})
  if not decode(responseJson) or not operationJson then return redis.error_reply('money_json_encode_failed') end
  redis.call('SET',KEYS[1],operationJson); return responseJson
end
if not allowed then return encode({ok=false,error='invalid_transition',from=old,to=next}) end
local metadata=decode(ARGV[6]); local nextWithdrawal=decode(ARGV[10])
if not metadata or not nextWithdrawal or tostring(nextWithdrawal.status or '')~=next
  or tonumber(nextWithdrawal.revision or -1)~=currentRevision+1 then return encode({ok=false,error='invalid_withdrawal_record'}) end
local balance=nil; local before=nil; local after=nil; local txJson=nil; local adminJson=nil
if delta~=0 then
  local userRaw=redis.call('GET',KEYS[2]); if not userRaw then return encode({ok=false,error='user_not_found'}) end
  local user=decode(userRaw); if not user then return encode({ok=false,error='invalid_user_record'}) end
  before=readbalance(KEYS[3],user); if not before then return encode({ok=false,error='invalid_balance_record'}) end
  after=safeadd(before,delta)
  if not after then return encode({ok=false,error='balance_out_of_range'}) end
  if after<0 then return encode({ok=false,error='insufficient_balance',currentBalanceCents=before}) end
  local tx=decode(ARGV[7]); local admin=decode(ARGV[8]); if not tx or not admin then return encode({ok=false,error='invalid_ledger_record'}) end
  local amountJson=persistedencode(delta/100); local amountCentsJson=persistedencode(delta)
  local beforeJson=persistedencode(before/100); local beforeCentsJson=persistedencode(before)
  local afterJson=persistedencode(after/100); local afterCentsJson=persistedencode(after)
  local statusLabelJson=persistedencode(ARGV[4])
  txJson=amountJson and amountCentsJson and afterJson and afterCentsJson and statusLabelJson and appendobjectfields(ARGV[7],'"amount":'..amountJson..',"amountCents":'..amountCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson..',"status":'..nextJson..',"statusLabel":'..statusLabelJson) or nil
  adminJson=amountJson and amountCentsJson and beforeJson and beforeCentsJson and afterJson and afterCentsJson and statusLabelJson and appendobjectfields(ARGV[8],'"amount":'..amountJson..',"amountCents":'..amountCentsJson..',"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson..',"status":'..nextJson..',"statusLabel":'..statusLabelJson) or nil
  if not txJson or not adminJson then return redis.error_reply('money_json_encode_failed') end
  balance=after/100
end
local balanceJson=balance~=nil and persistedencode(balance) or 'null'
if not oldJson or not nextJson or not balanceJson then return redis.error_reply('money_json_encode_failed') end
local responseJson='{"ok":true,"changed":true,"from":'..oldJson..',"to":'..nextJson..',"balance":'..balanceJson..',"withdrawal":'..ARGV[10]..'}'
if not decode(responseJson) then return redis.error_reply('money_json_encode_failed') end
local operationJson=persistedencode({requestHash=ARGV[1],resultJson=responseJson})
if not operationJson then return redis.error_reply('money_json_encode_failed') end
if delta~=0 then
  redis.call('SET',KEYS[3],tostring(after)); pushtrim(KEYS[5],txJson,199); pushtrim(KEYS[6],adminJson,499)
end
redis.call('SET',KEYS[4],ARGV[10]); redis.call('SET',KEYS[1],operationJson); return responseJson
`;

const WITHDRAWAL_LABELS = { pending: "待审核", processing: "提现中", success: "提现成功", failed: "审核失败" };

export async function transitionWithdrawalAtomic(id, status, note = "", actor = null, options = {}) {
  const withdrawalId = clean(id, 80);
  const nextStatus = clean(status, 30);
  if (!withdrawalId) return { ok: false, error: "withdrawal_not_found" };
  if (!WITHDRAWAL_LABELS[nextStatus]) return { ok: false, error: "invalid_status" };
  const detail = await redisMoneyGet(withdrawalKey(withdrawalId));
  if (!detail.ok) return { ok: false, error: detail.error };
  if (!detail.value) return { ok: false, error: "withdrawal_not_found" };
  let current;
  try { current = JSON.parse(detail.value); } catch { return { ok: false, error: "invalid_withdrawal_record" }; }
  if (current?.archived === true) return { ok: false, error: "withdrawal_archived", withdrawal: current };
  const email = normalizeEmail(current.userEmail);
  if (!validEmail(email)) return { ok: false, error: "user_not_found" };
  const expectedRevision = options.expectedRevision == null
    ? Number(current.revision || 0)
    : Number(options.expectedRevision);
  const operationId = clean(options.operationId, 160)
    || `withdrawal:${withdrawalId}:revision:${expectedRevision}`;
  const withdrawalLifecycleId = clean(current.accountLifecycleId, 80).toLowerCase();
  const requestHash = sha(JSON.stringify({
    withdrawalId,
    nextStatus,
    note: clean(note, 400),
    accountLifecycleId: withdrawalLifecycleId,
  }));
  const now = new Date();
  const metadata = {
    updatedAt: now.toISOString(), updatedAtBeijing: formatBeijingTime(now),
    ...(actor ? { updatedByStaffId: Number(actor.staffId || 1), updatedByStaffUsername: clean(actor.staffUsername || "admin", 60) } : {}),
  };
  const tx = {
    id: makeId("TX"), reason: nextStatus === "failed" ? "提现审核失败退回" : "提现重新审核冻结", source: "withdrawal", withdrawalId,
    operationId, createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now),
    ...(actor ? { staffId: Number(actor.staffId || 1), staffUsername: clean(actor.staffUsername || "admin", 60) } : {}),
  };
  const opKey = operationKey("withdraw-transition:" + withdrawalId, operationId);
  const nextRaw = losslessTopLevelPatch(detail.value, {
    status: nextStatus,
    statusLabel: WITHDRAWAL_LABELS[nextStatus],
    reviewNote: clean(note, 400),
    revision: Number(current.revision || 0) + 1,
    ...metadata,
  });
  if (!nextRaw) return { ok: false, error: "invalid_withdrawal_record" };
  const result = await executeOperation({
    script: TRANSITION_WITHDRAWAL_SCRIPT,
    keys: [opKey, userKey(email), balanceCentsKey(email), withdrawalKey(withdrawalId), transactionKey(email), ADMIN_BALANCE_LOG_KEY, accountLifecycleKey(email)],
    args: [requestHash, expectedRevision, nextStatus, WITHDRAWAL_LABELS[nextStatus], clean(note, 400), JSON.stringify(metadata), JSON.stringify(tx), JSON.stringify({ ...tx, email }), detail.value, nextRaw],
    opKey,
    requestHash,
  });
  if (result?.error === "storage_conflict" && Number(options._losslessAttempt || 0) < 3) {
    return transitionWithdrawalAtomic(id, status, note, actor, { ...options, expectedRevision, operationId, _losslessAttempt: Number(options._losslessAttempt || 0) + 1 });
  }
  return result;
}

function serviceFingerprint(services) {
  return (Array.isArray(services) ? services : [])
    .map((item) => `${clean(item?.key || item?.service || item?.product, 40)}:${clean(item?.plan || item?.planId, 40)}`)
    .filter((item) => item !== ":")
    .sort()
    .join("|");
}

const COMMIT_ORDER_SCRIPT = LUA_COMMON + `
local fixedTypes={'string','string','list','hash','zset','string','none','none','none','none','none','list','none','none','zset','zset','set','none','none'}
for index=1,19 do
  local expected=fixedTypes[index]
  if index==7 and ARGV[18]=='1' then expected='list' end
  if index==8 and ARGV[19]=='1' then expected='list' end
  if index==9 and (ARGV[20]=='1' or ARGV[24]=='1') then expected='string' end
  if index==10 and ARGV[20]=='1' then expected='string' end
  if index==11 and ARGV[21]=='1' then expected='list' end
  if index==13 and ARGV[22]=='1' then expected='string' end
  if index==14 and ARGV[23]=='1' then expected='string' end
  if index==18 and ARGV[24]=='1' then expected='string' end
  if index==19 and ARGV[24]=='1' then expected='string' end
  if expected~='none' and not validtype(KEYS[index],expected) then return encode({ok=false,error='storage_type_error',keyIndex=index}) end
end
if ARGV[24]=='1' then
  local principalRaw=redis.call('GET',KEYS[9]); local versionRaw=redis.call('GET',KEYS[18]); local lifecycle=redis.call('GET',KEYS[19])
  if not principalRaw then return encode({ok=false,error='session_state_changed'}) end
  local principal=decode(principalRaw); if not principal then return encode({ok=false,error='invalid_user_record'}) end
  if principal.banned then return encode({ok=false,error='account_banned'}) end
  if not versionRaw or not string.match(versionRaw,'^%d+$') then return encode({ok=false,error='session_state_changed'}) end
  local currentVersion=tonumber(versionRaw); local expectedVersion=tonumber(ARGV[25])
  if not currentVersion or currentVersion<1 or currentVersion~=math.floor(currentVersion) or currentVersion>9007199254740990
    or not expectedVersion or expectedVersion<1 or expectedVersion~=math.floor(expectedVersion) or currentVersion~=expectedVersion then
    return encode({ok=false,error='session_state_changed'})
  end
  if not lifecycle or #lifecycle~=32 or string.match(lifecycle,'[^a-f0-9]') or lifecycle~=ARGV[26] then
    return encode({ok=false,error='account_lifecycle_changed'})
  end
end
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
if redis.call('EXISTS',KEYS[2])==1 then return encode({ok=false,error='order_exists'}) end
local order=decode(ARGV[3]); local stocks=decode(ARGV[17])
if not order or not decode(ARGV[4]) or not stocks or tostring(order.orderId or '')~=ARGV[2] then return encode({ok=false,error='invalid_order_record'}) end

-- Redis scripts are atomic with respect to other clients, but a runtime error
-- does not roll back writes already performed by the script. Validate every
-- value used by a fallible commit command before entering the commit phase.
local revisionRaw=redis.call('GET',KEYS[6]); local revision=0
if revisionRaw then
  if not string.match(revisionRaw,'^%d+$') then return encode({ok=false,error='invalid_order_revision'}) end
  revision=tonumber(revisionRaw)
  if not revision or revision~=math.floor(revision) or revision<0 or revision>9007199254740990 then return encode({ok=false,error='invalid_order_revision'}) end
end
local createdScore=tonumber(ARGV[16])
if not createdScore or createdScore~=createdScore or createdScore<-9007199254740991 or createdScore>9007199254740991 then return encode({ok=false,error='invalid_order_score'}) end
local quoteTtl=tonumber(ARGV[15])
if ARGV[23]=='1' and (not quoteTtl or quoteTtl~=math.floor(quoteTtl) or quoteTtl<1 or quoteTtl>604800) then return encode({ok=false,error='invalid_quote_ttl'}) end

-- Validate every limited stock key before any write. Missing keys are unlimited.
local limited={}
for _,stock in ipairs(stocks) do
  local slot=tonumber(stock.slot); local count=tonumber(stock.count)
  if not slot or slot<20 or slot>#KEYS or not count or count<1 or count~=math.floor(count) or count>9007199254740991 then return encode({ok=false,error='invalid_stock_spec'}) end
  if not validtype(KEYS[slot],'string') then return encode({ok=false,error='storage_type_error',keyIndex=slot}) end
  local raw=redis.call('GET',KEYS[slot])
  if (raw~=false)~=(stock.limited==true) then return encode({ok=false,error='storage_conflict'}) end
  if raw then
    local available=tonumber(raw)
    if not available or available~=math.floor(available) or available<0 or available>9007199254740991 then return encode({ok=false,error='invalid_stock_record'}) end
    if available<count then return encode({ok=false,error='out_of_stock',soldOutService=stock.service,soldOutPlan=stock.plan,remaining=available}) end
    table.insert(limited,stock)
  end
end

local payment=ARGV[5]; local amount=tonumber(ARGV[6]); local user=nil; local userRaw=nil; local userChanged=false; local before=nil; local after=nil; local balance=nil
local tx=nil; local admin=nil
if not safeinteger(amount) or amount<0 then return encode({ok=false,error='invalid_amount'}) end
if ARGV[20]=='1' then
  userRaw=redis.call('GET',KEYS[9]); if not userRaw then return encode({ok=false,error='user_not_found'}) end
  user=decode(userRaw); if not user then return encode({ok=false,error='invalid_user_record'}) end
  before=readbalance(KEYS[10],user); if not before then return encode({ok=false,error='invalid_balance_record'}) end
  after=before
  if ARGV[8]~='' then
    if userRaw~=ARGV[27] then return encode({ok=false,error='storage_conflict'}) end
    local found=nil
    if type(user.coupons)=='table' then for _,coupon in ipairs(user.coupons) do if tostring(coupon.id or '')==ARGV[8] then found=coupon; break end end end
    if not found or found.status~='active' then return encode({ok=false,error='coupon_unavailable'}) end
    local couponValue=tonumber(found.amount or 0)
    local couponCents=couponValue and math.floor(couponValue*100+0.5) or nil
    local maxCents=tonumber(ARGV[10]) or 0; local expected=tonumber(ARGV[9]) or 0
    if not safeinteger(couponCents) or not safeinteger(maxCents) or not safeinteger(expected) then return encode({ok=false,error='coupon_changed'}) end
    local actual=math.min(couponCents,maxCents)
    if expected<=0 or actual~=expected then return encode({ok=false,error='coupon_changed'}) end
    found.status='used'; found.usedOrderId=ARGV[2]; found.discount=expected/100; found.usedAt=order.createdAt; found.usedAtBeijing=order.createdAtBeijing; userChanged=true
  end
  if payment=='balance' then
    if before<amount then return encode({ok=false,error='insufficient_balance',currentBalance=before/100,currentBalanceCents=before,required=amount/100}) end
    after=before-amount
    if not safeinteger(after) then return encode({ok=false,error='balance_out_of_range'}) end
    balance=after/100
    if amount>0 then
      tx=decode(ARGV[11]); admin=decode(ARGV[12]); if not tx or not admin then return encode({ok=false,error='invalid_ledger_record'}) end
    end
  end
end

local code=nil; local codeRaw=nil
if payment=='redeem' then
  codeRaw=redis.call('GET',KEYS[13]); if not codeRaw then return encode({ok=false,error='code_not_found'}) end
  if codeRaw~=ARGV[29] then return encode({ok=false,error='storage_conflict'}) end
  code=decode(codeRaw); if not code then return encode({ok=false,error='invalid_code_record'}) end
  if code.status~='active' then return encode({ok=false,error='code_unavailable'}) end
  if code.type~='service' and code.kind~='service' and not (type(code.services)=='table' and #code.services>0) then return encode({ok=false,error='not_service_code'}) end
  local values={}; if type(code.services)=='table' then for _,item in ipairs(code.services) do local key=tostring(item.key or item.service or item.product or ''); local plan=tostring(item.plan or item.planId or ''); table.insert(values,key..':'..plan) end end
  table.sort(values); if table.concat(values,'|')~=ARGV[13] then return encode({ok=false,error='service_mismatch'}) end
  local metadata=decode(ARGV[14]); if not metadata then return encode({ok=false,error='invalid_metadata'}) end
  for key,value in pairs(metadata) do code[key]=value end; code.type='service'; code.status='used'
elseif payment~='balance' and payment~='alipay' and payment~='usdt' and payment~='quote' then
  return encode({ok=false,error='invalid_payment_method'})
end

if ARGV[23]=='1' then
  local claimed=redis.call('GET',KEYS[14])
  if claimed and claimed~=ARGV[2] then return encode({ok=false,error='payment_quote_used'}) end
end

local userJson=nil; local txJson=nil; local adminJson=nil
if user then
  if userChanged then
    userJson=ARGV[28]
    local nextUser=decode(userJson); if not nextUser then return encode({ok=false,error='invalid_user_record'}) end
  end
  if payment=='balance' and amount>0 then
    local beforeJson=persistedencode(before/100); local beforeCentsJson=persistedencode(before)
    local afterJson=persistedencode(after/100); local afterCentsJson=persistedencode(after)
    txJson=beforeJson and beforeCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[11],'"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
    adminJson=beforeJson and beforeCentsJson and afterJson and afterCentsJson and appendobjectfields(ARGV[12],'"balanceBefore":'..beforeJson..',"balanceBeforeCents":'..beforeCentsJson..',"balanceAfter":'..afterJson..',"balanceAfterCents":'..afterCentsJson) or nil
  end
end
local codeJson=code and ARGV[30] or nil
if code then
  local nextCode=decode(codeJson)
  if not nextCode or tostring(nextCode.status or '')~='used' or tostring(nextCode.usedOrderId or '')~=ARGV[2] then return encode({ok=false,error='invalid_code_record'}) end
end
local overviewJson=ARGV[4]
local balanceJson='null'
if balance~=nil then balanceJson=persistedencode(balance) end
local resultJson=balanceJson and '{"ok":true,"order":'..ARGV[3]..',"balance":'..balanceJson..'}' or nil
local operationJson=resultJson and persistedencode({requestHash=ARGV[1],resultJson=resultJson}) or nil
if (userChanged and not userJson) or (payment=='balance' and amount>0 and (not txJson or not adminJson))
  or (code and not codeJson) or not overviewJson or not resultJson or not operationJson then
  return redis.error_reply('money_json_encode_failed')
end

-- Commit phase: every mutation and every index is part of this one script.
for _,stock in ipairs(limited) do redis.call('DECRBY',KEYS[tonumber(stock.slot)],tostring(stock.count)) end
if user then
  redis.call('SET',KEYS[10],tostring(after))
  if userChanged then redis.call('SET',KEYS[9],userJson) end
  if payment=='balance' and amount>0 then
    pushtrim(KEYS[11],txJson,199); pushtrim(KEYS[12],adminJson,499)
  end
end
if code then redis.call('SET',KEYS[13],codeJson) end
if ARGV[23]=='1' then redis.call('SET',KEYS[14],ARGV[2],'EX',tostring(quoteTtl)) end
redis.call('SET',KEYS[2],ARGV[3])
if redis.call('SADD',KEYS[17],ARGV[2])==1 then redis.call('LPUSH',KEYS[3],ARGV[2]) end
redis.call('HSET',KEYS[4],ARGV[2],overviewJson); redis.call('ZADD',KEYS[5],ARGV[16],ARGV[2]); redis.call('INCR',KEYS[6])
if ARGV[18]=='1' then redis.call('LPUSH',KEYS[7],ARGV[2]) end
if ARGV[19]=='1' then redis.call('LPUSH',KEYS[8],ARGV[2]) end
if payment=='usdt' and ARGV[23]=='1' then redis.call('ZADD',KEYS[15],ARGV[16],ARGV[2]) else redis.call('ZREM',KEYS[15],ARGV[2]) end
redis.call('ZREM',KEYS[16],ARGV[2])
redis.call('SET',KEYS[1],operationJson); return resultJson
`;

function orderOverview(order) {
  return {
    orderId: normalizeOrderId(order?.orderId), status: order?.status || "received", orderType: order?.orderType || "standard",
    paymentMethod: order?.paymentMethod || "alipay", paidCurrency: order?.paidCurrency || "CNY",
    paidAmount: Number(order?.paidAmount || 0), finalAmount: Number(order?.finalAmount || 0), subtotal: Number(order?.subtotal || 0),
    originalAmount: Number(order?.originalAmount || 0), bundleFinalAmount: Number(order?.bundleFinalAmount || 0),
    createdAt: order?.createdAt || "", createdAtBeijing: order?.createdAtBeijing || "", completedAt: order?.completedAt || "",
    email: order?.email || "", serviceLabel: order?.serviceLabel || "", items: (order?.items || []).map((item) => ({
      amount: Number(item?.amount || 0), service: item?.service || "", label: item?.label || "", plan: item?.plan || item?.rocketPlan || "", cycle: item?.cycle || "",
    })),
    usdtPayAmount: Number(order?.usdtPayAmount || 0), usdtQuoteId: order?.usdtQuoteId || "",
    usdtConfirmedAt: order?.usdtConfirmedAt || "", usdtTxId: order?.usdtTxId || "",
    referral: order?.referral ? { levelOneEmail: order.referral.levelOneEmail || "" } : null,
    assignedStaffId: 0, assignedStaffUsername: "", assignedAt: "", assignedAtBeijing: "", internalReference: "", netflixSelfServiceEnabled: true,
    netflixDeliveryMode: ["self_service", "password"].includes(order?.netflixDeliveryMode) ? order.netflixDeliveryMode : "",
  };
}

export async function commitOrderCreationAtomic({
  order, paymentMethod, userEmail = "", redeemCode = "", coupon = null, couponMaxAmount = 0,
  operationId = "", requestHash = "", clientIp = "", userAgent = "", quoteTtlSec = 4 * 24 * 60 * 60,
  expectedAuthVersion = 0, expectedAccountLifecycleId = "",
} = {}) {
  const orderId = normalizeOrderId(order?.orderId);
  const opId = clean(operationId, 160);
  const payloadHash = clean(requestHash, 80);
  if (!orderId || !opId || !/^[a-f0-9]{64}$/i.test(payloadHash)) return { ok: false, error: "invalid_order_record" };
  if (!['balance','redeem','alipay','usdt','quote'].includes(paymentMethod)) return { ok: false, error: "invalid_payment_method" };

  const lower = normalizeEmail(userEmail);
  const couponId = clean(coupon?.couponId, 100);
  const couponDiscountCents = cents(coupon?.discount || 0);
  const couponMaxCents = cents(couponMaxAmount);
  const needsUser = paymentMethod === "balance" || Boolean(couponId);
  if (!Number.isSafeInteger(couponDiscountCents) || !Number.isSafeInteger(couponMaxCents)) {
    return { ok: false, error: "invalid_amount" };
  }
  if (needsUser && !validEmail(lower)) return { ok: false, error: "user_not_found" };
  const authenticatedPrincipal = validEmail(lower);
  const principalAuthVersion = Number(expectedAuthVersion);
  const principalLifecycleId = clean(expectedAccountLifecycleId, 80);
  if (authenticatedPrincipal && (
    !Number.isSafeInteger(principalAuthVersion) || principalAuthVersion < 1
    || !/^[a-f0-9]{32}$/.test(principalLifecycleId)
  )) return { ok: false, error: "invalid_operation_principal" };
  if (!authenticatedPrincipal && (principalAuthVersion || principalLifecycleId)) {
    return { ok: false, error: "invalid_operation_principal" };
  }
  const readsUser = needsUser || authenticatedPrincipal;
  const buyerIndex = orderEmailIndexKey(order.email);
  const userIndex = orderEmailIndexKey(order.userEmail);
  const distinctUserIndex = userIndex && userIndex !== buyerIndex ? userIndex : "";
  const noopPrefix = "liumeiti:money:noop:" + sha(opId).slice(0, 20) + ":";
  const opKey = operationKey("order-create", opId);
  const keys = [
    opKey, orderRecordKey(orderId), ORDER_INDEX_KEY, ORDER_OVERVIEW_HASH_KEY, ORDER_SUMMARY_INDEX_KEY, ORDER_LIST_REVISION_KEY,
    buyerIndex || noopPrefix + "buyer", distinctUserIndex || noopPrefix + "user-index",
    readsUser ? userKey(lower) : noopPrefix + "user", needsUser ? balanceCentsKey(lower) : noopPrefix + "balance",
    paymentMethod === "balance" ? transactionKey(lower) : noopPrefix + "tx", ADMIN_BALANCE_LOG_KEY,
    paymentMethod === "redeem" ? redeemCodeKey(redeemCode) : noopPrefix + "code",
    paymentMethod === "usdt" && order.usdtQuoteId ? "lm:usdt:quote-claim:" + clean(order.usdtQuoteId, 80) : noopPrefix + "quote",
    USDT_PENDING_ORDER_INDEX_KEY, QUOTE_EXPIRY_ORDER_INDEX_KEY, ORDER_INDEX_MEMBERSHIP_KEY,
    authenticatedPrincipal ? "lm:user:authver:" + lower : noopPrefix + "auth-version",
    authenticatedPrincipal ? accountLifecycleKey(lower) : noopPrefix + "lifecycle",
  ];
  const grouped = new Map();
  (paymentMethod === "quote" ? [] : (Array.isArray(order.items) ? order.items : [])).forEach((item, index) => {
    const service = clean(item?.service, 40); const plan = clean(item?.plan || item?.rocketPlan, 40);
    const name = service + ":" + plan;
    // Legacy/non-variant products use the empty-plan stock key.
    if (!service) return;
    const group = grouped.get(name) || { service, plan, count: 0, itemIndexes: [] };
    group.count += 1; group.itemIndexes.push(index + 1); grouped.set(name, group);
  });
  const stockSpecs = [];
  for (const group of grouped.values()) {
    keys.push(stockKey(group.service, group.plan));
    stockSpecs.push({ ...group, slot: keys.length });
  }
  const now = new Date();
  const amountCents = cents(order.finalAmount || 0);
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 1_000_000_000_000) {
    return { ok: false, error: "invalid_amount" };
  }
  const tx = paymentMethod === "balance" && amountCents > 0 ? {
    id: makeId("TX"), amount: amountFromCents(-amountCents), amountCents: -amountCents, reason: "订单支付 " + orderId,
    source: "order", orderId, operationId: opId, createdAt: now.toISOString(), createdAtBeijing: formatBeijingTime(now),
  } : {};
  const code = normalizeCode(redeemCode);
  const codeMeta = paymentMethod === "redeem" ? {
    usedBy: clean(order.email, 200), usedOrderId: orderId, usedIp: clean(clientIp, 80), usedUserAgent: clean(userAgent, 500),
    usedAt: now.toISOString(), usedAtBeijing: formatBeijingTime(now), usedOperationId: opId,
  } : {};
  const committedOrder = { ...order, revision: 1, ...(paymentMethod === "balance" ? { paidByBalance: true } : {}) };
  const createdScore = new Date(order.createdAt || 0).getTime();
  const rawQuoteTtl = Number(quoteTtlSec);
  const safeQuoteTtl = Number.isFinite(rawQuoteTtl)
    ? Math.min(604800, Math.max(300, Math.floor(rawQuoteTtl)))
    : 4 * 24 * 60 * 60;
  const createdScoreArg = String(Number.isFinite(createdScore) && createdScore > 0 ? Math.floor(createdScore) : Date.now());
  const recovered = await recoverOperation(opKey, payloadHash);
  if (recovered) return recovered;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let expectedUserRaw = ""; let nextUserRaw = ""; let expectedCodeRaw = ""; let nextCodeRaw = "";
    const attemptOrder = {
      ...committedOrder,
      ...(Array.isArray(committedOrder.items)
        ? { items: committedOrder.items.map((item) => ({ ...item })) }
        : {}),
    };
    const stockReads = await Promise.all(stockSpecs.map((stock) => redisMoneyGet(stockKey(stock.service, stock.plan))));
    if (stockReads.some((read) => !read.ok)) {
      return { ok: false, error: stockReads.find((read) => !read.ok)?.error || "storage_unavailable" };
    }
    const attemptStockSpecs = stockSpecs.map((stock, index) => {
      const limited = stockReads[index].value != null;
      if (limited && Array.isArray(attemptOrder.items)) {
        for (const itemIndex of stock.itemIndexes) {
          if (attemptOrder.items[itemIndex - 1]) attemptOrder.items[itemIndex - 1].stockReserved = true;
        }
      }
      return { ...stock, limited };
    });
    if (couponId) {
      const read = await redisMoneyGet(userKey(lower));
      if (!read.ok) return { ok: false, error: read.error };
      if (!read.value) return { ok: false, error: "user_not_found" };
      let current;
      try { current = JSON.parse(read.value); } catch { return { ok: false, error: "invalid_user_record" }; }
      const index = Array.isArray(current?.coupons) ? current.coupons.findIndex((item) => String(item?.id || "") === couponId) : -1;
      if (index < 0) return { ok: false, error: "coupon_unavailable" };
      expectedUserRaw = read.value;
      nextUserRaw = losslessJsonPatch(read.value, [
        { path: ["coupons", index, "status"], value: "used" },
        { path: ["coupons", index, "usedOrderId"], value: orderId },
        { path: ["coupons", index, "discount"], value: amountFromCents(couponDiscountCents) },
        { path: ["coupons", index, "usedAt"], value: committedOrder.createdAt },
        { path: ["coupons", index, "usedAtBeijing"], value: committedOrder.createdAtBeijing },
      ]);
      if (!nextUserRaw) return { ok: false, error: "invalid_user_record" };
    }
    if (paymentMethod === "redeem") {
      const read = await redisMoneyGet(redeemCodeKey(redeemCode));
      if (!read.ok) return { ok: false, error: read.error };
      if (!read.value) return { ok: false, error: "code_not_found" };
      expectedCodeRaw = read.value;
      nextCodeRaw = losslessTopLevelPatch(read.value, { ...codeMeta, type: "service", status: "used" });
      if (!nextCodeRaw) return { ok: false, error: "invalid_code_record" };
    }
    const result = await executeOperation({
      script: COMMIT_ORDER_SCRIPT,
      keys,
      args: [
        payloadHash, orderId, JSON.stringify(attemptOrder), JSON.stringify(orderOverview(attemptOrder)), paymentMethod, amountCents, lower,
        couponId, couponDiscountCents, couponMaxCents, JSON.stringify(tx), JSON.stringify({ ...tx, email: lower }),
        paymentMethod === "redeem" ? serviceFingerprint(order.items) : "", JSON.stringify(codeMeta),
        String(safeQuoteTtl), createdScoreArg,
        JSON.stringify(attemptStockSpecs), buyerIndex ? "1" : "0", distinctUserIndex ? "1" : "0", needsUser ? "1" : "0",
        paymentMethod === "balance" && amountCents > 0 ? "1" : "0", paymentMethod === "redeem" ? "1" : "0",
        paymentMethod === "usdt" && Boolean(order.usdtQuoteId) ? "1" : "0",
        authenticatedPrincipal ? "1" : "0", authenticatedPrincipal ? String(principalAuthVersion) : "0", principalLifecycleId,
        expectedUserRaw, nextUserRaw, expectedCodeRaw, nextCodeRaw,
      ],
      opKey,
      requestHash: payloadHash,
    });
    if (result?.error !== "storage_conflict") return result;
  }
  return { ok: false, error: "storage_conflict" };
}

const USDT_CONFIRMED_TX_PREFIX = "lm:usdt:confirmed-tx:";
const USDT_CLOCK_SKEW_MS = 2 * 60 * 1000;
const USDT_QUOTE_GRACE_MS = 5 * 60 * 1000;

// The chain transaction claim and the order confirmation are one durability
// boundary. A process crash can therefore leave neither an orphan claim nor a
// confirmed order whose transaction is available to another order.
const CONFIRM_USDT_ORDER_SCRIPT = LUA_COMMON + `
local prior=existingop(KEYS[1],ARGV[1]); if prior then return prior end
local expected={'string','string','string','zset','zset','hash','zset','string','hash','zset'}
for index,key in ipairs(KEYS) do
  if not validtype(key,expected[index]) then return encode({ok=false,error='storage_type_error',keyIndex=index}) end
end

local currentRaw=redis.call('GET',KEYS[3])
if not currentRaw then return encode({ok=false,error='order_not_found'}) end
if currentRaw~=ARGV[4] then return encode({ok=false,error='stale_order'}) end
local current=decode(currentRaw); local next=decode(ARGV[6])
if not current or not next or tostring(current.orderId or '')~=ARGV[2] or tostring(next.orderId or '')~=ARGV[2] then
  return encode({ok=false,error='invalid_order_record'})
end

local expectedRevision=tonumber(ARGV[5]); local currentRevision=tonumber(current.revision or 0); local nextRevision=tonumber(next.revision)
if not expectedRevision or expectedRevision<0 or expectedRevision~=math.floor(expectedRevision)
  or not currentRevision or currentRevision<0 or currentRevision~=math.floor(currentRevision)
  or currentRevision~=expectedRevision then return encode({ok=false,error='stale_revision'}) end
if not nextRevision or nextRevision~=currentRevision+1 or nextRevision>9007199254740991 then
  return encode({ok=false,error='invalid_order_revision'})
end
if tostring(current.status or '')~='received' or tostring(current.paidCurrency or '')~='USDT' then
  return encode({ok=false,error='order_not_confirmable'})
end
if tostring(current.usdtConfirmedAt or '')~='' or tostring(current.usdtTxId or '')~='' then
  return encode({ok=false,error='order_already_confirmed'})
end
if tostring(next.status or '')~='received' or tostring(next.paidCurrency or '')~='USDT'
  or tostring(next.usdtTxId or '')~=ARGV[3] or tostring(next.usdtConfirmedAt or '')~=ARGV[10]
  or tostring(next.usdtChainTimestamp or '')~=ARGV[12]
  or tonumber(next.usdtConfirmedAmount or 0)~=tonumber(ARGV[11]) then
  return encode({ok=false,error='invalid_confirmation_record'})
end
local confirmedMicros=tonumber(ARGV[13]); local expectedMicros=tonumber(ARGV[14])
local orderAmount=tonumber(current.usdtPayAmount or 0)
if not confirmedMicros or confirmedMicros<=0 or confirmedMicros~=math.floor(confirmedMicros)
  or not expectedMicros or expectedMicros<=0 or expectedMicros~=math.floor(expectedMicros)
  or not orderAmount or orderAmount<=0 or math.floor(orderAmount*1000000+0.5)~=expectedMicros
  or confirmedMicros~=expectedMicros then return encode({ok=false,error='transaction_amount_mismatch'}) end
local chainTimestamp=tonumber(ARGV[15]); local windowStart=tonumber(ARGV[16]); local windowEnd=tonumber(ARGV[17])
if not chainTimestamp or not windowStart or not windowEnd or windowEnd<windowStart
  or chainTimestamp<windowStart or chainTimestamp>windowEnd then
  return encode({ok=false,error='transaction_outside_quote_window'})
end

local claimed=redis.call('GET',KEYS[2])
if claimed and claimed~=ARGV[2] then return encode({ok=false,error='tx_already_claimed',claimedOrderId=claimed}) end
local createdScore=tonumber(ARGV[8])
if not createdScore or createdScore~=createdScore or createdScore<-9007199254740991 or createdScore>9007199254740991 then
  return encode({ok=false,error='invalid_order_score'})
end
local listRevisionRaw=redis.call('GET',KEYS[8]); local listRevision=0
if listRevisionRaw then
  if not string.match(listRevisionRaw,'^%d+$') then return encode({ok=false,error='invalid_order_revision'}) end
  listRevision=tonumber(listRevisionRaw)
  if not listRevision or listRevision<0 or listRevision~=math.floor(listRevision) or listRevision>9007199254740990 then
    return encode({ok=false,error='invalid_order_revision'})
  end
end
local overviewRaw=redis.call('HGET',KEYS[6],ARGV[2])
if (ARGV[21]=='1' and overviewRaw~=ARGV[22]) or (ARGV[21]=='0' and overviewRaw) then return encode({ok=false,error='storage_conflict'}) end
local overviewJson=ARGV[23]; local overview=decode(overviewJson)
if not overview or tostring(overview.usdtConfirmedAt or '')~=ARGV[10] or tostring(overview.usdtTxId or '')~=ARGV[3] then return encode({ok=false,error='invalid_order_overview'}) end
local effect=decode(ARGV[19]); local effectScore=tonumber(ARGV[20])
if not effect or tostring(effect.effectKey or '')~=ARGV[18]
  or tostring(effect.orderId or '')~=ARGV[2] or tostring(effect.txId or '')~=ARGV[3]
  or tonumber(effect.amountMicros or 0)~=confirmedMicros
  or not effectScore or effectScore~=math.floor(effectScore)
  or effectScore<-9007199254740991 or effectScore>9007199254740991 then
  return encode({ok=false,error='invalid_confirmation_effect'})
end
local operationJson=persistedencode({requestHash=ARGV[1],resultJson=ARGV[9]})
if not overviewJson or not operationJson then return redis.error_reply('money_json_encode_failed') end

-- USDT confirmation commit: all commands below use fully validated values and
-- the claim is deliberately permanent because a chain transaction is immutable.
-- The effect record/index are committed in this same boundary so a process
-- crash after confirmation cannot permanently lose the audit/Telegram work.
redis.call('SET',KEYS[2],ARGV[2])
redis.call('SET',KEYS[3],ARGV[6])
redis.call('ZREM',KEYS[4],ARGV[2]); redis.call('ZREM',KEYS[5],ARGV[2])
redis.call('HSET',KEYS[6],ARGV[2],overviewJson); redis.call('ZADD',KEYS[7],ARGV[8],ARGV[2])
redis.call('SET',KEYS[8],tostring(listRevision+1))
redis.call('HSET',KEYS[9],ARGV[18],ARGV[19]); redis.call('ZADD',KEYS[10],ARGV[20],ARGV[18])
redis.call('SET',KEYS[1],operationJson); return ARGV[9]
`;

function usdtPaymentFingerprint(order) {
  return stableJson({
    orderId: normalizeOrderId(order?.orderId),
    paidCurrency: order?.paidCurrency || "",
    usdtPayAmount: Number(order?.usdtPayAmount || 0),
    usdtQuoteId: clean(order?.usdtQuoteId, 80),
    paymentQuoteIssuedAt: String(order?.paymentQuoteIssuedAt || ""),
    paymentQuoteExpiresAt: String(order?.paymentQuoteExpiresAt || ""),
  });
}

export function usdtConfirmationEffectKey(orderIdValue, txIdValue) {
  const orderId = normalizeOrderId(orderIdValue);
  const txId = clean(txIdValue, 96);
  return orderId && txId ? sha(`usdt-confirm-effect\0${orderId}\0${txId}`) : "";
}

export async function confirmUsdtOrderAtomic({
  order,
  transaction,
  confirmedAt = new Date(),
  effectActor = null,
} = {}) {
  const orderId = normalizeOrderId(order?.orderId);
  const txId = clean(transaction?.txId, 96);
  let micros;
  try { micros = BigInt(String(transaction?.micros)); } catch { micros = 0n; }
  const chainTimestamp = Number(transaction?.ts || 0);
  const expectedRevision = Number(order?.revision || 0);
  const confirmedDate = confirmedAt instanceof Date ? confirmedAt : new Date(confirmedAt);
  const chainDate = new Date(chainTimestamp);
  if (
    !orderId || !txId || micros <= 0n || !Number.isSafeInteger(chainTimestamp) || chainTimestamp <= 0
    || micros > BigInt(Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || Number.isNaN(confirmedDate.getTime()) || Number.isNaN(chainDate.getTime())
  ) return { ok: false, error: "invalid_usdt_confirmation" };

  const confirmedMicros = Number(micros);
  const amount = confirmedMicros / 1_000_000;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "invalid_usdt_confirmation" };
  const paymentFingerprint = usdtPaymentFingerprint(order);
  const requestHash = sha(stableJson({ orderId, txId, micros: String(micros), chainTimestamp, paymentFingerprint }));
  const opKey = operationKey("usdt-confirm-tx", txId);

  // This read makes retries cheap and also recovers a commit when the original
  // REST response was lost after Redis saved the permanent operation result.
  const recovered = await recoverOperation(opKey, requestHash);
  if (recovered) return recovered;

  const [stored, overviewStored] = await Promise.all([
    redisMoneyGet(orderRecordKey(orderId)), redisMoneyHget(ORDER_OVERVIEW_HASH_KEY, orderId),
  ]);
  if (!stored.ok) return { ok: false, error: stored.error || "storage_unavailable" };
  if (!overviewStored.ok) return { ok: false, error: overviewStored.error || "storage_unavailable" };
  if (!stored.value) return { ok: false, error: "order_not_found" };
  let current;
  try { current = JSON.parse(stored.value); } catch { return { ok: false, error: "invalid_order_record" }; }
  if (!current || normalizeOrderId(current.orderId) !== orderId) return { ok: false, error: "invalid_order_record" };
  if (current.usdtConfirmedAt || current.usdtTxId) {
    return current.usdtConfirmedAt && current.usdtTxId === txId
      ? { ok: true, order: current, txId, amount, amountMicros: String(micros), idempotent: true }
      : { ok: false, error: "order_already_confirmed" };
  }
  const currentRevision = Number(current.revision || 0);
  if (!Number.isSafeInteger(currentRevision) || currentRevision !== expectedRevision) {
    return { ok: false, error: "stale_revision", currentRevision };
  }
  if (current.status !== "received" || current.paidCurrency !== "USDT") {
    return { ok: false, error: "order_not_confirmable" };
  }
  if (usdtPaymentFingerprint(current) !== paymentFingerprint) {
    return { ok: false, error: "stale_order" };
  }
  const expectedMicros = Math.round(Number(current.usdtPayAmount || 0) * 1_000_000);
  const quoteStart = new Date(current.paymentQuoteIssuedAt || 0).getTime();
  const quoteEnd = new Date(current.paymentQuoteExpiresAt || 0).getTime();
  const windowStart = quoteStart - USDT_CLOCK_SKEW_MS;
  const windowEnd = quoteEnd + USDT_QUOTE_GRACE_MS;
  if (!Number.isSafeInteger(expectedMicros) || expectedMicros <= 0 || expectedMicros !== confirmedMicros) {
    return { ok: false, error: "transaction_amount_mismatch" };
  }
  if (
    !Number.isFinite(quoteStart) || !Number.isFinite(quoteEnd) || quoteStart <= 0 || quoteEnd <= quoteStart
    || chainTimestamp < windowStart || chainTimestamp > windowEnd
  ) return { ok: false, error: "transaction_outside_quote_window" };

  const confirmedIso = confirmedDate.toISOString();
  const chainIso = chainDate.toISOString();
  const effectKey = usdtConfirmationEffectKey(orderId, txId);
  const actorId = Number(effectActor?.staffId || 0);
  const effect = {
    version: 1,
    effectKey,
    orderId,
    txId,
    amount,
    amountMicros: String(micros),
    email: clean(current.email, 200),
    userEmail: normalizeEmail(current.userEmail),
    accountLifecycleId: clean(current.accountLifecycleId, 80).toLowerCase(),
    locale: current.locale === "en" ? "en" : "zh",
    businessTraceId: clean(current.businessTraceId, 40),
    actor: {
      staffId: Number.isSafeInteger(actorId) && actorId >= 0 ? actorId : 0,
      staffUsername: clean(effectActor?.staffUsername || "system", 60) || "system",
    },
    confirmedAt: confirmedIso,
  };
  const orderReplacements = {
    revision: currentRevision + 1,
    usdtConfirmedAt: confirmedIso,
    usdtConfirmedAtBeijing: formatBeijingTime(confirmedDate),
    usdtTxId: txId,
    usdtConfirmedAmount: amount,
    usdtChainTimestamp: chainIso,
  };
  const nextOrderRaw = losslessTopLevelPatch(stored.value, orderReplacements);
  if (!nextOrderRaw) return { ok: false, error: "invalid_order_record" };
  const nextOrder = { ...current, ...orderReplacements };
  const overviewBase = overviewStored.value || JSON.stringify(orderOverview(nextOrder));
  const nextOverviewRaw = losslessTopLevelPatch(overviewBase, {
    status: nextOrder.status,
    paymentMethod: nextOrder.paymentMethod,
    paidCurrency: nextOrder.paidCurrency,
    usdtConfirmedAt: confirmedIso,
    usdtTxId: txId,
  });
  if (!nextOverviewRaw) return { ok: false, error: "invalid_order_overview" };
  const createdScore = new Date(current.createdAt || 0).getTime();
  const safeCreatedScore = Number.isFinite(createdScore) && createdScore > 0 ? Math.floor(createdScore) : Date.now();
  const resultJson = `{"ok":true,"order":${nextOrderRaw},"txId":${JSON.stringify(txId)},"amount":${JSON.stringify(amount)},"amountMicros":${JSON.stringify(String(micros))},"effect":${JSON.stringify(effect)}}`;
  const result = await executeOperation({
    script: CONFIRM_USDT_ORDER_SCRIPT,
    keys: [
      opKey,
      USDT_CONFIRMED_TX_PREFIX + txId,
      orderRecordKey(orderId),
      USDT_PENDING_ORDER_INDEX_KEY,
      QUOTE_EXPIRY_ORDER_INDEX_KEY,
      ORDER_OVERVIEW_HASH_KEY,
      ORDER_SUMMARY_INDEX_KEY,
      ORDER_LIST_REVISION_KEY,
      USDT_CONFIRM_EFFECT_RECORDS_KEY,
      USDT_CONFIRM_EFFECT_INDEX_KEY,
    ],
    args: [
      requestHash,
      orderId,
      txId,
      stored.value,
      expectedRevision,
      nextOrderRaw,
      JSON.stringify(orderOverview(nextOrder)),
      safeCreatedScore,
      resultJson,
      confirmedIso,
      amount,
      chainIso,
      confirmedMicros,
      expectedMicros,
      chainTimestamp,
      windowStart,
      windowEnd,
      effectKey,
      JSON.stringify(effect),
      confirmedDate.getTime(),
      overviewStored.value == null ? "0" : "1",
      overviewStored.value || "",
      nextOverviewRaw,
    ],
    opKey,
    requestHash,
  });
  if (result?.error === "storage_conflict" && Number(arguments[0]?._losslessAttempt || 0) < 3) {
    return confirmUsdtOrderAtomic({ ...arguments[0], _losslessAttempt: Number(arguments[0]?._losslessAttempt || 0) + 1 });
  }
  return result;
}

export const moneyKeys = {
  userKey,
  balanceCentsKey,
  transactionKey,
  operationKey,
  redeemCodeKey,
  withdrawalKey,
  orderRecordKey,
  redisAtomicStorageKey,
};
