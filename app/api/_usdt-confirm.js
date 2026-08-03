import { randomBytes } from "node:crypto";
import {
  confirmUsdtOrderAtomic,
  USDT_CONFIRM_EFFECT_INDEX_KEY,
  USDT_CONFIRM_EFFECT_RECORDS_KEY,
  usdtConfirmationEffectKey,
} from "./_money.js";
import {
  clean,
  getOrderById,
  getPendingUsdtOrderEntries,
  pushAdminActionLog,
  redisCmd,
} from "./_utils.js";
import { deliverOnce } from "./_delivery-once.js";
import { enqueueOrderPushEvent } from "./_push.js";
import { appendBusinessTraceEvent } from "./_observability.js";

export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const CHECK_LOCK_KEY = "lm:usdt:confirm-lock";
const TX_CLAIM_PREFIX = "lm:usdt:confirmed-tx:";
const LOCK_TTL_SECONDS = 45;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const QUOTE_GRACE_MS = 5 * 60 * 1000;
const MAX_CHAIN_PAGES = 5;
const MAX_EFFECTS_PER_PASS = 100;

const COMPLETE_EFFECT_SCRIPT = `
local raw=redis.call('HGET',KEYS[1],ARGV[1])
if not raw then
  redis.call('ZREM',KEYS[2],ARGV[1])
  return 'missing'
end
if raw~=ARGV[2] then return 'changed' end
redis.call('HDEL',KEYS[1],ARGV[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return 'removed'`;

function sameTronAddress(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a.startsWith("T") || b.startsWith("T")) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function decimalToMicros(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 1000000);
}

function rawValueToMicros(value, decimals) {
  try {
    const raw = BigInt(String(value || "0"));
    const scale = Number(decimals);
    if (!Number.isInteger(scale) || scale < 0 || scale > 30 || raw < 0n) return null;
    if (scale === 6) return raw;
    if (scale < 6) return raw * (10n ** BigInt(6 - scale));
    const divisor = 10n ** BigInt(scale - 6);
    if (raw % divisor !== 0n) return null;
    return raw / divisor;
  } catch (e) {
    return null;
  }
}

export function normalizeConfirmedUsdtTransfers(payload, receivingAddress) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((row) => {
    const tokenAddress = String(row?.token_info?.address || row?.token_info?.contract_address || "");
    const micros = rawValueToMicros(row?.value, row?.token_info?.decimals ?? 6);
    const txId = clean(row?.transaction_id, 96);
    const to = String(row?.to || "").trim();
    const ts = Number(row?.block_timestamp || 0);
    if (
      !txId || micros === null || micros <= 0n || !Number.isFinite(ts) || ts <= 0
      || !sameTronAddress(to, receivingAddress)
      || (tokenAddress && !sameTronAddress(tokenAddress, USDT_TRC20_CONTRACT))
    ) return null;
    return {
      txId,
      to,
      from: String(row?.from || "").trim(),
      micros,
      amount: Number(micros) / 1000000,
      ts,
    };
  }).filter(Boolean);
}

function quoteWindow(order) {
  const start = new Date(order?.paymentQuoteIssuedAt || 0).getTime();
  const end = new Date(order?.paymentQuoteExpiresAt || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) return null;
  return { start: start - CLOCK_SKEW_MS, end: end + QUOTE_GRACE_MS };
}

export function transactionMatchesUsdtOrder(order, transaction) {
  const expectedMicros = decimalToMicros(order?.usdtPayAmount);
  const window = quoteWindow(order);
  if (!expectedMicros || !window || !transaction) return false;
  return BigInt(expectedMicros) === transaction.micros
    && transaction.ts >= window.start
    && transaction.ts <= window.end;
}

async function fetchConfirmedIncoming(address, minTimestamp, fetchImpl = fetch) {
  const transactions = [];
  let fingerprint = "";
  for (let page = 0; page < MAX_CHAIN_PAGES; page += 1) {
    const params = new URLSearchParams({
      only_to: "true",
      only_confirmed: "true",
      limit: "200",
      order_by: "block_timestamp,desc",
      contract_address: USDT_TRC20_CONTRACT,
      min_timestamp: String(Math.max(0, Number(minTimestamp || 0))),
    });
    if (fingerprint) params.set("fingerprint", fingerprint);
    const url = `https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params}`;
    const headers = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        cache: "no-store",
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
    } catch (error) {
      return { ok: false, error: "chain_fetch_failed", detail: clean(error?.message, 160) };
    }
    if (!response.ok) return { ok: false, error: "chain_fetch_failed", status: response.status };
    const payload = await response.json();
    transactions.push(...normalizeConfirmedUsdtTransfers(payload, address));
    fingerprint = String(payload?.meta?.fingerprint || "");
    if (!fingerprint || !payload?.data?.length) break;
  }
  const seen = new Set();
  return {
    ok: true,
    transactions: transactions.filter((tx) => !seen.has(tx.txId) && seen.add(tx.txId)),
  };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: true, skipped: true, reason: "telegram_not_configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (response.ok) return { ok: true };
    if (response.status >= 500 || [408, 425, 429].includes(response.status)) {
      return { ok: false, uncertain: true, error: `telegram_${response.status}` };
    }
    return { ok: false, error: `telegram_${response.status}` };
  } catch (error) {
    return { ok: false, uncertain: true, error: clean(error?.message || "telegram_transport_uncertain", 160) };
  }
}

function parseConfirmationEffect(raw, expectedKey) {
  let effect;
  try { effect = JSON.parse(raw); } catch { return null; }
  const effectKey = clean(effect?.effectKey, 80);
  const orderId = clean(effect?.orderId, 80).replace(/\s+/g, "").toUpperCase();
  const txId = clean(effect?.txId, 96);
  const amount = Number(effect?.amount);
  let amountMicros;
  try { amountMicros = BigInt(String(effect?.amountMicros || "0")); } catch { amountMicros = 0n; }
  if (
    Number(effect?.version) !== 1 || !/^[a-f0-9]{64}$/.test(effectKey)
    || effectKey !== clean(expectedKey, 80)
    || effectKey !== usdtConfirmationEffectKey(orderId, txId)
    || !orderId || !txId || !Number.isFinite(amount) || amount <= 0 || amountMicros <= 0n
    || amountMicros > BigInt(Number.MAX_SAFE_INTEGER)
    || Math.round(amount * 1_000_000) !== Number(amountMicros)
  ) return null;
  const actorId = Number(effect.actor?.staffId);
  return {
    ...effect,
    effectKey,
    orderId,
    txId,
    amount,
    amountMicros: String(amountMicros),
    email: clean(effect.email, 200),
    userEmail: clean(effect.userEmail, 254).toLowerCase(),
    accountLifecycleId: clean(effect.accountLifecycleId, 80).toLowerCase(),
    locale: effect.locale === "en" ? "en" : "zh",
    businessTraceId: clean(effect.businessTraceId, 40),
    actor: {
      staffId: Number.isSafeInteger(actorId) && actorId >= 0 ? actorId : 0,
      staffUsername: clean(effect.actor?.staffUsername || "system", 60) || "system",
    },
  };
}

function effectDeliverySettled(result) {
  return result?.ok === true || (result?.uncertain === true && result?.pending !== true);
}

function confirmationNotice(effect) {
  return [
    "USDT 到账自动确认",
    `订单: ${effect.orderId}`,
    `金额: ${effect.amount} USDT`,
    `邮箱: ${effect.email || ""}`,
    `交易: ${effect.txId}`,
  ].join("\n");
}

async function completeConfirmationEffect(effectKey, raw) {
  const result = await redisCmd([
    "EVAL",
    COMPLETE_EFFECT_SCRIPT,
    "2",
    USDT_CONFIRM_EFFECT_RECORDS_KEY,
    USDT_CONFIRM_EFFECT_INDEX_KEY,
    effectKey,
    raw,
  ]);
  return result === "removed" || result === "missing";
}

export async function dispatchUsdtConfirmationEffect(effectKeyValue, settings = {}) {
  const effectKey = clean(effectKeyValue, 80);
  if (!/^[a-f0-9]{64}$/.test(effectKey)) return { ok: false, error: "invalid_confirmation_effect" };
  const raw = await redisCmd(["HGET", USDT_CONFIRM_EFFECT_RECORDS_KEY, effectKey]);
  if (typeof raw !== "string" || !raw) {
    return { ok: false, missing: raw == null, error: "confirmation_effect_unavailable" };
  }
  const effect = parseConfirmationEffect(raw, effectKey);
  if (!effect) return { ok: false, error: "invalid_confirmation_effect" };

  const prefix = `usdt-confirm:${effect.orderId}:${effect.txId}`;
  const adminLog = await deliverOnce(`${prefix}:admin-log`, async () => {
    const written = await pushAdminActionLog({
      action: "usdt_auto_confirm",
      actor: effect.actor,
      target: `order:${effect.orderId}`,
      detail: { amount: effect.amount, txId: effect.txId },
    });
    // A failed REST response cannot prove whether the Redis log pipeline
    // committed, so stop automatic retries instead of risking a duplicate row.
    return written
      ? { ok: true }
      : { ok: false, uncertain: true, error: "admin_log_result_uncertain" };
  });
  const telegram = await deliverOnce(`${prefix}:telegram`, () => (
    settings.notify?.telegramEnabled === false
      ? { ok: true, skipped: true, reason: "telegram_disabled" }
      : sendTelegram(confirmationNotice(effect))
  ));
  const push = await enqueueOrderPushEvent({
    orderId: effect.orderId,
    userEmail: effect.userEmail,
    accountLifecycleId: effect.accountLifecycleId,
    locale: effect.locale,
  }, "order.payment_confirmed", `usdt:${effect.txId}`)
    .catch((error) => ({ ok: false, error: error?.message || "push_enqueue_failed" }));
  await appendBusinessTraceEvent(effect.orderId, {
    businessTraceId: effect.businessTraceId,
    stage: "usdt_payment_confirmed",
    component: "usdt",
    outcome: "ok",
    operationId: `usdt:${effect.txId}`,
  }).catch(() => null);
  await appendBusinessTraceEvent(effect.orderId, {
    businessTraceId: effect.businessTraceId,
    stage: "push_enqueue_payment_confirmed",
    component: "push",
    outcome: push.ok === false ? "error" : push.skipped ? "skipped" : "ok",
    operationId: `usdt:${effect.txId}`,
    errorCode: push.error || push.reason || "",
  }).catch(() => null);

  const settled = effectDeliverySettled(adminLog) && effectDeliverySettled(telegram);
  if (!settled) return { ok: false, pending: true, effect, adminLog, telegram, push };
  const removed = await completeConfirmationEffect(effectKey, raw);
  const uncertain = Boolean(adminLog?.uncertain || telegram?.uncertain);
  return {
    ok: removed && !uncertain,
    settled: removed,
    uncertain,
    effect,
    adminLog,
    telegram,
    push,
    ...(removed ? {} : { error: "confirmation_effect_finalize_failed" }),
  };
}

export async function drainUsdtConfirmationEffects({ settings = {}, limit = MAX_EFFECTS_PER_PASS } = {}) {
  const requestedLimit = Number(limit);
  const boundedLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_EFFECTS_PER_PASS, Math.floor(requestedLimit)))
    : MAX_EFFECTS_PER_PASS;
  const keys = await redisCmd(["ZRANGE", USDT_CONFIRM_EFFECT_INDEX_KEY, "0", String(boundedLimit - 1)]);
  if (!Array.isArray(keys)) {
    return { ok: false, scanned: 0, settled: 0, failed: 1, error: "confirmation_effect_index_unavailable" };
  }
  let settled = 0;
  let failed = 0;
  for (const key of keys) {
    const result = await dispatchUsdtConfirmationEffect(key, settings);
    if (result.settled) settled += 1;
    if (!result.ok) failed += 1;
  }
  return { ok: failed === 0, scanned: keys.length, settled, failed };
}

export function isFreshUsdtConfirmation(confirmation) {
  return confirmation?.ok === true && confirmation.idempotent !== true;
}

async function releaseLock(token) {
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  await redisCmd(["EVAL", script, "1", CHECK_LOCK_KEY, token]);
}

export async function confirmPendingUsdtPayments({ settings, actor, fetchImpl = fetch } = {}) {
  // The outbox is created in the same Lua commit as the payment confirmation.
  // Drain it even when scanning is disabled or no pending orders remain.
  const recoveredEffects = await drainUsdtConfirmationEffects({ settings });
  if (!settings?.usdt?.autoConfirm) {
    return {
      ok: recoveredEffects.ok,
      disabled: true,
      scanned: 0,
      matched: 0,
      pending: 0,
      effects: recoveredEffects,
    };
  }
  const address = String(settings.usdt.address || "").trim();
  if (!address) return { ok: false, error: "no_usdt_address", effects: recoveredEffects };

  const lockToken = randomBytes(16).toString("hex");
  // This short lock only avoids duplicate scans and chain API traffic. Payment
  // correctness is enforced by confirmUsdtOrderAtomic's Redis Lua transaction.
  const locked = await redisCmd(["SET", CHECK_LOCK_KEY, lockToken, "EX", String(LOCK_TTL_SECONDS), "NX"]);
  if (locked !== "OK") {
    return { ok: recoveredEffects.ok, busy: true, scanned: 0, matched: 0, pending: 0, effects: recoveredEffects };
  }

  try {
    const pending = await getPendingUsdtOrderEntries(500);
    if (!pending.length) {
      return { ok: recoveredEffects.ok, scanned: 0, matched: 0, pending: 0, ambiguous: 0, effects: recoveredEffects };
    }
    const minTimestamp = pending.reduce((min, entry) => {
      const issued = new Date(entry.order.paymentQuoteIssuedAt || 0).getTime();
      return Number.isFinite(issued) && issued > 0 ? Math.min(min, issued - CLOCK_SKEW_MS) : min;
    }, Date.now());
    const chain = await fetchConfirmedIncoming(address, minTimestamp, fetchImpl);
    if (!chain.ok) return chain;

    const matched = [];
    const claimedOrders = new Set();
    let ambiguous = 0;
    let dispatchedEffects = 0;
    let settledEffects = 0;
    let effectFailures = 0;
    for (const tx of chain.transactions) {
      const claimKey = TX_CLAIM_PREFIX + tx.txId;
      const existingOwner = clean(await redisCmd(["GET", claimKey]), 80).toUpperCase();
      let orderId = existingOwner;
      if (!orderId) {
        const candidates = pending.filter((entry) =>
          !claimedOrders.has(entry.order.orderId)
          && transactionMatchesUsdtOrder(entry.order, tx)
        );
        if (candidates.length !== 1) {
          if (candidates.length > 1) ambiguous += 1;
          continue;
        }
        orderId = candidates[0].order.orderId;
      }

      const latest = await getOrderById(orderId);
      if (latest?.usdtTxId === tx.txId && latest?.usdtConfirmedAt) {
        claimedOrders.add(orderId);
        continue;
      }
      if (
        !latest || latest.status !== "received" || latest.paidCurrency !== "USDT"
        || latest.usdtConfirmedAt || !transactionMatchesUsdtOrder(latest, tx)
      ) {
        continue;
      }

      const confirmation = await confirmUsdtOrderAtomic({
        order: latest,
        transaction: tx,
        confirmedAt: new Date(),
        effectActor: actor,
      });
      if (!confirmation?.ok) continue;

      claimedOrders.add(orderId);
      if (isFreshUsdtConfirmation(confirmation)) matched.push({ orderId, amount: tx.amount, txId: tx.txId });
      const effectKey = confirmation.effect?.effectKey || usdtConfirmationEffectKey(orderId, tx.txId);
      const effectResult = await dispatchUsdtConfirmationEffect(effectKey, settings);
      dispatchedEffects += 1;
      if (effectResult.settled) settledEffects += 1;
      if (!effectResult.ok) effectFailures += 1;
    }

    return {
      ok: recoveredEffects.ok && effectFailures === 0,
      scanned: chain.transactions.length,
      matched: matched.length,
      orders: matched,
      pending: Math.max(0, pending.length - matched.length),
      ambiguous,
      effects: {
        ok: recoveredEffects.ok && effectFailures === 0,
        scanned: recoveredEffects.scanned + dispatchedEffects,
        settled: recoveredEffects.settled + settledEffects,
        failed: recoveredEffects.failed + effectFailures,
      },
    };
  } finally {
    await releaseLock(lockToken);
  }
}
