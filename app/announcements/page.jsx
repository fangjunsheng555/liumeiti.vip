import Link from "next/link";
import { Megaphone, Pin, CalendarDays } from "lucide-react";
import FloatingSupport from "../components/FloatingSupport";
import MobileNav from "../components/MobileNav";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";
import { getServerLocale } from "../lib/i18n-server";
import { redisCmd } from "../api/_utils.js";
import { getSettings } from "../api/_settings.js";

export async function generateMetadata() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const title = en ? "Announcement Center" : "公告中心";
  const ogTitle = en ? "Announcement Center | Maoyang Taiwan Inc" : "公告中心 | 冒央会社";
  const description = en
    ? "Company news, business updates, system notices and promotions from Maoyang Taiwan Inc — all in one place."
    : SOCIAL_DESCRIPTION;
  return {
    title,
    description,
    alternates: { canonical: "/announcements" },
    openGraph: {
      title: ogTitle,
      description,
      url: "/announcements",
      locale: en ? "en_US" : "zh_CN",
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [SOCIAL_IMAGE],
    },
  };
}

const CATEGORY_META = {
  company: { zh: "公司公告", en: "Company", cls: "company" },
  business: { zh: "业务动态", en: "Business updates", cls: "business" },
  system: { zh: "网站 / 系统", en: "System", cls: "system" },
  promo: { zh: "活动公告", en: "Promotion", cls: "promo" },
};

const ANC_STYLES = `
.anc-main{padding-bottom:72px}
.anc-hero{text-align:center;padding:56px 20px 8px;max-width:780px;margin:0 auto}
.anc-hero .section-kicker{justify-content:center;display:flex}
.anc-hero h1{font-size:clamp(28px,4.4vw,40px);line-height:1.12;letter-spacing:-.02em;color:#0f172a;margin:14px 0 12px;font-weight:800}
.anc-hero p{color:#64748b;font-size:16px;line-height:1.6;margin:0 auto;max-width:560px}
.anc-list{max-width:760px;margin:24px auto 0;padding:0 20px;display:flex;flex-direction:column;gap:10px}
.anc-card{position:relative;background:#fff;border:1px solid #e2e8f0;border-radius:13px;padding:14px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 22px -20px rgba(15,23,42,.26);transition:box-shadow .2s ease,transform .2s ease,border-color .2s ease}
.anc-card:hover{box-shadow:0 1px 2px rgba(15,23,42,.05),0 14px 32px -22px rgba(15,23,42,.32);border-color:#cbd5e1}
.anc-card.is-pinned{border-color:rgba(15,118,110,.32);background:linear-gradient(180deg,rgba(20,184,166,.05),#fff 52px)}
.anc-card.is-pinned::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:linear-gradient(180deg,#14b8a6,#0f766e)}
.anc-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.anc-date{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;letter-spacing:.01em;color:#0f766e;background:rgba(20,184,166,.12);border:1px solid rgba(15,118,110,.2);padding:3px 9px;border-radius:999px;font-variant-numeric:tabular-nums}
.anc-date svg{opacity:.85}
.anc-tag{display:inline-flex;align-items:center;font-size:11.5px;font-weight:700;letter-spacing:.02em;padding:3px 9px;border-radius:999px;border:1px solid transparent}
.anc-tag.company{color:#1d4ed8;background:rgba(37,99,235,.1);border-color:rgba(37,99,235,.22)}
.anc-tag.business{color:#0f766e;background:rgba(15,118,110,.1);border-color:rgba(15,118,110,.22)}
.anc-tag.system{color:#475569;background:rgba(71,85,105,.1);border-color:rgba(71,85,105,.2)}
.anc-tag.promo{color:#b45309;background:rgba(217,119,6,.12);border-color:rgba(217,119,6,.24)}
.anc-pin{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;letter-spacing:.02em;color:#0f766e;background:#fff;border:1px solid rgba(15,118,110,.3);padding:3px 9px;border-radius:999px}
.anc-pin svg{transform:rotate(40deg)}
.anc-title{font-size:16px;line-height:1.4;font-weight:750;color:#0f172a;letter-spacing:-.01em;margin:0 0 5px}
.anc-body{font-size:13.5px;line-height:1.62;color:#334155;white-space:pre-wrap;word-break:break-word;margin:0}
.anc-empty{max-width:560px;margin:48px auto 0;text-align:center;background:#fff;border:1px dashed #cbd5e1;border-radius:20px;padding:56px 28px;color:#64748b}
.anc-empty-icon{width:60px;height:60px;margin:0 auto 18px;border-radius:18px;display:flex;align-items:center;justify-content:center;color:#0f766e;background:rgba(20,184,166,.12);border:1px solid rgba(15,118,110,.18)}
.anc-empty strong{display:block;font-size:18px;color:#0f172a;font-weight:750;margin-bottom:6px}
.anc-empty span{font-size:14px;line-height:1.6}
@media (max-width:640px){
  .anc-hero{padding:40px 16px 4px}
  .anc-list{padding:0 14px;gap:9px;margin-top:20px}
  .anc-card{padding:13px 15px;border-radius:12px}
  .anc-card.is-pinned::before{left:0;top:11px;bottom:11px}
  .anc-title{font-size:15.5px}
  .anc-body{font-size:13.5px}
}
`;

export default async function AnnouncementsPage() {
  const locale = await getServerLocale();
  const en = locale === "en";
  const L = (zh, e) => (en ? e : zh);
  const footerCfg = (await getSettings()).footer; // 页脚随站点设置

  let posts = [];
  try {
    const raw = await redisCmd(["GET", "lm:announce:posts"]);
    if (raw) posts = JSON.parse(raw);
  } catch (e) {}

  const list = (Array.isArray(posts) ? posts : [])
    .filter((p) => p && p.published === true)
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return String(b.date || "").localeCompare(String(a.date || ""));
    });

  return (
    <div className="page-shell portal-page-shell">
      <style dangerouslySetInnerHTML={{ __html: ANC_STYLES }} />
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label={L("返回首页", "Back home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">{L("服务产品", "Services")}</Link>
            <Link href="/service-center">{L("服务中心", "Service Center")}</Link>
            <Link href="/announcements">{L("公告中心", "Announcements")}</Link>
            <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
            <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
          </nav>
        </div>
      </header>

      <main className="main-content portal-main anc-main">
        <section className="anc-hero">
          <div className="section-kicker">ANNOUNCEMENTS</div>
          <h1>{L("公告中心", "Announcement Center")}</h1>
          <p>
            {L(
              "公司动态、业务更新、系统通知与活动公告集中发布，及时了解平台最新进展",
              "Company news, business updates, system notices and promotions — stay up to date with the latest from Maoyang Taiwan Inc."
            )}
          </p>
        </section>

        {list.length === 0 ? (
          <div className="anc-empty">
            <div className="anc-empty-icon"><Megaphone size={28} /></div>
            <strong>{L("暂无公告", "No announcements yet")}</strong>
            <span>{L("最新公司与业务公告将在这里发布，敬请关注", "New company and business announcements will appear here. Stay tuned.")}</span>
          </div>
        ) : (
          <div className="anc-list">
            {list.map((post) => {
              const cat = CATEGORY_META[post.category];
              const title = en ? (post.titleEn || post.title) : post.title;
              const body = en ? (post.bodyEn || post.body) : post.body;
              return (
                <article key={post.id} className={`anc-card${post.pinned ? " is-pinned" : ""}`}>
                  <div className="anc-meta">
                    {post.date && (
                      <span className="anc-date"><CalendarDays size={13} />{post.date}</span>
                    )}
                    {cat && <span className={`anc-tag ${cat.cls}`}>{L(cat.zh, cat.en)}</span>}
                    {post.pinned && (
                      <span className="anc-pin"><Pin size={12} />{L("置顶", "Pinned")}</span>
                    )}
                  </div>
                  {title && <h2 className="anc-title">{title}</h2>}
                  {body && <p className="anc-body">{body}</p>}
                </article>
              );
            })}
          </div>
        )}
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">{en ? footerCfg.brandEn : footerCfg.brand}</div>
            <div className="footer-links">
              <Link href="/legal">{L("企业资质与服务保障", "Credentials & service assurance")}</Link>
              <Link href="/announcements">{L("公告中心", "Announcements")}</Link>
              <Link href="/service-center#contact">{L("联系我们", "Contact")}</Link>
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
