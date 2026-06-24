"use client";

// 站内公告横幅（主站）。读 /api/announcements；用户可关闭（按公告 id 记 localStorage，内容更新后重新出现）。
import { useEffect, useState } from "react";
import { Megaphone, X } from "lucide-react";

export default function AnnounceBar() {
  const [a, setA] = useState(null);

  useEffect(() => {
    let on = true;
    fetch("/api/announcements", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!on || !d || !d.ok || !d.text) return;
        let dismissed = "";
        try { dismissed = window.localStorage.getItem("lm_announce_dismissed") || ""; } catch (e) {}
        if (String(d.id) === dismissed) return;
        setA(d);
      })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  if (!a) return null;
  // AnnounceBar 在 LocaleProvider 之外，不能用 useLocale；按 <html lang> 判断中/英。
  const en = (typeof document !== "undefined" ? (document.documentElement.lang || "") : "").toLowerCase().startsWith("en");
  const text = en && a.textEn ? a.textEn : a.text;
  // 渲染侧兜底：只接受 http(s) 绝对链接或站内相对链接，过滤危险协议。
  const link = /^(https?:\/\/|\/)/i.test(a.link || "") ? a.link : "";
  const close = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { window.localStorage.setItem("lm_announce_dismissed", String(a.id)); } catch (e2) {}
    setA(null);
  };
  const textStyle = {
    flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    color: "#fff", textDecoration: "none", letterSpacing: ".005em",
  };
  const barStyle = {
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "10px 16px",
    background: "linear-gradient(100deg, #0f766e 0%, #115e59 48%, #134e4a 100%)",
    color: "#fff", fontSize: 13.5, fontWeight: 650, lineHeight: 1.45,
    borderBottom: "1px solid rgba(8, 47, 43, 0.55)",
    boxShadow: "0 1px 0 rgba(255,255,255,0.06) inset",
  };
  return (
    <div style={barStyle} role="region" aria-label={en ? "Announcement" : "公告"}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, width: "min(1180px, 100%)" }}>
        <span style={{ flex: "none", display: "inline-grid", placeItems: "center", width: 26, height: 26, borderRadius: 9, background: "rgba(255,255,255,0.16)" }} aria-hidden="true">
          <Megaphone size={15} />
        </span>
        {link
          ? <a href={link} style={textStyle}>{text}<span style={{ opacity: 0.85, marginLeft: 6, fontWeight: 800 }}>›</span></a>
          : <span style={textStyle}>{text}</span>}
        <button
          type="button"
          onClick={close}
          aria-label={en ? "Dismiss" : "关闭"}
          style={{ flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 999, background: "rgba(255,255,255,0.14)", border: 0, color: "#fff", cursor: "pointer", opacity: 0.9, padding: 0, marginRight: -2 }}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
