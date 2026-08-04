import { DEFAULT_USER_AVATAR_ID, normalizeUserAvatarId } from "../lib/avatars.js";
import { authenticatedUserMatches } from "../lib/auth-recovery.js";

export const EMPTY_ACCOUNT_STATE = Object.freeze({
  loading: false,
  email: null,
  accountLifecycleId: "",
  username: "",
  avatarId: DEFAULT_USER_AVATAR_ID,
  orders: [],
  balance: 0,
  financeReady: false,
  financeError: "",
  txs: [],
  coupons: [],
  withdrawals: [],
  referral: null,
  referralDownlines: [],
});

function copyEmptyAccountState() {
  return { ...EMPTY_ACCOUNT_STATE, orders: [], txs: [], coupons: [], withdrawals: [], referralDownlines: [] };
}

function loadError(locale, kind) {
  const en = locale === "en";
  if (kind === "timeout") return en
    ? "Loading your account timed out. Check your connection and retry."
    : "账户信息读取超时，请检查网络后重试。";
  if (kind === "service") return en
    ? "The account service is temporarily unavailable. Please try again."
    : "账户服务暂时不可用，请稍后重试。";
  if (kind === "response") return en
    ? "We couldn't load your account. Retry or sign in again."
    : "无法读取账户信息，请重试或重新登录。";
  if (kind === "identity") return en
    ? "The signed-in account changed while the session was being verified. Sign in again."
    : "确认登录状态时账户已发生变化，请重新登录。";
  return en
    ? "We couldn't load your account. Check your connection and retry."
    : "账户信息加载失败，请检查网络后重试。";
}

function failure(locale, kind, message = "") {
  return { ok: false, loading: false, cancelled: false, retry: true, error: message || loadError(locale, kind), state: null };
}

function financeLoadError(locale, kind) {
  const en = locale === "en";
  if (kind === "timeout") return en
    ? "Balance details timed out. Retry before using any balance feature."
    : "资金信息读取超时，请重试后再进行余额操作。";
  if (kind === "service") return en
    ? "Balance details are temporarily unavailable. Retry before using any balance feature."
    : "资金服务暂时不可用，请重试后再进行余额操作。";
  if (kind === "response") return en
    ? "Balance details couldn't be verified. Retry before using any balance feature."
    : "资金信息暂时无法确认，请重试后再进行余额操作。";
  return en
    ? "Balance details couldn't load. Check your connection and retry."
    : "资金信息加载失败，请检查网络后重试。";
}

/** Pure request decision used by the Account page and executable tests. */
export async function requestAccountLoad({
  fetchImpl = globalThis.fetch,
  locale = "zh",
  timeoutMs = 15_000,
  signal: upstreamSignal,
  expectedIdentity = null,
} = {}) {
  const controller = new AbortController();
  const deadlineMs = Math.max(10, Number(timeoutMs) || 15_000);
  let timedOut = false;
  let cancelled = false;
  let rejectBoundary;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });

  const relayAbort = () => {
    cancelled = true;
    controller.abort(upstreamSignal?.reason);
    const error = new Error("account_load_cancelled");
    error.name = "AbortError";
    rejectBoundary(error);
  };
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener?.("abort", relayAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    const error = new Error("account_load_timeout");
    error.name = "TimeoutError";
    rejectBoundary(error);
  }, deadlineMs);

  const operation = async () => {
    const balancePromise = Promise.resolve()
      .then(() => fetchImpl("/api/auth/balance", { credentials: "same-origin", cache: "no-store", signal: controller.signal }))
      .then(async (response) => {
        if (!response.ok) return { response };
        try { return { response, data: await response.json() }; }
        catch { return { response, jsonError: true }; }
      }, (error) => ({ error }));
    const meRes = await fetchImpl("/api/auth/me", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (meRes.status === 401) {
      controller.abort();
      return { ok: false, loading: false, cancelled: false, retry: false, guest: true, status: 401, error: "", state: copyEmptyAccountState() };
    }

    let me = null;
    try { me = await meRes.json(); } catch {}
    if (!meRes.ok || !me?.ok) {
      const serverMessage = String(me?.message || "").trim();
      controller.abort();
      return { ...failure(locale, meRes.status >= 500 ? "service" : "response", serverMessage), status: Number(meRes.status || 0) };
    }
    if (expectedIdentity && !authenticatedUserMatches(
      me,
      expectedIdentity.email,
      expectedIdentity.accountLifecycleId,
    )) {
      controller.abort();
      return {
        ...failure(locale, "identity"),
        status: 409,
        identityMismatch: true,
        state: copyEmptyAccountState(),
      };
    }

    let financeTimer;
    const financeBoundary = new Promise((resolve) => {
      financeTimer = setTimeout(() => {
        const error = new Error("finance_load_timeout");
        error.name = "TimeoutError";
        controller.abort();
        resolve({ error });
      }, Math.max(5, Math.floor(deadlineMs / 2)));
    });
    const balanceOutcome = await Promise.race([balancePromise, financeBoundary]);
    clearTimeout(financeTimer);
    let bal = null;
    let financeReady = false;
    let financeError = "";
    if (balanceOutcome.response?.ok) {
      bal = balanceOutcome.data || null;
      const balanceNumber = bal?.balance;
      financeReady = Boolean(
        bal?.ok === true
        && authenticatedUserMatches(bal, me.email, me.accountLifecycleId)
        && typeof balanceNumber === "number"
        && Number.isFinite(balanceNumber)
        && Array.isArray(bal?.transactions)
        && Array.isArray(bal?.withdrawals)
        && Array.isArray(bal?.coupons)
      );
      if (!financeReady) financeError = financeLoadError(locale, "response");
    } else if (balanceOutcome.response) {
      financeError = financeLoadError(locale, balanceOutcome.response.status >= 500 ? "service" : "response");
    } else {
      financeError = financeLoadError(locale, balanceOutcome.error?.name === "TimeoutError" ? "timeout" : "network");
    }
    return {
      ok: true,
      loading: false,
      cancelled: false,
      retry: false,
      error: "",
      state: {
        loading: false,
        email: me.email,
        accountLifecycleId: me.accountLifecycleId || "",
        username: me.username || "",
        avatarId: normalizeUserAvatarId(me.avatarId),
        orders: Array.isArray(me.orders) ? me.orders : [],
        balance: financeReady ? bal.balance : Number(me.balance || 0),
        financeReady,
        financeError,
        txs: financeReady ? bal.transactions : [],
        coupons: financeReady ? bal.coupons : (Array.isArray(me.coupons) ? me.coupons : []),
        withdrawals: financeReady ? bal.withdrawals : [],
        referral: me.referral || bal?.referral || null,
        referralDownlines: Array.isArray(me.referralDownlines) ? me.referralDownlines : [],
      },
    };
  };

  try {
    return await Promise.race([operation(), boundary]);
  } catch (error) {
    controller.abort();
    if (cancelled && !timedOut) return { ok: false, loading: false, cancelled: true, retry: false, error: "", state: null };
    return failure(locale, timedOut || error?.name === "TimeoutError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener?.("abort", relayAbort);
  }
}
