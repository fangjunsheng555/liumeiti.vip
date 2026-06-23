"use client";

// 后台「历史访客」面板。仅超级管理员入口可见。
// 列表 = /api/admin/visitors（分页 / IP·邮箱搜索 / 仅看30天前）。
// 点开单条 = /api/admin/visitors/<id>（该访客访问过的所有页面）。
// 批量删 = DELETE /api/admin/visitors（按选择 ids 或 olderThanDays）。
import { useCallback, useEffect, useState } from "react";

const LIMIT = 50;
const OLD_DAYS = 30;
const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626",
};
const siteLabel = (s) => (s === "tool" ? "工具站" : s === "main" ? "主站" : s || "—");

export default function VisitorsPanel() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [olderOnly, setOlderOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
      if (q) p.set("q", q);
      if (olderOnly) { p.set("older", "1"); p.set("days", String(OLD_DAYS)); }
      const res = await fetch("/api/admin/visitors?" + p.toString(), { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) {
        setRows(data.rows || []);
        setTotal(Number(data.total || 0));
        if (data.searchCapped) setMsg("搜索仅扫描了最近 2000 名访客");
        else setMsg("");
      } else if (res.status === 401) {
        setMsg("无权限（仅超级管理员可查看）");
      }
    } catch (e) { setMsg("加载失败，请重试"); }
    setLoading(false);
    setSelected(new Set());
  }, [offset, q, olderOnly]);

  useEffect(() => { load(); }, [load]);

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
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/admin/visitors", {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      setMsg(data && data.ok ? `已删除 ${data.deleted} 名访客记录` : "删除失败");
    } catch (e) { setMsg("删除失败"); }
    setBusy(false);
    load();
  }

  async function deleteOld() {
    if (typeof window !== "undefined" && !window.confirm(`确认删除「${OLD_DAYS} 天前」的所有访客记录？此操作不可恢复。`)) return;
    setBusy(true); setMsg("");
    let deleted = 0, remaining = 0, guard = 0;
    try {
      do {
        const res = await fetch("/api/admin/visitors", {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ olderThanDays: OLD_DAYS }),
        });
        const data = await res.json();
        if (!data || !data.ok) { setMsg("删除失败"); break; }
        deleted += Number(data.deleted || 0);
        remaining = Number(data.remaining || 0);
        setMsg(`正在清理 ${OLD_DAYS} 天前记录…已删 ${deleted}${remaining ? `，剩 ${remaining}` : ""}`);
      } while (remaining > 0 && ++guard < 12);
      setMsg(`已删除 ${deleted} 名 ${OLD_DAYS} 天前的访客记录${remaining > 0 ? `（仍剩 ${remaining}，可再次点击）` : ""}`);
    } catch (e) { setMsg("删除失败"); }
    setBusy(false);
    load();
  }

  const page = Math.floor(offset / LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  const th = { textAlign: "left", padding: "9px 10px", fontSize: 12.5, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, verticalAlign: "top" };
  const btn = (active) => ({ padding: "7px 14px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface, color: active ? C.accent : C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>历史访客</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>主站 + 工具站 · 共 {total} 名{olderOnly ? `（仅 ${OLD_DAYS} 天前）` : ""}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(false)} onClick={load} disabled={loading || busy}>刷新</button>
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

      {msg && <div style={{ marginBottom: 10, fontSize: 13, color: C.accent }}>{msg}</div>}

      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 34 }}><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} aria-label="全选" /></th>
              <th style={th}>最后访问（北京时间）</th>
              <th style={th}>IP</th>
              <th style={th}>站点</th>
              <th style={th}>页数</th>
              <th style={th}>登录邮箱</th>
              <th style={th}>UA</th>
              <th style={{ ...th, width: 60 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={{ ...td, textAlign: "center", color: C.muted }} colSpan={8}>加载中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td style={{ ...td, textAlign: "center", color: C.muted }} colSpan={8}>暂无访客记录</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label="选择" /></td>
                <td style={{ ...td, whiteSpace: "nowrap", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{r.lastSeenText}</td>
                <td style={{ ...td, whiteSpace: "nowrap", fontFamily: "var(--mono, monospace)" }}>{r.ip}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{siteLabel(r.site)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.count}</td>
                <td style={{ ...td, whiteSpace: "nowrap", color: r.email ? C.text : C.faint }}>{r.email || "—"}</td>
                <td style={td}><div title={r.ua} style={{ maxWidth: 240, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: C.muted, fontSize: 12 }}>{r.ua}</div></td>
                <td style={td}><button type="button" style={{ ...btn(false), padding: "5px 10px", fontSize: 12.5 }} onClick={() => openDetail(r.id)}>查看</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, fontSize: 13, color: C.muted }}>
        <button type="button" style={{ ...btn(false), opacity: offset > 0 ? 1 : 0.5 }} onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset <= 0 || loading}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button type="button" style={{ ...btn(false), opacity: offset + LIMIT < total ? 1 : 0.5 }} onClick={() => setOffset(offset + LIMIT)} disabled={offset + LIMIT >= total || loading}>下一页</button>
      </div>

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 80, display: "flex", justifyContent: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 94vw)", height: "100%", background: C.surface, boxShadow: "-12px 0 40px -12px rgba(0,0,0,.4)", overflowY: "auto", padding: 22 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>访客详情</h3>
              <span style={{ flex: 1 }} />
              <button type="button" style={btn(false)} onClick={() => setDetail(null)}>关闭</button>
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
                  <span style={{ color: C.muted }}>首次访问</span><span>{detail.firstSeenText || "—"}</span>
                  <span style={{ color: C.muted }}>最后访问</span><span>{detail.lastSeenText || "—"}</span>
                  <span style={{ color: C.muted }}>访问页数</span><span>{detail.count}（保留最近 {detail.pages.length} 条）</span>
                  <span style={{ color: C.muted }}>UA</span><span style={{ wordBreak: "break-all", color: C.muted, fontSize: 12.5 }}>{detail.ua}</span>
                </div>
                <h4 style={{ fontSize: 14, margin: "0 0 8px" }}>访问过的页面</h4>
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  {detail.pages.length === 0 ? (
                    <div style={{ padding: 14, color: C.muted, fontSize: 13 }}>无页面记录</div>
                  ) : detail.pages.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, padding: "8px 12px", fontSize: 12.5, borderBottom: i < detail.pages.length - 1 ? `1px solid ${C.border}` : "none" }}>
                      <span style={{ color: C.faint, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{p.text}</span>
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
