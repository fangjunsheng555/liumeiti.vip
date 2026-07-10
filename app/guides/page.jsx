import Link from "next/link";
import { BookOpen, ArrowRight } from "lucide-react";
import FloatingSupport from "../components/FloatingSupport";
import MobileNav from "../components/MobileNav";
import { getServerLocale } from "../lib/i18n-server";
import { getSettings } from "../api/_settings.js";
import { GUIDES, localizeGuide } from "./guides-data.js";

const SITE_URL = "https://www.liumeiti.vip";

export async function generateMetadata() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const title = en ? "Guides & How-tos" : "使用教程与购买指南";
  const description = en
    ? "Step-by-step guides: buying Spotify/Netflix/AI memberships, VPN nodes, and proxy payment for overseas websites."
    : "手把手教程:Spotify/Netflix/AI 会员购买、机场节点配置、海外网站全球代付,一看就会。";
  return {
    title,
    description,
    alternates: { canonical: "/guides" },
    openGraph: { title, description, url: "/guides", type: "website" },
  };
}

export const dynamic = "force-dynamic";

export default async function GuidesIndexPage() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const footerCfg = (await getSettings()).footer;
  const guides = GUIDES.map((g) => localizeGuide(g, locale));

  return (
    <div className="portal-page">
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label={L("返回首页", "Back home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">{L("服务产品", "Services")}</Link>
            <Link href="/guides">{L("使用教程", "Guides")}</Link>
            <Link href="/service-center">{L("服务中心", "Service Center")}</Link>
            <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
          </nav>
        </div>
      </header>

      <main className="main-content portal-main guides-main">
        <section className="container guides-hero">
          <div className="section-kicker"><BookOpen size={13} /> {L("使用教程", "Guides")}</div>
          <h1>{L("使用教程与购买指南", "Guides & How-tos")}</h1>
          <p>{L("从选规格到开通、从代付申请到节点配置,常见问题一篇讲清。", "From choosing a plan to activation, proxy-pay requests to node setup — the common questions, answered.")}</p>
        </section>

        <section className="container guides-grid">
          {guides.map((g) => (
            <Link key={g.slug} href={`/guides/${g.slug}`} className="guide-card">
              <h2>{g.title}</h2>
              <p>{g.desc}</p>
              <span className="guide-card-cta">{L("阅读教程", "Read guide")} <ArrowRight size={14} /></span>
            </Link>
          ))}
        </section>
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">{en ? footerCfg.brandEn : footerCfg.brand}</div>
            <div className="footer-links">
              <Link href="/shop">{L("服务产品", "Services")}</Link>
              <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
              <Link href="/service-center">{L("服务中心", "Service Center")}</Link>
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
