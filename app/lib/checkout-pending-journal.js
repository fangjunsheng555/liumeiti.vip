import { restorePendingIdempotencyRecord } from "./idempotency.js";

export const CHECKOUT_PENDING_LEGACY_KEY = "liumeiti:checkout-pending:v1";
export const CHECKOUT_PENDING_PREFIX = "liumeiti:checkout-pending:v2:";
export const CHECKOUT_SUBMISSION_LOCK = "liumeiti:checkout-submit:v2";
const CHECKOUT_FALLBACK_LOCK_PREFIX = "liumeiti:checkout-submit-lock:v1:";
const COORDINATED_SINGLE_PENDING_KEYS = new Set([
  "liumeiti:idempotency:balance-redeem",
]);
const COORDINATED_SINGLE_PENDING_PREFIXES = [
  "liumeiti:idempotency:money:",
  "liumeiti:admin-mutation:",
  "lm:idempotency:spotify-resend:",
];
const COORDINATED_QUOTE_PENDING_KEY = "liumeiti:quote-order-pending:v1";

function coordinationToken(environment) {
  try {
    if (environment.crypto?.randomUUID) return environment.crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function fallbackLockEntries(storage) {
  const entries = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(CHECKOUT_FALLBACK_LOCK_PREFIX)) continue;
      const raw = storage.getItem(storageKey);
      if (raw === null) continue;
      let value;
      try { value = JSON.parse(raw); } catch { return { ok: false, error: "checkout_lock_ambiguous" }; }
      const token = storageKey.slice(CHECKOUT_FALLBACK_LOCK_PREFIX.length);
      if (!token || value?.token !== token || !Number.isFinite(value?.createdAt)) {
        return { ok: false, error: "checkout_lock_ambiguous" };
      }
      // Never let untrusted persisted fields replace the physical key/raw used
      // by stale-claim compare-removal.
      entries.push({ ...value, storageKey, raw });
    }
  } catch {
    return { ok: false, error: "checkout_cross_tab_coordination_unavailable" };
  }
  return { ok: true, entries };
}

function hasOtherCoordinatedPendingOperation(storage) {
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      if (COORDINATED_SINGLE_PENDING_KEYS.has(key)
        || COORDINATED_SINGLE_PENDING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        if (storage.getItem(key) !== null) return { ok: true, pending: true };
      }
    }
    const quoteRaw = storage.getItem(COORDINATED_QUOTE_PENDING_KEY);
    if (quoteRaw !== null) {
      let quote;
      try { quote = JSON.parse(quoteRaw); } catch { return { ok: true, pending: true }; }
      // This namespace's completion marker is only written after an explicit
      // successful response, so it need not keep an abandoned lock forever.
      const restoredQuote = restorePendingIdempotencyRecord(quote, "quote-order");
      if (!restoredQuote.ok || quote?.completed !== true || !quote?.result?.orderId) {
        return { ok: true, pending: true };
      }
    }
    return { ok: true, pending: false };
  } catch {
    return { ok: false, pending: true };
  }
}

/**
 * Admit at most one side-effecting submission across tabs. Web Locks is the
 * primary primitive. The fallback is Lamport's bakery protocol over atomic
 * localStorage entries. Contenders fail immediately instead of queuing behind
 * a request that might clear its journal; a browser with neither primitive is
 * rejected fail-closed and never sends an unjournaled request.
 */
export async function withCheckoutSubmissionCoordination(
  callback,
  environment = globalThis,
  { staleMs = 10 * 60 * 1000 } = {},
) {
  if (environment.navigator?.locks?.request) {
    return environment.navigator.locks.request(
      CHECKOUT_SUBMISSION_LOCK,
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (!lock) throw new Error("checkout_cross_tab_submission_active");
        return callback();
      },
    );
  }
  let storage;
  try { storage = environment.localStorage; } catch {
    throw new Error("checkout_cross_tab_coordination_unavailable");
  }
  if (!storage) {
    throw new Error("checkout_cross_tab_coordination_unavailable");
  }

  const token = coordinationToken(environment);
  const storageKey = `${CHECKOUT_FALLBACK_LOCK_PREFIX}${token}`;
  const now = () => environment.Date?.now?.() ?? Date.now();
  let ownRaw = "";
  let callbackStarted = false;

  try {
    let locks = fallbackLockEntries(storage);
    if (!locks.ok) throw new Error(locks.error);

    // A tab can crash before writing a journal. Only clear an old claim when
    // there is provably no pending operation; otherwise retain it fail-closed.
    const journals = readCheckoutPendingJournals(storage);
    const otherPending = hasOtherCoordinatedPendingOperation(storage);
    if (journals.ok && journals.records.length === 0 && otherPending.ok && !otherPending.pending) {
      const cutoff = now() - staleMs;
      for (const lock of locks.entries) {
        if (lock.createdAt >= cutoff) continue;
        if (storage.getItem(lock.storageKey) === lock.raw) storage.removeItem(lock.storageKey);
      }
    }

    const createdAt = now();
    ownRaw = JSON.stringify({ token, choosing: true, number: 0, createdAt });
    storage.setItem(storageKey, ownRaw);
    if (storage.getItem(storageKey) !== ownRaw) throw new Error("checkout_lock_write_unverified");

    locks = fallbackLockEntries(storage);
    if (!locks.ok) throw new Error(locks.error);
    const number = Math.max(0, ...locks.entries.map((entry) => Number(entry.number) || 0)) + 1;
    ownRaw = JSON.stringify({ token, choosing: false, number, createdAt });
    storage.setItem(storageKey, ownRaw);
    if (storage.getItem(storageKey) !== ownRaw) throw new Error("checkout_lock_write_unverified");

    locks = fallbackLockEntries(storage);
    if (!locks.ok) throw new Error(locks.error);
    if (storage.getItem(storageKey) !== ownRaw) throw new Error("checkout_lock_ownership_lost");
    const blocked = locks.entries.some((entry) => {
      if (entry.token === token) return false;
      if (entry.choosing) return true;
      const otherNumber = Number(entry.number);
      if (!Number.isInteger(otherNumber) || otherNumber <= 0) return true;
      return otherNumber < number || (otherNumber === number && entry.token < token);
    });
    // Never queue a user action behind another tab. If the first action reaches
    // a terminal response and clears its journal while this one waits, the
    // queued callback could mint a fresh key and repeat the side effect.
    if (blocked) throw new Error("checkout_cross_tab_submission_active");

    callbackStarted = true;
    return await callback();
  } catch (error) {
    // Coordination only owns acquisition/release failures. Once admitted, the
    // callback's status/code/terminal metadata is part of the exact operation
    // recovery contract and must reach the caller unchanged.
    if (callbackStarted) throw error;
    if (String(error?.message || "").startsWith("checkout_")) throw error;
    throw new Error("checkout_cross_tab_coordination_unavailable");
  } finally {
    try {
      if (ownRaw && storage.getItem(storageKey) === ownRaw) storage.removeItem(storageKey);
    } catch {}
  }
}

function operationKey(record) {
  return String(record?.idempotencyRequest?.key || "").trim();
}

export function checkoutPendingStorageKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) throw new TypeError("checkout_operation_key_required");
  return `${CHECKOUT_PENDING_PREFIX}${encodeURIComponent(normalized)}`;
}

function parseStoredRecord(storage, storageKey) {
  let raw;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return { ok: false, storageKey, error: "checkout_journal_read_failed" };
  }
  if (typeof raw !== "string") return { ok: true, missing: true, storageKey };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, storageKey, error: "checkout_journal_invalid_json" };
  }
  const restored = restorePendingIdempotencyRecord(parsed, "checkout-order");
  if (!restored.ok) return { ok: false, storageKey, error: restored.error };
  const identity = restored.record.identity;
  const accountEmail = String(identity?.accountEmail || "").trim().toLowerCase();
  const hasLifecycle = Object.prototype.hasOwnProperty.call(identity || {}, "accountLifecycleId");
  const accountLifecycleId = String(identity?.accountLifecycleId || "").trim().toLowerCase();
  // Pre-lifecycle journals are intentionally not upgraded by guessing from
  // the currently signed-in email. The address may have been deleted and
  // re-registered since the unresolved request was first sent.
  if (!hasLifecycle
    || (accountEmail ? !/^[a-f0-9]{32}$/.test(accountLifecycleId) : accountLifecycleId !== "")) {
    return { ok: false, storageKey, error: "checkout_journal_lifecycle_missing" };
  }

  const key = operationKey(restored.record);
  if (storageKey.startsWith(CHECKOUT_PENDING_PREFIX)) {
    let keyFromStorage;
    try {
      keyFromStorage = decodeURIComponent(storageKey.slice(CHECKOUT_PENDING_PREFIX.length));
    } catch {
      return { ok: false, storageKey, error: "checkout_journal_invalid_storage_key" };
    }
    if (!keyFromStorage || keyFromStorage !== key) {
      return { ok: false, storageKey, error: "checkout_journal_storage_key_mismatch" };
    }
  }

  return { ok: true, storageKey, record: restored.record };
}

/**
 * Read every exact pending checkout request. Corrupt entries are returned as
 * errors and are never deleted: they may represent a committed order whose
 * response was lost. The legacy single-record key is deduplicated with its v2
 * per-operation copy during migration.
 */
export function readCheckoutPendingJournals(storage) {
  if (!storage) return { ok: false, records: [], errors: [{ error: "checkout_journal_unavailable" }] };

  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(CHECKOUT_PENDING_PREFIX)) keys.push(key);
    }
    if (storage.getItem(CHECKOUT_PENDING_LEGACY_KEY) !== null) {
      keys.push(CHECKOUT_PENDING_LEGACY_KEY);
    }
  } catch {
    return { ok: false, records: [], errors: [{ error: "checkout_journal_read_failed" }] };
  }

  keys.sort((a, b) => a.localeCompare(b));
  const errors = [];
  const byOperation = new Map();
  for (const storageKey of keys) {
    const result = parseStoredRecord(storage, storageKey);
    if (!result.ok) {
      errors.push({ storageKey, error: result.error });
      continue;
    }
    if (result.missing) continue;
    const key = operationKey(result.record);
    const existing = byOperation.get(key);
    if (existing && existing.record.idempotencyRequest.fingerprint !== result.record.idempotencyRequest.fingerprint) {
      errors.push({ storageKey, error: "checkout_journal_operation_conflict" });
      continue;
    }
    // Prefer the per-operation copy while retaining the legacy key on disk
    // until this exact operation receives a terminal response.
    if (!existing || storageKey !== CHECKOUT_PENDING_LEGACY_KEY) {
      byOperation.set(key, { storageKey, record: result.record });
    }
  }

  const records = [...byOperation.values()].sort((a, b) => {
    const created = Number(a.record.createdAt || 0) - Number(b.record.createdAt || 0);
    return created || operationKey(a.record).localeCompare(operationKey(b.record));
  });
  return { ok: errors.length === 0, records, errors };
}

/**
 * Persist without replacing any other unresolved operation. The write is
 * verified and followed by a full re-read before callers are allowed to send
 * the HTTP request.
 */
export function writeCheckoutPendingJournal(storage, record) {
  const restored = restorePendingIdempotencyRecord(record, "checkout-order");
  if (!restored.ok) throw new Error(restored.error);
  const key = operationKey(restored.record);
  const before = readCheckoutPendingJournals(storage);
  if (!before.ok) throw new Error("checkout_journal_ambiguous");
  if (before.records.some((entry) => operationKey(entry.record) !== key)) {
    throw new Error("checkout_pending_operation_exists");
  }

  const storageKey = checkoutPendingStorageKey(key);
  const existing = parseStoredRecord(storage, storageKey);
  if (!existing.ok) throw new Error("checkout_journal_ambiguous");
  if (existing.record && existing.record.idempotencyRequest.fingerprint !== restored.record.idempotencyRequest.fingerprint) {
    throw new Error("checkout_journal_operation_conflict");
  }
  if (existing.record) {
    // The exact operation is already durable. Never rewrite even its UI-only
    // metadata while its server outcome is unresolved.
    return { storageKey, record: existing.record };
  }

  const serialized = JSON.stringify(restored.record);
  try {
    storage.setItem(storageKey, serialized);
    if (storage.getItem(storageKey) !== serialized) throw new Error("checkout_journal_write_unverified");
  } catch (error) {
    if (error?.message === "checkout_journal_write_unverified") throw error;
    throw new Error("checkout_journal_write_failed");
  }

  const after = readCheckoutPendingJournals(storage);
  if (!after.ok || after.records.length !== 1 || operationKey(after.records[0].record) !== key) {
    throw new Error("checkout_journal_concurrent_operation");
  }
  return { storageKey, record: restored.record };
}

/** Remove only the operation proven terminal by the server. */
export function clearCheckoutPendingJournal(storage, key) {
  const normalized = String(key || "").trim();
  if (!storage || !normalized) return false;

  const storageKey = checkoutPendingStorageKey(normalized);
  const exact = parseStoredRecord(storage, storageKey);
  if (!exact.ok) return false;
  if (exact.record && operationKey(exact.record) === normalized) storage.removeItem(storageKey);

  const legacy = parseStoredRecord(storage, CHECKOUT_PENDING_LEGACY_KEY);
  if (!legacy.ok) return false;
  if (legacy.record && operationKey(legacy.record) === normalized) {
    storage.removeItem(CHECKOUT_PENDING_LEGACY_KEY);
  }
  return true;
}

export function isCheckoutJournalStorageKey(key) {
  return key === CHECKOUT_PENDING_LEGACY_KEY || String(key || "").startsWith(CHECKOUT_PENDING_PREFIX);
}
