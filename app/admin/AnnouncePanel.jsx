"use client";

// 后台「站内公告」编辑。仅超级管理员。设置后前端 banner 展示（可点链接、可关闭）。
import { useEffect, useState } from "react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", border: "var(--border, #d2d2d7)",
  surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)", accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)",
};

export default function AnnouncePanel() {
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/announcement", { credentials: "same-origin", cache: "no-store" });
        const d = await r.json();
        if (d && d.ok && d.announce) { setText(d.announce.text || ""); setLink(d.announce.link || ""); setActive(!!d.announce.active); }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  async function save() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/admin/announcement", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, link, active }) });
      const d = await r.json();
      setMsg(d && d.ok ? "✅ 已保存" + (active ? "并发布" : "（未启用）") : "保存失败");
    } catch (e) { setMsg("保存失败"); }
    setBusy(false);
  }

  const inp = { width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
  const label = { display: "block", fontSize: 12.5, color: C.muted, fontWeight: 600, margin: "0 0 6px" };

  return (
    <div style={{ color: C.text, maxWidth: 560 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>站内公告</h2>
      <p style={{ color: C.muted, fontSize: 12.5, margin: "0 0 16px" }}>启用后在站点顶部展示一条横幅（可点链接、用户可关闭）。修改内容后旧的"已关闭"状态会重置。</p>
      {loading ? <div style={{ color: C.muted }}>加载中…</div> : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>公告内容</label>
            <input style={inp} value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder="例如：新增 HBO Max 会员，限时 8 折！" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>链接（可选，点击横幅跳转）</label>
            <input style={inp} value={link} maxLength={300} onChange={(e) => setLink(e.target.value)} placeholder="https://www.liumeiti.vip/services/max" />
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", marginBottom: 16 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> 启用（在前端展示）
          </label>
          {text && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...label }}>预览</div>
              <div style={{ background: C.accent, color: "#fff", padding: "10px 16px", borderRadius: 10, fontSize: 13.5, fontWeight: 600 }}>{text}{link ? " ›" : ""}</div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button type="button" onClick={save} disabled={busy} style={{ padding: "9px 22px", borderRadius: 10, border: 0, background: C.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>{busy ? "保存中…" : "保存"}</button>
            {msg && <span style={{ fontSize: 13, color: C.accent }}>{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
