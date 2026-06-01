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
    description: "台湾注册实体，遵循商业与消费者权益相关规范，提供流媒体会员服务、订单协助与售后保障",
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

const STATUS_ITEMS = [
  ["台湾注册实体", "Maoyang Taiwan Inc 作为台湾注册主体运营"],
  ["交易合规", "交易与售后遵循商业及消费者权益相关规范"],
  ["隐私最小化", "仅保存订单与售后所需的最小信息"],
];

const POLICY_SECTIONS = [
  {
    id: "qualification",
    icon: Building2,
    title: "企业资质",
    kicker: "Registered Entity",
    body: "冒央会社 Maoyang Taiwan Inc 为台湾注册实体，业务围绕流媒体会员服务、节点服务咨询、订单协助与售后支持展开。我们以清晰订单、可查记录和在线客服作为履约基础，交易与售后遵循台湾商业登记、消费者权益与电子商务相关规范",
    points: ["台湾注册主体运营", "订单与售后记录可追溯", "交易过程接受商业相关规范约束"],
  },
  {
    id: "commitment",
    icon: ShieldCheck,
    title: "服务承诺",
    kicker: "Service Promise",
    body: "所有商品页面展示的规格、价格、周期和服务范围会尽量保持清晰一致。用户提交订单后，系统会保存订单记录并同步邮件，客服会按订单信息核验服务并完成交付",
    points: ["价格与规格公开展示", "订单状态可在服务中心查询", "完成后邮件同步关键交付信息"],
  },
  {
    id: "after-sale",
    icon: Headphones,
    title: "售后保障",
    kicker: "After-Sales",
    body: "服务使用过程中如遇账号、车位、节点或订阅异常，可通过 QQ、WhatsApp、Telegram 联系在线客服。售后将优先核对订单、服务类型与问题场景，尽量以恢复使用为第一处理目标",
    points: ["订单号与邮箱可查售后进度", "在线客服持续跟进问题", "账号或节点异常优先协助恢复"],
  },
  {
    id: "privacy",
    icon: LockKeyhole,
    title: "隐私政策",
    kicker: "Privacy",
    body: "我们不主动索取与服务无关的隐私资料。为完成订单、售后查询、付款核验与账号安全，系统仅保存邮箱、联系方式、订单内容、付款方式、IP 与浏览器信息等必要记录，并用于服务交付与风险防护",
    points: ["不索取无关隐私资料", "必要记录仅用于订单与售后", "不公开出售用户资料"],
  },
  {
    id: "refund",
    icon: RotateCcw,
    title: "退款规则",
    kicker: "Refund Rules",
    body: "因账号、车位或节点服务本身原因导致无法正常使用，且经客服协助仍无法恢复的订单，支持在 7 天内按规则处理退款。因用户资料填写错误、主动变更、滥用、共享给陌生人或违反对应平台规则导致的问题，不属于无条件退款范围",
    points: ["账号原因支持 7 天内处理", "先协助恢复，再按规则退款", "异常滥用或资料错误不适用无条件退款"],
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

      <main className="main-content portal-main">
        <section className="container portal-hero">
          <div className="portal-hero-mark">
            <img src="/logo-mark.png" alt="" />
          </div>
          <div>
            <div className="section-kicker">MAOYANG TAIWAN INC</div>
            <h1>企业资质与服务保障</h1>
            <p>面向流媒体会员、节点服务与售后协助的正式说明，覆盖交易规范、隐私保护与退款规则</p>
          </div>
        </section>

        <section className="container legal-status-grid" aria-label="企业状态摘要">
          {STATUS_ITEMS.map(([title, desc]) => (
            <div key={title} className="legal-status-item">
              <CheckCircle2 size={17} />
              <strong>{title}</strong>
              <span>{desc}</span>
            </div>
          ))}
        </section>

        <section className="container legal-policy-grid">
          {POLICY_SECTIONS.map(({ id, icon: Icon, title, kicker, body, points }) => (
            <article key={id} id={id} className="legal-policy-card">
              <div className="legal-policy-head">
                <span><Icon size={20} /></span>
                <div>
                  <small>{kicker}</small>
                  <h2>{title}</h2>
                </div>
              </div>
              <p>{body}</p>
              <div className="legal-point-list">
                {points.map((point) => (
                  <span key={point}><BadgeCheck size={14} />{point}</span>
                ))}
              </div>
            </article>
          ))}
        </section>

        <section className="container legal-service-links">
          <div className="legal-service-copy">
            <div className="section-kicker">SERVICE PAGES</div>
            <h2>服务详情入口</h2>
            <p>按服务类型查看规格、适用场景与常见问题，便于下单前确认选择</p>
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
