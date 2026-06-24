"use client";

// 站内公告顶栏(主站)。读 /api/announcements 的 items 数组,3 秒轮播(只显示标题):
//  · 来源「站内公告」banner → 点击跳后台预设链接(新标签);
//  · 来源「公告中心」标记轮播的公告 → 点击进 /announcements(本站)。
// 用户可关闭(按当前内容签名记 localStorage,内容更新后重新出现)。
import { useEffect, useRef, useState } from "react";
import { Megaphone, X } from "lucide-react";

export default function AnnounceBar() {
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [hidden, setHidden] = useState(false);
  const sigRef = useRef("");

  useEffect(() => {
    let on = true;
    fetch("/api/announcements", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!on || !d || !d.ok) return;
        const list = (Array.isArray(d.items) ? d.items : []).filter((x) => x && x.text);
        if (!list.length) return;
        const sig = list.map((x) => String(x.id)).join("|");
        sigRef.current = sig;
        let dismissed = "";
        try { dismissed = window.localStorage.getItem("lm_announce_dismissed") || ""; } catch (e) {}
        if (dismissed === sig) return;
        setItems(list);
      })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  // 多条时每 5 秒轮播一条
  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 5000);
    return () => clearInterval(t);
  }, [items.length]);

  if (hidden || !items.length) return null;
  const cur = items[idx % items.length] || items[0];
  // AnnounceBar 在 LocaleProvider 之外,按 <html lang> 判断中/英。
  const en = (typeof document !== "undefined" ? (document.documentElement.lang || "") : "").toLowerCase().startsWith("en");
  const text = en && cur.textEn ? cur.textEn : cur.text;
  const link = /^(https?:\/\/|\/)/i.test(cur.link || "") ? cur.link : "";
  const internal = link.startsWith("/");   // 站内(公告中心)同标签;站外(预设链接)新标签

  const close = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { window.localStorage.setItem("lm_announce_dismissed", sigRef.current); } catch (e2) {}
    setHidden(true);
  };

  const textStyle = {
    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    color: "#1f2937", textDecoration: "none",
  };
  const barStyle = {
    position: "relative",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "5px 44px",
    background: "#ffffff",
    color: "#1f2937", fontSize: 13, fontWeight: 600, lineHeight: 1.4,
    borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
  };
  const inner = (
    <>
      {text}<span style={{ color: "#94a3b8", marginLeft: 6, fontWeight: 700 }}>›</span>
    </>
  );
  return (
    <div style={barStyle} role="region" aria-label={en ? "Announcement" : "公告"}>
      <style>{"@keyframes lmAnnFade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}"}</style>
      {/* 左侧:简洁中性图标(无底框、非绿) */}
      <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", display: "inline-flex", color: "#94a3b8" }} aria-hidden="true">
        <Megaphone size={15} />
      </span>
      {/* 居中文案 */}
      <span key={cur.id + ":" + idx} style={{ maxWidth: "min(1100px, 100%)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", animation: "lmAnnFade .42s ease" }}>
        {link
          ? <a href={link} {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })} style={textStyle}>{inner}</a>
          : <span style={textStyle}>{text}</span>}
      </span>
      <button
        type="button"
        onClick={close}
        aria-label={en ? "Dismiss" : "关闭"}
        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 999, background: "transparent", border: 0, color: "#94a3b8", cursor: "pointer", padding: 0 }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
