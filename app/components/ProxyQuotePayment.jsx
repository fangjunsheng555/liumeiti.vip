"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  LoaderCircle,
  Lock,
  MailCheck,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import FloatingSupport from "./FloatingSupport";
import { copyText, useSiteSettingsState, usdtPaymentPresentation } from "../lib/store";
import { useLocale } from "./LocaleProvider";
import { isExplicitTerminalIdempotencyResponse } from "../lib/idempotency";
import { withCheckoutSubmissionCoordination } from "../lib/checkout-pending-journal";
import { clearSinglePendingOperation, prepareSinglePendingOperation } from "../lib/single-pending-journal";
import { clientFetch as fetch } from "../lib/client-fetch";

async function quoteTokenDigest(token) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
    throw new Error("quote_payment_token_binding_unavailable");
  }
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function quoteLoadMessage(locale, status, code) {
  const L = (zh, en) => (locale === "en" ? en : zh);
  const known = {
    invalid_payment_link: L("付款链接无效，请打开最新邮件中的链接", "This payment link is invalid. Open the latest link from your email."),
    quote_expired: L("本次报价已失效。重新报价后，我们会向您发送新的付款邮件。", "This quote has expired. We will email a new payment link after the quote is renewed."),
    order_not_found: L("未找到订单，请核对付款链接", "Order not found. Check the payment link."),
    order_invalid: L("订单已失效，请联系在线客服", "This order is no longer valid. Contact support."),
    quote_not_ready: L("报价尚未生效，请联系在线客服", "The quote isn't active yet. Contact support."),
  }[code];
  if (known) return known;
  if (status === 401) return L("付款链接已失效，请打开最新邮件中的链接后重试", "This payment link has expired. Open the latest email link and retry.");
  if (status === 403) return L("当前付款链接无权访问此报价，请打开最新邮件中的链接", "This payment link cannot access the quote. Open the latest email link.");
  if (status === 409) return L("报价状态已更新，请重新读取", "The quote changed. Reload it before continuing.");
  if ([500, 503].includes(status)) return L("报价服务暂时不可用，请稍后重试", "The quote service is temporarily unavailable. Please retry later.");
  return L("暂时无法读取报价，请重试", "The quote couldn't be loaded. Please retry.");
}

function loadFailureMessage(locale, error, subject) {
  const L = (zh, en) => (locale === "en" ? en : zh);
  if (error?.name === "TimeoutError" || error?.code === "request_timeout") {
    return subject === "rate"
      ? L("USDT 汇率读取超时，请重试", "The USDT rate request timed out. Please retry.")
      : L("报价读取超时，请重试", "The quote request timed out. Please retry.");
  }
  if (error?.code === "invalid_json") return L("服务器响应异常，请重试", "The server returned an invalid response. Please retry.");
  return subject === "rate"
    ? L("USDT 汇率读取失败，请检查网络后重试", "The USDT rate couldn't be loaded. Check your connection and retry.")
    : L("报价读取失败，请检查网络后重试", "The quote couldn't be loaded. Check your connection and retry.");
}

export default function ProxyQuotePayment({ orderId }) {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const settingsState = useSiteSettingsState();
  const settings = settingsState.settings;
  const usdtPresentation = usdtPaymentPresentation(locale);
  const [token, setToken] = useState("");
  const [order, setOrder] = useState(null);
  const [state, setState] = useState({ loading: true, error: "", errorCode: "", notice: "" });
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [paymentUncertain, setPaymentUncertain] = useState(false);
  const [paymentReadyAt, setPaymentReadyAt] = useState(0);
  const [payMethod, setPayMethod] = useState("alipay"); // alipay | usdt
  const [usdtRate, setUsdtRate] = useState(0);
  const [rateState, setRateState] = useState({ loading: true, error: "" });
  const [copied, setCopied] = useState(false);
  const [qrReady, setQrReady] = useState(false);
  const [qrError, setQrError] = useState(false);
  const [qrReloadKey, setQrReloadKey] = useState(0);
  const paymentRequestRef = useRef(null);
  const rateRequestRef = useRef(0);
  const alipayQrSrc = settingsState.ready ? settings.payment.alipayQr : "";
  const usdtQrSrc = settingsState.ready ? settings.payment.usdtQr : "";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = `lm:idempotency:quote-payment:${String(orderId || "").toUpperCase()}`;
    try {
      setPaymentUncertain(window.localStorage.getItem(storageKey) !== null);
    } catch {
      setPaymentUncertain(true);
    }
  }, [orderId]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const value = params.get("token") || "";
    setToken(value);
    setOrder(null);
    setState({ loading: true, error: "", errorCode: "", notice: "" });
    if (!value) {
      setState({ loading: false, error: L("付款链接不完整", "Payment link is incomplete"), errorCode: "invalid_payment_link", notice: "" });
      return () => { active = false; };
    }
    (async () => {
      try {
        const response = await fetch(`/api/quote-orders/${encodeURIComponent(orderId)}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${value}` },
        });
        let data = null;
        try { data = await response.json(); } catch {
          const error = new Error("invalid_json");
          error.code = "invalid_json";
          throw error;
        }
        if (!response.ok || !data?.ok) {
          const error = new Error(quoteLoadMessage(locale, response.status, data?.error));
          error.code = data?.error || `quote_http_${response.status}`;
          error.userMessage = true;
          throw error;
        }
        if (!data.order || typeof data.order !== "object") {
          const error = new Error("invalid_json");
          error.code = "invalid_json";
          throw error;
        }
        if (!active) return;
        setOrder(data.order);
        setState({ loading: false, error: "", errorCode: "", notice: "" });
      } catch (error) {
        if (!active) return;
        const message = error?.userMessage
          ? error.message
          : loadFailureMessage(locale, error, "quote");
        setState({ loading: false, error: message, errorCode: error?.code || "quote_load_failed", notice: "" });
      }
    })();
    return () => { active = false; };
  }, [locale, orderId, quoteAttempt]);

  // USDT 汇率(固定汇率优先,否则每日自动),用于展示 USDT 应付额
  const loadUsdtRate = useCallback(async () => {
    const requestId = ++rateRequestRef.current;
    setUsdtRate(0);
    setQrReady(false);
    setQrError(false);
    setPaymentReadyAt(0);
    setRateState({ loading: true, error: "" });
    try {
      const response = await fetch("/api/usdt-rate", { cache: "no-store" });
      let data = null;
      try { data = await response.json(); } catch {
        const error = new Error("invalid_json");
        error.code = "invalid_json";
        throw error;
      }
      const rate = Number(data?.rate);
      if (!response.ok || !data?.ok || !Number.isFinite(rate) || rate <= 0) {
        const message = response.status === 401
          ? L("登录状态已失效，请重新登录后读取 USDT 汇率", "Your session expired. Sign in before loading the USDT rate.")
          : response.status === 403
            ? L("暂时无权读取 USDT 汇率，请刷新页面后重试", "The USDT rate can't be accessed. Refresh and retry.")
            : response.status === 409
              ? L("USDT 汇率已更新，请重新读取", "The USDT rate changed. Reload it.")
              : [500, 503].includes(response.status)
                ? L("USDT 汇率服务暂时不可用，请稍后重试", "The USDT rate service is temporarily unavailable. Please retry later.")
                : L("USDT 汇率暂时不可用，请重试", "The USDT rate is unavailable. Please retry.");
        const error = new Error(message);
        error.code = `rate_http_${response.status}`;
        error.userMessage = true;
        throw error;
      }
      if (requestId !== rateRequestRef.current) return;
      setUsdtRate(rate);
      setRateState({ loading: false, error: "" });
    } catch (error) {
      if (requestId !== rateRequestRef.current) return;
      const message = error?.userMessage
        ? error.message
        : loadFailureMessage(locale, error, "rate");
      setRateState({ loading: false, error: message });
    } finally {
      if (requestId === rateRequestRef.current) {
        setRateState((current) => ({ ...current, loading: false }));
      }
    }
  }, [locale]);

  useEffect(() => {
    loadUsdtRate();
    return () => { rateRequestRef.current += 1; };
  }, [loadUsdtRate]);

  useEffect(() => {
    setQrReady(false);
    setQrError(false);
    setPaymentReadyAt(0);
    if (!settingsState.ready) return;
    if (typeof window === "undefined") return;
    [alipayQrSrc, usdtQrSrc].forEach((src) => {
      const image = new Image();
      image.src = src;
    });
  }, [settingsState.ready, alipayQrSrc, usdtQrSrc]);

  const quoteCny = Number(order?.quoteAmount || 0);
  const usdtDiscount = Number(settings.usdt.discount);
  const usdtAmount = usdtRate > 0 ? Math.round((quoteCny * usdtDiscount / usdtRate) * 100) / 100 : 0;
  const isUsdt = payMethod === "usdt";
  const rateReady = !isUsdt || (!rateState.loading && !rateState.error && usdtAmount > 0);
  const paymentUiReady = settingsState.ready && rateReady && !paymentUncertain;
  const paymentQrSrc = isUsdt ? usdtQrSrc : alipayQrSrc;

  function selectPaymentMethod(method) {
    if (!settingsState.ready || method === payMethod || submitting || paymentUncertain) return;
    setPayMethod(method);
    setQrReady(false);
    setQrError(false);
    setPaymentReadyAt(0);
    setState((current) => ({ ...current, error: "", errorCode: "", notice: "" }));
  }

  async function confirmPayment() {
    if (submitting || !token || !order || !settingsState.ready) return;
    if (!paymentReadyAt || Date.now() - paymentReadyAt < 5000) {
      setState((current) => ({ ...current, notice: L("请扫码完成付款，付款完成后再点击「付款完成」提交订单", "Please scan to pay first, then tap \"I've paid\" to submit the order") }));
      return;
    }
    setSubmitting(true);
    setState((current) => ({ ...current, notice: "" }));
    try {
      await withCheckoutSubmissionCoordination(async () => {
        const storageKey = `lm:idempotency:quote-payment:${String(orderId || "").toUpperCase()}`;
        const payload = {
          paymentMethod: payMethod,
          expectedRevision: Number(order.revision || 0),
        };
        // The bearer token stays out of persistent browser storage. Its
        // SHA-256 digest is part of the immutable journal identity, so the
        // live token used below is provably the same bearer value as the
        // original request (otherwise journal restore fails before fetch).
        const tokenHash = await quoteTokenDigest(token);
        const pending = prepareSinglePendingOperation(
          window.localStorage,
          storageKey,
          "quote-payment-submit",
          payload,
          { identity: { orderId: String(orderId || "").toUpperCase(), tokenHash } },
        );
        paymentRequestRef.current = pending;
        const operation = pending.idempotencyRequest;
        const response = await fetch(`/api/quote-orders/${encodeURIComponent(orderId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": operation.key },
          body: JSON.stringify({ token, ...pending.payload }),
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok || !data?.ok) {
          const terminalResponse = isExplicitTerminalIdempotencyResponse(response.status, data);
          if (terminalResponse) {
            clearSinglePendingOperation(window.localStorage, storageKey, operation.key);
            paymentRequestRef.current = null;
            setPaymentUncertain(false);
          }
          const message = {
            quote_expired: L("本次报价已失效。重新报价后，我们会向您发送新的付款邮件。", "This quote has expired. We will email a new payment link after the quote is renewed."),
            order_invalid: L("订单已失效", "This order is no longer valid"),
            invalid_payment_link: L("付款链接无效", "Invalid payment link"),
            payment_processing: L("付款信息正在提交，请稍后刷新订单状态", "Payment is being submitted. Check the order status shortly."),
            payment_method_conflict: L("该订单已按另一种付款方式提交，请刷新订单状态并联系客服核对", "This order was submitted with a different payment method. Refresh and contact support to verify it."),
            idempotency_conflict: L("待提交付款记录与当前内容不一致，请勿重复提交并联系客服核对", "The pending payment record conflicts with this request. Do not resubmit it; contact support."),
            usdt_rate_unavailable: L("暂时无法锁定 USDT 汇率，请勿转账并稍后重试", "The USDT rate cannot be locked right now. Do not transfer; try again later."),
          }[data?.error] || data?.error || L("提交失败，原付款请求已保留，请勿更换付款方式后重试", "Submission failed. The original payment request is preserved; do not switch methods before retrying.");
          const error = new Error(message);
          error.code = data?.error || "payment_submit_failed";
          error.terminal = terminalResponse;
          error.invalidatesQuote = [
            "quote_expired",
            "order_invalid",
            "invalid_payment_link",
            "payment_method_conflict",
          ].includes(error.code);
          throw error;
        }
        clearSinglePendingOperation(window.localStorage, storageKey, operation.key);
        paymentRequestRef.current = null;
        setPaymentUncertain(false);
        setOrder(data.order);
      });
    } catch (error) {
      const message = error?.message === "quote_payment_token_binding_unavailable"
        ? L("当前浏览器无法安全保存付款请求，请勿重复提交并更换受支持的浏览器", "This browser cannot safely bind the payment request. Do not resubmit it; use a supported browser.")
        : error.message;
      if (error?.invalidatesQuote) {
        setPaymentUncertain(false);
        setOrder(null);
        setQrReady(false);
        setQrError(false);
        setPaymentReadyAt(0);
      } else if (error?.terminal) {
        setPaymentUncertain(false);
      } else {
        setPaymentUncertain(true);
      }
      setState((current) => ({ ...current, error: message, errorCode: error.code || "payment_submit_failed" }));
    } finally {
      setSubmitting(false);
    }
  }

  const finished = order && ["received", "completed"].includes(order.status);

  return (
    <div className="checkout-page proxy-payment-page">
      <header className="checkout-header">
        <Link href="/" className="checkout-back"><ArrowLeft size={16} /><img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="checkout-logo" /></Link>
        <div className="checkout-secure"><Lock size={13} />{L("专属报价付款", "Secure quote payment")}</div>
      </header>
      <main className="checkout-main proxy-payment-main">
        <div className="checkout-stepper proxy-stepper">
          {[L("需求已提交", "Requested"), L("报价已完成", "Quoted"), finished ? L("付款已提交", "Submitted") : L("确认付款", "Payment")].map((label, index) => (
            <div key={label} className={`checkout-step${index < 2 || finished ? " done" : ""}${index === 2 && !finished ? " active" : ""}`}>
              <span className="checkout-step-num">{index < 2 || finished ? <CheckCircle2 size={14} /> : 3}</span><span className="checkout-step-label">{label}</span>
            </div>
          ))}
        </div>

        {state.loading ? (
          <section className="proxy-payment-state"><LoaderCircle size={38} className="spin-icon" /><h1>{L("正在读取报价", "Loading your quote")}</h1></section>
        ) : state.error && !order ? (
          <section className="proxy-payment-state error">
            <ShieldCheck size={38} />
            <h1>{state.errorCode === "quote_expired" ? L("本次报价已失效", "This quote has expired") : L("无法打开付款链接", "Can't open this payment link")}</h1>
            <p>{state.errorCode === "quote_expired" ? L("工作人员重新报价后，新的付款链接将发送至您的邮箱。", "After our team renews the quote, a new payment link will be sent to your email.") : state.error}</p>
            <div className="proxy-success-actions">
              <button type="button" className="primary-btn" onClick={() => setQuoteAttempt((current) => current + 1)}>{L("重试", "Retry")}</button>
              <Link href="/service-center#contact" className="secondary-btn">{L("联系客服", "Contact support")}</Link>
            </div>
          </section>
        ) : finished ? (
          <section className="proxy-request-success proxy-paid-success">
            <div className="proxy-success-icon"><CheckCircle2 size={34} /></div>
            <span className="section-kicker">{order.status === "completed" ? L("处理完成", "Completed") : L("付款已提交", "Payment submitted")}</span>
            <h1>{order.status === "completed" ? L("代付已完成", "Proxy payment completed") : L("订单已收到", "Order received")}</h1>
            <p>{order.status === "completed" ? L("本次代付已经处理完成。", "Your proxy payment has been completed.") : L("工作人员正在核对款项，确认后将开始处理代付。", "We're verifying the payment and will process your request once confirmed.")}</p>
            <div className="proxy-order-reference"><span>{L("订单号", "Order ID")}</span><code>{order.orderId}</code><em><MailCheck size={13} />{L("通知已发送至邮箱", "Confirmation emailed")}</em></div>
            <div className="proxy-success-actions"><Link href={`/service-center?order=${encodeURIComponent(order.orderId)}`} className="primary-btn">{L("查询订单", "Track order")}</Link><Link href="/" className="secondary-btn">{L("返回首页", "Back home")}</Link></div>
          </section>
        ) : (
          <div className="proxy-payment-layout">
            <section className="checkout-card proxy-payment-order-card">
              <div className="proxy-payment-product"><img src="/products/proxy-pay.jpg" alt={L("全球代付", "Global Proxy Pay")} /><div><span className="section-kicker">{L("全球代付", "Global Proxy Pay")}</span><h1>{L("人工报价已完成", "Your custom quote")}</h1></div></div>
              <div className="proxy-payment-details">
                <div><span>{L("订单号", "Order ID")}</span><b>{order.orderId}<button type="button" onClick={() => { copyText(order.orderId); setCopied(true); setTimeout(() => setCopied(false), 1500); }} aria-label={L("复制订单号", "Copy order ID")}><Copy size={12} />{copied && <em>{L("已复制", "Copied")}</em>}</button></b></div>
                <div><span>{L("商品标价", "Listed price")}</span><b>{order.productPrice}</b></div>
                <div className="span-2"><span>{L("网站 / 平台", "Website / platform")}</span><b style={{ wordBreak: "break-all", fontWeight: 600 }}>{order.platformUrl}</b></div>
                <div><span>{L("报价时间", "Quoted at")}</span><b>{order.quotedAtBeijing || "--"}</b></div>
                <div><span>{L("付款截止", "Pay by")}</span><b>{order.quoteExpiresAtBeijing || "--"}</b></div>
                <div><span>{L("接收邮箱", "Email")}</span><b>{order.email}</b></div>
              </div>
            </section>

            <section className="checkout-card proxy-payment-qr-card">
              {!settingsState.ready && (
                <div className={`checkout-alert ${settingsState.error ? "error" : "info"}`} role={settingsState.error ? "alert" : "status"}>
                  <span>{settingsState.error
                    ? L("暂时无法读取最新收款信息。为避免转错账户，收款码和提交功能已暂停", "The latest payment details could not be loaded. The QR code and submission are paused to prevent a transfer to the wrong account.")
                    : L("正在读取最新收款信息…", "Loading the latest payment details…")}</span>
                  {settingsState.error && <button type="button" onClick={settingsState.retry}>{L("重试", "Retry")}</button>}
                </div>
              )}
              <div className="proxy-pay-method-seg">
                <button type="button" className={payMethod === "alipay" ? "active" : ""} onClick={() => selectPaymentMethod("alipay")} aria-pressed={payMethod === "alipay"} disabled={submitting || paymentUncertain || !settingsState.ready}>{L("支付宝", "Alipay")}</button>
                <button type="button" className={payMethod === "usdt" ? "active" : ""} onClick={() => selectPaymentMethod("usdt")} aria-pressed={payMethod === "usdt"} disabled={submitting || paymentUncertain || !settingsState.ready}>USDT {settingsState.ready && usdtPresentation.discount && <em>{usdtPresentation.discount}</em>}</button>
              </div>
              <div className="proxy-payment-qr-head"><span><ShieldCheck size={17} />{isUsdt ? L("USDT 付款", "USDT payment") : L("支付宝付款", "Alipay payment")}</span><em>{isUsdt ? "TRC20" : L("安全结算", "Secure")}</em></div>
              {paymentUiReady && <div className={`proxy-payment-method-amount ${payMethod}`} aria-live="polite">
                <span>{payMethod === "usdt" ? L("USDT 需付", "Pay with USDT") : L("支付宝需付", "Pay with Alipay")}</span>
                <b>{payMethod === "usdt"
                  ? (usdtAmount > 0 ? `${usdtAmount} USDT` : rateState.loading ? L("汇率读取中…", "Loading rate…") : L("汇率不可用", "Rate unavailable"))
                  : `¥${quoteCny.toFixed(2)}`}</b>
                <small>{payMethod === "usdt"
                  ? L("TRC20 · 请按此精确金额转账", "TRC20 · send this exact amount")
                  : L("请按此精确金额付款", "Pay this exact amount")}</small>
              </div>}
              {isUsdt && !paymentUncertain && rateState.error && <div className="checkout-alert error" role="alert">{rateState.error}<button type="button" onClick={loadUsdtRate}>{L("重试", "Retry")}</button></div>}
              {paymentUiReady && <div className={`proxy-payment-qr-frame${qrReady ? " ready" : qrError ? " error" : " loading"}`}>
                {!qrReady && !qrError && <div className="proxy-payment-qr-loading"><LoaderCircle size={20} className="spin-icon" /><span>{L("正在切换收款码", "Loading payment QR")}</span></div>}
                {qrError && <div className="proxy-payment-qr-loading" role="alert"><span>{L("收款码加载失败", "Payment QR failed to load")}</span><button type="button" onClick={() => { setQrError(false); setQrReady(false); setQrReloadKey((value) => value + 1); }}>{L("重试", "Retry")}</button></div>}
                <img
                  key={`${payMethod}:${paymentQrSrc}:${qrReloadKey}`}
                  src={paymentQrSrc}
                  alt={isUsdt ? L("USDT 收款码", "USDT QR code") : L("支付宝收款码", "Alipay QR code")}
                  className="proxy-payment-qr"
                  loading="eager"
                  onLoad={() => { setQrError(false); setQrReady(true); setPaymentReadyAt(Date.now()); }}
                  onError={() => { setQrError(true); setQrReady(false); setPaymentReadyAt(0); }}
                />
              </div>}
              {paymentUiReady && <strong>{isUsdt ? L("TRC20 钱包扫码", "Scan with a TRC20 wallet") : L("支付宝扫一扫", "Scan with Alipay")}</strong>}
              {isUsdt && paymentUiReady && (
                <div className="usdt-address-box">
                  <span className="usdt-address-label">{L("TRON / TRC20 收款地址", "TRON / TRC20 address")}</span>
                  <div className="usdt-address-field">
                    <code className="usdt-address-value">{settings.usdt.address}</code>
                    <button type="button" className={`usdt-address-copy${copied ? " copied" : ""}`} onClick={() => { copyText(settings.usdt.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }} aria-label={L("复制地址", "Copy address")}><Copy size={13} /></button>
                  </div>
                </div>
              )}
              {paymentUiReady && <p>{isUsdt ? L("转账完成后返回本页提交付款信息", "Return here after paying and submit the payment") : L("付款完成后返回本页提交付款信息", "Return here after paying and submit the payment")}</p>}
              {paymentUncertain && <div className="checkout-alert error" role="alert">{L("付款提交结果尚未确认。为避免重复付款，收款码和付款方式已锁定；请先查询最新订单状态，仍未更新请联系客服核对。", "The payment submission result is uncertain. To prevent duplicate payment, the payment details are locked. Check the latest order status, then contact support if it still hasn't updated.")}</div>}
              {state.notice && <div className="checkout-alert info">{state.notice}</div>}
              {state.error && <div className="checkout-alert error">{state.error}</div>}
              <button type="button" className="primary-btn primary-btn-lg proxy-payment-submit" onClick={paymentUncertain ? () => setQuoteAttempt((current) => current + 1) : confirmPayment} disabled={submitting || (!paymentUncertain && (!settingsState.ready || !rateReady))}>{submitting ? <><LoaderCircle size={16} className="spin-icon" />{L("提交中", "Submitting")}</> : paymentUncertain ? <><RefreshCw size={16} />{L("查询最新订单状态", "Check latest order status")}</> : !settingsState.ready ? <><LoaderCircle size={16} className="spin-icon" />{L("正在确认收款信息", "Checking payment details")}</> : <><CheckCircle2 size={16} />{L("付款完成，提交订单", "I've paid — submit")}</>}</button>
              <small><Clock3 size={12} />{L("提交后由工作人员核对款项", "Payment is verified by our team")}</small>
            </section>
          </div>
        )}
      </main>
      <FloatingSupport />
    </div>
  );
}
