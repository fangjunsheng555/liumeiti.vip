"use client";

// 站点设置 — 仅超级管理员。读写 /api/admin/settings。
// 改客服/USDT/组合优惠/收款码/品牌/通知,保存后前端站点显示与结账/邮件即时一致。
import { useEffect, useState, useCallback } from "react";
import { LoaderCircle, Save, RotateCcw, Settings as SettingsIcon, AlertTriangle, CheckCircle2 } from "lucide-react";

const C = {
  text: "var(--text,#1d1d1f)", muted: "var(--muted,#6e6e73)", faint: "var(--faint,#8a8a8e)",
  border: "var(--border,#d2d2d7)", surface: "var(--surface,#fff)", surface2: "var(--surface-2,#f5f5f7)",
  accent: "var(--accent,#0f766e)",
};
const inp = { width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 13, boxSizing: "border-box" };
const lbl = { fontSize: 11.5, color: C.muted, fontWeight: 700, marginBottom: 4, display: "block" };
const card = { border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 16, marginBottom: 14 };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 };

export default function SettingsPanel() {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/settings", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setS(j.settings);
      else setMsg({ type: "error", text: j.error === "unauthorized" ? "仅超级管理员可管理站点设置" : (j.error || "加载失败") });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function set(path, value) {
    setS((cur) => {
      const next = JSON.parse(JSON.stringify(cur));
      let o = next; const ks = path.split(".");
      for (let i = 0; i < ks.length - 1; i += 1) o = o[ks[i]];
      o[ks[ks.length - 1]] = value;
      return next;
    });
  }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/settings", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: s }),
      });
      const j = await r.json();
      if (j.ok) { setS(j.settings); setMsg({ type: "ok", text: "已保存 · 站点显示与结账/邮件即时更新" }); }
      else setMsg({ type: "error", text: j.error || "保存失败" });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setSaving(false); }
  }

  if (loading && !s) return <div style={{ display: "inline-flex", gap: 8, alignItems: "center", color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载设置…</div>;
  if (!s) return msg ? <div style={{ display: "flex", gap: 8, padding: "10px 13px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13 }}><AlertTriangle size={15} />{msg.text}</div> : null;

  const pct = (v) => `${Math.round((1 - Number(v || 0)) * 100)}% off · ${(10 * (1 - Number(v || 0))).toFixed(1)}折`;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 18, margin: 0, display: "inline-flex", alignItems: "center", gap: 7 }}><SettingsIcon size={18} />站点设置</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>客服 / USDT / 组合优惠 / 收款码 / 品牌 / 通知,保存即全站生效</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={load} disabled={saving} style={{ ...inp, width: "auto", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 700 }}><RotateCcw size={13} />重载</button>
        <button type="button" onClick={save} disabled={saving} style={{ width: "auto", padding: "8px 16px", borderRadius: 9, border: "none", background: C.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存"}
        </button>
      </div>
      {msg && <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600, background: msg.type === "ok" ? "#ecfdf5" : "#fef2f2", border: `1px solid ${msg.type === "ok" ? "#a7f3d0" : "#fecaca"}`, color: msg.type === "ok" ? "#047857" : "#dc2626" }}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      {/* 客服联系方式 */}
      <div style={card}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>客服联系方式<span style={{ color: C.faint, fontWeight: 500, fontSize: 12, marginLeft: 8 }}>站点客服按钮 + 订单邮件共用</span></div>
        {["qq", "whatsapp", "telegram"].map((k) => (
          <div key={k} style={{ ...grid, marginBottom: 10 }}>
            <div><span style={lbl}>{k.toUpperCase()} 显示值</span><input style={inp} value={s.support[k].value} onChange={(e) => set(`support.${k}.value`, e.target.value)} /></div>
            <div style={{ gridColumn: "span 2" }}><span style={lbl}>{k.toUpperCase()} 跳转链接(href)</span><input style={inp} value={s.support[k].href} onChange={(e) => set(`support.${k}.href`, e.target.value)} /></div>
          </div>
        ))}
      </div>

      {/* USDT */}
      <div style={card}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>USDT 结算</div>
        <div style={grid}>
          <div style={{ gridColumn: "span 2" }}><span style={lbl}>TRC20 收款地址</span><input style={inp} value={s.usdt.address} onChange={(e) => set("usdt.address", e.target.value)} /></div>
          <div><span style={lbl}>USDT 折扣率（{pct(s.usdt.discount)}）</span><input type="number" step="0.01" min="0.1" max="1" style={inp} value={s.usdt.discount} onChange={(e) => set("usdt.discount", Number(e.target.value))} /></div>
          <div><span style={lbl}>固定汇率（留空=每日自动）</span><input inputMode="decimal" placeholder="自动" style={inp} value={s.usdt.rateOverride} onChange={(e) => set("usdt.rateOverride", e.target.value.replace(/[^\d.]/g, ""))} /></div>
        </div>
      </div>

      {/* 组合优惠 */}
      <div style={card}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>组合优惠档位</div>
        <div style={grid}>
          <div><span style={lbl}>满 2 件折扣（{pct(s.bundle.tier2Rate)}）</span><input type="number" step="0.01" min="0" max="0.9" style={inp} value={s.bundle.tier2Rate} onChange={(e) => set("bundle.tier2Rate", Number(e.target.value))} /></div>
          <div><span style={lbl}>满 3 件折扣（{pct(s.bundle.tier3Rate)}）</span><input type="number" step="0.01" min="0" max="0.9" style={inp} value={s.bundle.tier3Rate} onChange={(e) => set("bundle.tier3Rate", Number(e.target.value))} /></div>
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>折扣率 0.05 = 5% off = 95折;0.10 = 9折。0 = 无折扣。</div>
      </div>

      {/* 收款码 + 品牌 + 通知 */}
      <div style={card}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>收款码 / 品牌 / 通知</div>
        <div style={grid}>
          <div style={{ gridColumn: "span 2" }}><span style={lbl}>支付宝收款码图片路径/URL</span><input style={inp} value={s.payment.alipayQr} onChange={(e) => set("payment.alipayQr", e.target.value)} placeholder="/payment/alipay.jpg" /></div>
          <div><span style={lbl}>品牌名（中文）</span><input style={inp} value={s.brand.name} onChange={(e) => set("brand.name", e.target.value)} /></div>
          <div><span style={lbl}>品牌名（英文）</span><input style={inp} value={s.brand.nameEn} onChange={(e) => set("brand.nameEn", e.target.value)} /></div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: C.text, marginTop: 22 }}>
            <input type="checkbox" checked={!!s.notify.telegramEnabled} onChange={(e) => set("notify.telegramEnabled", e.target.checked)} />新订单 Telegram 通知
          </label>
        </div>
      </div>
    </div>
  );
}
