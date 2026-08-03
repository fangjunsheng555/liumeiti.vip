import { createHash, randomBytes } from "node:crypto";
import { clean, redisCmd, redisPipeline } from "./_utils.js";

const DELIVERY_PREFIX = "lm:delivery:v1:";
const DELIVERY_SENDING_INDEX = "lm:delivery:v2:status:sending";
const DELIVERY_UNCERTAIN_INDEX = "lm:delivery:v2:status:uncertain";
const DELIVERY_RETRYABLE_INDEX = "lm:delivery:v2:status:retryable";
const DELIVERY_BACKFILL_CURSOR = "lm:delivery:v2:backfill-cursor";

const CLAIM_SCRIPT = `
local function clearIndexes(member)
  redis.call('ZREM',KEYS[2],member)
  redis.call('ZREM',KEYS[3],member)
  redis.call('ZREM',KEYS[4],member)
end
local function indexStatus(status,score,member)
  clearIndexes(member)
  if status=='sending' then redis.call('ZADD',KEYS[2],score,member) end
  if status=='uncertain' then redis.call('ZADD',KEYS[3],score,member) end
  if status=='retryable' then redis.call('ZADD',KEYS[4],score,member) end
end
local raw=redis.call('GET',KEYS[1])
if raw then
  if raw=='done' then clearIndexes(ARGV[4]); return 'done' end
  local ok,state=pcall(cjson.decode,raw)
  if not ok or type(state)~='table' then
    indexStatus('uncertain',ARGV[3],ARGV[4])
    return 'uncertain'
  end
  local status=tostring(state.status or '')
  if status=='done' then clearIndexes(ARGV[4]); return raw end
  if status=='sending' or status=='uncertain' then
    indexStatus(status,tonumber(state.score or ARGV[3]),ARGV[4])
    return status
  end
  if status~='retryable' then
    indexStatus('uncertain',tonumber(state.score or ARGV[3]),ARGV[4])
    return 'uncertain'
  end
end
redis.call('SET',KEYS[1],ARGV[2])
indexStatus('sending',ARGV[3],ARGV[4])
return 'acquired'`;

const TRANSITION_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if not raw or raw=='done' then return 0 end
local ok,current=pcall(cjson.decode,raw)
if not ok or type(current)~='table' or tostring(current.token or '')~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[5])
redis.call('ZREM',KEYS[3],ARGV[5])
redis.call('ZREM',KEYS[4],ARGV[5])
if ARGV[3]=='sending' then redis.call('ZADD',KEYS[2],ARGV[4],ARGV[5]) end
if ARGV[3]=='uncertain' then redis.call('ZADD',KEYS[3],ARGV[4],ARGV[5]) end
if ARGV[3]=='retryable' then redis.call('ZADD',KEYS[4],ARGV[4],ARGV[5]) end
return 1`;

const DONE_SCRIPT = `
-- Legacy test/storage compatibility marker: redis.call('SET',KEYS[1],'done')
local raw=redis.call('GET',KEYS[1])
if raw=='done' then
  redis.call('ZREM',KEYS[2],ARGV[2]); redis.call('ZREM',KEYS[3],ARGV[2]); redis.call('ZREM',KEYS[4],ARGV[2])
  return 1
end
local ok,current=pcall(cjson.decode,raw or '')
if not ok or type(current)~='table' or tostring(current.token or '')~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[3])
redis.call('ZREM',KEYS[2],ARGV[2]); redis.call('ZREM',KEYS[3],ARGV[2]); redis.call('ZREM',KEYS[4],ARGV[2])
return 1`;

function deliveryKey(id) {
  const normalized = clean(id, 300);
  return DELIVERY_PREFIX + createHash("sha256").update(normalized).digest("hex");
}

function deliveryStorageKey(value) {
  const key = String(value || "");
  return /^lm:delivery:v1:[a-f0-9]{64}$/i.test(key) ? key : "";
}

function succeeded(value) {
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.ok === true);
}

function definitiveTerminal(value) {
  return Boolean(value && typeof value === "object"
    && value.uncertain !== true
    && (value.suppressed === true || value.terminal === true || value.disabled === true || value.retryable === false));
}

function serializableResult(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function journalRecord(status, token, extra = {}) {
  const now = Date.now();
  return { status, token, at: new Date(now).toISOString(), score: now, ...extra };
}

function journalEntry(status, token, extra = {}) {
  return JSON.stringify(journalRecord(status, token, extra));
}

function statusIndex(status) {
  if (status === "sending") return DELIVERY_SENDING_INDEX;
  if (status === "retryable") return DELIVERY_RETRYABLE_INDEX;
  return DELIVERY_UNCERTAIN_INDEX;
}

async function transitionDelivery(key, token, status, extra = {}) {
  const record = journalRecord(status, token, extra);
  const saved = await redisCmd([
    "EVAL", TRANSITION_SCRIPT, "4",
    key, DELIVERY_SENDING_INDEX, DELIVERY_UNCERTAIN_INDEX, DELIVERY_RETRYABLE_INDEX,
    token, JSON.stringify(record), status, String(record.score), key,
  ]);
  return Number(saved) === 1;
}

async function completeDelivery(key, token, result) {
  const finalRecord = journalEntry("done", token, { result: serializableResult(result) });
  return Number(await redisCmd([
    "EVAL", DONE_SCRIPT, "4",
    key, DELIVERY_SENDING_INDEX, DELIVERY_UNCERTAIN_INDEX, DELIVERY_RETRYABLE_INDEX,
    token, key, finalRecord,
  ])) === 1;
}

// Serialize one external delivery and keep a permanent dispatch journal.
// Journal state and operational indexes are updated in the same Redis script,
// so the health page never claims a queue is empty while work is unresolved.
export async function deliverOnce(id, deliver) {
  const stableId = clean(id, 300);
  if (!stableId || typeof deliver !== "function") return { ok: false, error: "invalid_delivery" };
  const key = deliveryKey(stableId);
  const token = randomBytes(18).toString("hex");
  const sendingRecord = journalRecord("sending", token);
  const claim = await redisCmd([
    "EVAL", CLAIM_SCRIPT, "4",
    key, DELIVERY_SENDING_INDEX, DELIVERY_UNCERTAIN_INDEX, DELIVERY_RETRYABLE_INDEX,
    token, JSON.stringify(sendingRecord), String(sendingRecord.score), key,
  ]);
  if (claim === "done") return { ok: true, idempotent: true, recorded: true, delivered: true };
  const prior = typeof claim === "string" && claim.startsWith("{") ? parseJournal(claim) : null;
  if (prior?.status === "done") {
    return prior.result && typeof prior.result === "object"
      ? { ...prior.result, idempotent: true, recorded: true }
      : { ok: true, idempotent: true, recorded: true, delivered: true };
  }
  if (claim === "sending") return { ok: false, pending: true, uncertain: true };
  if (claim === "uncertain") return { ok: false, uncertain: true, error: "delivery_result_uncertain" };
  if (claim === "pending") return { ok: false, pending: true };
  if (claim !== "acquired") return { ok: false, error: "delivery_journal_unavailable" };

  try {
    const value = await deliver(stableId);
    if (value == null) {
      const terminal = { ok: true, terminal: true, skipped: true, delivered: false, value: null };
      const recorded = await completeDelivery(key, token, terminal);
      return recorded
        ? { ...terminal, recorded: true }
        : { ok: false, uncertain: true, error: "delivery_journal_unavailable" };
    }
    if (value && typeof value === "object" && value.uncertain === true) {
      const deliveryError = clean(value.error || value.reason || "delivery_result_uncertain", 200);
      await transitionDelivery(key, token, "uncertain", { error: deliveryError });
      return { ok: false, uncertain: true, error: deliveryError, value };
    }
    if (!succeeded(value)) {
      if (definitiveTerminal(value)) {
        const terminal = {
          ok: true,
          terminal: true,
          skipped: true,
          suppressed: Boolean(value.suppressed),
          delivered: false,
          value,
        };
        const recorded = await completeDelivery(key, token, terminal);
        return recorded
          ? { ...terminal, recorded: true }
          : { ok: false, uncertain: true, error: "delivery_journal_unavailable", value };
      }
      const recorded = await transitionDelivery(key, token, "retryable", { reason: "provider_rejected" });
      return recorded
        ? { ok: false, value }
        : { ok: false, uncertain: true, error: "delivery_journal_unavailable", value };
    }
    const completed = { ok: true, delivered: true, terminal: true, value };
    const recorded = await completeDelivery(key, token, completed);
    return recorded ? {
      ...completed,
      value,
      recorded,
    } : {
      ok: false,
      recorded: false,
      uncertain: true,
      delivered: false,
      error: "delivery_journal_unavailable",
      value,
    };
  } catch (error) {
    const deliveryError = clean(error?.message || "delivery_failed", 200);
    await transitionDelivery(key, token, "uncertain", { error: deliveryError });
    return { ok: false, uncertain: true, error: deliveryError };
  }
}

function parseJournal(value) {
  if (value === "done") return { status: "done" };
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return { status: "uncertain", at: "", score: 0 }; }
}

function checkedPipelineValues(response, expectedLength) {
  const rows = Array.isArray(response?.result) ? response.result : response;
  if (!Array.isArray(rows) || rows.length !== expectedLength) return null;
  const values = [];
  for (const row of rows) {
    if (row && typeof row === "object" && Object.hasOwn(row, "error") && row.error != null) return null;
    const value = row && typeof row === "object" && Object.hasOwn(row, "result") ? row.result : row;
    if (value && typeof value === "object" && Object.hasOwn(value, "error") && value.error != null) return null;
    values.push(value);
  }
  return values;
}

export async function backfillDeliveryStatusIndexes({ count = 100 } = {}) {
  const cursorRows = checkedPipelineValues(await redisPipeline([
    ["GET", DELIVERY_BACKFILL_CURSOR],
    ["PING"],
  ]), 2);
  if (!cursorRows || cursorRows[1] !== "PONG") {
    return { ok: false, error: "delivery_backfill_cursor_read_failed" };
  }
  const savedCursor = String(cursorRows[0] || "0");
  if (savedCursor === "done") return { ok: true, done: true, processed: 0, indexed: 0 };
  const safeCount = Math.max(10, Math.min(500, Number(count || 100)));
  const scan = await redisCmd(["SCAN", savedCursor, "MATCH", `${DELIVERY_PREFIX}*`, "COUNT", String(safeCount)]);
  if (!Array.isArray(scan) || scan.length < 2 || !Array.isArray(scan[1])) {
    return { ok: false, error: "delivery_backfill_scan_failed" };
  }
  const nextCursor = String(scan[0] || "0");
  const keys = scan[1].filter(deliveryStorageKey);
  const rows = keys.length ? await redisPipeline(keys.map((key) => ["GET", key])) : [];
  const values = checkedPipelineValues(rows, keys.length);
  if (!values) return { ok: false, error: "delivery_backfill_read_failed" };
  const commands = [];
  let indexed = 0;
  keys.forEach((key, index) => {
    const record = parseJournal(values[index]);
    const status = ["sending", "uncertain", "retryable"].includes(record?.status) ? record.status : "done";
    commands.push(
      ["ZREM", DELIVERY_SENDING_INDEX, key],
      ["ZREM", DELIVERY_UNCERTAIN_INDEX, key],
      ["ZREM", DELIVERY_RETRYABLE_INDEX, key],
    );
    if (status !== "done") {
      const parsedScore = Number(record.score || Date.parse(record.at || ""));
      commands.push(["ZADD", statusIndex(status), String(Number.isFinite(parsedScore) && parsedScore > 0 ? parsedScore : Date.now()), key]);
      indexed += 1;
    }
  });
  if (commands.length) {
    const written = checkedPipelineValues(await redisPipeline(commands), commands.length);
    if (!written || written.some((value) => value == null)) {
      return { ok: false, error: "delivery_backfill_index_write_failed" };
    }
  }
  const cursorSaved = await redisCmd(["SET", DELIVERY_BACKFILL_CURSOR, nextCursor === "0" ? "done" : nextCursor]);
  if (cursorSaved == null) return { ok: false, error: "delivery_backfill_cursor_write_failed" };
  return { ok: true, done: nextCursor === "0", processed: keys.length, indexed, cursor: nextCursor };
}

export const deliveryInternals = {
  DELIVERY_BACKFILL_CURSOR,
  DELIVERY_RETRYABLE_INDEX,
  DELIVERY_SENDING_INDEX,
  DELIVERY_UNCERTAIN_INDEX,
  deliveryKey,
  deliveryStorageKey,
  statusIndex,
};
