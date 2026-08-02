import {
  createPendingIdempotencyRecord,
  idempotencyFingerprint,
  restorePendingIdempotencyRecord,
} from "./idempotency.js";

const ADMIN_MUTATION_PREFIX = "liumeiti:admin-mutation";
const EXACT_SUFFIX = ":exact-v2:";

function snapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("admin_mutation_payload_not_serializable");
  return JSON.parse(serialized);
}

function normalizedPart(value, error) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(error);
  return result;
}

function operationScope(scope) {
  return `admin-${normalizedPart(scope, "admin_mutation_scope_required")}`;
}

function operationIdentity(scope, target) {
  return {
    scope: normalizedPart(scope, "admin_mutation_scope_required"),
    target: normalizedPart(target, "admin_mutation_target_required"),
  };
}

function operationKey(record) {
  return String(record?.idempotencyRequest?.key || "").trim();
}

function rawOperationKey(value) {
  return String(value?.idempotencyRequest?.key || value?.key || "").trim();
}

export function adminMutationSlotKey(scope, target) {
  const identity = operationIdentity(scope, target);
  // Preserve the deployed v1 key byte-for-byte for rolling migration.
  return `${ADMIN_MUTATION_PREFIX}:${identity.scope}:${identity.target}:v1`;
}

export function adminMutationExactStorageKey(slotKey, key) {
  const slot = normalizedPart(slotKey, "admin_mutation_slot_required");
  const operation = normalizedPart(key, "admin_mutation_operation_required");
  return `${slot}${EXACT_SUFFIX}${encodeURIComponent(operation)}`;
}

function parseExactRecord(raw, scope, target, storageKey = "") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "admin_mutation_journal_invalid_json", storageKey };
  }
  const restored = restorePendingIdempotencyRecord(parsed, operationScope(scope));
  if (!restored.ok) return { ok: false, error: restored.error, storageKey };
  const identity = operationIdentity(scope, target);
  if (restored.record.identity?.scope !== identity.scope || restored.record.identity?.target !== identity.target) {
    return { ok: false, error: "admin_mutation_journal_identity_mismatch", storageKey };
  }
  const key = operationKey(restored.record);
  if (storageKey.includes(EXACT_SUFFIX)) {
    let storedKey = "";
    try { storedKey = decodeURIComponent(storageKey.slice(storageKey.indexOf(EXACT_SUFFIX) + EXACT_SUFFIX.length)); } catch {}
    if (!storedKey || storedKey !== key) {
      return { ok: false, error: "admin_mutation_journal_storage_key_mismatch", storageKey };
    }
  }
  return { ok: true, record: restored.record, storageKey };
}

function migrateLegacyRecord(raw, scope, target, payload, storageKey) {
  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return { ok: false, error: "admin_mutation_legacy_invalid_json", storageKey };
  }

  // A future-safe exact record may already occupy the legacy slot. Validate it
  // using the same strict path instead of weakening its fingerprint.
  if (legacy?.payload && legacy?.idempotencyRequest) {
    return parseExactRecord(raw, scope, target, storageKey);
  }

  if (payload === undefined) {
    return { ok: false, error: "admin_mutation_legacy_payload_required", storageKey };
  }

  const exactPayload = snapshot(payload);
  const key = String(legacy?.key || "").trim();
  const legacyFingerprint = idempotencyFingerprint(operationScope(scope), exactPayload);
  if (!key || legacy?.fingerprint !== legacyFingerprint) {
    return { ok: false, error: "admin_mutation_legacy_payload_mismatch", storageKey };
  }

  const identity = operationIdentity(scope, target);
  return {
    ok: true,
    storageKey,
    legacy: true,
    record: {
      version: 1,
      createdAt: Number(legacy.createdAt || Date.now()),
      payload: exactPayload,
      identity,
      idempotencyRequest: {
        ...snapshot(legacy),
        // The deployed key remains unchanged. Only the local validation
        // fingerprint is upgraded now that the exact body and target are known.
        fingerprint: idempotencyFingerprint(operationScope(scope), { identity, payload: exactPayload }),
      },
    },
  };
}

/**
 * Read every unresolved operation for one scope/target slot. Invalid entries
 * remain on disk and make the result fail closed; they may represent a server
 * commit whose HTTP response was lost.
 */
export function readAdminMutationJournals(storage, scope, target, payloadForLegacy) {
  if (!storage) return { ok: false, records: [], errors: [{ error: "admin_mutation_journal_unavailable" }] };
  const slotKey = adminMutationSlotKey(scope, target);
  const exactPrefix = slotKey + EXACT_SUFFIX;
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(exactPrefix)) keys.push(key);
    }
    if (storage.getItem(slotKey) !== null) keys.push(slotKey);
  } catch {
    return { ok: false, records: [], errors: [{ error: "admin_mutation_journal_read_failed" }] };
  }

  keys.sort((left, right) => left.localeCompare(right));
  const errors = [];
  const byOperation = new Map();
  for (const storageKey of keys) {
    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch {
      errors.push({ storageKey, error: "admin_mutation_journal_read_failed" });
      continue;
    }
    if (typeof raw !== "string") continue;
    const parsed = storageKey === slotKey
      ? migrateLegacyRecord(raw, scope, target, payloadForLegacy, storageKey)
      : parseExactRecord(raw, scope, target, storageKey);
    if (!parsed.ok) {
      errors.push({ storageKey, error: parsed.error });
      continue;
    }
    const key = operationKey(parsed.record);
    const existing = byOperation.get(key);
    if (existing && existing.record.idempotencyRequest.fingerprint !== parsed.record.idempotencyRequest.fingerprint) {
      errors.push({ storageKey, error: "admin_mutation_journal_operation_conflict" });
      continue;
    }
    // Prefer the exact per-operation copy while retaining the legacy entry
    // until this same key receives a proven terminal response.
    if (!existing || storageKey !== slotKey) byOperation.set(key, parsed);
  }

  return {
    ok: errors.length === 0,
    slotKey,
    records: [...byOperation.values()].sort((left, right) => (
      Number(left.record.createdAt || 0) - Number(right.record.createdAt || 0)
      || operationKey(left.record).localeCompare(operationKey(right.record))
    )),
    errors,
  };
}

function persistExactRecord(storage, scope, target, payload, record) {
  const key = operationKey(record);
  const before = readAdminMutationJournals(storage, scope, target, payload);
  if (!before.ok) throw new Error(before.errors[0]?.error || "admin_mutation_journal_ambiguous");
  if (before.records.some((entry) => operationKey(entry.record) !== key)) {
    throw new Error("admin_mutation_unresolved_operation_exists");
  }

  const exactKey = adminMutationExactStorageKey(before.slotKey, key);
  let existingRaw = null;
  try { existingRaw = storage.getItem(exactKey); } catch { throw new Error("admin_mutation_journal_read_failed"); }
  if (typeof existingRaw === "string") {
    const existing = parseExactRecord(existingRaw, scope, target, exactKey);
    if (!existing.ok || existing.record.idempotencyRequest.fingerprint !== record.idempotencyRequest.fingerprint) {
      throw new Error(existing.error || "admin_mutation_journal_operation_conflict");
    }
  }

  const serialized = JSON.stringify(record);
  try {
    storage.setItem(exactKey, serialized);
    if (storage.getItem(exactKey) !== serialized) throw new Error("admin_mutation_journal_write_unverified");
  } catch (error) {
    if (error?.message === "admin_mutation_journal_write_unverified") throw error;
    throw new Error("admin_mutation_journal_write_failed");
  }

  const after = readAdminMutationJournals(storage, scope, target, payload);
  if (!after.ok || after.records.length !== 1 || operationKey(after.records[0].record) !== key) {
    throw new Error("admin_mutation_journal_concurrent_operation");
  }
  return { record: after.records[0].record, storageKey: after.slotKey, operationStorageKey: exactKey };
}

/**
 * Reuse and replay the exact unresolved body when it matches the current form.
 * A changed form or multiple raced operations is ambiguous and cannot mint a
 * replacement key until the earlier outcome has been resolved.
 */
export function prepareAdminMutationJournal(storage, scope, target, payload) {
  const exactPayload = snapshot(payload);
  const identity = operationIdentity(scope, target);
  const expectedFingerprint = idempotencyFingerprint(operationScope(scope), { identity, payload: exactPayload });
  const current = readAdminMutationJournals(storage, scope, target, exactPayload);
  if (!current.ok) throw new Error(current.errors[0]?.error || "admin_mutation_journal_ambiguous");
  if (current.records.length > 1) throw new Error("admin_mutation_multiple_unresolved_operations");

  let record = current.records[0]?.record || null;
  if (record && record.idempotencyRequest.fingerprint !== expectedFingerprint) {
    throw new Error("admin_mutation_pending_payload_changed");
  }
  if (!record) {
    record = createPendingIdempotencyRecord(null, operationScope(scope), exactPayload, { identity });
  }
  return persistExactRecord(storage, scope, target, exactPayload, record);
}

function removeStoredOperationIfMatching(storage, storageKey, key) {
  let raw;
  try { raw = storage.getItem(storageKey); } catch { return false; }
  if (raw === null) return true;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (rawOperationKey(parsed) !== key) return true;
  // Best-effort localStorage compare-and-remove. The per-operation key means a
  // different operation never shares this location; the second comparison also
  // protects the rolling legacy slot if another tab replaced its value.
  try {
    if (storage.getItem(storageKey) !== raw) return true;
    storage.removeItem(storageKey);
    return storage.getItem(storageKey) === null;
  } catch { return false; }
}

/** Remove only the exact operation proven terminal by the server. */
export function clearAdminMutationJournal(storage, slotKey, operationId) {
  const key = String(operationId || "").trim();
  if (!storage || !slotKey || !key) return false;
  const exact = removeStoredOperationIfMatching(storage, adminMutationExactStorageKey(slotKey, key), key);
  const legacy = removeStoredOperationIfMatching(storage, slotKey, key);
  return exact && legacy;
}
