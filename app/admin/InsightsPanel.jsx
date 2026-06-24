"use client";

// 后台「数据洞察」专业仪表盘。仅超级管理员入口可见。
// 数据 = /api/admin/insights?days=N：范围漏斗+转化率 + 每日趋势 + 环比 + 来源/服务 + 累计对照。
import { useCallback, useEffect, useState } from "react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)",
  up: "#0f9d58", down: "#dc2626",
};
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-CN"));
const money = (n) => "¥" + (n == null ? "0" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 }));
const dlabel = (k) => (k && k.length === 8 ? k.slice(4, 6) + "-" + k.slice(6, 8) : k);

function Delta({ d }) {
  if (d == null) return <span style={{ fontSize: 11.5, fontWeight: 700, color: C.accent }}>新增</span>;
  const up = d > 0, flat = d === 0;
  const col = flat ? C.muted : up ? C.up : C.down;
  return <span style={{ fontSize: 11.5, fontWeight: 700, color: col }}>{flat ? "持平" : (up ? "▲ " : "▼ ") + Math.abs(d) + "%"}</span>;
}

const RANGES = [{ d: 7, label: "近 7 天" }, { d: 30, label: "近 30 天" }, { d: 90, label: "近 90 天" }];
const TREND_METRICS = [
  { key: "revenue", label: "营收", money: true }, { key: "paid", label: "成交" },
  { key: "orders", label: "下单" }, { key: "checkoutStarted", label: "结算发起" }, { key: "serviceViews", label: "服务浏览" },
];

export default function InsightsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [metric, setMetric] = useState("revenue");

  const load = useCallback(async (d) => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/admin/insights?days=" + d, { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) setData(j);
      else setMsg(r.status === 401 ? "无权限（仅超级管理员）" : "加载失败");
    } catch (e) { setMsg("加载失败"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(days); }, [days, load]);

  const f = data && data.funnel;
  const cmp = data && data.compare;
  const daily = (data && data.daily) || [];
  const tm = TREND_METRICS.find((m) => m.key === metric) || TREND_METRICS[0];
  const maxV = Math.max(1, ...daily.map((x) => Number(x[metric]) || 0));

  const card = { flex: "1 1 150px", minWidth: 140, padding: "13px 15px", border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface };
  const big = { fontSize: 23, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: C.text, lineHeight: 1.1, letterSpacing: "-0.01em" };
  const capi = { fontSize: 12.5, color: C.muted, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 };
  const th = { textAlign: "left", padding: "8px 10px", fontSize: 12.5, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "8px 10px", fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const rangeBtn = (active) => ({ padding: "6px 13px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accent : C.surface, color: active ? "#fff" : C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" });
  const pill = (active) => ({ padding: "5px 11px", borderRadius: 8, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface, color: active ? C.accent : C.muted, fontSize: 12.5, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>数据洞察</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>转化漏斗 · 趋势 · 环比 · 来源/服务</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: "inline-flex", gap: 6 }}>
          {RANGES.map((r) => <button key={r.d} type="button" onClick={() => setDays(r.d)} style={rangeBtn(days === r.d)}>{r.label}</button>)}
        </div>
        <button type="button" onClick={() => load(days)} disabled={loading} style={{ padding: "6px 13px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{loading ? "刷新中…" : "刷新"}</button>
      </div>
      {msg && <div style={{ marginBottom: 12, fontSize: 13, color: C.accent }}>{msg}</div>}

      {loading && !data ? <div style={{ color: C.muted }}>加载中…</div> : f && (
        <>
          {/* KPI 卡片（范围内 + 环比） */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <div style={card}><div style={capi}><span>访客（独立）</span>{cmp && <Delta d={cmp.visitors.delta} />}</div><div style={big}>{fmt(f.visitors)}</div></div>
            <div style={card}><div style={capi}><span>服务浏览</span>{cmp && <Delta d={cmp.serviceViews.delta} />}</div><div style={big}>{fmt(f.serviceViews)}</div></div>
            <div style={card}><div style={capi}><span>结算发起</span>{cmp && <Delta d={cmp.checkoutStarted.delta} />}</div><div style={big}>{fmt(f.checkoutStarted)}</div></div>
            <div style={card}><div style={capi}><span>成交</span>{cmp && <Delta d={cmp.paid.delta} />}</div><div style={{ ...big, color: C.accent }}>{fmt(f.paid)}</div></div>
            <div style={card}><div style={capi}><span>营收</span>{cmp && <Delta d={cmp.revenue.delta} />}</div><div style={{ ...big, color: C.accent }}>{money(f.revenue)}</div></div>
          </div>

          {/* 转化率条 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            {[
              { l: "浏览 → 结算", v: f.rates.viewToCheckout + "%" },
              { l: "结算 → 成交", v: f.rates.checkoutToPaid + "%" },
              { l: "访客 → 成交", v: f.rates.visitorToPaid + "%" },
              { l: "客单价", v: money(f.rates.aov) },
            ].map((x, i) => (
              <div key={i} style={{ flex: "1 1 120px", minWidth: 110, padding: "10px 14px", borderRadius: 12, background: C.accentSoft, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>{x.l}</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.accent, fontVariantNumeric: "tabular-nums" }}>{x.v}</div>
              </div>
            ))}
          </div>

          {/* 每日趋势条形图 */}
          <div style={{ marginTop: 22, border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>每日趋势</h3>
              <span style={{ flex: 1 }} />
              {TREND_METRICS.map((m) => <button key={m.key} type="button" onClick={() => setMetric(m.key)} style={pill(metric === m.key)}>{m.label}</button>)}
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: daily.length > 45 ? 1 : 3, height: 140, overflowX: "auto" }}>
              {daily.map((d, i) => {
                const v = Number(d[metric]) || 0;
                const h = Math.round((v / maxV) * 120);
                return (
                  <div key={i} title={dlabel(d.date) + "：" + (tm.money ? money(v) : fmt(v))} style={{ flex: "1 0 auto", minWidth: daily.length > 45 ? 4 : 7, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%" }}>
                    <div style={{ width: "100%", maxWidth: 18, height: Math.max(v > 0 ? 3 : 0, h), borderRadius: "4px 4px 0 0", background: v > 0 ? `linear-gradient(180deg, ${C.accent}, #2dd4bf)` : "transparent" }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 10.5, color: C.faint }}>
              <span>{daily[0] ? dlabel(daily[0].date) : ""}</span>
              <span>{daily.length ? dlabel(daily[daily.length - 1].date) : ""}（今天）</span>
            </div>
          </div>

          {/* 按来源 */}
          <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>按来源（范围内有效订单）</h3>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
              <thead><tr><th style={th}>来源</th><th style={{ ...th, textAlign: "right" }}>订单</th><th style={{ ...th, textAlign: "right" }}>成交</th><th style={{ ...th, textAlign: "right" }}>营收</th><th style={{ ...th, textAlign: "right" }}>成交率</th></tr></thead>
              <tbody>
                {(data.bySource || []).length === 0 ? <tr><td style={{ ...td, textAlign: "center", color: C.muted }} colSpan={5}>该范围暂无订单</td></tr>
                  : data.bySource.map((sx, i) => (
                    <tr key={i}><td style={td}>{sx.source}</td><td style={numTd}>{fmt(sx.orders)}</td><td style={numTd}>{fmt(sx.paid)}</td><td style={numTd}>{money(sx.revenue)}</td><td style={numTd}>{sx.orders ? Math.round((sx.paid / sx.orders) * 1000) / 10 : 0}%</td></tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* 服务级 */}
          <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>服务级表现（浏览/点击=累计，订单=范围内）</h3>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead><tr><th style={th}>服务</th><th style={{ ...th, textAlign: "right" }}>浏览</th><th style={{ ...th, textAlign: "right" }}>下单点击</th><th style={{ ...th, textAlign: "right" }}>下单</th><th style={{ ...th, textAlign: "right" }}>成交</th><th style={{ ...th, textAlign: "right" }}>营收</th><th style={{ ...th, textAlign: "right" }}>浏览→成交</th></tr></thead>
              <tbody>
                {(data.services || []).map((sx) => (
                  <tr key={sx.key}><td style={td}>{sx.name}</td><td style={numTd}>{fmt(sx.views)}</td><td style={numTd}>{fmt(sx.cta)}</td><td style={numTd}>{fmt(sx.orders)}</td><td style={numTd}>{fmt(sx.paid)}</td><td style={numTd}>{money(sx.revenue)}</td><td style={numTd}>{sx.viewToPaid}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 全站累计对照 */}
          {data.totals && (
            <div style={{ marginTop: 22, padding: "14px 16px", borderRadius: 12, background: C.surface2, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 8, fontWeight: 600 }}>全站累计（自上线以来）</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
                {[
                  ["访客", fmt(data.totals.visitorsAll)], ["注册用户", fmt(data.totals.signups)],
                  ["服务浏览", fmt(data.totals.serviceViewsAll)], ["结算发起", fmt(data.totals.checkoutStartedAll)],
                  ["有效订单", fmt(data.totals.ordersAll)], ["成交", fmt(data.totals.paidAll)], ["总营收", money(data.totals.revenueAll)],
                ].map((x, i) => (
                  <div key={i}><div style={{ fontSize: 11.5, color: C.faint }}>{x[0]}</div><div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{x[1]}</div></div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
