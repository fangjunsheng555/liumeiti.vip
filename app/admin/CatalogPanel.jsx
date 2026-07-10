"use client";

// 商品/价格/库存管理 — 仅超级管理员。读写 /api/admin/catalog。
// 改价格/规格/文案/上下架/库存,保存后前端(首页/选购/服务页/结账)与结账实收价即时同步。
import { useEffect, useState, useCallback } from "react";
import { LoaderCircle, Save, RotateCcw, Package, AlertTriangle, CheckCircle2 } from "lucide-react";

export default function CatalogPanel() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [stockEdits, setStockEdits] = useState({}); // { "<key>:<planId>": "" | "整数" }

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/catalog", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) { setCatalog(j.catalog); setStockEdits({}); }
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
  const skey = (pKey, plId) => pKey + ":" + plId;
  function stockVal(p, pl) {
    const k = skey(p.key, pl.id);
    if (k in stockEdits) return stockEdits[k];
    return pl.stock == null ? "" : String(pl.stock);
  }
  function setStockVal(p, pl, v) {
    const cleaned = v === "" ? "" : v.replace(/[^\d]/g, "");
    setStockEdits((s) => ({ ...s, [skey(p.key, pl.id)]: cleaned }));
  }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/catalog", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog, stockEdits }),
      });
      const j = await r.json();
      if (j.ok) { setCatalog(j.catalog); setStockEdits({}); setMsg({ type: "ok", text: "已保存 · 前端展示/结账价格与库存已即时更新" }); }
      else setMsg({ type: "error", text: j.error || "保存失败" });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setSaving(false); }
  }

  if (loading && !catalog) return <div style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载商品…</div>;
  if (!catalog) return msg ? <div className="admin-settings-alert error"><AlertTriangle size={15} />{msg.text}</div> : null;

  return (
    <div className="admin-settings">
      <div className="admin-settings-head">
        <h2><Package size={19} />商品 / 价格管理</h2>
        <span className="sub">价格/规格/文案/上下架/库存,保存即全站+结账生效</span>
        <span className="spacer" />
        <button type="button" className="admin-settings-btn" onClick={load} disabled={saving}><RotateCcw size={13} />重载</button>
        <button type="button" className="admin-settings-btn primary" onClick={save} disabled={saving}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存全部"}
        </button>
      </div>
      {msg && <div className={`admin-settings-alert ${msg.type}`}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      {catalog.map((p) => (
        <div key={p.key} className="admin-settings-section" style={{ opacity: p.active === false ? 0.62 : 1 }}>
          <div className="admin-settings-section-title">
            <span className="ico"><Package size={15} /></span>{p.title}
            <code style={{ fontSize: 11, color: "var(--faint)", fontWeight: 500 }}>{p.key}</code>
            <span className="spacer" style={{ flex: 1 }} />
            <label className="admin-settings-check" style={{ fontSize: 12.5, color: p.active === false ? "#b91c1c" : "var(--accent)" }}>
              <input type="checkbox" checked={p.active !== false} onChange={(e) => patchProduct(p.key, "active", e.target.checked)} />
              {p.active === false ? "已下架" : "上架中"}
            </label>
            <label style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 5 }}>
              排序<input type="number" value={p.sort ?? 0} onChange={(e) => patchProduct(p.key, "sort", Number(e.target.value))} style={{ width: 64, padding: "5px 7px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5 }} />
            </label>
          </div>
          <div className="admin-settings-section-sub">商品文案与规格价格,前端展示与结账实收一致</div>

          <div className="admin-settings-grid" style={{ marginBottom: 12 }}>
            <div className="admin-settings-field"><label>名称</label><input value={p.title || ""} onChange={(e) => patchProduct(p.key, "title", e.target.value)} /></div>
            <div className="admin-settings-field"><label>副标题</label><input value={p.subtitle || ""} onChange={(e) => patchProduct(p.key, "subtitle", e.target.value)} /></div>
            <div className="admin-settings-field"><label>列表展示价(文案)</label><input value={p.priceText || ""} onChange={(e) => patchProduct(p.key, "priceText", e.target.value)} placeholder="如 ¥128/年起" /></div>
            <div className="admin-settings-field"><label>默认规格</label><input value={p.defaultPlan || ""} onChange={(e) => patchProduct(p.key, "defaultPlan", e.target.value)} /></div>
            <div className="admin-settings-field full"><label>短简介</label><input value={p.shortIntro || ""} onChange={(e) => patchProduct(p.key, "shortIntro", e.target.value)} /></div>
            <div className="admin-settings-field full"><label>卖点(用 ｜ 分隔)</label><input value={(p.highlights || []).join("｜")} onChange={(e) => patchProduct(p.key, "highlights", e.target.value.split("｜").map((s) => s.trim()).filter(Boolean))} /></div>
          </div>

          {p.quoteOnly ? (
            <div className="admin-settings-hint">人工报价商品：前端仅展示“3折起”，每笔订单在订单详情中单独核价并发送付款链接，不设置固定价格或库存。</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--muted)", margin: "0 0 8px" }}>规格 / 价格 / 库存 <span style={{ fontWeight: 500, color: "var(--faint)" }}>(¥ = 结账实收价 · 库存留空 = 不限 · 0 = 售罄)</span></div>
              <div style={{ display: "grid", gap: 8 }}>
                {p.plans.map((pl) => {
                  const sv = stockVal(p, pl);
                  const sold = sv === "0";
                  return (
                    <div key={pl.id} className="admin-catalog-plan-row" style={sold ? { background: "#fef2f2", borderColor: "#fecaca" } : undefined} data-inactive={pl.active === false ? "1" : undefined}>
                      <input className="plan-label" value={pl.label || ""} onChange={(e) => patchPlan(p.key, pl.id, "label", e.target.value)} title="规格名" />
                      <div className="plan-amount"><span>¥</span><input type="number" step="0.01" min="0" value={pl.amount} onChange={(e) => patchPlan(p.key, pl.id, "amount", Number(e.target.value))} title="实收价" /></div>
                      <input className="plan-stock" inputMode="numeric" placeholder="不限" style={sold ? { color: "#dc2626", borderColor: "#fecaca" } : undefined} value={sv} onChange={(e) => setStockVal(p, pl, e.target.value)} title="库存(留空=不限,0=售罄)" />
                      <input className="plan-cycle" value={pl.cycle || ""} onChange={(e) => patchPlan(p.key, pl.id, "cycle", e.target.value)} title="周期" />
                      <input className="plan-desc" value={pl.desc || ""} onChange={(e) => patchPlan(p.key, pl.id, "desc", e.target.value)} title="规格说明" />
                      <label className="plan-active" title="该规格上/下架">
                        <input type="checkbox" checked={pl.active !== false} onChange={(e) => patchPlan(p.key, pl.id, "active", e.target.checked)} />上架
                      </label>
                    </div>
                  );
                })}
              </div>
              <div className="admin-settings-hint">列:规格名 · ¥实收价 · 库存 · 周期 · 说明 · 上架　|　规格 id:{p.plans.map((pl) => pl.id).join(" · ")}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
