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
} from "../lib/store";

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, hydrated, removeFromCart, clearCart } = useCart();
  const [step, setStep] = useState("form");
  const [form, setForm] = useState(blankCheckoutForm);
  const [paymentMethod, setPaymentMethod] = useState("alipay");
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [orderResults, setOrderResults] = useState([]);
  const [authedUser, setAuthedUser] = useState(null); // {email, balance} | null
  // Pre-fill email + load balance for logged-in user
  useEffect(() => {
    fetch("/api/auth/balance", { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && d.ok) {
          setAuthedUser({ email: d.email, balance: Number(d.balance || 0) });
          setForm((cur) => cur.email ? cur : { ...cur, email: d.email });
        }
      })
      .catch(() => {});
  }, []);

  const cartItems = cart.map((key) => PRODUCTS.find((p) => p.key === key)).filter(Boolean);
  const cartCount = cartItems.length;
  const subtotal = cartSubtotalCny(cartItems);
  const discountRate = bundleDiscountRate(cartCount);
  const finalCny = cartFinalCny(cartItems);
  const finalUsdt = cartFinalUsdt(cartItems);
  const savings = subtotal - finalCny;

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

  // Contact field is required only when cart includes products with needsContact (Spotify)
  const contactRequired = cartItems.some((p) => p.key === "spotify");

  function validateForm() {
    if (cartCount === 0) return "购物车为空,请先选购商品。";
    if (!validEmail(form.email)) {
      return "请填写有效的邮箱地址,客服将通过邮箱发送订单与开通信息。";
    }
    if (contactRequired && !form.contact.trim()) {
      return "Spotify 订单需要填写联系方式,工作人员会通过此方式联系您。";
    }
    for (const p of cartItems) {
      const f = form.fields[p.key] || {};
      if (productNeedsAccountPassword(p) && (!f.account?.trim() || !f.password?.trim())) {
        return `请为「${p.title}」填写需要开通的账号和密码。`;
      }
    }
    return "";
  }

  function goPay(event) {
    event.preventDefault();
    const error = validateForm();
    if (error) {
      setStatus({ type: "error", message: error });
      return;
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
      return {
        service: p.key,
        account: (f.account || "").trim(),
        password: productNeedsAccountPassword(p) ? (f.password || "").trim() : "",
      };
    });

    try {
      const response = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(),
          contact: form.contact.trim(),
          remark: form.remark.trim(),
          paymentMethod,
          items,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "submit_failed");

      setOrderResults([{
        orderId: data.orderId,
        items: data.items || [],
        paidAmount: data.paidAmount,
        paidCurrency: data.paidCurrency,
      }]);
      setStep("done");
      setStatus({ type: "success", message: "订单已成功提交" });
      clearCart();
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus({ type: "error", message: "订单提交失败,请联系在线客服处理。" });
    } finally {
      setSubmitting(false);
    }
  }

  // Empty cart state
  if (hydrated && cartCount === 0 && step !== "done") {
    return (
      <div className="checkout-page">
        <header className="checkout-header">
          <Link href="/" className="checkout-back">
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
          <p>还没有选购商品,先回首页看看吧。</p>
          <Link href="/" className="primary-btn primary-btn-lg">
            <ArrowLeft size={15} />
            返回首页选购
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <header className="checkout-header">
        <Link href="/" className="checkout-back">
          <ArrowLeft size={16} />
          <img src="/logo.png" alt="冒央会社" className="checkout-logo" />
        </Link>
        <div className="checkout-secure">
          <Lock size={13} />
          {paymentMethod === "usdt" ? "USDT-TRC20 安全结算" : "支付宝担保结算"}
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
                  <Link href="/#products" className="text-link">+ 继续选购</Link>
                </div>
                <div className="cart-items-grid">
                  {cartItems.map((item) => (
                    <div key={item.key} className="cart-tile">
                      <button
                        type="button"
                        className="cart-tile-remove"
                        onClick={() => removeFromCart(item.key)}
                        aria-label={`移除 ${item.title}`}
                        title={`移除 ${item.title}`}
                      >
                        <X size={11} strokeWidth={3} />
                      </button>
                      <img src={item.image} alt={item.title} className="cart-tile-img" />
                      <div className="cart-tile-name">{item.title}</div>
                      <div className="cart-tile-price">¥{item.amount}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Per-product extra fields */}
              {cartItems.some((p) => productNeedsAccountPassword(p)) && (
                <section className="checkout-card">
                  <div className="checkout-card-head">
                    <h3>商品配置</h3>
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
                              <span>{p.title} · 密码</span>
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
                    placeholder="用于接收订单信息与日后订单查询"
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
                      ? "Spotify 订单需要,必要时通过此联系您"
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
                    <span>折后总额</span>
                    <b>¥{finalCny}</b>
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
                <div className="payment-method-group">
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
                      <div className="payment-method-icon alipay">支付宝</div>
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
                      <div className="payment-method-icon usdt">USDT</div>
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
                        <div className="payment-method-icon balance">余额</div>
                        <div className="payment-method-detail">
                          <strong>账户余额支付</strong>
                          <small>余额 ¥{authedUser.balance.toFixed(2)}{authedUser.balance < finalCny ? " · 余额不足" : " · 一键扣款"}</small>
                        </div>
                      </label>
                    )}
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon wechat">微信</div>
                      <div className="payment-method-detail">
                        <strong>微信支付</strong>
                        <small>支付通道维护中,暂不可用</small>
                      </div>
                    </label>
                    <label className="payment-method-option disabled">
                      <input type="radio" name="paymentMethod" disabled />
                      <div className="payment-method-icon card">CARD</div>
                      <div className="payment-method-detail">
                        <strong>Mastercard / Visa</strong>
                        <small>支付通道维护中,暂不可用</small>
                      </div>
                    </label>
                  </div>
                </div>

                <button type="submit" className="primary-btn primary-btn-lg checkout-submit-btn">
                  前往支付 · {paymentMethod === "usdt" ? `${finalUsdt} USDT` : `¥${finalCny}`}
                  <ArrowRight size={15} />
                </button>
              </section>
            </aside>

            {/* Mobile sticky bottom CTA */}
            <div className="checkout-mobile-cta">
              <div className="checkout-mobile-cta-info">
                <small>{paymentMethod === "usdt" ? "USDT-TRC20" : "支付宝"}</small>
                <b>{paymentMethod === "usdt" ? `${finalUsdt} USDT` : `¥${finalCny}`}</b>
              </div>
              <button type="submit" className="primary-btn checkout-mobile-cta-btn">
                前往支付
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
                ) : (
                  <b>¥{finalCny}</b>
                )}
              </div>

              {/* 重要提示 */}
              <div className="pay-tip">
                {paymentMethod === "usdt"
                  ? `请使用 TRON (TRC20) 网络转账精确金额 ${finalUsdt} USDT 到下方地址,付款完成后请记得返回本页面点击「付款完成」按钮提交订单。`
                  : paymentMethod === "balance"
                  ? `点击下方「确认扣款并提交订单」后,系统将自动从您的账户余额(¥${authedUser?.balance.toFixed(2) || "0.00"})扣除 ¥${finalCny},随后提交订单。`
                  : "请按上方金额完成支付宝付款。付款完成后请记得返回本页面点击「付款完成」按钮,充值人员 30 分钟内处理。"}
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
                  {cartItems.map((p) => (
                    <div key={p.key} className="checkout-cart-row">
                      <span>{p.title}</span>
                      <b>¥{p.amount}</b>
                    </div>
                  ))}
                  {discountRate > 0 && (
                    <div className="checkout-cart-row discount">
                      <span>组合优惠 · {bundleDiscountLabel(cartCount)}</span>
                      <b>−¥{savings}</b>
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
            <p>客服将在 30 分钟内联系您。订单确认邮件已发送至您的邮箱,请保持邮箱及联系方式畅通。</p>

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
                  <b>{orderResults[0].paidCurrency === "USDT" ? `${orderResults[0].paidAmount} USDT` : `¥${orderResults[0].paidAmount}`}</b>
                </div>
              </div>
            )}

            <div className="checkout-done-actions">
              <Link href="/" className="primary-btn primary-btn-lg">
                返回首页
              </Link>
              <Link href="/#order-query" className="secondary-btn">
                查询订单状态
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
