"use client";

// 后台「公告中心」编辑。仅超级管理员。管理多条带日期/分类的公告，前端在 /announcements 列表展示。
// 列表 = GET /api/admin/announce-posts。保存 = POST { post }（含 id 即编辑）。删除 = DELETE { id }。
import { useCallback, useEffect, useState } from "react";
import { Inbox, LoaderCircle, CheckCircle2, AlertTriangle, Pin, Plus, Pencil, Trash2, Eye, EyeOff, Megaphone, Send } from "lucide-react";
import ServiceNoticeDialog from "./ServiceNoticeDialog";

const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)", border: "var(--border, #d2d2d7)",
  surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)", accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626", ok: "#16a34a",
};

// 分类标签：与数据契约一致（company/business/system/promo），空 = 无标签。
const CATS = [
  { value: "", label: "无（不显示标签）" },
  { value: "company", label: "公司公告 / Company" },
  { value: "business", label: "业务动态 / Business updates" },
  { value: "system", label: "网站/系统 / System" },
  { value: "promo", label: "活动公告 / Promotion" },
];
const CAT_MAP = {
  company: { zh: "公司公告", en: "Company" },
  business: { zh: "业务动态", en: "Business updates" },
  system: { zh: "网站/系统", en: "System" },
  promo: { zh: "活动公告", en: "Promotion" },
};
const catLabel = (c) => (CAT_MAP[c] ? CAT_MAP[c].zh : "");

const EMPTY = { id: 0, title: "", titleEn: "", body: "", bodyEn: "", date: "", category: "", affectedService: "", pinned: false, published: true, inBar: false };

// 显示排序：置顶优先，其次日期字符串倒序（新在前）。
function sortPosts(list) {
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return String(b.date || "").localeCompare(String(a.date || ""));
  });
}

export default function AnnouncePostsPanel() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: "ok"|"error", text } | null
  const [form, setForm] = useState(EMPTY);
  const [services, setServices] = useState([]);
  const [noticePost, setNoticePost] = useState(null);

  const ok = (text) => setMsg({ type: "ok", text });
  const err = (text) => setMsg({ type: "error", text });
  const editing = !!form.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/announce-posts", { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      if (d && d.ok) {
        setPosts(sortPosts(Array.isArray(d.posts) ? d.posts : []));
        setServices(Array.isArray(d.services) ? d.services : []);
      }
      else if (r.status === 401) err("无权限（仅超级管理员可管理公告）");
      else err("加载失败，请重试");
    } catch (e) { err("加载失败，请重试"); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const resetForm = () => { setForm(EMPTY); };
  const editPost = (p) => {
    setForm({
      id: p.id || 0, title: p.title || "", titleEn: p.titleEn || "", body: p.body || "", bodyEn: p.bodyEn || "",
      date: p.date || "", category: p.category || "", pinned: !!p.pinned, published: p.published !== false, inBar: !!p.inBar,
      affectedService: p.affectedService || "",
    });
    setMsg(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  async function save() {
    if (!form.title.trim()) { err("请填写中文标题"); return; }
    if (!form.date.trim()) { err("请填写日期（如 2026-06-24）"); return; }
    setBusy(true); setMsg(null);
    const post = {
      id: form.id || undefined,
      title: form.title.trim(), titleEn: form.titleEn.trim(),
      body: form.body, bodyEn: form.bodyEn,
      date: form.date.trim(), category: form.category,
      affectedService: form.affectedService,
      pinned: !!form.pinned, published: !!form.published, inBar: !!form.inBar,
    };
    try {
      const r = await fetch("/api/admin/announce-posts", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ post }),
      });
      const d = await r.json();
      if (d && d.ok) { ok(editing ? "公告已更新" : "公告已发布"); resetForm(); await load(); }
      else err("保存失败，请重试");
    } catch (e) { err("保存失败，请重试"); }
    setBusy(false);
  }

  async function del(id, title) {
    if (typeof window !== "undefined" && !window.confirm(`确认删除公告「${title || id}」？此操作不可恢复。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/announce-posts", {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (d && d.ok) { ok("公告已删除"); if (form.id === id) resetForm(); await load(); }
      else err("删除失败，请重试");
    } catch (e) { err("删除失败，请重试"); }
    setBusy(false);
  }

  const inp = { width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
  const ta = { ...inp, minHeight: 84, resize: "vertical", lineHeight: 1.55, fontFamily: "inherit" };
  const label = { display: "block", fontSize: 12.5, color: C.muted, fontWeight: 600, margin: "0 0 6px" };
  const card = { border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 18 };
  const iconBtn = (color) => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: color || C.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" });

  // 状态徽章（置顶 / 已发布 / 草稿）
  const Badge = ({ children, fg, bg, bd }) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: fg, background: bg, border: `1px solid ${bd}` }}>{children}</span>
  );

  // 预览：忠实还原前端公告卡（日期 pill + 分类标签 + 标题 + 正文）。
  const Preview = () => {
    const cat = CAT_MAP[form.category];
    return (
      <div style={{ border: "1px solid rgba(15,23,42,0.08)", borderRadius: 14, background: "#fff", padding: "16px 18px", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#0f766e", background: "rgba(15,118,110,0.10)", padding: "3px 10px", borderRadius: 999, fontVariantNumeric: "tabular-nums" }}>{form.date || "2026-06-24"}</span>
          {cat && <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", background: "#f1f5f9", padding: "3px 10px", borderRadius: 999 }}>{cat.zh}</span>}
          {form.pinned && <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "3px 9px", borderRadius: 999 }}><Pin size={11} />置顶</span>}
        </div>
        <div style={{ fontSize: 16.5, fontWeight: 800, color: "#0f172a", lineHeight: 1.4, marginBottom: form.body ? 8 : 0 }}>{form.title || "公告标题"}</div>
        {form.body && <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{form.body}</div>}
      </div>
    );
  };

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px" }}>
        <Megaphone size={18} style={{ color: C.accent }} />
        <h2 style={{ fontSize: 18, margin: 0 }}>公告中心</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>共 {posts.length} 条</span>
      </div>
      <p style={{ color: C.muted, fontSize: 12.5, margin: "0 0 16px" }}>管理公司公告、业务动态、网站/系统通知与活动公告。置顶优先、按日期倒序展示。日期由你手动填写。</p>

      {msg && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600,
          background: msg.type === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${msg.type === "error" ? "#fecaca" : "#bbf7d0"}`, color: msg.type === "error" ? C.danger : C.ok }}>
          {msg.type === "error" ? <AlertTriangle size={15} style={{ flex: "none" }} /> : <CheckCircle2 size={15} style={{ flex: "none" }} />}
          <span>{msg.text}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
        {/* 编辑/新建表单 */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            {editing ? <Pencil size={16} style={{ color: C.accent }} /> : <Plus size={16} style={{ color: C.accent }} />}
            <h3 style={{ fontSize: 15, margin: 0 }}>{editing ? `编辑公告 #${form.id}` : "新建公告"}</h3>
            {editing && <button type="button" onClick={resetForm} style={{ ...iconBtn(C.muted), marginLeft: "auto" }}><Plus size={13} />改为新建</button>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={label}>日期（手动填写）</label>
              <input style={inp} value={form.date} onChange={(e) => setF("date", e.target.value)} placeholder="2026-06-24" inputMode="numeric" />
            </div>
            <div>
              <label style={label}>分类</label>
              <select style={{ ...inp, cursor: "pointer" }} value={form.category} onChange={(e) => setF("category", e.target.value)}>
                {CATS.map((c) => <option key={c.value || "none"} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>关联服务（可选）</label>
              <select style={{ ...inp, cursor: "pointer" }} value={form.affectedService} onChange={(e) => setF("affectedService", e.target.value)}>
                <option value="">不关联服务</option>
                {services.map((service) => <option key={service.key} value={service.key}>{service.label}{service.active ? "" : "（已下架）"}</option>)}
              </select>
              <small style={{ display: "block", marginTop: 5, color: C.faint, fontSize: 11.5, lineHeight: 1.5 }}>关联后可向相关用户发送邮件，不会在商品页显示提示。</small>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label}>标题（中文）</label>
            <input style={inp} value={form.title} onChange={(e) => setF("title", e.target.value)} placeholder="例如：新增 HBO Max 会员上线" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>标题（English，可选）</label>
            <input style={inp} value={form.titleEn} onChange={(e) => setF("titleEn", e.target.value)} placeholder="e.g. HBO Max memberships now available" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>正文（中文）</label>
            <textarea style={ta} value={form.body} onChange={(e) => setF("body", e.target.value)} placeholder="公告正文内容，可换行。" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>正文（English，可选）</label>
            <textarea style={ta} value={form.bodyEn} onChange={(e) => setF("bodyEn", e.target.value)} placeholder="English body (optional)." />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", marginBottom: 18 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={form.pinned} onChange={(e) => setF("pinned", e.target.checked)} /> 置顶
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={form.published} onChange={(e) => setF("published", e.target.checked)} /> 启用 / 发布（在前端展示）
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={form.inBar} onChange={(e) => setF("inBar", e.target.checked)} /> 在站内公告顶栏轮播（只轮播标题，点击进公告中心）
            </label>
          </div>

          {/* 实时预览 */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ ...label, marginBottom: 8 }}>前端公告卡预览</div>
            <Preview />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" onClick={save} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 24px", borderRadius: 10, border: 0, background: "linear-gradient(135deg,#0f766e,#14b8a6)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
              {busy && <LoaderCircle size={15} className="spin-icon" />}{busy ? "保存中…" : editing ? "保存修改" : "发布公告"}
            </button>
            {editing && <button type="button" onClick={resetForm} disabled={busy} style={{ padding: "10px 20px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>取消</button>}
          </div>
        </div>

        {/* 现有公告列表 */}
        <div>
          <div style={{ ...label, marginBottom: 10, fontSize: 13 }}>现有公告</div>
          {loading ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载中…</div>
          ) : posts.length === 0 ? (
            <div style={{ ...card, textAlign: "center", padding: "44px 16px" }}>
              <Inbox size={34} style={{ color: C.faint }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 10 }}>暂无公告</div>
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>用上方表单发布第一条公告，会出现在这里。</div>
            </div>
          ) : (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, overflow: "hidden" }}>
              {posts.map((p, i) => (
                <div key={p.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", borderBottom: i < posts.length - 1 ? `1px solid ${C.border}` : "none", background: form.id === p.id ? C.accentSoft : "transparent" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{p.date || "—"}</span>
                      {catLabel(p.category) && <span style={{ fontSize: 11.5, fontWeight: 600, color: "#475569", background: "#f1f5f9", padding: "1px 8px", borderRadius: 999 }}>{catLabel(p.category)}</span>}
                      {p.pinned && <Badge fg="#b45309" bg="#fef3c7" bd="#fde68a"><Pin size={10} />置顶</Badge>}
                      {p.published !== false
                        ? <Badge fg={C.ok} bg="#f0fdf4" bd="#bbf7d0"><Eye size={10} />已发布</Badge>
                        : <Badge fg={C.muted} bg={C.surface2} bd={C.border}><EyeOff size={10} />草稿</Badge>}
                      {p.inBar && <Badge fg={C.accent} bg={C.accentSoft} bd="#bbe7df"><Megaphone size={10} />顶栏轮播</Badge>}
                      {p.affectedService && <Badge fg="#0f6675" bg="#ecfeff" bd="#bae6fd">{services.find((service) => service.key === p.affectedService)?.label || p.affectedService}</Badge>}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || "（无标题）"}</div>
                    {p.body && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.body}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "none" }}>
                    {p.affectedService && <button type="button" onClick={() => setNoticePost(p)} disabled={busy} style={iconBtn(C.accent)}><Send size={13} />通知用户</button>}
                    <button type="button" onClick={() => editPost(p)} disabled={busy} style={iconBtn(C.accent)}><Pencil size={13} />编辑</button>
                    <button type="button" onClick={() => del(p.id, p.title)} disabled={busy} style={iconBtn(C.danger)}><Trash2 size={13} />删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {noticePost && <ServiceNoticeDialog post={noticePost} onClose={() => setNoticePost(null)} />}
    </div>
  );
}
