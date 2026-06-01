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
  description: "了解冒央会社 Maoyang Taiwan Inc 的企业信息、服务承诺、售后保障、隐私保护与退款说明",
  alternates: { canonical: "/legal" },
  openGraph: {
    title: "企业资质与服务保障 | 冒央会社",
    description: "台湾注册实体，清晰展示服务承诺、售后保障、隐私保护与退款说明",
    url: "/legal",
    images: [{ url: "https://liumeiti.vip/icon-512.png?v=20260601", width: 512, height: 512, type: "image/png", alt: "冒央会社" }],
  },
  twitter: {
    card: "summary",
    title: "企业资质与服务保障 | 冒央会社",
    description: "查看冒央会社企业信息、服务承诺、隐私保护与退款说明",
    images: ["https://liumeiti.vip/icon-512.png?v=20260601"],
  },
};

const SUMMARY_ITEMS = [
  ["台湾注册公司", "Maoyang Taiwan Inc", "以台湾注册公司身份为用户提供服务与售后支持"],
  ["订单清晰可查", "订单与邮件同步", "下单后可用邮箱或订单号查看进度"],
  ["隐私保护原则", "只收集服务所需资料", "不要求提供无关隐私信息"],
];

const POLICY_SECTIONS = [
  {
    id: "qualification",
    icon: Building2,
    title: "企业资质",
    kicker: "Registered Entity",
    lead: "冒央会社 Maoyang Taiwan Inc 为台湾注册实体，专注流媒体会员、节点服务咨询、订单协助与售后支持",
    items: [
      ["公司信息", "以 Maoyang Taiwan Inc 名义运营，为用户提供服务选购、订单协助与售后支持"],
      ["服务保障", "交易与售后遵循台湾商业及消费者权益相关规范，订单信息方便后续查询"],
      ["下单确认", "服务内容以商品页、订单页与邮件通知为准，方便用户在付款前确认规格"],
    ],
    tags: ["台湾注册实体", "订单可查询", "服务说明清晰"],
  },
  {
    id: "commitment",
    icon: ShieldCheck,
    title: "服务承诺",
    kicker: "Service Promise",
    lead: "我们会在下单前清晰展示价格、规格、周期与适用说明，让用户更容易确认自己需要的服务",
    items: [
      ["套餐信息", "商品页展示服务类型、套餐价格、使用周期与适用说明，下单前即可确认选择"],
      ["邮件通知", "提交订单后会发送邮件通知，关键进度和交付信息可及时查看"],
      ["订单查询", "用户可通过订单号或下单邮箱，在服务中心查询订单与售后进度"],
    ],
    tags: ["价格规格清楚", "订单进度可查", "邮件同步通知"],
  },
  {
    id: "after-sale",
    icon: Headphones,
    title: "售后保障",
    kicker: "After-Sales",
    lead: "服务使用中如遇账号、车位、节点或订阅异常，可联系在线客服，我们会结合订单情况协助处理",
    items: [
      ["联系渠道", "可通过 QQ、WhatsApp、Telegram 或服务中心提交订单信息与问题说明"],
      ["协助方式", "优先确认服务类型与问题场景，以恢复使用或给出明确结果为目标"],
      ["售后进度", "售后进展会与订单关联，用户可继续通过服务中心查看后续结果"],
    ],
    tags: ["在线客服跟进", "订单关联售后", "异常优先恢复"],
  },
  {
    id: "privacy",
    icon: LockKeyhole,
    title: "隐私政策",
    kicker: "Privacy",
    lead: "我们不主动索取与服务无关的隐私资料，只保留完成下单、付款确认、售后查询所需的信息",
    items: [
      ["资料范围", "可能保存邮箱、联系方式、订单内容、付款方式、IP 与浏览器信息等服务所需资料"],
      ["使用目的", "相关信息只会用于订单交付、售后查询、付款确认与账号安全保护"],
      ["保护承诺", "不公开出售用户资料，也不要求用户提供与服务无关的隐私内容"],
    ],
    tags: ["不索取无关资料", "只用于服务需要", "不出售用户资料"],
  },
  {
    id: "refund",
    icon: RotateCcw,
    title: "退款规则",
    kicker: "Refund Rules",
    lead: "如因账号、车位或节点服务本身原因导致无法正常使用，且经协助后仍无法恢复，可在 7 天内按规则处理退款",
    items: [
      ["可处理情况", "服务本身异常且无法恢复时，会按订单类型、使用状态与问题原因处理"],
      ["退款说明", "优先协助恢复使用；确认无法恢复后，再按对应说明进入退款处理"],
      ["不适用情况", "资料填写错误、主动变更、滥用、共享给陌生人或违反对应平台规则导致的问题，不属于无条件退款范围"],
    ],
    tags: ["7 天内可处理", "先恢复再退款", "说明清晰可查"],
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
            <p>在这里可以了解冒央会社的企业信息、服务承诺、售后支持、隐私保护与退款说明，下单前看得清楚，用起来更安心</p>
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
              <b>7 天说明<em>售后处理</em></b>
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
