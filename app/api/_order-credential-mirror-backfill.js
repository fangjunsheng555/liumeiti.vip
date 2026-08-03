import { randomBytes } from "node:crypto";
import {
  ORDERS_KEY,
  ORDER_INDEX_KEY,
  ORDER_RECORD_PREFIX,
  redisConfig,
  redisPipeline,
  setOrderAt,
} from "./_utils.js";

const CURSOR_KEY = "lm:orders:credential-mirror-backfill:v1";
const LOCK_KEY = "lm:orders:credential-mirror-backfill-lock:v1";
const LOCK_TTL_SEC = 90;
const MAX_BATCH_SIZE = 50;
const MAX_CAS_ATTEMPTS = 3;

function pipelineValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
    ? entry.result
    : entry;
}

async function strictPipeline(commands) {
  if (!redisConfig()) throw new Error("order_credential_backfill_store_unavailable");
  const response = await redisPipeline([...commands, ["PING"]]);
  if (!Array.isArray(response) || response.length !== commands.length + 1) {
    throw new Error("order_credential_backfill_store_unavailable");
  }
  if (response.some((entry) => entry && typeof entry === "object" && entry.error)) {
    throw new Error("order_credential_backfill_store_unavailable");
  }
  if (pipelineValue(response[response.length - 1]) !== "PONG") {
    throw new Error("order_credential_backfill_store_unavailable");
  }
  return response.slice(0, -1).map(pipelineValue);
}

function normalizeOrderId(value) {
  return String(value || "").replace(/[\x00-\x1f\x7f\s]/g, "").slice(0, 80).toUpperCase();
}

function parseOrder(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const order = JSON.parse(raw);
    return order && typeof order === "object" && !Array.isArray(order) ? order : null;
  } catch {
    return null;
  }
}

function parseCursor(raw) {
  if (raw == null) return { raw: null, phase: "legacy", offset: 0 };
  if (typeof raw !== "string") throw new Error("order_credential_backfill_cursor_corrupt");
  let cursor;
  try { cursor = JSON.parse(raw); } catch { throw new Error("order_credential_backfill_cursor_corrupt"); }
  const phase = cursor?.phase;
  const offset = Number(cursor?.offset);
  if (!["legacy", "records", "done"].includes(phase)
      || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("order_credential_backfill_cursor_corrupt");
  }
  return { raw, phase, offset };
}

export function mirrorPrimaryItemCredentials(order) {
  if (!order || typeof order !== "object" || !Array.isArray(order.items) || order.items.length === 0) {
    return { changed: false, order };
  }
  const primary = order.items[0] && typeof order.items[0] === "object" ? order.items[0] : {};
  const mirrored = {
    account: primary.account || "",
    password: primary.password || "",
    staffAccount: primary.staffAccount || "",
    staffPassword: primary.staffPassword || "",
  };
  const changed = Object.entries(mirrored).some(([key, value]) => (order[key] || "") !== value);
  return changed ? { changed: true, order: { ...order, ...mirrored } } : { changed: false, order };
}

const ADVANCE_CURSOR_SCRIPT = `
local lock=redis.call('GET',KEYS[1])
if lock~=ARGV[1] then return cjson.encode({ok=false,error='lock_lost'}) end
local current=redis.call('GET',KEYS[2])
local absent='__LM_CURSOR_ABSENT__'
local expected=ARGV[2]
if (not current and expected~=absent) or (current and current~=expected) then
  return cjson.encode({ok=false,error='stale_cursor'})
end
redis.call('SET',KEYS[2],ARGV[3])
return cjson.encode({ok=true})
`;

const RENEW_LOCK_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end";
const RELEASE_LOCK_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

function parseEvalResult(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return null; }
}

async function defaultAcquireLock(token) {
  const [acquired, owner] = await strictPipeline([
    ["SET", LOCK_KEY, token, "NX", "EX", String(LOCK_TTL_SEC)],
    ["GET", LOCK_KEY],
  ]);
  if (acquired === "OK" && owner === token) return { acquired: true };
  if (owner) return { acquired: false, busy: true };
  throw new Error("order_credential_backfill_lock_unavailable");
}

async function defaultRenewLock(token) {
  const [result] = await strictPipeline([
    ["EVAL", RENEW_LOCK_SCRIPT, "1", LOCK_KEY, token, String(LOCK_TTL_SEC)],
  ]);
  return Number(result) === 1;
}

async function defaultReleaseLock(token) {
  try {
    const [released] = await strictPipeline([
      ["EVAL", RELEASE_LOCK_SCRIPT, "1", LOCK_KEY, token],
    ]);
    return Number(released) > 0;
  } catch {
    return false;
  }
}

async function defaultReadCursor() {
  const [raw] = await strictPipeline([["GET", CURSOR_KEY]]);
  return parseCursor(raw);
}

async function defaultReadPage(cursor, count) {
  const stop = cursor.offset + count - 1;
  if (cursor.phase === "legacy") {
    const [rows] = await strictPipeline([["LRANGE", ORDERS_KEY, String(cursor.offset), String(stop)]]);
    if (!Array.isArray(rows)) throw new Error("order_credential_backfill_legacy_read_failed");
    return rows.map((raw, index) => {
      const order = parseOrder(raw);
      if (!order) throw new Error("order_credential_backfill_order_corrupt");
      const orderId = normalizeOrderId(order.orderId);
      if (!orderId) throw new Error("order_credential_backfill_order_corrupt");
      return { orderId, legacyIndex: cursor.offset + index };
    });
  }
  const [ids] = await strictPipeline([["LRANGE", ORDER_INDEX_KEY, String(cursor.offset), String(stop)]]);
  if (!Array.isArray(ids)) throw new Error("order_credential_backfill_index_read_failed");
  return ids.map((value) => {
    const orderId = normalizeOrderId(value);
    if (!orderId) throw new Error("order_credential_backfill_index_corrupt");
    return { orderId, legacyIndex: null };
  });
}

async function defaultReadOrder(handle) {
  const commands = [["GET", ORDER_RECORD_PREFIX + handle.orderId]];
  if (Number.isInteger(handle.legacyIndex)) {
    commands.push(["LINDEX", ORDERS_KEY, String(handle.legacyIndex)]);
  }
  const values = await strictPipeline(commands);
  const recordRaw = values[0];
  const legacyRaw = Number.isInteger(handle.legacyIndex) ? values[1] : null;
  const order = parseOrder(recordRaw) || parseOrder(legacyRaw);
  if (!order || normalizeOrderId(order.orderId) !== handle.orderId) {
    throw new Error("order_credential_backfill_order_unavailable");
  }
  return { order, index: { orderId: handle.orderId, legacyIndex: handle.legacyIndex } };
}

async function defaultSaveOrder(index, order, expectedRevision) {
  return setOrderAt(index, order, { expectedRevision });
}

async function defaultAdvanceCursor(token, cursor, nextCursor) {
  const nextRaw = JSON.stringify({ phase: nextCursor.phase, offset: nextCursor.offset });
  const [result] = await strictPipeline([[
    "EVAL", ADVANCE_CURSOR_SCRIPT, "2", LOCK_KEY, CURSOR_KEY,
    token, cursor.raw == null ? "__LM_CURSOR_ABSENT__" : cursor.raw, nextRaw,
  ]]);
  const parsed = parseEvalResult(result);
  if (!parsed?.ok) throw new Error(parsed?.error || "order_credential_backfill_cursor_write_failed");
  return { raw: nextRaw, phase: nextCursor.phase, offset: nextCursor.offset };
}

const defaultDependencies = {
  acquireLock: defaultAcquireLock,
  renewLock: defaultRenewLock,
  releaseLock: defaultReleaseLock,
  readCursor: defaultReadCursor,
  readPage: defaultReadPage,
  readOrder: defaultReadOrder,
  saveOrder: defaultSaveOrder,
  advanceCursor: defaultAdvanceCursor,
};

function canContinue({ deadlineAt, shouldContinue }) {
  return (!deadlineAt || Date.now() < deadlineAt) && (!shouldContinue || shouldContinue());
}

async function repairOne(handle, deps) {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await deps.readOrder(handle);
    // A background data migration must never impersonate the owner of an
    // in-flight business transition. It leaves both the record and cursor in
    // place so the transition keeper can finish/abort first, then a later
    // maintenance run retries this exact order from a stable revision.
    if (entry.order?.pendingTransition) {
      throw new Error("order_credential_backfill_order_transition_pending");
    }
    const mirrored = mirrorPrimaryItemCredentials(entry.order);
    if (!mirrored.changed) return { updated: false };
    const revision = Number(entry.order.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("order_credential_backfill_revision_corrupt");
    }
    if (await deps.saveOrder(entry.index, mirrored.order, revision)) {
      const verified = await deps.readOrder(handle);
      if (!mirrorPrimaryItemCredentials(verified.order).changed) return { updated: true };
    }
  }
  throw new Error("order_credential_backfill_cas_conflict");
}

export async function backfillOrderCredentialMirrors({
  count = 25,
  deadlineAt = 0,
  shouldContinue = null,
  dependencies = defaultDependencies,
} = {}) {
  const safeCount = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(Number(count || 25))));
  const token = randomBytes(16).toString("hex");
  let locked = false;
  try {
    const lease = await dependencies.acquireLock(token);
    if (!lease?.acquired) {
      return lease?.busy
        ? { ok: true, skipped: true, reason: "backfill_busy", processed: 0, updated: 0 }
        : { ok: false, error: "order_credential_backfill_lock_unavailable", processed: 0, updated: 0 };
    }
    locked = true;
    const cursor = await dependencies.readCursor();
    if (cursor.phase === "done") {
      return { ok: true, done: true, processed: 0, updated: 0 };
    }
    if (!canContinue({ deadlineAt, shouldContinue })) {
      return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", processed: 0, updated: 0 };
    }
    const page = await dependencies.readPage(cursor, safeCount);
    let processed = 0;
    let updated = 0;
    for (const handle of page) {
      if (!canContinue({ deadlineAt, shouldContinue })) {
        return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", processed, updated };
      }
      if (!await dependencies.renewLock(token)) {
        return { ok: false, partial: true, error: "order_credential_backfill_lock_lost", processed, updated };
      }
      const repaired = await repairOne(handle, dependencies);
      processed += 1;
      if (repaired.updated) updated += 1;
    }
    if (!canContinue({ deadlineAt, shouldContinue })) {
      return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", processed, updated };
    }
    if (!await dependencies.renewLock(token)) {
      return { ok: false, partial: true, error: "order_credential_backfill_lock_lost", processed, updated };
    }
    const nextCursor = page.length < safeCount
      ? (cursor.phase === "legacy" ? { phase: "records", offset: 0 } : { phase: "done", offset: cursor.offset + page.length })
      : { phase: cursor.phase, offset: cursor.offset + page.length };
    await dependencies.advanceCursor(token, cursor, nextCursor);
    return {
      ok: true,
      done: nextCursor.phase === "done",
      phase: nextCursor.phase,
      processed,
      updated,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.code || error?.message || "order_credential_backfill_failed").slice(0, 160),
      processed: 0,
      updated: 0,
    };
  } finally {
    if (locked) await dependencies.releaseLock(token);
  }
}

export const orderCredentialMirrorBackfillInternals = {
  ADVANCE_CURSOR_SCRIPT,
  CURSOR_KEY,
  LOCK_KEY,
  MAX_CAS_ATTEMPTS,
  parseCursor,
  repairOne,
};
