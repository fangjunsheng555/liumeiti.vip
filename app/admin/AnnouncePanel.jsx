"use client";

// 后台「站内公告」编辑。仅超级管理员。设置后前端 banner 展示（可点链接、可关闭）。
import { useEffect, useState } from "react";
import { Megaphone, CheckCircle2, AlertTriangle, LoaderCircle } from "lucide-react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)", border: "var(--border, #d2d2d7)",
  surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)", accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626", ok: "#16a34a",
};
const MAX = 300;

export default function AnnouncePanel() {
  const [text, setText] = useState("");
  const [textEn, setTextEn] = useState("");
  const [link, setLink] = useState("");
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: "ok"|"error", text } | null

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/announcement", { credentials: "same-origin", cache: "no-store" });
        const d = await r.json();
        if (d && d.ok && d.announce) { setText(d.announce.text || ""); setTextEn(d.announce.textEn || ""); setLink(d.announce.link || ""); setActive(!!d.announce.active); }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/announcement", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, textEn, link, active }) });
      const d = await r.json();
      if (d && d.ok) setMsg({ type: "ok", text: active ? "已保存并发布到站点顶部" : "已保存（未启用，不会展示）" });
      else setMsg({ type: "error", text: "保存失败，请重试" });
    } catch (e) { setMsg({ type: "error", text: "保存失败，请重试" }); }
    setBusy(false);
  }

  const inp = { width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
  const label = { display: "block", fontSize: 12.5, color: C.muted, fontWeight: 600, margin: "0 0 6px" };
  const counter = (v) => <div style={{ textAlign: "right", fontSize: 11, color: v.length >= MAX ? C.danger : C.faint, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{v.length}/{MAX}</div>;
  const card = { border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 18, maxWidth: 560 };

  // 预览：忠实还原前端 banner（与 AnnounceBar 同步:喇叭图标 + 品牌渐变 + ›链接提示 + 圆形 × 关闭）
  const Banner = ({ value, tag }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 11, background: "linear-gradient(100deg,#0f766e 0%,#115e59 48%,#134e4a 100%)", color: "#fff", padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 650, lineHeight: 1.45 }}>
      <span style={{ flex: "none", display: "inline-grid", placeItems: "center", width: 24, height: 24, borderRadius: 8, background: "rgba(255,255,255,0.16)" }}><Megaphone size={14} /></span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}{link ? <span style={{ opacity: 0.85, marginLeft: 6, fontWeight: 800 }}>›</span> : null}{tag ? <em style={{ opacity: 0.7, fontStyle: "normal", fontWeight: 400, marginLeft: 6 }}>{tag}</em> : null}</span>
      <span style={{ flex: "none", display: "inline-grid", placeItems: "center", width: 24, height: 24, borderRadius: 999, background: "rgba(255,255,255,0.14)", fontSize: 14, lineHeight: 1 }}>×</span>
    </div>
  );

  return (
    <div style={{ color: C.text, maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px" }}>
        <Megaphone size={18} style={{ color: C.accent }} />
        <h2 style={{ fontSize: 18, margin: 0 }}>站内公告</h2>
      </div>
      <p style={{ color: C.muted, fontSize: 12.5, margin: "0 0 16px" }}>启用后在站点顶部展示一条横幅（可点链接、用户可关闭）。修改内容后旧的“已关闭”状态会自动重置，所有用户会重新看到。</p>

      {loading ? (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载中…</div>
      ) : (
        <div style={card}>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>公告内容（中文）</label>
            <input style={inp} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)} placeholder="例如：新增 HBO Max 会员，限时 8 折！" />
            {counter(text)}
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>公告内容（English，可选，留空则英文站也显示中文）</label>
            <input style={inp} value={textEn} maxLength={MAX} onChange={(e) => setTextEn(e.target.value)} placeholder="e.g. HBO Max memberships now available — 20% off!" />
            {counter(textEn)}
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>链接（可选，点击横幅跳转；仅支持 http(s):// 或站内 / 路径）</label>
            <input style={inp} value={link} maxLength={MAX} onChange={(e) => setLink(e.target.value)} placeholder="https://www.liumeiti.vip/services/max" />
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", marginBottom: 16 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> 启用（在前端展示）
          </label>

          {text && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ ...label, marginBottom: 8 }}>站点顶部实际效果预览</div>
              <Banner value={text} />
              {textEn && <div style={{ marginTop: 8 }}><Banner value={textEn} tag="EN" /></div>}
            </div>
          )}

          {msg && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600,
              background: msg.type === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${msg.type === "error" ? "#fecaca" : "#bbf7d0"}`, color: msg.type === "error" ? C.danger : C.ok }}>
              {msg.type === "error" ? <AlertTriangle size={15} style={{ flex: "none" }} /> : <CheckCircle2 size={15} style={{ flex: "none" }} />}
              <span>{msg.text}</span>
            </div>
          )}

          <button type="button" onClick={save} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 24px", borderRadius: 10, border: 0, background: "linear-gradient(135deg,#0f766e,#14b8a6)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy && <LoaderCircle size={15} className="spin-icon" />}{busy ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    </div>
  );
}
