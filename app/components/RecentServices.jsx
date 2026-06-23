"use client";

// 首页「最近看过的服务」个性化区块。读 localStorage lm_recent_services（service 页浏览时写入）。
// 无记录则不渲染（新访客首页无变化）。卡片复用首页 home-service-card 样式。
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SERVICE_PAGES } from "../services/service-data";

export default function RecentServices() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    try {
      const arr = JSON.parse(window.localStorage.getItem("lm_recent_services") || "[]");
      if (!Array.isArray(arr)) return;
      const byKey = new Map(SERVICE_PAGES.map((s) => [s.key, s]));
      setItems(arr.map((x) => byKey.get(x && x.key)).filter(Boolean).slice(0, 5));
    } catch (e) {}
  }, []);

  if (!items.length) return null;
  return (
    <section className="container home-services-section">
      <div className="section-head simple-head home-compact-head">
        <div><h2 className="section-title">最近看过的服务</h2></div>
      </div>
      <div className="home-services-grid">
        {items.map((s) => (
          <Link key={s.slug} href={`/services/${s.slug}`} className={`home-service-card svc-${s.slug}`}>
            <div className="home-service-logo-wrap">
              <img src={s.image} alt={s.shortTitle} className="home-service-logo" loading="lazy" decoding="async" width="56" height="56" />
            </div>
            <div className="home-service-info">
              <div className="home-service-name">{s.shortTitle}</div>
              <div className="home-service-sub">{s.subtitle}</div>
            </div>
            <div className="home-service-foot">
              <span className="home-service-price">{s.price}</span>
              <ArrowRight size={16} className="home-service-arrow" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
