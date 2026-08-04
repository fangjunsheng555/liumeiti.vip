import { createHash } from "node:crypto";
import { clean, redisCmd, redisPipeline, replaceTopLevelJsonFields } from "./_utils.js";
import { redisEvalAtomic } from "./_money.js";

const OPERATION_PREFIX = "liumeiti:durable-operation:v1:";
const OPERATION_STARTED_INDEX = "liumeiti:durable-operation:v1:started-index";
const OPERATION_BACKFILL_CURSOR = "liumeiti:durable-operation:v1:started-index:backfill-cursor";

const CLAIM_SCRIPT = `
-- durable_claim_v2_lossless
local function validtype(key,expected) local value=redis.call('TYPE',key) local actual=type(value)=='table' and value.ok or value return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') then return {'error','storage_type_error'} end if KEYS[1]~='liumeiti:durable-operation:v1:'..ARGV[2] then return {'error','invalid_operation_record'} end local claimScore=tonumber(ARGV[4]) if not claimScore or claimScore~=claimScore or claimScore<0 or claimScore>9007199254740991 then return {'error','invalid_operation_record'} end local raw=redis.call('GET',KEYS[1]) if raw then local ok,record=pcall(cjson.decode,raw) if not ok or type(record)~='table' or type(record.requestHash)~='string' then redis.call('ZADD',KEYS[2],claimScore,ARGV[2]); return {'error','operation_record_corrupt'} end if type(record.operationId)~='string' or record.operationId~=ARGV[2] then return {'error','operation_record_corrupt'} end if record.requestHash~=ARGV[1] then return {'error','idempotency_conflict'} end local state=record.state==nil and 'started' or tostring(record.state) if (state~='started' and state~='done') or (state=='done' and (type(record.result)~='table' or type(record.result.ok)~='boolean')) then local startedScore=tonumber(record.startedAtMs); if not startedScore or startedScore~=startedScore or startedScore<0 or startedScore>9007199254740991 then startedScore=claimScore end; redis.call('ZADD',KEYS[2],startedScore,ARGV[2]); return {'error','operation_record_corrupt'} end if state=='done' then redis.call('ZREM',KEYS[2],ARGV[2]) else local startedScore=tonumber(record.startedAtMs) if not startedScore or startedScore~=startedScore or startedScore<0 or startedScore>9007199254740991 then startedScore=claimScore end redis.call('ZADD',KEYS[2],startedScore,ARGV[2]) end return {'ok',state,raw,'0'} end local createdOk,created=pcall(cjson.decode,ARGV[5]) if not createdOk or type(created)~='table' or created.requestHash~=ARGV[1] or type(created.operationId)~='string' or created.operationId~=ARGV[2] or tostring(created.state or '')~='started' then return {'error','invalid_operation_record'} end redis.call('SET',KEYS[1],ARGV[5]) redis.call('ZADD',KEYS[2],claimScore,ARGV[2]) return {'ok','started',ARGV[5],'1'}
`;

const COMPLETE_SCRIPT = `
-- durable_complete_v2_lossless
local function validtype(key,expected) local value=redis.call('TYPE',key) local actual=type(value)=='table' and value.ok or value return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') then return {'error','storage_type_error'} end if KEYS[1]~='liumeiti:durable-operation:v1:'..ARGV[3] then return {'error','invalid_operation_record'} end local raw=redis.call('GET',KEYS[1]) if not raw then return {'error','operation_record_missing'} end local ok,record=pcall(cjson.decode,raw) if not ok or type(record)~='table' or type(record.requestHash)~='string' then redis.call('ZADD',KEYS[2],0,ARGV[3]); return {'error','operation_record_corrupt'} end if type(record.operationId)~='string' or record.operationId~=ARGV[3] then return {'error','operation_record_corrupt'} end if record.requestHash~=ARGV[1] then return {'error','idempotency_conflict'} end local state=record.state==nil and 'started' or tostring(record.state) if state=='done' and type(record.result)=='table' and type(record.result.ok)=='boolean' then redis.call('ZREM',KEYS[2],ARGV[3]) return {'done',raw,'1'} end if state~='started' then local startedScore=tonumber(record.startedAtMs); if not startedScore or startedScore~=startedScore or startedScore<0 or startedScore>9007199254740991 then startedScore=0 end; redis.call('ZADD',KEYS[2],startedScore,ARGV[3]); return {'error','operation_record_corrupt'} end if raw~=ARGV[2] then return {'stale',raw} end local replacementOk,replacement=pcall(cjson.decode,ARGV[4]) if not replacementOk or type(replacement)~='table' or replacement.requestHash~=ARGV[1] or type(replacement.operationId)~='string' or replacement.operationId~=ARGV[3] or tostring(replacement.state or '')~='done' or type(replacement.result)~='table' or type(replacement.result.ok)~='boolean' then return {'error','invalid_operation_result'} end redis.call('SET',KEYS[1],ARGV[4]) redis.call('ZREM',KEYS[2],ARGV[3]) return {'done',ARGV[4],'0'}
`;

const ENSURE_PLAN_SCRIPT = `
-- durable_plan_v2_lossless
if KEYS[1]~='liumeiti:durable-operation:v1:'..ARGV[2] then return {'error','invalid_operation_record'} end local raw=redis.call('GET',KEYS[1]) if not raw then return {'error','operation_record_missing'} end local ok,record=pcall(cjson.decode,raw) if not ok or type(record)~='table' or type(record.requestHash)~='string' then return {'error','operation_record_corrupt'} end if type(record.operationId)~='string' or record.operationId~=ARGV[2] then return {'error','operation_record_corrupt'} end if record.requestHash~=ARGV[1] then return {'error','idempotency_conflict'} end if record.state~=nil and tostring(record.state)~='started' then return {'error','operation_record_corrupt'} end if record.plan~=nil then return {'planned',raw,'0'} end if raw~=ARGV[3] then return {'stale',raw} end local replacementOk,replacement=pcall(cjson.decode,ARGV[4]) if not replacementOk or type(replacement)~='table' or replacement.requestHash~=ARGV[1] or type(replacement.operationId)~='string' or replacement.operationId~=ARGV[2] or replacement.plan==nil then return {'error','invalid_operation_plan'} end redis.call('SET',KEYS[1],ARGV[4]) return {'planned',ARGV[4],'1'}
`;

function sha(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function operationCoordinates(scope, principal, idempotencyKey) {
  const normalizedScope = clean(scope, 120);
  const normalizedPrincipal = clean(principal, 240);
  const key = clean(idempotencyKey, 160);
  if (!normalizedScope || !normalizedPrincipal || !key) return null;
  const operationId = sha(`${normalizedScope}\0${normalizedPrincipal}\0${key}`);
  return {
    operationId,
    storageKey: OPERATION_PREFIX + operationId,
    lockKey: OPERATION_PREFIX + operationId + ":lock",
  };
}

// Let a route compare a domain-level commit marker with the exact operation
// that would be claimed, without creating a permanent `started` record first.
// This is important for terminal preflight rejections (for example, a
// single-use link submitted with a new key): rejected requests must not become
// false recovery-queue work.
export function durableOperationId({ scope, principal, idempotencyKey } = {}) {
  return operationCoordinates(scope, principal, idempotencyKey)?.operationId || "";
}

// Atomically binds an opaque client key to one exact payload forever. A
// `started` record deliberately has no expiry: after a process crash the same
// request can resume, while a changed request can never reuse the key.
export async function claimDurableOperation({ scope, principal, idempotencyKey, requestHash }) {
  const coordinates = operationCoordinates(scope, principal, idempotencyKey);
  const hash = clean(requestHash, 80);
  if (!coordinates || !hash) return { ok: false, error: "invalid_operation" };
  const now = new Date();
  const createdRecord = JSON.stringify({
    version: 1,
    state: "started",
    operationId: coordinates.operationId,
    requestHash: hash,
    createdAt: now.toISOString(),
    startedAtMs: now.getTime(),
  });
  const executed = await redisEvalAtomic(CLAIM_SCRIPT, [coordinates.storageKey, OPERATION_STARTED_INDEX], [
    hash,
    coordinates.operationId,
    now.toISOString(),
    String(now.getTime()),
    createdRecord,
  ]);
  const tuple = Array.isArray(executed.value) ? executed.value : [];
  if (!executed.ok || tuple[0] !== "ok") {
    return {
      ok: false,
      error: tuple[0] === "error" ? clean(tuple[1], 80) : executed.error || "storage_unavailable",
      ...coordinates,
    };
  }
  const record = parseOperation(tuple[2], coordinates.operationId);
  if (!record) return { ok: false, error: "invalid_storage_response", ...coordinates };
  return {
    ok: true,
    state: clean(tuple[1], 40) || "started",
    isNew: tuple[3] === "1",
    record,
    ...coordinates,
  };
}

export async function completeDurableOperation(operation, result) {
  const storageKey = clean(operation?.storageKey, 300);
  const requestHash = clean(operation?.record?.requestHash || operation?.requestHash, 80);
  const expectedOperationId = operationIdFromStorageKey(storageKey);
  const handleOperationId = clean(operation?.operationId, 80);
  const recordOperationId = clean(operation?.record?.operationId, 80);
  const operationId = handleOperationId || recordOperationId;
  if (!storageKey || !expectedOperationId || operationId !== expectedOperationId
    || (handleOperationId && handleOperationId !== expectedOperationId)
    || (recordOperationId && recordOperationId !== expectedOperationId)
    || !requestHash || !result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") {
    return { ok: false, error: "invalid_operation" };
  }
  const completedAt = new Date().toISOString();
  let executed = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readOperationState(storageKey);
    if (!state.ok) return { ok: false, error: "storage_unavailable" };
    if (!state.exists) return { ok: false, error: "operation_record_missing" };
    const raw = state.raw;
    const current = parseOperation(raw, expectedOperationId);
    if (!current) return { ok: false, error: "operation_record_corrupt" };
    if (current.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
    const replacement = replaceTopLevelJsonFields(raw, { state: "done", result, completedAt });
    if (!replacement) return { ok: false, error: "invalid_operation_result" };
    executed = await redisEvalAtomic(COMPLETE_SCRIPT, [storageKey, OPERATION_STARTED_INDEX], [
      requestHash,
      raw,
      operationId,
      replacement,
    ]);
    const tuple = Array.isArray(executed.value) ? executed.value : [];
    if (executed.ok && tuple[0] === "done") {
      const stored = parseOperation(tuple[1], expectedOperationId);
      if (!stored) return { ok: false, error: "invalid_storage_response" };
      return {
        ok: true,
        idempotent: tuple[2] === "1",
        result: stored.result || result,
      };
    }
    if (executed.ok && tuple[0] === "stale") continue;
    if (executed.ok && tuple[0] === "error") return { ok: false, error: clean(tuple[1], 80) || "storage_unavailable" };
    break;
  }
  if (!executed?.ok) {
    // The Lua script may have committed even when the REST response was lost.
    // Read the permanent record before reporting a failure: returning 503
    // after both the domain write and this journal commit succeeded would make
    // the caller believe an already-completed operation failed.
    const recoveredRaw = await redisCmd(["GET", storageKey]);
    const recovered = parseOperation(recoveredRaw, expectedOperationId);
    if (recovered?.state === "done"
      && recovered.requestHash === requestHash
      && recovered.result
      && typeof recovered.result === "object"
      && !Array.isArray(recovered.result) && typeof recovered.result.ok === "boolean") {
      return {
        ok: true,
        idempotent: true,
        recovered: true,
        result: recovered.result,
      };
    }
    return { ok: false, error: executed?.error || "storage_unavailable" };
  }
  return { ok: false, error: "operation_concurrent_update" };
}

function operationIdFromStorageKey(key) {
  const match = String(key || "").match(/^liumeiti:durable-operation:v1:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function parseOperation(raw, expectedOperationId = "") {
  if (!raw) return null;
  if (typeof raw === "object") {
    if (Array.isArray(raw)) return null;
    return expectedOperationId && raw.operationId !== expectedOperationId ? null : raw;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return expectedOperationId && parsed.operationId !== expectedOperationId ? null : parsed;
  } catch { return null; }
}

function checkedPipelineValues(response, expectedLength) {
  const rows = Array.isArray(response?.result) ? response.result : response;
  if (!Array.isArray(rows) || rows.length !== expectedLength) return null;
  const values = [];
  for (const row of rows) {
    if (row && typeof row === "object" && Object.hasOwn(row, "error") && row.error != null) return null;
    const value = row && typeof row === "object" && Object.hasOwn(row, "result") ? row.result : row;
    if (value && typeof value === "object" && Object.hasOwn(value, "error") && value.error != null) return null;
    values.push(value);
  }
  return values;
}

export async function backfillDurableOperationStartedIndex({ count = 100 } = {}) {
  const cursorRows = checkedPipelineValues(await redisPipeline([
    ["GET", OPERATION_BACKFILL_CURSOR],
    ["PING"],
  ]), 2);
  if (!cursorRows || cursorRows[1] !== "PONG") {
    return { ok: false, error: "durable_backfill_cursor_read_failed" };
  }
  const savedCursor = String(cursorRows[0] || "0");
  if (savedCursor === "done") return { ok: true, done: true, processed: 0, indexed: 0 };
  const safeCount = Math.max(10, Math.min(500, Number(count || 100)));
  const scan = await redisCmd(["SCAN", savedCursor, "MATCH", `${OPERATION_PREFIX}*`, "COUNT", String(safeCount)]);
  if (!Array.isArray(scan) || scan.length < 2 || !Array.isArray(scan[1])) {
    return { ok: false, error: "durable_backfill_scan_failed" };
  }
  const nextCursor = String(scan[0] || "0");
  const keys = scan[1].filter((key) => operationIdFromStorageKey(key));
  const rows = keys.length ? await redisPipeline(keys.map((key) => ["GET", key])) : [];
  const values = checkedPipelineValues(rows, keys.length);
  if (!values) return { ok: false, error: "durable_backfill_read_failed" };
  const commands = [];
  let indexed = 0;
  keys.forEach((key, index) => {
    const operationId = operationIdFromStorageKey(key);
    const record = parseOperation(values[index], operationId);
    if (values[index] != null && !(record && typeof record.requestHash === "string" && record.state === "done" && record.result && typeof record.result === "object" && !Array.isArray(record.result) && typeof record.result.ok === "boolean")) {
      const score = Date.parse(record?.createdAt || "");
      commands.push(["ZADD", OPERATION_STARTED_INDEX, String(Number.isFinite(score) ? score : Date.now()), operationId]);
      indexed += 1;
    } else {
      commands.push(["ZREM", OPERATION_STARTED_INDEX, operationId]);
    }
  });
  if (commands.length) {
    const written = checkedPipelineValues(await redisPipeline(commands), commands.length);
    if (!written || written.some((value) => value == null)) {
      return { ok: false, error: "durable_backfill_index_write_failed" };
    }
  }
  const cursorSaved = await redisCmd(["SET", OPERATION_BACKFILL_CURSOR, nextCursor === "0" ? "done" : nextCursor]);
  if (cursorSaved == null) return { ok: false, error: "durable_backfill_cursor_write_failed" };
  return { ok: true, done: nextCursor === "0", processed: keys.length, indexed, cursor: nextCursor };
}

// Persist the exact recipient/work plan before starting external effects. A
// retry therefore resumes the first plan even if the underlying query changes
// after a response is lost.
export async function ensureDurableOperationPlan(operation, plan) {
  const storageKey = clean(operation?.storageKey, 300);
  const requestHash = clean(operation?.record?.requestHash || operation?.requestHash, 80);
  const expectedOperationId = operationIdFromStorageKey(storageKey);
  const handleOperationId = clean(operation?.operationId, 80);
  const recordOperationId = clean(operation?.record?.operationId, 80);
  const operationId = handleOperationId || recordOperationId;
  if (!storageKey || !expectedOperationId || operationId !== expectedOperationId
    || (handleOperationId && handleOperationId !== expectedOperationId)
    || (recordOperationId && recordOperationId !== expectedOperationId)
    || !requestHash || !plan || typeof plan !== "object") {
    return { ok: false, error: "invalid_operation" };
  }
  const planCreatedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readOperationState(storageKey);
    if (!state.ok) return { ok: false, error: "storage_unavailable" };
    if (!state.exists) return { ok: false, error: "operation_record_missing" };
    const raw = state.raw;
    const current = parseOperation(raw, expectedOperationId);
    if (!current) return { ok: false, error: "operation_record_corrupt" };
    if (current.requestHash !== requestHash) return { ok: false, error: "idempotency_conflict" };
    const replacement = replaceTopLevelJsonFields(raw, { plan, planCreatedAt });
    if (!replacement) return { ok: false, error: "invalid_operation_plan" };
    const executed = await redisEvalAtomic(ENSURE_PLAN_SCRIPT, [storageKey], [requestHash, expectedOperationId, raw, replacement]);
    const tuple = Array.isArray(executed.value) ? executed.value : [];
    if (executed.ok && tuple[0] === "stale") continue;
    if (!executed.ok || tuple[0] !== "planned") {
      return { ok: false, error: tuple[0] === "error" ? clean(tuple[1], 80) : executed.error || "storage_unavailable" };
    }
    const record = parseOperation(tuple[1], expectedOperationId);
    if (!record) return { ok: false, error: "invalid_storage_response" };
    operation.record = record;
    return {
      ok: true,
      created: tuple[2] === "1",
      plan: record.plan,
      record,
    };
  }
  return { ok: false, error: "operation_concurrent_update" };
}

async function readOperationState(storageKey) {
  const values = checkedPipelineValues(await redisPipeline([
    ["GET", storageKey],
    ["PING"],
  ]), 2);
  if (!values || values[1] !== "PONG") return { ok: false, exists: false, raw: null };
  if (values[0] == null) return { ok: true, exists: false, raw: null };
  return typeof values[0] === "string"
    ? { ok: true, exists: true, raw: values[0] }
    : { ok: false, exists: true, raw: null };
}

export const durableOperationInternals = {
  OPERATION_BACKFILL_CURSOR,
  OPERATION_STARTED_INDEX,
  operationCoordinates,
  operationIdFromStorageKey,
};
