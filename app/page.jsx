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
  AlertTriangle,
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
  Wallet,
  X,
  Zap,
} from "lucide-react";

const SITE_CONTENT = {
  brandCn: "冒央会社",
  brandEn: "MAOYANG TAIWAN INC",
  domain: "liumeiti.vip",
  heroBadge: "来自中国台湾 · 专注流媒体会员6年",
  heroTitleLine1: "冒央会社",
  heroTitleHighlight: "·流媒体会员服务",
  heroDesc: "正版流媒体会员，全网最低价 · 付款后极速到账",
  heroStats: [
    { num: "500k+", label: "累计用户", icon: Users },
    { num: "1M+", label: "服务案例", icon: TrendingUp },
    { num: "Top 3", label: "行业排名", icon: Award },
    { num: "2020至今", label: "专注服务", icon: Clock },
  ],
  layoutCards: [
    ["选择所需服务", "Spotify / Netflix / Disney+ / Hbomax / 机场节点"],
    ["查看详情介绍", "请查阅我们的服务介绍，确保服务满足您的需求"],
    ["付款下单", "正确填写信息后扫码付款，付款完成提交订单，工作人员将在10分钟内处理"],
    ["售后服务", "成交只是开始，专业团队全程售后保障用户使用体验"],
  ],
  faq: [
    {
      q: "下单后多久能用？",
      a: "支付完成后客服将在 10 分钟内处理（高峰期不超过 1 小时），通常 5-15 分钟即可使用。所有开通均由真人客服核对，确保稳定准确。",
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
    { icon: Zap, title: "极速开通", desc: "支付后客服极速处理" },
    { icon: ShieldCheck, title: "7 天退款", desc: "账号原因全额退" },
    { icon: Headphones, title: "在线客服", desc: "随时响应你的问题" },
    { icon: Lock, title: "担保支付", desc: "全程加密更安全" },
  ],
  testimonials: [
    { name: "陈**", initial: "陈", region: "首尔", service: "Spotify 家庭版", rating: 5, date: "8分钟前", text: "用了快两年了，从没出过问题，老板人也好有问题秒回。比某宝便宜一大截，强推！" },
    { name: "Chueng****", initial: "L", region: "台北", service: "Netflix 4K", rating: 5, date: "30分钟前", text: "4K 杜比真的清晰，独立车位不会被踢，全家一起看也够用。客服处理快得离谱，5 分钟就开好了。" },
    { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "9小时前", text: "看流媒体4K 不缓冲，日常使用其他app也很流畅。第一次买就续了一年，¥98 真的没谁了。" },
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
  if (order.paymentMethod === "redeem") return "兑换码";
  return order.paymentMethod === "usdt" ? "USDT" : "支付宝";
}

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

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="oauth-provider-icon">
      <path fill="currentColor" d="M16.52 12.58c-.02-2.05 1.68-3.04 1.76-3.09-1-.1.14-2.06-3.92-2.2-1.65-.17-3.17.97-3.99.97-.84 0-2.1-.95-3.45-.92-1.78.03-3.42 1.04-4.34 2.64-1.85 3.2-.47 7.94 1.33 10.54.88 1.27 1.93 2.7 3.31 2.65 1.33-.05 1.83-.86 3.44-.86 1.6 0 2.06.86 3.46.83 1.43-.02 2.33-1.3 3.2-2.58 1.01-1.48 1.43-2.92 1.45-2.99-.03-.01-2.23-.85-2.25-3.49ZM13.27 5.55c.73-.88 1.22-2.1 1.08-3.32-1.05.04-2.32.7-3.07 1.58-.67.78-1.26 2.03-1.1 3.22 1.17.09 2.36-.59 3.09-1.48Z" />
    </svg>
  );
}

export default function Page() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [cartToast, setCartToast] = useState(null);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [authUser, setAuthUser] = useState(null); // null = unknown, false = guest, {email} = logged in
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register" | "forgot" | "reset"
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ a: 0, b: 0 });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [queryStatus, setQueryStatus] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResults, setQueryResults] = useState([]);
  const [expandedOrderId, setExpandedOrderId] = useState("");
  const [queryDetailOrder, setQueryDetailOrder] = useState(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemStatus, setRedeemStatus] = useState(null);

  const { cart, toggleCart: toggleCartStore, removeFromCart } = useCart();

  // Check auth status on mount + load balance
  useEffect(() => {
    if (typeof window === "undefined") return;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setAuthUser(d.ok ? { email: d.email, username: d.username, balance: Number(d.balance || 0) } : false))
      .catch(() => setAuthUser(false));
  }, []);

  // Lock body scroll while auth modal is open (prevents iOS keyboard
  // from scrolling/jitter the page behind the modal)
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (authModal) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [authModal]);

  // Refresh captcha when auth modal opens (only for login/register)
  useEffect(() => {
    if (authModal === "login" || authModal === "register") {
      setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
    }
    if (authModal) {
      setAuthError("");
      setAuthNotice("");
    }
    if (authModal === null) {
      setAuthForm({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
    }
  }, [authModal]);

  // Auto-open login modal if URL has ?auth=login
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "login") setAuthModal("login");
    if (params.get("auth") === "oauth_new") setAuthNotice("注册成功,新用户 ¥8.88 优惠券已发放,结算时自动抵扣。");
    if (params.get("auth") && params.get("auth").includes("not_configured")) {
      setAuthModal("login");
      setAuthError("第三方登录尚未配置,请先使用邮箱登录或注册。");
    }
  }, []);

  async function doAuth(e) {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      let endpoint = authModal;
      let payload;
      if (authModal === "login" || authModal === "register") {
        payload = {
          email: authForm.email.trim(),
          password: authForm.password,
          captchaA: authCaptcha.a,
          captchaB: authCaptcha.b,
          captchaAnswer: Number(authForm.captchaAnswer),
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
        // Always show success (don't leak whether email registered)
        setAuthNotice("如果邮箱已注册,验证码已发送至邮箱。请查看收件箱(或垃圾邮件)。");
        setAuthModal("reset");
        setAuthForm((f) => ({ ...f, code: "", newPassword: "" }));
        return;
      }

      if (data.ok) {
        if (authModal === "login" || authModal === "register" || authModal === "reset") {
          setAuthUser({ email: data.email });
          setAuthModal(null);
        }
      } else {
        const msg = {
          captcha_failed: "人机验证失败,请重新计算",
          email_taken: "该邮箱已注册",
          invalid_email: "邮箱格式错误",
          password_length: "密码 6-64 位",
          invalid_credentials: "邮箱或密码错误",
          invalid_code: "验证码格式错误(6 位数字)",
          code_invalid_or_expired: "验证码错误或已过期",
          user_not_found: "该邮箱未注册",
        }[data.error] || data.error || "操作失败";
        setAuthError(msg);
        if (authModal === "login" || authModal === "register") {
          setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
        }
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

  async function submitHomeRedeem(event) {
    event.preventDefault();
    const code = redeemInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      setRedeemStatus({ type: "error", message: "请输入兑换码。" });
      return;
    }
    setRedeemBusy(true);
    setRedeemStatus({ type: "info", message: "正在识别兑换码..." });
    try {
      const infoRes = await fetch(`/api/redeem-code?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const info = await infoRes.json();
      if (!info.ok || info.status !== "active") {
        setRedeemStatus({ type: "error", message: "兑换码不存在、已使用或已作废。" });
        return;
      }
      if (info.type === "service") {
        window.location.href = `/checkout?redeem=${encodeURIComponent(code)}`;
        return;
      }
      if (!authUser || authUser === false) {
        setAuthModal("login");
        setAuthNotice("余额兑换码需要先登录账号,登录后再次点击兑换即可到账。");
        setRedeemStatus({ type: "error", message: "余额兑换码需要登录账号后兑换。" });
        return;
      }
      const res = await fetch("/api/auth/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!data.ok) {
        setRedeemStatus({ type: "error", message: data.message || "兑换失败,请联系客服。" });
        return;
      }
      setAuthUser((cur) => cur && cur !== false ? { ...cur, balance: Number(data.balance || cur.balance || 0) } : cur);
      setRedeemInput("");
      setRedeemStatus({ type: "success", message: `兑换成功,余额已到账。当前余额 ¥${Number(data.balance || 0).toFixed(2)}` });
    } catch (e) {
      setRedeemStatus({ type: "error", message: "兑换失败,请稍后再试。" });
    } finally {
      setRedeemBusy(false);
    }
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
              <a href="/account" className="header-balance-chip" title={`${authUser.username || authUser.email} · 个人中心`}>
                <Wallet size={13} />
                <span>¥{Number(authUser.balance || 0).toFixed(2)}</span>
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <main id="top" className="main-content">

        {/* ── Hero ── */}
        <section className="hero-section container">
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
              {authUser && authUser.email ? (
                <a href="/account" className="hero-pair-btn secondary">
                  <Users size={14} />
                  个人中心
                </a>
              ) : (
                <button type="button" className="hero-pair-btn secondary with-auth-tip" onClick={() => setAuthModal("login")}>
                  <Users size={14} />
                  登录 / 注册
                  <span className="hero-auth-tip">新用户立减 ¥8.88</span>
                </button>
              )}
            </div>

            <div className="hero-microtrust">
              <span><Zap size={13} />即时开通</span>
              <span className="dot" />
              <span><ShieldCheck size={13} />7 天内退款</span>
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
                <div className="trust-strip-icon"><Icon size={16} /></div>
                <div className="trust-strip-title">{title}</div>
                {/* description hidden on mobile by CSS */}
                <div className="trust-strip-desc">{desc}</div>
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

        {/* ── Redeem Code ── */}
        <section className="section container redeem-section">
          <div className="redeem-card glass-card">
            <div className="redeem-card-copy">
              <div className="section-kicker">Redeem Code</div>
              <h2>兑换码兑换</h2>
              <p>请在下方准确输入兑换码后点击立即兑换，系统会自动识别跳转</p>
            </div>
            <form className="redeem-card-form" onSubmit={submitHomeRedeem}>
              <label>
                <span>兑换码</span>
                <input
                  value={redeemInput}
                  onChange={(e) => {
                    setRedeemInput(e.target.value.toUpperCase());
                    if (redeemStatus?.type === "error") setRedeemStatus(null);
                  }}
                  placeholder="准确输入兑换码，支持粘贴"
                  autoComplete="off"
                />
              </label>
              <button type="submit" disabled={redeemBusy}>
                {redeemBusy ? <LoaderCircle size={14} className="spin-icon" /> : <Gift size={14} />}
                立即兑换
              </button>
              {redeemStatus && <div className={`redeem-card-status ${redeemStatus.type}`}>{redeemStatus.message}</div>}
            </form>
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
        <section className="section container contact-section">
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
              {SITE_CONTENT.supportChannels.map((ch) => {
                const isCopied = copiedKey === "float-" + ch.label;
                return (
                  <button
                    key={ch.label}
                    className={`floating-item${isCopied ? " is-copied" : ""}`}
                    onClick={() => handleCopy(ch.copyValue, "float-" + ch.label)}
                  >
                    <span><strong>{ch.label}</strong>：{ch.value}</span>
                    {isCopied
                      ? <em className="floating-item-copied"><CheckCircle2 size={13} />已复制</em>
                      : <Copy size={14} />}
                  </button>
                );
              })}
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

      {/* ── Auth Modal (login / register / forgot / reset) ── */}
      {authModal && (
        <div className="auth-modal-mask" onClick={() => !authBusy && setAuthModal(null)}>
          <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-modal-head">
              {authModal === "login" || authModal === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authModal === "login" ? " active" : ""}`} onClick={() => setAuthModal("login")}>登录</button>
                  <button type="button" className={`auth-tab${authModal === "register" ? " active" : ""}`} onClick={() => setAuthModal("register")}>注册</button>
                </div>
              ) : (
                <div className="auth-modal-title">
                  {authModal === "forgot" ? "找回密码" : "重置密码"}
                </div>
              )}
              <button type="button" className="auth-close" onClick={() => !authBusy && setAuthModal(null)}>
                <X size={16} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              {(authModal === "login" || authModal === "register") && (
                <div className="oauth-login-grid">
                  <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />Google 登录</a>
                  <a href="/api/auth/oauth/apple/start" className="oauth-login-btn apple"><AppleIcon />Apple 登录</a>
                </div>
              )}
              <label className="auth-field">
                <span>邮箱</span>
                <input
                  type="email"
                  inputMode="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                  placeholder="example@email.com"
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
                    maxLength={64}
                    required
                  />
                </label>
              )}

              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>邮箱验证码 (6 位)</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      value={authForm.code}
                      onChange={(e) => setAuthForm({ ...authForm, code: e.target.value.replace(/\D/g, "") })}
                      placeholder="收件箱中的 6 位验证码"
                      autoComplete="one-time-code"
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>新密码 (6-64 位)</span>
                    <input
                      type="password"
                      value={authForm.newPassword}
                      onChange={(e) => setAuthForm({ ...authForm, newPassword: e.target.value })}
                      placeholder="设置新的登录密码"
                      autoComplete="new-password"
                      minLength={6}
                      maxLength={64}
                      required
                    />
                  </label>
                </>
              )}

              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field auth-captcha">
                  <span>人机验证</span>
                  <div className="auth-captcha-row">
                    <em>{authCaptcha.a} + {authCaptcha.b} =</em>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={authForm.captchaAnswer}
                      onChange={(e) => setAuthForm({ ...authForm, captchaAnswer: e.target.value })}
                      placeholder="?"
                      required
                    />
                    <button
                      type="button"
                      className="auth-captcha-refresh"
                      onClick={() => setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) })}
                      title="换一题"
                      aria-label="换一题"
                    ><RefreshCw size={14} /></button>
                  </div>
                </label>
              )}

              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}

              <button type="submit" className="auth-submit" disabled={authBusy}>
                {authBusy ? (
                  <><LoaderCircle size={14} className="spin-icon" />处理中</>
                ) : authModal === "login" ? "登录"
                  : authModal === "register" ? "注册并登录"
                  : authModal === "forgot" ? "发送邮箱验证码"
                  : "重置密码并登录"}
              </button>

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
        const isRedeem = queryDetailOrder.paymentMethod === "redeem";
        const paidDisplay = isRedeem
          ? "服务兑换码"
          : isUsdt && queryDetailOrder.paidAmount
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
                    {queryDetailOrder.status === "completed"
                      ? <CheckCircle2 size={11} />
                      : queryDetailOrder.status === "invalid"
                      ? <AlertTriangle size={11} />
                      : <Clock size={11} />}
                    {queryDetailOrder.status === "completed"
                      ? "订单已完成"
                      : queryDetailOrder.status === "invalid"
                      ? "订单无效·未收到付款"
                      : "订单已收到"}
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
