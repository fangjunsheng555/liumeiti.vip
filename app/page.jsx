"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Headphones,
  Image as ImageIcon,
  LayoutPanelTop,
  LoaderCircle,
  MessageCircleMore,
  QrCode,
  Search,
  Sparkles,
  Users,
  Award,
  TrendingUp,
  Clock,
  X,
} from "lucide-react";

const SITE_CONTENT = {
  brandCn: "冒央会社",
  brandEn: "MAOYANG",
  domain: "liumeiti.vip",
  heroBadge: "来自中国台湾，专注流媒体会员服务",
  heroTitleLine1: "冒央会社",
  heroTitleHighlight: " · Maoyang Taiwan Inc",
  heroDesc:
    "自2020年从事会员服务，以全网最低的价格为客人带来最优质的会员体验。在国内外各大平台均开设店铺，累计服务50万+客户，服务案例超100万，百分百好评无一差评！",
  heroStats: [
    { num: "500,000+", label: "累计用户", icon: Users },
    { num: "1,000,000+", label: "服务案例", icon: TrendingUp },
    { num: "Top 3", label: "行业排名", icon: Award },
    { num: "2020至今", label: "专注服务", icon: Clock },
  ],
  topCards: [
    ["服务类别", "Spotify，Netflix，Disney+，Hbomax，网络服务等"],
    ["公司规模", "设有充值部门售后部门共26人，实时为用户提供优质服务，行业Top3"],
    ["价格优势", "源头会员供应，没有任何中间商赚取差价"],
    ["服务特点", "低价稳定优质，注重用户使用体验"],
  ],
  layoutCards: [
    ["选择所需服务", "Spotify / Netflix / Disney+ / Hbomax / 机场节点"],
    ["查看详情介绍", "请认真查阅我们的服务介绍，确保服务满足您的需求"],
    ["付款下单", "填写联系方式后扫码付款，付款完成提交订单，工作人员将在30分钟内处理"],
    ["售后服务", "成交只是开始，专业团队全程售后保障用户使用体验"],
  ],
  faq: [
    {
      q: "是否支持售后服务？",
      a: "支持。我们支持7天无理由退款，并且提供在线客服协助、问题排查与订单服务咨询，如您有任何问题，随时联系我们的在线客服团队。",
    },
    {
      q: "如何联系在线客服？",
      a: "可通过 QQ、WhatsApp、Telegram 与我们联系，在线时间为北京时间早 9 点至晚 11 点。",
    },
    {
      q: "关于我们？",
      a: "冒央会社来自中国台湾，长期专注流媒体会员服务、使用指导、售后协助。我们重视响应速度、服务体验与长期口碑，持续为用户提供廉价、稳定、优质的服务。",
    },
    {
      q: "是否可以定制企业或团队方案？",
      a: "可以。我们全网拥有200+代理合作伙伴，若你有长期合作、批量需求或企业场景，可联系客服进一步沟通。",
    },
  ],
  supportChannels: [
    { label: "QQ", value: "2802632995", copyValue: "2802632995" },
    { label: "WhatsApp", value: "+1 431 509 3334", copyValue: "+1 4315093334" },
    { label: "Telegram", value: "+44 770 748 9977", copyValue: "+44 7707489977" },
  ],
  supportHours: "在线时间：北京时间 09:00 – 23:00",
  footerRecord: "地址：台灣新北市板橋區遠東路1號3號218",
  footerNote: "Copyright © 2026 Maoyang Taiwan Inc. All rights reserved",
};

const PRODUCTS = [
  {
    key: "spotify",
    image: "/products/spotify.jpg",
    title: "Spotify",
    subtitle: "欧美日高价区家庭计划",
    amount: 128,
    cycle: "1年",
    price: "仅需¥128/年",
    shortIntro: "无损音质，播客，AIDJ，完整曲库，有声读物，合辑歌单等",
    highlights: ["功能齐全", "稳定使用", "售后保障"],
    detailTitle: "欧美日高价区家庭计划，一年仅128元包售后",
    detailBody:
      "支持无损音质，收听播客，离线下载，合辑歌单，有声读物，曲库完整，如需订阅个人/双人/六人家庭请联系在线客服",
    orderTitle: "Spotify · 支付宝扫码支付 ¥128",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "netflix",
    image: "/products/netflix.jpg",
    title: "Netflix",
    subtitle: "4K杜比套餐，独立车位",
    amount: 168,
    cycle: "1年",
    price: "仅需¥168/年",
    shortIntro: "全球可用顶规套餐，4K画质，杜比音效，一人一位可上锁",
    highlights: ["4K画质", "杜比音效", "售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅168包售后",
    detailBody:
      "4K杜比最高级别套餐，高峰不排队不被挤，一人独享一个位置，最高4K画质，支持杜比音效，离线下载，位置可上pin，五人一车一人一位互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Netflix · 支付宝扫码支付 ¥168",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "disney",
    image: "/products/disney.jpg",
    title: "Disney+",
    subtitle: "独立车位全球可用4K杜比套餐",
    amount: 108,
    cycle: "1年",
    price: "仅需¥108/年",
    shortIntro: "4人一车绝不超售，全球可用4K杜比套餐，一人一位置互不干扰",
    highlights: ["4K杜比", "位置上锁", "不被挤不排队"],
    detailTitle: "最高级别套餐，独立车位，一年仅108包售后",
    detailBody:
      "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，4人一车绝不超售，高峰不排队不被挤，位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Disney+ · 支付宝扫码支付 ¥108",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "max",
    image: "/products/hbomax.jpg",
    title: "HBO Max",
    subtitle: "独立车位全球可用4K杜比套餐",
    amount: 148,
    cycle: "1年",
    price: "仅需¥148/年",
    shortIntro: "4人车全球可用4K杜比套餐，一人独享一位置互不干扰高峰不排队",
    highlights: ["4K杜比", "全球可用", "实时售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅148包售后",
    detailBody:
      "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，4人一车绝不超售，高峰不排队不被挤，位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "HBO Max · 支付宝扫码支付 ¥148",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "rocket",
    image: "/products/rocket.jpg",
    title: "机场节点",
    subtitle: "不限设备·不限流量·最高5Gbps·解锁全球平台",
    amount: 98,
    cycle: "1年",
    needsUsername: true,
    price: "仅需¥98/年",
    shortIntro: "大厂机房多线路，最高5Gbps带宽，解锁所有流媒体/AI/社交软件，高峰不卡顿",
    highlights: ["不限设备/流量", "高速稳定多节点", "全加密无日志"],
    detailTitle: "大厂机房多线路，不限设备不限流量，年仅¥98",
    detailBody:
      "优选大厂VPS，多线路港日台韩新美英德法等，不限制设备，不限制流量，最高速率可达5Gbps，高峰不拥堵不卡顿，解锁所有主流流媒体/AI软件/社交软件，全加密协议无日志隐私保障，实时维护24×7线路不中断",
    orderTitle: "机场节点 · 支付宝扫码支付 ¥98",
    orderBody:
      "请在支付完成后点击付款完成提交订单，系统自动将为你生成订阅链接。",
    qrImage: "/payment/alipay.jpg",
  },
];

function copyText(text) {
  if (typeof window === "undefined") return;
  const fallbackCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function money(amount) {
  return "¥" + Number(amount || 0).toFixed(0);
}

function blankOrderForm() {
  return { account: "", password: "", contact: "", username: "", remark: "" };
}

function validUsername(value) {
  return /^[A-Za-z0-9]{4,10}$/.test(String(value || "").trim());
}

function needsAccountPassword(product) {
  return product?.key === "spotify";
}

function orderTime(order) {
  if (order.createdAtBeijing) return order.createdAtBeijing;
  if (!order.createdAt) return "";
  return new Date(order.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) + " 北京时间";
}

function paymentLabel(order) {
  return order.paymentMethod === "usdt" ? "USDT" : "支付宝";
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

export default function Page() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [orderPreviewOpen, setOrderPreviewOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [orderStep, setOrderStep] = useState("form");
  const [orderForm, setOrderForm] = useState(blankOrderForm);
  const [orderStatus, setOrderStatus] = useState(null);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [queryStatus, setQueryStatus] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResults, setQueryResults] = useState([]);
  const [expandedOrderId, setExpandedOrderId] = useState("");

  const selectedProduct = useMemo(
    () => PRODUCTS.find((item) => item.key === selectedKey) || null,
    [selectedKey]
  );
  const submittedLinks = useMemo(
    () => selectedProduct?.needsUsername ? subscriptionLinks(orderForm.username) : null,
    [orderForm.username, selectedProduct]
  );

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  function closeProduct() {
    setSelectedKey(null);
    setOrderPreviewOpen(false);
    setOrderStep("form");
    setOrderForm(blankOrderForm());
    setOrderStatus(null);
    setOrderSubmitting(false);
    setPasswordVisible(false);
  }

  function openOrder() {
    setOrderForm(blankOrderForm());
    setOrderStatus(null);
    setOrderStep("form");
    setPasswordVisible(false);
    setOrderPreviewOpen(true);
  }

  function closeOrder() {
    if (orderSubmitting) return;
    setOrderPreviewOpen(false);
    setOrderStep("form");
    setOrderStatus(null);
  }

  function updateOrderField(field, value) {
    setOrderForm((current) => ({ ...current, [field]: value }));
    if (orderStatus?.type === "error") setOrderStatus(null);
  }

  function validateOrder() {
    if (!orderForm.contact.trim()) {
      return "请填写联系方式，客服会用它核对订单并联系你。";
    }
    if (selectedProduct?.needsUsername && !validUsername(orderForm.username)) {
      return "请填写4-10位数字或字母用户名，区分大小写。";
    }
    if (needsAccountPassword(selectedProduct) && (!orderForm.account.trim() || !orderForm.password.trim())) {
      return "请填写需要开通 Spotify 的账号和密码。";
    }
    return "";
  }

  function goPayment(event) {
    event.preventDefault();
    const error = validateOrder();
    if (error) {
      setOrderStatus({ type: "error", message: error });
      return;
    }
    setOrderStatus(null);
    setOrderStep("pay");
  }

  async function submitOrder() {
    if (!selectedProduct || orderSubmitting) return;
    const error = validateOrder();
    if (error) {
      setOrderStatus({ type: "error", message: error });
      setOrderStep("form");
      return;
    }

    setOrderSubmitting(true);
    setOrderStatus({ type: "info", message: "正在提交订单..." });

    try {
      const response = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: selectedProduct.key,
          contact: orderForm.contact.trim(),
          account: selectedProduct.needsUsername ? orderForm.username.trim() : orderForm.account.trim(),
          password: needsAccountPassword(selectedProduct) ? orderForm.password.trim() : "",
          remark: orderForm.remark.trim(),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "submit_failed");
      setOrderStep("done");
      setOrderStatus({
        type: "success",
        message: "订单已提交成功，请耐心等待客服处理。",
        orderId: result.orderId,
      });
    } catch (error) {
      setOrderStatus({
        type: "error",
        message: "订单提交失败，请联系在线客服处理。",
      });
    } finally {
      setOrderSubmitting(false);
    }
  }

  async function submitQuery(event) {
    event.preventDefault();
    const query = queryInput.trim();
    if (!query) {
      setQueryStatus({ type: "error", message: "请输入完整订单号或联系方式。" });
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
      setQueryStatus({
        type: orders.length ? "success" : "error",
        message: orders.length
          ? orders.some((order) => order.matchType === "orderId")
            ? "已通过订单号查询到订单，详情已展开。"
            : "已找到 " + orders.length + " 条订单，点击摘要查看详情。"
          : "未查询到订单，请核对订单号或联系方式。",
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
          <a href="#top" className="brand-wrap">
            <div className="brand-logo">
              <span className="brand-logo-mini">MY</span>
              <span className="brand-logo-cn">冒央</span>
            </div>
            <div>
              <div className="brand-en">{SITE_CONTENT.brandEn}</div>
              <div className="brand-cn">{SITE_CONTENT.brandCn}</div>
            </div>
          </a>

          <nav className="desktop-nav">
            <a href="#products">服务产品</a>
            <a href="#layout">下单流程</a>
            <a href="#order-query">订单查询</a>
            <a href="#faq">FAQ</a>
            <a href="#contact">联系我们</a>
          </nav>

        </div>
      </header>

      <main id="top" className="main-content">

        {/* ── Hero ── */}
        <section className="hero-section container">
          <div className="hero-badge">
            <Sparkles size={14} />
            {SITE_CONTENT.heroBadge}
          </div>

          <div className="hero-grid">
            <div>
              <h1 className="hero-title">
                {SITE_CONTENT.heroTitleLine1}
                <span className="hero-title-highlight">{SITE_CONTENT.heroTitleHighlight}</span>
              </h1>
              <p className="hero-desc">{SITE_CONTENT.heroDesc}</p>

              <div className="hero-actions">
                <a href="#products" className="primary-btn">
                  购买服务
                  <ArrowRight size={15} />
                </a>
                <a href="#order-query" className="secondary-btn">查询订单</a>
                <a href="#layout" className="secondary-btn">查看下单流程</a>
              </div>

              <div className="hero-stats">
                {SITE_CONTENT.heroStats.map(({ num, label, icon: Icon }) => (
                  <div key={label} className="stat-item">
                    <Icon size={18} className="stat-icon" />
                    <div className="stat-num">{num}</div>
                    <div className="stat-label">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="hero-cards-grid">
              {SITE_CONTENT.topCards.map(([title, desc]) => (
                <div key={title} className="glass-card small-card">
                  <div className="small-card-title">{title}</div>
                  <div className="small-card-desc">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Products ── */}
        <section id="products" className="section container">
          <div className="section-head">
            <div>
              <div className="section-kicker">Services</div>
              <h2 className="section-title">流媒体会员服务</h2>
            </div>
          </div>

          <div className="products-grid">
            {PRODUCTS.map((item) => (
              <article key={item.key} className="glass-card product-card">
                <div className="product-card-top">
                  <div>
                    <div className="tiny-pill">服务名称</div>
                    <div className="product-name">{item.title}</div>
                    <div className="product-subtitle">{item.subtitle}</div>
                  </div>
                  <img src={item.image} alt={item.title} className="product-image" />
                </div>

                <div className="price-box">{item.price}</div>
                <div className="intro-box">{item.shortIntro}</div>

                <div className="bullet-list">
                  {item.highlights.map((bullet) => (
                    <div key={bullet} className="bullet-item">
                      <BadgeCheck size={15} />
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>

                <button className="primary-btn left-btn" onClick={() => setSelectedKey(item.key)}>
                  立即购买
                  <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>
        </section>

        {/* ── Order Process ── */}
        <section id="layout" className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Place Guide</div>
              <h2 className="section-title">下单流程介绍</h2>
            </div>
          </div>

          <div className="layout-grid">
            {SITE_CONTENT.layoutCards.map(([title, desc], idx) => {
              const icons = [LayoutPanelTop, ImageIcon, QrCode, MessageCircleMore];
              const Icon = icons[idx];
              return (
                <div key={title} className="glass-card info-card">
                  <div className="info-step">{String(idx + 1).padStart(2, "0")}</div>
                  <Icon size={30} className="info-icon" />
                  <div className="info-title">{title}</div>
                  <div className="info-desc">{desc}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Order Query ── */}
        <section id="order-query" className="section container order-query-section">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Order Lookup</div>
              <h2 className="section-title">订单查询</h2>
            </div>
          </div>

          <div className="order-query-panel">
            <form className="order-query-form" onSubmit={submitQuery}>
              <label className="order-query-field">
                <span>订单号 / 联系方式</span>
                <input
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  placeholder="输入完整订单号或下单联系方式"
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
              <div className="query-results">
                {queryResults.map((order) => {
                  const forceExpanded = order.matchType === "orderId";
                  const expanded = forceExpanded || expandedOrderId === order.orderId;
                  const serviceText = order.serviceLabel || order.service || "订单";
                  const actionText = forceExpanded ? "完整详情" : expanded ? "收起详情" : "查看详情";
                  return (
                    <article key={order.orderId} className={`query-result${expanded ? " open" : ""}`}>
                      <button
                        type="button"
                        className="query-result-head"
                        onClick={() => {
                          if (!forceExpanded) setExpandedOrderId(expanded ? "" : order.orderId);
                        }}
                      >
                        <span className="query-service-summary">
                          <small>购买服务</small>
                          <b>{serviceText}</b>
                        </span>
                        <span className="query-muted-summary">
                          <small>订单号</small>
                          <b>{order.orderId}</b>
                        </span>
                        <span className="query-muted-summary">
                          <small>{orderTime(order)}</small>
                          <b>{money(order.finalAmount)} · {paymentLabel(order)}</b>
                        </span>
                        <em>{actionText}</em>
                      </button>

                      {expanded && (
                        <div className="query-detail">
                          <div><span>服务</span><b>{order.serviceLabel || "--"}</b></div>
                          <div><span>周期</span><b>{order.cycle || "--"}</b></div>
                          <div><span>支付方式</span><b>{paymentLabel(order)}</b></div>
                          <div><span>应付金额</span><b>{money(order.finalAmount)}</b></div>
                          {order.account && (
                            <div><span>{order.service === "rocket" ? "用户名" : "账号"}</span><b>{order.account}</b></div>
                          )}
                          {order.password && (
                            <div><span>密码</span><b>{order.password}</b></div>
                          )}
                          <div><span>联系方式</span><b>{order.contact || "--"}</b></div>
                          <div className="query-detail-wide"><span>备注</span><b>{order.remark || "无"}</b></div>
                          {order.subscriptionLinks && (
                            <div className="query-detail-wide">
                              <span>订阅链接</span>
                              <div className="query-subscriptions">
                                <button
                                  type="button"
                                  onClick={() => handleCopy(order.subscriptionLinks.shadowrocket, "query-shadowrocket-" + order.orderId)}
                                >
                                  <span>
                                    <strong>shadowrocket小火箭订阅</strong>
                                    <small>{order.subscriptionLinks.shadowrocket}</small>
                                  </span>
                                  <em>{copiedKey === "query-shadowrocket-" + order.orderId ? "已复制" : "复制链接"}</em>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCopy(order.subscriptionLinks.clash, "query-clash-" + order.orderId)}
                                >
                                  <span>
                                    <strong>Clash订阅</strong>
                                    <small>{order.subscriptionLinks.clash}</small>
                                  </span>
                                  <em>{copiedKey === "query-clash-" + order.orderId ? "已复制" : "复制链接"}</em>
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* ── FAQ ── */}
        <section id="faq" className="section container">
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
        </section>

        {/* ── Contact ── */}
        <section id="contact" className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Contact Us</div>
              <h2 className="section-title">联系我们</h2>
            </div>
          </div>

          <div className="channels-grid">
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

          <div className="contact-bottom">
            <div className="glass-card hours-card">
              <Headphones size={22} className="info-icon" />
              <div className="hours-label">客服在线时间</div>
              <div className="hours-value">北京时间 09:00 – 23:00</div>
            </div>
            <div className="glass-card legal-card">
              <div className="tiny-pill support-pill">
                <Globe size={13} />
                补充说明
              </div>
              <p className="note-text">
                冒央会社所有从事服务均符合中国大陆与台湾法律法规，使用过程任何问题请联系我们的在线客服人员。
              </p>
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
          className="floating-button"
          onClick={() => setContactOpen((v) => !v)}
          aria-label="打开客服菜单"
        >
          {contactOpen ? <X size={22} /> : <Headphones size={22} />}
        </button>
      </div>

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
                  <button className="primary-btn" onClick={openOrder}>
                    点击下单
                    <ArrowRight size={15} />
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

      {/* ── Order / Payment Modal ── */}
      {selectedProduct && orderPreviewOpen && (
        <div className="modal-mask second-mask" onClick={closeOrder}>
          <div
            className={`modal-card modal-medium${orderStep === "form" ? " order-modal-form" : ""}${orderStep === "pay" ? " order-modal-pay" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <div className="section-kicker">Place Order</div>
                <div className="modal-title">
                  {orderStep === "form" && "填写订单信息"}
                  {orderStep === "pay" && "支付宝扫码付款"}
                  {orderStep === "done" && "订单已提交"}
                </div>
              </div>
              <button className="close-btn" onClick={closeOrder} disabled={orderSubmitting}>
                <X size={17} />
              </button>
            </div>

            <div className={`order-modal-body${orderStep === "form" ? " order-form-body" : ""}${orderStep === "pay" ? " order-pay-body" : ""}`}>
              <div className="order-flow">
                {["填写信息", "扫码付款", "提交订单"].map((label, index) => {
                  const stepIndex = orderStep === "form" ? 0 : orderStep === "pay" ? 1 : 2;
                  return (
                    <div
                      key={label}
                      className={`order-flow-step${index < stepIndex ? " done" : ""}${index === stepIndex ? " active" : ""}`}
                    >
                      <b>{index + 1}</b>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>

              {orderStatus && (
                <div className={`order-status ${orderStatus.type}`}>
                  {orderStatus.message}
                  {orderStatus.orderId && <strong>订单号：{orderStatus.orderId}</strong>}
                </div>
              )}

              {orderStep === "form" && (
                <form className="order-form" onSubmit={goPayment}>
                  <div className="order-summary-card">
                    <div>
                      <span>服务</span>
                      <b>{selectedProduct.title}</b>
                    </div>
                    <div>
                      <span>周期</span>
                      <b>{selectedProduct.cycle}</b>
                    </div>
                    <div>
                      <span>应付</span>
                      <b>{money(selectedProduct.amount)}</b>
                    </div>
                    <div>
                      <span>支付方式</span>
                      <b>支付宝</b>
                    </div>
                  </div>

                  {selectedProduct.needsUsername && (
                    <label className="order-field">
                      <span>设置你的用户名</span>
                      <input
                        value={orderForm.username}
                        onChange={(event) => updateOrderField("username", event.target.value)}
                        placeholder="4-10位数字或字母，区分大小写"
                        autoComplete="username"
                        required
                      />
                    </label>
                  )}

                  {needsAccountPassword(selectedProduct) && (
                    <div className="order-field-grid">
                      <label className="order-field">
                        <span>Spotify账号</span>
                        <input
                          value={orderForm.account}
                          onChange={(event) => updateOrderField("account", event.target.value)}
                          placeholder="需要开通的 Spotify 账号"
                          autoComplete="username"
                          required
                        />
                      </label>
                      <label className="order-field">
                        <span>Spotify密码</span>
                        <div className="password-input-wrap">
                          <input
                            type={passwordVisible ? "text" : "password"}
                            value={orderForm.password}
                            onChange={(event) => updateOrderField("password", event.target.value)}
                            placeholder="账号密码"
                            autoComplete="current-password"
                            required
                          />
                          <button
                            type="button"
                            className="password-eye-btn"
                            onClick={() => setPasswordVisible((visible) => !visible)}
                            aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                            title={passwordVisible ? "隐藏密码" : "显示密码"}
                          >
                            {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                      </label>
                    </div>
                  )}

                  <label className="order-field contact-field">
                    <div className="order-field-label-row">
                      <span>联系方式</span>
                      <small className="contact-note">
                        *请准确填写，可用于订单核实与日后查询。
                      </small>
                    </div>
                    <input
                      value={orderForm.contact}
                      onChange={(event) => updateOrderField("contact", event.target.value)}
                      placeholder="QQ / 微信 / WhatsApp / Telegram"
                      autoComplete="tel"
                      required
                    />
                  </label>

                  <label className="order-field">
                    <span>备注（非必填）</span>
                    <textarea
                      value={orderForm.remark}
                      onChange={(event) => updateOrderField("remark", event.target.value)}
                      placeholder="地区、特殊需求或付款备注"
                      rows={3}
                    />
                  </label>

                  <div className="order-actions">
                    <button type="button" className="secondary-btn" onClick={() => setOrderPreviewOpen(false)}>
                      返回详情
                    </button>
                    <button type="submit" className="primary-btn">
                      前往支付
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </form>
              )}

              {orderStep === "pay" && (
                <div className="modal-grid second-grid payment-grid">
                  <div className="qr-box-wrap">
                    <div className="qr-label">Alipay · 支付宝扫一扫</div>
                    <div className="qr-box">
                      {selectedProduct.qrImage ? (
                        <img
                          src={selectedProduct.qrImage}
                          alt="支付二维码"
                          className="qr-image"
                        />
                      ) : (
                        <div className="qr-placeholder">
                          <QrCode size={52} />
                          <div>二维码加载中</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="payment-side">
                    <div className="detail-title">{selectedProduct.orderTitle}</div>
                    <div className="detail-body">{selectedProduct.orderBody}</div>
                    <div className="pay-amount-card">
                      <span>应付金额</span>
                      <b>{money(selectedProduct.amount)}</b>
                    </div>
                    <div className="notice-box">
                      {selectedProduct.needsUsername
                        ? "请在支付完成后点击付款完成提交订单，系统自动将为你生成订阅链接。"
                        : "请按页面金额完成支付宝付款，付款后点击下方按钮提交订单。"}
                    </div>
                    <div className="order-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setOrderStep("form")}
                        disabled={orderSubmitting}
                      >
                        返回修改
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={submitOrder}
                        disabled={orderSubmitting}
                      >
                        {orderSubmitting ? (
                          <>
                            <LoaderCircle size={15} className="spin-icon" />
                            正在提交
                          </>
                        ) : (
                          <>
                            付款完成，提交订单
                            <ArrowRight size={15} />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {orderStep === "done" && (
                <div className="order-done">
                  <CheckCircle2 size={48} />
                  <h3>提交成功</h3>
                  <p>订单已实时推送给客服，请等待处理。</p>
                  {selectedProduct.needsUsername && submittedLinks && (
                    <div className="subscription-wrap">
                      <div className="subscription-note">
                        请复制并妥善保存好你的订阅链接
                      </div>
                      <div className="subscription-links">
                        <div className="subscription-link-row">
                          <a href={submittedLinks.shadowrocket} target="_blank" rel="noopener noreferrer">
                            <strong>shadowrocket小火箭订阅：</strong>
                            <span>{submittedLinks.shadowrocket}</span>
                          </a>
                          <button
                            type="button"
                            className="subscription-copy-btn"
                            onClick={() => handleCopy(submittedLinks.shadowrocket, "shadowrocket-sub")}
                          >
                            <Copy size={14} />
                            {copiedKey === "shadowrocket-sub" ? "已复制" : "复制"}
                          </button>
                        </div>
                        <div className="subscription-link-row">
                          <a href={submittedLinks.clash} target="_blank" rel="noopener noreferrer">
                            <strong>Clash订阅：</strong>
                            <span>{submittedLinks.clash}</span>
                          </a>
                          <button
                            type="button"
                            className="subscription-copy-btn"
                            onClick={() => handleCopy(submittedLinks.clash, "clash-sub")}
                          >
                            <Copy size={14} />
                            {copiedKey === "clash-sub" ? "已复制" : "复制"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="order-actions center-actions">
                    <button type="button" className="primary-btn" onClick={closeProduct}>
                      完成
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
