"use client";

import { useEffect, useState } from "react";
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
  USDT_ADDRESS,
  USDT_RATE,
  useCart,
  copyText,
  bundleDiscountRate,
  bundleDiscountLabel,
  cartSubtotalCny,
  cartFinalCny,
  cartFinalUsdt,
  validUsername,
  validEmail,
  productNeedsAccountPassword,
  subscriptionLinks,
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

const CHECKOUT_DRAFT_KEY = "liumeiti:checkout-draft:v2";
const CHECKOUT_PENDING_KEY = "liumeiti:checkout-pending:v1";
const CHECKOUT_DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

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

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, cartPlans, hydrated, removeFromCart, replaceCart, clearCart, setCartPlan } = useCart();
  const [step, setStep] = useState("form");
  const [form, setForm] = useState(blankCheckoutForm);
  const [paymentMethod, setPaymentMethod] = useState("alipay");
  const [paymentAdjustment, setPaymentAdjustment] = useState(0);
  const [paymentQuoteToken, setPaymentQuoteToken] = useState("");
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [orderResults, setOrderResults] = useState([]);
  const [authedUser, setAuthedUser] = useState(null); // {email, balance} | null
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register" | "forgot" | "reset"
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ token: "", image: "", loading: false, error: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [redeemMode, setRedeemMode] = useState({ loading: true, code: "", info: null });
  const [urlPlans, setUrlPlans] = useState({});
  const [draftReady, setDraftReady] = useState(false);

  async function refreshAccountState(isCancelled = () => false) {
    try {
      const [balanceRes, meRes] = await Promise.all([
        fetch("/api/auth/balance", { credentials: "same-origin" }),
        fetch("/api/auth/me", { credentials: "same-origin" }),
      ]);
      const balanceData = balanceRes.ok ? await balanceRes.json() : null;
      const meData = meRes.ok ? await meRes.json() : null;
      if (isCancelled()) return { ok: false, boughtTrial: false };
      if (balanceData && balanceData.ok) {
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
          email: balanceData.email,
          balance: Number(balanceData.balance || 0),
          coupons: balanceData.coupons || [],
          orders,
        });
        setForm((cur) => cur.email ? cur : { ...cur, email: balanceData.email });
        return { ok: true, boughtTrial, email: balanceData.email };
      }
      setAuthedUser(null);
      return { ok: false, boughtTrial: false };
    } catch (e) {
      return { ok: false, boughtTrial: false };
    }
  }

  // Pre-fill email + load balance for logged-in user
  useEffect(() => {
    let cancelled = false;
    refreshAccountState(() => cancelled);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (authModal) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [authModal]);

  async function refreshAuthCaptcha(clearAnswer = true) {
    setAuthCaptcha((cur) => ({ ...cur, loading: true, error: "" }));
    if (clearAnswer) setAuthForm((f) => ({ ...f, captchaAnswer: "" }));
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token || !data.image) throw new Error(data.message || "验证码加载失败");
      setAuthCaptcha({ token: data.token, image: data.image, loading: false, error: "" });
    } catch {
      setAuthCaptcha({ token: "", image: "", loading: false, error: "验证码加载失败，请点击刷新" });
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
          setStatus({ type: "error", message: data.message || "服务兑换码无效、已使用或已作废" });
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
        setStatus({ type: "error", message: "兑换码识别失败,请稍后再试" });
        setRedeemMode({ loading: false, code, info: null });
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("redeem")) return;
    const rawItems = String(params.get("items") || "");
    if (!rawItems) return;
    const valid = new Set(PRODUCTS.map((item) => item.key));
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
      const rawPending = window.localStorage.getItem(CHECKOUT_PENDING_KEY);
      const rawDraft = window.localStorage.getItem(CHECKOUT_DRAFT_KEY);
      const saved = rawPending ? JSON.parse(rawPending) : rawDraft ? JSON.parse(rawDraft) : null;
      if (saved && Date.now() - Number(saved.createdAt || 0) < CHECKOUT_DRAFT_MAX_AGE) {
        if (saved.form && typeof saved.form === "object") {
          const savedFields = { ...((saved.form && saved.form.fields) || {}) };
          urlKeys.forEach((key) => {
            if (!hasProductPlans(key)) return;
            const nextField = { ...(savedFields[key] || {}) };
            if (explicitPlans[key]) nextField.plan = explicitPlans[key];
            else delete nextField.plan;
            savedFields[key] = nextField;
          });
          setForm((current) => ({
            ...current,
            ...saved.form,
            fields: { ...(current.fields || {}), ...savedFields },
          }));
        }
        if (["alipay", "usdt", "balance"].includes(saved.paymentMethod)) {
          setPaymentMethod(saved.paymentMethod);
        }
        if (!hasRedeem && !hasItems && cart.length === 0 && Array.isArray(saved.cart)) {
          const valid = new Set(PRODUCTS.map((item) => item.key));
          const keys = saved.cart.filter((key) => valid.has(key));
          if (keys.length > 0) replaceCart(keys);
        }
      }
    } catch (e) {
      try {
        window.localStorage.removeItem(CHECKOUT_PENDING_KEY);
        window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
      } catch (ignore) {}
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

  const cartItems = cart.map((key) => PRODUCTS.find((p) => p.key === key)).filter(Boolean);
  const cartCount = cartItems.length;
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
  const finalUsdt = Math.round((finalCny * 0.9 / USDT_RATE) * 100) / 100;
  const savings = subtotal - bundleFinalCny;

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

  async function doCheckoutAuth(e) {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      let endpoint = authModal;
      let payload;
      if (authModal === "login") {
        payload = {
          email: authForm.email.trim(),
          password: authForm.password,
        };
      } else if (authModal === "register") {
        payload = {
          email: authForm.email.trim(),
          password: authForm.password,
          captchaToken: authCaptcha.token,
          captchaAnswer: authForm.captchaAnswer.trim(),
          inviteCode: storedInviteCode(),
        };
      } else if (authModal === "forgot") {
        payload = { email: authForm.email.trim() };
      } else if (authModal === "reset") {
        payload = {
          email: authForm.email.trim(),
          code: authForm.code.trim(),
          newPassword: authForm.newPassword,
        };
      }

      const res = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (authModal === "forgot") {
        setAuthNotice("验证码已发送至邮箱。请查看收件箱(或垃圾邮件)");
        setAuthModal("reset");
        setAuthForm((f) => ({ ...f, code: "", newPassword: "" }));
        return;
      }

      if (data.ok) {
        const account = await refreshAccountState();
        setAuthModal(null);
      } else {
        const msg = {
          captcha_failed: "验证码错误，请重新输入",
          email_taken: "该邮箱已注册",
          invalid_email: "邮箱格式错误",
          password_length: "密码 6-64 位",
          invalid_credentials: "邮箱或密码错误",
          invalid_code: "验证码格式错误(6 位数字)",
          code_invalid_or_expired: "验证码错误或已过期",
          user_not_found: "该邮箱未注册",
        }[data.error] || data.error || "操作失败";
        if (authModal === "register" && data.error === "captcha_failed") refreshAuthCaptcha(true);
        setAuthError(msg);
      }
    } catch (error) {
      setAuthError("网络错误");
    } finally {
      setAuthBusy(false);
    }
  }

  // Contact field is required only when cart includes products with needsContact (Spotify)
  const contactRequired = cartItems.some((p) => p.key === "spotify");
  const checkoutReady = hydrated && !redeemMode.loading && draftReady;

  function validateForm() {
    if (cartCount === 0) return "购物车为空,请先选购商品";
    if (!validEmail(form.email)) {
      return "请填写有效的邮箱地址,客服将通过邮箱发送订单与开通信息";
    }
    if (contactRequired && !form.contact.trim()) {
      return "Spotify 订单需要填写联系方式,客服会通过此方式联系您";
    }
    for (const p of cartItems) {
      const f = form.fields[p.key] || {};
      if (productNeedsAccountPassword(p) && (!f.account?.trim() || !f.password?.trim())) {
        return `请为「${p.title}」填写需要开通的账号和密码`;
      }
    }
    return "";
  }

  async function goPay(event) {
    event.preventDefault();
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
    setPaymentQuoteToken("");
    setPaymentAdjustment(0);
    if (paymentMethod === "alipay" && finalCny > 0) {
      setSubmitting(true);
      setStatus({ type: "info", message: "正在生成付款金额..." });
      try {
        const response = await fetch("/api/order-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentMethod: "alipay" }),
        });
        const quote = await response.json();
        if (!quote.ok) throw new Error(quote.message || quote.error || "payment_quote_failed");
        setPaymentAdjustment(Number(quote.paymentAdjustment || 0));
        setPaymentQuoteToken(String(quote.quoteToken || ""));
      } catch (quoteError) {
        setStatus({ type: "error", message: quoteError.message || "付款金额生成失败，请稍后再试" });
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    setStatus(null);
    setStep("pay");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitOrders() {
    if (submitting || cartCount === 0) return;
    const error = validateForm();
    if (error) {
      setStatus({ type: "error", message: error });
      setStep("form");
      return;
    }

    setSubmitting(true);
    setStatus({ type: "info", message: "正在提交订单..." });

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
      const payload = {
        email: form.email.trim(),
        contact: form.contact.trim(),
        remark: form.remark.trim(),
        paymentMethod,
        paymentQuoteToken: paymentMethod === "alipay" ? paymentQuoteToken : "",
        redeemCode: serviceRedeemActive ? redeemMode.code : "",
        inviteCode: storedInviteCode(),
        items,
      };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CHECKOUT_PENDING_KEY, JSON.stringify({
          createdAt: Date.now(),
          form,
          paymentMethod,
          cart,
          payload,
        }));
      }
      const response = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data.ok) {
        const errorMessage = data.message || data.error || "submit_failed";
        throw new Error(errorMessage);
      }

      setOrderResults([{
        orderId: data.orderId,
        items: data.items || [],
        paidAmount: data.paidAmount,
        paidCurrency: data.paidCurrency,
        paymentMethod: data.paymentMethod || (serviceRedeemActive ? "redeem" : paymentMethod),
      }]);
      setStep("done");
      setStatus({ type: "success", message: "订单已成功提交" });
      clearCart();
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(CHECKOUT_PENDING_KEY);
        window.localStorage.removeItem(CHECKOUT_DRAFT_KEY);
      }
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus({ type: "error", message: `${error.message || "订单提交失败"}，已保留填写内容，可稍后重试或联系在线客服处理` });
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
            <img src="/logo.png" alt="冒央会社" className="checkout-logo" />
          </Link>
          <div className="checkout-secure">
            <Lock size={13} />
            安全结算
          </div>
        </header>
        <div className="checkout-empty checkout-loading-state">
          <LoaderCircle size={46} className="checkout-empty-icon spin-icon" />
          <h2>正在恢复订单</h2>
          <p>正在恢复未完成订单</p>
        </div>
        <FloatingSupport />
      </div>
    );
  }

  // Empty cart state
  if (checkoutReady && cartCount === 0 && step !== "done") {
    return (
      <div className="checkout-page">
        <header className="checkout-header">
          <Link href="/shop" className="checkout-back">
            <ArrowLeft size={16} />
            <img src="/logo.png" alt="冒央会社" className="checkout-logo" />
          </Link>
          <div className="checkout-secure">
            <Lock size={13} />
            安全结算
          </div>
        </header>
        <div className="checkout-empty">
          <ShoppingCart size={64} className="checkout-empty-icon" />
          <h2>购物车为空</h2>
          <p>先选择需要开通的服务</p>
          <Link href="/shop" className="primary-btn primary-btn-lg">
            <ArrowLeft size={15} />
            前往选购
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
          <img src="/logo.png" alt="冒央会社" className="checkout-logo" />
        </Link>
        <div className="checkout-secure">
          <Lock size={13} />
          {serviceRedeemActive ? "兑换码免支付" : paymentMethod === "usdt" ? "USDT-TRC20 安全结算" : "支付宝担保结算"}
        </div>
      </header>

      <main className="checkout-main">
        <div className="checkout-stepper">
          {["填写订单", "扫码付款", "提交完成"].map((label, idx) => {
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
          <div className={`checkout-alert ${status.type}`}>{status.message}</div>
        )}

        {serviceRedeemActive && (
          <div className="checkout-alert success">
            服务兑换码已识别: {(redeemMode.info.services || []).map((item) => item.label).join(" + ")}，按页面提示填写后可直接提交,无需支付
          </div>
        )}

        {step === "form" && (
          <form className="checkout-grid" onSubmit={goPay}>
            <div className="checkout-left">
              {/* Trust strip */}
              <div className="checkout-trust">
                <span><Lock size={12} />信息加密</span>
                <span><ShieldCheck size={12} />担保支付</span>
                <span><Zap size={12} />10 分钟内开通</span>
                <span><RefreshCw size={12} />7 天内可退</span>
              </div>

              {/* Cart items */}
              <section className="checkout-card">
                <div className="checkout-card-head">
                  <h3>已选商品 <em>{cartCount}</em></h3>
                  {!serviceRedeemActive && <Link href="/shop" className="text-link">+ 继续选购</Link>}
                </div>
                <div className="cart-items-grid">
                  {cartItems.map((item) => {
                    const itemAmount = productItemAmount(item, planMap[item.key]);
                    const planInfo = hasProductPlans(item.key) ? getProductPlan(item.key, planMap[item.key]) : null;
                    return (
                      <div key={item.key} className="cart-tile">
                        {!serviceRedeemActive && (
                          <button
                            type="button"
                            className="cart-tile-remove"
                            onClick={() => removeFromCart(item.key)}
                            aria-label={`移除 ${item.title}`}
                            title={`移除 ${item.title}`}
                          >
                            <X size={11} strokeWidth={3} />
                          </button>
                        )}
                        <img src={item.image} alt={item.title} className="cart-tile-img" />
                        <div className="cart-tile-name">
                          {item.title}
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
                    <h3>开通信息</h3>
                  </div>
                  <div className="checkout-product-fields">
                    {cartItems.map((p) => {
                      const f = form.fields[p.key] || {};
                      if (productNeedsAccountPassword(p)) {
                        return (
                          <div key={p.key} className="order-field-grid">
                            <label className="order-field">
                              <span>{p.title} · 账号/邮箱</span>
                              <input
                                value={f.account || ""}
                                onChange={(e) => updateProductField(p.key, "account", e.target.value)}
                                placeholder="需要开通的账号"
                                autoComplete="username"
                                required
                              />
                            </label>
                            <label className="order-field">
                              <span className="order-field-label-row">
                                <span>{p.title} · 密码</span>
                                {p.key === "spotify" && (
                                  <a
                                    className="order-field-help-link"
                                    href="https://accounts.spotify.com/en/password-reset"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    忘记 Spotify 密码？点击找回
                                  </a>
                                )}
                              </span>
                              <div className="password-input-wrap">
                                <input
                                  type={passwordVisible ? "text" : "password"}
                                  value={f.password || ""}
                                  onChange={(e) => updateProductField(p.key, "password", e.target.value)}
                                  placeholder="账号密码"
                                  autoComplete="current-password"
                                  required
                                />
                                <button
                                  type="button"
                                  className="password-eye-btn"
                                  onClick={() => setPasswordVisible((v) => !v)}
                                  aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
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
                  <h3>联系方式</h3>
                </div>
                <label className="order-field">
                  <span>邮箱 <em className="field-required">*</em></span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => updateField("email", e.target.value)}
                    placeholder="接收订单通知，也可用于后续查询"
                    autoComplete="email"
                    inputMode="email"
                    required
                  />
                </label>
                <label className="order-field">
                  <span>
                    QQ / 微信 / WhatsApp / Telegram
                    {contactRequired ? <em className="field-required">*</em> : <em className="field-optional">(选填)</em>}
                  </span>
                  <input
                    value={form.contact}
                    onChange={(e) => updateField("contact", e.target.value)}
                    placeholder={contactRequired
                      ? "Spotify 订单需要,方便客服协助开通"
                      : "可选 — 通常通过邮箱沟通"}
                    autoComplete="tel"
                    required={contactRequired}
                  />
                </label>
                <label className="order-field">
                  <span>备注(非必填)</span>
                  <textarea
                    value={form.remark}
                    onChange={(e) => updateField("remark", e.target.value)}
                    placeholder="特殊需求或付款备注等"
                    rows={2}
                  />
                </label>
              </section>
            </div>

            <aside className="checkout-right">
              <section className="checkout-card sticky-summary">
                <div className="checkout-card-head">
                  <h3>订单总览</h3>
                </div>

                <div className="cart-summary">
                  <div className="cart-summary-row">
                    <span>商品总价</span>
                    <b>¥{subtotal}</b>
                  </div>
                  {discountRate > 0 && (
                    <div className="cart-summary-row discount">
                      <span>组合优惠 · {bundleDiscountLabel(cartCount)}</span>
                      <b>−¥{savings}</b>
                    </div>
                  )}
                  <div className="cart-summary-row total">
                    <span>组合折后</span>
                    <b>¥{bundleFinalCny}</b>
                  </div>
                  {couponDiscount > 0 && (
                    <div className="cart-summary-row coupon">
                      <span>{activeCoupon?.title || "优惠券自动抵扣"}</span>
                      <b>−¥{couponDiscount.toFixed(2)}</b>
                    </div>
                  )}
                  {serviceRedeemActive && (
                    <div className="cart-summary-row coupon">
                      <span>服务兑换码抵扣</span>
                      <b>−¥{bundleFinalCny.toFixed(2)}</b>
                    </div>
                  )}
                  <div className="cart-summary-row total">
                    <span>应付总额</span>
                    <b>¥{serviceRedeemActive ? "0.00" : finalCny.toFixed(2)}</b>
                  </div>
                  {cartCount === 1 && (
                    <div className="cart-bundle-hint">
                      <Gift size={12} />再加 1 件享 9.5 折,加满 3 件享 9 折
                    </div>
                  )}
                  {cartCount === 2 && (
                    <div className="cart-bundle-hint">
                      <Gift size={12} />再加 1 件升级到 9 折
                    </div>
                  )}
                </div>

                {/* Payment method */}
                {!serviceRedeemActive && <div className="payment-method-group">
                  <div className="payment-method-label">选择支付方式</div>
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
                        <small>担保支付 · 即时到账</small>
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
                        <strong>{finalUsdt} USDT</strong>
                        <small>9 折优惠 · TRC20</small>
                      </div>
                      <div className="payment-method-badge">9 折</div>
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
                          <strong>账户余额支付</strong>
                          <small>余额 ¥{authedUser.balance.toFixed(2)}{authedUser.balance < finalCny ? " · 余额不足" : " · 一键扣款"}</small>
                        </div>
                      </label>
                    )}
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon wechat"><WechatIcon /></div>
                      <div className="payment-method-detail">
                        <strong>微信支付</strong>
                        <small>暂未开放,请选择其他方式</small>
                      </div>
                    </label>
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon card"><CardPayIcon /></div>
                      <div className="payment-method-detail">
                        <strong>Mastercard / Visa</strong>
                        <small>暂未开放,请选择其他方式</small>
                      </div>
                    </label>
                  </div>
                </div>}

                <button type="submit" className="primary-btn primary-btn-lg checkout-submit-btn" disabled={cartCount === 0 || submitting}>
                  {serviceRedeemActive ? "确认兑换并提交订单" : `前往支付 · ${paymentMethod === "usdt" ? `${finalUsdt} USDT` : `¥${finalCny}`}`}
                  <ArrowRight size={15} />
                </button>
              </section>
            </aside>

            {/* Mobile sticky bottom CTA */}
            <div className="checkout-mobile-cta">
              <div className="checkout-mobile-cta-info">
                <small>{serviceRedeemActive ? "服务兑换码" : paymentMethod === "usdt" ? "USDT-TRC20" : "支付宝"}</small>
                <b>{serviceRedeemActive ? "免支付" : paymentMethod === "usdt" ? `${finalUsdt} USDT` : `¥${finalCny}`}</b>
              </div>
              <button type="submit" className="primary-btn checkout-mobile-cta-btn" disabled={cartCount === 0 || submitting}>
                {serviceRedeemActive ? "提交兑换" : "前往支付"}
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
                  {paymentMethod === "usdt" ? "USDT · TRC20" : paymentMethod === "balance" ? "账户余额" : "支付宝"}
                </span>
                <button
                  type="button"
                  className="pay-method-switch"
                  onClick={() => { setStep("form"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  disabled={submitting}
                >
                  切换方式
                </button>
              </div>

              {/* 应付金额 - 大字 */}
              <div className="pay-amount-prominent">
                <span>{paymentMethod === "balance" ? "余额扣款" : "应付金额"}</span>
                {paymentMethod === "usdt" ? (
                  <>
                    <b>{finalUsdt} <em>USDT</em></b>
                    <small>¥{finalCny}(支付宝应付)× 0.9 ÷ {USDT_RATE}</small>
                  </>
                ) : paymentMethod === "alipay" ? (
                  <>
                    <b>¥{alipayPayableCny.toFixed(2)}</b>
                    <small>付款核对尾差 {paymentAdjustment > 0 ? "+" : ""}¥{paymentAdjustment.toFixed(2)}，商品金额 ¥{finalCny.toFixed(2)}</small>
                  </>
                ) : (
                  <b>¥{finalCny}</b>
                )}
              </div>

              {/* 重要提示 */}
              <div className="pay-tip">
                {paymentMethod === "usdt"
                  ? `请使用 TRON (TRC20) 网络转账精确金额 ${finalUsdt} USDT 到下方地址,付款完成后请记得返回本页面点击「付款完成」按钮提交订单`
                  : paymentMethod === "balance"
                  ? `点击下方「确认扣款并提交订单」后，将从您的账户余额(¥${authedUser?.balance.toFixed(2) || "0.00"})扣除 ¥${finalCny},随后提交订单`
                  : "请按上方精确金额完成支付宝付款，尾差用于快速核对订单；付款完成后返回本页面点击「付款完成」提交订单"}
              </div>

              {/* QR 二维码 — 只对支付宝/USDT 显示,余额支付不需要 */}
              {paymentMethod !== "balance" && (
                <div className="qr-display compact">
                  <img
                    src={paymentMethod === "usdt" ? "/payment/usdt.png" : (cartItems[0]?.qrImage || "/payment/alipay.jpg")}
                    alt={paymentMethod === "usdt" ? "USDT 收款码" : "支付宝收款码"}
                  />
                  <div className="qr-display-label">
                    {paymentMethod === "usdt" ? "TRC20 钱包扫一扫或复制下面地址转账" : "支付宝扫一扫"}
                  </div>
                </div>
              )}

              {/* USDT 地址 */}
              {paymentMethod === "usdt" && (
                <div className="usdt-address-box">
                  <div className="usdt-address-head">
                    <span>TRON / TRC20 收款地址</span>
                    <button
                      type="button"
                      className={`usdt-address-copy${copiedKey === "usdt-addr" ? " copied" : ""}`}
                      onClick={() => handleCopy(USDT_ADDRESS, "usdt-addr")}
                    >
                      <Copy size={12} />
                      {copiedKey === "usdt-addr" ? "已复制" : "复制地址"}
                    </button>
                  </div>
                  <code className="usdt-address-value">{USDT_ADDRESS}</code>
                </div>
              )}

              {/* 订单总览 - 折叠到底部 */}
              <details className="pay-summary-foldable">
                <summary>查看订单详情({cartCount} 件)</summary>
                <div className="checkout-cart-summary">
                  {cartItems.map((p) => {
                    const itemAmount = productItemAmount(p, planMap[p.key]);
                    const planInfo = hasProductPlans(p.key) ? getProductPlan(p.key, planMap[p.key]) : null;
                    return (
                      <div key={p.key} className="checkout-cart-row">
                        <span>{planInfo ? `${p.title} · ${planInfo.label}` : p.title}</span>
                        <b>¥{itemAmount}</b>
                      </div>
                    );
                  })}
                  {discountRate > 0 && (
                    <div className="checkout-cart-row discount">
                      <span>组合优惠 · {bundleDiscountLabel(cartCount)}</span>
                      <b>−¥{savings}</b>
                    </div>
                  )}
                  {couponDiscount > 0 && (
                    <div className="checkout-cart-row discount">
                      <span>{activeCoupon?.title || "优惠券自动抵扣"}</span>
                      <b>−¥{couponDiscount.toFixed(2)}</b>
                    </div>
                  )}
                </div>
              </details>

              {/* 提交按钮 */}
              <button
                type="button"
                className="primary-btn primary-btn-lg pay-submit-btn"
                onClick={submitOrders}
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <LoaderCircle size={15} className="spin-icon" />
                    正在提交
                  </>
                ) : paymentMethod === "balance" ? (
                  <>
                    确认扣款并提交订单
                    <ArrowRight size={15} />
                  </>
                ) : (
                  <>
                    付款完成,提交订单
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
            <h2>订单已提交</h2>
            <p>我们将在 10 分钟内联系您，订单确认邮件已发送至您的邮箱,请保持邮箱及联系方式畅通</p>

            {orderResults[0] && (
              <div className="order-result-single">
                <div className="order-result-head">
                  <span>订单号</span>
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
                              <a href={it.subscriptionLinks.shadowrocket} target="_blank" rel="noopener noreferrer">
                                <strong>Shadowrocket 订阅:</strong>
                                <span>{it.subscriptionLinks.shadowrocket}</span>
                              </a>
                              <button
                                type="button"
                                className="subscription-copy-btn"
                                onClick={() => handleCopy(it.subscriptionLinks.shadowrocket, `sr-${orderId}-${it.service}`)}
                              >
                                <Copy size={14} />
                                {copiedKey === `sr-${orderId}-${it.service}` ? "已复制" : "复制"}
                              </button>
                            </div>
                            <div className="subscription-link-row">
                              <a href={it.subscriptionLinks.clash} target="_blank" rel="noopener noreferrer">
                                <strong>Clash 订阅:</strong>
                                <span>{it.subscriptionLinks.clash}</span>
                              </a>
                              <button
                                type="button"
                                className="subscription-copy-btn"
                                onClick={() => handleCopy(it.subscriptionLinks.clash, `cl-${orderId}-${it.service}`)}
                              >
                                <Copy size={14} />
                                {copiedKey === `cl-${orderId}-${it.service}` ? "已复制" : "复制"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="order-result-paid">
                  <span>实付</span>
                  <b>{orderResults[0].paidCurrency === "CODE" ? "服务兑换码" : orderResults[0].paidCurrency === "USDT" ? `${orderResults[0].paidAmount} USDT` : `¥${orderResults[0].paidAmount}`}</b>
                </div>
              </div>
            )}

            <div className="checkout-done-actions">
              <Link href="/shop" className="primary-btn primary-btn-lg">
                继续选购
              </Link>
              <Link href="/service-center#order-query" className="secondary-btn">
                查询订单状态
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
            if (!authBusy) {
              setAuthModal(null);
            }
          }}
        >
          <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-modal-head">
              {authModal === "login" || authModal === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authModal === "login" ? " active" : ""}`} onClick={() => setAuthModal("login")}>登录</button>
                  <button type="button" className={`auth-tab register-tab${authModal === "register" ? " active" : ""}`} onClick={() => setAuthModal("register")}>
                    注册
                    <span className="auth-tab-tip">立减¥8.88</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">
                  {authModal === "forgot" ? "找回密码" : "重置密码"}
                </div>
              )}
              <button
                type="button"
                className="auth-close"
                onClick={() => {
                  if (!authBusy) {
                    setAuthModal(null);
                  }
                }}
              >
                <X size={18} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doCheckoutAuth}>
              <label className="auth-field">
                <span>邮箱</span>
                <input
                  type="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                  placeholder="your@email.com"
                  autoComplete="email"
                  readOnly={authModal === "reset"}
                  required
                />
              </label>

              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field">
                  <span>密码{authModal === "register" && " (6-64 位)"}</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                    placeholder={authModal === "register" ? "设置一个密码" : "登录密码"}
                    autoComplete={authModal === "register" ? "new-password" : "current-password"}
                    minLength={6}
                    required
                  />
                </label>
              )}

              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>邮箱验证码</span>
                    <input
                      value={authForm.code}
                      onChange={(e) => setAuthForm({ ...authForm, code: e.target.value.replace(/\D/g, "") })}
                      placeholder="6 位数字验证码"
                      inputMode="numeric"
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>新密码</span>
                    <input
                      type="password"
                      value={authForm.newPassword}
                      onChange={(e) => setAuthForm({ ...authForm, newPassword: e.target.value })}
                      placeholder="设置新的登录密码"
                      minLength={6}
                      required
                    />
                  </label>
                </>
              )}

              {authModal === "register" && (
                <label className="auth-field auth-captcha">
                  <span>验证码</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-control">
                      <ShieldCheck size={16} />
                      <input
                        value={authForm.captchaAnswer}
                        onChange={(e) => setAuthForm({ ...authForm, captchaAnswer: e.target.value.replace(/\s+/g, "").slice(0, 4) })}
                        placeholder="验证码"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        required
                      />
                    </div>
                    <button type="button" className="auth-captcha-image" onClick={() => refreshAuthCaptcha(true)} disabled={authCaptcha.loading} aria-label="刷新验证码">
                      {authCaptcha.image && !authCaptcha.loading ? <img src={authCaptcha.image} alt="验证码" /> : <LoaderCircle size={18} className="spin-icon" />}
                      <span><RefreshCw size={12} /></span>
                    </button>
                  </div>
                  {authCaptcha.error && <em className="auth-captcha-error">{authCaptcha.error}</em>}
                </label>
              )}

              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}

              <button type="submit" className="auth-submit" disabled={authBusy || (authModal === "register" && (authCaptcha.loading || !authCaptcha.token))}>
                {authBusy ? (
                  <><LoaderCircle size={15} className="spin-icon" />处理中...</>
                ) : authModal === "login" ? "登录"
                  : authModal === "register" ? "注册并登录"
                  : authModal === "forgot" ? "发送邮箱验证码"
                  : "重置密码并登录"}
              </button>

              {(authModal === "login" || authModal === "register") && (
                <div className="auth-divider"><span>或使用</span></div>
              )}

              {(authModal === "login" || authModal === "register") && (
                <div className="oauth-login-grid bottom">
                  <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />Google 登录</a>
                </div>
              )}

              <div className="auth-hints">
                {authModal === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>忘记密码?</button>
                    <span className="auth-hint">还没账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("register")}>立即注册</button></span>
                  </>
                )}
                {authModal === "register" && (
                  <span className="auth-hint">已有账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>去登录</button></span>
                )}
                {authModal === "forgot" && (
                  <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>返回登录</button>
                )}
                {authModal === "reset" && (
                  <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>重新发送验证码</button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
