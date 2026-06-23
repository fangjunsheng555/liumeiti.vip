"use client";

// 主站访客埋点 + 首次来源归因。首访 + 每次 SPA 路由切换发信标到 /api/track。
// 归因 lm_attr：首访写一次（Domain=.liumeiti.vip 跨子域共享，180 天），结算时随订单上报。
// 静默采集，无隐私提示（见站主要求）。
import { useEffect } from "react";
import { usePathname } from "next/navigation";

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function ensureAttr() {
  try {
    const existing = readCookie("lm_attr");
    if (existing) { try { return JSON.parse(existing); } catch (e) { return null; } }
    const p = new URLSearchParams(window.location.search || "");
    let externalRef = "";
    try {
      const r = document.referrer || "";
      if (r) {
        const h = new URL(r).hostname.replace(/^www\./, "");
        if (h !== "liumeiti.vip" && !/\.liumeiti\.vip$/.test(new URL(r).hostname)) externalRef = r.slice(0, 200);
      }
    } catch (e) {}
    const attr = {};
    const us = (p.get("utm_source") || "").slice(0, 200); if (us) attr.utm_source = us;
    const um = (p.get("utm_medium") || "").slice(0, 200); if (um) attr.utm_medium = um;
    const uc = (p.get("utm_campaign") || "").slice(0, 200); if (uc) attr.utm_campaign = uc;
    if (externalRef) attr.referrer = externalRef;
    attr.landing = ((window.location.pathname || "/") + (window.location.search || "")).slice(0, 200);
    attr.firstTs = Date.now();
    document.cookie = "lm_attr=" + encodeURIComponent(JSON.stringify(attr)) + "; Path=/; Domain=.liumeiti.vip; Max-Age=" + 60 * 60 * 24 * 180 + "; SameSite=Lax";
    return attr;
  } catch (e) { return null; }
}

export default function VisitTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const attr = ensureAttr();
    const path = (window.location.pathname || "/") + (window.location.search || "");
    try {
      fetch("/api/track", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, site: "main", ref: document.referrer || "", attr }),
      }).catch(() => {});
    } catch (e) {}
  }, [pathname]);
  return null;
}
