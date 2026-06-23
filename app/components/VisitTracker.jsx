"use client";

// 主站访客埋点：首次加载 + 每次 SPA 路由切换，向 /api/track 发一个轻量信标。
// IP/UA/北京时间在服务端取；这里只发路径。keepalive 让其在页面卸载时也能送达。
import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function VisitTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = (window.location.pathname || "/") + (window.location.search || "");
    try {
      fetch("/api/track", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, site: "main", ref: document.referrer || "" }),
      }).catch(() => {});
    } catch (e) {}
  }, [pathname]);
  return null;
}
