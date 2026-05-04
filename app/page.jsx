"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PRODUCTS,
  USDT_DISCOUNT,
  USDT_RATE,
  useCart,
  copyText,
  money,
  bundleDiscountRate,
  bundleDiscountLabel,
  cartSubtotalCny,
  cartFinalCny,
  cartFinalUsdt,
  subscriptionLinks,
} from "./lib/store";
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  CheckCircle2,
  Copy,
  Flame,
  Gift,
  Headphones,
  Image as ImageIcon,
  LayoutPanelTop,
  LoaderCircle,
  Lock,
  MessageCircleMore,
  QrCode,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Users,
  Award,
  TrendingUp,
  Clock,
  X,
  Zap,
} from "lucide-react";

const SITE_CONTENT = {
  brandCn: "冒央会社",
  brandEn: "MAOYANG",
  domain: "liumeiti.vip",
  heroBadge: "来自中国台湾 · 专注流媒体会员6年",
  heroTitleLine1: "冒央会社",
  heroTitleHighlight: " · Maoyang Taiwan Inc",
  heroDesc: "正版流媒体会员，全网最低价 · 30 分钟内极速到账。",
  heroStats: [
    { num: "500,000+", label: "累计用户", icon: Users },
    { num: "1,000,000+", label: "服务案例", icon: TrendingUp },
    { num: "Top 3", label: "行业排名", icon: Award },
    { num: "2020至今", label: "专注服务", icon: Clock },
  ],
  layoutCards: [
    ["选择所需服务", "Spotify / Netflix / Disney+ / Hbomax / 机场节点"],
    ["查看详情介绍", "请查阅我们的服务介绍，确保服务满足您的需求"],
    ["付款下单", "正确填写信息后扫码付款，付款完成提交订单，工作人员将在30分钟内处理"],
    ["售后服务", "成交只是开始，专业团队全程售后保障用户使用体验"],
  ],
  faq: [
    {
      q: "下单后多久能用？",
      a: "支付完成后客服将在 30 分钟内处理（高峰期不超过 1 小时），通常 5-15 分钟即可使用。所有开通均由真人客服核对，确保稳定准确。",
    },
    {
      q: "账号安全有保障吗？会被封禁吗？",
      a: "我们采用源头独立渠道，账号长期稳定可用。Netflix / Disney+ / HBO 均为独立车位上锁，不会被踢；Spotify 为正规家庭组邀请；机场节点为大厂纯净 IP。如出现问题联系在线客服解决即可。",
    },
    {
      q: "支付方式有哪些？支付安全吗？",
      a: "支持支付宝担保支付（推荐），及 USDT 加密货币支付（9折）。所有支付通道均为持牌正规渠道，资金通过支付宝担保托管，不直接接触账户，安全无忧。",
    },
    {
      q: "是否支持售后服务？",
      a: "支持。我们支持 7 天内账号原因退款，并且提供在线客服协助、问题排查与订单服务咨询，如您有任何问题，随时联系我们的在线客服团队。",
    },
    {
      q: "如何联系在线客服？",
      a: "可通过 QQ、WhatsApp、Telegram 与我们联系，在线时间为北京时间早 9 点至晚 11 点。下单后客服会主动联系你确认信息。",
    },
    {
      q: "关于我们？",
      a: "冒央会社来自中国台湾，长期专注流媒体会员服务、使用指导、售后协助。我们重视响应速度、服务体验与长期口碑，持续为用户提供廉价、稳定、优质的服务。",
    },
    {
      q: "是否可以定制企业或团队方案？",
      a: "可以。我们全网拥有 200+ 代理合作伙伴，若你有长期合作、批量需求或企业场景，可联系客服进一步沟通。",
    },
  ],
  supportChannels: [
    { label: "QQ", value: "2802632995", copyValue: "2802632995" },
    { label: "WhatsApp", value: "+1 431 509 3334", copyValue: "+1 4315093334" },
    { label: "Telegram", value: "@MaoyangSupport", copyValue: "@MaoyangSupport" },
  ],
  supportHours: "在线时间：北京时间 09:00 – 23:00",
  footerRecord: "地址：台灣新北市板橋區遠東路1號3號218",
  footerNote: "Copyright © 2026 Maoyang Taiwan Inc. All rights reserved",
  trustStrip: [
    { icon: Zap, title: "30 分钟开通", desc: "支付后客服极速处理" },
    { icon: ShieldCheck, title: "7 天内退款", desc: "账号原因全额退" },
    { icon: Headphones, title: "14x7 在线客服", desc: "随时响应你的问题" },
    { icon: Lock, title: "多通道担保支付", desc: "全程加密更安全" },
  ],
  testimonials: [
    { name: "陈**", initial: "陈", region: "首尔", service: "Spotify 家庭版", rating: 5, date: "5分钟前", text: "用了快两年了，从没出过问题，老板人也好有问题秒回。比某宝便宜一大截，强推！" },
    { name: "Chueng****", initial: "L", region: "台北", service: "Netflix 4K", rating: 5, date: "15分钟前", text: "4K 杜比真的清晰，独立车位不会被踢，全家一起看也够用。客服处理快得离谱，5 分钟就开好了。" },
    { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "六小时前", text: "看流媒体4K 不缓冲，日常使用其他app也很流畅。第一次买就续了一年，¥98 真的没谁了。" },
    { name: "張*", initial: "張", region: "香港", service: "Disney+", rating: 5, date: "一天前", text: "本来还在犹豫，下单完 10 分钟就能用了，体验很顶。已经推荐给好几个朋友。" },
    { name: "Yammy***", initial: "Y", region: "伦敦", service: "HBO Max", rating: 5, date: "三天前", text: "第一次买怕被骗，结果非常正规，客服全程指导，账号到现在用了半年都很稳。" },
    { name: "李**", initial: "李", region: "北京", service: "Spotify+Netflix 4K+机场节点", rating: 5, date: "一周前", text: "组合下单还便宜了一些，听歌刷剧科学上网一站搞定，售后也跟上了，下次还来。" },
  ],
  monthlySoldNote: "本月已售",
};

const PRODUCT_PROMOS = {
  spotify:  { badge: "热销 No.1", badgeIcon: Flame, originalPrice: 298, monthly: "≈¥10.7/月", soldThisMonth: 1328 },
  netflix:  { badge: "影视首选", badgeIcon: Star, originalPrice: 398, monthly: "≈¥14/月", soldThisMonth: 956 },
  disney:   { badge: "性价比之选", badgeIcon: Gift, originalPrice: 268, monthly: "≈¥9/月", soldThisMonth: 612 },
  max:      { badge: "影迷经典最爱", badgeIcon: Tag, originalPrice: 348, monthly: "≈¥12.3/月", soldThisMonth: 487 },
  rocket:   { badge: "必备工具", badgeIcon: Sparkles, originalPrice: 218, monthly: "≈¥8.2/月", soldThisMonth: 1580 },
};

// PRODUCTS, USDT constants and pure helpers are imported from ./lib/store

function orderTime(order) {
  if (order.createdAtBeijing) return order.createdAtBeijing;
  if (!order.createdAt) return "";
  return new Date(order.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) + " 北京时间";
}

function paymentLabel(order) {
  return order.paymentMethod === "usdt" ? "USDT" : "支付宝";
}

export default function Page() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [cartToast, setCartToast] = useState(null);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [authUser, setAuthUser] = useState(null); // null = unknown, false = guest, {email} = logged in
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register"
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ a: 0, b: 0 });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [queryStatus, setQueryStatus] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResults, setQueryResults] = useState([]);
  const [expandedOrderId, setExpandedOrderId] = useState("");
  const [queryDetailOrder, setQueryDetailOrder] = useState(null);

  const { cart, toggleCart: toggleCartStore, removeFromCart } = useCart();

  // Check auth status on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setAuthUser(d.ok ? { email: d.email } : false))
      .catch(() => setAuthUser(false));
  }, []);

  // Refresh captcha when auth modal opens
  useEffect(() => {
    if (authModal) {
      setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
      setAuthError("");
      setAuthForm({ email: "", password: "", captchaAnswer: "" });
    }
  }, [authModal]);

  // Auto-open login modal if URL has ?auth=login
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "login") setAuthModal("login");
  }, []);

  async function doAuth(e) {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      const res = await fetch(`/api/auth/${authModal}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: authForm.email.trim(),
          password: authForm.password,
          captchaA: authCaptcha.a,
          captchaB: authCaptcha.b,
          captchaAnswer: Number(authForm.captchaAnswer),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthUser({ email: data.email });
        setAuthModal(null);
      } else {
        const msg = {
          captcha_failed: "人机验证失败,请重新计算",
          email_taken: "该邮箱已注册",
          invalid_email: "邮箱格式错误",
          password_length: "密码 6-64 位",
          invalid_credentials: "邮箱或密码错误",
        }[data.error] || data.error || "操作失败";
        setAuthError(msg);
        setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
      }
    } catch (e) {
      setAuthError("网络错误");
    } finally {
      setAuthBusy(false);
    }
  }

  async function doLogout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    setAuthUser(false);
  }

  // Auto-query if ?order=LMxxxxx in URL (from email link)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order");
    if (orderId && orderId.length > 4) {
      setQueryInput(orderId);
      // Trigger query
      (async () => {
        setQueryLoading(true);
        setQueryStatus({ type: "info", message: "正在查询订单..." });
        try {
          const response = await fetch("/api/order-query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: orderId }),
          });
          const data = await response.json();
          if (data.ok && data.orders && data.orders.length > 0) {
            const match = data.orders.find((o) => o.matchType === "orderId") || data.orders[0];
            setQueryResults(data.orders);
            setQueryDetailOrder(match);
            setQueryStatus({ type: "success", message: "已找到订单。" });
          } else {
            setQueryStatus({ type: "error", message: "未查询到该订单,请联系客服。" });
          }
        } catch (e) {
          setQueryStatus({ type: "error", message: "查询失败,请稍后再试。" });
        } finally {
          setQueryLoading(false);
        }
      })();
    }
  }, []);

  const selectedProduct = useMemo(
    () => PRODUCTS.find((item) => item.key === selectedKey) || null,
    [selectedKey]
  );

  const cartItems = useMemo(
    () => cart.map((key) => PRODUCTS.find((p) => p.key === key)).filter(Boolean),
    [cart]
  );
  const cartCount = cartItems.length;
  const cartSubtotal = useMemo(() => cartSubtotalCny(cartItems), [cartItems]);
  const cartDiscountRate = useMemo(() => bundleDiscountRate(cartCount), [cartCount]);
  const cartFinalAmount = useMemo(() => cartFinalCny(cartItems), [cartItems]);
  const cartSavings = cartSubtotal - cartFinalAmount;

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  function closeProduct() {
    setSelectedKey(null);
  }

  function isInCart(key) {
    return cart.includes(key);
  }

  function toggleCart(key) {
    const wasIn = cart.includes(key);
    toggleCartStore(key);
    if (!wasIn) {
      const product = PRODUCTS.find((p) => p.key === key);
      if (product) {
        setCartToast({ key, title: product.title });
        setTimeout(() => setCartToast(null), 1800);
      }
    }
  }

  function goCheckout() {
    if (cartCount === 0) return;
    window.location.href = "/checkout";
  }

  async function submitQuery(event) {
    event.preventDefault();
    const query = queryInput.trim();
    if (!query) {
      setQueryStatus({ type: "error", message: "请输入完整订单号或下单邮箱。" });
      setQueryResults([]);
      setExpandedOrderId("");
      return;
    }

    setQueryLoading(true);
    setQueryStatus({ type: "info", message: "正在查询订单..." });
    setExpandedOrderId("");

    try {
      const response = await fetch("/api/order-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "query_failed");
      if (!data.configured) {
        setQueryResults([]);
        setQueryStatus({ type: "error", message: "订单存储尚未连接，请联系在线客服查询。" });
        return;
      }
      const orders = data.orders || [];
      setQueryResults(orders);
      setExpandedOrderId("");
      // Auto-open detail modal when matched by orderId (typically single match)
      const orderIdMatch = orders.find((o) => o.matchType === "orderId");
      if (orderIdMatch) {
        setQueryDetailOrder(orderIdMatch);
      }
      setQueryStatus({
        type: orders.length ? "success" : "error",
        message: orders.length
          ? orderIdMatch
            ? "已通过订单号查询到订单。"
            : "已找到 " + orders.length + " 条订单,点击查看详情。"
          : "未查询到订单,请核对订单号或邮箱。",
      });
    } catch (error) {
      setQueryResults([]);
      setQueryStatus({ type: "error", message: "查询失败，请稍后再试或联系在线客服。" });
    } finally {
      setQueryLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />
      <div className="bg-orb orb-c" />

      {/* ── Header ── */}
      <header className="site-header">
        <div className="container header-inner">
          <a href="#top" className="brand-wrap" aria-label={`${SITE_CONTENT.brandCn} ${SITE_CONTENT.brandEn}`}>
            <img src="/logo.png" alt={`${SITE_CONTENT.brandCn} ${SITE_CONTENT.brandEn}`} className="brand-img" />
          </a>

          <nav className="desktop-nav">
            <a href="#products">服务产品</a>
            <a href="#layout">下单流程</a>
            <a href="#order-query">订单查询</a>
            <a href="#faq">FAQ</a>
            <a href="#contact">联系我们</a>
          </nav>

          <div className="header-auth">
            {authUser && authUser.email ? (
              <a href="/account" className="header-auth-btn header-auth-user" title={authUser.email}>
                <span className="header-auth-avatar">{authUser.email[0].toUpperCase()}</span>
                <span className="header-auth-label">我的</span>
              </a>
            ) : (
              <button type="button" className="header-auth-btn" onClick={() => setAuthModal("login")}>
                登录 / 注册
              </button>
            )}
          </div>
        </div>
      </header>

      <main id="top" className="main-content">

        {/* ── Hero ── */}
        <section className="hero-section container">
          <div className="hero-badge">
            <Sparkles size={14} />
            {SITE_CONTENT.heroBadge}
          </div>

          <div className="hero-single">
            <h1 className="hero-title">
              {SITE_CONTENT.heroTitleLine1}
              <span className="hero-title-highlight">{SITE_CONTENT.heroTitleHighlight}</span>
            </h1>
            <p className="hero-desc">{SITE_CONTENT.heroDesc}</p>

            <div className="hero-actions hero-actions-pair">
              <a href="#products" className="hero-pair-btn primary">
                <Zap size={14} />
                立即开通
              </a>
              <a href="#order-query" className="hero-pair-btn secondary">
                <Search size={14} />
                查询订单
              </a>
            </div>

            <div className="hero-microtrust">
              <span><Zap size={13} />即时开通</span>
              <span className="dot" />
              <span><ShieldCheck size={13} />7 天退款</span>
              <span className="dot" />
              <span><Sparkles size={13} />全网最低价</span>
            </div>
          </div>
        </section>

        {/* ── Hero Stats Band ── */}
        <section className="container hero-stats-band-wrap">
          <div className="hero-stats-band">
            {SITE_CONTENT.heroStats.map(({ num, label, icon: Icon }) => (
              <div key={label} className="stat-item">
                <Icon size={18} className="stat-icon" />
                <div className="stat-num">{num}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Trust Strip ── */}
        <section className="container trust-strip-section">
          <div className="trust-strip">
            {SITE_CONTENT.trustStrip.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="trust-strip-item">
                <div className="trust-strip-icon"><Icon size={20} /></div>
                <div>
                  <div className="trust-strip-title">{title}</div>
                  <div className="trust-strip-desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Products ── */}
        <section id="products" className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Services</div>
              <h2 className="section-title">流媒体会员服务</h2>
            </div>
            <div className="section-note section-note-acc">
              <ShieldCheck size={13} />
              全场支持 7 天内退款
            </div>
          </div>

          <div className="products-grid products-grid-32">
            {PRODUCTS.map((item) => {
              const promo = PRODUCT_PROMOS[item.key] || {};
              const PromoIcon = promo.badgeIcon;
              const saved = promo.originalPrice ? promo.originalPrice - item.amount : 0;
              return (
                <article key={item.key} className="glass-card product-card product-card-mini">
                  {promo.badge && (
                    <div className="product-badge">
                      {PromoIcon && <PromoIcon size={11} />}
                      {promo.badge}
                    </div>
                  )}
                  <div className="product-card-top">
                    <img src={item.image} alt={item.title} className="product-image" />
                    <div className="product-name-block">
                      <div className="product-name">{item.title}</div>
                      <div className="product-subtitle">{item.subtitle}</div>
                    </div>
                  </div>

                  <div className="price-box price-box-pro">
                    <div className="price-main">
                      <span className="price-now">¥{item.amount}</span>
                      <span className="price-cycle">/{item.cycle}</span>
                      {promo.originalPrice && (
                        <span className="price-original">¥{promo.originalPrice}</span>
                      )}
                    </div>
                    <div className="price-meta">
                      {saved > 0 && <span className="price-save">立省 ¥{saved}</span>}
                      <span className="price-usdt-hint">USDT支付 9 折</span>
                    </div>
                  </div>

                  {promo.soldThisMonth && (
                    <div className="product-social-proof">
                      <Flame size={11} />
                      {SITE_CONTENT.monthlySoldNote} {promo.soldThisMonth.toLocaleString()} 份
                    </div>
                  )}

                  <div className="product-card-actions">
                    <button
                      type="button"
                      className="text-btn product-detail-link"
                      onClick={() => setSelectedKey(item.key)}
                    >
                      查看详情
                    </button>
                    <button
                      type="button"
                      className={`primary-btn product-cta${isInCart(item.key) ? " in-cart" : ""}`}
                      onClick={() => toggleCart(item.key)}
                    >
                      {isInCart(item.key) ? (
                        <>
                          <CheckCircle2 size={14} />
                          已加入
                        </>
                      ) : (
                        <>
                          加入购物车
                          <ArrowRight size={14} />
                        </>
                      )}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* ── Order Process + Order Query (2-column on desktop) ── */}
        <section className="section container">
          <div className="process-query-pair">
            <div id="layout" className="process-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">Place Guide</div>
                  <h2 className="section-title">下单流程</h2>
                </div>
              </div>

              <div className="layout-grid layout-grid-stack">
                {SITE_CONTENT.layoutCards.map(([title, desc], idx) => {
                  const icons = [LayoutPanelTop, ImageIcon, QrCode, MessageCircleMore];
                  const Icon = icons[idx];
                  return (
                    <div key={title} className="glass-card info-card">
                      <div className="info-step">{String(idx + 1).padStart(2, "0")}</div>
                      <Icon size={26} className="info-icon" />
                      <div className="info-title">{title}</div>
                      <div className="info-desc">{desc}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div id="order-query" className="query-pair-block order-query-section">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Order Lookup</div>
              <h2 className="section-title">订单查询</h2>
            </div>
          </div>

          <div className="order-query-panel">
            <form className="order-query-form" onSubmit={submitQuery}>
              <label className="order-query-field">
                <span>完整订单号 / 下单邮箱</span>
                <input
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  placeholder="输入完整订单号或下单时填写的邮箱"
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="primary-btn" disabled={queryLoading}>
                {queryLoading ? (
                  <>
                    <LoaderCircle size={15} className="spin-icon" />
                    查询中
                  </>
                ) : (
                  <>
                    <Search size={15} />
                    查询订单
                  </>
                )}
              </button>
            </form>

            {queryStatus && (
              <div className={`query-status ${queryStatus.type}`}>{queryStatus.message}</div>
            )}

            {queryResults.length > 0 && (
              <div className="query-results-compact">
                {queryResults.map((order) => {
                  const serviceText = order.serviceLabel || order.service || "订单";
                  return (
                    <button
                      key={order.orderId}
                      type="button"
                      className="query-result-row"
                      onClick={() => setQueryDetailOrder(order)}
                    >
                      <div className="query-result-row-main">
                        <strong>{serviceText}</strong>
                        <small>{order.orderId}</small>
                      </div>
                      <div className="query-result-row-meta">
                        <b>{money(order.finalAmount)}</b>
                        <span>{paymentLabel(order)}</span>
                      </div>
                      <ArrowRight size={14} className="query-result-row-arrow" />
                    </button>
                  );
                })}
              </div>
            )}
              </div>
            </div>
          </div>
        </section>

        {/* ── Testimonials ── */}
        <section className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Reviews</div>
              <h2 className="section-title">用户评价</h2>
            </div>
            <div className="reviews-summary">
              <div className="reviews-stars">
                {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={18} fill="currentColor" />)}
              </div>
              <div className="reviews-summary-text">
                <b>4.98 / 5.0</b>
                <small>基于 50,000+ 真实评价</small>
              </div>
            </div>
          </div>

          <div className="testimonials-grid">
            {SITE_CONTENT.testimonials.map((t) => (
              <article key={t.name + t.date} className="glass-card testimonial-card">
                <div className="testimonial-head">
                  <div className="testimonial-avatar">{t.initial}</div>
                  <div>
                    <div className="testimonial-name">{t.name}</div>
                    <div className="testimonial-meta">{t.region} · {t.service}</div>
                  </div>
                  <div className="testimonial-stars">
                    {[...Array(t.rating)].map((_, i) => (
                      <Star key={i} size={13} fill="currentColor" />
                    ))}
                  </div>
                </div>
                <div className="testimonial-text">"{t.text}"</div>
                <div className="testimonial-date">{t.date}</div>
              </article>
            ))}
          </div>
        </section>

        {/* ── FAQ + Contact (2-column on desktop) ── */}
        <section className="section container">
          <div className="faq-contact-pair">
            <div id="faq" className="faq-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">FAQ</div>
                  <h2 className="section-title">常见问题</h2>
                </div>
              </div>

              <div className="faq-list">
                {SITE_CONTENT.faq.map((faq, index) => {
                  const open = faqOpen === index;
                  return (
                    <div key={faq.q} className={`faq-card${open ? " faq-open" : ""}`}>
                      <button className="faq-button" onClick={() => setFaqOpen(open ? -1 : index)}>
                        <span>{faq.q}</span>
                        <ChevronDown size={18} className={`chevron${open ? " rotate" : ""}`} />
                      </button>
                      {open && <div className="faq-answer">{faq.a}</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div id="contact" className="contact-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">Contact Us</div>
                  <h2 className="section-title">联系我们</h2>
                </div>
              </div>

              <div className="channels-grid channels-stack">
                {SITE_CONTENT.supportChannels.map((ch) => (
                  <div key={ch.label} className="glass-card channel-card">
                    <MessageCircleMore size={28} className="channel-icon" />
                    <div className="channel-label">{ch.label}</div>
                    <div className="channel-value">{ch.value}</div>
                    <button
                      className={`channel-copy-btn${copiedKey === ch.label ? " copied" : ""}`}
                      onClick={() => handleCopy(ch.copyValue, ch.label)}
                    >
                      <Copy size={14} />
                      {copiedKey === ch.label ? "已复制" : "复制"}
                    </button>
                  </div>
                ))}
              </div>

              <div className="contact-hours-line">
                <Clock size={14} />
                客服在线:北京时间 09:00 – 23:00 · 真人客服值守
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="site-footer">
        <div className="container footer-inner">
          <div>
            <div className="footer-brand">{SITE_CONTENT.brandCn} · {SITE_CONTENT.brandEn}</div>
            <div className="footer-sub">{SITE_CONTENT.domain} · Since 2020</div>
          </div>
          <div className="footer-pill">{SITE_CONTENT.footerRecord}</div>
          <div className="footer-pill">{SITE_CONTENT.footerNote}</div>
        </div>
      </footer>

      {/* ── Floating Support Button ── */}
      <div className="floating-wrap">
        {contactOpen && (
          <div className="floating-panel">
            <div className="floating-head">
              <div className="section-kicker">Support</div>
              <div className="floating-title">在线客服</div>
            </div>
            <div className="floating-list">
              {SITE_CONTENT.supportChannels.map((ch) => (
                <button
                  key={ch.label}
                  className="floating-item"
                  onClick={() => handleCopy(ch.copyValue, "float-" + ch.label)}
                >
                  <span><strong>{ch.label}</strong>：{ch.value}</span>
                  <Copy size={14} />
                </button>
              ))}
              <div className="floating-hours">{SITE_CONTENT.supportHours}</div>
            </div>
          </div>
        )}
        <button
          className={`floating-button${contactOpen ? "" : " has-pulse"}`}
          onClick={() => setContactOpen((v) => !v)}
          aria-label="打开客服菜单"
        >
          {contactOpen ? <X size={22} /> : <Headphones size={22} />}
          {!contactOpen && <span className="floating-online-dot" aria-hidden="true" />}
        </button>
      </div>

      {/* ── Cart UI (only when cart has items) ── */}
      {cartCount > 0 && (
        <>
          {cartExpanded && (
            <button
              type="button"
              className="cart-backdrop"
              onClick={() => setCartExpanded(false)}
              aria-label="关闭购物车展开"
            />
          )}
          <div className="cart-bar" role="region" aria-label="购物车">
            {cartExpanded && (
              <div className="cart-bar-panel">
                <div className="cart-bar-panel-head">
                  <strong>已选 {cartCount} 件</strong>
                  <button type="button" className="cart-bar-panel-close" onClick={() => setCartExpanded(false)} aria-label="收起">
                    <X size={14} />
                  </button>
                </div>
                <div className="cart-bar-panel-list">
                  {cartItems.map((item) => (
                    <div key={item.key} className="cart-bar-panel-item">
                      <img src={item.image} alt={item.title} />
                      <div className="cart-bar-panel-info">
                        <strong>{item.title}</strong>
                        <span>¥{item.amount}</span>
                      </div>
                      <button
                        type="button"
                        className="cart-bar-panel-remove"
                        onClick={() => removeFromCart(item.key)}
                        aria-label={`移除 ${item.title}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                {cartDiscountRate > 0 && (
                  <div className="cart-bar-panel-discount">
                    <span>{bundleDiscountLabel(cartCount)}</span>
                    <span>−¥{cartSavings}</span>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="cart-bar-info"
              onClick={() => setCartExpanded((v) => !v)}
              aria-label={cartExpanded ? "收起购物车" : "展开购物车"}
              aria-expanded={cartExpanded}
            >
              <div className="cart-bar-info-top">
                <ShoppingCart size={14} />
                <span>已选 <b>{cartCount}</b> 件</span>
                {cartDiscountRate > 0 && (
                  <span className="cart-bar-discount-tag">{bundleDiscountLabel(cartCount)}</span>
                )}
                <ChevronDown size={13} className={`cart-bar-chevron${cartExpanded ? " open" : ""}`} />
              </div>
              <div className="cart-bar-info-bottom">
                {cartDiscountRate > 0 && <s>¥{cartSubtotal}</s>}
                <b>¥{cartFinalAmount}</b>
              </div>
            </button>
            <button type="button" className="cart-bar-checkout" onClick={goCheckout}>
              去结算
              <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}

      {/* ── Cart Toast ── */}
      {cartToast && (
        <div className="cart-toast" role="status">
          <CheckCircle2 size={16} />
          已将「{cartToast.title}」加入购物车
        </div>
      )}

      {/* ── Auth Modal (login/register) ── */}
      {authModal && (
        <div className="auth-modal-mask" onClick={() => !authBusy && setAuthModal(null)}>
          <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-modal-head">
              <div className="auth-modal-tabs">
                <button
                  type="button"
                  className={`auth-tab${authModal === "login" ? " active" : ""}`}
                  onClick={() => setAuthModal("login")}
                >登录</button>
                <button
                  type="button"
                  className={`auth-tab${authModal === "register" ? " active" : ""}`}
                  onClick={() => setAuthModal("register")}
                >注册</button>
              </div>
              <button type="button" className="auth-close" onClick={() => !authBusy && setAuthModal(null)}>
                <X size={16} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>邮箱</span>
                <input
                  type="email"
                  inputMode="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                  placeholder="example@email.com"
                  autoComplete="email"
                  required
                />
              </label>
              <label className="auth-field">
                <span>密码{authModal === "register" && " (6-64 位)"}</span>
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                  placeholder={authModal === "register" ? "设置一个密码" : "登录密码"}
                  autoComplete={authModal === "register" ? "new-password" : "current-password"}
                  minLength={6}
                  maxLength={64}
                  required
                />
              </label>
              <label className="auth-field auth-captcha">
                <span>人机验证</span>
                <div className="auth-captcha-row">
                  <em>{authCaptcha.a} + {authCaptcha.b} =</em>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={authForm.captchaAnswer}
                    onChange={(e) => setAuthForm({ ...authForm, captchaAnswer: e.target.value })}
                    placeholder="答案"
                    required
                  />
                  <button
                    type="button"
                    className="auth-captcha-refresh"
                    onClick={() => setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) })}
                    title="换一题"
                    aria-label="换一题"
                  >换</button>
                </div>
              </label>
              {authError && <div className="auth-error">{authError}</div>}
              <button type="submit" className="auth-submit" disabled={authBusy}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />处理中</> : (authModal === "login" ? "登录" : "注册并登录")}
              </button>
              <p className="auth-hint">
                {authModal === "login" ? "还没账号?" : "已有账号?"}
                <button
                  type="button"
                  className="auth-switch"
                  onClick={() => setAuthModal(authModal === "login" ? "register" : "login")}
                >
                  {authModal === "login" ? "立即注册" : "去登录"}
                </button>
              </p>
            </form>
          </div>
        </div>
      )}

      {/* ── Product Detail Modal ── */}
      {selectedProduct && (
        <div className="modal-mask" onClick={closeProduct}>
          <div className="modal-card modal-large" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-head-left">
                <img
                  src={selectedProduct.image}
                  alt={selectedProduct.title}
                  className="modal-product-image"
                />
                <div>
                  <div className="section-kicker">详情介绍</div>
                  <div className="modal-title">{selectedProduct.title} 详情预览</div>
                </div>
              </div>
              <button className="close-btn" onClick={closeProduct}>
                <X size={17} />
              </button>
            </div>

            <div className="modal-grid">
              <div className="modal-left-box">
                <div className="modal-price">{selectedProduct.price}</div>
                <div className="modal-intro-box">{selectedProduct.shortIntro}</div>
                <div className="bullet-list">
                  {selectedProduct.highlights.map((bullet) => (
                    <div key={bullet} className="bullet-item">
                      <BadgeCheck size={15} />
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="detail-title">{selectedProduct.detailTitle}</div>
                <div className="detail-body">{selectedProduct.detailBody}</div>
                <div className="modal-actions">
                  <button
                    type="button"
                    className={`primary-btn${isInCart(selectedProduct.key) ? " in-cart" : ""}`}
                    onClick={() => {
                      toggleCart(selectedProduct.key);
                    }}
                  >
                    {isInCart(selectedProduct.key) ? (
                      <>
                        <CheckCircle2 size={15} />
                        已加入(点击移除)
                      </>
                    ) : (
                      <>
                        加入购物车
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                  <button
                    className="secondary-btn"
                    onClick={() => {
                      closeProduct();
                      setContactOpen(true);
                    }}
                  >
                    联系在线客服
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Order Query Detail Modal ── */}
      {queryDetailOrder && (() => {
        const items = queryDetailOrder.items && queryDetailOrder.items.length > 0
          ? queryDetailOrder.items
          : [{
              service: queryDetailOrder.service,
              label: queryDetailOrder.serviceLabel,
              cycle: queryDetailOrder.cycle,
              amount: queryDetailOrder.finalAmount,
              account: queryDetailOrder.account,
              password: queryDetailOrder.password,
              subscriptionLinks: queryDetailOrder.subscriptionLinks,
            }];
        const isUsdt = queryDetailOrder.paymentMethod === "usdt";
        const paidDisplay = isUsdt && queryDetailOrder.paidAmount
          ? `${queryDetailOrder.paidAmount} USDT`
          : `¥${queryDetailOrder.paidAmount || queryDetailOrder.finalAmount}`;
        return (
          <div className="modal-mask" onClick={() => setQueryDetailOrder(null)}>
            <div className="query-modal" onClick={(e) => e.stopPropagation()}>
              <div className="query-modal-head">
                <div>
                  <div className="section-kicker">Order Detail</div>
                  <div className="query-modal-title">
                    {items.length > 1 ? `组合订单 · ${items.length} 件` : (items[0]?.label || "订单")}
                  </div>
                  <code className="query-modal-id">{queryDetailOrder.orderId}</code>
                  <div className={`query-modal-status status-${queryDetailOrder.status || "received"}`}>
                    {queryDetailOrder.status === "completed" ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                    {queryDetailOrder.status === "completed" ? "订单已完成" : "订单已收到"}
                  </div>
                </div>
                <button
                  type="button"
                  className="close-btn"
                  onClick={() => setQueryDetailOrder(null)}
                  aria-label="关闭"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="query-modal-body">
                <div className="query-modal-amount">
                  <span>实付金额</span>
                  <b>{paidDisplay}</b>
                  <em>{paymentLabel(queryDetailOrder)}</em>
                </div>

                <div className="query-modal-items">
                  <div className="query-modal-items-label">商品明细 · {items.length} 件</div>
                  {items.map((it, idx) => (
                    <div key={idx} className="query-modal-item">
                      <div className="query-modal-item-head">
                        <strong>{it.label}</strong>
                        <span>{it.cycle} · ¥{it.amount}</span>
                      </div>
                      {(it.account || it.password) && (
                        <div className="query-modal-item-creds">
                          {it.account && (
                            <div>
                              <span>{it.service === "rocket" ? "用户名" : "账号"}</span>
                              <code>{it.account}</code>
                            </div>
                          )}
                          {it.password && (
                            <div>
                              <span>密码</span>
                              <code>{it.password}</code>
                            </div>
                          )}
                        </div>
                      )}
                      {it.subscriptionLinks && (
                        <div className="query-modal-item-subs">
                          <button
                            type="button"
                            className="query-modal-sub-row"
                            onClick={() => handleCopy(it.subscriptionLinks.shadowrocket, `qm-sr-${idx}`)}
                          >
                            <div>
                              <strong>Shadowrocket 订阅</strong>
                              <small>{it.subscriptionLinks.shadowrocket}</small>
                            </div>
                            <em>{copiedKey === `qm-sr-${idx}` ? "已复制" : "复制"}</em>
                          </button>
                          <button
                            type="button"
                            className="query-modal-sub-row"
                            onClick={() => handleCopy(it.subscriptionLinks.clash, `qm-cl-${idx}`)}
                          >
                            <div>
                              <strong>Clash 订阅</strong>
                              <small>{it.subscriptionLinks.clash}</small>
                            </div>
                            <em>{copiedKey === `qm-cl-${idx}` ? "已复制" : "复制"}</em>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {queryDetailOrder.staffNotes && (
                  <div className="query-modal-staff-notes">
                    <div className="query-modal-staff-notes-label">客服备注</div>
                    <div>{queryDetailOrder.staffNotes}</div>
                  </div>
                )}

                <div className="query-modal-rows">
                  <div><span>订单时间</span><b>{orderTime(queryDetailOrder)}</b></div>
                  {queryDetailOrder.completedAtBeijing && (
                    <div><span>完成时间</span><b>{queryDetailOrder.completedAtBeijing}</b></div>
                  )}
                  {queryDetailOrder.email && (
                    <div><span>邮箱</span><b>{queryDetailOrder.email}</b></div>
                  )}
                  <div><span>联系方式</span><b>{queryDetailOrder.contact || "--"}</b></div>
                  {queryDetailOrder.remark && (
                    <div className="query-modal-row-wide"><span>备注</span><b className="query-modal-remark">{queryDetailOrder.remark}</b></div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}
