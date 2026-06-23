"use client";

// 后台「数据洞察」面板。仅超级管理员入口可见。
// 数据 = /api/admin/insights：转化漏斗（累计）+ 按来源 + 服务级表现。
import { useEffect, useState } from "react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)",
};
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export default function InsightsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/admin/insights", { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      if (d && d.ok) setData(d);
      else setMsg(r.status === 401 ? "无权限（仅超级管理员）" : "加载失败");
    } catch (e) { setMsg("加载失败"); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const f = data?.funnel;
  const card = { flex: "1 1 130px", minWidth: 120, padding: "14px 16px", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface };
  const big = { fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: C.text, lineHeight: 1.1 };
  const cap = { fontSize: 12.5, color: C.muted, marginTop: 4 };
  const th = { textAlign: "left", padding: "8px 10px", fontSize: 12.5, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "7px 10px", fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>数据洞察</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>累计 · 转化漏斗 / 来源 / 服务</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={load} disabled={loading} style={{ padding: "7px 14px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>刷新</button>
      </div>
      {msg && <div style={{ marginBottom: 12, fontSize: 13, color: C.accent }}>{msg}</div>}
      {loading && !data ? <div style={{ color: C.muted }}>加载中…</div> : f && (
        <>
          {/* 漏斗卡片 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
            <div style={card}><div style={big}>{f.visitors}</div><div style={cap}>访客（独立）</div></div>
            <div style={card}><div style={big}>{f.signups}</div><div style={cap}>注册用户 · {pct(f.signups, f.visitors)}%</div></div>
            <div style={card}><div style={big}>{f.serviceViews}</div><div style={cap}>服务页浏览</div></div>
            <div style={card}><div style={big}>{f.checkoutStarted}</div><div style={cap}>结算发起</div></div>
            <div style={card}><div style={big}>{f.orders}</div><div style={cap}>有效订单</div></div>
            <div style={card}><div style={{ ...big, color: C.accent }}>{f.paid}</div><div style={cap}>成交 · 结算→成交 {pct(f.paid, f.checkoutStarted)}%</div></div>
            <div style={card}><div style={{ ...big, color: C.accent }}>¥{f.revenue}</div><div style={cap}>成交营收 · 访客→成交 {pct(f.paid, f.visitors)}%</div></div>
          </div>

          {/* 按来源 */}
          <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>按来源（有效订单）</h3>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
              <thead><tr><th style={th}>来源</th><th style={{ ...th, textAlign: "right" }}>订单</th><th style={{ ...th, textAlign: "right" }}>成交</th><th style={{ ...th, textAlign: "right" }}>营收</th><th style={{ ...th, textAlign: "right" }}>成交率</th></tr></thead>
              <tbody>
                {(data.bySource || []).length === 0 ? <tr><td style={{ ...td, textAlign: "center", color: C.muted }} colSpan={5}>暂无订单</td></tr>
                  : data.bySource.map((s, i) => (
                    <tr key={i}><td style={td}>{s.source}</td><td style={numTd}>{s.orders}</td><td style={numTd}>{s.paid}</td><td style={numTd}>¥{s.revenue}</td><td style={numTd}>{pct(s.paid, s.orders)}%</td></tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* 服务级 */}
          <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>服务级表现</h3>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead><tr><th style={th}>服务</th><th style={{ ...th, textAlign: "right" }}>浏览</th><th style={{ ...th, textAlign: "right" }}>下单点击</th><th style={{ ...th, textAlign: "right" }}>下单</th><th style={{ ...th, textAlign: "right" }}>成交</th><th style={{ ...th, textAlign: "right" }}>营收</th><th style={{ ...th, textAlign: "right" }}>浏览→成交</th></tr></thead>
              <tbody>
                {(data.services || []).map((s) => (
                  <tr key={s.key}><td style={td}>{s.name}</td><td style={numTd}>{s.views}</td><td style={numTd}>{s.cta}</td><td style={numTd}>{s.orders}</td><td style={numTd}>{s.paid}</td><td style={numTd}>¥{s.revenue}</td><td style={numTd}>{s.viewToPaid}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
