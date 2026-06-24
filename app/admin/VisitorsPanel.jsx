"use client";

// 后台「历史访客」面板。仅超级管理员入口可见。
// 列表 = /api/admin/visitors（分页 / IP·邮箱搜索 / 仅看30天前）。
// 点开单条 = /api/admin/visitors/<id>（该访客访问过的所有页面）。
// 批量删 = DELETE /api/admin/visitors（按选择 ids 或 olderThanDays）。
import { useCallback, useEffect, useState } from "react";
import { Inbox, LoaderCircle, CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

const LIMIT = 50;
const OLD_DAYS = 30;
const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626",
};
const siteLabel = (s) => (s === "tool" ? "工具站" : s === "main" ? "主站" : s || "—");
// 北京时间短格式：26-06-23 21:18（无秒、无后缀）
function fmt(ms) {
  const n = Number(ms || 0);
  if (!n) return "—";
  const d = new Date(n + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default function VisitorsPanel() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [olderOnly, setOlderOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: "ok"|"error"|"info", text } | null
  const [selected, setSelected] = useState(() => new Set());
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reloadFlag, setReloadFlag] = useState(0);
  const ok = (text) => setMsg({ type: "ok", text });
  const err = (text) => setMsg({ type: "error", text });
  const info = (text) => setMsg({ type: "info", text });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
      if (q) p.set("q", q);
      if (olderOnly) { p.set("older", "1"); p.set("days", String(OLD_DAYS)); }
      const res = await fetch("/api/admin/visitors?" + p.toString(), { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) {
        // offset===0 时整组替换，否则把新一批追加到末尾（滚动加载更多）
        setRows((prev) => (offset === 0 ? (data.rows || []) : [...prev, ...(data.rows || [])]));
        setTotal(Number(data.total || 0));
        if (data.searchCapped) info("搜索仅扫描了最近 2000 名访客");
        else setMsg(null);
      } else if (res.status === 401) {
        err("无权限（仅超级管理员可查看）");
      }
    } catch (e) { err("加载失败，请重试"); }
    setLoading(false);
    if (offset === 0) setSelected(new Set());
  }, [offset, q, olderOnly, reloadFlag]);

  useEffect(() => { load(); }, [load]);

  // 强制从头刷新（搜索/筛选/删除后）：offset 已非 0 则归零触发，否则递增 reloadFlag 触发
  const refresh = () => { if (offset !== 0) setOffset(0); else setReloadFlag((f) => f + 1); };
  const doSearch = () => { setOffset(0); setQ(qInput.trim()); };
  const toggleOlder = () => { setOffset(0); setOlderOnly((v) => !v); };

  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));

  async function openDetail(id) {
    setDetail({ loading: true }); setDetailLoading(true);
    try {
      const res = await fetch("/api/admin/visitors/" + id, { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) setDetail({ ...data.visitor, pages: data.pages || [] });
      else setDetail({ error: data.error || "加载失败" });
    } catch (e) { setDetail({ error: "加载失败" }); }
    setDetailLoading(false);
  }

  async function deleteSelected() {
    if (!selected.size) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除选中的 ${selected.size} 名访客记录？此操作不可恢复。`)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/admin/visitors", {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      data && data.ok ? ok(`已删除 ${data.deleted} 名访客记录`) : err("删除失败");
    } catch (e) { err("删除失败"); }
    setBusy(false);
    refresh();
  }

  async function deleteOld() {
    if (typeof window !== "undefined" && !window.confirm(`确认删除「${OLD_DAYS} 天前」的所有访客记录？此操作不可恢复。`)) return;
    setBusy(true); setMsg(null);
    let deleted = 0, remaining = 0, guard = 0;
    try {
      do {
        const res = await fetch("/api/admin/visitors", {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ olderThanDays: OLD_DAYS }),
        });
        const data = await res.json();
        if (!data || !data.ok) { err("删除失败"); break; }
        deleted += Number(data.deleted || 0);
        remaining = Number(data.remaining || 0);
        info(`正在清理 ${OLD_DAYS} 天前记录…已删 ${deleted}${remaining ? `，剩 ${remaining}` : ""}`);
      } while (remaining > 0 && ++guard < 12);
      ok(`已删除 ${deleted} 名 ${OLD_DAYS} 天前的访客记录${remaining > 0 ? `（仍剩 ${remaining}，可再次点击）` : ""}`);
    } catch (e) { err("删除失败"); }
    setBusy(false);
    refresh();
  }

  const hasMore = rows.length < total;

  const th = { textAlign: "left", padding: "9px 10px", fontSize: 12.5, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "5px 9px", fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, verticalAlign: "middle" };
  const ellip = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const btn = (active) => ({ padding: "7px 14px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface, color: active ? C.accent : C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>历史访客</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>主站 + 工具站 · 共 {total} 名{olderOnly ? `（仅 ${OLD_DAYS} 天前）` : ""}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(false)} onClick={refresh} disabled={loading || busy}>刷新</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          value={qInput} onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }}
          placeholder="按 IP 或登录邮箱搜索" inputMode="search"
          style={{ flex: "1 1 220px", maxWidth: 320, padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 14, outline: "none" }}
        />
        <button type="button" style={btn(false)} onClick={doSearch} disabled={loading}>搜索</button>
        {q && <button type="button" style={btn(false)} onClick={() => { setQInput(""); setQ(""); setOffset(0); }}>清除</button>}
        <button type="button" style={btn(olderOnly)} onClick={toggleOlder}>{olderOnly ? "✓ 仅看 30 天前" : "仅看 30 天前"}</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...btn(false), opacity: selected.size ? 1 : 0.5 }} onClick={deleteSelected} disabled={busy || !selected.size}>删除选中{selected.size ? `（${selected.size}）` : ""}</button>
        <button type="button" style={{ ...btn(false), borderColor: C.danger, color: C.danger }} onClick={deleteOld} disabled={busy}>删除 30 天前的全部</button>
      </div>

      {msg && (() => {
        const styles = {
          ok: { bg: "#f0fdf4", bd: "#bbf7d0", fg: "#16a34a", Icon: CheckCircle2 },
          error: { bg: "#fef2f2", bd: "#fecaca", fg: C.danger, Icon: AlertTriangle },
          info: { bg: C.accentSoft, bd: C.accent, fg: C.accent, Icon: Info },
        }[msg.type] || { bg: C.accentSoft, bd: C.accent, fg: C.accent, Icon: Info };
        const Icon = styles.Icon;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600, background: styles.bg, border: `1px solid ${styles.bd}`, color: styles.fg }}>
            <Icon size={15} style={{ flex: "none" }} /><span>{msg.text}</span>
          </div>
        );
      })()}

      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 30 }}><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} aria-label="全选" /></th>
              <th style={{ ...th, width: 122 }}>最后访问</th>
              <th style={{ ...th, width: 116 }}>IP</th>
              <th style={{ ...th, width: 54 }}>站点</th>
              <th style={{ ...th, width: 44 }}>页数</th>
              <th style={{ ...th, width: 150 }}>登录邮箱</th>
              <th style={th}>UA</th>
              <th style={{ ...th, width: 52 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={{ ...td, textAlign: "center", padding: "30px 16px", borderBottom: 0 }} colSpan={8}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载中…</span>
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td style={{ ...td, padding: "38px 16px", borderBottom: 0 }} colSpan={8}>
                <div style={{ textAlign: "center" }}>
                  <Inbox size={34} style={{ color: C.faint }} />
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 10 }}>{q ? "没有匹配的访客" : "暂无访客记录"}</div>
                  <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>{q ? "换个 IP 或邮箱关键词再试" : "有访客访问主站或工具站后会出现在这里"}</div>
                </div>
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label="选择" /></td>
                <td style={{ ...td, whiteSpace: "nowrap", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmt(r.lastSeen)}</td>
                <td style={td}><div title={r.ip} style={{ ...ellip, fontFamily: "var(--mono, monospace)" }}>{r.ip}</div></td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{siteLabel(r.site)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.count}</td>
                <td style={td}><div title={r.email} style={{ ...ellip, color: r.email ? C.text : C.faint }}>{r.email || "—"}</div></td>
                <td style={td}><div title={r.ua} style={{ ...ellip, color: C.muted, fontSize: 12 }}>{r.ua}</div></td>
                <td style={td}><button type="button" style={{ ...btn(false), padding: "5px 10px", fontSize: 12.5 }} onClick={() => openDetail(r.id)}>查看</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginTop: 14, fontSize: 12.5, color: C.muted }}>
          {hasMore ? (
            <button
              type="button"
              style={{ ...btn(false), padding: "9px 22px", display: "inline-flex", alignItems: "center", gap: 8 }}
              onClick={() => setOffset(offset + LIMIT)}
              disabled={loading}
            >
              {loading ? <LoaderCircle size={14} className="spin-icon" /> : null}
              {loading ? "加载中…" : `加载更多（还有 ${total - rows.length} 名）`}
            </button>
          ) : null}
          <span>已显示 {rows.length} / {total} 名访客</span>
        </div>
      )}

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 80, display: "flex", justifyContent: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 94vw)", height: "100%", background: C.surface, boxShadow: "-12px 0 40px -12px rgba(0,0,0,.4)", overflowY: "auto", padding: 22 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>访客详情</h3>
              <span style={{ flex: 1 }} />
              <button type="button" aria-label="关闭" onClick={() => setDetail(null)} style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.muted, cursor: "pointer" }}><X size={18} /></button>
            </div>
            {detailLoading || detail.loading ? (
              <p style={{ color: C.muted }}>加载中…</p>
            ) : detail.error ? (
              <p style={{ color: C.danger }}>加载失败：{detail.error}</p>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "7px 14px", fontSize: 13.5, marginBottom: 18 }}>
                  <span style={{ color: C.muted }}>IP</span><span style={{ fontFamily: "var(--mono, monospace)" }}>{detail.ip}</span>
                  <span style={{ color: C.muted }}>登录邮箱</span><span>{detail.email || "—（未登录）"}</span>
                  <span style={{ color: C.muted }}>首次访问</span><span>{fmt(detail.firstSeen)}</span>
                  <span style={{ color: C.muted }}>最后访问</span><span>{fmt(detail.lastSeen)}</span>
                  <span style={{ color: C.muted }}>访问页数</span><span>{detail.count}（保留最近 {detail.pages.length} 条）</span>
                  <span style={{ color: C.muted }}>UA</span><span style={{ wordBreak: "break-all", color: C.muted, fontSize: 12.5 }}>{detail.ua}</span>
                </div>
                <h4 style={{ fontSize: 14, margin: "0 0 8px" }}>访问过的页面</h4>
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  {detail.pages.length === 0 ? (
                    <div style={{ padding: "28px 14px", textAlign: "center", color: C.muted }}>
                      <Inbox size={26} style={{ color: C.faint }} />
                      <div style={{ fontSize: 12.5, marginTop: 6 }}>暂无页面浏览记录</div>
                    </div>
                  ) : detail.pages.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, padding: "8px 12px", fontSize: 12.5, borderBottom: i < detail.pages.length - 1 ? `1px solid ${C.border}` : "none" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = C.surface2; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                      <span style={{ color: C.faint, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmt(p.ts)}</span>
                      <span style={{ color: C.accent, whiteSpace: "nowrap" }}>{siteLabel(p.site)}</span>
                      <span style={{ color: C.text, wordBreak: "break-all" }}>{p.path}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
