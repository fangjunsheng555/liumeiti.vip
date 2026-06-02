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
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";

export const metadata = {
  title: "企业资质与服务保障",
  description: SOCIAL_DESCRIPTION,
  alternates: { canonical: "/legal" },
  openGraph: {
    title: "企业资质与服务保障 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    url: "/legal",
    images: [SOCIAL_IMAGE_META],
  },
  twitter: {
    card: "summary",
    title: "企业资质与服务保障 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    images: [SOCIAL_IMAGE],
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
    id: "terms",
    icon: FileText,
    title: "服务条款",
    kicker: "Terms of Service",
    lead: "用户下单即表示已确认所选服务、周期、价格、支付方式及页面提示。不同平台服务可能存在地区、设备、账号状态与平台规则差异",
    items: [
      ["服务范围", "我们提供流媒体会员、节点套餐、开通协助、使用指导与售后沟通，不提供违法用途支持，也不鼓励违反平台规则的使用方式"],
      ["用户责任", "用户需保证提交邮箱、联系方式、账号资料与付款信息真实准确；因资料错误导致延迟或失败的，应配合客服修正"],
      ["交付标准", "订单状态、开通邮件、服务中心查询结果与客服确认记录共同构成服务交付依据"],
      ["异常处理", "如平台政策、地区限制、账号安全校验或不可抗力影响服务，我们会优先协助恢复、替换或按退款规则处理"],
    ],
    tags: ["下单即确认", "资料准确", "交付可追踪"],
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
      ["账号资料", "涉及开通所需的账号或密码资料仅用于对应订单处理；完成或售后结束后将按最小必要原则限制访问与保留"],
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
      ["可退款情况", "付款后未能开通、交付内容与订单不一致、服务本身异常且无法恢复，均可申请退款或等值替换"],
      ["处理流程", "用户需提供订单号、下单邮箱、问题截图或错误提示；客服核验后优先恢复使用，确认无法恢复后进入退款处理"],
      ["退款金额", "未交付订单原则上按实付金额退回；已交付并部分使用的订单，将结合使用时长、套餐性质、平台成本与问题原因协商处理"],
      ["到账时间", "支付宝或原支付渠道退款通常 1-5 个工作日完成；USDT 退款需用户提供 TRC20 地址并承担链上转账手续费"],
      ["不适用情况", "资料填写错误、主动变更、滥用、共享给陌生人或违反对应平台规则导致的问题，不属于无条件退款范围"],
    ],
    tags: ["7 天内可处理", "先恢复再退款", "说明清晰可查"],
  },
  {
    id: "retention",
    icon: LockKeyhole,
    title: "数据保留说明",
    kicker: "Data Retention",
    lead: "我们按订单交付、售后追踪、付款核对与安全保护所需保留数据，并尽量减少不必要的长期保存",
    items: [
      ["订单记录", "订单号、邮箱、商品、金额、状态与客服备注会保留用于售后查询、财务核对和争议处理"],
      ["验证码记录", "订单查询验证码、找回密码验证码等临时验证信息仅短期有效，过期后自动失效"],
      ["安全记录", "登录、订单提交、管理操作、IP 与浏览器信息仅用于安全校验和异常排查，不会对外公开"],
      ["删除请求", "用户可联系客服申请更正或删除非必要资料；法律、财务或争议处理必须保留的记录将按必要期限保存"],
    ],
    tags: ["最小必要", "临时验证码", "可申请更正"],
  },
];

export default function LegalPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Maoyang Taiwan Inc",
    alternateName: "冒央会社",
    url: "https://www.liumeiti.vip",
    logo: "https://www.liumeiti.vip/logo-transparent.png",
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
            <p>企业信息、服务承诺、售后保障、隐私政策与退款规则集中说明，便于下单前确认</p>
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
