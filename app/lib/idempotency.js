import { isRetryableMoneyOperationFailure } from "./money-operation-failure.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function idempotencyFingerprint(scope, payload) {
  return JSON.stringify({ scope: String(scope || "operation"), payload: stableValue(payload) });
}

function randomPart() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "");
  } catch {}
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function nextIdempotencyRequest(current, scope, payload, now = Date.now()) {
  const fingerprint = idempotencyFingerprint(scope, payload);
  // An unresolved request must keep the same key regardless of its age. A
  // response can be lost after the server commits the operation, so replacing
  // the key on a client-side timer could execute the same side effect twice.
  if (current?.key && current.fingerprint === fingerprint) {
    return current;
  }
  const safeScope = String(scope || "operation").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) || "operation";
  return {
    key: `${safeScope}-${Number(now).toString(36)}-${randomPart()}`.slice(0, 160),
    fingerprint,
    createdAt: Number(now),
  };
}

function jsonSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("idempotency_payload_not_serializable");
  return JSON.parse(serialized);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const AMBIGUOUS_PRE_LOOKUP_ERRORS = new Set([
  "idempotency_key_required",
  "invalid_idempotency_key",
  "operation_identity_required",
  "invalid_expected_account",
  "operation_identity_mismatch",
  "operation_identity_changed",
  "operation_identity_auth_required",
  "guest_operation_has_session",
  "operation_lifecycle_required",
  "invalid_expected_lifecycle",
  "operation_lifecycle_mismatch",
  "operation_lifecycle_changed",
  "account_lifecycle_required",
  "account_lifecycle_changed",
  "session_state_changed",
  "guest_operation_lifecycle_invalid",
]);

/**
 * Persist the exact HTTP body together with the identity-bound fingerprint.
 * A caller must replay `record.payload` verbatim; recalculating a request from
 * live UI state can silently replace expiring quote tokens and execute a
 * second operation after a response was lost.
 */
export function createPendingIdempotencyRecord(
  current,
  scope,
  payload,
  { identity = {}, metadata = {}, now = Date.now() } = {},
) {
  const exactPayload = jsonSnapshot(payload);
  const exactIdentity = jsonSnapshot(identity);
  if (!plainObject(exactPayload) || !plainObject(exactIdentity)) {
    throw new TypeError("idempotency_payload_must_be_object");
  }
  const operation = nextIdempotencyRequest(current, scope, {
    identity: exactIdentity,
    payload: exactPayload,
  }, now);
  return {
    ...jsonSnapshot(metadata),
    version: 1,
    createdAt: Number(now),
    payload: exactPayload,
    identity: exactIdentity,
    idempotencyRequest: operation,
  };
}

/**
 * Validate an on-disk pending record without deleting it on corruption. A
 * malformed/partially-written record is an ambiguous operation and must fail
 * closed instead of permitting a fresh idempotency key.
 */
export function restorePendingIdempotencyRecord(record, scope) {
  if (!plainObject(record) || !plainObject(record.payload) || !plainObject(record.idempotencyRequest)) {
    return { ok: false, error: "invalid_pending_record" };
  }
  // v1 checkout records written before the identity field stored the bound
  // account on the operation itself. Accept and normalize those records.
  const identity = plainObject(record.identity)
    ? record.identity
    : { accountEmail: String(record.idempotencyRequest.accountEmail || "") };
  const operation = record.idempotencyRequest;
  if (!operation.key || !operation.fingerprint) {
    return { ok: false, error: "invalid_pending_record" };
  }
  const expected = idempotencyFingerprint(scope, { identity, payload: record.payload });
  if (operation.fingerprint !== expected) {
    return { ok: false, error: "pending_fingerprint_mismatch" };
  }
  return {
    ok: true,
    record: {
      ...record,
      payload: jsonSnapshot(record.payload),
      identity: jsonSnapshot(identity),
      idempotencyRequest: jsonSnapshot(operation),
    },
  };
}

/**
 * Success and explicit non-retryable payload rejections prove that this exact
 * attempt is finished. Authentication can run before the server's operation
 * lookup, so 401/403 remain ambiguous along with timeouts, conflicts,
 * throttling, and server failures.
 */
export function isExplicitTerminalIdempotencyResponse(status, data) {
  if (data?.ok === true) return true;
  // Storage/protocol failures can be returned after Redis committed but before
  // the HTTP response was decoded or recovered. Never let an HTTP 4xx rewrite
  // turn that uncertain outcome into permission to discard the original key.
  if (isRetryableMoneyOperationFailure(data)) return false;
  const code = Number(status || 0);
  // These rejections occur before an operation lookup. They therefore cannot
  // prove that an earlier attempt with the same key did not commit before its
  // response was lost (for example, if a proxy later strips a binding header).
  if (AMBIGUOUS_PRE_LOOKUP_ERRORS.has(String(data?.error || ""))) return false;
  return data?.ok === false && [400, 404, 410, 422].includes(code);
}
