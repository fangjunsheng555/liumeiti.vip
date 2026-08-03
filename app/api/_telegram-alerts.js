import { createHash, randomBytes } from "node:crypto";
import { clean, redisCmd, redisPipeline } from "./_utils.js";

const TELEGRAM_HISTORY_KEY = "lm:ops:telegram:history:v1";
const TELEGRAM_DEDUPE_PREFIX = "lm:ops:telegram:dedupe:v1:";
const TELEGRAM_LOCK_PREFIX = "lm:ops:telegram:lock:v1:";
const TELEGRAM_RETRY_INDEX = "lm:ops:telegram:retry:v1";
const TELEGRAM_RETRY_PREFIX = "lm:ops:telegram:retry-record:v1:";
const TELEGRAM_RETRY_LOCK_PREFIX = "lm:ops:telegram:retry-lock:v1:";
const HISTORY_LIMIT = 500;
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const RETRY_TTL_SECONDS = 3 * 24 * 60 * 60;
const RETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RETRY_MAX_ATTEMPTS = 8;

const CLAIM_ALERT_SCRIPT = `
if redis.call('GET',KEYS[1]) then return cjson.encode({ok=true,state='duplicate'}) end
if redis.call('EXISTS',KEYS[2])==1 then return cjson.encode({ok=true,state='locked'}) end
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2])
return cjson.encode({ok=true,state='acquired'})`;

const CLAIM_RETRY_LOCK_SCRIPT = `
if redis.call('EXISTS',KEYS[1])==1 then return cjson.encode({ok=true,state='locked'}) end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])
return cjson.encode({ok=true,state='acquired'})`;

const UPSERT_RETRY_SCRIPT = `
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[3])
redis.call('ZADD',KEYS[2],ARGV[2],ARGV[4])
return 1`;

const REMOVE_RETRY_SCRIPT = `
redis.call('DEL',KEYS[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return 1`;

const READ_RETRY_STATE_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
local duplicate=redis.call('EXISTS',KEYS[2])==1
return cjson.encode({ok=true,hasRecord=raw~=false,record=raw or '',duplicate=duplicate})`;

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry
  ));
}

function storageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function strictPipelineRows(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected) throw storageError(code);
  return value.map((entry) => {
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "error")) throw storageError(code);
    const result = entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
    if (result == null) throw storageError(code);
    return result;
  });
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function maskEmail(value) {
  return String(value || "").replace(/\b([A-Z0-9._%+-])[^\s@]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, (_, first, domain) => `${first}***@${domain}`);
}

export function redactOperationalText(value) {
  let text = maskEmail(clean(value, 3500));
  for (const secret of [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.CRON_SECRET,
    process.env.KV_REST_API_TOKEN,
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.RESEND_API_KEY,
  ].filter(Boolean)) {
    text = text.split(String(secret)).join("[redacted]");
  }
  return text
    .replace(/([?&](?:token|secret|key|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(basic)\s+[a-z0-9+/=]{8,}/gi, "$1 [redacted]")
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|session|credential|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi, '$1"[redacted]"')
    .slice(0, 3500);
}

function alertFingerprint(value) {
  return createHash("sha256").update(clean(value, 300)).digest("hex");
}

function retryRecordKey(hash) {
  return TELEGRAM_RETRY_PREFIX + clean(hash, 64).toLowerCase();
}

async function appendHistory(record) {
  let rows;
  try {
    rows = strictPipelineRows(await redisPipeline([
    ["LPUSH", TELEGRAM_HISTORY_KEY, JSON.stringify(record)],
    ["LTRIM", TELEGRAM_HISTORY_KEY, "0", String(HISTORY_LIMIT - 1)],
    ]), 2, "telegram_history_write_failed");
  } catch {
    return false;
  }
  return Number(rows[0]) >= 1 && rows[1] === "OK";
}

async function releaseLock(key, token) {
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  return Number(await redisCmd(["EVAL", script, "1", key, token])) > 0;
}

function providerFailure(status, payload) {
  const retryAfter = Math.max(0, Number(payload?.parameters?.retry_after || 0));
  if (status === 429) return { ok: false, retryable: true, retryAfter, error: "telegram_http_429" };
  if ([408, 425].includes(status) || status >= 500) {
    return { ok: false, retryable: true, uncertain: true, retryAfter, error: `telegram_http_${status}` };
  }
  const configurationError = [400, 401, 403].includes(status);
  return {
    ok: false,
    terminal: true,
    configurationError,
    error: `telegram_http_${status}`,
  };
}

async function deliverTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, disabled: true, terminal: true, configurationError: true, error: "telegram_not_configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload && payload.ok === true) {
      return { ok: true, messageId: clean(payload?.result?.message_id, 80) };
    }
    if (response.ok) {
      return { ok: false, retryable: true, uncertain: true, error: "telegram_invalid_json" };
    }
    return providerFailure(response.status, payload);
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      uncertain: true,
      error: clean(error?.name === "AbortError" ? "telegram_timeout" : error?.message || "telegram_transport_failed", 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

function retryDelayMs(hash, attempts, retryAfterSeconds = 0) {
  const exponent = Math.min(8, Math.max(0, Number(attempts || 1) - 1));
  const backoff = Math.min(6 * 60 * 60 * 1000, 60_000 * (2 ** exponent));
  const retryAfter = Math.max(0, Number(retryAfterSeconds || 0) * 1000);
  const jitter = Number.parseInt(String(hash || "0").slice(0, 6), 16) % 15_000;
  return Math.max(backoff, retryAfter) + jitter;
}

async function upsertRetry(record) {
  const saved = await redisCmd([
    "EVAL", UPSERT_RETRY_SCRIPT, "2",
    retryRecordKey(record.hash), TELEGRAM_RETRY_INDEX,
    JSON.stringify(record), String(record.nextAttemptAt), String(RETRY_TTL_SECONDS), record.hash,
  ]);
  return Number(saved) === 1;
}

async function removeRetry(hash) {
  return Number(await redisCmd([
    "EVAL", REMOVE_RETRY_SCRIPT, "2", retryRecordKey(hash), TELEGRAM_RETRY_INDEX, hash,
  ])) === 1;
}

async function scheduleRetry({ hash, fingerprint, incidentId, event, message, prior = null, result, providerDelivered = false, now = Date.now() }) {
  const attempts = Math.max(1, Number(prior?.attempts || 0) + 1);
  const createdAtMs = Number(prior?.createdAtMs || now);
  if (attempts > RETRY_MAX_ATTEMPTS || now - createdAtMs >= RETRY_MAX_AGE_MS) {
    const removed = await removeRetry(hash);
    return { queued: false, expired: removed, storageFailed: !removed, attempts };
  }
  const nextAttemptAt = now + retryDelayMs(hash, attempts, result?.retryAfter);
  const record = {
    hash,
    fingerprint: clean(fingerprint, 300),
    incidentId: clean(incidentId, 80),
    event: clean(event, 40),
    message: redactOperationalText(message),
    providerDelivered: Boolean(providerDelivered || prior?.providerDelivered),
    attempts,
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    nextAttemptAt,
    nextAttemptAtIso: new Date(nextAttemptAt).toISOString(),
    lastError: clean(result?.error, 160),
  };
  return { queued: await upsertRetry(record), record };
}

function providerAttemptMarker({ hash, fingerprint, incidentId, event, message, prior = null, now = Date.now() }) {
  const createdAtMs = Number(prior?.createdAtMs || now);
  return {
    ...(prior && typeof prior === "object" ? prior : {}),
    hash,
    fingerprint: clean(fingerprint, 300),
    incidentId: clean(incidentId, 80),
    event: clean(event, 40),
    message: redactOperationalText(message),
    providerDelivered: false,
    providerAttemptedAt: new Date(now).toISOString(),
    attempts: Math.max(0, Number(prior?.attempts || 0)),
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    nextAttemptAt: now + RETRY_MAX_AGE_MS,
    nextAttemptAtIso: new Date(now + RETRY_MAX_AGE_MS).toISOString(),
    lastError: "telegram_provider_outcome_pending",
  };
}

async function readRetryState(hash) {
  const state = parseJson(await redisCmd([
    "EVAL", READ_RETRY_STATE_SCRIPT, "2",
    retryRecordKey(hash), TELEGRAM_DEDUPE_PREFIX + hash,
  ]));
  if (!state?.ok || typeof state.hasRecord !== "boolean" || typeof state.duplicate !== "boolean") {
    return { ok: false, error: "telegram_retry_state_unavailable" };
  }
  if (!state.hasRecord) return { ok: true, record: null, duplicate: state.duplicate };
  const record = parseJson(state.record);
  return record && typeof record === "object"
    ? { ok: true, record, duplicate: state.duplicate }
    : { ok: false, error: "telegram_retry_record_corrupt" };
}

async function recordTelegramHealth(result, record) {
  try {
    const { recordHealthStatus } = await import("./_health.js");
    return await recordHealthStatus("telegram", {
      status: result.ok ? "ok" : result.disabled ? "disabled" : "error",
      summary: result.ok ? "运维告警已发送" : result.disabled ? "Telegram 告警未配置" : result.retryable ? "Telegram 告警等待重试" : "Telegram 告警发送失败",
      error: result.ok ? "" : result.error,
      metrics: { durationMs: record.durationMs, incidentId: record.incidentId, retryQueued: Boolean(result.retryQueued) },
    });
  } catch {
    return null;
  }
}

function historyRecord({ fingerprint, incidentId, event, result, started, attempt = 1 }) {
  return {
    id: `TA${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`,
    fingerprint: clean(fingerprint, 300),
    incidentId: clean(incidentId, 80),
    event: clean(event, 40),
    attempt,
    status: result.ok ? "sent" : result.disabled ? "disabled" : result.retryable ? "retry_scheduled" : result.uncertain ? "uncertain" : "failed",
    error: clean(result.error, 160),
    durationMs: Date.now() - started,
    createdAt: new Date().toISOString(),
  };
}

export async function sendOperationalTelegram({ fingerprint, text, incidentId = "", event = "alert" } = {}) {
  const safeFingerprint = clean(fingerprint, 300);
  const safeIncidentId = clean(incidentId, 80).toUpperCase();
  const message = redactOperationalText(text);
  if (!safeFingerprint || !message) return { ok: false, error: "invalid_alert" };
  // An incident ID scopes dedupe to one lifecycle. A newly-created incident
  // with the same signal fingerprint must still emit its own open alert.
  const hash = alertFingerprint(`${safeFingerprint}\0${safeIncidentId}\0${clean(event, 40)}`);
  const dedupeKey = TELEGRAM_DEDUPE_PREFIX + hash;
  const lockKey = TELEGRAM_LOCK_PREFIX + hash;
  const lockToken = randomBytes(12).toString("hex");
  const claim = parseJson(await redisCmd([
    "EVAL", CLAIM_ALERT_SCRIPT, "2", dedupeKey, lockKey, lockToken, "30",
  ]));
  if (!claim?.ok) {
    const storageFailure = { ok: false, retryable: true, error: "telegram_lock_store_unavailable" };
    const retry = await scheduleRetry({
      hash,
      fingerprint: safeFingerprint,
      incidentId: safeIncidentId,
      event,
      message,
      result: storageFailure,
    });
    return { ...storageFailure, retryQueued: Boolean(retry.queued), retry };
  }
  if (claim.state !== "acquired") {
    return { ok: true, duplicate: claim.state === "duplicate", pending: claim.state === "locked" };
  }

  const started = Date.now();
  try {
    const marker = providerAttemptMarker({
      hash,
      fingerprint: safeFingerprint,
      incidentId: safeIncidentId,
      event,
      message,
    });
    if (!await upsertRetry(marker)) {
      return { ok: false, retryable: true, error: "telegram_attempt_journal_unavailable", retryQueued: false };
    }
    let result = await deliverTelegramMessage(message);
    let retry = null;
    if (result.ok) {
      const dedupeSaved = await redisCmd(["SET", dedupeKey, "1", "EX", String(DEDUPE_TTL_SECONDS)]) === "OK";
      if (dedupeSaved) {
        await removeRetry(hash);
      } else {
        result = { ok: false, retryable: true, providerDelivered: true, error: "telegram_dedupe_store_unavailable" };
        retry = await scheduleRetry({
          hash,
          fingerprint: safeFingerprint,
          incidentId: safeIncidentId,
          event,
          message,
          result,
          providerDelivered: true,
        });
        result.retryQueued = Boolean(retry.queued);
      }
    } else if (result.retryable) {
      retry = await scheduleRetry({ hash, fingerprint: safeFingerprint, incidentId: safeIncidentId, event, message, result });
      result.retryQueued = Boolean(retry.queued);
    } else {
      await removeRetry(hash);
    }
    const record = historyRecord({ fingerprint: safeFingerprint, incidentId: safeIncidentId, event, result, started });
    const historySaved = await appendHistory(record);
    const healthSaved = await recordTelegramHealth(result, record);
    if (!historySaved || !healthSaved) {
      return {
        ...result,
        ok: false,
        providerDelivered: Boolean(result.ok || result.providerDelivered),
        monitoringError: !historySaved ? "telegram_history_write_failed" : "telegram_health_write_failed",
        retry,
        record,
      };
    }
    return { ...result, retry, record };
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

export async function drainTelegramAlertRetries({ limit = 20, now = Date.now(), shouldContinue = () => true } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
  const hashes = await redisCmd(["ZRANGEBYSCORE", TELEGRAM_RETRY_INDEX, "-inf", String(now), "LIMIT", "0", String(safeLimit)]);
  if (!Array.isArray(hashes)) return { ok: false, error: "telegram_retry_queue_unavailable", scanned: 0, processed: 0, failed: 1 };
  let processed = 0;
  let sent = 0;
  let rescheduled = 0;
  let terminal = 0;
  let failed = 0;
  for (const rawHash of hashes) {
    if (!shouldContinue()) {
      return {
        ok: false,
        partial: true,
        deadlineExceeded: true,
        error: "maintenance_deadline_exceeded",
        scanned: hashes.length,
        processed,
        sent,
        rescheduled,
        terminal,
        failed,
      };
    }
    const hash = clean(rawHash, 64).toLowerCase();
    if (!hash) continue;
    const lockKey = TELEGRAM_RETRY_LOCK_PREFIX + hash;
    const lockToken = randomBytes(12).toString("hex");
    const claim = parseJson(await redisCmd([
      "EVAL", CLAIM_RETRY_LOCK_SCRIPT, "1", lockKey, lockToken, "30",
    ]));
    if (!claim?.ok) {
      failed += 1;
      continue;
    }
    if (claim.state !== "acquired") continue;
    try {
      const state = await readRetryState(hash);
      if (!state.ok) {
        failed += 1;
        continue;
      }
      const record = state.record;
      if (!record) {
        if (!await removeRetry(hash)) failed += 1;
        continue;
      }
      if (state.duplicate) {
        if (await removeRetry(hash)) processed += 1;
        else failed += 1;
        continue;
      }
      // A previous worker persisted this marker before calling Telegram but
      // never durably recorded the provider result. Retrying would risk a
      // duplicate operational alert, so quarantine it as uncertain instead.
      if (record.providerAttemptedAt && !record.providerDelivered) {
        const removed = await removeRetry(hash);
        const historySaved = await appendHistory(historyRecord({
          fingerprint: record.fingerprint,
          incidentId: record.incidentId,
          event: record.event,
          result: { ok: false, terminal: true, uncertain: true, error: "telegram_provider_outcome_unknown" },
          started: now,
          attempt: Number(record.attempts || 0),
        }));
        processed += 1;
        terminal += 1;
        if (!removed || !historySaved) failed += 1;
        continue;
      }
      if (Number(record.attempts || 0) >= RETRY_MAX_ATTEMPTS || now - Number(record.createdAtMs || now) >= RETRY_MAX_AGE_MS) {
        if (!await removeRetry(hash)) failed += 1;
        terminal += 1;
        processed += 1;
        await appendHistory(historyRecord({
          fingerprint: record.fingerprint,
          incidentId: record.incidentId,
          event: record.event,
          result: { ok: false, terminal: true, error: "telegram_retry_expired" },
          started: now,
          attempt: Number(record.attempts || 0),
        }));
        continue;
      }
      const started = Date.now();
      let result;
      if (record.providerDelivered) {
        const saved = await redisCmd(["SET", TELEGRAM_DEDUPE_PREFIX + hash, "1", "EX", String(DEDUPE_TTL_SECONDS)]) === "OK";
        result = saved
          ? { ok: true, providerDelivered: true, recoveredDedupe: true }
          : { ok: false, retryable: true, providerDelivered: true, error: "telegram_dedupe_store_unavailable" };
      } else {
        const marker = providerAttemptMarker({
          hash,
          fingerprint: record.fingerprint,
          incidentId: record.incidentId,
          event: record.event,
          message: record.message,
          prior: record,
          now,
        });
        if (!await upsertRetry(marker)) {
          failed += 1;
          continue;
        }
        result = await deliverTelegramMessage(record.message);
      }
      processed += 1;
      if (result.ok) {
        if (!record.providerDelivered) {
          const saved = await redisCmd(["SET", TELEGRAM_DEDUPE_PREFIX + hash, "1", "EX", String(DEDUPE_TTL_SECONDS)]) === "OK";
          if (!saved) {
            result = { ok: false, retryable: true, providerDelivered: true, error: "telegram_dedupe_store_unavailable" };
          }
        }
      }
      if (result.ok) {
        if (await removeRetry(hash)) sent += 1;
        else failed += 1;
      } else if (result.retryable) {
        const retry = await scheduleRetry({
          hash,
          fingerprint: record.fingerprint,
          incidentId: record.incidentId,
          event: record.event,
          message: record.message,
          prior: record,
          result,
          providerDelivered: Boolean(result.providerDelivered),
          now,
        });
        if (retry.queued) rescheduled += 1;
        else terminal += 1;
        result.retryQueued = Boolean(retry.queued);
      } else {
        if (await removeRetry(hash)) terminal += 1;
        else failed += 1;
      }
      const history = historyRecord({
        fingerprint: record.fingerprint,
        incidentId: record.incidentId,
        event: record.event,
        result,
        started,
        attempt: Number(record.attempts || 0) + 1,
      });
      const historySaved = await appendHistory(history);
      const healthSaved = await recordTelegramHealth(result, history);
      if (!historySaved || !healthSaved) failed += 1;
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }
  return {
    ok: failed === 0,
    scanned: hashes.length,
    processed,
    sent,
    rescheduled,
    terminal,
    failed,
    ...(failed ? { error: "telegram_retry_processing_failed" } : {}),
  };
}

function incidentUrl(incidentId) {
  const base = String(process.env.SITE_URL || "https://www.liumeiti.vip").replace(/\/$/, "");
  return `${base}/admin?tab=health&incident=${encodeURIComponent(incidentId)}`;
}

export async function notifyIncidentOpened(incident, { reopened = false } = {}) {
  if (!incident?.id) return { ok: false, error: "incident_required" };
  const title = reopened ? "事故再次发生" : "系统事故告警";
  const text = [
    `🚨 [${incident.severity || "P2"}] ${title}`,
    `事故: ${incident.id}`,
    `组件: ${incident.component || "system"}`,
    `问题: ${incident.title || "系统异常"}`,
    incident.lastErrorCode ? `错误: ${incident.lastErrorCode}` : "",
    `次数: ${Number(incident.occurrences || 1)}`,
    `后台: ${incidentUrl(incident.id)}`,
  ].filter(Boolean).join("\n");
  return sendOperationalTelegram({
    fingerprint: incident.fingerprint || incident.id,
    incidentId: incident.id,
    event: reopened ? `reopened:${incident.version}` : "opened",
    text,
  });
}

export async function notifyIncidentRecovered(incident) {
  if (!incident?.id) return { ok: false, error: "incident_required" };
  const text = [
    "✅ 系统事故已连续三次恢复正常",
    `事故: ${incident.id}`,
    `组件: ${incident.component || "system"}`,
    `问题: ${incident.title || "系统异常"}`,
    "状态: 已恢复，等待管理员填写处理结论并关闭",
    `后台: ${incidentUrl(incident.id)}`,
  ].join("\n");
  return sendOperationalTelegram({
    fingerprint: incident.fingerprint || incident.id,
    incidentId: incident.id,
    event: `recovered:${incident.version}`,
    text,
  });
}

export async function readTelegramAlertHistory(limit = 100) {
  const safeLimit = Math.max(1, Math.min(HISTORY_LIMIT, Number(limit || 100)));
  const result = strictPipelineRows(await redisPipeline([
    ["LRANGE", TELEGRAM_HISTORY_KEY, "0", String(safeLimit - 1)],
    ["PING"],
  ]), 2, "telegram_history_unavailable");
  if (!Array.isArray(result[0]) || result[1] !== "PONG") throw storageError("telegram_history_unavailable");
  return result[0].map((value) => {
    const record = parseJson(value);
    if (!record || typeof record !== "object") throw storageError("telegram_history_corrupt");
    return record;
  });
}

export async function readTelegramRetryQueue(limit = 100) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 100)));
  const index = strictPipelineRows(await redisPipeline([
    ["ZRANGE", TELEGRAM_RETRY_INDEX, "0", String(safeLimit - 1)],
    ["PING"],
  ]), 2, "telegram_retry_queue_unavailable");
  if (!Array.isArray(index[0]) || index[1] !== "PONG") throw storageError("telegram_retry_queue_unavailable");
  const hashes = index[0];
  if (!hashes.length) return [];
  const rows = strictPipelineRows(
    await redisPipeline(hashes.map((hash) => ["GET", retryRecordKey(hash)])),
    hashes.length,
    "telegram_retry_queue_unavailable",
  );
  return rows.map((value) => {
    const record = parseJson(value);
    if (!record || typeof record !== "object") throw storageError("telegram_retry_record_corrupt");
    return record;
  });
}

export const telegramAlertInternals = {
  RETRY_MAX_AGE_MS,
  RETRY_MAX_ATTEMPTS,
  TELEGRAM_RETRY_INDEX,
  TELEGRAM_RETRY_PREFIX,
  alertFingerprint,
  maskEmail,
  providerFailure,
  retryDelayMs,
  retryRecordKey,
};
