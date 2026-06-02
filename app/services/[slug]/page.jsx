import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, BadgeCheck, CheckCircle2, ShieldCheck } from "lucide-react";
import FloatingSupport from "../../components/FloatingSupport";
import MobileNav from "../../components/MobileNav";
import { getServiceBySlug, SERVICE_PAGES } from "../service-data";
import ServiceOrderActions from "../ServiceOrderActions";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../../social-meta";

export function generateStaticParams() {
  return SERVICE_PAGES.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const service = getServiceBySlug(slug);
  if (!service) return {};
  const title = `${service.title} ${service.price}`;
  return {
    title,
    description: service.description,
    alternates: { canonical: `/services/${service.slug}` },
    openGraph: {
      title: `${title} | 冒央会社`,
      description: SOCIAL_DESCRIPTION,
      url: `/services/${service.slug}`,
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary",
      title: `${title} | 冒央会社`,
      description: SOCIAL_DESCRIPTION,
      images: [SOCIAL_IMAGE],
    },
  };
}

export default async function ServiceLandingPage({ params }) {
  const { slug } = await params;
  const service = getServiceBySlug(slug);
  if (!service) notFound();

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: service.title,
      image: `https://www.liumeiti.vip${service.image}`,
      description: service.description,
      brand: { "@type": "Brand", name: "冒央会社 Maoyang Taiwan Inc" },
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "CNY",
        lowPrice: String(service.plans[0]?.[1] || service.price).replace(/[^\d.]/g, "") || "0",
        availability: "https://schema.org/InStock",
        url: `https://www.liumeiti.vip/services/${service.slug}`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "首页", item: "https://www.liumeiti.vip/" },
        { "@type": "ListItem", position: 2, name: "服务产品", item: "https://www.liumeiti.vip/shop" },
        { "@type": "ListItem", position: 3, name: service.shortTitle, item: `https://www.liumeiti.vip/services/${service.slug}` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: service.faq.map(([question, answer]) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer },
      })),
    },
  ];

  return (
    <div className="page-shell portal-page-shell service-landing-shell">
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
        <section className="container service-seo-hero">
          <div className="service-seo-copy">
            <div className="section-kicker">SERVICE DETAIL</div>
            <h1>{service.title}</h1>
            <p>{service.description}</p>
            <div className="service-seo-badges">
              {service.highlights.map((item) => (
                <span key={item}><BadgeCheck size={14} />{item}</span>
              ))}
            </div>
            <ServiceOrderActions service={service} />
          </div>
          <div className="service-seo-visual">
            <img src={service.image} alt={service.title} />
            <div>
              <span>{service.subtitle}</span>
              <b>{service.price}</b>
            </div>
          </div>
        </section>

        <section className="container service-plan-section">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">PLAN OPTIONS</div>
              <h2 className="section-title">规格与价格</h2>
            </div>
          </div>
          <div className="service-plan-grid">
            {service.plans.map(([name, price, desc]) => (
              <article key={name} className="service-plan-card">
                <span>{name}</span>
                <b>{price}</b>
                <p>{desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="container service-process-card">
          <div className="service-process-title">
            <ShieldCheck size={18} />
            <div>
              <h2>下单与售后说明</h2>
              <p>选择规格后提交订单，完成支付或使用服务兑换码后，可通过邮箱或订单号查询进度</p>
            </div>
          </div>
          <div className="service-process-steps">
            {["选择规格", "填写资料", "提交订单", "售后查询"].map((item, index) => (
              <div key={item}>
                <em>{String(index + 1).padStart(2, "0")}</em>
                <span>{item}</span>
                {index < 3 && <ArrowRight size={14} />}
              </div>
            ))}
          </div>
        </section>

        <section className="container service-faq-grid">
          {service.faq.map(([question, answer]) => (
            <article key={question} className="service-faq-card">
              <CheckCircle2 size={18} />
              <h3>{question}</h3>
              <p>{answer}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">冒央会社 · Maoyang Taiwan Inc</div>
            <div className="footer-links">
              <Link href="/legal">企业资质与服务保障</Link>
              <Link href="/shop">返回选购</Link>
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
