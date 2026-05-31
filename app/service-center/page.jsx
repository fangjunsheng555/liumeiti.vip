"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Copy,
  Gift,
  Headphones,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { copyText } from "../lib/store";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import { QQBrandIcon, TelegramBrandIcon, WhatsAppBrandIcon } from "../components/BrandIcons";

const LAYOUT_CARDS = [
  ["选择/兑换服务", "Spotify / Netflix / Disney+ / Hbomax / 机场节点"],
  ["填写信息", "按照网站引导，准确填写你的订单所需的信息"],
  ["提交订单", "核查填写信息无误后提交订单，你的邮箱将收到订单确认信息"],
  ["售后服务", "完成后邮件通知，订单页可继续查询售后信息"],
];

const ASSURANCE_CARDS = [
  {
    title: "稳定开通",
    desc: "六年专业流媒体服务经验，订单提交后人工极速处理",
    meta: "专业省心",
    icon: BadgeCheck,
  },
  {
    title: "售后协助",
    desc: "账号、车位或节点遇到异常，请联系我们全年无休7x14在线客服处理",
    meta: "全程保驾护航",
    icon: Headphones,
  },
  {
    title: "退款规则",
    desc: "账号原因无法正常使用时支持 7 天内退款，客服会先协助排查",
    meta: "规则清晰",
    icon: RefreshCw,
  },
  {
    title: "订单记录",
    desc: "订单除隐私信息外会永久保留，同时订单会同步发送至下单邮箱",
    meta: "记录可追溯",
    icon: Lock,
  },
];

const FAQ = [
  {
    q: "下单后多久能用？",
    a: "支付完成后通常 5-10 分钟即可使用，高峰期不超过 1 小时。所有开通都会核对服务与资料，确保稳定准确",
  },
  {
    q: "账号安全有保障吗？会被封禁吗？",
    a: "我们自有源头渠道，账号长期稳定可用。Spotify 为正规家庭组邀请；Netflix / Disney+ / HBO 均为独立车位可上锁，长期稳定可用；机场节点均为已解锁流媒体纯净 IP，如出现问题联系在线客服解决即可",
  },
  {
    q: "支付方式有哪些？支付安全吗？",
    a: "支持支付宝担保支付（推荐）及 USDT 支付（9折）。订单记录与确认邮件会同步留存，后续查询和售后都更清晰",
  },
  {
    q: "是否支持售后服务？",
    a: "支持。我们支持 7 天内账号原因退款，我们提供订单服务咨询、在线客服协助与问题排查，如您有任何问题，随时联系我们的在线客服团队",
  },
  {
    q: "如何联系在线客服？",
    a: "可通过 QQ、WhatsApp、Telegram 与我们联系，在线时间为北京时间早 9 点至晚 11 点，如您有任何问题，随时联系我们的在线客服团队",
  },
  {
    q: "关于我们？",
    a: "冒央会社来自中国台湾，自2020年起专注流媒体会员服务、使用指导、售后协助。我们重视响应速度、服务体验与长期口碑，持续为用户提供廉价、稳定、优质的服务",
  },
  {
    q: "是否可以定制企业或团队方案？",
    a: "可以。我们全网拥有 200+ 代理合作伙伴，若你有长期合作、批量需求或企业场景，可联系在线客服进一步沟通",
  },
];

const TESTIMONIALS = [
  { name: "陈**", initial: "陈", region: "首尔", service: "Spotify 家庭版", rating: 5, date: "8分钟前", text: "用了快两年了，从没出过问题，老板人也好有问题秒回。比某宝便宜一大截，强推！" },
  { name: "Chueng****", initial: "L", region: "台北", service: "Netflix 4K", rating: 5, date: "30分钟前", text: "4K 杜比真的清晰，独立车位不会被踢，全家一起看也够用。客服处理快得离谱，5 分钟就开好了" },
  { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "9小时前", text: "看流媒体4K 不缓冲，日常使用其他app也很流畅。普通套餐一年 128，50GB/月真实流量够日常用了" },
  { name: "張*", initial: "張", region: "香港", service: "Disney+", rating: 5, date: "一天前", text: "本来还在犹豫，下单完 10 分钟就能用了，体验很顶。已经推荐给好几个朋友" },
  { name: "Yammy***", initial: "Y", region: "伦敦", service: "HBO Max", rating: 5, date: "三天前", text: "第一次买怕被骗，结果非常正规，客服全程指导，账号到现在用了半年都很稳" },
  { name: "李**", initial: "李", region: "北京", service: "Spotify+Netflix 4K+机场节点", rating: 5, date: "一周前", text: "组合下单还便宜了一些，听歌刷剧科学上网一站搞定，售后也跟上了，下次还来" },
  { name: "王*", initial: "王", region: "烟台", service: "机场节点 · 普通套餐", rating: 5, date: "14分钟前", text: "节点真攒劲，刷油管 4K 一点都不卡，50GB/月真实流量明明白白，得劲！" },
  { name: "周**", initial: "周", region: "徐州", service: "Spotify 家庭版", rating: 5, date: "25分钟前", text: "听歌看播客真带劲，下单 5 分钟就开通，账号用一年了冒得问题" },
  { name: "黄*", initial: "黄", region: "嘉兴", service: "Netflix 4K 杜比", rating: 5, date: "45分钟前", text: "客服半夜还在线着实蛮灵的，账号秒开，老婆刷韩剧再也勿卡了" },
  { name: "朱*", initial: "朱", region: "临沂", service: "机场节点 + Netflix", rating: 5, date: "1小时前", text: "组合下单真划算，刷剧加日常上网都搞定，跟朋友推了好几个，全网最低不夸张" },
  { name: "林**", initial: "林", region: "桂林", service: "HBO Max", rating: 5, date: "2小时前", text: "想看权游重温一下，独立车位稳得很，老婆一起看一年下来划算得很" },
  { name: "郑**", initial: "郑", region: "北海", service: "Disney+ 4K", rating: 5, date: "4小时前", text: "细佬要看动画，4K 杜比清晰得很，下单到能用大概 8 分钟，客服几靠谱" },
  { name: "杨*", initial: "杨", region: "大理", service: "机场节点 · 无限套餐", rating: 5, date: "8小时前", text: "屋头路由器一开全屋设备都用上，无限流量放心跑，节点速度整得比前头用过的几家都强" },
  { name: "吴**", initial: "吴", region: "银川", service: "Spotify + HBO Max", rating: 5, date: "12小时前", text: "听歌追剧一把抓，开一年才两百多块，美滴很，下回还来" },
  { name: "谢*", initial: "谢", region: "包头", service: "Netflix 4K", rating: 5, date: "一天前", text: "终于不用拼车了，独立车位看 4K 不被挤，画质音效都顶配，真带劲" },
  { name: "韩**", initial: "韩", region: "抚顺", service: "机场节点 · 无限套餐", rating: 5, date: "两天前", text: "全家整一起用真不限设备，路由器加手机加电视一起跑都没掉速，贼稳，698 一年无限流量贼值" },
  { name: "沈*", initial: "沈", region: "运城", service: "Disney+", rating: 5, date: "三天前", text: "之前在某宝被坑过几回，这次一年下来都很稳，决定再来续两年，真不赖" },
  { name: "姚**", initial: "姚", region: "中山", service: "Spotify 家庭版", rating: 5, date: "五天前", text: "家庭计划音质同歌单都齐，比某宝平一半，老板秒回客服，几靠谱" },
];

const SUPPORT_CHANNELS = [
  { label: "QQ", value: "2802632995", copyValue: "2802632995" },
  { label: "WhatsApp", value: "+1 4315093334", copyValue: "+1 4315093334" },
  { label: "Telegram", value: "@MaoyangSupport", copyValue: "@MaoyangSupport" },
];

const STATUS_LABEL = { received: "订单已收到", completed: "订单已完成", invalid: "订单无效·未收到付款" };

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

function paymentLabel(order) {
  if (order.paymentMethod === "redeem") return "兑换码";
  return order.paymentMethod === "usdt" ? "USDT" : "支付宝";
}

export default function ServiceCenterPage() {
  const [authUser, setAuthUser] = useState(null);
  const [authModal, setAuthModal] = useState(null);
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ a: 0, b: 0 });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemStatus, setRedeemStatus] = useState(null);
  const [queryInput, setQueryInput] = useState("");
  const [queryStatus, setQueryStatus] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResults, setQueryResults] = useState([]);
  const [queryDetailOrder, setQueryDetailOrder] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [copiedKey, setCopiedKey] = useState("");

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setAuthUser(d.ok ? { email: d.email, username: d.username, balance: Number(d.balance || 0) } : false))
      .catch(() => setAuthUser(false));
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = authModal ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [authModal]);

  useEffect(() => {
    if (authModal === "register") {
      setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
    }
    if (!authModal) setAuthForm({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  }, [authModal]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("redeem") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const order = params.get("order");
    if (code) {
      window.location.replace(`/?redeem=${encodeURIComponent(code)}#redeem`);
      return;
    }
    if (order && order.length > 4) {
      setQueryInput(order);
      setTimeout(() => runQuery(order), 100);
    }
  }, []);

  function normalizeRedeemCode(value) {
    return String(value || "").replace(/\s+/g, "").replace(/[＿_—–]/g, "-").toUpperCase();
  }

  async function pasteRedeem() {
    try {
      const text = await navigator.clipboard?.readText?.();
      const next = normalizeRedeemCode(text);
      if (!next) {
        setRedeemStatus({ type: "error", message: "剪贴板里没有可用的兑换码" });
        return;
      }
      setRedeemInput(next);
      if (redeemStatus?.type === "error") setRedeemStatus(null);
    } catch {
      setRedeemStatus({ type: "error", message: "无法读取剪贴板,请长按输入框手动粘贴" });
    }
  }

  async function submitRedeem(event) {
    event.preventDefault();
    const code = redeemInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      setRedeemStatus({ type: "error", message: "请输入兑换码" });
      return;
    }
    setRedeemBusy(true);
    setRedeemStatus({ type: "info", message: "正在识别兑换码..." });
    try {
      const infoRes = await fetch(`/api/redeem-code?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const info = await infoRes.json();
      if (!infoRes.ok || !info.ok || info.status !== "active") {
        setRedeemStatus({ type: "error", message: info.message || "兑换码不存在、已使用或已作废" });
        return;
      }
      if (info.type === "service") {
        window.location.href = `/checkout?redeem=${encodeURIComponent(code)}`;
        return;
      }
      if (!authUser || authUser === false) {
        setAuthModal("login");
        setAuthNotice("余额兑换码需要先登录账号,登录后再次点击兑换即可到账");
        setRedeemStatus({ type: "error", message: "余额兑换码需要登录账号后兑换" });
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
        setRedeemStatus({ type: "error", message: data.message || "兑换失败,请联系客服" });
        return;
      }
      setAuthUser((cur) => cur && cur !== false ? { ...cur, balance: Number(data.balance || cur.balance || 0) } : cur);
      setRedeemInput("");
      setRedeemStatus({ type: "success", message: `兑换成功,余额已到账，当前余额 ¥${Number(data.balance || 0).toFixed(2)}` });
    } catch {
      setRedeemStatus({ type: "error", message: "兑换失败,请稍后再试" });
    } finally {
      setRedeemBusy(false);
    }
  }

  async function doAuth(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      const endpoint = authModal;
      let payload = {};
      if (authModal === "login") payload = { email: authForm.email.trim(), password: authForm.password };
      if (authModal === "register") payload = {
        email: authForm.email.trim(),
        password: authForm.password,
        captchaA: authCaptcha.a,
        captchaB: authCaptcha.b,
        captchaAnswer: Number(authForm.captchaAnswer),
      };
      if (authModal === "forgot") payload = { email: authForm.email.trim() };
      if (authModal === "reset") payload = {
        email: authForm.email.trim(),
        code: authForm.code.trim(),
        newPassword: authForm.newPassword,
      };

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
        setAuthUser({ email: data.email });
        setAuthModal(null);
        return;
      }
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
      if (authModal === "register") setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
    } catch {
      setAuthError("网络错误");
    } finally {
      setAuthBusy(false);
    }
  }

  async function runQuery(query) {
    const value = String(query || "").trim();
    if (!value) {
      setQueryStatus({ type: "error", message: "请输入完整订单号或下单邮箱" });
      setQueryResults([]);
      return;
    }
    setQueryLoading(true);
    setQueryStatus({ type: "info", message: "正在查询订单..." });
    try {
      const response = await fetch("/api/order-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: value }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "query_failed");
      if (!data.configured) {
        setQueryResults([]);
        setQueryStatus({ type: "error", message: "订单存储尚未连接，请联系在线客服查询" });
        return;
      }
      const orders = data.orders || [];
      setQueryResults(orders);
      const orderIdMatch = orders.find((o) => o.matchType === "orderId");
      if (orderIdMatch) setQueryDetailOrder(orderIdMatch);
      setQueryStatus({
        type: orders.length ? "success" : "error",
        message: orders.length
          ? orderIdMatch ? "已通过订单号查询到订单" : `已找到 ${orders.length} 条订单,点击查看详情`
          : "未查询到订单,请核对订单号或邮箱",
      });
    } catch {
      setQueryResults([]);
      setQueryStatus({ type: "error", message: "查询失败，请稍后再试或联系在线客服" });
    } finally {
      setQueryLoading(false);
    }
  }

  function submitQuery(event) {
    event.preventDefault();
    runQuery(queryInput);
  }

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1600);
  }

  const queryItems = useMemo(() => {
    if (!queryDetailOrder) return [];
    return Array.isArray(queryDetailOrder.items) && queryDetailOrder.items.length
      ? queryDetailOrder.items
      : [{
          service: queryDetailOrder.service,
          label: queryDetailOrder.serviceLabel,
          cycle: queryDetailOrder.cycle,
          amount: queryDetailOrder.finalAmount,
          account: queryDetailOrder.account,
          password: queryDetailOrder.password,
        }];
  }, [queryDetailOrder]);

  return (
    <div className="page-shell service-page-shell">
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="返回首页">
            <img src="/logo.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">服务产品</Link>
            <Link href="/#layout">下单流程</Link>
            <Link href="#order-query">订单查询</Link>
            <Link href="#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main className="main-content service-main">
        <section className="section container service-title-section">
          <Link href="/" className="shop-back-link"><ArrowLeft size={14} />返回首页</Link>
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">服务中心</div>
              <h1 className="section-title">服务中心</h1>
              <p className="section-note">订单查询、售后支持与在线客服</p>
            </div>
          </div>
        </section>

        <section className="section container service-tools-section">
          <div className="service-single-column">
            <div id="order-query" className="query-pair-block order-query-section">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">订单查询</div>
                  <h2 className="section-title">订单查询</h2>
                </div>
              </div>
              <div className="order-query-panel">
                <form className="order-query-form" onSubmit={submitQuery}>
                  <label className="order-query-field">
                    <span>完整订单号 / 下单邮箱</span>
                    <input
                      value={queryInput}
                      onChange={(e) => setQueryInput(e.target.value)}
                      placeholder="输入完整订单号或下单时填写的邮箱"
                      autoComplete="off"
                    />
                  </label>
                  <button type="submit" className="primary-btn" disabled={queryLoading}>
                    {queryLoading ? <LoaderCircle size={15} className="spin-icon" /> : <Search size={16} />}
                    查询订单
                  </button>
                </form>
                {queryStatus && <div className={`query-status ${queryStatus.type}`}>{queryStatus.message}</div>}
                {queryResults.length > 0 && (
                  <div className="query-results-compact">
                    {queryResults.map((order) => (
                      <button key={order.orderId} type="button" className="query-result-row" onClick={() => setQueryDetailOrder(order)}>
                        <div className="query-result-row-main">
                          <strong>{order.serviceLabel || "订单"}</strong>
                          <span>{order.email}</span>
                        </div>
                        <div className="query-result-row-meta">
                          <span>{STATUS_LABEL[order.status] || order.status}</span>
                          <b>¥{Number(order.finalAmount || order.paidAmount || 0).toFixed(2)}</b>
                        </div>
                        <ArrowRight size={14} className="query-result-row-arrow" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
        </section>

        <section id="assurance" className="section container assurance-section">
          <div className="section-head simple-head assurance-head">
            <div>
              <div className="section-kicker">服务保障</div>
              <h2 className="section-title">服务保障体系</h2>
            </div>
          </div>
          <div className="assurance-grid">
            {ASSURANCE_CARDS.map(({ title, desc, meta, icon: Icon }) => (
              <article key={title} className="glass-card assurance-card">
                <div className="assurance-card-title">
                  <span className="assurance-card-icon"><Icon size={18} /></span>
                  {title}
                </div>
                <p>{desc}</p>
                <small>{meta}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="section container contact-section">
          <div className="faq-contact-pair">
            <div id="faq" className="faq-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">常见问题</div>
                  <h2 className="section-title">常见问题</h2>
                </div>
              </div>
              <div className="faq-list">
                {FAQ.map((faq, index) => {
                  const open = faqOpen === index;
                  return (
                    <div key={faq.q} className={`faq-card${open ? " faq-open" : ""}`}>
                      <button className="faq-button" onClick={() => setFaqOpen(open ? -1 : index)}>
                        {faq.q}
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
                  <div className="section-kicker">在线联系</div>
                  <h2 className="section-title">联系我们</h2>
                </div>
              </div>
              <div className="channels-grid channels-row">
                {SUPPORT_CHANNELS.map((ch) => {
                  const kind = ch.label.toLowerCase();
                  const BrandIcon = kind === "qq" ? QQBrandIcon : kind === "whatsapp" ? WhatsAppBrandIcon : TelegramBrandIcon;
                  return (
                    <div key={ch.label} className="glass-card channel-card">
                      <span className={`channel-icon-wrap ${kind}`} aria-hidden="true"><BrandIcon /></span>
                      <div className="channel-label">{ch.label}</div>
                      <div className="channel-value">{ch.value}</div>
                      <button
                        className={`channel-copy-btn${copiedKey === ch.label ? " copied" : ""}`}
                        onClick={() => handleCopy(ch.copyValue, ch.label)}
                      >
                        <Copy size={14} />{copiedKey === ch.label ? "已复制" : "复制"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer service-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">冒央会社 · Maoyang Taiwan Inc</div>
            <div className="footer-sub">liumeiti.vip · joinvip.vip</div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">地址：台湾新北市板桥区远东路1号3-218</div>
            <div className="footer-pill">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      {authModal && (
        <div className="auth-modal-mask" onClick={() => !authBusy && setAuthModal(null)}>
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
                <div className="auth-modal-title">{authModal === "forgot" ? "找回密码" : "重置密码"}</div>
              )}
              <button type="button" className="auth-close" onClick={() => !authBusy && setAuthModal(null)}>
                <X size={19} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>邮箱</span>
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="example@email.com" required />
              </label>
              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field">
                  <span>{authModal === "register" ? "密码 (6-64 位)" : "密码"}</span>
                  <input type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder={authModal === "register" ? "设置一个密码" : "登录密码"} required />
                </label>
              )}
              {authModal === "register" && (
                <label className="auth-field auth-captcha">
                  <span>人机验证</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-question">{authCaptcha.a} + {authCaptcha.b} =</div>
                    <input value={authForm.captchaAnswer} onChange={(e) => setAuthForm((f) => ({ ...f, captchaAnswer: e.target.value }))} placeholder="?" inputMode="numeric" required />
                    <button type="button" className="auth-captcha-refresh" onClick={() => setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) })}>
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </label>
              )}
              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>验证码</span>
                    <input value={authForm.code} onChange={(e) => setAuthForm((f) => ({ ...f, code: e.target.value }))} placeholder="6 位验证码" inputMode="numeric" required />
                  </label>
                  <label className="auth-field">
                    <span>新密码</span>
                    <input type="password" value={authForm.newPassword} onChange={(e) => setAuthForm((f) => ({ ...f, newPassword: e.target.value }))} placeholder="设置新密码" required />
                  </label>
                </>
              )}
              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}
              <button type="submit" className="auth-submit" disabled={authBusy}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />处理中</> : authModal === "register" ? "注册并登录" : authModal === "forgot" ? "发送验证码" : authModal === "reset" ? "重置并登录" : "登录"}
              </button>
              {(authModal === "login" || authModal === "register") && (
                <>
                  <div className="auth-divider"><span>或使用</span></div>
                  <div className="oauth-login-grid bottom">
                    <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />Google 登录</a>
                  </div>
                </>
              )}
              <div className="auth-hints">
                {authModal === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>忘记密码?</button>
                    <span className="auth-hint">还没账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("register")}>立即注册</button></span>
                  </>
                )}
                {authModal === "register" && <span className="auth-hint">已有账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>去登录</button></span>}
                {authModal === "forgot" && <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>返回登录</button>}
                {authModal === "reset" && <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>重新发送验证码</button>}
              </div>
            </form>
          </div>
        </div>
      )}

      {queryDetailOrder && (
        <div className="modal-mask" onClick={() => setQueryDetailOrder(null)}>
          <div className="query-modal" onClick={(e) => e.stopPropagation()}>
            <div className="query-modal-head">
              <div>
                <div className="section-kicker">订单详情</div>
                <div className="query-modal-title">订单详情</div>
                <code className="query-modal-id">{queryDetailOrder.orderId}</code>
                <div className={`query-modal-status status-${queryDetailOrder.status || "received"}`}>
                  {STATUS_LABEL[queryDetailOrder.status] || queryDetailOrder.status}
                </div>
              </div>
              <button className="close-btn" onClick={() => setQueryDetailOrder(null)} aria-label="关闭"><X size={20} /></button>
            </div>
            <div className="query-modal-body">
              <div className="query-modal-amount">
                <span>实付金额</span>
                <b>{queryDetailOrder.paidCurrency === "USDT" ? `${queryDetailOrder.paidAmount} USDT` : queryDetailOrder.paidCurrency === "CODE" ? "服务兑换码" : `¥${Number(queryDetailOrder.paidAmount || queryDetailOrder.finalAmount || 0).toFixed(2)}`}</b>
                <em>{paymentLabel(queryDetailOrder)}</em>
              </div>
              <div className="query-modal-items">
                <div className="query-modal-items-label">商品明细 · {queryItems.length} 件</div>
                {queryItems.map((item, idx) => (
                  <div key={idx} className="query-modal-item">
                    <div className="query-modal-item-head">
                      <strong>{item.label || "订单商品"}</strong>
                      <span>¥{Number(item.amount || 0).toFixed(2)}</span>
                    </div>
                    {(item.account || item.password) && (
                      <div className="query-modal-item-creds">
                        {item.account && <div><span>{item.service === "rocket" ? "用户名" : "账号"}</span><code>{item.account}</code></div>}
                        {item.password && <div><span>密码</span><code>{item.password}</code></div>}
                      </div>
                    )}
                    {item.subscriptionLinks && (
                      <div className="query-modal-item-subs">
                        <button className="query-modal-sub-row" onClick={() => handleCopy(item.subscriptionLinks.shadowrocket, `sr-${idx}`)}>
                          <span>Shadowrocket</span><small>{item.subscriptionLinks.shadowrocket}</small><em>{copiedKey === `sr-${idx}` ? "已复制" : "复制"}</em>
                        </button>
                        <button className="query-modal-sub-row" onClick={() => handleCopy(item.subscriptionLinks.clash, `cl-${idx}`)}>
                          <span>Clash</span><small>{item.subscriptionLinks.clash}</small><em>{copiedKey === `cl-${idx}` ? "已复制" : "复制"}</em>
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
                <div><span>下单时间</span><b>{queryDetailOrder.createdAtBeijing || "--"}</b></div>
                <div><span>完成时间</span><b>{queryDetailOrder.completedAtBeijing || "--"}</b></div>
                <div><span>邮箱</span><b>{queryDetailOrder.email || "--"}</b></div>
                <div><span>联系方式</span><b>{queryDetailOrder.contact || "--"}</b></div>
                {queryDetailOrder.remark && <div className="query-modal-row-wide"><span>备注</span><b className="query-modal-remark">{queryDetailOrder.remark}</b></div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <MobileNav />
    </div>
  );
}
