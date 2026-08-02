import { createHash } from "node:crypto";
import { clean } from "./_utils.js";
import { redisEvalAtomic } from "./_money.js";

const OPERATION_PREFIX = "liumeiti:durable-operation:v1:";

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
  return cjson.encode({ok=true,state=tostring(record.state or 'started'),record=record,isNew=false})
end
local record={
  version=1,
  state='started',
  operationId=ARGV[2],
  requestHash=ARGV[1],
  createdAt=ARGV[3]
}
redis.call('SET',KEYS[1],cjson.encode(record))
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

// Atomically binds an opaque client key to one exact payload forever. A
// `started` record deliberately has no expiry: after a process crash the same
// request can resume, while a changed request can never reuse the key.
export async function claimDurableOperation({ scope, principal, idempotencyKey, requestHash }) {
  const coordinates = operationCoordinates(scope, principal, idempotencyKey);
  const hash = clean(requestHash, 80);
  if (!coordinates || !hash) return { ok: false, error: "invalid_operation" };
  const executed = await redisEvalAtomic(CLAIM_SCRIPT, [coordinates.storageKey], [
    hash,
    coordinates.operationId,
    new Date().toISOString(),
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
  const executed = await redisEvalAtomic(COMPLETE_SCRIPT, [storageKey], [
    requestHash,
    JSON.stringify(result),
    new Date().toISOString(),
  ]);
  if (!executed.ok || !executed.value?.ok) {
    return { ok: false, error: executed.value?.error || executed.error || "storage_unavailable" };
  }
  return {
    ok: true,
    idempotent: Boolean(executed.value.idempotent),
    result: executed.value.record?.result || result,
  };
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

export const durableOperationInternals = { operationCoordinates };
