// Errors in this set come from the storage transport, Redis key types, or
// server-built records. They are not a rejection of the user's payload. Keep
// the original idempotency key until the server can prove the operation's
// outcome, even when an intermediary accidentally rewrites the HTTP status.
const RETRYABLE_MONEY_OPERATION_ERRORS = new Set([
  "storage_unavailable",
  "storage_error",
  "storage_failed",
  "invalid_storage_response",
  "invalid_operation_record",
  "invalid_redis_keyspace_mode",
  "redis_cluster_keyspace_not_supported",
  "redis_cluster_keyspace_not_ready",
  "redis_cluster_crossslot_guard",
  "storage_type_error",
  "invalid_user_record",
  "invalid_storage_record",
  "invalid_balance_record",
  "invalid_ledger_record",
  "invalid_record",
  "invalid_withdrawal_record",
  "invalid_order_record",
  "invalid_order_revision",
  "invalid_order_score",
  "invalid_order_overview",
  "invalid_quote_ttl",
  "invalid_stock_spec",
  "invalid_stock_record",
  "invalid_stock_effect",
  "invalid_code_record",
  "invalid_metadata",
  "invalid_coupon_transition",
  "invalid_payment_method",
  "invalid_auth_version",
  "invalid_account_lifecycle",
  "invalid_lifecycle_candidate",
  "invalid_confirmation_record",
  "invalid_confirmation_effect",
  "withdrawal_exists",
]);

export function isRetryableMoneyOperationFailure(result) {
  if (!result || typeof result !== "object") return false;
  if (result.ok === false && !String(result.error || "").trim()) return true;
  return result.ambiguous === true
    || result.retryable === true
    || RETRYABLE_MONEY_OPERATION_ERRORS.has(String(result.error || ""));
}

export function retryableMoneyOperationFields(result) {
  return {
    retryable: true,
    ambiguous: result?.ambiguous === true,
  };
}

export const moneyOperationFailureInternals = { RETRYABLE_MONEY_OPERATION_ERRORS };
