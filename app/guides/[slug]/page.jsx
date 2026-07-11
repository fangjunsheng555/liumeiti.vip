import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ArrowRight, Headphones } from "lucide-react";
import FloatingSupport from "../../components/FloatingSupport";
import MobileNav from "../../components/MobileNav";
import { getServerLocale } from "../../lib/i18n-server";
import { getSettings } from "../../api/_settings.js";
import { GUIDES, getGuide, localizeGuide } from "../guides-data.js";
import { getServiceBySlug, localizeService } from "../../services/service-data";

const SITE_URL = "https://www.liumeiti.vip";

function StepDescription({ content }) {
  if (typeof content === "string") return <p>{content}</p>;

  return (
    <p>
      {(content?.parts || []).map((part, index) => {
        if (typeof part === "string") return part;
        return (
          <a
            key={`${part.href}-${index}`}
            className="guide-step-link"
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={part.ariaLabel || part.text}
          >
            {part.text}
          </a>
        );
      })}
    </p>
  );
}

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const raw = getGuide(slug);
  if (!raw) return { title: "Guide" };
  const locale = await getServerLocale();
  const g = localizeGuide(raw, locale);
  return {
    title: g.title,
    description: g.desc,
    alternates: { canonical: `/guides/${slug}` },
    openGraph: { title: g.title, description: g.desc, url: `/guides/${slug}`, type: "article" },
  };
}

export const dynamic = "force-dynamic";

export default async function GuidePage({ params }) {
  const { slug } = await params;
  const raw = getGuide(slug);
  if (!raw) notFound();
  const locale = await getServerLocale();
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const g = localizeGuide(raw, locale);
  const footerCfg = (await getSettings()).footer;

  // 关联服务(内链到服务页,提升转化 + SEO 内链)
  const svcRaw = getServiceBySlug(raw.service);
  const svc = svcRaw ? localizeService(svcRaw, locale) : null;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: g.title,
    description: g.desc,
    inLanguage: en ? "en" : "zh-CN",
    dateModified: raw.updated,
    author: { "@type": "Organization", name: en ? "Maoyang Taiwan Inc" : "冒央会社" },
    publisher: { "@type": "Organization", name: en ? "Maoyang Taiwan Inc" : "冒央会社" },
    mainEntityOfPage: `${SITE_URL}/guides/${slug}`,
  };
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: g.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };

  return (
    <div className="portal-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />

      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label={L("返回首页", "Back home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">{L("服务产品", "Services")}</Link>
            <Link href="/guides">{L("服务指南", "Guides")}</Link>
            <Link href="/service-center">{L("服务中心", "Service Center")}</Link>
            <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
          </nav>
        </div>
      </header>

      <main className="main-content portal-main guide-article-main">
        <nav className="container guide-breadcrumb" aria-label="breadcrumb">
          <Link href="/">{L("首页", "Home")}</Link><ChevronRight size={13} />
          <Link href="/guides">{L("服务指南", "Guides")}</Link><ChevronRight size={13} />
          <span>{g.title}</span>
        </nav>

        <article className="container guide-article">
          <header className="guide-article-head">
            <h1>{g.title}</h1>
            <p className="guide-article-intro">{g.intro}</p>
          </header>

          <section className="guide-section">
            <h2>{L("操作步骤", "Steps")}</h2>
            <ol className="guide-steps">
              {g.steps.map(([t, d], i) => (
                <li key={i}>
                  <span className="guide-step-num">{i + 1}</span>
                  <div><strong>{t}</strong><StepDescription content={d} /></div>
                </li>
              ))}
            </ol>
          </section>

          {svc && (
            <aside className="guide-cta-card">
              <img src={svc.image} alt={svc.shortTitle || svc.title} />
              <div className="guide-cta-body">
                <span className="section-kicker">{L("相关服务", "Related service")}</span>
                <strong>{svc.shortTitle || svc.title}</strong>
                <small>{svc.subtitle}</small>
              </div>
              <Link href={`/services/${raw.service}`} className="primary-btn">
                {L("去下单", "Order now")} <ArrowRight size={15} />
              </Link>
            </aside>
          )}

          <section className="guide-section">
            <h2>{L("常见问题", "FAQ")}</h2>
            <div className="guide-faq">
              {g.faq.map(([q, a], i) => (
                <div key={i} className="guide-faq-item">
                  <h3>{q}</h3>
                  <p>{a}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="guide-help">
            <Headphones size={15} />
            {L("还有疑问?", "Still have questions?")}
            <Link href="/service-center#contact">{L("联系在线客服", "Contact support")}</Link>
          </div>
        </article>
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">{en ? footerCfg.brandEn : footerCfg.brand}</div>
            <div className="footer-links">
              <Link href="/guides">{L("全部教程", "All guides")}</Link>
              <Link href="/shop">{L("服务产品", "Services")}</Link>
              <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{en ? footerCfg.addressEn : footerCfg.address}</div>
            <div className="footer-pill">{footerCfg.copyright}</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
