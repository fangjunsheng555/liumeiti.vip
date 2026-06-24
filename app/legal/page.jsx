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
import { SERVICE_PAGES, localizeService } from "../services/service-data";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";
import { getServerLocale } from "../lib/i18n-server";

export async function generateMetadata() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const title = en ? "Credentials & Service Guarantees" : "企业资质与服务保障";
  const ogTitle = en ? "Credentials & Service Guarantees | Maoyang Taiwan Inc" : "企业资质与服务保障 | 冒央会社";
  const description = en
    ? "Company credentials, service promise, after-sales, privacy policy and refund rules — everything you need to confirm before ordering."
    : SOCIAL_DESCRIPTION;
  return {
    title,
    description,
    alternates: { canonical: "/legal" },
    openGraph: {
      title: ogTitle,
      description,
      url: "/legal",
      locale: en ? "en_US" : "zh_CN",
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary",
      title: ogTitle,
      description,
      images: [SOCIAL_IMAGE],
    },
  };
}

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

const SUMMARY_ITEMS_EN = [
  ["Registered in Taiwan", "Maoyang Taiwan Inc", "We serve users and provide after-sales as a company registered in Taiwan"],
  ["Trackable orders", "Orders synced to email", "Track progress by email or order number after ordering"],
  ["Privacy first", "Only what the service needs", "We never ask for irrelevant private information"],
];

const POLICY_SECTIONS_EN = {
  qualification: {
    title: "Credentials", kicker: "Registered Entity",
    lead: "Maoyang Taiwan Inc is a registered entity in Taiwan, focused on streaming memberships, VPN consultation, order assistance and after-sales support.",
    items: [
      ["Company info", "Operating as Maoyang Taiwan Inc, providing service purchasing, order assistance and after-sales support"],
      ["Service assurance", "Transactions and after-sales follow Taiwan's commercial and consumer-protection norms; order info is easy to look up"],
      ["Order confirmation", "Service scope follows the product page, order page and email notice, so users can confirm before paying"],
    ],
    tags: ["Registered entity", "Trackable orders", "Clear service info"],
  },
  commitment: {
    title: "Service promise", kicker: "Service Promise",
    lead: "We clearly show price, plan, cycle and notes before you order, so it's easy to confirm what you need.",
    items: [
      ["Plan info", "The product page shows service type, plan price, cycle and notes to confirm before ordering"],
      ["Email notice", "An email is sent after the order so key progress and delivery info is timely"],
      ["Order lookup", "Look up orders and after-sales progress in the Service Center by order number or email"],
    ],
    tags: ["Clear pricing", "Trackable progress", "Email synced"],
  },
  terms: {
    title: "Terms of service", kicker: "Terms of Service",
    lead: "Placing an order confirms the chosen service, cycle, price, payment method and on-page notes. Services may vary by region, device, account status and platform rules.",
    items: [
      ["Scope", "We provide streaming memberships, VPN plans, setup assistance, usage guidance and after-sales; we do not support illegal use or encourage breaking platform rules"],
      ["User responsibility", "Users must provide accurate email, contact, account and payment details; if errors cause delay or failure, please cooperate with support to fix them"],
      ["Delivery standard", "Order status, setup emails, Service Center results and support records together form the basis of delivery"],
      ["Exceptions", "If platform policy, regional limits, account checks or force majeure affect the service, we prioritize recovery, replacement or handling per the refund rules"],
    ],
    tags: ["Order = confirmation", "Accurate details", "Trackable delivery"],
  },
  "after-sale": {
    title: "After-sales", kicker: "After-Sales",
    lead: "If an account, Profile, node or subscription has issues, reach our online support and we'll help based on your order.",
    items: [
      ["Contact channels", "Submit order info and your issue via QQ, WhatsApp, Telegram or the Service Center"],
      ["How we help", "We first confirm the service type and scenario, aiming to restore use or give a clear outcome"],
      ["Progress", "After-sales progress is linked to your order; keep checking results in the Service Center"],
    ],
    tags: ["Online support", "Linked to order", "Recovery first"],
  },
  privacy: {
    title: "Privacy policy", kicker: "Privacy",
    lead: "We don't ask for private data unrelated to the service — only what's needed to complete the order, confirm payment and handle after-sales.",
    items: [
      ["Data scope", "We may keep email, contact, order content, payment method, IP and browser info needed for the service"],
      ["Purpose", "Such info is only used for order delivery, after-sales lookup, payment confirmation and account security"],
      ["Account data", "Account or password details needed for setup are only used for the matching order; after completion access and retention follow the minimum-necessary principle"],
      ["Our promise", "We don't sell user data and don't ask for private content unrelated to the service"],
    ],
    tags: ["No irrelevant data", "Service use only", "No data selling"],
  },
  refund: {
    title: "Refund rules", kicker: "Refund Rules",
    lead: "If an account, Profile or node can't be used due to the service itself and can't be recovered after help, a refund can be handled within 7 days per the rules.",
    items: [
      ["Eligible cases", "Not delivered after payment, delivery inconsistent with the order, or the service itself fails and can't be recovered — eligible for a refund or equivalent replacement"],
      ["Process", "Provide the order number, order email and a screenshot or error; after verification we restore use first, then process a refund if it can't be recovered"],
      ["Refund amount", "Undelivered orders are refunded by amount paid; delivered and partly-used orders are handled by usage time, plan type, platform cost and the cause"],
      ["Timing", "Alipay or original-channel refunds usually take 1–5 business days; USDT refunds require a TRC20 address, with on-chain fees borne by the user"],
      ["Not applicable", "Issues from wrong details, voluntary changes, abuse, sharing with strangers or breaking platform rules are not unconditionally refundable"],
    ],
    tags: ["Within 7 days", "Recover then refund", "Clear & trackable"],
  },
  retention: {
    title: "Data retention", kicker: "Data Retention",
    lead: "We keep data as needed for delivery, after-sales tracking, payment reconciliation and security, and minimize unnecessary long-term storage.",
    items: [
      ["Order records", "Order number, email, items, amount, status and support notes are kept for after-sales, finance reconciliation and dispute handling"],
      ["Code records", "Temporary codes such as order-lookup and password-reset codes are short-lived and expire automatically"],
      ["Security logs", "Login, order submission, admin actions, IP and browser info are only used for security checks and troubleshooting, never made public"],
      ["Deletion requests", "Users may ask support to correct or delete non-essential data; records required by law, finance or disputes are kept for the necessary period"],
    ],
    tags: ["Minimum necessary", "Temporary codes", "Correction on request"],
  },
};

export default async function LegalPage() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const summaryItems = en ? SUMMARY_ITEMS_EN : SUMMARY_ITEMS;
  const policySections = POLICY_SECTIONS.map((s) => (en && POLICY_SECTIONS_EN[s.id] ? { ...s, ...POLICY_SECTIONS_EN[s.id] } : s));
  const serviceLinks = SERVICE_PAGES.map((s) => localizeService(s, locale));
  const L = (zh, e) => (en ? e : zh);
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
          <Link href="/" className="brand-wrap" aria-label={L("返回首页", "Back home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">{L("服务产品", "Services")}</Link>
            <Link href="/service-center">{L("服务中心", "Service Center")}</Link>
            <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
            <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
          </nav>
        </div>
      </header>

      <main className="main-content portal-main legal-main">
        <section className="container legal-hero">
          <div className="legal-hero-copy">
            <div className="section-kicker">MAOYANG TAIWAN INC</div>
            <h1>{L("企业资质与服务保障", "Credentials & service assurance")}</h1>
            <p>{L("企业信息、服务承诺、售后保障、隐私政策与退款规则集中说明，便于下单前确认", "Company info, service promise, after-sales, privacy and refund rules in one place — easy to confirm before ordering")}</p>
            <div className="legal-hero-actions">
              <Link href="#policy-map">{L("查看保障条款", "View policies")}</Link>
              <Link href="/service-center#contact">{L("联系客服", "Contact support")}</Link>
            </div>
          </div>
          <aside className="legal-hero-panel" aria-label={L("企业保障摘要", "Assurance summary")}>
            <img src="/logo-mark.png" alt="" />
            <strong>{L("冒央会社 Maoyang Taiwan Inc", "Maoyang Taiwan Inc")}</strong>
            <span>{L("台湾注册实体 · 订单可查 · 售后可追踪", "Registered in Taiwan · Trackable orders · After-sales")}</span>
            <div className="legal-panel-grid">
              <b>{L("2020至今", "Since 2020")}<em>{L("稳定运营", "Stable")}</em></b>
              <b>{L("7 天说明", "7-day")}<em>{L("售后处理", "After-sales")}</em></b>
              <b>{L("最小化", "Minimal")}<em>{L("隐私原则", "Privacy")}</em></b>
            </div>
          </aside>
        </section>

        <section className="container legal-summary-grid" aria-label={L("企业状态摘要", "Company status")}>
          {summaryItems.map(([title, value, desc]) => (
            <article key={title} className="legal-summary-card">
              <CheckCircle2 size={17} />
              <small>{title}</small>
              <strong>{value}</strong>
              <span>{desc}</span>
            </article>
          ))}
        </section>

        <section id="policy-map" className="container legal-document-nav" aria-label={L("保障条款导航", "Policy navigation")}>
          {policySections.map(({ id, title, icon: Icon }, index) => (
            <Link key={id} href={`#${id}`}>
              <em>{String(index + 1).padStart(2, "0")}</em>
              <Icon size={16} />
              <span>{title}</span>
            </Link>
          ))}
        </section>

        <section className="container legal-document-shell">
          {policySections.map(({ id, icon: Icon, title, kicker, lead, items, tags }, index) => (
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
            <h2>{L("服务详情确认入口", "Confirm service details")}</h2>
            <p>{L("下单前可按服务类型查看规格、适用场景与常见问题，确认后再进入选购或联系客服", "Check plans, use cases and FAQs by service before ordering, then shop or contact support")}</p>
          </div>
          <div className="legal-service-list">
            {serviceLinks.map((item) => (
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
            <div className="footer-brand">{L("冒央会社 · Maoyang Taiwan Inc", "Maoyang Taiwan Inc")}</div>
            <div className="footer-links">
              <Link href="/legal">{L("企业资质与服务保障", "Credentials & service assurance")}</Link>
              <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{L("地址：台湾新北市板桥区远东路1号3-218", "Addr: 3-218, No.1 Yuandong Rd, Banqiao, New Taipei, Taiwan")}</div>
            <div className="footer-pill">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
