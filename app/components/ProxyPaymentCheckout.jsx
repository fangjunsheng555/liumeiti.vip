"use client";

import { useEffect, useState } from "react";
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

function inviteCode() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("lm_invite") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  } catch {
    return "";
  }
}

export default function ProxyPaymentCheckout({ initialEmail = "", onSubmitted }) {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [form, setForm] = useState({ email: initialEmail, platformUrl: "", productPrice: "", contact: "", remark: "" });
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (initialEmail) setForm((current) => current.email ? current : { ...current, email: initialEmail });
  }, [initialEmail]);

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
    const error = validate();
    if (error) {
      setNotice({ type: "error", message: error });
      return;
    }
    setSubmitting(true);
    setNotice({ type: "info", message: L("正在提交申请...", "Submitting request...") });
    try {
      const response = await fetch("/api/quote-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, locale, inviteCode: inviteCode() }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const message = {
          invalid_email: L("邮箱格式不正确", "Invalid email"),
          missing_platform_url: L("请填写网站链接", "Website link is required"),
          invalid_platform_url: L("网站链接格式不正确", "Invalid website link"),
          mainland_site_not_supported: L("暂不支持中国大陆网站", "Mainland China websites are not supported"),
          invalid_product_price: L("请填写商品标价和币种", "Enter the listed price and currency"),
          missing_contact: L("请填写联系方式", "Contact is required"),
        }[data.error] || data.message || data.error || L("提交失败，请稍后再试", "Couldn't submit. Try again shortly.");
        throw new Error(message);
      }
      setResult({ orderId: data.orderId });
      setNotice(null);
      onSubmitted?.();
      window.scrollTo({ top: 0, behavior: "smooth" });
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
