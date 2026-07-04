import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ArrowRight, BadgeCheck, CheckCircle2, ShieldCheck } from "lucide-react";
import FloatingSupport from "../../components/FloatingSupport";
import MobileNav from "../../components/MobileNav";
import { getServiceBySlug, localizeService, SERVICE_ALIASES, SERVICE_PAGES } from "../service-data";
import ServiceOrderActions from "../ServiceOrderActions";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../../social-meta";
import { getServerLocale } from "../../lib/i18n-server";
import { getT } from "../../lib/i18n";
import { getCatalogSoldOutMap } from "../../api/_utils.js";
import { getMergedCatalog } from "../../api/_catalog.js";
import { getSettings } from "../../api/_settings.js";

// 把后台合并目录的价格/规格覆盖到服务页(与首页/选购/结账完全一致)。
// 名称/说明保持本地化(中英),价格取目录权威 amount;商品下架则 404。
function applyCatalogToService(service, catProd, locale, soldOutMap = {}) {
  if (!catProd) return service;
  const activePlans = (catProd.plans || []).filter((pl) => pl.active !== false);
  const next = { ...service };
  if (locale !== "en" && catProd.priceText) next.price = catProd.priceText;
  const cycleShort = (c) => String(c || "").replace(/^1/, "");
  if (Array.isArray(service.plans) && activePlans.length) {
    // 第4位 = 该规格是否售罄(库存0),供下方规格卡用
    next.plans = activePlans.map((pl, i) => {
      const orig = service.plans[i] || [];
      const name = locale === "en" ? (orig[0] || pl.label) : pl.label;
      const desc = locale === "en" ? (orig[2] || pl.desc) : pl.desc;
      return [name, `¥${pl.amount}/${cycleShort(pl.cycle)}`, desc, !!soldOutMap[catProd.key + ":" + pl.id]];
    });
    next.planIds = activePlans.map((pl) => pl.id);
  }
  return next;
}

export const dynamic = "force-dynamic"; // 始终读最新商品覆盖(价格/上下架),不静态缓存

export const dynamicParams = false;

export function generateStaticParams() {
  return Array.from(new Set([...SERVICE_PAGES.map((item) => item.slug), ...Object.keys(SERVICE_ALIASES)]))
    .map((slug) => ({ slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const raw = getServiceBySlug(slug);
  if (!raw) notFound();
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
      card: "summary_large_image",
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
  if (String(slug || "").toLowerCase() !== raw.slug) permanentRedirect(`/services/${raw.slug}`);
  const locale = await getServerLocale();
  const t = getT(locale);
  const catalog = await getMergedCatalog();
  const settings = await getSettings(); // 站点设置(页脚同步)
  const footerCfg = settings.footer;
  const catProd = catalog.find((p) => p.key === raw.key);
  if (catProd && catProd.active === false) notFound(); // 已下架
  const soldOutMap = await getCatalogSoldOutMap(catProd ? [catProd] : []); // { "<key>:<planId>": true }
  const service = applyCatalogToService(localizeService(raw, locale), catProd, locale, soldOutMap);

  // 该商品的 { planId: 售罄 } 映射(传给下单 CTA;与库存0即时一致)
  const planSoldOut = {};
  (catProd?.plans || []).forEach((pl) => { if (soldOutMap[catProd.key + ":" + pl.id]) planSoldOut[pl.id] = true; });
  const allSoldOut = Boolean(catProd) && (catProd.plans || []).filter((pl) => pl.active !== false).length > 0
    && (catProd.plans || []).filter((pl) => pl.active !== false).every((pl) => soldOutMap[catProd.key + ":" + pl.id]);

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
        availability: allSoldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
        url: `https://www.liumeiti.vip/services/${service.slug}`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: locale === "en" ? "Home" : "首页", item: "https://www.liumeiti.vip/" },
        { "@type": "ListItem", position: 2, name: locale === "en" ? "Services" : "服务产品", item: "https://www.liumeiti.vip/shop" },
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
          <Link href="/" className="brand-wrap" aria-label={locale === "en" ? "Back home" : "返回首页"}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
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
        <nav className="container service-breadcrumb" aria-label={locale === "en" ? "Breadcrumb" : "面包屑导航"}>
          <Link href="/">{locale === "en" ? "Home" : "首页"}</Link>
          <span aria-hidden="true">/</span>
          <Link href="/shop">{locale === "en" ? "Services" : "服务产品"}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{service.shortTitle}</span>
        </nav>

        <section className="container service-seo-hero">
          <div className="service-seo-copy">
            <div className="section-kicker">{locale === "en" ? "Service detail" : "服务详情"}</div>
            <h1>{service.title}</h1>
            <p>{service.description}</p>
            <div className="service-seo-badges">
              {service.highlights.map((item) => (
                <span key={item}><BadgeCheck size={14} />{item}</span>
              ))}
            </div>
            <ServiceOrderActions service={service} soldOut={planSoldOut} />
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
              <div className="section-kicker">{locale === "en" ? "Plan options" : "规格方案"}</div>
              <h2 className="section-title">{t("svc.plansTitle")}</h2>
            </div>
          </div>
          <div className="service-plan-grid">
            {service.plans.map(([name, price, desc, planOut], i) => {
              return (
              <article key={name} className={`service-plan-card${planOut ? " sold-out" : ""}`}>
                <span>{name}{planOut ? ` · ${locale === "en" ? "Sold out" : "已售罄"}` : ""}</span>
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
            <div className="footer-brand">{locale === "en" ? footerCfg.brandEn : footerCfg.brand}</div>
            <div className="footer-links">
              <Link href="/legal">{t("footer.legal")}</Link>
              <Link href="/shop">{t("svc.back")}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{locale === "en" ? footerCfg.addressEn : footerCfg.address}</div>
            <div className="footer-pill">{footerCfg.copyright}</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
