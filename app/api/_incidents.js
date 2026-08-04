import { createHash, randomBytes } from "node:crypto";
import { clean, redisCmd, redisPipeline } from "./_utils.js";

const INCIDENT_INDEX_KEY = "lm:incident:index:v1";
const INCIDENT_RECORD_PREFIX = "lm:incident:record:v1:";
const INCIDENT_FINGERPRINT_PREFIX = "lm:incident:fingerprint:v1:";
const INCIDENT_EVENT_PREFIX = "lm:incident:events:v1:";
const INCIDENT_HEALTHY_PREFIX = "lm:incident:healthy:v1:";
const MAX_EVENTS = 100;
const OPEN_STATUSES = new Set(["open", "acknowledged", "investigating", "recovered", "reopened"]);
const INCIDENT_STATUSES = new Set([...OPEN_STATUSES, "resolved"]);

const CREATE_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'zset') or not validtype(KEYS[4],'list') then return cjson.encode({ok=false,error='storage_type_error'}) end
local score=tonumber(ARGV[3]); local limit=tonumber(ARGV[5])
if not score or score~=score or score<-9007199254740991 or score>9007199254740991 or not limit or limit~=math.floor(limit) or limit<1 or limit>10000 then return cjson.encode({ok=false,error='invalid_incident'}) end
local mapped=redis.call('GET',KEYS[1])
if mapped then
  local encodedOk,encoded=pcall(cjson.encode,{ok=false,error='fingerprint_conflict',incidentId=mapped})
  if not encodedOk then return redis.error_reply('incident_response_encode_failed') end
  return encoded
end
if redis.call('EXISTS',KEYS[2])==1 then return cjson.encode({ok=false,error='incident_id_conflict'}) end
local recordOk,record=pcall(cjson.decode,ARGV[2])
if not recordOk or type(record)~='table' or tostring(record.id or '')~=ARGV[1] then return cjson.encode({ok=false,error='invalid_incident'}) end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('SET',KEYS[2],ARGV[2])
redis.call('ZADD',KEYS[3],ARGV[3],ARGV[1])
redis.call('LPUSH',KEYS[4],ARGV[4])
redis.call('LTRIM',KEYS[4],0,limit-1)
return cjson.encode({ok=true})`;

const UPDATE_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') or not validtype(KEYS[3],'list') then return cjson.encode({ok=false,error='storage_type_error'}) end
local limit=tonumber(ARGV[6]); local mappingAction=tostring(ARGV[3] or 'keep')
if not limit or limit~=math.floor(limit) or limit<1 or limit>10000 or (mappingAction~='keep' and mappingAction~='claim' and mappingAction~='release') then return cjson.encode({ok=false,error='invalid_incident'}) end
local raw=redis.call('GET',KEYS[1])
if not raw then return cjson.encode({ok=false,error='incident_not_found'}) end
local ok,current=pcall(cjson.decode,raw)
if not ok or type(current)~='table' or tostring(current.id or '')~=ARGV[4] then return cjson.encode({ok=false,error='incident_record_corrupt'}) end
if tonumber(current.version or 0)~=tonumber(ARGV[1]) then
  local encodedOk,encoded=pcall(cjson.encode,{ok=false,error='stale_version',current=current})
  if not encodedOk then return redis.error_reply('incident_response_encode_failed') end
  return encoded
end
local nextOk,next=pcall(cjson.decode,ARGV[2])
if not nextOk or type(next)~='table' or tostring(next.id or '')~=ARGV[4] or tostring(next.fingerprint or '')~=tostring(current.fingerprint or '') then return cjson.encode({ok=false,error='invalid_incident'}) end
local responseOk,response=pcall(cjson.encode,{ok=true,record=next})
if not responseOk then return redis.error_reply('incident_response_encode_failed') end
if mappingAction=='claim' then
  local mapped=redis.call('GET',KEYS[2])
  if mapped and mapped~=ARGV[4] then
    local encodedOk,encoded=pcall(cjson.encode,{ok=false,error='fingerprint_conflict',incidentId=mapped})
    if not encodedOk then return redis.error_reply('incident_response_encode_failed') end
    return encoded
  end
  redis.call('SET',KEYS[2],ARGV[4])
elseif mappingAction=='release' then
  if redis.call('GET',KEYS[2])==ARGV[4] then redis.call('DEL',KEYS[2]) end
end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('LPUSH',KEYS[3],ARGV[5])
redis.call('LTRIM',KEYS[3],0,limit-1)
return response`;

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry
  ));
}

function storageError(code = "incident_store_unavailable") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function strictPipelineRows(value, expected, code = "incident_store_unavailable") {
  if (!Array.isArray(value) || value.length !== expected) throw storageError(code);
  return value.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) throw storageError(code);
    const result = entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
    if (result === undefined) throw storageError(code);
    return result;
  });
}

function parseStoredRecord(value, code = "incident_record_corrupt") {
  if (value == null || value === "") return null;
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw storageError(code);
  return parsed;
}

function parseIncidentRecord(value, expectedId = "", expectedFingerprint = "") {
  const record = parseStoredRecord(value, "incident_record_corrupt");
  if (!record) return null;
  const id = clean(record.id, 80).toUpperCase();
  const fingerprint = normalizeFingerprint(record.fingerprint);
  const valid = Boolean(id) && id === record.id
    && (!expectedId || id === clean(expectedId, 80).toUpperCase())
    && Boolean(fingerprint) && fingerprint === record.fingerprint
    && (!expectedFingerprint || fingerprint === normalizeFingerprint(expectedFingerprint))
    && INCIDENT_STATUSES.has(record.status)
    && Number.isSafeInteger(Number(record.version))
    && Number(record.version) >= 1;
  if (!valid) throw storageError("incident_record_corrupt");
  return record;
}

function parseIncidentEvent(value) {
  const event = parseStoredRecord(value, "incident_event_corrupt");
  const valid = event
    && Boolean(clean(event.id, 80))
    && Boolean(clean(event.type, 40))
    && INCIDENT_STATUSES.has(event.status)
    && Number.isFinite(Date.parse(event.at || ""));
  if (!valid) throw storageError("incident_event_corrupt");
  return event;
}

function normalizeFingerprint(value) {
  return clean(value, 200).toLowerCase().replace(/[^a-z0-9:_-]/g, "_");
}

function fingerprintHash(value) {
  return createHash("sha256").update(normalizeFingerprint(value)).digest("hex");
}

function fingerprintKey(value) {
  return INCIDENT_FINGERPRINT_PREFIX + fingerprintHash(value);
}

function recordKey(id) {
  return INCIDENT_RECORD_PREFIX + clean(id, 80).toUpperCase();
}

function eventKey(id) {
  return INCIDENT_EVENT_PREFIX + clean(id, 80).toUpperCase();
}

function makeIncidentId() {
  return `INC${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`;
}

function actorSnapshot(actor) {
  return {
    staffId: Math.max(0, Number(actor?.staffId || 0)),
    staffUsername: clean(actor?.staffUsername || (actor?.staffId ? "staff" : "system"), 60),
  };
}

function safeSeverity(value) {
  return ["P1", "P2", "P3"].includes(value) ? value : "P2";
}

function safeDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = ["runId", "operationId", "durationMs", "ageMs", "expectedIntervalMs", "missedAfterMs", "count", "dueCount", "oldestAgeMs", "route", "requests", "status5xx", "errorRate", "p95Ms"];
  const out = {};
  for (const key of allowed) {
    const item = value[key];
    if (typeof item === "number" || typeof item === "boolean") out[key] = item;
    else if (item != null) out[key] = clean(item, 120);
  }
  return out;
}

function incidentEvent(type, record, actor = null, detail = {}) {
  const at = new Date().toISOString();
  return {
    id: `IE${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`,
    type: clean(type, 40),
    status: clean(record?.status, 30),
    severity: safeSeverity(record?.severity),
    actor: actorSnapshot(actor),
    detail: safeDetail(detail),
    at,
  };
}

async function compareAndSet(record, expectedVersion, { mappingAction = "keep", event } = {}) {
  try { parseIncidentRecord(record, record?.id, record?.fingerprint); } catch { return { ok: false, error: "invalid_incident" }; }
  const nextEvent = event || incidentEvent("updated", record);
  const raw = await redisCmd([
    "EVAL", UPDATE_SCRIPT, "3",
    recordKey(record.id), fingerprintKey(record.fingerprint), eventKey(record.id),
    String(expectedVersion), JSON.stringify(record), mappingAction, record.id, JSON.stringify(nextEvent), String(MAX_EVENTS),
  ]);
  const result = parseJson(raw);
  let returned = null;
  try { returned = result?.ok ? parseIncidentRecord(result.record || record, record.id, record.fingerprint) : null; } catch { return { ok: false, error: "storage_unavailable" }; }
  return result?.ok && returned ? { ok: true, record: returned } : {
    ok: false,
    error: result?.error || "storage_unavailable",
    current: result?.current || null,
    incidentId: clean(result?.incidentId, 80),
  };
}

async function releaseFingerprintMapping(fingerprint, incidentId) {
  const release = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  const raw = await redisCmd(["EVAL", release, "1", fingerprintKey(fingerprint), clean(incidentId, 80).toUpperCase()]);
  if (raw == null) throw storageError();
  return Number(raw) > 0;
}

async function readMappedIncident(fingerprint) {
  const mapping = strictPipelineRows(await redisPipeline([
    ["GET", fingerprintKey(fingerprint)],
    ["PING"],
  ]), 2);
  if (mapping[1] !== "PONG") throw storageError();
  const id = clean(mapping[0], 80).toUpperCase();
  if (!id) return null;
  const stored = strictPipelineRows(await redisPipeline([
    ["GET", recordKey(id)],
    ["PING"],
  ]), 2);
  if (stored[1] !== "PONG") throw storageError();
  let record = null;
  try { record = parseIncidentRecord(stored[0], id, fingerprint); } catch (error) {
    if (error?.code !== "incident_record_corrupt") throw error;
    console.warn(`[incidents] ignored corrupt fingerprint target ${id}`);
    return { id, missing: true, corrupt: true };
  }
  if (!record) return { id, missing: true };
  return record;
}

async function recoverCreatedIncident({ fingerprint, id, recordRaw, eventRaw, score }) {
  let recovered;
  try {
    recovered = strictPipelineRows(await redisPipeline([
      ["GET", fingerprintKey(fingerprint)],
      ["GET", recordKey(id)],
      ["ZSCORE", INCIDENT_INDEX_KEY, id],
      ["LINDEX", eventKey(id), "0"],
      ["PING"],
    ]), 5);
  } catch {
    return false;
  }
  return recovered[0] === id
    && recovered[1] === recordRaw
    && recovered[2] != null
    && Number(recovered[2]) === score
    && recovered[3] === eventRaw
    && recovered[4] === "PONG";
}

async function createIncident(input) {
  const now = new Date();
  const fingerprint = normalizeFingerprint(input.fingerprint);
  const id = makeIncidentId();
  const record = {
    id,
    fingerprint,
    severity: safeSeverity(input.severity),
    status: "open",
    component: clean(input.component || "system", 60),
    title: clean(input.title || "系统异常", 160),
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    occurrences: 1,
    ownerStaffId: 0,
    ownerStaffUsername: "",
    acknowledgedAt: "",
    acknowledgedBy: null,
    recoveredAt: "",
    resolvedAt: "",
    resolvedBy: null,
    resolution: "",
    lastErrorCode: clean(input.errorCode, 160),
    detail: safeDetail(input.detail),
    businessTraceId: clean(input.businessTraceId, 40),
    version: 1,
  };
  const openedEvent = incidentEvent("opened", record, null, record.detail);
  const recordRaw = JSON.stringify(record);
  const eventRaw = JSON.stringify(openedEvent);
  const savedRaw = await redisCmd([
    "EVAL", CREATE_SCRIPT, "4",
    fingerprintKey(fingerprint), recordKey(id), INCIDENT_INDEX_KEY, eventKey(id),
    id, recordRaw, String(now.getTime()), eventRaw, String(MAX_EVENTS),
  ]);
  const saved = parseJson(savedRaw);
  if (!saved?.ok) {
    if (savedRaw == null && await recoverCreatedIncident({
      fingerprint,
      id,
      recordRaw,
      eventRaw,
      score: now.getTime(),
    })) {
      return { ok: true, record, created: true, recovered: true };
    }
    return saved?.error === "fingerprint_conflict"
      ? { ok: false, conflict: true, incidentId: clean(saved.incidentId, 80) }
      : { ok: false, error: saved?.error || "storage_unavailable" };
  }
  return { ok: true, record, created: true };
}

async function updateOccurrence(current, input) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!current || !OPEN_STATUSES.has(current.status)) {
      return { ok: false, closed: true, error: "incident_closed", current: current || null };
    }
    const expectedVersion = Number(current.version || 0);
    const now = new Date().toISOString();
    const wasRecovered = current.status === "recovered";
    const next = {
      ...current,
      severity: safeSeverity(input.severity || current.severity),
      status: wasRecovered ? "reopened" : current.status,
      title: clean(input.title || current.title, 160),
      component: clean(input.component || current.component, 60),
      lastSeenAt: now,
      occurrences: Math.max(0, Number(current.occurrences || 0)) + 1,
      recoveredAt: wasRecovered ? "" : current.recoveredAt,
      lastErrorCode: clean(input.errorCode || current.lastErrorCode, 160),
      detail: safeDetail(input.detail || current.detail),
      businessTraceId: clean(input.businessTraceId || current.businessTraceId, 40),
      version: expectedVersion + 1,
    };
    const saved = await compareAndSet(next, expectedVersion, {
      event: incidentEvent(wasRecovered ? "reopened" : "repeated", next, null, next.detail),
    });
    if (saved.ok) {
      return { ok: true, record: next, created: false, reopened: wasRecovered };
    }
    if (saved.error !== "stale_version" || !saved.current) return saved;
    current = saved.current;
  }
  return { ok: false, error: "stale_version" };
}

export async function openOrUpdateIncident(input = {}) {
  const fingerprint = normalizeFingerprint(input.fingerprint);
  if (!fingerprint) return { ok: false, error: "fingerprint_required" };
  const cleared = await redisCmd(["DEL", INCIDENT_HEALTHY_PREFIX + fingerprintHash(fingerprint)]);
  if (cleared == null) return { ok: false, error: "incident_health_state_unavailable" };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await readMappedIncident(fingerprint);
    if (existing && !existing.missing && OPEN_STATUSES.has(existing.status)) {
      const updated = await updateOccurrence(existing, input);
      if (updated.ok) return updated;
      if (!updated.closed) return updated;
      // A concurrent resolve won the occurrence CAS and atomically released
      // the fingerprint. Loop back, reread the mapping, and create a fresh
      // lifecycle instead of resurrecting the resolved record.
      continue;
    }
    if (existing?.missing) {
      await releaseFingerprintMapping(fingerprint, existing.id);
    } else if (existing && !OPEN_STATUSES.has(existing.status)) {
      // A resolved incident keeps its permanent record but must release the
      // fingerprint claim. The compare-delete prevents this recovery path
      // from erasing a newer incident created concurrently.
      await releaseFingerprintMapping(fingerprint, existing.id);
    }
    const created = await createIncident({ ...input, fingerprint });
    if (created.ok) return created;
    if (!created.conflict) return created;
  }
  return { ok: false, error: "incident_claim_conflict" };
}

export async function getIncident(id) {
  const safeId = clean(id, 80).toUpperCase();
  if (!safeId) return null;
  const stored = strictPipelineRows(await redisPipeline([
    ["GET", recordKey(safeId)],
    ["PING"],
  ]), 2);
  if (stored[1] !== "PONG") throw storageError();
  try { return parseIncidentRecord(stored[0], safeId); } catch (error) {
    if (error?.code !== "incident_record_corrupt") throw error;
    console.warn(`[incidents] ignored corrupt incident record ${safeId}`);
    return null;
  }
}

export async function transitionIncident(id, input = {}, actor = {}) {
  const action = clean(input.action, 30).toLowerCase();
  const current = await getIncident(id);
  if (!current) return { ok: false, error: "incident_not_found" };
  const operationId = clean(input.operationId, 80);
  if (operationId && current.lastOperationId === operationId) {
    return { ok: true, record: current, idempotent: true };
  }
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== Number(current.version || 0)) {
    return { ok: false, error: "stale_version", current };
  }
  const now = new Date().toISOString();
  const staff = actorSnapshot(actor);
  const next = {
    ...current,
    version: expectedVersion + 1,
    ...(operationId ? { lastOperationId: operationId, lastOperationAt: now } : {}),
  };

  if (action === "acknowledge") {
    if (!["open", "reopened"].includes(current.status)) return { ok: false, error: "invalid_incident_transition" };
    next.status = "acknowledged";
    next.acknowledgedAt = now;
    next.acknowledgedBy = staff;
    if (!next.ownerStaffId && staff.staffId) {
      next.ownerStaffId = staff.staffId;
      next.ownerStaffUsername = staff.staffUsername;
    }
  } else if (action === "assign") {
    if (current.status === "resolved") return { ok: false, error: "invalid_incident_transition" };
    const ownerStaffId = Math.max(0, Number(input.ownerStaffId || 0));
    next.ownerStaffId = ownerStaffId;
    next.ownerStaffUsername = ownerStaffId ? clean(input.ownerStaffUsername || staff.staffUsername, 60) : "";
  } else if (action === "investigate") {
    if (!["open", "acknowledged", "reopened"].includes(current.status)) return { ok: false, error: "invalid_incident_transition" };
    next.status = "investigating";
    if (!next.acknowledgedAt) {
      next.acknowledgedAt = now;
      next.acknowledgedBy = staff;
    }
    if (!next.ownerStaffId && staff.staffId) {
      next.ownerStaffId = staff.staffId;
      next.ownerStaffUsername = staff.staffUsername;
    }
  } else if (action === "recover") {
    if (!["open", "acknowledged", "investigating", "reopened"].includes(current.status)) return { ok: false, error: "invalid_incident_transition" };
    next.status = "recovered";
    next.recoveredAt = now;
  } else if (action === "resolve") {
    const resolution = clean(input.resolution, 1000);
    if (resolution.length < 3) return { ok: false, error: "resolution_required" };
    if (current.status === "resolved") return { ok: true, record: current, idempotent: true };
    next.status = "resolved";
    next.resolvedAt = now;
    next.resolvedBy = staff;
    next.resolution = resolution;
  } else if (action === "reopen") {
    if (!["resolved", "recovered"].includes(current.status)) return { ok: false, error: "invalid_incident_transition" };
    next.status = "reopened";
    next.recoveredAt = "";
    next.resolvedAt = "";
    next.resolvedBy = null;
    next.resolution = "";
    next.lastSeenAt = now;
  } else {
    return { ok: false, error: "invalid_action" };
  }

  const mappingAction = action === "resolve" ? "release" : action === "reopen" ? "claim" : "keep";
  const eventDetail = { ...(input.detail && typeof input.detail === "object" ? input.detail : {}), ...(operationId ? { operationId } : {}) };
  const saved = await compareAndSet(next, expectedVersion, {
    mappingAction,
    event: incidentEvent(action, next, staff, eventDetail),
  });
  if (!saved.ok) return saved;
  return { ok: true, record: next };
}

export async function incidentEvents(id, limit = MAX_EVENTS) {
  const safeId = clean(id, 80).toUpperCase();
  const safeLimit = Math.max(1, Math.min(MAX_EVENTS, Number(limit || MAX_EVENTS)));
  if (!safeId) return [];
  const result = strictPipelineRows(await redisPipeline([
    ["LRANGE", eventKey(safeId), "0", String(safeLimit - 1)],
    ["PING"],
  ]), 2, "incident_events_unavailable");
  const rows = result[0];
  if (!Array.isArray(rows) || result[1] !== "PONG") throw storageError("incident_events_unavailable");
  const events = [];
  let corruptCount = 0;
  for (const value of rows) {
    try { events.push(parseIncidentEvent(value)); } catch (error) {
      if (error?.code !== "incident_event_corrupt") throw error;
      corruptCount += 1;
    }
  }
  if (corruptCount) console.warn(`[incidents] ignored ${corruptCount} corrupt event(s) for ${safeId}`);
  return events;
}

export async function listIncidents({ status = "all", severity = "all", offset = 0, limit = 50 } = {}) {
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  const scanLimit = Math.min(1000, Math.max(safeOffset + safeLimit, 200));
  const index = strictPipelineRows(await redisPipeline([
    ["ZREVRANGE", INCIDENT_INDEX_KEY, "0", String(scanLimit - 1)],
    ["PING"],
  ]), 2, "incident_list_unavailable");
  const ids = index[0];
  if (!Array.isArray(ids) || index[1] !== "PONG") throw storageError("incident_list_unavailable");
  if (ids.some((id, index) => clean(id, 80).toUpperCase() !== id || ids.indexOf(id) !== index)) throw storageError("incident_record_corrupt");
  if (!ids.length) return { incidents: [], total: 0, counts: {}, diagnostics: { corruptCount: 0, missingCount: 0 } };
  const rows = strictPipelineRows(
    await redisPipeline(ids.map((incidentId) => ["GET", recordKey(incidentId)])),
    ids.length,
    "incident_list_unavailable",
  );
  let corruptCount = 0;
  let missingCount = 0;
  let records = [];
  rows.forEach((value, index) => {
    if (value == null) {
      missingCount += 1;
      return;
    }
    try {
      const record = parseIncidentRecord(value, ids[index]);
      if (!record) {
        corruptCount += 1;
        console.warn(`[incidents] ignored empty indexed incident ${clean(ids[index], 80).toUpperCase()}`);
        return;
      }
      records.push(record);
    } catch (error) {
      if (error?.code !== "incident_record_corrupt") throw error;
      corruptCount += 1;
      console.warn(`[incidents] ignored corrupt indexed incident ${clean(ids[index], 80).toUpperCase()}`);
    }
  });
  const counts = records.reduce((out, record) => {
    out[record.status] = (out[record.status] || 0) + 1;
    return out;
  }, {});
  if (status !== "all") records = records.filter((record) => record.status === status);
  if (severity !== "all") records = records.filter((record) => record.severity === severity);
  return {
    incidents: records.slice(safeOffset, safeOffset + safeLimit),
    total: records.length,
    counts,
    diagnostics: { corruptCount, missingCount },
  };
}

export async function reportOperationalFailure(input = {}) {
  const result = await openOrUpdateIncident(input);
  if (result.ok && (result.created || result.reopened)) {
    try {
      const telegram = await import("./_telegram-alerts.js");
      const alert = await telegram.notifyIncidentOpened(result.record, { reopened: Boolean(result.reopened) });
      if (alert?.ok !== true) {
        return {
          ...result,
          ok: false,
          incidentRecorded: true,
          alertOk: false,
          error: "incident_alert_failed",
          alertError: clean(alert?.error || "telegram_alert_failed", 160),
          alert,
        };
      }
      return { ...result, alertOk: true, alert };
    } catch (error) {
      return {
        ...result,
        ok: false,
        incidentRecorded: true,
        alertOk: false,
        error: "incident_alert_failed",
        alertError: clean(error?.code || error?.message || "telegram_alert_failed", 160),
      };
    }
  }
  return result;
}

export async function reportOperationalRecovery(input = {}) {
  const fingerprint = normalizeFingerprint(input.fingerprint);
  if (!fingerprint) return { ok: false, error: "fingerprint_required" };
  let current = await readMappedIncident(fingerprint);
  if (!current || current.missing || !["open", "acknowledged", "investigating", "reopened"].includes(current.status)) {
    return { ok: true, skipped: true, reason: "no_open_incident" };
  }
  const streakKey = INCIDENT_HEALTHY_PREFIX + fingerprintHash(fingerprint);
  const streakRaw = await redisCmd(["INCR", streakKey]);
  const streak = Number(streakRaw);
  if (streakRaw == null || !Number.isFinite(streak) || streak <= 0) {
    return { ok: false, error: "incident_health_state_unavailable" };
  }
  if (streak === 1) {
    const expires = await redisCmd(["EXPIRE", streakKey, String(24 * 60 * 60)]);
    if (Number(expires) !== 1) return { ok: false, error: "incident_health_state_unavailable", streak };
  }
  if (streak < 3) return { ok: true, pending: true, streak };
  let recovered = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    recovered = await transitionIncident(current.id, {
      action: "recover",
      expectedVersion: Number(current.version || 0),
    }, { staffId: 0, staffUsername: "monitor" });
    if (recovered.ok || recovered.error !== "stale_version") break;
    current = await getIncident(current.id);
    if (!current) return { ok: false, error: "incident_not_found", streak };
    if (current.status === "recovered" || current.status === "resolved") {
      return { ok: true, record: current, idempotent: true, streak };
    }
    if (!["open", "acknowledged", "investigating", "reopened"].includes(current.status)) {
      return { ok: false, error: "invalid_incident_transition", current, streak };
    }
  }
  if (!recovered) return { ok: false, error: "incident_recovery_failed", streak };
  if (recovered.ok) {
    try {
      const telegram = await import("./_telegram-alerts.js");
      const alert = await telegram.notifyIncidentRecovered(recovered.record);
      if (alert?.ok !== true) {
        return {
          ...recovered,
          ok: false,
          incidentRecorded: true,
          alertOk: false,
          error: "incident_alert_failed",
          alertError: clean(alert?.error || "telegram_alert_failed", 160),
          alert,
          streak,
        };
      }
      return { ...recovered, alertOk: true, alert, streak };
    } catch (error) {
      return {
        ...recovered,
        ok: false,
        incidentRecorded: true,
        alertOk: false,
        error: "incident_alert_failed",
        alertError: clean(error?.code || error?.message || "telegram_alert_failed", 160),
        streak,
      };
    }
  }
  return { ...recovered, streak };
}

export const incidentInternals = {
  INCIDENT_FINGERPRINT_PREFIX,
  INCIDENT_INDEX_KEY,
  INCIDENT_RECORD_PREFIX,
  OPEN_STATUSES,
  actorSnapshot,
  fingerprintHash,
  normalizeFingerprint,
  safeDetail,
};
