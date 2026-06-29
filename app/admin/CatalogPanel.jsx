"use client";

// 商品/价格管理 — 仅超级管理员。读写 /api/admin/catalog。
// 改价格/规格/文案/上下架/排序,保存后前端(首页/选购/服务页/结账)与结账实收价即时跟随。
import { useEffect, useState, useCallback } from "react";
import { LoaderCircle, Save, RotateCcw, Package, AlertTriangle, CheckCircle2 } from "lucide-react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)",
};

const inp = { width: "100%", padding: "7px 9px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 13, boxSizing: "border-box" };
const lbl = { fontSize: 11, color: C.muted, fontWeight: 700, marginBottom: 3, display: "block" };

export default function CatalogPanel() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/catalog", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setCatalog(j.catalog);
      else setMsg({ type: "error", text: j.error === "unauthorized" ? "仅超级管理员可管理商品" : (j.error || "加载失败") });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function patchProduct(key, field, value) {
    setCatalog((c) => c.map((p) => (p.key === key ? { ...p, [field]: value } : p)));
  }
  function patchPlan(key, planId, field, value) {
    setCatalog((c) => c.map((p) => (p.key === key
      ? { ...p, plans: p.plans.map((pl) => (pl.id === planId ? { ...pl, [field]: value } : pl)) }
      : p)));
  }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/catalog", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog }),
      });
      const j = await r.json();
      if (j.ok) { setCatalog(j.catalog); setMsg({ type: "ok", text: "已保存 · 前端与结账价格已即时更新" }); }
      else setMsg({ type: "error", text: j.error || "保存失败" });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setSaving(false); }
  }

  if (loading && !catalog) return <div style={{ display: "inline-flex", gap: 8, alignItems: "center", color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载商品…</div>;
  if (!catalog) return msg ? <div style={{ display: "flex", gap: 8, padding: "10px 13px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13 }}><AlertTriangle size={15} />{msg.text}</div> : null;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0, display: "inline-flex", alignItems: "center", gap: 7 }}><Package size={18} />商品 / 价格管理</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>改价格/规格/文案/上下架，保存后前端与结账即时生效</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={load} disabled={saving} style={{ ...inp, width: "auto", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 700 }}><RotateCcw size={13} />重载</button>
        <button type="button" onClick={save} disabled={saving} style={{ width: "auto", padding: "8px 16px", borderRadius: 9, border: "none", background: C.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存全部"}
        </button>
      </div>
      {msg && <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600, background: msg.type === "ok" ? "#ecfdf5" : "#fef2f2", border: `1px solid ${msg.type === "ok" ? "#a7f3d0" : "#fecaca"}`, color: msg.type === "ok" ? "#047857" : "#dc2626" }}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      <div style={{ display: "grid", gap: 14 }}>
        {catalog.map((p) => (
          <div key={p.key} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 14, opacity: p.active === false ? 0.62 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{p.title}</strong>
              <code style={{ fontSize: 11, color: C.faint }}>{p.key}</code>
              <span style={{ flex: 1 }} />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: p.active === false ? "#b91c1c" : C.accent }}>
                <input type="checkbox" checked={p.active !== false} onChange={(e) => patchProduct(p.key, "active", e.target.checked)} />
                {p.active === false ? "已下架" : "上架中"}
              </label>
              <label style={{ fontSize: 12, color: C.muted }}>排序<input type="number" value={p.sort ?? 0} onChange={(e) => patchProduct(p.key, "sort", Number(e.target.value))} style={{ ...inp, width: 64, marginLeft: 5, display: "inline-block", padding: "5px 7px" }} /></label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 12 }}>
              <div><span style={lbl}>名称</span><input style={inp} value={p.title || ""} onChange={(e) => patchProduct(p.key, "title", e.target.value)} /></div>
              <div><span style={lbl}>副标题</span><input style={inp} value={p.subtitle || ""} onChange={(e) => patchProduct(p.key, "subtitle", e.target.value)} /></div>
              <div><span style={lbl}>列表展示价(文案)</span><input style={inp} value={p.priceText || ""} onChange={(e) => patchProduct(p.key, "priceText", e.target.value)} placeholder="如 ¥128/年起" /></div>
              <div><span style={lbl}>默认规格</span><input style={inp} value={p.defaultPlan || ""} onChange={(e) => patchProduct(p.key, "defaultPlan", e.target.value)} /></div>
            </div>
            <div style={{ marginBottom: 12 }}><span style={lbl}>短简介</span><input style={inp} value={p.shortIntro || ""} onChange={(e) => patchProduct(p.key, "shortIntro", e.target.value)} /></div>
            <div style={{ marginBottom: 14 }}><span style={lbl}>卖点(用 ｜ 分隔)</span><input style={inp} value={(p.highlights || []).join("｜")} onChange={(e) => patchProduct(p.key, "highlights", e.target.value.split("｜").map((s) => s.trim()).filter(Boolean))} /></div>

            <div style={{ fontSize: 12.5, fontWeight: 800, color: C.muted, margin: "0 0 8px" }}>规格 / 价格（¥amount = 结账实收价）</div>
            <div style={{ display: "grid", gap: 8 }}>
              {p.plans.map((pl) => (
                <div key={pl.id} style={{ display: "grid", gridTemplateColumns: "minmax(90px,1.1fr) 92px minmax(70px,0.7fr) minmax(120px,2fr) auto", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 10, background: C.surface2, border: `1px solid ${C.border}`, opacity: pl.active === false ? 0.55 : 1 }}>
                  <input style={{ ...inp, fontWeight: 700 }} value={pl.label || ""} onChange={(e) => patchPlan(p.key, pl.id, "label", e.target.value)} title="规格名" />
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }}><span style={{ color: C.muted, fontWeight: 800 }}>¥</span><input type="number" step="0.01" min="0" style={{ ...inp, fontWeight: 800, color: C.accent }} value={pl.amount} onChange={(e) => patchPlan(p.key, pl.id, "amount", Number(e.target.value))} title="实收价" /></div>
                  <input style={inp} value={pl.cycle || ""} onChange={(e) => patchPlan(p.key, pl.id, "cycle", e.target.value)} title="周期" />
                  <input style={inp} value={pl.desc || ""} onChange={(e) => patchPlan(p.key, pl.id, "desc", e.target.value)} title="规格说明" />
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }} title="该规格上/下架">
                    <input type="checkbox" checked={pl.active !== false} onChange={(e) => patchPlan(p.key, pl.id, "active", e.target.checked)} />上架
                  </label>
                </div>
              ))}
            </div>
            <code style={{ fontSize: 10.5, color: C.faint, display: "block", marginTop: 6 }}>规格 id：{p.plans.map((pl) => pl.id).join(" · ")}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
