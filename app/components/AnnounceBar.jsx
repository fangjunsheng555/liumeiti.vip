"use client";

// 站内公告横幅（主站）。读 /api/announcements；用户可关闭（按公告 id 记 localStorage，内容更新后重新出现）。
import { useEffect, useState } from "react";

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
  const close = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { window.localStorage.setItem("lm_announce_dismissed", String(a.id)); } catch (e2) {}
    setA(null);
  };
  const inner = (
    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {a.text}{a.link ? " ›" : ""}
    </span>
  );
  const barStyle = {
    display: "flex", alignItems: "center", gap: 12, padding: "9px 16px",
    background: "var(--accent, #0f766e)", color: "#fff", fontSize: 13.5, fontWeight: 600, lineHeight: 1.4,
  };
  return (
    <div style={barStyle} role="region" aria-label="公告">
      {a.link
        ? <a href={a.link} style={{ flex: 1, minWidth: 0, color: "#fff", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.text} ›</a>
        : inner}
      <button type="button" onClick={close} aria-label="关闭" style={{ flex: "none", background: "transparent", border: 0, color: "#fff", fontSize: 18, lineHeight: 1, cursor: "pointer", opacity: 0.85, padding: 0 }}>×</button>
    </div>
  );
}
