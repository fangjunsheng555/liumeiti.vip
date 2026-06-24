"use client";

// 用户 360 — 在用户详情里展示该用户的访问/行为/来源。仅超管入口下渲染。
// 数据 = /api/admin/user-activity?email=
import { useEffect, useState } from "react";
import { Inbox, LoaderCircle } from "lucide-react";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface2: "var(--surface-2, #f5f5f7)", accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)",
};
const SVC = { spotify: "Spotify", ai: "AI 会员", netflix: "Netflix", disney: "Disney+", max: "HBO Max", rocket: "机场节点" };
const siteLabel = (s) => (s === "tool" ? "工具站" : s === "main" ? "主站" : s || "");
const EVNAME = { service_view: "看服务", cta_click: "点下单", checkout_started: "进结算", signup: "注册" };

function sourceText(a) {
  if (!a) return "直接访问";
  if (a.utm_source) return "UTM·" + a.utm_source + (a.utm_campaign ? "/" + a.utm_campaign : "");
  if (a.fromTool) return "工具站引流";
  if (a.referrer) { try { return "外链·" + new URL(a.referrer).hostname.replace(/^www\./, ""); } catch (e) { return "外链"; } }
  return "直接访问";
}

export default function UserActivity({ email }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!email) { setD(null); return; }
    let on = true; setLoading(true);
    fetch("/api/admin/user-activity?email=" + encodeURIComponent(email), { credentials: "same-origin", cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (on) setD(j); }).catch(() => {}).finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [email]);

  if (loading && !d) return <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13, padding: "8px 0" }}><LoaderCircle size={15} className="spin-icon" />加载访问数据…</div>;
  if (!d || !d.ok) return null;

  const wrap = { marginTop: 14, padding: 14, border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface2 };
  const h = { fontSize: 14, fontWeight: 700, margin: "0 0 10px", color: C.text };
  if (!d.found) return <div style={wrap}><div style={h}>访问与行为</div><div style={{ display: "flex", alignItems: "center", gap: 8, color: C.faint, fontSize: 13 }}><Inbox size={16} style={{ flex: "none" }} />暂无记录（该用户登录后产生访问才会出现）。</div></div>;

  const chip = { display: "inline-block", padding: "2px 9px", borderRadius: 20, background: C.accentSoft, color: C.accent, fontSize: 12, fontWeight: 600, marginRight: 6, marginBottom: 6 };
  const rowLine = { display: "flex", gap: 8, fontSize: 12.5, padding: "4px 0", borderBottom: `1px solid ${C.border}` };

  return (
    <div style={wrap}>
      <div style={h}>访问与行为（用户 360）</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 13, marginBottom: 12 }}>
        <span style={{ color: C.muted }}>来源</span><span>{sourceText(d.attribution)}{d.attribution?.landing ? `（落地 ${d.attribution.landing}）` : ""}</span>
        <span style={{ color: C.muted }}>设备/IP 数</span><span>{d.devices}</span>
        <span style={{ color: C.muted }}>累计浏览</span><span>{d.totalPages} 次</span>
        <span style={{ color: C.muted }}>最后访问</span><span>{d.lastSeenText || "—"}</span>
      </div>
      {d.servicesViewed?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 6 }}>看过的服务</div>
          {d.servicesViewed.map((s) => <span key={s} style={chip}>{SVC[s] || s}</span>)}
        </div>
      )}
      {d.events?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 4 }}>最近行为</div>
          {d.events.slice(0, 10).map((e, i) => (
            <div key={i} style={rowLine}>
              <span style={{ color: C.faint, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{e.text}</span>
              <span style={{ color: C.accent, whiteSpace: "nowrap" }}>{EVNAME[e.name] || e.name}</span>
              <span style={{ color: C.text, wordBreak: "break-all" }}>{e.slug ? (SVC[e.slug] || e.slug) : (e.label || "")}</span>
            </div>
          ))}
        </div>
      )}
      {d.pages?.length > 0 && (
        <div>
          <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 4 }}>最近页面</div>
          {d.pages.slice(0, 10).map((p, i) => (
            <div key={i} style={rowLine}>
              <span style={{ color: C.faint, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{p.text}</span>
              <span style={{ color: C.accent, whiteSpace: "nowrap" }}>{siteLabel(p.site)}</span>
              <span style={{ color: C.text, wordBreak: "break-all" }}>{p.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
