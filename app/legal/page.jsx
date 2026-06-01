import Link from "next/link";
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  FileText,
  Headphones,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import FloatingSupport from "../components/FloatingSupport";
import MobileNav from "../components/MobileNav";
import { SERVICE_PAGES } from "../services/service-data";

export const metadata = {
  title: "企业资质与服务保障",
  description: "冒央会社 Maoyang Taiwan Inc 企业资质、服务承诺、售后保障、隐私政策与退款规则说明",
  alternates: { canonical: "/legal" },
  openGraph: {
    title: "企业资质与服务保障 | 冒央会社",
    description: "台湾注册实体，公开服务承诺、售后保障、隐私政策与退款规则",
    url: "/legal",
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "企业资质与服务保障 | 冒央会社",
    description: "查看冒央会社企业资质、服务承诺、隐私政策与退款规则",
    images: ["/og-image.png"],
  },
};

const SUMMARY_ITEMS = [
  ["台湾注册实体", "Maoyang Taiwan Inc", "以台湾注册主体提供服务与售后支持"],
  ["交易留痕可查", "订单全程记录", "订单、邮件与售后信息可用于进度查询"],
  ["隐私最小化", "仅保留必要资料", "不索取或保存与服务无关的隐私信息"],
];

const POLICY_SECTIONS = [
  {
    id: "qualification",
    icon: Building2,
    title: "企业资质",
    kicker: "Registered Entity",
    lead: "冒央会社 Maoyang Taiwan Inc 为台湾注册实体，业务范围围绕流媒体会员、节点服务咨询、订单协助与售后支持展开",
    items: [
      ["主体说明", "以 Maoyang Taiwan Inc 名义运营，面向用户提供服务确认、订单协助与售后支持"],
      ["交易规范", "交易流程遵循台湾商业登记、消费者权益与电子商务相关规范，订单记录可追溯"],
      ["服务边界", "服务内容以商品页、订单页与邮件同步信息为准，便于用户在下单前确认规格"],
    ],
    tags: ["台湾注册主体", "订单记录可查", "服务范围公开"],
  },
  {
    id: "commitment",
    icon: ShieldCheck,
    title: "服务承诺",
    kicker: "Service Promise",
    lead: "我们将价格、规格、周期、服务范围和交付结果前置展示，尽量减少下单前后的信息差",
    items: [
      ["信息展示", "商品页展示服务类型、套餐价格、周期与适用说明，用户可在下单前确认选择"],
      ["订单同步", "提交订单后系统保存订单记录，并通过邮件同步关键状态与交付信息"],
      ["进度查询", "用户可通过订单号或下单邮箱在服务中心查询订单处理与售后信息"],
    ],
    tags: ["价格规格公开", "订单状态可查", "邮件同步交付"],
  },
  {
    id: "after-sale",
    icon: Headphones,
    title: "售后保障",
    kicker: "After-Sales",
    lead: "服务使用中如遇账号、车位、节点或订阅异常，可通过在线客服提交问题，客服团队会按订单信息持续跟进",
    items: [
      ["受理方式", "通过 QQ、WhatsApp、Telegram 或服务中心提交订单信息与问题说明"],
      ["处理原则", "优先核对订单、服务类型与异常场景，以恢复使用和明确处理结果为目标"],
      ["进度记录", "售后沟通与处理状态会关联订单，用户可继续查询后续结果"],
    ],
    tags: ["在线客服跟进", "订单关联售后", "异常优先恢复"],
  },
  {
    id: "privacy",
    icon: LockKeyhole,
    title: "隐私政策",
    kicker: "Privacy",
    lead: "我们不主动索取与服务无关的隐私资料，必要记录仅用于订单交付、付款核验、售后查询与风险防护",
    items: [
      ["必要信息", "系统可能保存邮箱、联系方式、订单内容、付款方式、IP 与浏览器信息等必要记录"],
      ["使用范围", "相关信息仅用于订单交付、售后核验、账户安全与异常风险识别"],
      ["资料边界", "不公开出售用户资料，不要求用户提供与服务履约无关的隐私内容"],
    ],
    tags: ["不索取无关资料", "仅用于服务履约", "不出售用户资料"],
  },
  {
    id: "refund",
    icon: RotateCcw,
    title: "退款规则",
    kicker: "Refund Rules",
    lead: "因账号、车位或节点服务本身原因导致无法正常使用，且经客服协助仍无法恢复的订单，支持在 7 天内按规则处理退款",
    items: [
      ["适用范围", "服务本身异常且无法恢复时，按订单类型、使用状态与问题原因进行退款处理"],
      ["处理顺序", "客服会先协助恢复使用；确认无法恢复后，再按规则进入退款流程"],
      ["不适用情形", "资料填写错误、主动变更、滥用、共享给陌生人或违反对应平台规则导致的问题，不属于无条件退款范围"],
    ],
    tags: ["7 天内按规则处理", "先恢复再退款", "规则清晰可查"],
  },
];

export default function LegalPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Maoyang Taiwan Inc",
    alternateName: "冒央会社",
    url: "https://liumeiti.vip",
    logo: "https://liumeiti.vip/logo-transparent.png",
    address: {
      "@type": "PostalAddress",
      addressRegion: "新北市",
      streetAddress: "板桥区远东路1号3-218",
      addressCountry: "TW",
    },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      availableLanguage: ["zh-CN", "zh-TW"],
    },
  };

  return (
    <div className="page-shell portal-page-shell legal-page-shell">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="返回首页">
            <img src="/logo.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">服务产品</Link>
            <Link href="/service-center">服务中心</Link>
            <Link href="/legal">企业保障</Link>
            <Link href="/service-center#contact">联系我们</Link>
          </nav>
        </div>
      </header>

      <main className="main-content portal-main legal-main">
        <section className="container legal-hero">
          <div className="legal-hero-copy">
            <div className="section-kicker">MAOYANG TAIWAN INC</div>
            <h1>企业资质与服务保障</h1>
            <p>面向用户公开的服务规则与保障说明，用于确认主体信息、交易流程、隐私边界、售后责任与退款处理方式</p>
            <div className="legal-hero-actions">
              <Link href="#policy-map">查看保障条款</Link>
              <Link href="/service-center#contact">联系客服</Link>
            </div>
          </div>
          <aside className="legal-hero-panel" aria-label="企业保障摘要">
            <img src="/logo-mark.png" alt="" />
            <strong>冒央会社 Maoyang Taiwan Inc</strong>
            <span>台湾注册实体 · 订单可查 · 售后可追踪</span>
            <div className="legal-panel-grid">
              <b>2020至今<em>稳定运营</em></b>
              <b>7 天规则<em>售后处理</em></b>
              <b>最小化<em>隐私原则</em></b>
            </div>
          </aside>
        </section>

        <section className="container legal-summary-grid" aria-label="企业状态摘要">
          {SUMMARY_ITEMS.map(([title, value, desc]) => (
            <article key={title} className="legal-summary-card">
              <CheckCircle2 size={17} />
              <small>{title}</small>
              <strong>{value}</strong>
              <span>{desc}</span>
            </article>
          ))}
        </section>

        <section id="policy-map" className="container legal-document-nav" aria-label="保障条款导航">
          {POLICY_SECTIONS.map(({ id, title, icon: Icon }, index) => (
            <Link key={id} href={`#${id}`}>
              <em>{String(index + 1).padStart(2, "0")}</em>
              <Icon size={16} />
              <span>{title}</span>
            </Link>
          ))}
        </section>

        <section className="container legal-document-shell">
          {POLICY_SECTIONS.map(({ id, icon: Icon, title, kicker, lead, items, tags }, index) => (
            <article key={id} id={id} className="legal-document-card">
              <div className="legal-document-index">{String(index + 1).padStart(2, "0")}</div>
              <div className="legal-document-body">
                <div className="legal-document-head">
                  <span><Icon size={20} /></span>
                  <div>
                    <small>{kicker}</small>
                    <h2>{title}</h2>
                  </div>
                </div>
                <p className="legal-document-lead">{lead}</p>
                <div className="legal-document-rows">
                  {items.map(([label, text]) => (
                    <div key={label} className="legal-document-row">
                      <b>{label}</b>
                      <p>{text}</p>
                    </div>
                  ))}
                </div>
                <div className="legal-document-tags">
                  {tags.map((tag) => (
                    <span key={tag}><BadgeCheck size={14} />{tag}</span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="container legal-service-links">
          <div className="legal-service-copy">
            <div className="section-kicker">SERVICE CONFIRMATION</div>
            <h2>服务详情确认入口</h2>
            <p>下单前可按服务类型查看规格、适用场景与常见问题，确认后再进入选购或联系客服</p>
          </div>
          <div className="legal-service-list">
            {SERVICE_PAGES.map((item) => (
              <Link key={item.slug} href={`/services/${item.slug}`}>
                <FileText size={15} />
                <span>{item.shortTitle}</span>
                <b>{item.price}</b>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">冒央会社 · Maoyang Taiwan Inc</div>
            <div className="footer-links">
              <Link href="/legal">企业资质与服务保障</Link>
              <Link href="/service-center#contact">联系我们</Link>
            </div>
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
