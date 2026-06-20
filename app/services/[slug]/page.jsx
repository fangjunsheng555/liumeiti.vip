import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, BadgeCheck, CheckCircle2, ShieldCheck } from "lucide-react";
import FloatingSupport from "../../components/FloatingSupport";
import MobileNav from "../../components/MobileNav";
import { getServiceBySlug, localizeService, SERVICE_PAGES } from "../service-data";
import ServiceOrderActions from "../ServiceOrderActions";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../../social-meta";
import { getServerLocale } from "../../lib/i18n-server";
import { getT } from "../../lib/i18n";
import { getAiSoldOutMap, AI_STOCK_PLAN_IDS } from "../../api/_utils.js";

export function generateStaticParams() {
  return SERVICE_PAGES.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const raw = getServiceBySlug(slug);
  if (!raw) return {};
  const locale = await getServerLocale();
  const en = locale === "en";
  const service = localizeService(raw, locale);
  const title = `${service.title} ${service.price}`;
  const brand = en ? "Maoyang Taiwan Inc" : "冒央会社";
  return {
    title,
    description: service.description,
    alternates: { canonical: `/services/${service.slug}` },
    openGraph: {
      title: `${title} | ${brand}`,
      description: service.description,
      url: `/services/${service.slug}`,
      locale: en ? "en_US" : "zh_CN",
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary",
      title: `${title} | ${brand}`,
      description: service.description,
      images: [SOCIAL_IMAGE],
    },
  };
}

export default async function ServiceLandingPage({ params }) {
  const { slug } = await params;
  const raw = getServiceBySlug(slug);
  if (!raw) notFound();
  const locale = await getServerLocale();
  const t = getT(locale);
  const service = localizeService(raw, locale);

  const aiSoldOut = service.key === "ai" ? await getAiSoldOutMap() : {};
  const aiAllSoldOut = service.key === "ai" && AI_STOCK_PLAN_IDS.length > 0 && AI_STOCK_PLAN_IDS.every((id) => aiSoldOut[id]);

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
        availability: aiAllSoldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
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
            <Link href="/shop">{t("nav.services")}</Link>
            <Link href="/service-center">{t("nav.serviceCenter")}</Link>
            <Link href="/legal">{t("nav.legal")}</Link>
            <Link href="/service-center#contact">{t("nav.contact")}</Link>
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
            <ServiceOrderActions service={service} soldOut={aiSoldOut} />
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
              <h2 className="section-title">{t("svc.plansTitle")}</h2>
            </div>
          </div>
          <div className="service-plan-grid">
            {service.plans.map(([name, price, desc], i) => {
              const planSoldOut = service.key === "ai" && aiSoldOut[AI_STOCK_PLAN_IDS[i]];
              return (
              <article key={name} className={`service-plan-card${planSoldOut ? " sold-out" : ""}`}>
                <span>{name}{planSoldOut ? ` · ${locale === "en" ? "Sold out" : "已售罄"}` : ""}</span>
                <b>{price}</b>
                <p>{desc}</p>
              </article>
              );
            })}
          </div>
        </section>

        <section className="container service-process-card">
          <div className="service-process-title">
            <ShieldCheck size={18} />
            <div>
              <h2>{t("svc.orderTitle")}</h2>
              <p>{t("svc.orderDesc")}</p>
            </div>
          </div>
          <div className="service-process-steps">
            {[t("svc.step1"), t("svc.step2"), t("svc.step3"), t("svc.step4")].map((item, index) => (
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
            <div className="footer-brand">{t("footer.brand")}</div>
            <div className="footer-links">
              <Link href="/legal">{t("footer.legal")}</Link>
              <Link href="/shop">{t("svc.back")}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{t("footer.address")}</div>
            <div className="footer-pill">{t("footer.copyright")}</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
