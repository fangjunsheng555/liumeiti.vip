"use client";

import { useEffect, useState } from "react";
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
  ShieldCheck,
} from "lucide-react";
import FloatingSupport from "./FloatingSupport";
import { copyText, useSiteSettings } from "../lib/store";
import { useLocale } from "./LocaleProvider";

export default function ProxyQuotePayment({ orderId }) {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const settings = useSiteSettings();
  const [token, setToken] = useState("");
  const [order, setOrder] = useState(null);
  const [state, setState] = useState({ loading: true, error: "", notice: "" });
  const [submitting, setSubmitting] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const value = params.get("token") || "";
    setToken(value);
    if (!value) {
      setState({ loading: false, error: L("付款链接不完整", "Payment link is incomplete"), notice: "" });
      return;
    }
    fetch(`/api/quote-orders/${encodeURIComponent(orderId)}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${value}` },
    })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (!response.ok || !data.ok) {
          const message = {
            invalid_payment_link: L("付款链接无效", "Invalid payment link"),
            quote_expired: L("报价已过期，请联系客服重新报价", "This quote expired. Contact support for a new quote."),
            order_not_found: L("未找到订单", "Order not found"),
            order_invalid: L("订单已失效，请联系在线客服", "This order is no longer valid. Contact support."),
            quote_not_ready: L("报价尚未生效，请联系在线客服", "The quote isn't active yet. Contact support."),
          }[data.error] || data.error || L("无法读取报价", "Couldn't load the quote");
          throw new Error(message);
        }
        setOrder(data.order);
        setLoadedAt(Date.now());
        setState({ loading: false, error: "", notice: "" });
      })
      .catch((error) => setState({ loading: false, error: error.message, notice: "" }));
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirmPayment() {
    if (submitting || !token || !order) return;
    if (Date.now() - loadedAt < 5000) {
      setState((current) => ({ ...current, notice: L("请先完成扫码付款，再提交付款信息", "Complete the QR payment before submitting") }));
      return;
    }
    setSubmitting(true);
    setState((current) => ({ ...current, notice: "" }));
    try {
      const response = await fetch(`/api/quote-orders/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, paymentMethod: "alipay" }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const message = {
          quote_expired: L("报价已过期，请联系客服重新报价", "This quote expired. Contact support for a new quote."),
          order_invalid: L("订单已失效", "This order is no longer valid"),
          invalid_payment_link: L("付款链接无效", "Invalid payment link"),
          payment_processing: L("付款信息正在提交，请稍后刷新订单状态", "Payment is being submitted. Check the order status shortly."),
        }[data.error] || data.error || L("提交失败，请稍后再试", "Couldn't submit. Try again shortly.");
        throw new Error(message);
      }
      setOrder(data.order);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
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
          <section className="proxy-payment-state error"><ShieldCheck size={38} /><h1>{L("无法打开付款链接", "Can't open this payment link")}</h1><p>{state.error}</p><Link href="/service-center#contact" className="primary-btn">{L("联系客服", "Contact support")}</Link></section>
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
              <div className="proxy-payment-amount"><span>{L("应付金额", "Amount due")}</span><b>¥{Number(order.quoteAmount || 0).toFixed(2)}</b><small>{L("请支付页面显示的精确金额", "Pay the exact amount shown")}</small></div>
              <div className="proxy-payment-details">
                <div><span>{L("订单号", "Order ID")}</span><b>{order.orderId}<button type="button" onClick={() => { copyText(order.orderId); setCopied(true); setTimeout(() => setCopied(false), 1500); }} aria-label={L("复制订单号", "Copy order ID")}><Copy size={12} />{copied && <em>{L("已复制", "Copied")}</em>}</button></b></div>
                <div><span>{L("商品标价", "Listed price")}</span><b>{order.productPrice}</b></div>
                <div className="span-2"><span>{L("网站 / 平台", "Website / platform")}</span><a href={order.platformUrl} target="_blank" rel="noopener noreferrer">{order.platformUrl}<ExternalLink size={12} /></a></div>
                <div><span>{L("报价时间", "Quoted at")}</span><b>{order.quotedAtBeijing || "--"}</b></div>
                <div><span>{L("接收邮箱", "Email")}</span><b>{order.email}</b></div>
              </div>
            </section>

            <section className="checkout-card proxy-payment-qr-card">
              <div className="proxy-payment-qr-head"><span><ShieldCheck size={17} />{L("支付宝付款", "Alipay payment")}</span><em>{L("安全结算", "Secure")}</em></div>
              <img src={settings.payment.alipayQr || "/payment/alipay.jpg"} alt={L("支付宝收款码", "Alipay QR code")} className="proxy-payment-qr" />
              <strong>{L("支付宝扫一扫", "Scan with Alipay")}</strong>
              <p>{L("付款完成后返回本页提交付款信息", "Return here after paying and submit the payment")}</p>
              {state.notice && <div className="checkout-alert info">{state.notice}</div>}
              {state.error && <div className="checkout-alert error">{state.error}</div>}
              <button type="button" className="primary-btn primary-btn-lg proxy-payment-submit" onClick={confirmPayment} disabled={submitting}>{submitting ? <><LoaderCircle size={16} className="spin-icon" />{L("提交中", "Submitting")}</> : <><CheckCircle2 size={16} />{L("付款完成，提交订单", "I've paid — submit")}</>}</button>
              <small><Clock3 size={12} />{L("提交后由工作人员核对款项", "Payment is verified by our team")}</small>
            </section>
          </div>
        )}
      </main>
      <FloatingSupport />
    </div>
  );
}
