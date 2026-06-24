"use client";

// 后台「弃单召回」面板。仅超级管理员入口可见。
// 列表 = /api/admin/abandoned（到结算页未完成下单的访客）。
// 召回 = POST {id, action:"email"}（复用站点发信）；标记已成交 = action:"converted"；批量删 = DELETE。
import { useCallback, useEffect, useState } from "react";
import { Inbox, LoaderCircle, CheckCircle2, AlertTriangle } from "lucide-react";

const LIMIT = 50;
const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)",
  border: "var(--border, #d2d2d7)", surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)",
  accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626", ok: "#16a34a", warn: "#d97706",
};
function fmt(ms) {
  const n = Number(ms || 0); if (!n) return "—";
  const d = new Date(n + 8 * 3600 * 1000); const p = (x) => String(x).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const STATUS = { open: { t: "待召回", c: "var(--warn,#d97706)" }, contacted: { t: "已召回", c: "var(--accent,#0f766e)" }, converted: { t: "已成交", c: "#16a34a" } };

export default function AbandonedPanel() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null); // { type: "ok"|"error", text }
  const [selected, setSelected] = useState(() => new Set());
  const ok = (text) => setMsg({ type: "ok", text });
  const err = (text) => setMsg({ type: "error", text });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/abandoned?offset=${offset}&limit=${LIMIT}`, { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      if (d && d.ok) { setRows(d.rows || []); setTotal(Number(d.total || 0)); }
      else if (r.status === 401) err("无权限（仅超级管理员）");
    } catch (e) { err("加载失败"); }
    setLoading(false); setSelected(new Set());
  }, [offset]);
  useEffect(() => { load(); }, [load]);

  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));

  async function act(id, action) {
    setBusy(id + action); setMsg(null);
    try {
      const r = await fetch("/api/admin/abandoned", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      const d = await r.json();
      if (d && d.ok) { ok(action === "email" ? "召回邮件已发送" : "已标记成交"); load(); }
      else err(d.error === "no_email" ? "该弃单没有邮箱，无法发信召回" : (d.error === "send_failed" ? "发信失败，请重试" : "操作失败"));
    } catch (e) { err("操作失败"); }
    setBusy("");
  }
  async function delSelected() {
    if (!selected.size) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除选中的 ${selected.size} 条弃单记录？`)) return;
    setBusy("del"); setMsg(null);
    try { const r = await fetch("/api/admin/abandoned", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected] }) }); const d = await r.json(); d && d.ok ? ok(`已删除 ${d.deleted} 条`) : err("删除失败"); } catch (e) { err("删除失败"); }
    setBusy(""); load();
  }

  const page = Math.floor(offset / LIMIT) + 1, pages = Math.max(1, Math.ceil(total / LIMIT));
  const th = { textAlign: "left", padding: "6px 9px", fontSize: 12.5, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "5px 9px", fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, verticalAlign: "middle" };
  const ellip = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const btn = (active, danger) => ({ padding: "6px 12px", borderRadius: 9, border: `1px solid ${danger ? C.danger : active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface, color: danger ? C.danger : active ? C.accent : C.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>弃单召回</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>到结算页但未完成下单 · 共 {total} 条</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(false)} onClick={load} disabled={loading}>刷新</button>
        <button type="button" style={{ ...btn(false), opacity: selected.size ? 1 : 0.5 }} onClick={delSelected} disabled={busy === "del" || !selected.size}>删除选中{selected.size ? `（${selected.size}）` : ""}</button>
      </div>
      {msg && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600,
          background: msg.type === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${msg.type === "error" ? "#fecaca" : "#bbf7d0"}`, color: msg.type === "error" ? C.danger : C.ok }}>
          {msg.type === "error" ? <AlertTriangle size={15} style={{ flex: "none" }} /> : <CheckCircle2 size={15} style={{ flex: "none" }} />}
          <span>{msg.text}</span>
        </div>
      )}

      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 30 }}><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} aria-label="全选" /></th>
              <th style={{ ...th, width: 116 }}>时间</th>
              <th style={{ ...th, width: 180 }}>联系（邮箱）</th>
              <th style={th}>想买</th>
              <th style={{ ...th, width: 70 }}>金额</th>
              <th style={{ ...th, width: 90 }}>来源</th>
              <th style={{ ...th, width: 64 }}>状态</th>
              <th style={{ ...th, width: 150 }}>操作</th>
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
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 10 }}>暂无弃单记录</div>
                  <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>很好——到结算页的访客都完成下单了</div>
                </div>
              </td></tr>
            ) : rows.map((r) => {
              const st = STATUS[r.status] || STATUS.open;
              return (
                <tr key={r.id}>
                  <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label="选择" /></td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmt(r.ts)}</td>
                  <td style={td}><div title={r.email} style={{ ...ellip, color: r.email ? C.text : C.faint }}>{r.email || "—（匿名）"}</div></td>
                  <td style={td}><div title={r.services} style={ellip}>{r.services || "—"}</div></td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>{r.amount ? "¥" + r.amount : "—"}</td>
                  <td style={td}><div title={r.source} style={{ ...ellip, color: C.muted }}>{r.fromTool ? "工具站" : (r.source || "直接")}</div></td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: st.c, fontWeight: 600 }}>{st.t}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" style={{ ...btn(false), padding: "4px 9px", opacity: r.email ? 1 : 0.45 }} disabled={!r.email || busy === r.id + "email"} onClick={() => act(r.id, "email")}>{busy === r.id + "email" ? "发送中" : "召回"}</button>
                      <button type="button" style={{ ...btn(false), padding: "4px 9px" }} disabled={busy === r.id + "converted"} onClick={() => act(r.id, "converted")}>已成交</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, fontSize: 13, color: C.muted }}>
        <button type="button" style={{ ...btn(false), opacity: offset > 0 ? 1 : 0.5 }} onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset <= 0 || loading}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button type="button" style={{ ...btn(false), opacity: offset + LIMIT < total ? 1 : 0.5 }} onClick={() => setOffset(offset + LIMIT)} disabled={offset + LIMIT >= total || loading}>下一页</button>
      </div>
    </div>
  );
}
