import { DEFAULT_USER_AVATAR_ID, normalizeUserAvatarId } from "../lib/avatars.js";

export const EMPTY_ACCOUNT_STATE = Object.freeze({
  loading: false,
  email: null,
  accountLifecycleId: "",
  username: "",
  avatarId: DEFAULT_USER_AVATAR_ID,
  orders: [],
  balance: 0,
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
  return en
    ? "We couldn't load your account. Check your connection and retry."
    : "账户信息加载失败，请检查网络后重试。";
}

function failure(locale, kind, message = "") {
  return { ok: false, loading: false, cancelled: false, retry: true, error: message || loadError(locale, kind), state: null };
}

/** Pure request decision used by the Account page and executable tests. */
export async function requestAccountLoad({
  fetchImpl = globalThis.fetch,
  locale = "zh",
  timeoutMs = 15_000,
  signal: upstreamSignal,
} = {}) {
  const controller = new AbortController();
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
  }, Math.max(10, Number(timeoutMs) || 15_000));

  const operation = async () => {
    const balancePromise = Promise.resolve()
      .then(() => fetchImpl("/api/auth/balance", { credentials: "same-origin", cache: "no-store", signal: controller.signal }))
      .then((response) => ({ response }), (error) => ({ error }));
    const meRes = await fetchImpl("/api/auth/me", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (meRes.status === 401) {
      controller.abort();
      return { ok: false, loading: false, cancelled: false, retry: false, error: "", state: copyEmptyAccountState() };
    }

    let me = null;
    try { me = await meRes.json(); } catch {}
    if (!meRes.ok || !me?.ok) {
      const serverMessage = String(me?.message || "").trim();
      controller.abort();
      return failure(locale, meRes.status >= 500 ? "service" : "response", serverMessage);
    }

    const balanceOutcome = await balancePromise;
    let bal = null;
    if (balanceOutcome.response?.ok) {
      try { bal = await balanceOutcome.response.json(); } catch {}
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
        balance: Number(bal?.balance ?? me.balance ?? 0),
        txs: Array.isArray(bal?.transactions) ? bal.transactions : [],
        coupons: bal?.coupons || me.coupons || [],
        withdrawals: Array.isArray(bal?.withdrawals) ? bal.withdrawals : [],
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
