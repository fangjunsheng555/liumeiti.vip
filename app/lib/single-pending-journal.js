import {
  createPendingIdempotencyRecord,
  idempotencyFingerprint,
  restorePendingIdempotencyRecord,
} from "./idempotency.js";

function snapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("pending_operation_not_serializable");
  return JSON.parse(serialized);
}

function operationKey(record) {
  return String(record?.idempotencyRequest?.key || record?.key || "").trim();
}

function context(scope, payload, identity) {
  const normalizedScope = String(scope || "").trim();
  if (!normalizedScope) throw new TypeError("pending_operation_scope_required");
  return {
    scope: normalizedScope,
    payload: snapshot(payload),
    identity: snapshot(identity || {}),
  };
}

function hasAccountLifecycle(identity) {
  return /^[a-f0-9]{32}$/.test(String(identity?.accountLifecycleId || "").trim().toLowerCase());
}

/**
 * Read a single-slot browser journal without mutating it. Corrupt, legacy-
 * mismatched, identity-switched, and edited records all fail closed because
 * any one of them may represent a server commit whose response was lost.
 */
export function readSinglePendingOperation(
  storage,
  storageKey,
  scope,
  payload,
  { identity = {}, legacyPayload = payload, requireAccountLifecycle = false } = {},
) {
  if (!storage || !storageKey) throw new Error("pending_operation_journal_unavailable");
  const exact = context(scope, payload, identity);
  if (requireAccountLifecycle && !hasAccountLifecycle(exact.identity)) {
    throw new Error("pending_operation_lifecycle_required");
  }
  let raw;
  try { raw = storage.getItem(storageKey); } catch { throw new Error("pending_operation_journal_read_failed"); }
  if (raw === null) return { record: null, legacy: false, raw: null };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("pending_operation_journal_invalid_json"); }
  if (parsed?.payload && parsed?.idempotencyRequest) {
    if (requireAccountLifecycle && !hasAccountLifecycle(parsed.identity)) {
      throw new Error("pending_operation_lifecycle_missing");
    }
    const restored = restorePendingIdempotencyRecord(parsed, exact.scope);
    if (!restored.ok) throw new Error(restored.error);
    const expected = idempotencyFingerprint(exact.scope, { identity: exact.identity, payload: exact.payload });
    if (restored.record.idempotencyRequest.fingerprint !== expected) {
      throw new Error("pending_operation_context_changed");
    }
    return { record: restored.record, legacy: false, raw };
  }

  // Rolling compatibility for the previous key-only client journal. It can be
  // upgraded only when its old fingerprint proves the exact legacy request.
  if (requireAccountLifecycle) throw new Error("pending_operation_lifecycle_missing");
  const key = operationKey(parsed);
  const expectedLegacy = idempotencyFingerprint(exact.scope, snapshot(legacyPayload));
  if (!key || parsed?.fingerprint !== expectedLegacy) {
    throw new Error("pending_operation_legacy_mismatch");
  }
  return {
    legacy: true,
    raw,
    record: {
      version: 1,
      createdAt: Number(parsed.createdAt || Date.now()),
      payload: exact.payload,
      identity: exact.identity,
      idempotencyRequest: {
        ...snapshot(parsed),
        fingerprint: idempotencyFingerprint(exact.scope, { identity: exact.identity, payload: exact.payload }),
      },
    },
  };
}

/** Persist and verify the exact body before the caller may send the request. */
export function prepareSinglePendingOperation(
  storage,
  storageKey,
  scope,
  payload,
  options = {},
) {
  const exact = context(scope, payload, options.identity || {});
  const existing = readSinglePendingOperation(storage, storageKey, exact.scope, exact.payload, options);
  const record = existing.record || createPendingIdempotencyRecord(
    null,
    exact.scope,
    exact.payload,
    { identity: exact.identity },
  );
  if (existing.record && !existing.legacy) {
    try {
      if (storage.getItem(storageKey) !== existing.raw) {
        throw new Error("pending_operation_journal_concurrent_change");
      }
    } catch (error) {
      if (error?.message === "pending_operation_journal_concurrent_change") throw error;
      throw new Error("pending_operation_journal_read_failed");
    }
    return record;
  }
  const serialized = JSON.stringify(record);
  try {
    // An already validated exact record is immutable while unresolved. Legacy
    // and new records are upgraded/written once and verified byte-for-byte.
    storage.setItem(storageKey, serialized);
    if (storage.getItem(storageKey) !== serialized) throw new Error("pending_operation_journal_write_unverified");
  } catch (error) {
    if (error?.message === "pending_operation_journal_write_unverified") throw error;
    throw new Error("pending_operation_journal_write_failed");
  }
  return record;
}

/** Compare-clear only the operation proven terminal by the HTTP response. */
export function clearSinglePendingOperation(storage, storageKey, expectedOperationKey) {
  const expected = String(expectedOperationKey || "").trim();
  if (!storage || !storageKey || !expected) return false;
  let raw;
  try { raw = storage.getItem(storageKey); } catch { return false; }
  if (raw === null) return true;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (operationKey(parsed) !== expected) return false;
  try {
    if (storage.getItem(storageKey) !== raw) return false;
    storage.removeItem(storageKey);
    return storage.getItem(storageKey) === null;
  } catch {
    return false;
  }
}

/**
 * Replace an unresolved single-slot record with terminal metadata only while
 * the slot still contains that exact operation. A successful server response
 * must never blindly overwrite a different unresolved request written while
 * the first request was in flight.
 */
export function completeSinglePendingOperation(
  storage,
  storageKey,
  expectedOperationKey,
  completedRecord,
) {
  const expected = String(expectedOperationKey || "").trim();
  if (!storage || !storageKey || !expected || operationKey(completedRecord) !== expected) return false;
  let raw;
  try { raw = storage.getItem(storageKey); } catch { return false; }
  if (raw === null) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (operationKey(parsed) !== expected) return false;

  let serialized;
  try { serialized = JSON.stringify(completedRecord); } catch { return false; }
  if (typeof serialized !== "string") return false;
  try {
    if (storage.getItem(storageKey) !== raw) return false;
    storage.setItem(storageKey, serialized);
    return storage.getItem(storageKey) === serialized;
  } catch {
    return false;
  }
}
