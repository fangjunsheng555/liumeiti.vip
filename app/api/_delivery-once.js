import { createHash, randomBytes } from "node:crypto";
import { clean, redisCmd } from "./_utils.js";

const DELIVERY_PREFIX = "lm:delivery:v1:";
const CLAIM_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if raw then
  if raw=='done' then return 'done' end
  local ok,state=pcall(cjson.decode,raw)
  if not ok or type(state)~='table' then return 'uncertain' end
  local status=tostring(state.status or '')
  if status=='done' or status=='sending' or status=='uncertain' then return status end
  if status~='retryable' then return 'uncertain' end
end
redis.call('SET',KEYS[1],ARGV[2])
return 'acquired'`;

function deliveryKey(id) {
  const normalized = clean(id, 300);
  return DELIVERY_PREFIX + createHash("sha256").update(normalized).digest("hex");
}

function succeeded(value) {
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.ok === true);
}

function journalEntry(status, token, extra = {}) {
  return JSON.stringify({ status, token, at: new Date().toISOString(), ...extra });
}

// Serialize one external delivery and keep a permanent dispatch journal.
// A process/provider failure after dispatch is inherently ambiguous for
// transports without provider-side idempotency (SMTP and Telegram). In that
// case the journal remains `sending`/`uncertain` and automatic retries stop,
// which prevents duplicate external effects. Definite provider rejections are
// recorded as retryable, while successful providers still receive stableId so
// transports with native idempotency close the remaining acknowledgement gap.
export async function deliverOnce(id, deliver) {
  const stableId = clean(id, 300);
  if (!stableId || typeof deliver !== "function") return { ok: false, error: "invalid_delivery" };
  const key = deliveryKey(stableId);
  const token = randomBytes(18).toString("hex");
  const sending = journalEntry("sending", token);
  // One script performs the authoritative journal read, dispatch claim and
  // pre-dispatch `sending` write. A Redis/HTTP failure returns no recognised
  // claim and therefore can never fall through to the external provider.
  const claim = await redisCmd(["EVAL", CLAIM_SCRIPT, "1", key, token, sending]);
  if (claim === "done") return { ok: true, idempotent: true };
  if (claim === "sending") return { ok: false, pending: true, uncertain: true };
  if (claim === "uncertain") return { ok: false, uncertain: true, error: "delivery_result_uncertain" };
  if (claim === "pending") return { ok: false, pending: true };
  if (claim !== "acquired") return { ok: false, error: "delivery_journal_unavailable" };

  try {
    const value = await deliver(stableId);
    if (value == null) {
      await redisCmd(["SET", key, journalEntry("retryable", token, { reason: "skipped" })]);
      return { ok: true, skipped: true };
    }
    if (value && typeof value === "object" && value.uncertain === true) {
      const deliveryError = clean(value.error || value.reason || "delivery_result_uncertain", 200);
      await redisCmd(["SET", key, journalEntry("uncertain", token, { error: deliveryError })]);
      return { ok: false, uncertain: true, error: deliveryError, value };
    }
    if (!succeeded(value)) {
      await redisCmd(["SET", key, journalEntry("retryable", token, { reason: "provider_rejected" })]);
      return { ok: false, value };
    }
    const recorded = await redisCmd(["SET", key, "done"]);
    return {
      ok: true,
      value,
      recorded: recorded === "OK",
      ...(recorded === "OK" ? {} : { uncertain: true }),
    };
  } catch (error) {
    await redisCmd(["SET", key, journalEntry("uncertain", token, {
      error: clean(error?.message || "delivery_failed", 200),
    })]);
    return {
      ok: false,
      uncertain: true,
      error: clean(error?.message || "delivery_failed", 200),
    };
  }
}

export const deliveryInternals = { deliveryKey };
