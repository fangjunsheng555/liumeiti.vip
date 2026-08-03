import { createHash } from "node:crypto";
import { clean, redisCmd, redisPipeline } from "./_utils.js";
import { redisEvalAtomic } from "./_money.js";

const OPERATION_PREFIX = "liumeiti:durable-operation:v1:";
const OPERATION_STARTED_INDEX = "liumeiti:durable-operation:v1:started-index";
const OPERATION_BACKFILL_CURSOR = "liumeiti:durable-operation:v1:started-index:backfill-cursor";

const CLAIM_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if raw then
  local ok,record=pcall(cjson.decode,raw)
  if not ok or type(record)~='table' or type(record.requestHash)~='string' then
    return cjson.encode({ok=false,error='operation_record_corrupt'})
  end
  if record.requestHash~=ARGV[1] then
    return cjson.encode({ok=false,error='idempotency_conflict'})
  end
  local state=tostring(record.state or 'started')
  if state=='done' then
    redis.call('ZREM',KEYS[2],ARGV[2])
  else
    redis.call('ZADD',KEYS[2],tonumber(record.startedAtMs or ARGV[4]),ARGV[2])
  end
  return cjson.encode({ok=true,state=state,record=record,isNew=false})
end
local record={
  version=1,
  state='started',
  operationId=ARGV[2],
  requestHash=ARGV[1],
  createdAt=ARGV[3],
  startedAtMs=tonumber(ARGV[4])
}
redis.call('SET',KEYS[1],cjson.encode(record))
redis.call('ZADD',KEYS[2],ARGV[4],ARGV[2])
return cjson.encode({ok=true,state='started',record=record,isNew=true})`;

const COMPLETE_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if not raw then return cjson.encode({ok=false,error='operation_record_missing'}) end
local ok,record=pcall(cjson.decode,raw)
if not ok or type(record)~='table' or type(record.requestHash)~='string' then
  return cjson.encode({ok=false,error='operation_record_corrupt'})
end
if record.requestHash~=ARGV[1] then
  return cjson.encode({ok=false,error='idempotency_conflict'})
end
if record.state=='done' then
  redis.call('ZREM',KEYS[2],tostring(record.operationId or ARGV[4]))
  return cjson.encode({ok=true,state='done',record=record,idempotent=true})
end
local resultOk,result=pcall(cjson.decode,ARGV[2])
if not resultOk or type(result)~='table' then
  return cjson.encode({ok=false,error='invalid_operation_result'})
end
record.state='done'
record.result=result
record.completedAt=ARGV[3]
redis.call('SET',KEYS[1],cjson.encode(record))
redis.call('ZREM',KEYS[2],tostring(record.operationId or ARGV[4]))
return cjson.encode({ok=true,state='done',record=record,idempotent=false})`;

const ENSURE_PLAN_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if not raw then return cjson.encode({ok=false,error='operation_record_missing'}) end
local ok,record=pcall(cjson.decode,raw)
if not ok or type(record)~='table' or type(record.requestHash)~='string' then
  return cjson.encode({ok=false,error='operation_record_corrupt'})
end
if record.requestHash~=ARGV[1] then
  return cjson.encode({ok=false,error='idempotency_conflict'})
end
if record.plan~=nil then
  return cjson.encode({ok=true,record=record,created=false})
end
local planOk,plan=pcall(cjson.decode,ARGV[2])
if not planOk or type(plan)~='table' then
  return cjson.encode({ok=false,error='invalid_operation_plan'})
end
record.plan=plan
record.planCreatedAt=ARGV[3]
redis.call('SET',KEYS[1],cjson.encode(record))
return cjson.encode({ok=true,record=record,created=true})`;

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
  const executed = await redisEvalAtomic(CLAIM_SCRIPT, [coordinates.storageKey, OPERATION_STARTED_INDEX], [
    hash,
    coordinates.operationId,
    now.toISOString(),
    String(now.getTime()),
  ]);
  if (!executed.ok || !executed.value?.ok) {
    return {
      ok: false,
      error: executed.value?.error || executed.error || "storage_unavailable",
      ...coordinates,
    };
  }
  return {
    ok: true,
    state: executed.value.state,
    isNew: Boolean(executed.value.isNew),
    record: executed.value.record || {},
    ...coordinates,
  };
}

export async function completeDurableOperation(operation, result) {
  const storageKey = clean(operation?.storageKey, 300);
  const requestHash = clean(operation?.record?.requestHash || operation?.requestHash, 80);
  if (!storageKey || !requestHash || !result || typeof result !== "object") {
    return { ok: false, error: "invalid_operation" };
  }
  const executed = await redisEvalAtomic(COMPLETE_SCRIPT, [storageKey, OPERATION_STARTED_INDEX], [
    requestHash,
    JSON.stringify(result),
    new Date().toISOString(),
    clean(operation?.operationId || operation?.record?.operationId, 80),
  ]);
  if (!executed.ok || !executed.value?.ok) {
    // The Lua script may have committed even when the REST response was lost.
    // Read the permanent record before reporting a failure: returning 503
    // after both the domain write and this journal commit succeeded would make
    // the caller believe an already-completed operation failed.
    const recoveredRaw = await redisCmd(["GET", storageKey]);
    const recovered = parseOperation(recoveredRaw);
    if (recovered?.state === "done"
      && recovered.requestHash === requestHash
      && recovered.result
      && typeof recovered.result === "object"
      && !Array.isArray(recovered.result)) {
      return {
        ok: true,
        idempotent: true,
        recovered: true,
        result: recovered.result,
      };
    }
    return { ok: false, error: executed.value?.error || executed.error || "storage_unavailable" };
  }
  return {
    ok: true,
    idempotent: Boolean(executed.value.idempotent),
    result: executed.value.record?.result || result,
  };
}

function operationIdFromStorageKey(key) {
  const match = String(key || "").match(/^liumeiti:durable-operation:v1:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function parseOperation(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
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
    const record = parseOperation(values[index]);
    if (record && String(record.state || "started") !== "done") {
      const score = Date.parse(record.createdAt || "");
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
  if (!storageKey || !requestHash || !plan || typeof plan !== "object") {
    return { ok: false, error: "invalid_operation" };
  }
  const executed = await redisEvalAtomic(ENSURE_PLAN_SCRIPT, [storageKey], [
    requestHash,
    JSON.stringify(plan),
    new Date().toISOString(),
  ]);
  if (!executed.ok || !executed.value?.ok) {
    return { ok: false, error: executed.value?.error || executed.error || "storage_unavailable" };
  }
  operation.record = executed.value.record || operation.record || {};
  return {
    ok: true,
    created: Boolean(executed.value.created),
    plan: operation.record.plan,
    record: operation.record,
  };
}

export const durableOperationInternals = {
  OPERATION_BACKFILL_CURSOR,
  OPERATION_STARTED_INDEX,
  operationCoordinates,
  operationIdFromStorageKey,
};
