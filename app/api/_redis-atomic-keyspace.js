// Redis Cluster only permits a script to touch keys from one hash slot. The
// production Vercel KV / Upstash REST deployment is non-sharded, so historical
// keys remain byte-for-byte unchanged by default. These mapping helpers define
// a future migration format only: the current runtime deliberately rejects
// cluster-v1 because the rest of the application is not routed through it yet.

export const REDIS_ATOMIC_KEYSPACE_ENV = "LIUMEITI_REDIS_ATOMIC_KEYSPACE";
export const REDIS_ATOMIC_CLUSTER_MODE = "cluster-v1";
export const REDIS_ATOMIC_HASH_TAG = "{liumeiti-atomic-v1}";
export const REDIS_ATOMIC_SCHEMA_READY_KEY = REDIS_ATOMIC_HASH_TAG + ":schema-ready";
export const REDIS_ATOMIC_SCHEMA_READY_VALUE = "cluster-v1:ready";

export function redisAtomicKeyspaceMode() {
  const value = String(process.env[REDIS_ATOMIC_KEYSPACE_ENV] || "").trim().toLowerCase();
  if (!value || value === "legacy" || value === "upstash") return "legacy";
  if (value === REDIS_ATOMIC_CLUSTER_MODE) return REDIS_ATOMIC_CLUSTER_MODE;
  return "invalid";
}

export function redisAtomicStorageKey(logicalKey) {
  const key = String(logicalKey || "");
  return redisAtomicKeyspaceMode() === REDIS_ATOMIC_CLUSTER_MODE
    ? REDIS_ATOMIC_HASH_TAG + ":" + key
    : key;
}

export function redisAtomicStorageKeys(logicalKeys) {
  return (Array.isArray(logicalKeys) ? logicalKeys : []).map(redisAtomicStorageKey);
}

export function redisHashTag(key) {
  const value = String(key || "");
  const start = value.indexOf("{");
  if (start < 0) return "";
  const end = value.indexOf("}", start + 1);
  return end > start + 1 ? value.slice(start + 1, end) : "";
}

export function redisKeysShareExplicitHashTag(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  const tag = redisHashTag(keys[0]);
  return Boolean(tag) && keys.every((key) => redisHashTag(key) === tag);
}
