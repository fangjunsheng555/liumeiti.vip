import { randomBytes } from "node:crypto";
import {
  clean,
  formatBeijingTime,
  getOrderById,
  getPendingUsdtOrderEntries,
  pushAdminActionLog,
  redisCmd,
  setOrderAt,
} from "./_utils.js";

export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const CHECK_LOCK_KEY = "lm:usdt:confirm-lock";
const TX_CLAIM_PREFIX = "lm:usdt:confirmed-tx:";
const LOCK_TTL_SECONDS = 45;
const TX_CLAIM_TTL_SECONDS = 180 * 24 * 60 * 60;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const QUOTE_GRACE_MS = 5 * 60 * 1000;
const MAX_CHAIN_PAGES = 5;

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
  if (!token || !chatId) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function releaseLock(token) {
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  await redisCmd(["EVAL", script, "1", CHECK_LOCK_KEY, token]);
}

async function releaseTransactionClaim(txId, orderId) {
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  await redisCmd(["EVAL", script, "1", TX_CLAIM_PREFIX + txId, orderId]);
}

export async function confirmPendingUsdtPayments({ settings, actor, fetchImpl = fetch } = {}) {
  if (!settings?.usdt?.autoConfirm) return { ok: true, disabled: true, scanned: 0, matched: 0, pending: 0 };
  const address = String(settings.usdt.address || "").trim();
  if (!address) return { ok: false, error: "no_usdt_address" };

  const lockToken = randomBytes(16).toString("hex");
  const locked = await redisCmd(["SET", CHECK_LOCK_KEY, lockToken, "EX", String(LOCK_TTL_SECONDS), "NX"]);
  if (locked !== "OK") return { ok: true, busy: true, scanned: 0, matched: 0, pending: 0 };

  try {
    const pending = await getPendingUsdtOrderEntries(500);
    if (!pending.length) return { ok: true, scanned: 0, matched: 0, pending: 0, ambiguous: 0 };
    const minTimestamp = pending.reduce((min, entry) => {
      const issued = new Date(entry.order.paymentQuoteIssuedAt || 0).getTime();
      return Number.isFinite(issued) && issued > 0 ? Math.min(min, issued - CLOCK_SKEW_MS) : min;
    }, Date.now());
    const chain = await fetchConfirmedIncoming(address, minTimestamp, fetchImpl);
    if (!chain.ok) return chain;

    const matched = [];
    const claimedOrders = new Set();
    let ambiguous = 0;
    for (const tx of chain.transactions) {
      if (await redisCmd(["GET", TX_CLAIM_PREFIX + tx.txId])) continue;
      const candidates = pending.filter((entry) =>
        !claimedOrders.has(entry.order.orderId)
        && transactionMatchesUsdtOrder(entry.order, tx)
      );
      if (candidates.length !== 1) {
        if (candidates.length > 1) ambiguous += 1;
        continue;
      }

      const candidate = candidates[0];
      const orderId = candidate.order.orderId;
      const txClaimed = await redisCmd([
        "SET", TX_CLAIM_PREFIX + tx.txId, orderId,
        "EX", String(TX_CLAIM_TTL_SECONDS), "NX",
      ]);
      if (txClaimed !== "OK") continue;

      const latest = await getOrderById(orderId);
      if (
        !latest || latest.status !== "received" || latest.paidCurrency !== "USDT"
        || latest.usdtConfirmedAt || !transactionMatchesUsdtOrder(latest, tx)
      ) {
        await releaseTransactionClaim(tx.txId, orderId);
        continue;
      }

      const confirmedAt = new Date();
      const updated = {
        ...latest,
        usdtConfirmedAt: confirmedAt.toISOString(),
        usdtConfirmedAtBeijing: formatBeijingTime(confirmedAt),
        usdtTxId: tx.txId,
        usdtConfirmedAmount: tx.amount,
        usdtChainTimestamp: new Date(tx.ts).toISOString(),
      };
      const saved = await setOrderAt({ orderId, legacyIndex: null }, updated);
      if (!saved) {
        await releaseTransactionClaim(tx.txId, orderId);
        continue;
      }

      claimedOrders.add(orderId);
      matched.push({ orderId, amount: tx.amount, txId: tx.txId });
      await pushAdminActionLog({
        action: "usdt_auto_confirm",
        actor: actor || { staffId: 0, staffUsername: "system" },
        target: `order:${orderId}`,
        detail: { amount: tx.amount, txId: tx.txId },
      });
      if (settings.notify?.telegramEnabled !== false) {
        await sendTelegram([
          "USDT 到账自动确认",
          `订单: ${orderId}`,
          `金额: ${tx.amount} USDT`,
          `邮箱: ${updated.email || ""}`,
          `交易: ${tx.txId}`,
        ].join("\n"));
      }
    }

    return {
      ok: true,
      scanned: chain.transactions.length,
      matched: matched.length,
      orders: matched,
      pending: Math.max(0, pending.length - matched.length),
      ambiguous,
    };
  } finally {
    await releaseLock(lockToken);
  }
}
