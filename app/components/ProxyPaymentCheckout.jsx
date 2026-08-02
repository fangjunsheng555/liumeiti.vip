"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCheck2,
  LoaderCircle,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import FloatingSupport from "./FloatingSupport";
import { useLocale } from "./LocaleProvider";
import { validEmail } from "../lib/store";
import {
  createPendingIdempotencyRecord,
  idempotencyFingerprint,
  isExplicitTerminalIdempotencyResponse,
  restorePendingIdempotencyRecord,
} from "../lib/idempotency";
import { withCheckoutSubmissionCoordination } from "../lib/checkout-pending-journal";
import {
  clearSinglePendingOperation,
  completeSinglePendingOperation,
} from "../lib/single-pending-journal";

const QUOTE_ORDER_PENDING_KEY = "liumeiti:quote-order-pending:v1";
const QUOTE_ORDER_COMPLETED_DEDUP_MS = 10 * 60 * 1000;

async function withQuoteOrderLock(callback) {
  // Reuse the checkout origin-wide lock. It provides Web Locks when present,
  // a verified localStorage bakery lock otherwise, and fails closed if the
  // browser cannot safely coordinate tabs.
  return withCheckoutSubmissionCoordination(callback);
}

function inviteCode() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("lm_invite") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  } catch {
    return "";
  }
}

function visibleQuoteForm(value) {
  return {
    email: String(value?.email || ""),
    platformUrl: String(value?.platformUrl || ""),
    productPrice: String(value?.productPrice || ""),
    contact: String(value?.contact || ""),
    remark: String(value?.remark || ""),
  };
}

function sameVisibleQuoteForm(left, right) {
  return idempotencyFingerprint("quote-order-visible-form", visibleQuoteForm(left))
    === idempotencyFingerprint("quote-order-visible-form", visibleQuoteForm(right));
}

function validQuoteOperationIdentity(identity) {
  if (!Object.prototype.hasOwnProperty.call(identity || {}, "accountLifecycleId")) return false;
  const email = String(identity?.accountEmail || "").trim().toLowerCase();
  const lifecycle = String(identity?.accountLifecycleId || "").trim().toLowerCase();
  return email ? /^[a-f0-9]{32}$/.test(lifecycle) : lifecycle === "";
}

export default function ProxyPaymentCheckout({ initialEmail = "", accountEmail = "", accountLifecycleId = "", onSubmitted }) {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [form, setForm] = useState({ email: initialEmail, platformUrl: "", productPrice: "", contact: "", remark: "" });
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);
  const requestRef = useRef(null);

  useEffect(() => {
    if (initialEmail) setForm((current) => current.email ? current : { ...current, email: initialEmail });
  }, [initialEmail]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = JSON.parse(window.localStorage.getItem(QUOTE_ORDER_PENDING_KEY) || "null");
      if (!stored?.payload || stored.completed) return;
      const restored = restorePendingIdempotencyRecord(stored, "quote-order");
      if (!restored.ok) return;
      if (!validQuoteOperationIdentity(restored.record.identity)) {
        setNotice({ type: "error", message: L(
          "旧版未完成报价缺少账户生命周期绑定，不能安全自动恢复。请勿重复提交，并联系客服核对。",
          "The unfinished legacy quote lacks an account-lifecycle binding. Do not resubmit it; contact support.",
        ) });
        return;
      }
      const originalAccount = String(restored.record.identity?.accountEmail || "").trim().toLowerCase();
      const originalLifecycle = String(restored.record.identity?.accountLifecycleId || "").trim().toLowerCase();
      const currentAccount = String(accountEmail || "").trim().toLowerCase();
      const currentLifecycle = String(accountLifecycleId || "").trim().toLowerCase();
      if (originalAccount !== currentAccount || originalLifecycle !== currentLifecycle) return;
      requestRef.current = restored.record;
      setForm(visibleQuoteForm(restored.record.payload));
      setNotice((current) => current || {
        type: "info",
        message: L(
          "已恢复未完成的原报价申请；提交时会沿用原请求，请勿更改后重复申请。",
          "Your unfinished quote request was restored. It will replay the original request; do not edit it and submit again.",
        ),
      });
    } catch {
      // Submission performs the authoritative fail-closed validation. Avoid
      // deleting or guessing at a record merely because hydration failed.
    }
  }, [accountEmail, accountLifecycleId]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    if (notice?.type === "error") setNotice(null);
  }

  function validate() {
    if (!validEmail(form.email)) return L("请填写有效邮箱", "Enter a valid email");
    // 网站链接/平台不做格式校验,任意内容(链接或文字描述)均可,仅要求非空。
    if (!form.platformUrl.trim()) return L("请填写网站链接 / 平台", "Enter the website link / platform");
    if (!form.productPrice.trim() || !/\d/.test(form.productPrice)) return L("请填写商品标价和币种", "Enter the listed price and currency");
    if (!form.contact.trim()) return L("请填写联系方式", "Enter your contact");
    return "";
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setNotice({ type: "info", message: L("正在提交申请...", "Submitting request...") });
    try {
      await withQuoteOrderLock(async () => {
        const currentAccount = String(accountEmail || "").trim().toLowerCase();
        const currentLifecycle = String(accountLifecycleId || "").trim().toLowerCase();
        if ((currentAccount && !/^[a-f0-9]{32}$/.test(currentLifecycle)) || (!currentAccount && currentLifecycle)) {
          throw new Error("quote_operation_identity_unavailable");
        }
        const currentPayload = {
          ...form,
          expectedAccountEmail: currentAccount,
          expectedAccountLifecycleId: currentLifecycle,
          locale,
          inviteCode: inviteCode(),
        };
        // Storage is authoritative after acquiring the cross-tab lock. A
        // stale in-memory ref must never overwrite a newer operation created
        // or completed by another tab.
        let pending = null;
        if (typeof window !== "undefined") {
          let stored = null;
          try {
            stored = JSON.parse(window.localStorage.getItem(QUOTE_ORDER_PENDING_KEY) || "null");
          } catch {
            throw new Error(L("检测到无法安全读取的未完成报价申请，请勿重复提交并联系客服核对。", "An unfinished quote request cannot be safely read. Do not resubmit it; contact support."));
          }
          if (stored?.payload) {
            const restored = restorePendingIdempotencyRecord(stored, "quote-order");
            if (!restored.ok) {
              throw new Error(L("检测到无法安全恢复的未完成报价申请，请勿重复提交并联系客服核对。", "An unfinished quote request cannot be safely restored. Do not resubmit it; contact support."));
            }
            if (!validQuoteOperationIdentity(restored.record.identity)) {
              throw new Error("quote_operation_lifecycle_missing");
            }
            pending = restored.record;
          } else if (stored) {
            // The old journal did not store the request body or account. Its
            // server outcome cannot be distinguished safely after an account
            // switch, so never guess or mint a replacement key.
            throw new Error(L("检测到旧版未完成报价申请，请勿重复提交并联系客服核对原订单。", "A legacy quote request is still unresolved. Do not resubmit it; contact support to verify the original order."));
          }
        }
        if (!pending && requestRef.current) pending = requestRef.current;

        if (pending) {
          const originalAccount = String(pending.identity?.accountEmail || "").trim().toLowerCase();
          const originalLifecycle = String(pending.identity?.accountLifecycleId || "").trim().toLowerCase();
          if (pending.completed) {
            const completedAt = Date.parse(pending.completedAt || "");
            if (!Number.isFinite(completedAt) || !pending.result?.orderId) {
              throw new Error(L(
                "报价申请的完成记录无法安全验证，请勿重复提交并联系客服核对。",
                "The quote completion record cannot be safely verified. Do not resubmit it; contact support.",
              ));
            }
            const currentFingerprint = idempotencyFingerprint("quote-order", {
              identity: { accountEmail: currentAccount, accountLifecycleId: currentLifecycle },
              payload: currentPayload,
            });
            if (
              Number.isFinite(completedAt)
              && Date.now() - completedAt >= 0
              && Date.now() - completedAt <= QUOTE_ORDER_COMPLETED_DEDUP_MS
              && pending.idempotencyRequest?.fingerprint === currentFingerprint
              && pending.result?.orderId
            ) {
              setResult({ orderId: pending.result.orderId });
              setNotice(null);
              onSubmitted?.();
              return;
            }
            // A confirmed terminal success may be replaced by a genuinely new
            // request or a different account. Only unresolved operations bind
            // the browser to their original identity.
            requestRef.current = null;
            pending = null;
          } else if (originalAccount !== currentAccount) {
            throw new Error(originalAccount
              ? L(`请先登录 ${originalAccount} 恢复原报价申请，请勿重复提交。`, `Sign in as ${originalAccount} to recover the original quote request; do not submit it again.`)
              : L("请先退出当前账户恢复原访客申请，请勿重复提交。", "Sign out to recover the original guest request; do not submit it again."));
          } else if (originalLifecycle !== currentLifecycle) {
            throw new Error(L(
              "原账户已被删除或重新注册，未完成报价不能关联到新账户。请勿重复提交，并联系客服核对。",
              "The original account was deleted or re-registered. The unfinished quote cannot be attached to the new account. Do not resubmit it; contact support.",
            ));
          } else if (!sameVisibleQuoteForm(pending.payload, form)) {
            throw new Error(L(
              "当前表单与未完成的原报价申请不一致。请恢复原内容后重试，或联系客服核对；系统未发送新申请。",
              "The form differs from the unfinished original quote request. Restore the original details or contact support; no new request was sent.",
            ));
          }
        }

        if (!pending) {
          const validationError = validate();
          if (validationError) throw new Error(validationError);
          pending = createPendingIdempotencyRecord(null, "quote-order", currentPayload, {
            identity: { accountEmail: currentAccount, accountLifecycleId: currentLifecycle },
          });
          if (typeof window !== "undefined") {
            const encoded = JSON.stringify(pending);
            window.localStorage.setItem(QUOTE_ORDER_PENDING_KEY, encoded);
            if (window.localStorage.getItem(QUOTE_ORDER_PENDING_KEY) !== encoded) {
              throw new Error(L("浏览器无法安全保存报价申请，请检查存储权限后重试。", "The browser cannot safely save this quote request. Check storage permissions and try again."));
            }
          }
        }

        requestRef.current = pending;
        const operation = pending.idempotencyRequest;
        const exactPayload = pending.payload;
        const originalAccount = String(pending.identity?.accountEmail || "").trim().toLowerCase();
        const originalLifecycle = String(pending.identity?.accountLifecycleId || "").trim().toLowerCase();
        const response = await fetch("/api/quote-orders", {
          method: "POST",
          credentials: originalAccount ? "same-origin" : "omit",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operation.key,
            "X-Order-Expected-Account": originalAccount || "__guest__",
            "X-Operation-Expected-Lifecycle": originalAccount ? originalLifecycle : "__guest__",
          },
          body: JSON.stringify(exactPayload),
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok || !data?.ok) {
          if (isExplicitTerminalIdempotencyResponse(response.status, data)) {
            requestRef.current = null;
            if (typeof window !== "undefined") {
              clearSinglePendingOperation(window.localStorage, QUOTE_ORDER_PENDING_KEY, operation.key);
            }
          }
          const message = {
            invalid_email: L("邮箱格式不正确", "Invalid email"),
            missing_platform_url: L("请填写网站链接", "Website link is required"),
            invalid_platform_url: L("网站链接格式不正确", "Invalid website link"),
            mainland_site_not_supported: L("暂不支持中国大陆网站", "Mainland China websites are not supported"),
            invalid_product_price: L("请填写商品标价和币种", "Enter the listed price and currency"),
            missing_contact: L("请填写联系方式", "Contact is required"),
            operation_identity_changed: L("登录账户已变化，请切回原账户恢复申请", "The signed-in account changed. Return to the original account to recover this request."),
            operation_identity_auth_required: L("登录已失效，请重新登录原账户恢复申请", "Your session expired. Sign in to the original account to recover this request."),
            operation_lifecycle_changed: L("原账户已删除或重新注册，申请不能转移到新账户，请联系客服核对", "The original account was deleted or re-registered. This request cannot move to the new account; contact support."),
            idempotency_conflict: L("原报价申请内容冲突，请勿重复提交并联系客服", "The original quote request conflicts with the stored operation. Do not resubmit it; contact support."),
          }[data?.error] || data?.message || data?.error || L("提交失败，原请求已保留，请勿重复提交", "Submission failed. The original request is preserved; do not submit it again.");
          throw new Error(message);
        }

        const completed = {
          ...pending,
          completed: true,
          completedAt: new Date().toISOString(),
          result: { orderId: data.orderId },
        };
        requestRef.current = null;
        if (typeof window !== "undefined") {
          // Completion is UI dedup metadata, not permission to overwrite a
          // different unresolved request that appeared while fetch awaited.
          completeSinglePendingOperation(
            window.localStorage,
            QUOTE_ORDER_PENDING_KEY,
            operation.key,
            completed,
          );
        }
        setResult({ orderId: data.orderId });
        setNotice(null);
        onSubmitted?.();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    } catch (error) {
      setNotice({ type: "error", message: error.message || L("网络错误，请稍后再试", "Network error. Try again shortly.") });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-page proxy-checkout-page">
      <header className="checkout-header">
        <Link href="/shop" className="checkout-back">
          <ArrowLeft size={16} />
          <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="checkout-logo" />
        </Link>
        <div className="checkout-secure"><Lock size={13} />{L("人工报价服务", "Manual quote service")}</div>
      </header>

      <main className="checkout-main proxy-checkout-main">
        <div className="checkout-stepper proxy-stepper">
          {[
            [L("提交需求", "Request"), FileCheck2],
            [L("人工报价", "Quote"), Mail],
            [L("确认付款", "Payment"), CheckCircle2],
          ].map(([label, Icon], index) => (
            <div key={label} className={`checkout-step${index === 0 ? " active" : ""}`}>
              <span className="checkout-step-num"><Icon size={14} /></span>
              <span className="checkout-step-label">{label}</span>
            </div>
          ))}
        </div>

        {result ? (
          <section className="proxy-request-success">
            <div className="proxy-success-icon"><CheckCircle2 size={34} /></div>
            <span className="section-kicker">{L("提交成功", "Submitted")}</span>
            <h1>{L("代付申请已收到", "Your request is in")}</h1>
            <p>{L("工作人员核价后，报价与付款链接会发送到您的邮箱。", "We'll email the quote and secure payment link after review.")}</p>
            <div className="proxy-order-reference">
              <span>{L("订单号", "Order ID")}</span>
              <code>{result.orderId}</code>
              <em><Clock3 size={13} />{L("等待人工报价", "Awaiting quote")}</em>
            </div>
            <div className="proxy-success-actions">
              <Link href={`/service-center?order=${encodeURIComponent(result.orderId)}`} className="primary-btn"><FileCheck2 size={15} />{L("查询订单", "Track order")}</Link>
              <Link href="/" className="secondary-btn">{L("返回首页", "Back home")}</Link>
            </div>
          </section>
        ) : (
          <form className="proxy-checkout-layout" onSubmit={submit}>
            <div className="proxy-checkout-form-column">
              <section className="checkout-card proxy-service-hero">
                <img src="/products/proxy-pay.jpg" alt={L("全球代付", "Global Proxy Pay")} />
                <div>
                  <span className="section-kicker">{L("全球代付", "Global Proxy Pay")}</span>
                  <h1>{L("海外网站与平台代付", "Payment for overseas websites")}</h1>
                  <p>{L("中国大陆网站除外 · 提交后人工核价", "Mainland China excluded · manually reviewed")}</p>
                </div>
                <b>{L("3折起", "From 30%")}</b>
              </section>

              {notice && <div className={`checkout-alert ${notice.type}`}>{notice.message}</div>}

              <section className="checkout-card proxy-request-fields">
                <div className="checkout-card-head">
                  <div><span className="section-kicker">{L("代付信息", "Request details")}</span><h2>{L("填写需求", "Tell us what to pay")}</h2></div>
                  <em>{L("4 项必填", "4 required")}</em>
                </div>
                <label className="order-field">
                  <span>{L("邮箱", "Email")} <em className="field-required">*</em></span>
                  <input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.com" autoComplete="email" maxLength={200} required />
                  <small>{L("用于接收报价与付款链接", "Receives the quote and payment link")}</small>
                </label>
                <label className="order-field">
                  <span>{L("网站链接 / 平台", "Website link / platform")} <em className="field-required">*</em></span>
                  <div className="proxy-url-field"><ExternalLink size={16} /><input type="text" value={form.platformUrl} onChange={(e) => update("platformUrl", e.target.value)} placeholder="https://example.com/product" maxLength={800} required /></div>
                </label>
                <div className="proxy-field-row">
                  <label className="order-field">
                    <span>{L("商品标价", "Listed price")} <em className="field-required">*</em></span>
                    <input value={form.productPrice} onChange={(e) => update("productPrice", e.target.value)} placeholder={L("例如 USD 99.99", "e.g. USD 99.99")} maxLength={80} required />
                  </label>
                  <label className="order-field">
                    <span>{L("联系方式", "Contact")} <em className="field-required">*</em></span>
                    <input value={form.contact} onChange={(e) => update("contact", e.target.value)} placeholder="QQ / WeChat / WhatsApp / Telegram" autoComplete="tel" maxLength={200} required />
                  </label>
                </div>
                <label className="order-field">
                  <span>{L("备注", "Note")} <em className="field-optional">{L("(选填)", "(optional)")}</em></span>
                  <textarea value={form.remark} onChange={(e) => update("remark", e.target.value)} placeholder={L("规格、账号地区或其他要求", "Variant, account region or other requirements")} rows={3} maxLength={1500} />
                </label>
              </section>
            </div>

            <aside className="proxy-checkout-aside">
              <section className="checkout-card proxy-quote-summary">
                <div className="proxy-summary-mark"><ShieldCheck size={20} /></div>
                <h2>{L("确认报价后再付款", "Pay only after the quote")}</h2>
                <div className="proxy-summary-steps">
                  <div><em>01</em><span><b>{L("提交需求", "Send request")}</b><small>{L("填写网站与商品标价", "Share the website and listed price")}</small></span></div>
                  <div><em>02</em><span><b>{L("人工核价", "Manual review")}</b><small>{L("核验平台、商品与可用性", "We verify platform, item and availability")}</small></span></div>
                  <div><em>03</em><span><b>{L("邮件付款", "Pay by email link")}</b><small>{L("确认报价后完成付款", "Accept the quote and complete payment")}</small></span></div>
                </div>
                <button type="submit" className="primary-btn primary-btn-lg proxy-submit" disabled={submitting}>
                  {submitting ? <><LoaderCircle size={16} className="spin-icon" />{L("提交中", "Submitting")}</> : <>{L("提交代付申请", "Submit request")}<ArrowRight size={16} /></>}
                </button>
                <p><Lock size={12} />{L("提交申请不产生付款", "Submitting does not charge you")}</p>
              </section>
            </aside>

            <div className="checkout-mobile-cta proxy-mobile-cta">
              <div className="checkout-mobile-cta-info"><small>{L("无需预付", "No upfront payment")}</small><b>{L("等待人工报价", "Custom quote")}</b></div>
              <button type="submit" className="primary-btn checkout-mobile-cta-btn" disabled={submitting}>{submitting ? <LoaderCircle size={15} className="spin-icon" /> : <>{L("提交申请", "Submit")}<ArrowRight size={15} /></>}</button>
            </div>
          </form>
        )}
      </main>
      <FloatingSupport />
    </div>
  );
}
