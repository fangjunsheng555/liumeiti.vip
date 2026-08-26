"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Gift,
  LoaderCircle,
  Lock,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  PRODUCTS,
  getCatalogProducts,
  useCatalogSyncState,
  useSiteSettingsState,
  useCart,
  copyText,
  bundleDiscountRate,
  bundleDiscountLabel,
  bundleTierLabel,
  usdtPaymentPresentation,
  localizeProduct,
  localizePlan,
  cartSubtotalCny,
  cartFinalCny,
  cartFinalUsdt,
  validUsername,
  validEmail,
  productNeedsAccountPassword,
  blankCheckoutForm,
  DEFAULT_ROCKET_PLAN,
  getRocketPlan,
  getProductPlan,
  getDefaultProductPlan,
  hasProductPlans,
  isProductPlan,
  productItemAmount,
} from "../lib/store";
import FloatingSupport from "../components/FloatingSupport";
import ProxyPaymentCheckout from "../components/ProxyPaymentCheckout";
import { useLocale } from "../components/LocaleProvider";
import {
  createPendingIdempotencyRecord,
  isExplicitTerminalIdempotencyResponse,
} from "../lib/idempotency";
import {
  CHECKOUT_PENDING_LEGACY_KEY,
  clearCheckoutPendingJournal,
  isCheckoutJournalStorageKey,
  readCheckoutPendingJournals,
  withCheckoutSubmissionCoordination,
  writeCheckoutPendingJournal,
} from "../lib/checkout-pending-journal";
import { clientFetch as fetch, isClientRequestTimeout } from "../lib/client-fetch";
import {
  authenticatedUserMatches,
  isSuccessfulAuthResponse,
  safeLoginAfterConfirmedAuth,
  safeLoginAfterUncertainAuth,
  shouldReauthenticateAfterAuthVerification,
  shouldRecoverAuthMutationResponse,
} from "../lib/auth-recovery";

const CHECKOUT_DRAFT_KEY = "liumeiti:checkout-draft:v2";
const CHECKOUT_DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_OAUTH_START = "/api/auth/oauth/google/start";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="oauth-provider-icon">
      <path fill="#4285F4" d="M21.6 12.23c0-.74-.07-1.45-.19-2.13H12v4.03h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.43Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.34l-3.24-2.51c-.9.6-2.05.95-3.38.95-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A9.99 9.99 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.98A6.01 6.01 0 0 1 6.08 12c0-.69.12-1.35.32-1.98V7.43H3.06A9.99 9.99 0 0 0 2 12c0 1.61.39 3.13 1.06 4.57l3.34-2.59Z" />
      <path fill="#EA4335" d="M12 5.9c1.47 0 2.79.51 3.83 1.5l2.87-2.87C16.96 2.91 14.7 2 12 2a9.99 9.99 0 0 0-8.94 5.43l3.34 2.59C7.19 7.66 9.4 5.9 12 5.9Z" />
    </svg>
  );
}

function AlipayIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="payment-brand-svg">
      <rect x="4" y="4" width="40" height="40" rx="12" fill="#1677ff" />
      <text x="24" y="31" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="22" fontWeight="900" fill="#fff">支</text>
    </svg>
  );
}

function UsdtIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="payment-brand-svg">
      <rect x="4" y="4" width="40" height="40" rx="12" fill="#26a17b" />
      <path fill="#fff" d="M13 13.5h22v5.1h-8.1v4.08c5.15.25 9.1 1.28 9.1 2.52 0 1.25-3.95 2.28-9.1 2.53v7.77h-5.8v-7.77c-5.15-.25-9.1-1.28-9.1-2.53 0-1.24 3.95-2.27 9.1-2.52V18.6H13v-5.1Zm11 11.2c-3.85 0-6.98.35-6.98.78 0 .36 2.18.66 5.1.75v-2.52h3.76v2.52c2.92-.09 5.1-.39 5.1-.75 0-.43-3.13-.78-6.98-.78Z" />
    </svg>
  );
}

function BalanceIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="payment-brand-svg">
      <rect x="4" y="4" width="40" height="40" rx="12" fill="#0f766e" />
      <path fill="#fff" d="M13 17.2c0-2.42 1.98-4.4 4.4-4.4h13.2c2.42 0 4.4 1.98 4.4 4.4v1.32H13V17.2Zm0 5.12h22v8.48c0 2.42-1.98 4.4-4.4 4.4H17.4c-2.42 0-4.4-1.98-4.4-4.4v-8.48Zm15.9 3.02a3.2 3.2 0 0 0 0 6.4h3.42v-6.4H28.9Z" />
      <circle cx="29.1" cy="28.54" r="1.22" fill="#0f766e" />
    </svg>
  );
}

function WechatIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="payment-brand-svg">
      <rect x="4" y="4" width="40" height="40" rx="12" fill="#1aad19" />
      <path fill="#fff" d="M21.4 15.2c-5.25 0-9.4 3.38-9.4 7.55 0 2.38 1.36 4.46 3.54 5.84l-.84 2.82 3.2-1.62c1.08.34 2.26.52 3.5.52 5.25 0 9.4-3.38 9.4-7.56s-4.15-7.55-9.4-7.55Z" />
      <path fill="#fff" opacity=".78" d="M28.7 23.8c-4.45 0-8.02 2.88-8.02 6.42s3.57 6.42 8.02 6.42c.98 0 1.92-.14 2.8-.4l2.68 1.32-.7-2.2c1.96-1.18 3.24-3.05 3.24-5.14 0-3.54-3.58-6.42-8.02-6.42Z" />
      <circle cx="18.25" cy="21.22" r="1.22" fill="#1aad19" />
      <circle cx="24.6" cy="21.22" r="1.22" fill="#1aad19" />
      <circle cx="26.3" cy="29.25" r="1" fill="#1aad19" />
      <circle cx="31.18" cy="29.25" r="1" fill="#1aad19" />
    </svg>
  );
}

function CardPayIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="payment-brand-svg">
      <rect x="4" y="4" width="40" height="40" rx="12" fill="#475569" />
      <rect x="11" y="15" width="26" height="18" rx="4.5" fill="#fff" opacity=".96" />
      <rect x="11" y="19" width="26" height="4" fill="#94a3b8" />
      <rect x="15" y="27" width="10" height="2.8" rx="1.4" fill="#64748b" />
      <circle cx="31" cy="28.5" r="2.6" fill="#f59e0b" />
      <circle cx="34" cy="28.5" r="2.6" fill="#ef4444" opacity=".78" />
    </svg>
  );
}

function planParamFor(params, productKey) {
  if (!hasProductPlans(productKey)) return "";
  const raw = String(params.get(`${productKey}Plan`) || (productKey === "rocket" ? params.get("rocketPlan") : "") || "");
  if (!raw) return "";
  return isProductPlan(productKey, raw) ? getProductPlan(productKey, raw)?.id || "" : "";
}

function planMapFromServices(services) {
  const next = {};
  (Array.isArray(services) ? services : []).forEach((service) => {
    const key = service?.key;
    if (!hasProductPlans(key)) return;
    const plan = getProductPlan(key, service?.plan);
    if (plan) next[key] = plan.id;
  });
  return next;
}

function storedInviteCode() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("lm_invite") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  } catch (e) {
    return "";
  }
}

function googleOAuthStartUrl(inviteCode) {
  const code = String(inviteCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  return code ? `${GOOGLE_OAUTH_START}?invite=${encodeURIComponent(code)}` : GOOGLE_OAUTH_START;
}

function handleGoogleOAuthStart(event) {
  const href = googleOAuthStartUrl(storedInviteCode());
  if (href === GOOGLE_OAUTH_START) return;
  event.preventDefault();
  window.location.href = href;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const catalogState = useCatalogSyncState(); // 只有权威目录读取成功后才允许新订单进入付款
  const settingsState = useSiteSettingsState(); // 收款地址/二维码读取失败时禁止付款并提供重试
  const catalogVersion = catalogState.version;
  const siteSettings = settingsState.settings;
  const checkoutConfigReady = catalogState.ready && settingsState.ready;
  const checkoutConfigLoading = !checkoutConfigReady && !catalogState.error && !settingsState.error;
  const checkoutConfigError = catalogState.error || settingsState.error;
  const usdtPresentation = usdtPaymentPresentation(locale);
  const products = getCatalogProducts(); // 合并后的上架商品(价格/规格/上下架与结账实收价一致)
  const { cart, cartPlans, hydrated, removeFromCart, replaceCart, clearCart, setCartPlan } = useCart();
  const [step, setStep] = useState("form");
  const [form, setForm] = useState(blankCheckoutForm);
  const [paymentMethod, setPaymentMethod] = useState("alipay");
  const [paymentAdjustment, setPaymentAdjustment] = useState(0);
  const [usdtNonce, setUsdtNonce] = useState(0);
  const [usdtPrecision, setUsdtPrecision] = useState(4);
  const [paymentQuoteToken, setPaymentQuoteToken] = useState("");
  const [paymentPageEnteredAt, setPaymentPageEnteredAt] = useState(0);
  const [paySubmitNotice, setPaySubmitNotice] = useState("");
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [orderResults, setOrderResults] = useState([]);
  const [authedUser, setAuthedUser] = useState(null); // {email, balance} | null
  const [accountReady, setAccountReady] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register" | "forgot" | "reset"
  const [authSessionPending, setAuthSessionPending] = useState(false);
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ token: "", image: "", loading: false, error: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [redeemMode, setRedeemMode] = useState({ loading: true, code: "", info: null });
  const [urlPlans, setUrlPlans] = useState({});
  const [draftReady, setDraftReady] = useState(false);
  const [usdtRateState, setUsdtRateState] = useState({ rate: 0, ready: false, loading: false, error: "" });
  const [usdtRateAttempt, setUsdtRateAttempt] = useState(0);
  const [proxySubmitted, setProxySubmitted] = useState(false);
  const [pendingJournalVersion, setPendingJournalVersion] = useState(0);
  const orderRequestRef = useRef(null);
  const pendingOrderRef = useRef(null);
  const pendingReplayStartedRef = useRef(false);
  const accountLoadRequestRef = useRef(0);
  const authSessionIdentityRef = useRef(null);

  async function refreshAccountState(isCancelled = () => false, expectedIdentity = null) {
    const requestId = ++accountLoadRequestRef.current;
    setAccountReady(false);
    setAccountError("");
    try {
      const meRes = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (isCancelled() || requestId !== accountLoadRequestRef.current) return { ok: false, boughtTrial: false };
      if (meRes.status === 401) {
        setAuthedUser(null);
        setAccountReady(true);
        return { ok: false, guest: true, status: 401, boughtTrial: false };
      }
      let meData = null;
      try { meData = await meRes.json(); } catch {
        throw new SyntaxError("invalid_account_response");
      }
      if (!meRes.ok || !meData?.ok || !/^[a-f0-9]{32}$/.test(String(meData.accountLifecycleId || ""))) {
        const error = new Error("account_state_unavailable");
        error.status = meRes.status;
        throw error;
      }
      if (expectedIdentity && !authenticatedUserMatches(
        meData,
        expectedIdentity.email,
        expectedIdentity.accountLifecycleId,
      )) {
        const error = new Error("auth_identity_changed");
        error.status = 409;
        error.identityMismatch = true;
        throw error;
      }
      if (isCancelled() || requestId !== accountLoadRequestRef.current) return { ok: false, boughtTrial: false };
      const accountData = meData;
      if (accountData) {
        const orders = Array.isArray(meData?.orders) ? meData.orders : [];
        const boughtTrial = orders.some((order) =>
          order?.status !== "invalid" &&
          Array.isArray(order?.items) &&
          order.items.some((item) =>
            item.service === "rocket" &&
            (item.plan === "trial" || item.rocketPlan === "trial" || item.label?.includes("5元10GB测试") || Number(item.amount || 0) === 5)
          )
        );
        setAuthedUser({
          email: accountData.email,
          accountLifecycleId: accountData.accountLifecycleId,
          balance: Number(accountData.balance || 0),
          coupons: accountData.coupons || [],
          orders,
        });
        setForm((cur) => cur.email ? cur : { ...cur, email: accountData.email });
        setAccountReady(true);
        return { ok: true, boughtTrial, email: accountData.email, accountLifecycleId: accountData.accountLifecycleId };
      }
    } catch (e) {
      if (isCancelled() || requestId !== accountLoadRequestRef.current) return { ok: false, boughtTrial: false };
      const message = e?.identityMismatch
        ? L("当前登录账户与刚才完成操作的账户不一致，请重新登录原账户", "The current session doesn't match the account operation. Sign in to the original account again.")
        : isClientRequestTimeout(e)
        ? L("登录状态确认超时，请重试后再付款", "Session verification timed out. Retry before paying.")
        : [500, 503].includes(e?.status)
          ? L("账户服务暂时不可用，请稍后重试", "The account service is temporarily unavailable. Please retry.")
          : e?.status === 403
            ? L("暂时无法确认登录权限，请刷新登录状态后重试", "Your session permissions couldn't be verified. Refresh and retry.")
            : e?.status === 409
              ? L("登录状态已更新，请重试", "Your session changed. Please retry.")
              : e?.name === "SyntaxError"
                ? L("账户接口响应异常，请重试", "The account service returned an invalid response. Please retry.")
                : L("登录状态确认失败，请检查网络后重试", "Session verification failed. Check your connection and retry.");
      setAccountError(message);
      return {
        ok: false,
        error: message,
        status: Number(e?.status || 0),
        identityMismatch: e?.identityMismatch === true,
        boughtTrial: false,
      };
    }
  }

  // Pre-fill email + load balance for logged-in user
  useEffect(() => {
    let cancelled = false;
    refreshAccountState(() => cancelled);
    return () => { cancelled = true; accountLoadRequestRef.current += 1; };
  }, []);

  // 固定正数覆盖可直接使用；否则必须成功读取服务端汇率，绝不回退到编译时常量。
  useEffect(() => {
    let cancelled = false;
    if (!settingsState.ready) {
      setUsdtRateState({ rate: 0, ready: false, loading: false, error: "" });
      return () => { cancelled = true; };
    }
    const override = Number(siteSettings.usdt.rateOverride);
    if (Number.isFinite(override) && override > 0) {
      setUsdtRateState({ rate: override, ready: true, loading: false, error: "" });
      return () => { cancelled = true; };
    }
    setUsdtRateState({ rate: 0, ready: false, loading: true, error: "" });
    (async () => {
      try {
        const response = await fetch("/api/usdt-rate", { cache: "no-store" });
        let data = null;
        try {
          data = await response.json();
        } catch (error) {
          if (isClientRequestTimeout(error)) throw error;
          const invalid = new Error("usdt_rate_invalid_response");
          invalid.code = "usdt_rate_invalid_response";
          throw invalid;
        }
        const rate = Number(data?.rate);
        if (!response.ok || !data?.ok || !Number.isFinite(rate) || rate <= 0) {
          const invalid = new Error(response.ok ? "usdt_rate_invalid_response" : `usdt_rate_http_${response.status}`);
          invalid.code = response.ok ? "usdt_rate_invalid_response" : `usdt_rate_http_${response.status}`;
          throw invalid;
        }
        if (!cancelled) setUsdtRateState({ rate, ready: true, loading: false, error: "" });
      } catch (error) {
        if (cancelled) return;
        const code = isClientRequestTimeout(error)
          ? "usdt_rate_timeout"
          : String(error?.code || "usdt_rate_network_error");
        setUsdtRateState({ rate: 0, ready: false, loading: false, error: code });
      }
    })();
    return () => { cancelled = true; };
  }, [settingsState.ready, siteSettings.usdt.rateOverride, usdtRateAttempt]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (authModal) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    if (!authModal) return () => { document.body.style.overflow = ""; };
    const onKey = (e) => { if (e.key === "Escape" && !authBusy && !authSessionPending) setAuthModal(null); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
  }, [authModal, authBusy, authSessionPending]);

  async function refreshAuthCaptcha(clearAnswer = true) {
    setAuthCaptcha((cur) => ({ ...cur, loading: true, error: "" }));
    if (clearAnswer) setAuthForm((f) => ({ ...f, captchaAnswer: "" }));
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token || !data.image) throw new Error(data.message || L("验证码加载失败", "Failed to load captcha"));
      setAuthCaptcha({ token: data.token, image: data.image, loading: false, error: "" });
    } catch {
      setAuthCaptcha({ token: "", image: "", loading: false, error: L("验证码加载失败，请点击刷新", "Couldn't load captcha. Tap to refresh.") });
    }
  }

  useEffect(() => {
    if (authModal === "register") refreshAuthCaptcha(true);
    else setAuthCaptcha({ token: "", image: "", loading: false, error: "" });
    if (authModal === null) {
      setAuthForm({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
      setAuthError("");
      setAuthNotice("");
    }
  }, [authModal]);

  // 弃单埋点：进结算页（购物车就绪）发一次 checkout_started；首次拿到有效邮箱再发一次（带联系方式以便后台召回）。
  // 下单成功后由 /api/order 清除该访客的弃单记录。静默、不影响下单。
  const checkoutTrackedRef = useRef({ base: false, email: "" });
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated || !cart || cart.length === 0) return;
    const email = (form.email || authedUser?.email || "").trim();
    const emailValid = /.+@.+\..+/.test(email);
    const ref = checkoutTrackedRef.current;
    if (ref.base && (!emailValid || ref.email === email)) return; // 已发过且无新邮箱
    ref.base = true;
    if (emailValid) ref.email = email;
    let amount = 0;
    try { amount = cartFinalCny(cart, cartPlans) || 0; } catch (e) {}
    const locale = (document.cookie.match(/(?:^|; )locale=([^;]+)/) || [])[1] === "en" ? "en" : "zh";
    try {
      fetch("/api/track", {
        method: "POST", credentials: "include", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "event", name: "checkout_started", meta: { services: cart.join(","), amount, email: emailValid ? email : "", locale } }),
      }).catch(() => {});
    } catch (e) {}
  }, [hydrated, cart, cartPlans, form.email, authedUser]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("redeem") || "").trim().toUpperCase();
    if (!code) {
      setRedeemMode({ loading: false, code: "", info: null });
      return;
    }
    setRedeemMode({ loading: true, code, info: null });
    fetch(`/api/redeem-code?code=${encodeURIComponent(code)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok || data.status !== "active" || data.type !== "service") {
          setStatus({ type: "error", message: data.message || L("服务兑换码无效、已使用或已作废", "Service code is invalid, used, or voided") });
          setRedeemMode({ loading: false, code, info: null });
          return;
        }
        const keys = (data.services || []).map((item) => item.key).filter(Boolean);
        replaceCart(keys);
        setPaymentMethod("redeem");
        const redeemPlans = planMapFromServices(data.services || []);
        Object.entries(redeemPlans).forEach(([key, planId]) => setCartPlan(key, planId));
        if (Object.keys(redeemPlans).length > 0) {
          setForm((current) => {
            const nextFields = { ...(current.fields || {}) };
            Object.entries(redeemPlans).forEach(([key, planId]) => {
              nextFields[key] = { ...(nextFields[key] || {}), plan: planId };
            });
            return { ...current, fields: nextFields };
          });
        }
        setRedeemMode({ loading: false, code, info: data });
      })
      .catch(() => {
        setStatus({ type: "error", message: L("兑换码识别失败,请稍后再试", "Couldn't read the code, please try again") });
        setRedeemMode({ loading: false, code, info: null });
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("redeem")) return;
    const rawItems = String(params.get("items") || "");
    if (!rawItems) return;
    const valid = new Set(products.map((item) => item.key));
    const seen = new Set();
    const keys = rawItems
      .split(",")
      .map((item) => item.trim())
      .filter((key) => valid.has(key) && !seen.has(key) && seen.add(key));
    if (keys.length > 0) replaceCart(keys);
    const explicitPlans = {};
    keys.forEach((key) => {
      const planId = planParamFor(params, key);
      if (planId) explicitPlans[key] = planId;
    });
    setUrlPlans(explicitPlans);
    Object.entries(explicitPlans).forEach(([key, planId]) => setCartPlan(key, planId));
    if (Object.keys(explicitPlans).length > 0) {
      setForm((current) => {
        const nextFields = { ...(current.fields || {}) };
        Object.entries(explicitPlans).forEach(([key, planId]) => {
          nextFields[key] = { ...(nextFields[key] || {}), plan: planId };
        });
        return { ...current, fields: nextFields };
      });
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated || draftReady) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const hasRedeem = Boolean(params.get("redeem"));
      const hasItems = Boolean(params.get("items"));
      const rawItems = String(params.get("items") || "");
      const urlKeys = rawItems.split(",").map((item) => item.trim()).filter(Boolean);
      const explicitPlans = {};
      urlKeys.forEach((key) => {
        const planId = planParamFor(params, key);
        if (planId) explicitPlans[key] = planId;
      });
      const pendingSnapshot = readCheckoutPendingJournals(window.localStorage);
      const rawDraft = window.localStorage.getItem(CHECKOUT_DRAFT_KEY);
      let saved = null;
      let isPending = false;
      if (!pendingSnapshot.ok || pendingSnapshot.records.length > 1) {
        // Any corrupt record, or more than one distinct unresolved operation,
        // is ambiguous. Preserve every journal and prevent another order.
        pendingOrderRef.current = {
          invalid: true,
          error: !pendingSnapshot.ok ? "checkout_journal_ambiguous" : "checkout_multiple_pending_orders",
        };
        setStatus({
          type: "error",
          message: L(
            "检测到一个或多个无法安全自动恢复的待处理订单。请勿重复付款，并联系客服逐笔核对。",
            "One or more unfinished orders cannot be safely auto-restored. Do not pay again; contact support to verify each one.",
          ),
        });
      } else if (pendingSnapshot.records.length === 1) {
        const entry = pendingSnapshot.records[0];
        saved = entry.record;
        try {
          // Copy legacy v1 into the per-operation namespace. The legacy copy
          // remains until this exact operation reaches a terminal response.
          if (entry.storageKey === CHECKOUT_PENDING_LEGACY_KEY) {
            writeCheckoutPendingJournal(window.localStorage, saved);
          }
        } catch {
          pendingOrderRef.current = { invalid: true, error: "checkout_journal_migration_failed" };
          saved = null;
          setStatus({
            type: "error",
            message: L(
              "待处理订单无法安全迁移。请勿重复付款，并联系客服核对。",
              "The unfinished order could not be safely migrated. Do not pay again; contact support.",
            ),
          });
        }
        if (saved) {
          isPending = true;
          pendingOrderRef.current = saved;
          orderRequestRef.current = saved.idempotencyRequest;
        }
      } else if (rawDraft) {
        try {
          const draft = JSON.parse(rawDraft);
          if (draft && Date.now() - Number(draft.createdAt || 0) < CHECKOUT_DRAFT_MAX_AGE) saved = draft;
          else window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
        } catch (ignore) {
          window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
        }
      }
      if (saved) {
        if (saved.form && typeof saved.form === "object") {
          const savedFields = { ...((saved.form && saved.form.fields) || {}) };
          if (!isPending) {
            urlKeys.forEach((key) => {
              if (!hasProductPlans(key)) return;
              const nextField = { ...(savedFields[key] || {}) };
              if (explicitPlans[key]) nextField.plan = explicitPlans[key];
              else delete nextField.plan;
              savedFields[key] = nextField;
            });
          }
          setForm((current) => ({
            ...current,
            ...saved.form,
            fields: { ...(current.fields || {}), ...savedFields },
          }));
        }
        // 仅恢复 alipay/usdt；'balance' 不从草稿恢复——未登录会落到无 QR 的余额付款页且 balance 为 undefined。
        // 登录后由下方余额可用逻辑自动选中余额。
        const savedPaymentMethod = saved.payload?.paymentMethod || saved.paymentMethod;
        if (["alipay", "usdt", "balance", "redeem"].includes(savedPaymentMethod)) {
          setPaymentMethod(savedPaymentMethod);
        }
        if (isPending) {
          setPaymentQuoteToken(String(saved.payload?.paymentQuoteToken || ""));
          setPaymentAdjustment(Number(saved.paymentQuote?.paymentAdjustment || 0));
          setUsdtNonce(Number(saved.paymentQuote?.usdtNonce || 0));
          setUsdtPrecision(Number(saved.paymentQuote?.usdtPrecision) === 6 ? 6 : 4);
        }
        if ((isPending || (!hasRedeem && !hasItems && cart.length === 0)) && Array.isArray(saved.cart)) {
          const valid = new Set(products.map((item) => item.key));
          const keys = saved.cart.filter((key) => valid.has(key));
          if (keys.length > 0) replaceCart(keys);
        }
      }
    } catch (e) {
      // Never erase a pending journal on a client exception: its server-side
      // outcome is unknown until the exact request receives a terminal reply.
      pendingOrderRef.current = {
        ...(pendingOrderRef.current && typeof pendingOrderRef.current === "object"
          ? pendingOrderRef.current
          : {}),
        invalid: true,
        error: "checkout_journal_restore_failed",
      };
      orderRequestRef.current = null;
      setStatus({
        type: "error",
        message: L("待处理订单恢复失败，请勿重复支付并联系在线客服。", "Order recovery failed. Do not pay again; contact support."),
      });
    } finally {
      setDraftReady(true);
    }
  }, [hydrated, draftReady]);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated || !draftReady || step === "done") return;
    try {
      window.localStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({
        createdAt: Date.now(),
        form,
        paymentMethod,
        cart,
      }));
    } catch (e) {}
  }, [hydrated, draftReady, form, paymentMethod, cart, step]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const syncPendingJournal = (event) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (!isCheckoutJournalStorageKey(event.key)) return;
      const snapshot = readCheckoutPendingJournals(window.localStorage);
      if (!snapshot.ok || snapshot.records.length > 1) {
        pendingOrderRef.current = {
          invalid: true,
          error: !snapshot.ok ? "checkout_journal_ambiguous" : "checkout_multiple_pending_orders",
        };
        orderRequestRef.current = null;
        pendingReplayStartedRef.current = false;
        setStatus({
          type: "error",
          message: L(
            "其他标签页产生了无法安全自动恢复的待处理订单。请勿重复付款，并联系客服逐笔核对。",
            "Another tab created unfinished order state that cannot be safely auto-restored. Do not pay again; contact support.",
          ),
        });
        setPendingJournalVersion((version) => version + 1);
        return;
      }
      if (snapshot.records.length !== 1) {
        // A different tab may have received a terminal response. Do not erase
        // an in-memory in-flight request based only on a removal event.
        return;
      }

      const incoming = snapshot.records[0].record;
      const incomingKey = incoming.idempotencyRequest.key;
      const currentKey = pendingOrderRef.current?.idempotencyRequest?.key;
      if (currentKey && currentKey !== incomingKey) {
        pendingOrderRef.current = { invalid: true, error: "checkout_concurrent_pending_orders" };
        orderRequestRef.current = null;
        pendingReplayStartedRef.current = false;
        setStatus({
          type: "error",
          message: L(
            "检测到并发的待处理订单。请勿重复付款，并联系客服核对。",
            "Concurrent unfinished orders were detected. Do not pay again; contact support.",
          ),
        });
      } else {
        pendingOrderRef.current = incoming;
        orderRequestRef.current = incoming.idempotencyRequest;
        pendingReplayStartedRef.current = false;
      }
      setPendingJournalVersion((version) => version + 1);
    };
    window.addEventListener("storage", syncPendingJournal);
    return () => window.removeEventListener("storage", syncPendingJournal);
  }, []);

  useEffect(() => {
    if (!draftReady || !accountReady || pendingReplayStartedRef.current) return;
    const pending = pendingOrderRef.current;
    if (!pending || pending.invalid) return;
    const originalAccount = String(pending.identity?.accountEmail || "").trim().toLowerCase();
    const originalLifecycle = String(pending.identity?.accountLifecycleId || "").trim().toLowerCase();
    const currentAccount = String(authedUser?.email || "").trim().toLowerCase();
    const currentLifecycle = String(authedUser?.accountLifecycleId || "").trim().toLowerCase();
    if (originalAccount !== currentAccount) {
      setStatus({
        type: "error",
        action: originalAccount ? "reauthenticate" : "logout-guest",
        message: originalAccount
          ? L(
              `请先登录 ${originalAccount} 以安全恢复待处理订单，请勿重复支付。`,
              `Sign in as ${originalAccount} to safely recover the unfinished order. Do not pay again.`,
            )
          : L(
              "该待处理订单由访客提交，请先退出当前账户再恢复，请勿重复支付。",
              "This unfinished order was submitted as a guest. Sign out before recovering it; do not pay again.",
            ),
      });
      if (originalAccount) openPendingReauthentication(pending);
      return;
    }
    if (originalLifecycle !== currentLifecycle) {
      pendingReplayStartedRef.current = false;
      setStatus({
        type: "error",
        message: L(
          "该邮箱对应的原账户生命周期已结束，待处理订单不能关联到重新注册的新账户。请勿重复支付，并联系客服核对原订单。",
          "The original account lifecycle for this email has ended. This pending order cannot be attached to a re-registered account. Do not pay again; contact support to verify it.",
        ),
      });
      return;
    }
    pendingReplayStartedRef.current = true;
    void replayPendingOrder(pending);
  }, [draftReady, accountReady, authedUser?.email, authedUser?.accountLifecycleId, pendingJournalVersion]);

  const cartItems = cart.map((key) => products.find((p) => p.key === key)).filter(Boolean);
  const cartCount = cartItems.length;
  const proxyQuoteCart = cartCount === 1 && cartItems[0]?.key === "proxy-pay";
  const cartHasRocket = cartItems.some((p) => p.key === "rocket");
  const serviceRedeemActive = Boolean(redeemMode.info && redeemMode.info.type === "service");
  const serviceRedeemPlans = serviceRedeemActive ? planMapFromServices(redeemMode.info?.services || []) : {};
  const planMap = Object.fromEntries(
    cartItems
      .filter((item) => hasProductPlans(item.key))
      .map((item) => {
        const plan = getProductPlan(
          item.key,
          serviceRedeemPlans[item.key] ||
            urlPlans[item.key] ||
            form.fields?.[item.key]?.plan ||
            cartPlans?.[item.key] ||
            getDefaultProductPlan(item.key),
        );
        return [item.key, plan?.id || getDefaultProductPlan(item.key)];
      }),
  );
  const subtotal = cartSubtotalCny(cartItems, planMap);
  const discountRate = bundleDiscountRate(cartCount);
  const bundleFinalCny = cartFinalCny(cartItems, planMap);
  const rocketPlanId = planMap.rocket || DEFAULT_ROCKET_PLAN;
  const rocketPlanInfo = getRocketPlan(rocketPlanId);
  const rocketTrialSelected = cartHasRocket && rocketPlanId === "trial";
  const couponEligibleCny = rocketTrialSelected
    ? Math.max(0, Math.round((bundleFinalCny - Number(rocketPlanInfo.amount || 0)) * 100) / 100)
    : bundleFinalCny;
  const activeCoupon = (authedUser?.coupons || []).find((c) => c.status === "active");
  const couponDiscount = !serviceRedeemActive && activeCoupon ? Math.min(Number(activeCoupon.amount || 0), couponEligibleCny) : 0;
  const finalCny = Math.max(0, Math.round((bundleFinalCny - couponDiscount) * 100) / 100);
  const alipayPayableCny = Math.max(0.01, Math.round((finalCny + paymentAdjustment) * 100) / 100);
  // USDT 折扣/汇率以站点设置为准(与服务端实收一致)
  const usdtDiscount = Number(siteSettings.usdt.discount) || 0.9;
  const usdtRateReady = usdtRateState.ready && Number.isFinite(usdtRateState.rate) && usdtRateState.rate > 0;
  const effectiveUsdtRate = usdtRateReady ? usdtRateState.rate : 0;
  const finalUsdt = usdtRateReady ? Math.round((finalCny * usdtDiscount / effectiveUsdtRate) * 100) / 100 : 0;
  const usdtScale = 10 ** usdtPrecision;
  const usdtPayable = (Math.round((finalUsdt + Number(usdtNonce || 0)) * usdtScale) / usdtScale).toFixed(usdtPrecision);
  const requiresUsdtRate = !serviceRedeemActive && paymentMethod === "usdt" && finalCny > 0;
  const checkoutPaymentReady = checkoutConfigReady && (!requiresUsdtRate || usdtRateReady);
  const savings = subtotal - bundleFinalCny;

  // 余额付款变得不足时（加购/优惠变化抬高总价）自动切回支付宝，避免停留在会被服务端拒绝的余额选项。
  useEffect(() => {
    if (paymentMethod === "balance" && (!authedUser || Number(authedUser.balance || 0) < finalCny)) {
      setPaymentMethod("alipay");
    }
  }, [paymentMethod, finalCny, authedUser]);

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    if (status?.type === "error") setStatus(null);
  }

  function updateProductField(productKey, field, value) {
    setForm((current) => ({
      ...current,
      fields: {
        ...current.fields,
        [productKey]: { ...(current.fields[productKey] || {}), [field]: value },
      },
    }));
    if (status?.type === "error") setStatus(null);
  }

  function handleRocketPlanSelect(plan) {
    if (!plan) return;
    if (serviceRedeemActive && serviceRedeemPlans.rocket && serviceRedeemPlans.rocket !== plan.id) return;
    setCartPlan("rocket", plan.id);
    updateProductField("rocket", "plan", plan.id);
  }

  function enterSafeCheckoutLogin(expectedIdentity) {
    const recovery = expectedIdentity?.recovery || safeLoginAfterConfirmedAuth("login", {
      ...authForm,
      email: expectedIdentity?.email || authForm.email,
    });
    setAuthSessionPending(false);
    authSessionIdentityRef.current = null;
    setAuthModal(recovery.mode);
    setAuthForm(recovery.form);
    setAuthError("");
    setAuthNotice(L(
      "账户操作已经完成，但当前登录状态无法对应到该账户。请使用刚才的密码重新登录；原注册或重置操作不会再次提交。",
      "The account operation completed, but the current session doesn't match it. Sign in with the password you just used; the original sign-up or reset won't be submitted again.",
    ));
  }

  async function doCheckoutAuth(e) {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    const attemptedMode = authModal;
    const attemptedForm = { ...authForm, email: authForm.email.trim().toLowerCase() };
    if (!authSessionPending) authSessionIdentityRef.current = null;
    let responseConfirmed = false;
    try {
      if (authSessionPending) {
        responseConfirmed = true;
        const expectedIdentity = authSessionIdentityRef.current;
        const account = expectedIdentity
          ? await refreshAccountState(() => false, expectedIdentity)
          : { ok: false, status: 409, identityMismatch: true };
        if (!account?.ok || !expectedIdentity || !authenticatedUserMatches(account, expectedIdentity.email, expectedIdentity.accountLifecycleId)) {
          if (shouldReauthenticateAfterAuthVerification(account)) {
            enterSafeCheckoutLogin(expectedIdentity);
            return;
          }
          setAuthError(account?.error || L("账户操作已成功，但登录状态确认失败。这里只会重试确认，不会重复提交原操作。", "The account operation succeeded, but session verification failed. This retry only verifies the session; it won't repeat the original operation."));
          return;
        }
        setAuthSessionPending(false);
        authSessionIdentityRef.current = null;
        setAuthModal(null);
        const pending = pendingOrderRef.current;
        if (pending && !pending.invalid && pendingIdentityMatches(pending, account.email)) {
          pendingReplayStartedRef.current = true;
          await replayPendingOrder(pending, account.email);
        }
        return;
      }

      const endpoint = attemptedMode;
      let payload;
      if (attemptedMode === "login") {
        payload = {
          email: attemptedForm.email,
          password: attemptedForm.password,
        };
      } else if (attemptedMode === "register") {
        payload = {
          email: attemptedForm.email,
          password: attemptedForm.password,
          captchaToken: authCaptcha.token,
          captchaAnswer: attemptedForm.captchaAnswer.trim(),
          inviteCode: storedInviteCode(),
        };
      } else if (attemptedMode === "forgot") {
        payload = { email: attemptedForm.email };
      } else if (attemptedMode === "reset") {
        payload = {
          email: attemptedForm.email,
          code: attemptedForm.code.trim(),
          newPassword: attemptedForm.newPassword,
        };
      }

      const res = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch {
        throw new SyntaxError("invalid_auth_response");
      }

      if (!isSuccessfulAuthResponse(res, data, attemptedMode)) {
        if (shouldRecoverAuthMutationResponse(attemptedMode, res.status, data?.error)) {
          throw new Error("auth_mutation_result_uncertain");
        }
        const msg = {
          captcha_failed: L("验证码错误，请重新输入", "Wrong captcha, please try again"),
          email_taken: L("该邮箱已注册", "This email is already registered"),
          invalid_email: L("邮箱格式错误", "Invalid email format"),
          password_length: L("密码 6-64 位", "Password must be 6-64 characters"),
          invalid_credentials: L("邮箱或密码错误", "Wrong email or password"),
          invalid_code: L("验证码格式错误(6 位数字)", "Invalid code format (6 digits)"),
          code_invalid_or_expired: L("验证码错误或已过期", "Code is wrong or expired"),
          user_not_found: L("该邮箱未注册", "This email isn't registered"),
          account_banned: L("该账号已停用，请联系在线客服", "This account is disabled. Contact support."),
        }[data?.error] || L("操作失败，请重试", "Something went wrong. Please retry.");
        if (attemptedMode === "register" && data?.error === "captcha_failed") refreshAuthCaptcha(true);
        setAuthError(msg);
        return;
      }
      if (attemptedMode === "forgot") {
        responseConfirmed = true;
        setAuthNotice(L("如果该邮箱已注册，验证码会发送至邮箱。请检查收件箱（或垃圾邮件）", "If this email is registered, a code will be sent. Check your inbox or spam."));
        setAuthModal("reset");
        setAuthForm((f) => ({ ...f, email: attemptedForm.email, code: "", newPassword: "" }));
        return;
      }

      if (!authenticatedUserMatches(data, attemptedForm.email, data?.accountLifecycleId)) {
        throw new SyntaxError("invalid_auth_identity");
      }
      responseConfirmed = true;
      authSessionIdentityRef.current = {
        email: attemptedForm.email,
        accountLifecycleId: String(data.accountLifecycleId).trim().toLowerCase(),
        recovery: safeLoginAfterConfirmedAuth(attemptedMode, attemptedForm),
      };

      // The login/register/reset mutation has already succeeded. If the
      // following /auth/me verification is temporarily unavailable, the next
      // click must only retry that read and must never repeat the mutation.
      setAuthSessionPending(true);
      setAuthNotice(L("账户操作已成功，正在确认登录状态。若确认失败，可安全重试。", "The account operation succeeded. Verifying your session now; verification can be retried safely."));
      const account = await refreshAccountState(() => false, authSessionIdentityRef.current);
      if (!account?.ok || !authenticatedUserMatches(account, authSessionIdentityRef.current?.email, authSessionIdentityRef.current?.accountLifecycleId)) {
        if (shouldReauthenticateAfterAuthVerification(account)) {
          enterSafeCheckoutLogin(authSessionIdentityRef.current);
          return;
        }
        setAuthError(account?.error || L("登录成功，但账户状态确认失败，请重试", "Signed in, but account verification failed. Please retry."));
        return;
      }
      setAuthSessionPending(false);
      authSessionIdentityRef.current = null;
      setAuthModal(null);
      // Do not depend on the authedUser effect to resume an ambiguous order:
      // re-authenticating A as A may not change that dependency at all.
      const pending = pendingOrderRef.current;
      if (pending && !pending.invalid && pendingIdentityMatches(pending, account.email)) {
        pendingReplayStartedRef.current = true;
        await replayPendingOrder(pending, account.email);
      }
    } catch (error) {
      const recovery = !responseConfirmed ? safeLoginAfterUncertainAuth(attemptedMode, attemptedForm) : null;
      if (recovery) {
        setAuthSessionPending(false);
        authSessionIdentityRef.current = null;
        setAuthModal(recovery.mode);
        setAuthForm(recovery.form);
        setAuthNotice(L(
          "刚才的注册或重置结果尚未确认，已切换为安全登录验证，不会重复提交原操作。",
          "The sign-up or reset result is uncertain. We've switched to a safe sign-in check and won't repeat the original operation.",
        ));
        return;
      }
      setAuthError(L("网络错误", "Network error"));
    } finally {
      setAuthBusy(false);
    }
  }

  // Contact field is required only when cart includes products with needsContact (Spotify)
  const contactRequired = cartItems.some((p) => p.key === "spotify");
  const checkoutReady = hydrated && !redeemMode.loading && draftReady;

  function validateForm() {
    if (cartCount === 0) return L("购物车为空,请先选购商品", "Your cart is empty. Please add a service first.");
    if (!validEmail(form.email)) {
      return L("请填写有效的邮箱地址,客服将通过邮箱发送订单与开通信息", "Please enter a valid email — we'll send your order and access details there.");
    }
    if (contactRequired && !form.contact.trim()) {
      return L("Spotify 订单需要填写联系方式,客服会通过此方式联系您", "Spotify orders need a contact so support can reach you.");
    }
    for (const p of cartItems) {
      const f = form.fields[p.key] || {};
      if (productNeedsAccountPassword(p) && (!f.account?.trim() || !f.password?.trim())) {
        return L(`请为「${p.title}」填写需要开通的账号和密码`, `Please enter the account and password to set up for "${p.title}"`);
      }
    }
    return "";
  }

  function pendingIdentityMatches(pending, accountEmailOverride) {
    const originalAccount = String(pending?.identity?.accountEmail || "").trim().toLowerCase();
    const originalLifecycle = String(pending?.identity?.accountLifecycleId || "").trim().toLowerCase();
    const currentAccount = String(
      arguments.length > 1 ? accountEmailOverride : (authedUser?.email || ""),
    ).trim().toLowerCase();
    const currentLifecycle = arguments.length > 1 && !currentAccount
      ? ""
      : String(authedUser?.accountLifecycleId || "").trim().toLowerCase();
    return originalAccount === currentAccount && originalLifecycle === currentLifecycle;
  }

  function openPendingReauthentication(pending = pendingOrderRef.current) {
    const originalAccount = String(pending?.identity?.accountEmail || "").trim().toLowerCase();
    if (!originalAccount) return;
    pendingReplayStartedRef.current = false;
    setAuthedUser(null);
    setAuthError("");
    setAuthNotice("");
    setAuthForm((current) => ({ ...current, email: originalAccount, password: "" }));
    setAuthModal("login");
  }

  async function signOutAndRecoverGuestOrder() {
    const pending = pendingOrderRef.current;
    if (!pending || pending.invalid || String(pending.identity?.accountEmail || "").trim()) return;
    setStatus({ type: "info", message: L("正在退出当前账户并安全恢复访客订单...", "Signing out and safely recovering the guest order...") });
    try {
      // Do not pretend to be a guest while the authenticated cookie may still
      // be valid. A store outage deliberately keeps that cookie so the user
      // can retry durable all-device revocation.
      const response = await fetch("/api/auth/login", { method: "DELETE", credentials: "same-origin" });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok || !data?.ok || typeof data.revoked !== "boolean") {
        throw new Error("logout_not_confirmed");
      }
      setAuthedUser(null);
      setAccountReady(true);
      pendingReplayStartedRef.current = true;
      await replayPendingOrder(pending, "");
    } catch {
      pendingReplayStartedRef.current = false;
      setStatus({
        type: "error",
        action: "logout-guest",
        message: L(
          "退出登录失败，访客订单请求仍已保留。请勿重复支付，网络恢复后重试。",
          "Sign-out failed. The guest order is still preserved; do not pay again. Retry when the network recovers.",
        ),
      });
    }
  }

  function clearPendingJournal(operationKey) {
    if (typeof window !== "undefined") {
      try {
        clearCheckoutPendingJournal(window.localStorage, operationKey);
      } catch (ignore) {
        // A corrupt journal remains fail-closed; never erase an operation we
        // cannot prove is the one that just reached a terminal response.
      }
    }
    if (operationKey && pendingOrderRef.current?.idempotencyRequest?.key === operationKey) {
      pendingOrderRef.current = null;
    }
    if (operationKey && orderRequestRef.current?.key === operationKey) orderRequestRef.current = null;
  }

  function finishOrderSubmission(data, payload, operationKey) {
    setOrderResults([{
      orderId: data.orderId,
      items: data.items || [],
      paidAmount: data.paidAmount,
      paidCurrency: data.paidCurrency,
      paymentMethod: data.paymentMethod || (payload.paymentMethod === "redeem" ? "redeem" : payload.paymentMethod),
    }]);
    setStep("done");
    setStatus({ type: "success", message: L("订单已成功提交", "Order submitted successfully") });
    clearPendingJournal(operationKey);
    clearCart();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function dispatchExactOrder(pending) {
    const payload = pending.payload;
    const operation = pending.idempotencyRequest;
    const originalAccount = String(pending.identity?.accountEmail || "").trim();
    const originalLifecycle = String(pending.identity?.accountLifecycleId || "").trim();
    const response = await fetch("/api/order", {
      method: "POST",
      // Guest recovery deliberately omits any session cookie acquired after
      // the first attempt so the server derives the same operation identity.
      credentials: originalAccount ? "same-origin" : "omit",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": operation.key,
        // This also binds pre-upgrade journals whose exact persisted body did
        // not yet contain expectedAccountEmail.
        "X-Order-Expected-Account": originalAccount.toLowerCase() || "__guest__",
        "X-Operation-Expected-Lifecycle": originalAccount ? originalLifecycle : "__guest__",
      },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await response.json(); } catch (ignore) {}
    if (data?.ok) {
      finishOrderSubmission(data, payload, operation.key);
      return data;
    }
    if (isExplicitTerminalIdempotencyResponse(response.status, data)) {
      clearPendingJournal(operation.key);
      if (data?.error === "payment_quote_required") {
        setPaymentQuoteToken("");
        setPaymentAdjustment(0);
        setUsdtNonce(0);
        setStep("form");
      }
    }
    const requestMessage = data?.error === "operation_lifecycle_changed"
      ? L(
          "原账户已被删除或重新注册，待处理订单不能转移到新账户。请勿重复支付，并联系客服核对。",
          "The original account was deleted or re-registered. The pending order cannot move to the new account. Do not pay again; contact support.",
        )
      : data?.message || data?.error || `submit_failed_${response.status || "network"}`;
    const requestError = new Error(requestMessage);
    requestError.terminal = isExplicitTerminalIdempotencyResponse(response.status, data);
    requestError.status = response.status;
    requestError.code = data?.error || "";
    throw requestError;
  }

  async function replayPendingOrder(pending, accountEmailOverride) {
    if (!pending || pending.invalid || submitting) return;
    if (!pendingIdentityMatches(
      pending,
      arguments.length > 1 ? accountEmailOverride : (authedUser?.email || ""),
    )) return;
    setSubmitting(true);
    setStatus({ type: "info", message: L("正在安全恢复待处理订单...", "Safely recovering your unfinished order...") });
    try {
      // Startup recovery, re-auth recovery, and manual retry all use the same
      // origin-wide admission gate as a new checkout. The server key is still
      // authoritative, but avoiding parallel client replays also prevents
      // competing tabs from racing journal cleanup and UI recovery state.
      await withCheckoutSubmissionCoordination(() => dispatchExactOrder(pending));
    } catch (error) {
      const retained = !error.terminal;
      const mustReauthenticate = error.status === 401 || error.code === "operation_identity_changed" || error.code === "operation_identity_auth_required";
      const mustSignOutForGuest = error.code === "guest_operation_has_session";
      if (mustReauthenticate) pendingReplayStartedRef.current = false;
      if (mustReauthenticate) openPendingReauthentication(pending);
      setStatus({
        type: "error",
        action: mustReauthenticate ? "reauthenticate" : mustSignOutForGuest ? "logout-guest" : "",
        message: mustReauthenticate
          ? L(
              `登录状态已变化。请重新登录 ${pending.identity?.accountEmail || "原账户"} 后原样恢复订单，请勿重复支付。`,
              `Your session changed. Sign in again as ${pending.identity?.accountEmail || "the original account"} to replay the original order; do not pay again.`,
            )
          : mustSignOutForGuest
          ? L(
              "该待处理订单最初由访客提交。请先退出当前账户，再原样恢复；请勿重复支付。",
              "This unfinished order was submitted as a guest. Sign out to replay it exactly; do not pay again.",
            )
          : retained
          ? L(
              `${error.message || "订单恢复暂时失败"}，原订单请求已保留，请勿重复支付，可稍后重试或联系在线客服。`,
              `${error.message || "Order recovery is temporarily unavailable"}. The original request is preserved; do not pay again. Retry later or contact support.`,
            )
          : L(
              `${error.message || "原订单请求已被服务器拒绝"}，请重新确认订单信息。`,
              `${error.message || "The original request was rejected by the server"}. Review the order details before trying again.`,
            ),
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function goPay(event) {
    event.preventDefault();
    if (!accountReady) {
      setStatus({ type: "error", message: accountError || L("正在确认登录状态，请稍候或重试", "Your session is still being verified. Wait or retry.") });
      return;
    }
    const pending = pendingOrderRef.current;
    if (pending) {
      if (pending.invalid) {
        setStatus({
          type: "error",
          message: L("待处理订单无法安全恢复，请勿重复支付并联系在线客服。", "The unfinished order can't be safely restored. Do not pay again; contact support."),
        });
        return;
      }
      if (!pendingIdentityMatches(pending)) return;
      pendingReplayStartedRef.current = true;
      await replayPendingOrder(pending);
      return;
    }
    if (!checkoutConfigReady) {
      setStatus({
        type: "error",
        message: checkoutConfigLoading
          ? L("正在读取最新商品价格与收款信息，请稍候", "Loading the latest prices and payment details. Please wait.")
          : L("暂时无法读取最新商品价格与收款信息。为避免金额或收款信息错误，请重试后再付款", "The latest prices and payment details could not be loaded. Retry before paying."),
      });
      return;
    }
    if (requiresUsdtRate && !usdtRateReady) {
      setStatus({
        type: "error",
        message: usdtRateState.loading
          ? L("正在读取当前 USDT 汇率，请稍候", "Loading the current USDT rate. Please wait.")
          : L("暂时无法读取当前 USDT 汇率。为避免金额错误，请重试或改用其他付款方式", "The current USDT rate could not be loaded. Retry or choose another payment method."),
      });
      return;
    }
    const error = validateForm();
    if (error) {
      setStatus({ type: "error", message: error });
      return;
    }
    setStatus(null);
    if (serviceRedeemActive) {
      submitOrders();
      return;
    }
    setPaySubmitNotice("");
    setPaymentQuoteToken("");
    setPaymentAdjustment(0);
    setUsdtNonce(0);
    setUsdtPrecision(4);
    if ((paymentMethod === "alipay" || paymentMethod === "usdt") && finalCny > 0) {
      setSubmitting(true);
      setStatus({ type: "info", message: L("正在生成付款金额...", "Generating payment amount...") });
      try {
        const response = await fetch("/api/order-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentMethod }),
        });
        const quote = await response.json();
        if (!quote.ok) throw new Error(quote.message || quote.error || "payment_quote_failed");
        setPaymentAdjustment(Number(quote.paymentAdjustment || 0));
        setUsdtNonce(Number(quote.usdtNonce || 0));
        setUsdtPrecision(Number(quote.usdtPrecision) === 6 ? 6 : 4);
        setPaymentQuoteToken(String(quote.quoteToken || ""));
      } catch (quoteError) {
        setStatus({ type: "error", message: quoteError.message || L("付款金额生成失败，请稍后再试", "Couldn't generate the payment amount, please try again") });
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    setStatus(null);
    setPaymentPageEnteredAt(Date.now());
    setStep("pay");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitOrders() {
    if (submitting) return;
    if (!accountReady) {
      setStatus({ type: "error", message: accountError || L("正在确认登录状态，请稍候或重试", "Your session is still being verified. Wait or retry.") });
      return;
    }
    const unresolved = pendingOrderRef.current;
    if (unresolved) {
      if (unresolved.invalid) {
        setStatus({
          type: "error",
          message: L("待处理订单无法安全恢复，请勿重复支付并联系在线客服。", "The unfinished order can't be safely restored. Do not pay again; contact support."),
        });
        return;
      }
      if (!pendingIdentityMatches(unresolved)) return;
      pendingReplayStartedRef.current = true;
      await replayPendingOrder(unresolved);
      return;
    }
    if (!checkoutConfigReady) {
      setStatus({
        type: "error",
        message: checkoutConfigLoading
          ? L("正在读取最新商品价格与收款信息，请稍候", "Loading the latest prices and payment details. Please wait.")
          : L("暂时无法读取最新商品价格与收款信息。为避免金额或收款信息错误，请重试后再提交", "The latest prices and payment details could not be loaded. Retry before submitting."),
      });
      return;
    }
    if (requiresUsdtRate && !usdtRateReady) {
      setStatus({
        type: "error",
        message: usdtRateState.loading
          ? L("正在读取当前 USDT 汇率，请稍候", "Loading the current USDT rate. Please wait.")
          : L("暂时无法读取当前 USDT 汇率。为避免金额错误，请重试或改用其他付款方式", "The current USDT rate could not be loaded. Retry or choose another payment method."),
      });
      return;
    }
    if (cartCount === 0) return;
    const error = validateForm();
    if (error) {
      setStatus({ type: "error", message: error });
      setStep("form");
      return;
    }
    const scanPaymentActive = !serviceRedeemActive && step === "pay" && (paymentMethod === "alipay" || paymentMethod === "usdt");
    if (scanPaymentActive && paymentPageEnteredAt && Date.now() - paymentPageEnteredAt < 5000) {
      setStatus(null);
      setPaySubmitNotice(L("请扫码完成付款，付款完成后再点击「付款完成」提交订单", "Please scan to pay first, then tap \"I've paid\" to submit the order"));
      return;
    }

    setPaySubmitNotice("");
    setSubmitting(true);
    setStatus({ type: "info", message: L("正在提交订单...", "Submitting your order...") });

    const items = cartItems.map((p) => {
      const f = form.fields[p.key] || {};
      const item = {
        service: p.key,
        account: (f.account || "").trim(),
        password: productNeedsAccountPassword(p) ? (f.password || "").trim() : "",
      };
      if (hasProductPlans(p.key)) {
        item.plan = planMap[p.key] || getDefaultProductPlan(p.key);
        if (p.key === "rocket") item.rocketPlan = item.plan || DEFAULT_ROCKET_PLAN;
      }
      return item;
    });

    try {
      await withCheckoutSubmissionCoordination(async () => {
        // Re-read after acquiring origin-wide ownership. A journal may have
        // appeared after this tab rendered but before the user clicked.
        const snapshot = readCheckoutPendingJournals(window.localStorage);
        if (!snapshot.ok || snapshot.records.length > 1) {
          pendingOrderRef.current = {
            invalid: true,
            error: !snapshot.ok ? "checkout_journal_ambiguous" : "checkout_multiple_pending_orders",
          };
          throw new Error("checkout_journal_ambiguous");
        }
        if (snapshot.records.length === 1) {
          const existing = snapshot.records[0].record;
          pendingOrderRef.current = existing;
          orderRequestRef.current = existing.idempotencyRequest;
          if (!pendingIdentityMatches(existing)) {
            const originalAccount = String(existing.identity?.accountEmail || "").trim();
            const identityError = new Error(originalAccount ? "operation_identity_changed" : "guest_operation_has_session");
            identityError.code = identityError.message;
            identityError.status = 409;
            throw identityError;
          }
          await dispatchExactOrder(existing);
          return;
        }

        const payload = {
          email: form.email.trim(),
          contact: form.contact.trim(),
          remark: form.remark.trim(),
          // The server verifies this persisted identity against the cookie on
          // every exact replay. This closes a cross-tab account-switch race that
          // client-side state alone cannot reliably detect.
          expectedAccountEmail: authedUser?.email || "",
          expectedAccountLifecycleId: authedUser?.accountLifecycleId || "",
          paymentMethod,
          paymentQuoteToken: (paymentMethod === "alipay" || paymentMethod === "usdt") ? paymentQuoteToken : "",
          redeemCode: serviceRedeemActive ? redeemMode.code : "",
          inviteCode: storedInviteCode(),
          items,
        };
        const operationAccountEmail = payload.expectedAccountEmail;
        const pending = createPendingIdempotencyRecord(
          orderRequestRef.current,
          "checkout-order",
          payload,
          {
            identity: {
              accountEmail: operationAccountEmail,
              accountLifecycleId: payload.expectedAccountLifecycleId,
            },
            metadata: {
              form,
              paymentMethod,
              cart,
              paymentQuote: { paymentAdjustment, usdtNonce, usdtPrecision },
            },
          },
        );
        const persisted = writeCheckoutPendingJournal(window.localStorage, pending);
        const operation = persisted.record.idempotencyRequest;
        orderRequestRef.current = operation;
        pendingOrderRef.current = persisted.record;
        await dispatchExactOrder(persisted.record);
      });
    } catch (error) {
      const retained = !error.terminal;
      const mustReauthenticate = error.status === 401 || error.code === "operation_identity_changed" || error.code === "operation_identity_auth_required";
      const mustSignOutForGuest = error.code === "guest_operation_has_session";
      const journalBlocked = String(error.message || "").startsWith("checkout_");
      if (journalBlocked && !pendingOrderRef.current) {
        pendingOrderRef.current = { invalid: true, error: error.message };
        orderRequestRef.current = null;
        pendingReplayStartedRef.current = false;
      }
      if (mustReauthenticate) {
        pendingReplayStartedRef.current = false;
        openPendingReauthentication(pendingOrderRef.current);
      }
      setStatus({
        type: "error",
        action: mustReauthenticate ? "reauthenticate" : mustSignOutForGuest ? "logout-guest" : "",
        message: journalBlocked
          ? L(
              "检测到其他标签页的待处理订单，或当前浏览器无法安全协调多标签提交。未发送新的订单请求；请勿重复付款，并在原标签页重试或联系客服。",
              "Another tab has an unfinished order, or this browser cannot safely coordinate checkout tabs. No new order was sent; do not pay again. Retry in the original tab or contact support.",
            )
          : mustReauthenticate
          ? L(
              `登录状态已变化。请重新登录 ${pendingOrderRef.current?.identity?.accountEmail || "原账户"} 后原样恢复订单，请勿重复支付。`,
              `Your session changed. Sign in again as ${pendingOrderRef.current?.identity?.accountEmail || "the original account"} to replay the original order; do not pay again.`,
            )
          : mustSignOutForGuest
          ? L(
              "该待处理订单最初由访客提交。请先退出当前账户，再原样恢复；请勿重复支付。",
              "This unfinished order was submitted as a guest. Sign out to replay it exactly; do not pay again.",
            )
          : retained
          ? L(
              `${error.message || "订单提交失败"}，原请求已完整保留，请勿重复支付，可稍后原样重试或联系在线客服。`,
              `${error.message || "Order submission failed"}. The exact request is preserved; do not pay again. Retry later or contact support.`,
            )
          : L(
              `${error.message || "订单请求已被服务器拒绝"}，请重新确认订单信息。`,
              `${error.message || "The order request was rejected by the server"}. Review the details before trying again.`,
            ),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!checkoutReady && step !== "done") {
    return (
      <div className="checkout-page">
        <header className="checkout-header">
          <Link href="/shop" className="checkout-back">
            <ArrowLeft size={16} />
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="checkout-logo" />
          </Link>
          <div className="checkout-secure">
            <Lock size={13} />
            {L("安全结算", "Secure checkout")}
          </div>
        </header>
        <div className="checkout-empty checkout-loading-state">
          <LoaderCircle size={46} className="checkout-empty-icon spin-icon" />
          <h2>{L("正在恢复订单", "Restoring your order")}</h2>
          <p>{L("正在恢复未完成订单", "Loading your unfinished checkout…")}</p>
        </div>
        <FloatingSupport />
      </div>
    );
  }

  if (checkoutReady && catalogState.ready && !pendingOrderRef.current && (proxyQuoteCart || proxySubmitted)) {
    return (
      <ProxyPaymentCheckout
        initialEmail={form.email || authedUser?.email || ""}
        accountEmail={authedUser?.email || ""}
        accountLifecycleId={authedUser?.accountLifecycleId || ""}
        onSubmitted={() => {
          setProxySubmitted(true);
          clearCart();
          try {
            window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
          } catch {}
        }}
      />
    );
  }

  // Empty cart state
  if (checkoutReady && cartCount === 0 && step !== "done") {
    return (
      <div className="checkout-page">
        <header className="checkout-header">
          <Link href="/shop" className="checkout-back">
            <ArrowLeft size={16} />
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="checkout-logo" />
          </Link>
          <div className="checkout-secure">
            <Lock size={13} />
            {L("安全结算", "Secure checkout")}
          </div>
        </header>
        <div className="checkout-empty">
          <ShoppingCart size={64} className="checkout-empty-icon" />
          <h2>{L("购物车为空", "Your cart is empty")}</h2>
          <p>{L("先选择需要开通的服务", "Pick a service to get started")}</p>
          <Link href="/shop" className="primary-btn primary-btn-lg">
            <ArrowLeft size={15} />
            {L("前往选购", "Go to shop")}
          </Link>
        </div>
        <FloatingSupport />
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <header className="checkout-header">
        <Link href="/shop" className="checkout-back">
          <ArrowLeft size={16} />
          <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="checkout-logo" />
        </Link>
        <div className="checkout-secure">
          <Lock size={13} />
          {serviceRedeemActive ? L("兑换码免支付", "Code · no payment") : paymentMethod === "usdt" ? L("USDT-TRC20 安全结算", "USDT-TRC20 secure checkout") : paymentMethod === "balance" ? L("账户余额支付", "Account balance") : L("支付宝担保结算", "Alipay secure checkout")}
        </div>
      </header>

      <main className="checkout-main">
        <div className="checkout-stepper">
          {(locale === "en" ? ["Order details", "Scan & pay", "Done"] : ["填写订单", "扫码付款", "提交完成"]).map((label, idx) => {
            const stepIndex = step === "form" ? 0 : step === "pay" ? 1 : 2;
            const done = idx < stepIndex;
            const active = idx === stepIndex;
            return (
              <div key={label} className={`checkout-step${done ? " done" : ""}${active ? " active" : ""}`}>
                <span className="checkout-step-num">{done ? <CheckCircle2 size={14} /> : idx + 1}</span>
                <span className="checkout-step-label">{label}</span>
              </div>
            );
          })}
        </div>

        {status && (
          <div className={`checkout-alert ${status.type}`} role={status.type === "error" ? "alert" : "status"}>
            <span>{status.message}</span>
            {status.action === "reauthenticate" && (
              <button type="button" className="checkout-alert-action" onClick={() => openPendingReauthentication()}>
                {L("重新登录原账户", "Sign in as the original account")}
              </button>
            )}
            {status.action === "logout-guest" && (
              <button type="button" className="checkout-alert-action" onClick={signOutAndRecoverGuestOrder}>
                {L("退出并恢复访客订单", "Sign out and recover guest order")}
              </button>
            )}
          </div>
        )}

        {!checkoutConfigReady && !proxySubmitted && (
          <div className={`checkout-alert ${checkoutConfigError ? "error" : "info"}`} role={checkoutConfigError ? "alert" : "status"}>
            <span>{checkoutConfigError
              ? L("暂时无法读取最新商品价格与收款信息。为避免金额或收款信息错误，当前无法付款", "The latest prices and payment details could not be loaded, so payment is temporarily unavailable.")
              : L("正在读取最新商品价格与收款信息…", "Loading the latest prices and payment details…")}</span>
            {checkoutConfigError && (
              <button
                type="button"
                className="checkout-alert-action"
                onClick={() => { catalogState.retry(); settingsState.retry(); }}
              >
                {L("重试", "Retry")}
              </button>
            )}
          </div>
        )}

        {checkoutConfigReady && requiresUsdtRate && !usdtRateReady && (
          <div className={`checkout-alert ${usdtRateState.error ? "error" : "info"}`} role={usdtRateState.error ? "alert" : "status"}>
            <span>{usdtRateState.error
              ? L("暂时无法读取当前 USDT 汇率。为避免金额错误，USDT 支付已暂停；请重试或改用其他付款方式", "The current USDT rate could not be loaded. USDT payment is paused; retry or choose another payment method.")
              : L("正在读取当前 USDT 汇率…", "Loading the current USDT rate…")}</span>
            {usdtRateState.error && (
              <button type="button" className="checkout-alert-action" onClick={() => setUsdtRateAttempt((value) => value + 1)}>
                {L("重试", "Retry")}
              </button>
            )}
          </div>
        )}

        {!accountReady && <div className={`checkout-alert ${accountError ? "error" : "info"}`} role={accountError ? "alert" : "status"}>
          <span>{accountError || L("正在确认登录状态，确认完成前无法付款", "Verifying your session. Payment stays disabled until this finishes.")}</span>
          {accountError && <button type="button" className="checkout-alert-action" onClick={() => refreshAccountState()}><RefreshCw size={13} />{L("重试", "Retry")}</button>}
        </div>}

        {serviceRedeemActive && (
          <div className="checkout-alert success">
            {L("服务兑换码已识别", "Service code recognized")}: {(redeemMode.info.services || []).map((item) => item.label).join(" + ")}{L("，按页面提示填写后可直接提交,无需支付", " — fill in the form below and submit directly, no payment needed")}
          </div>
        )}

        {step === "form" && (
          <form className="checkout-grid" onSubmit={goPay}>
            <div className="checkout-left">
              {/* Trust strip */}
              <div className="checkout-trust">
                <span><Lock size={12} />{L("信息加密", "Encrypted")}</span>
                <span><ShieldCheck size={12} />{L("担保支付", "Escrow pay")}</span>
                <span><Zap size={12} />{L("10 分钟内开通", "Live in 10 min")}</span>
                <span><RefreshCw size={12} />{L("7 天内可退", "7-day refund")}</span>
              </div>

              {/* Cart items */}
              <section className="checkout-card">
                <div className="checkout-card-head">
                  <h3>{L("已选商品", "Selected")} <em>{cartCount}</em></h3>
                  {!serviceRedeemActive && <Link href="/shop" className="text-link">{L("+ 继续选购", "+ Add more")}</Link>}
                </div>
                <div className="cart-items-grid">
                  {cartItems.map((item) => {
                    const itemAmount = productItemAmount(item, planMap[item.key]);
                    const planInfo = hasProductPlans(item.key) ? localizePlan(item.key, getProductPlan(item.key, planMap[item.key]), locale) : null;
                    const itemL = localizeProduct(item, locale);
                    return (
                      <div key={item.key} className="cart-tile">
                        {!serviceRedeemActive && (
                          <button
                            type="button"
                            className="cart-tile-remove"
                            onClick={() => removeFromCart(item.key)}
                            aria-label={L(`移除 ${item.title}`, `Remove ${itemL.title}`)}
                            title={L(`移除 ${item.title}`, `Remove ${itemL.title}`)}
                          >
                            <X size={11} strokeWidth={3} />
                          </button>
                        )}
                        <img src={item.image} alt={itemL.title} className="cart-tile-img" />
                        <div className="cart-tile-name">
                          {itemL.title}
                          {planInfo && (
                            <span className="cart-tile-plan-tag">{planInfo.label}</span>
                          )}
                        </div>
                        <div className="cart-tile-price">¥{itemAmount}</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Per-product extra fields */}
              {cartItems.some((p) => productNeedsAccountPassword(p)) && (
                <section className="checkout-card">
                  <div className="checkout-card-head">
                    <h3>{L("开通信息", "Setup details")}</h3>
                  </div>
                  <div className="checkout-product-fields">
                    {cartItems.map((p) => {
                      const f = form.fields[p.key] || {};
                      if (productNeedsAccountPassword(p)) {
                        return (
                          <div key={p.key} className="order-field-grid">
                            <label className="order-field">
                              <span>{p.title} · {L("账号/邮箱", "Account / email")}</span>
                              <input
                                value={f.account || ""}
                                onChange={(e) => updateProductField(p.key, "account", e.target.value)}
                                placeholder={L("需要开通的账号", "Account to set up")}
                                autoComplete="username"
                                required
                              />
                            </label>
                            <label className="order-field">
                              <span className="order-field-label-row">
                                <span>{p.title} · {L("密码", "Password")}</span>
                                {p.key === "spotify" && (
                                  <a
                                    className="order-field-help-link"
                                    href="https://accounts.spotify.com/en/password-reset"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {L("忘记 Spotify 密码？点击找回", "Forgot Spotify password? Reset it")}
                                  </a>
                                )}
                              </span>
                              <div className="password-input-wrap">
                                <input
                                  type={passwordVisible ? "text" : "password"}
                                  value={f.password || ""}
                                  onChange={(e) => updateProductField(p.key, "password", e.target.value)}
                                  placeholder={L("账号密码", "Account password")}
                                  autoComplete="current-password"
                                  required
                                />
                                <button
                                  type="button"
                                  className="password-eye-btn"
                                  onClick={() => setPasswordVisible((v) => !v)}
                                  aria-label={passwordVisible ? L("隐藏密码", "Hide password") : L("显示密码", "Show password")}
                                >
                                  {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                                </button>
                              </div>
                            </label>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </section>
              )}

              {/* Contact info */}
              <section className="checkout-card">
                <div className="checkout-card-head">
                  <h3>{L("联系方式", "Contact")}</h3>
                </div>
                <label className="order-field">
                  <span>{L("邮箱", "Email")} <em className="field-required">*</em></span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => updateField("email", e.target.value)}
                    placeholder={L("接收订单通知，也可用于后续查询", "For order updates and later lookups")}
                    autoComplete="email"
                    inputMode="email"
                    maxLength={200}
                    required
                  />
                </label>
                <label className="order-field">
                  <span>
                    QQ / WeChat / WhatsApp / Telegram
                    {contactRequired ? <em className="field-required">*</em> : <em className="field-optional">{L("(选填)", "(optional)")}</em>}
                  </span>
                  <input
                    value={form.contact}
                    onChange={(e) => updateField("contact", e.target.value)}
                    placeholder={contactRequired
                      ? L("Spotify 订单需要,方便客服协助开通", "Needed for Spotify so support can help set up")
                      : L("可选 — 通常通过邮箱沟通", "Optional — we usually reach you by email")}
                    autoComplete="tel"
                    maxLength={200}
                    required={contactRequired}
                  />
                </label>
                <label className="order-field">
                  <span>{L("备注(非必填)", "Note (optional)")}</span>
                  <textarea
                    value={form.remark}
                    onChange={(e) => updateField("remark", e.target.value)}
                    placeholder={L("特殊需求或付款备注等", "Special requests or payment notes")}
                    rows={2}
                    maxLength={1500}
                  />
                </label>
              </section>
            </div>

            <aside className="checkout-right">
              <section className="checkout-card sticky-summary">
                <div className="checkout-card-head">
                  <h3>{L("订单总览", "Order summary")}</h3>
                </div>

                <div className="cart-summary">
                  <div className="cart-summary-row">
                    <span>{L("商品总价", "Subtotal")}</span>
                    <b>¥{subtotal}</b>
                  </div>
                  {discountRate > 0 && (
                    <div className="cart-summary-row discount">
                      <span>{L("组合优惠", "Bundle discount")} · {bundleDiscountLabel(cartCount, locale)}</span>
                      <b>−¥{savings}</b>
                    </div>
                  )}
                  <div className="cart-summary-row total">
                    <span>{L("组合折后", "After bundle")}</span>
                    <b>¥{bundleFinalCny}</b>
                  </div>
                  {couponDiscount > 0 && (
                    <div className="cart-summary-row coupon">
                      <span>{locale === "en" ? "New-user coupon" : (activeCoupon?.title || "优惠券自动抵扣")}</span>
                      <b>−¥{couponDiscount.toFixed(2)}</b>
                    </div>
                  )}
                  {serviceRedeemActive && (
                    <div className="cart-summary-row coupon">
                      <span>{L("服务兑换码抵扣", "Service code applied")}</span>
                      <b>−¥{bundleFinalCny.toFixed(2)}</b>
                    </div>
                  )}
                  <div className="cart-summary-row total">
                    <span>{L("应付总额", "Total due")}</span>
                    <b>¥{serviceRedeemActive ? "0.00" : finalCny.toFixed(2)}</b>
                  </div>
                  {cartCount === 1 && (
                    <div className="cart-bundle-hint">
                      <Gift size={12} />{L(`再加 1 件享 ${bundleTierLabel(2, "zh")},加满 3 件享 ${bundleTierLabel(3, "zh")}`, `Add 1 more for ${bundleTierLabel(2, "en")}, 3 items for ${bundleTierLabel(3, "en")}`)}
                    </div>
                  )}
                  {cartCount === 2 && (
                    <div className="cart-bundle-hint">
                      <Gift size={12} />{L(`再加 1 件升级到 ${bundleTierLabel(3, "zh")}`, `Add 1 more for ${bundleTierLabel(3, "en")}`)}
                    </div>
                  )}
                </div>

                {/* Payment method */}
                {!serviceRedeemActive && <div className="payment-method-group">
                  <div className="payment-method-label">{L("选择支付方式", "Payment method")}</div>
                  <div className="payment-method-options">
                    <label className={`payment-method-option${paymentMethod === "alipay" ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="paymentMethod"
                        value="alipay"
                        checked={paymentMethod === "alipay"}
                        onChange={() => setPaymentMethod("alipay")}
                      />
                      <div className="payment-method-icon alipay"><AlipayIcon /></div>
                      <div className="payment-method-detail">
                        <strong>¥{finalCny}</strong>
                        <small>{L("担保支付 · 即时到账", "Escrow · instant")}</small>
                      </div>
                    </label>
                    <label className={`payment-method-option${paymentMethod === "usdt" ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="paymentMethod"
                        value="usdt"
                        checked={paymentMethod === "usdt"}
                        onChange={() => setPaymentMethod("usdt")}
                      />
                      <div className="payment-method-icon usdt"><UsdtIcon /></div>
                      <div className="payment-method-detail">
                        <strong>{usdtRateReady
                          ? `${finalUsdt} USDT`
                          : usdtRateState.error
                            ? L("汇率暂不可用", "Rate unavailable")
                            : L("汇率确认中", "Checking rate")}</strong>
                        <small>{usdtPresentation.methodNote}</small>
                      </div>
                      {usdtPresentation.discount && <div className="payment-method-badge">{usdtPresentation.discount}</div>}
                    </label>
                    {authedUser && (
                      <label className={`payment-method-option${paymentMethod === "balance" ? " selected" : ""}${authedUser.balance < finalCny ? " low-balance" : ""}`}>
                        <input
                          type="radio"
                          name="paymentMethod"
                          value="balance"
                          checked={paymentMethod === "balance"}
                          onChange={() => authedUser.balance >= finalCny && setPaymentMethod("balance")}
                          disabled={authedUser.balance < finalCny}
                        />
                        <div className="payment-method-icon balance"><BalanceIcon /></div>
                        <div className="payment-method-detail">
                          <strong>{L("账户余额支付", "Pay with balance")}</strong>
                          <small>{L("余额", "Balance")} ¥{authedUser.balance.toFixed(2)}{authedUser.balance < finalCny ? L(" · 余额不足", " · insufficient") : L(" · 一键扣款", " · one tap")}</small>
                        </div>
                      </label>
                    )}
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon wechat"><WechatIcon /></div>
                      <div className="payment-method-detail">
                        <strong>{L("微信支付", "WeChat Pay")}</strong>
                        <small>{L("暂未开放,请选择其他方式", "Coming soon — pick another method")}</small>
                      </div>
                    </label>
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon card"><CardPayIcon /></div>
                      <div className="payment-method-detail">
                        <strong>Mastercard / Visa</strong>
                        <small>{L("暂未开放,请选择其他方式", "Coming soon — pick another method")}</small>
                      </div>
                    </label>
                  </div>
                </div>}

                <button type="submit" className="primary-btn primary-btn-lg checkout-submit-btn" disabled={cartCount === 0 || submitting || !accountReady || !checkoutPaymentReady}>
                  {!checkoutConfigReady
                    ? L("正在确认最新价格", "Checking latest prices")
                    : requiresUsdtRate && !usdtRateReady
                      ? usdtRateState.error ? L("USDT 汇率不可用", "USDT rate unavailable") : L("正在确认 USDT 汇率", "Checking USDT rate")
                    : serviceRedeemActive
                      ? L("确认兑换并提交订单", "Confirm & submit order")
                      : `${L("前往支付", "Pay")} · ${paymentMethod === "usdt" ? `${finalUsdt} USDT` : `¥${finalCny}`}`}
                  <ArrowRight size={15} />
                </button>
              </section>
            </aside>

            {/* Mobile sticky bottom CTA */}
            <div className="checkout-mobile-cta">
              <div className="checkout-mobile-cta-info">
                <small>{serviceRedeemActive ? L("服务兑换码", "Service code") : paymentMethod === "usdt" ? "USDT-TRC20" : paymentMethod === "balance" ? L("账户余额", "Account balance") : L("支付宝", "Alipay")}</small>
                <b>{serviceRedeemActive
                  ? L("免支付", "No pay")
                  : paymentMethod === "usdt"
                    ? usdtRateReady ? `${finalUsdt} USDT` : L("汇率确认中", "Checking rate")
                    : `¥${finalCny}`}</b>
              </div>
              <button type="submit" className="primary-btn checkout-mobile-cta-btn" disabled={cartCount === 0 || submitting || !accountReady || !checkoutPaymentReady}>
                {!checkoutConfigReady
                  ? L("正在确认价格", "Checking prices")
                  : requiresUsdtRate && !usdtRateReady
                    ? L("等待 USDT 汇率", "Waiting for USDT rate")
                    : serviceRedeemActive ? L("提交兑换", "Submit") : L("前往支付", "Pay")}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        )}

        {step === "pay" && (
          <div className="checkout-pay-compact">
            <section className="checkout-card pay-card-tight">
              {/* 支付方式头 */}
              <div className="pay-method-head">
                <span className="pay-method-tag">
                  {paymentMethod === "usdt" ? "USDT · TRC20" : paymentMethod === "balance" ? L("账户余额", "Balance") : L("支付宝", "Alipay")}
                </span>
                <button
                  type="button"
                  className="pay-method-switch"
                  onClick={() => { setPaySubmitNotice(""); setPaymentPageEnteredAt(0); setStep("form"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  disabled={submitting}
                >
                  {L("切换方式", "Change method")}
                </button>
              </div>

              {/* 应付金额 - 大字 */}
              <div className="pay-amount-prominent">
                <span>{paymentMethod === "balance" ? L("余额扣款", "Charged from balance") : L("应付金额", "Amount due")}</span>
                {paymentMethod === "usdt" ? (
                  usdtRateReady ? <>
                    <b>{usdtPayable} <em>USDT</em></b>
                    <small>¥{finalCny}{L("(支付宝应付)", " (Alipay due)")} × {usdtDiscount} ÷ {effectiveUsdtRate}</small>
                  </> : <b>{usdtRateState.error ? L("USDT 汇率暂不可用", "USDT rate unavailable") : L("正在确认 USDT 汇率", "Checking USDT rate")}</b>
                ) : paymentMethod === "alipay" ? (
                  <>
                    <b>¥{alipayPayableCny.toFixed(2)}</b>
                    <small>{L("付款核对尾差", "Verification adjustment")} {paymentAdjustment > 0 ? "+" : ""}¥{paymentAdjustment.toFixed(2)}{L("，商品金额", " · item total")} ¥{finalCny.toFixed(2)}</small>
                  </>
                ) : (
                  <b>¥{finalCny}</b>
                )}
              </div>

              {/* 重要提示 */}
              <div className="pay-tip">
                {paymentMethod === "usdt"
                  ? usdtRateReady
                    ? L(`请使用 TRON (TRC20) 网络转账精确金额 ${usdtPayable} USDT 到下方地址,付款完成后请记得返回本页面点击「付款完成」按钮提交订单`, `Send exactly ${usdtPayable} USDT over the TRON (TRC20) network to the address below. After paying, return here and tap "I've paid" to submit your order.`)
                    : L("汇率确认成功后才会显示转账金额和收款信息，请勿提前转账", "The amount and payment details appear only after the rate is verified. Do not transfer yet.")
                  : paymentMethod === "balance"
                  ? L(`点击下方「确认扣款并提交订单」后，将从您的账户余额(¥${authedUser?.balance.toFixed(2) || "0.00"})扣除 ¥${finalCny},随后提交订单`, `Tapping "Confirm & submit order" below will deduct ¥${finalCny} from your balance (¥${authedUser?.balance.toFixed(2) || "0.00"}) and place the order.`)
                  : L("请按上方精确金额完成支付宝付款，尾差用于快速核对订单；付款完成后返回本页面点击「付款完成」提交订单", "Pay the exact amount above via Alipay — the small diff helps us verify your order quickly. After paying, return here and tap \"I've paid\" to submit.")}
              </div>

              {/* QR 二维码 — 只对支付宝/USDT 显示,余额支付不需要 */}
              {checkoutPaymentReady && paymentMethod !== "balance" && (
                <div className="qr-display compact">
                  <img
                    src={paymentMethod === "usdt" ? siteSettings.payment.usdtQr : siteSettings.payment.alipayQr}
                    alt={paymentMethod === "usdt" ? L("USDT 收款码", "USDT QR code") : L("支付宝收款码", "Alipay QR code")}
                  />
                  <div className="qr-display-label">
                    {paymentMethod === "usdt" ? L("TRC20 钱包扫一扫或复制下面地址转账", "Scan with a TRC20 wallet, or copy the address below") : L("支付宝扫一扫", "Scan with Alipay")}
                  </div>
                </div>
              )}

              {/* USDT 地址 */}
              {checkoutPaymentReady && paymentMethod === "usdt" && (
                <div className="usdt-address-box">
                  <span className="usdt-address-label">{L("TRON / TRC20 收款地址", "TRON / TRC20 address")}</span>
                  <div className="usdt-address-field">
                    <code className="usdt-address-value">{siteSettings.usdt.address}</code>
                    <button
                      type="button"
                      className={`usdt-address-copy${copiedKey === "usdt-addr" ? " copied" : ""}`}
                      onClick={() => handleCopy(siteSettings.usdt.address, "usdt-addr")}
                      aria-label={copiedKey === "usdt-addr" ? L("已复制", "Copied") : L("复制地址", "Copy address")}
                      title={copiedKey === "usdt-addr" ? L("已复制", "Copied") : L("复制地址", "Copy address")}
                    >
                      {copiedKey === "usdt-addr" ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>
              )}

              {/* 订单总览 - 折叠到底部 */}
              <details className="pay-summary-foldable">
                <summary>{L(`查看订单详情(${cartCount} 件)`, `Order details (${cartCount})`)}</summary>
                <div className="checkout-cart-summary">
                  {cartItems.map((p) => {
                    const itemAmount = productItemAmount(p, planMap[p.key]);
                    const planInfo = hasProductPlans(p.key) ? localizePlan(p.key, getProductPlan(p.key, planMap[p.key]), locale) : null;
                    const pL = localizeProduct(p, locale);
                    return (
                      <div key={p.key} className="checkout-cart-row">
                        <span>{planInfo ? `${pL.title} · ${planInfo.label}` : pL.title}</span>
                        <b>¥{itemAmount}</b>
                      </div>
                    );
                  })}
                  {discountRate > 0 && (
                    <div className="checkout-cart-row discount">
                      <span>{L("组合优惠", "Bundle discount")} · {bundleDiscountLabel(cartCount, locale)}</span>
                      <b>−¥{savings}</b>
                    </div>
                  )}
                  {couponDiscount > 0 && (
                    <div className="checkout-cart-row discount">
                      <span>{locale === "en" ? "New-user coupon" : (activeCoupon?.title || "优惠券自动抵扣")}</span>
                      <b>−¥{couponDiscount.toFixed(2)}</b>
                    </div>
                  )}
                </div>
              </details>

              {paySubmitNotice && paymentMethod !== "balance" && (
                <div className="pay-submit-notice" role="status" aria-live="polite">
                  {paySubmitNotice}
                </div>
              )}

              {/* 提交按钮 */}
              <button
                type="button"
                className="primary-btn primary-btn-lg pay-submit-btn"
                onClick={submitOrders}
                disabled={submitting || !accountReady || !checkoutPaymentReady}
              >
                {submitting ? (
                  <>
                    <LoaderCircle size={15} className="spin-icon" />
                    {L("正在提交", "Submitting")}
                  </>
                ) : paymentMethod === "balance" ? (
                  <>
                    {L("确认扣款并提交订单", "Confirm & submit order")}
                    <ArrowRight size={15} />
                  </>
                ) : (
                  <>
                    {L("付款完成,提交订单", "I've paid — submit order")}
                    <ArrowRight size={15} />
                  </>
                )}
              </button>
            </section>
          </div>
        )}

        {step === "done" && (
          <section className="checkout-card checkout-done">
            <div className="checkout-done-icon">
              <CheckCircle2 size={56} />
            </div>
            <h2>{L("订单已提交", "Order submitted")}</h2>
            <p>{L("我们将在 10 分钟内联系您，订单确认邮件已发送至您的邮箱,请保持邮箱及联系方式畅通", "We'll reach out within 10 minutes. A confirmation email has been sent — please keep your email and contact reachable.")}</p>

            {orderResults[0] && (
              <div className="order-result-single">
                <div className="order-result-head">
                  <span>{L("订单号", "Order ID")}</span>
                  <code>{orderResults[0].orderId}</code>
                </div>
                <div className="order-result-items">
                  {orderResults[0].items.map((it) => {
                    const orderId = orderResults[0].orderId;
                    return (
                      <div key={it.service} className="order-result-item">
                        <div className="order-result-item-head">
                          <strong>{it.label}</strong>
                          <span>¥{it.amount}</span>
                        </div>
                        {it.subscriptionLinks && (
                          <div className="subscription-links">
                            <div className="subscription-link-row">
                              <a href={it.subscriptionLinks} target="_blank" rel="noopener noreferrer">
                                <strong>{L("订阅链接:", "Subscription link:")}</strong>
                                <span>{it.subscriptionLinks}</span>
                              </a>
                              <button
                                type="button"
                                className="subscription-copy-btn"
                                onClick={() => handleCopy(it.subscriptionLinks, `sub-${orderId}-${it.service}`)}
                              >
                                <Copy size={14} />
                                {copiedKey === `sub-${orderId}-${it.service}` ? L("已复制", "Copied") : L("复制", "Copy")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="order-result-paid">
                  <span>{L("实付", "Paid")}</span>
                  <b>{orderResults[0].paidCurrency === "CODE" ? L("服务兑换码", "Service code") : orderResults[0].paidCurrency === "USDT" ? `${orderResults[0].paidAmount} USDT` : `¥${orderResults[0].paidAmount}`}</b>
                </div>
              </div>
            )}

            <div className="checkout-done-actions">
              <Link href="/shop" className="primary-btn primary-btn-lg">
                {L("继续选购", "Keep shopping")}
              </Link>
              <Link href="/service-center#order-query" className="secondary-btn">
                {L("查询订单状态", "Track order")}
              </Link>
            </div>
          </section>
        )}
      </main>

      <FloatingSupport />

      {authModal && (
        <div
          className="auth-modal-mask"
          onClick={() => {
            if (!authBusy && !authSessionPending) {
              setAuthModal(null);
            }
          }}
        >
          <div className="auth-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={L("账户登录", "Account")}>
            <div className="auth-modal-head">
              {authSessionPending ? (
                <div className="auth-modal-title">{L("确认登录状态", "Verify session")}</div>
              ) : authModal === "login" || authModal === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authModal === "login" ? " active" : ""}`} onClick={() => setAuthModal("login")} disabled={authBusy}>{L("登录", "Sign in")}</button>
                  <button type="button" className={`auth-tab register-tab${authModal === "register" ? " active" : ""}`} onClick={() => setAuthModal("register")} disabled={authBusy}>
                    {L("注册", "Sign up")}
                    <span className="auth-tab-tip">{L("立减¥8.88", "¥8.88 off")}</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">
                  {authModal === "forgot" ? L("找回密码", "Reset password") : L("重置密码", "Set new password")}
                </div>
              )}
              <button
                type="button"
                className="auth-close"
                onClick={() => {
                  if (!authBusy && !authSessionPending) {
                    setAuthModal(null);
                  }
                }}
                disabled={authBusy || authSessionPending}
              >
                <X size={18} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doCheckoutAuth}>
              <label className="auth-field">
                <span>{L("邮箱", "Email")}</span>
                <input
                  type="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                  placeholder="your@email.com"
                  autoComplete="email"
                  readOnly={authModal === "reset"}
                  disabled={authBusy || authSessionPending}
                  required
                />
              </label>

              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field">
                  <span>{L("密码", "Password")}{authModal === "register" && L(" (6-64 位)", " (6-64 chars)")}</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                    placeholder={authModal === "register" ? L("设置一个密码", "Create a password") : L("登录密码", "Your password")}
                    autoComplete={authModal === "register" ? "new-password" : "current-password"}
                    minLength={6}
                    disabled={authSessionPending}
                    required
                  />
                </label>
              )}

              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>{L("邮箱验证码", "Email code")}</span>
                    <input
                      value={authForm.code}
                      onChange={(e) => setAuthForm({ ...authForm, code: e.target.value.replace(/\D/g, "") })}
                      placeholder={L("6 位数字验证码", "6-digit code")}
                      inputMode="numeric"
                      disabled={authSessionPending}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>{L("新密码", "New password")}</span>
                    <input
                      type="password"
                      value={authForm.newPassword}
                      onChange={(e) => setAuthForm({ ...authForm, newPassword: e.target.value })}
                      placeholder={L("设置新的登录密码", "Set a new password")}
                      minLength={6}
                      disabled={authSessionPending}
                      required
                    />
                  </label>
                </>
              )}

              {authModal === "register" && (
                <label className="auth-field auth-captcha">
                  <span>{L("验证码", "Captcha")}</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-control">
                      <ShieldCheck size={16} />
                      <input
                        value={authForm.captchaAnswer}
                        onChange={(e) => setAuthForm({ ...authForm, captchaAnswer: e.target.value.replace(/\s+/g, "").slice(0, 4) })}
                        placeholder={L("验证码", "Captcha")}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        disabled={authSessionPending}
                        required
                      />
                    </div>
                    <button type="button" className="auth-captcha-image" onClick={() => refreshAuthCaptcha(true)} disabled={authBusy || authSessionPending || authCaptcha.loading} aria-label={L("刷新验证码", "Refresh captcha")}>
                      {authCaptcha.image && !authCaptcha.loading ? <img src={authCaptcha.image} alt={L("验证码", "Captcha")} /> : <LoaderCircle size={18} className="spin-icon" />}
                      <span><RefreshCw size={12} /></span>
                    </button>
                  </div>
                  {authCaptcha.error && <em className="auth-captcha-error">{authCaptcha.error}</em>}
                </label>
              )}

              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}

              <button type="submit" className="auth-submit" disabled={authBusy || (!authSessionPending && authModal === "register" && (authCaptcha.loading || !authCaptcha.token))}>
                {authBusy ? (
                  <><LoaderCircle size={15} className="spin-icon" />{L("处理中...", "Processing...")}</>
                ) : authSessionPending ? L("只重试确认登录状态", "Retry session verification only")
                  : authModal === "login" ? L("登录", "Sign in")
                  : authModal === "register" ? L("注册并登录", "Sign up & sign in")
                  : authModal === "forgot" ? L("发送邮箱验证码", "Send code")
                  : L("重置密码并登录", "Reset & sign in")}
              </button>

              {(authModal === "login" || authModal === "register") && (
                <div className="auth-divider"><span>{L("或使用", "or")}</span></div>
              )}

              {(authModal === "login" || authModal === "register") && (
                <div className="oauth-login-grid bottom">
                  <a
                    href={authBusy || authSessionPending ? undefined : GOOGLE_OAUTH_START}
                    tabIndex={authBusy || authSessionPending ? -1 : undefined}
                    className="oauth-login-btn"
                    aria-disabled={authBusy || authSessionPending}
                    onClick={(event) => authBusy || authSessionPending ? event.preventDefault() : handleGoogleOAuthStart(event)}
                  ><GoogleIcon />{L("Google 登录", "Sign in with Google")}</a>
                </div>
              )}

              {!authSessionPending && <div className="auth-hints">
                {authModal === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")} disabled={authBusy}>{L("忘记密码?", "Forgot password?")}</button>
                    <span className="auth-hint">{L("还没账号?", "No account?")} <button type="button" className="auth-switch" onClick={() => setAuthModal("register")} disabled={authBusy}>{L("立即注册", "Sign up")}</button></span>
                  </>
                )}
                {authModal === "register" && (
                  <span className="auth-hint">{L("已有账号?", "Have an account?")} <button type="button" className="auth-switch" onClick={() => setAuthModal("login")} disabled={authBusy}>{L("去登录", "Sign in")}</button></span>
                )}
                {authModal === "forgot" && (
                  <button type="button" className="auth-switch" onClick={() => setAuthModal("login")} disabled={authBusy}>{L("返回登录", "Back to sign in")}</button>
                )}
                {authModal === "reset" && (
                  <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")} disabled={authBusy}>{L("重新发送验证码", "Resend code")}</button>
                )}
              </div>}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
