"use client";

// 后台「AI 工具配额」面板。仅超级管理员。管理 AI 对话 / 生图工具的额度申请与覆盖。
// 数据 = GET /api/admin/quota → { requests, overrides }。
// 审批 = POST { action:"approve"|"reject", id, [granted|unlimited] }。
// 覆盖 = POST { action:"setOverride", email, type, daily|unlimited, maxTokens|tokensUnlimited, note }。
// 取消 = DELETE { action:"cancelOverride", email, type }。
import { useCallback, useEffect, useState } from "react";
import { Inbox, LoaderCircle, CheckCircle2, AlertTriangle, Sparkles, ClipboardList, SlidersHorizontal, Settings2, Check, X, Trash2, BarChart3, Search } from "lucide-react";

const UNLIMITED = "unlimited";
const C = {
  text: "var(--text, #1d1d1f)", muted: "var(--muted, #6e6e73)", faint: "var(--faint, #8a8a8e)", border: "var(--border, #d2d2d7)",
  surface: "var(--surface, #fff)", surface2: "var(--surface-2, #f5f5f7)", accent: "var(--accent, #0f766e)", accentSoft: "var(--accent-soft, #e6f4f1)", danger: "#dc2626", ok: "#16a34a",
};

// 类型中文：chat = 对话(条/日)，image = 生图(张/日)
const TYPES = [
  { value: "chat", label: "对话(条/日)", unit: "条" },
  { value: "image", label: "生图(张/日)", unit: "张" },
];
const typeMeta = (t) => TYPES.find((x) => x.value === t) || { value: t, label: t || "—", unit: "" };
const typeLabel = (t) => typeMeta(t).label;
const typeUnit = (t) => typeMeta(t).unit;

// 三个子分类做成顶部固定的栏目(tab),只切换下方结果——避免堆叠成一长页
const TABS = [
  { key: "pending", label: "待审批", icon: ClipboardList },
  { key: "overrides", label: "生效覆盖", icon: SlidersHorizontal },
  { key: "manual", label: "手动设置", icon: Settings2 },
  { key: "usage", label: "全部用量", icon: BarChart3 },
];

// 北京时间短格式：26-06-24 21:18
function fmt(ms) {
  const n = Number(ms || 0);
  if (!n) return "—";
  const d = new Date(n + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 限额显示：数字 或「不限额」
const dailyText = (v, unit) => (v === UNLIMITED ? "不限额" : `${Number(v)} ${unit}/日`);
// token 显示：数字 / 不限 / 默认（undefined/null）
const tokenText = (v) => (v === UNLIMITED ? "不限 token" : v == null || v === "" ? "默认 token" : `${Number(v)} token`);

const EMPTY_FORM = { email: "", type: "chat", daily: "", dailyUnlimited: false, maxTokens: "", tokensUnlimited: false, note: "" };

export default function AIQuotaPanel() {
  const [requests, setRequests] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type:"ok"|"error", text } | null
  const [form, setForm] = useState(EMPTY_FORM);
  // 单条申请的「通过额度微调」临时状态：{ [id]: { granted, unlimited } }
  const [tweak, setTweak] = useState({});
  const [tab, setTab] = useState("pending"); // 当前子分类栏目
  // 全部用量看板
  const [usage, setUsage] = useState({ items: [], grand: null, matched: 0, hasMore: false });
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageQ, setUsageQ] = useState("");
  const [usagePeriod, setUsagePeriod] = useState("all"); // 排序依据:all=历史活跃 / today=今日活跃

  const ok = (text) => setMsg({ type: "ok", text });
  const err = (text) => setMsg({ type: "error", text });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/quota", { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      if (r.ok && d) {
        setRequests(Array.isArray(d.requests) ? d.requests : []);
        setOverrides(Array.isArray(d.overrides) ? d.overrides : []);
        setMsg(null);
      } else if (r.status === 401) {
        err("无权限（仅超级管理员可管理配额）");
      } else err("加载失败，请重试");
    } catch (e) { err("加载失败，请重试"); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // 全部用量:仅在切到该栏目时加载;搜索/排序变化防抖 300ms 重新拉取。
  const loadUsage = useCallback(async (q, period) => {
    setUsageLoading(true);
    try {
      const r = await fetch("/api/admin/ai-usage?period=" + period + "&limit=100" + (q ? "&q=" + encodeURIComponent(q) : ""), { credentials: "same-origin", cache: "no-store" });
      const d = await r.json();
      if (r.ok && d && d.ok) setUsage({ items: Array.isArray(d.items) ? d.items : [], grand: d.grand || null, matched: d.matched || 0, hasMore: !!d.hasMore });
      else if (r.status === 401) setMsg({ type: "error", text: "无权限（仅超级管理员可查看用量）" });
      else setMsg({ type: "error", text: "用量加载失败，请重试" });
    } catch (e) { setMsg({ type: "error", text: "用量加载失败，请重试" }); }
    setUsageLoading(false);
  }, []);

  useEffect(() => {
    if (tab !== "usage") return;
    const t = setTimeout(() => loadUsage(usageQ.trim(), usagePeriod), 300);
    return () => clearTimeout(t);
  }, [tab, usageQ, usagePeriod, loadUsage]);

  async function post(body, okText) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/quota", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok && d && d.ok !== false) { ok(okText); await load(); return true; }
      err((d && d.error) || "操作失败，请重试");
    } catch (e) { err("操作失败，请重试"); }
    finally { setBusy(false); }
    return false;
  }

  // ── (1) 审批 ──
  const tweakOf = (req) => tweak[req.id] || { granted: String(req.requested ?? ""), unlimited: req.requested === UNLIMITED };
  const setTweakOf = (id, patch) => setTweak((t) => ({ ...t, [id]: { ...(t[id] || {}), ...patch } }));

  async function approve(req) {
    const t = tweakOf(req);
    const body = { action: "approve", id: req.id };
    if (t.unlimited) body.unlimited = true;
    else {
      const n = Number(t.granted);
      if (!Number.isFinite(n) || n < 0) { err("请填写有效的通过额度（≥0 的整数，或勾选不限额）"); return; }
      body.granted = Math.floor(n);
    }
    const done = await post(body, "已通过申请");
    if (done) setTweak((t2) => { const n = { ...t2 }; delete n[req.id]; return n; });
  }

  async function reject(req) {
    if (typeof window !== "undefined" && !window.confirm(`确认拒绝 ${req.email} 的${typeLabel(req.type)}额度申请？`)) return;
    await post({ action: "reject", id: req.id }, "已拒绝申请");
  }

  // ── (2) 取消覆盖 ──
  async function cancelOverride(o) {
    if (typeof window !== "undefined" && !window.confirm(`确认取消 ${o.email} 的${typeLabel(o.type)}配额覆盖？该用户将恢复默认额度。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/quota", {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancelOverride", email: o.email, type: o.type }),
      });
      const d = await r.json();
      if (r.ok && d && d.ok !== false) { ok("已取消配额覆盖"); await load(); }
      else err((d && d.error) || "取消失败，请重试");
    } catch (e) { err("取消失败，请重试"); }
    setBusy(false);
  }

  // ── (3) 手动设置 ──
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function saveOverride() {
    const email = form.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err("请填写有效的用户邮箱"); return; }
    const body = { action: "setOverride", email, type: form.type, note: form.note.trim() };
    if (form.dailyUnlimited) body.unlimited = true;
    else {
      const n = Number(form.daily);
      if (!Number.isFinite(n) || n < 0) { err("请填写有效的限额数字（≥0），或勾选不限额"); return; }
      body.daily = Math.floor(n);
    }
    if (form.type === "chat") {
      if (form.tokensUnlimited) body.tokensUnlimited = true;
      else if (String(form.maxTokens).trim() !== "") {
        const m = Number(form.maxTokens);
        if (!Number.isFinite(m) || m <= 0) { err("token 上限须为正整数，或勾选不限 token / 留空用默认"); return; }
        body.maxTokens = Math.floor(m);
      }
    }
    const done = await post(body, "配额已保存");
    if (done) setForm(EMPTY_FORM);
  }

  const pending = requests.filter((r) => (r.status || "pending") === "pending");

  // ── 样式 ──
  const inp = { width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
  const label = { display: "block", fontSize: 12.5, color: C.muted, fontWeight: 600, margin: "0 0 6px" };
  const card = { border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, padding: 18 };
  const iconBtn = (color, bd) => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 13px", borderRadius: 9, border: `1px solid ${bd || C.border}`, background: C.surface, color: color || C.text, fontSize: 12.5, fontWeight: 600, cursor: busy ? "default" : "pointer", whiteSpace: "nowrap", opacity: busy ? 0.65 : 1 });
  const check = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap", color: C.text };

  const Badge = ({ children, fg, bg, bd }) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: fg, background: bg, border: `1px solid ${bd}`, whiteSpace: "nowrap" }}>{children}</span>
  );
  const TypeBadge = ({ t }) => (
    t === "image"
      ? <Badge fg="#7c3aed" bg="#f5f3ff" bd="#ddd6fe">{typeLabel(t)}</Badge>
      : <Badge fg={C.accent} bg={C.accentSoft} bd="#bbe7df">{typeLabel(t)}</Badge>
  );

  const Empty = ({ text, hint }) => (
    <div style={{ ...card, textAlign: "center", padding: "40px 16px" }}>
      <Inbox size={32} style={{ color: C.faint }} />
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 10 }}>{text}</div>
      {hint && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  );

  // ── 各栏目内容(只渲染当前激活的一个) ──
  const PendingBody = (
    pending.length === 0 ? (
      <Empty text="暂无待审批申请" hint="用户在 AI 工具内提交额度申请后会出现在这里。" />
    ) : (
      <div style={{ display: "grid", gap: 12 }}>
        {pending.map((req) => {
          const t = tweakOf(req);
          return (
            <div key={req.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.text, wordBreak: "break-all" }}>{req.email}</span>
                <TypeBadge t={req.type} />
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: C.faint, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmt(req.createdAt)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: req.reason ? 8 : 12 }}>
                <span style={{ fontSize: 12.5, color: C.muted }}>申请额度</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.accent }}>{dailyText(req.requested, typeUnit(req.type))}</span>
              </div>
              {req.reason && (
                <div style={{ fontSize: 13, color: C.text, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 12px", lineHeight: 1.55, marginBottom: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{req.reason}</div>
              )}
              {/* 通过额度微调 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 600 }}>通过额度</span>
                <input
                  type="number" min={0} inputMode="numeric"
                  value={t.unlimited ? "" : t.granted}
                  disabled={t.unlimited || busy}
                  onChange={(e) => setTweakOf(req.id, { granted: e.target.value })}
                  style={{ ...inp, width: 110, padding: "7px 10px", opacity: t.unlimited ? 0.5 : 1 }}
                  placeholder={typeUnit(req.type) + "/日"}
                />
                <label style={check}>
                  <input type="checkbox" checked={t.unlimited} disabled={busy} onChange={(e) => setTweakOf(req.id, { unlimited: e.target.checked })} /> 不限额
                </label>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => approve(req)} disabled={busy} style={{ ...iconBtn("#fff"), background: "linear-gradient(135deg,#0f766e,#14b8a6)", border: 0 }}><Check size={14} />通过</button>
                <button type="button" onClick={() => reject(req)} disabled={busy} style={iconBtn(C.danger, C.danger)}><X size={14} />拒绝</button>
              </div>
            </div>
          );
        })}
      </div>
    )
  );

  const OverridesBody = (
    overrides.length === 0 ? (
      <Empty text="暂无配额覆盖" hint="审批通过或手动设置后，生效的覆盖会列在这里。" />
    ) : (
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, overflow: "hidden" }}>
        {overrides.map((o, i) => (
          <div key={`${o.type}:${o.email}`} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "13px 16px", borderBottom: i < overrides.length - 1 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text, wordBreak: "break-all" }}>{o.email}</span>
                <TypeBadge t={o.type} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
                <span style={{ color: C.muted }}>限额 <b style={{ color: o.daily === UNLIMITED ? C.ok : C.text, fontWeight: 700 }}>{dailyText(o.daily, typeUnit(o.type))}</b></span>
                {o.type === "chat" && (
                  <span style={{ color: C.muted }}>token <b style={{ color: o.maxTokens === UNLIMITED ? C.ok : C.text, fontWeight: 700 }}>{tokenText(o.maxTokens)}</b></span>
                )}
                {o.note && <span style={{ color: C.faint }} title={o.note}>· {o.note}</span>}
              </div>
            </div>
            <button type="button" onClick={() => cancelOverride(o)} disabled={busy} style={iconBtn(C.danger, C.border)}><Trash2 size={13} />取消</button>
          </div>
        ))}
      </div>
    )
  );

  const ManualBody = (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
        <div>
          <label style={label}>用户邮箱</label>
          <input style={inp} value={form.email} onChange={(e) => setF("email", e.target.value)} placeholder="user@example.com" inputMode="email" autoComplete="off" />
        </div>
        <div>
          <label style={label}>类型</label>
          <select style={{ ...inp, cursor: "pointer" }} value={form.type} onChange={(e) => setF("type", e.target.value)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={label}>每日限额</label>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <input
            type="number" min={0} inputMode="numeric"
            value={form.dailyUnlimited ? "" : form.daily}
            disabled={form.dailyUnlimited}
            onChange={(e) => setF("daily", e.target.value)}
            style={{ ...inp, width: 160, opacity: form.dailyUnlimited ? 0.5 : 1 }}
            placeholder={`数字（${typeUnit(form.type)}/日）`}
          />
          <label style={check}>
            <input type="checkbox" checked={form.dailyUnlimited} onChange={(e) => setF("dailyUnlimited", e.target.checked)} /> 不限额
          </label>
        </div>
      </div>

      {form.type === "chat" && (
        <div style={{ marginBottom: 14 }}>
          <label style={label}>token 上限（单次对话，可选）</label>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <input
              type="number" min={1} inputMode="numeric"
              value={form.tokensUnlimited ? "" : form.maxTokens}
              disabled={form.tokensUnlimited}
              onChange={(e) => setF("maxTokens", e.target.value)}
              style={{ ...inp, width: 160, opacity: form.tokensUnlimited ? 0.5 : 1 }}
              placeholder="留空 = 默认"
            />
            <label style={check}>
              <input type="checkbox" checked={form.tokensUnlimited} onChange={(e) => setF("tokensUnlimited", e.target.checked)} /> 不限 token
            </label>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        <label style={label}>备注（可选）</label>
        <input style={inp} value={form.note} onChange={(e) => setF("note", e.target.value)} placeholder="例如：VIP 客户 / 临时提额" />
      </div>

      <button type="button" onClick={saveOverride} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 24px", borderRadius: 10, border: 0, background: "linear-gradient(135deg,#0f766e,#14b8a6)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>
        {busy && <LoaderCircle size={15} className="spin-icon" />}{busy ? "保存中…" : "保存配额"}
      </button>
    </div>
  );

  // ── (4) 全部用量 ──
  const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
  const StatCard = ({ label, value, sub, accent }) => (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: "11px 13px" }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: accent || C.text, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
        {value}{sub ? <span style={{ fontSize: 12, fontWeight: 600, color: C.faint, marginLeft: 3 }}>{sub}</span> : null}
      </div>
    </div>
  );
  const uGrid = { display: "grid", gridTemplateColumns: "minmax(0,1fr) 68px 68px 68px 68px", gap: 8, alignItems: "center", padding: "11px 14px" };
  const numCell = { textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13.5 };

  const UsageBody = (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
          <Search size={15} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: C.faint, pointerEvents: "none" }} />
          <input value={usageQ} onChange={(e) => setUsageQ(e.target.value)} placeholder="按邮箱搜索…" inputMode="email" autoComplete="off" style={{ ...inp, paddingLeft: 34 }} />
        </div>
        <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", flex: "none" }}>
          {[{ k: "all", t: "历史活跃" }, { k: "today", t: "今日活跃" }].map((o) => {
            const on = usagePeriod === o.k;
            return (
              <button key={o.k} type="button" onClick={() => setUsagePeriod(o.k)}
                style={{ padding: "9px 14px", border: 0, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap", background: on ? C.accent : "transparent", color: on ? "#fff" : C.muted }}>
                {o.t} ↓
              </button>
            );
          })}
        </div>
      </div>

      {usage.grand && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px,1fr))", gap: 10 }}>
          <StatCard label="用过 AI 的用户" value={fmtNum(usage.grand.users)} sub="人" />
          <StatCard label="今日对话" value={fmtNum(usage.grand.chatToday)} sub="条" />
          <StatCard label="今日生图" value={fmtNum(usage.grand.imgToday)} sub="张" accent="#7c3aed" />
          <StatCard label="历史对话" value={fmtNum(usage.grand.chatTotal)} sub="条" />
          <StatCard label="历史生图" value={fmtNum(usage.grand.imgTotal)} sub="张" accent="#7c3aed" />
        </div>
      )}

      {usageLoading ? (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13, padding: "8px 2px" }}><LoaderCircle size={16} className="spin-icon" />加载中…</div>
      ) : usage.items.length === 0 ? (
        <Empty text={usageQ ? "没有匹配的用户" : "暂无用量数据"} hint="用户使用 AI 对话或生图后会出现在这里。" />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 460, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.surface }}>
            <div style={{ ...uGrid, background: C.surface2, fontWeight: 700, color: C.muted }}>
              <span style={{ fontSize: 12 }}>邮箱（{fmtNum(usage.matched)} 人）</span>
              <span style={{ ...numCell, fontSize: 11.5 }}>今日对话</span>
              <span style={{ ...numCell, fontSize: 11.5 }}>今日生图</span>
              <span style={{ ...numCell, fontSize: 11.5 }}>历史对话</span>
              <span style={{ ...numCell, fontSize: 11.5 }}>历史生图</span>
            </div>
            {usage.items.map((it) => (
              <div key={it.email} style={{ ...uGrid, borderTop: `1px solid ${C.border}` }}>
                <span style={{ wordBreak: "break-all", fontSize: 13, fontWeight: 600, color: C.text }}>{it.email}</span>
                <span style={{ ...numCell, color: it.chatToday ? C.text : C.faint }}>{fmtNum(it.chatToday)}</span>
                <span style={{ ...numCell, color: it.imgToday ? "#7c3aed" : C.faint }}>{fmtNum(it.imgToday)}</span>
                <span style={{ ...numCell, color: it.chatTotal ? C.text : C.faint }}>{fmtNum(it.chatTotal)}</span>
                <span style={{ ...numCell, color: it.imgTotal ? "#7c3aed" : C.faint }}>{fmtNum(it.imgTotal)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {usage.hasMore && <div style={{ fontSize: 12, color: C.faint, textAlign: "center" }}>仅显示前 100 名，用邮箱搜索可精确查找。</div>}
      <p style={{ fontSize: 11.5, color: C.faint, margin: 0, lineHeight: 1.6 }}>注：历史用量自本功能上线起累计（无法回溯此前）；「今日」按北京时间 0 点起算；排序依所选「历史 / 今日活跃」（对话 + 生图）从多到少。</p>
    </div>
  );

  const tabBadge = (key) => (key === "pending" ? pending.length : key === "overrides" ? overrides.length : 0);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px" }}>
        <Sparkles size={18} style={{ color: C.accent }} />
        <h2 style={{ fontSize: 18, margin: 0 }}>AI 工具配额</h2>
        <span style={{ color: C.muted, fontSize: 12.5 }}>{pending.length} 待审批 · {overrides.length} 项覆盖</span>
      </div>
      <p style={{ color: C.muted, fontSize: 12.5, margin: "0 0 12px" }}>审批用户对 AI 对话 / 生图工具的额度申请，并可手动为指定用户设置每日额度与 token 上限。</p>

      {loading ? (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载中…</div>
      ) : (
        <>
          {/* ── 固定栏目条:滚动结果时与左侧导航一起常驻不动 ── */}
          <div className="aiq-sticky">
            <div className="aiq-tabs">
              {TABS.map((tb) => {
                const on = tab === tb.key;
                const Ic = tb.icon;
                const n = tabBadge(tb.key);
                return (
                  <button key={tb.key} type="button" onClick={() => setTab(tb.key)} className={on ? "" : "aiq-tab"}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 11, border: 0, cursor: "pointer",
                      fontSize: 13.5, fontWeight: 750, whiteSpace: "nowrap", fontFamily: "inherit",
                      background: on ? "linear-gradient(135deg,#0f172a,#134e4a)" : "transparent",
                      color: on ? "#fff" : C.muted,
                      boxShadow: on ? "0 6px 16px rgba(15,23,42,.18)" : "none",
                      transition: "background .16s, color .16s",
                    }}>
                    <Ic size={15} style={{ color: on ? "#5eead4" : C.faint }} />
                    {tb.label}
                    {n > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 800, padding: "1px 7px", borderRadius: 999, lineHeight: 1.6,
                        background: on ? "rgba(255,255,255,.2)" : "#fef3c7", color: on ? "#fff" : "#b45309" }}>{n}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {msg && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                background: msg.type === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${msg.type === "error" ? "#fecaca" : "#bbf7d0"}`, color: msg.type === "error" ? C.danger : C.ok }}>
                {msg.type === "error" ? <AlertTriangle size={15} style={{ flex: "none" }} /> : <CheckCircle2 size={15} style={{ flex: "none" }} />}
                <span>{msg.text}</span>
              </div>
            )}
          </div>

          {/* ── 当前栏目结果 ── */}
          <div>
            {tab === "pending" && PendingBody}
            {tab === "overrides" && OverridesBody}
            {tab === "manual" && ManualBody}
            {tab === "usage" && UsageBody}
          </div>
        </>
      )}
    </div>
  );
}
