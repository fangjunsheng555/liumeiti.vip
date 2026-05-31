"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Clock,
  Headphones,
  Lock,
  Megaphone,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
  Users,
  Award,
  Zap,
  Star,
} from "lucide-react";
import MobileNav from "./components/MobileNav";
import RedeemCard from "./components/RedeemCard";
import FloatingSupport from "./components/FloatingSupport";

const OPERATION_SLOT_MINUTES = 10;
const OPERATION_SLOTS_PER_DAY = 24 * 60 / OPERATION_SLOT_MINUTES;
const OPERATION_INITIAL_METRICS = {
  processedToday: "968单",
  averageResponse: "<1分钟",
  queueCount: "8单",
  serviceYears: "近6年",
};

const HERO_STATS = [
  { metric: "processedToday", label: "今日已处理订单", icon: TrendingUp },
  { metric: "averageResponse", label: "平均响应时间", icon: Clock },
  { metric: "queueCount", label: "当前排队数量", icon: Users },
  { metric: "serviceYears", label: "服务运行年限", icon: Award },
];

const TRUST_ITEMS = [
  { icon: ShieldCheck, title: "官方授权", desc: "安全稳定" },
  { icon: Users, title: "专业团队", desc: "7x24在线" },
  { icon: BadgeCheck, title: "即时响应", desc: "秒级开通" },
  { icon: Lock, title: "隐私保护", desc: "放心使用" },
];

const LAYOUT_CARDS = [
  ["选择服务", "选购会员、节点服务，或使用服务码进入开通"],
  ["填写资料", "按服务要求填写邮箱、联系方式与开通资料"],
  ["确认提交", "核对信息并完成支付，服务码订单可直接提交"],
  ["查看进度", "开通通知与售后进度可在服务中心查询"],
];

const TESTIMONIALS = [
  { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "9小时前", text: "看流媒体4K 不缓冲，日常使用其他app也很流畅。普通套餐一年 128，50GB/月真实流量够日常用了" },
  { name: "張*", initial: "張", region: "香港", service: "Disney+", rating: 5, date: "一天前", text: "本来还在犹豫，下单完 10 分钟就能用了，体验很顶。已经推荐给好几个朋友" },
  { name: "Yammy***", initial: "Y", region: "伦敦", service: "HBO Max", rating: 5, date: "三天前", text: "第一次买怕被骗，结果非常正规，客服全程指导，账号到现在用了半年都很稳" },
  { name: "李**", initial: "李", region: "北京", service: "Spotify+Netflix 4K+机场节点", rating: 5, date: "一周前", text: "组合下单还便宜了一些，听歌刷剧科学上网一站搞定，售后也跟上了，下次还来" },
];

const TESTIMONIALS_PER_PAGE = 4;
const TESTIMONIALS_INTERVAL_MS = 5500;

const LIVE_ORDERS = [
  { city: "上海", name: "刘**", product: "Spotify 家庭版", time: "刚刚" },
  { city: "广州", name: "王*", product: "Netflix 4K 杜比", time: "2 分钟前" },
  { city: "绍兴", name: "T***", product: "机场节点 · 无限套餐", time: "7 分钟前" },
  { city: "桃园", name: "Zhao***", product: "Disney+ 4K", time: "11 分钟前" },
  { city: "武汉", name: "黄**", product: "HBO Max", time: "16 分钟前" },
  { city: "包头", name: "周**", product: "Spotify + 机场节点", time: "21 分钟前" },
  { city: "新北", name: "H**", product: "机场节点 · 普通套餐", time: "24 分钟前" },
  { city: "苏州", name: "Eric***", product: "机场节点 · 高级套餐", time: "27 分钟前" },
  { city: "重庆", name: "吴**", product: "Netflix + Disney+", time: "34 分钟前" },
  { city: "厦门", name: "Sara**", product: "机场节点 · 无限套餐", time: "41 分钟前" },
];

function seededUnit(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function beijingParts(date = new Date()) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
  };
}

function daySeed(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function operationWeight(hour) {
  if (hour >= 0 && hour < 6) return 0.16;
  if (hour >= 6 && hour < 8) return 0.55;
  if (hour >= 8 && hour < 11) return 1.32;
  if (hour >= 11 && hour < 14) return 0.82;
  if (hour >= 14 && hour < 17) return 0.96;
  if (hour >= 17 && hour < 21) return 1.42;
  if (hour >= 21 && hour < 23) return 0.78;
  return 0.28;
}

function slotWeight(slot, seed) {
  const hour = Math.floor((slot * OPERATION_SLOT_MINUTES) / 60);
  const jitter = 0.74 + seededUnit(seed + slot * 17) * 0.52;
  return operationWeight(hour) * jitter;
}

function dailyOrderTarget(seed) {
  return Math.min(1500, Math.floor(1080 + seededUnit(seed + 91) * 390));
}

function processedOrderCount(parts) {
  const seed = daySeed(parts);
  const target = dailyOrderTarget(seed);
  const currentSlot = Math.min(OPERATION_SLOTS_PER_DAY - 1, Math.floor((parts.hour * 60 + parts.minute) / OPERATION_SLOT_MINUTES));
  const slotProgress = (parts.minute % OPERATION_SLOT_MINUTES) / OPERATION_SLOT_MINUTES;
  let fullDayWeight = 0;
  let elapsedWeight = 0;
  for (let slot = 0; slot < OPERATION_SLOTS_PER_DAY; slot += 1) {
    const weight = slotWeight(slot, seed);
    fullDayWeight += weight;
    if (slot < currentSlot) elapsedWeight += weight;
    if (slot === currentSlot) elapsedWeight += weight * slotProgress;
  }
  return Math.min(1500, Math.floor(target * (elapsedWeight / fullDayWeight)));
}

function queueCount(parts, processed) {
  const seed = daySeed(parts);
  const slot = Math.floor((parts.hour * 60 + parts.minute) / 5);
  const peak = operationWeight(parts.hour);
  const wave = seededUnit(seed + slot * 31 + 701);
  const target = dailyOrderTarget(seed);
  const processedRatio = processed / Math.max(1, target);
  if (processed < 40) return 0;
  if (peak < 0.5) return processed < 220 ? 0 : (wave > 0.82 ? 1 : 0);
  if (processed < 90) return wave > 0.88 ? 1 : 0;
  if (processed < 180 && peak < 1) return wave > 0.72 ? 1 : 0;
  const demand = peak * Math.min(1, processedRatio * 1.25);
  const cap = demand < 0.16 ? 2 : demand < 0.32 ? 5 : demand < 0.55 ? 9 : (peak >= 1.3 ? 20 : 13);
  const floor = peak >= 1.3 && processed > 320 ? 3 : peak >= 0.9 && processed > 260 ? 1 : 0;
  const value = Math.round(floor + wave * cap);
  if (processed < 180) return Math.min(value, 2);
  if (processed < 320) return Math.min(value, 5);
  return Math.max(0, Math.min(32, value));
}

function buildOperationMetrics(date = new Date()) {
  const parts = beijingParts(date);
  const processed = processedOrderCount(parts);
  return {
    processedToday: `${processed.toLocaleString("zh-CN")}单`,
    averageResponse: "<1分钟",
    queueCount: `${queueCount(parts, processed)}单`,
    serviceYears: "近6年",
  };
}

function LiveOrderTicker() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIdx((i) => (i + 1) % LIVE_ORDERS.length), 3200);
    return () => clearInterval(timer);
  }, []);
  const order = LIVE_ORDERS[idx];
  return (
    <div className="home-announcement-row" role="status" aria-live="polite">
      <Megaphone size={15} />
      <span>
        <b>{order.city}</b> {order.name} 下单了 {order.product} · {order.time}
      </span>
      <ArrowRight size={14} />
    </div>
  );
}

function HomeTestimonials() {
  const [start, setStart] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setStart((value) => (value + TESTIMONIALS_PER_PAGE) % TESTIMONIALS.length);
    }, TESTIMONIALS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  const visible = Array.from({ length: TESTIMONIALS_PER_PAGE }, (_, i) => TESTIMONIALS[(start + i) % TESTIMONIALS.length]);
  return (
    <div className="testimonials-grid testimonials-rotator home-testimonials-grid" key={start}>
      {visible.map((t, i) => (
        <article key={`${start}-${i}-${t.name}-${t.date}`} className="glass-card testimonial-card">
          <div className="testimonial-head">
            <div className="testimonial-avatar">{t.initial}</div>
            <div>
              <div className="testimonial-name">{t.name}</div>
              <div className="testimonial-meta">{t.region} · {t.service}</div>
            </div>
            <div className="testimonial-stars">
              {[...Array(t.rating)].map((_, j) => (
                <Star key={j} size={13} fill="currentColor" />
              ))}
            </div>
          </div>
          <div className="testimonial-text">"{t.text}"</div>
          <div className="testimonial-date">{t.date}</div>
        </article>
      ))}
    </div>
  );
}

export default function Page() {
  const [metrics, setMetrics] = useState(OPERATION_INITIAL_METRICS);
  const [authUser, setAuthUser] = useState(null);

  useEffect(() => {
    const update = () => setMetrics(buildOperationMetrics());
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setAuthUser(data.ok ? data : false))
      .catch(() => setAuthUser(false));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const redeem = params.get("redeem");
    const order = params.get("order");
    const auth = params.get("auth");
    if (redeem) {
      window.history.replaceState(null, "", `/?redeem=${encodeURIComponent(redeem)}#redeem`);
    } else if (order) {
      window.location.replace(`/service-center?order=${encodeURIComponent(order)}`);
    } else if (auth) {
      window.location.replace(`/account?auth=${encodeURIComponent(auth)}`);
    }
  }, []);

  return (
    <div className="page-shell home-page-shell">
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="冒央会社 Maoyang Taiwan Inc">
            <img src="/logo.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <div className="mobile-header-actions" aria-label="快捷入口">
            <Link href="/shop" aria-label="服务选购">
              <ShoppingBag size={16} />
              <span>选购</span>
            </Link>
            <Link href="/service-center" aria-label="服务中心">
              <Headphones size={16} />
              <span>客服</span>
            </Link>
          </div>
          <nav className="desktop-nav">
            <Link href="/shop">服务产品</Link>
            <Link href="/#layout">下单流程</Link>
            <Link href="/service-center#order-query">订单查询</Link>
            <Link href="/service-center#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main id="top" className="main-content home-main">
        <section className="home-hero-card container">
          <div className="home-hero-logo-wrap">
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="home-hero-full-logo" />
            <h1 className="sr-only">冒央会社 · 流媒体服务</h1>
          </div>
          <p>流媒体会员、节点服务与售后协助一站办理</p>
          <div className="home-hero-badges">
            <span><Zap size={14} />即时开通</span>
            <span><ShieldCheck size={14} />7 天内退款</span>
            <span><BadgeCheck size={14} />全网最低价</span>
          </div>
          <div className="home-hero-actions">
            <Link href="/shop" className="hero-pair-btn primary">
              <Zap size={16} />立即开通
            </Link>
            <Link href={authUser ? "/account" : "/account?auth=login"} className={`hero-pair-btn secondary${authUser ? "" : " with-auth-tip"}`}>
              <Users size={16} />{authUser ? "个人中心" : "登录 / 注册"}
              {!authUser && <span className="hero-auth-tip">新用户注册立减 ¥8.88</span>}
            </Link>
            <Link href="/service-center#order-query" className="home-query-btn">
              <ShoppingBag size={16} />订单查询
            </Link>
          </div>
          <div className="home-hero-metrics" aria-label="平台运营数据">
            {HERO_STATS.map(({ metric, label, icon: Icon }) => (
              <div key={label} className="home-hero-metric">
                <Icon size={14} />
                <span>{label}</span>
                <b>{metrics[metric]}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-trust-card">
          <h2>平台优势</h2>
          <div className="home-trust-grid">
            {TRUST_ITEMS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="home-trust-item">
                <Icon size={22} />
                <strong>{title}</strong>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-announcement-card">
          <LiveOrderTicker />
        </section>

        <section id="redeem" className="section container home-redeem-section">
          <RedeemCard autoFillFromQuery />
        </section>

        <section id="layout" className="section container home-layout-section">
          <div className="section-head simple-head home-compact-head">
            <div>
              <div className="section-kicker">服务流程</div>
              <h2 className="section-title">下单/兑换流程</h2>
            </div>
          </div>
          <div className="layout-grid layout-grid-stack home-layout-grid">
            {LAYOUT_CARDS.map(([title, desc], index) => (
              <div key={title} className="glass-card info-card">
                <div className="info-step">{String(index + 1).padStart(2, "0")}</div>
                <ShoppingBag size={24} className="info-icon" />
                <div className="info-title">{title}</div>
                <div className="info-desc">{desc}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="section container home-reviews-section">
          <div className="section-head simple-head home-compact-head">
            <div className="home-review-heading">
              <div className="section-kicker">用户反馈</div>
              <div className="home-review-title-row">
                <h2 className="section-title">用户评价</h2>
                <div className="reviews-summary">
                  <div className="reviews-stars">
                    {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={18} fill="currentColor" />)}
                  </div>
                  <div className="reviews-summary-text">
                    <b>4.98 / 5.0</b>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <HomeTestimonials />
        </section>
      </main>

      <footer className="site-footer home-footer">
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
      <MobileNav />
    </div>
  );
}
